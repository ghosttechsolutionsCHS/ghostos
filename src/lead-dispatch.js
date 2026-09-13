import { TABLES, getRecord, listRecords, logActivity, updateRecord } from './airtable.js';
import { createRelayDraft } from './relay-delivery.js';
import { processLead } from './ghostos.js';

const ACTIVE_MESSAGE_STATUSES = new Set(['Pending','Blocked','Failed','Sent']);
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

export function createLeadDispatcher(overrides = {}) {
  const deps = {
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

  async function markProcessed(jobId, detail, attempt) {
    const when = deps.now();
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'GhostOS Dispatch Status': 'Processed',
      'GhostOS Dispatch Attempt': attempt,
      'GhostOS Dispatch Completed At': when,
      'GhostOS Dispatch Error': '',
    });
    await deps.logActivity({ agent:'ATLAS', jobId, actionType:'lead_dispatch_completed', status:'Done', detail });
    return { processed:true, jobId, detail };
  }

  async function reconcileExisting(job, messages, attempt) {
    const existing = meaningfulMessage(messages, job.id);
    if (existing) {
      if (job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:true, duplicate:true, jobId:job.id, existingMessageId:existing.id };
      return markProcessed(job.id, `Dispatcher found existing RELAY message ${existing.id}; no duplicate processing performed.`, attempt);
    }

    const reply = String(job.fields['RELAY Reply Draft'] || '').trim();
    if (reply) {
      if (job.fields['RELAY SMS Opted Out']) {
        if (job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:true, duplicate:true, jobId:job.id };
        return markProcessed(job.id, 'Existing RELAY reply text was found, but SMS is opted out. No new SMS draft was created.', attempt);
      }
      const draft = await deps.createRelayDraft({ jobId:job.id, message:reply, messageType:inferRecoveredType(job), channel:'auto' });
      await deps.logActivity({ agent:'RELAY', jobId:job.id, actionType:'customer_message_draft_recovered', status:'Done', detail:`Recovered existing job reply text into RELAY Messages as ${draft.id}. No customer message was sent.` });
      return markProcessed(job.id, `Recovered pre-existing RELAY reply into message ledger ${draft.id}; no duplicate agent run required.`, attempt);
    }

    if (job.fields.Status !== 'New Lead') {
      if (job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:true, duplicate:true, jobId:job.id };
      return markProcessed(job.id, `Lead already advanced to ${job.fields.Status}; no duplicate processing performed.`, attempt);
    }
    return null;
  }

  async function dispatchLead(jobId, { force = false, source = 'automatic' } = {}) {
    let job = await deps.getRecord(TABLES.JOBS, jobId);
    if (!job) throw new Error('Lead not found');
    if (processingIsFresh(job)) return { processed:false, skipped:true, reason:'Already processing' };
    if (job.fields.Status !== 'New Lead' && !force) return { processed:false, skipped:true, reason:`Status is ${job.fields.Status}` };

    const attempt = n(job.fields['GhostOS Dispatch Attempt']) + 1;
    let messages = await getMessages();
    const reconciled = await reconcileExisting(job, messages, attempt);
    if (reconciled) return { ...reconciled, reconciled:true };

    if (!force && job.fields['GhostOS Dispatch Status'] === 'Processed') return { processed:false, skipped:true, reason:'Already processed' };

    const started = deps.now();
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'GhostOS Dispatch Status':'Processing',
      'GhostOS Dispatch Attempt':attempt,
      'GhostOS Dispatch Started At':started,
      'GhostOS Dispatch Error':'',
    });
    await deps.logActivity({ agent:'ATLAS', jobId, actionType:'lead_dispatch_started', status:'Running', detail:`${source} New Lead dispatch started (attempt ${attempt}).` });

    try {
      await deps.processLead(jobId, { dispatchSource:source, dispatchAttempt:attempt });
      job = await deps.getRecord(TABLES.JOBS, jobId);
      messages = await getMessages();

      if (!meaningfulMessage(messages, jobId) && String(job.fields['RELAY Reply Draft'] || '').trim() && !job.fields['RELAY SMS Opted Out']) {
        const draft = await deps.createRelayDraft({ jobId, message:String(job.fields['RELAY Reply Draft']).trim(), messageType:inferRecoveredType(job), channel:'auto' });
        await deps.logActivity({ agent:'RELAY', jobId, actionType:'customer_message_draft_recovered', status:'Done', detail:`ATLAS produced reply text without a RELAY ledger entry; dispatcher recovered it as ${draft.id}. No external send occurred.` });
        messages = await getMessages();
      }

      if (!resultExists(job, messages)) throw new Error('ATLAS completed without a RELAY draft or a concrete next workflow state');
      return markProcessed(jobId, `New Lead dispatch completed from ${source}. Result was persisted and verified.`, attempt);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 20000);
      await deps.updateRecord(TABLES.JOBS, jobId, {
        'GhostOS Dispatch Status':'Failed',
        'GhostOS Dispatch Attempt':attempt,
        'GhostOS Dispatch Error':message,
      });
      await deps.logActivity({ agent:'ATLAS', jobId, actionType:'lead_dispatch_failed', status:'Error', detail:message });
      throw error;
    }
  }

  async function runCycle({ maxLeads = 5 } = {}) {
    const jobs = await deps.listRecords(TABLES.JOBS, { maxRecords:300 });
    const candidates = jobs.filter((job) => job.fields.Status === 'New Lead')
      .filter((job) => job.fields['GhostOS Dispatch Status'] !== 'Processed')
      .filter((job) => !processingIsFresh(job))
      .slice(0, Math.max(1, Math.min(20, Number(maxLeads) || 5)));
    const results = [];
    for (const job of candidates) {
      try { results.push(await dispatchLead(job.id, { source:'scheduled_dispatcher' })); }
      catch (error) { results.push({ processed:false, failed:true, jobId:job.id, error:String(error?.message || error) }); }
    }
    return { scanned:jobs.length, candidates:candidates.length, results };
  }

  return { dispatchLead, runCycle };
}

export async function dispatchLead(jobId, options) { return createLeadDispatcher().dispatchLead(jobId, options); }
export async function runLeadDispatchCycle(options) { return createLeadDispatcher().runCycle(options); }
