import { TABLES, createRecord, getRecord, listRecords, logActivity, updateRecord } from './airtable.js';
import { buildIdempotencyKey, createRelayDraft } from './relay-delivery.js';
import { processLead } from './ghostos.js';

const ACTIVE_MESSAGE_STATUSES = new Set(['Pending','Blocked','Failed','Sent','Delivered']);
const STALE_PROCESSING_MS = 15 * 60 * 1000;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function linkedToJob(message, jobId) { return Array.isArray(message.fields.Job) && message.fields.Job.includes(jobId); }
function meaningfulMessage(messages, jobId) {
  return messages.find((m) => linkedToJob(m, jobId) && ACTIVE_MESSAGE_STATUSES.has(m.fields.Status) && String(m.fields.Body || '').trim());
}
function processingIsFresh(job, now = Date.now()) {
  if (job.fields['GhostOS Dispatch Status'] !== 'Processing') return false;
  const started = new Date(job.fields['GhostOS Dispatch Started At'] || 0).getTime();
  return Number.isFinite(started) && now - started < STALE_PROCESSING_MS;
}
function inferRecoveredType(job) {
  if (job.fields['RELAY State'] === 'Need More Info') return 'clarification';
  if (job.fields.Status === 'Quoted') return 'quote';
  return 'follow_up';
}
function resultExists(job, messages) {
  return Boolean(meaningfulMessage(messages, job.id)) || job.fields.Status !== 'New Lead' || Boolean(String(job.fields['RELAY Reply Draft'] || '').trim());
}
function customerReference(job) { return job.fields['Customer Name'] || job.fields['Job / Customer'] || job.id; }
function resolveRecoveryChannel(job) {
  if (job.fields.Phone) return { channel:'sms', destination:String(job.fields.Phone) };
  if (job.fields.Email) return { channel:'email', destination:String(job.fields.Email) };
  return null;
}
function dispatchState(job) { return String(job.fields['GhostOS Dispatch Status'] || '').trim() || 'blank'; }

export function createLeadDispatcher(overrides = {}) {
  const deps = {
    createRecord,
    getRecord,
    listRecords,
    logActivity,
    updateRecord,
    createRelayDraft,
    processLead,
    now: () => new Date().toISOString(),
    ...overrides,
  };

  async function getMessages() {
    return deps.listRecords(TABLES.MESSAGES, { maxRecords: 500 });
  }

  async function markProcessed(jobId, detail, attempt, extra = {}) {
    const when = deps.now();
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'GhostOS Dispatch Status': 'Processed',
      'GhostOS Dispatch Attempt': attempt,
      'GhostOS Dispatch Completed At': when,
      'GhostOS Dispatch Error': '',
    });
    await deps.logActivity({ agent:'ATLAS', jobId, actionType:'lead_dispatch_completed', status:'Done', detail });
    return { processed:true, jobId, detail, ...extra };
  }

  async function recoverExistingReply(job, messages, attempt) {
    const reply = String(job.fields['RELAY Reply Draft'] || '').trim();
    if (!reply) return null;
    if (job.fields['RELAY SMS Opted Out'] && job.fields.Phone) {
      return markProcessed(job.id, 'Existing RELAY reply text was found, but SMS is opted out. No SMS draft was created.', attempt, { recoveredDraft:false });
    }

    const route = resolveRecoveryChannel(job);
    if (!route) throw new Error('Existing RELAY Reply Draft cannot be recovered because the lead has no phone or email destination');
    const messageType = inferRecoveredType(job);
    const idempotencyKey = buildIdempotencyKey({ jobId:job.id, channel:route.channel, destination:route.destination, messageType, message:reply });
    const duplicate = messages.find((m) => linkedToJob(m, job.id) && m.fields['Idempotency Key'] === idempotencyKey);
    if (duplicate) return markProcessed(job.id, `Dispatcher found recovered RELAY message ${duplicate.id}; no duplicate draft created.`, attempt, { recoveredDraft:false, duplicate:true, existingMessageId:duplicate.id });

    const when = deps.now();
    const draft = await deps.createRecord(TABLES.MESSAGES, {
      Message: `RELAY recovered draft — ${messageType} — ${when}`,
      Job: [job.id],
      'Idempotency Key': idempotencyKey,
      Channel: route.channel === 'sms' ? 'SMS' : 'Email',
      Destination: route.destination,
      'Message Type': messageType,
      Body: reply,
      Status: 'Pending',
      Attempt: 0,
      'Created At': when,
      'Customer Reference': customerReference(job),
    });
    await deps.updateRecord(TABLES.JOBS, job.id, {
      'RELAY Reply Draft': reply,
      'RELAY Next Action': 'Recovered draft is ready in RELAY Messages. Review/edit it, copy it, send it personally, then mark it sent manually.',
    });
    await deps.logActivity({ agent:'RELAY', jobId:job.id, actionType:'customer_message_draft_recovered', status:'Done', detail:`Recovered existing job reply text into RELAY Messages as ${draft.id}. No customer message was sent.` });
    return markProcessed(job.id, `Recovered pre-existing RELAY reply into message ledger ${draft.id}; no duplicate agent run required.`, attempt, { recoveredDraft:true, draftId:draft.id });
  }

  async function reconcileExisting(job, messages, attempt) {
    const existing = meaningfulMessage(messages, job.id);
    if (existing) {
      if (job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:true, duplicate:true, jobId:job.id, existingMessageId:existing.id, recoveredDraft:false };
      return markProcessed(job.id, `Dispatcher found existing RELAY message ${existing.id}; no duplicate processing performed.`, attempt, { recoveredDraft:false, existingMessageId:existing.id });
    }
    const recovered = await recoverExistingReply(job, messages, attempt);
    if (recovered) return recovered;
    if (job.fields.Status !== 'New Lead') {
      if (job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:true, duplicate:true, jobId:job.id, recoveredDraft:false };
      return markProcessed(job.id, `Lead already advanced to ${job.fields.Status}; no duplicate processing performed.`, attempt, { recoveredDraft:false });
    }
    return null;
  }

  async function dispatchLead(jobId, { force = false, source = 'automatic' } = {}) {
    let job = await deps.getRecord(TABLES.JOBS, jobId);
    if (!job) throw new Error('Lead not found');
    if (processingIsFresh(job)) return { processed:false, skipped:true, jobId, reason:'Already processing', dispatchState:dispatchState(job) };
    if (job.fields.Status !== 'New Lead' && !force) return { processed:false, skipped:true, jobId, reason:`Status is ${job.fields.Status}`, dispatchState:dispatchState(job) };

    const attempt = n(job.fields['GhostOS Dispatch Attempt']) + 1;
    try {
      let messages = await getMessages();
      const reconciled = await reconcileExisting(job, messages, attempt);
      if (reconciled) return { ...reconciled, reconciled:true };
      if (!force && job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:false, skipped:true, jobId, reason:'Already processed', dispatchState:'Processed' };

      const started = deps.now();
      await deps.updateRecord(TABLES.JOBS, jobId, {
        'GhostOS Dispatch Status':'Processing',
        'GhostOS Dispatch Attempt':attempt,
        'GhostOS Dispatch Started At':started,
        'GhostOS Dispatch Error':'',
      });
      await deps.logActivity({ agent:'ATLAS', jobId, actionType:'lead_dispatch_started', status:'Running', detail:`${source} New Lead dispatch started (attempt ${attempt}).` });

      await deps.processLead(jobId, { dispatchSource:source, dispatchAttempt:attempt });
      job = await deps.getRecord(TABLES.JOBS, jobId);
      messages = await getMessages();

      if (!meaningfulMessage(messages, jobId) && String(job.fields['RELAY Reply Draft'] || '').trim()) {
        const recovered = await recoverExistingReply(job, messages, attempt);
        if (recovered) return { ...recovered, reconciled:true };
      }

      if (!resultExists(job, messages)) throw new Error('ATLAS completed without a RELAY draft or a concrete next workflow state');
      return markProcessed(jobId, `New Lead dispatch completed from ${source}. Result was persisted and verified.`, attempt, { recoveredDraft:false });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 20000);
      try {
        await deps.updateRecord(TABLES.JOBS, jobId, {
          'GhostOS Dispatch Status':'Failed',
          'GhostOS Dispatch Attempt':attempt,
          'GhostOS Dispatch Error':message,
        });
        await deps.logActivity({ agent:'ATLAS', jobId, actionType:'lead_dispatch_failed', status:'Error', detail:`${source}: ${message}` });
      } catch (auditError) {
        console.error('GhostOS could not persist lead dispatch failure', { jobId, error:message, auditError:auditError?.message || auditError });
      }
      throw error;
    }
  }

  async function runCycle({ maxLeads = 5 } = {}) {
    const jobs = await deps.listRecords(TABLES.JOBS, { maxRecords:300 });
    const limit = Math.max(1, Math.min(20, Number(maxLeads) || 5));
    const eligible = [];
    const skipped = [];
    let newLeadsSeen = 0;

    for (const job of jobs) {
      if (job.fields.Status !== 'New Lead') continue;
      newLeadsSeen += 1;
      const state = dispatchState(job);
      if (state === 'Processed') { skipped.push({ jobId:job.id, reason:'dispatch_processed' }); continue; }
      if (processingIsFresh(job)) { skipped.push({ jobId:job.id, reason:'dispatch_processing_fresh' }); continue; }
      if (eligible.length >= limit) { skipped.push({ jobId:job.id, reason:'cycle_limit' }); continue; }
      eligible.push(job);
    }

    const results = [];
    for (const job of eligible) {
      try { results.push(await dispatchLead(job.id, { source:'scheduled_dispatcher' })); }
      catch (error) { results.push({ processed:false, failed:true, jobId:job.id, error:String(error?.message || error) }); }
    }

    const summary = {
      leadsScanned: jobs.length,
      newLeadsSeen,
      leadsEligible: eligible.length,
      leadsSkipped: skipped,
      leadsProcessed: results.filter((r)=>r.processed).length,
      draftsRecoveredOrCreated: results.filter((r)=>r.recoveredDraft || r.draftCreated).length,
      failures: results.filter((r)=>r.failed).map((r)=>({ jobId:r.jobId, error:r.error })),
      results,
    };
    await deps.logActivity({ agent:'ATLAS', actionType:'lead_dispatch_cycle_summary', status:summary.failures.length ? 'Error' : 'Done', detail:JSON.stringify(summary).slice(0,90000) });
    console.log('GhostOS lead dispatch cycle summary', JSON.stringify(summary));
    return summary;
  }

  async function backfill(recordIds = []) {
    const ids = [...new Set(recordIds.map((id)=>String(id).trim()).filter(Boolean))].slice(0,20);
    if (!ids.length) throw new Error('At least one recordId is required for backfill');
    const results = [];
    for (const jobId of ids) {
      try { results.push(await dispatchLead(jobId, { force:false, source:'owner_backfill' })); }
      catch (error) { results.push({ processed:false, failed:true, jobId, error:String(error?.message || error) }); }
    }
    await deps.logActivity({ agent:'ATLAS', actionType:'lead_dispatch_backfill_summary', status:results.some((r)=>r.failed)?'Error':'Done', detail:JSON.stringify({ requested:ids.length, results }).slice(0,90000) });
    return { requested:ids.length, results };
  }

  return { dispatchLead, runCycle, backfill };
}

export async function dispatchLead(jobId, options) { return createLeadDispatcher().dispatchLead(jobId, options); }
export async function runLeadDispatchCycle(options) { return createLeadDispatcher().runCycle(options); }
export async function backfillLeadDispatch(recordIds) { return createLeadDispatcher().backfill(recordIds); }
