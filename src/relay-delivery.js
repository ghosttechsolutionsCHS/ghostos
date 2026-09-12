import { createHash } from 'node:crypto';
import {
  TABLES,
  createRecord,
  getRecord,
  listRecords,
  logActivity,
  updateRecord,
} from './airtable.js';
import { createRelayProviderFromEnv } from './relay-provider.js';

const MESSAGE_TYPES = new Set([
  'clarification',
  'quote',
  'follow_up',
  'status_update',
  'scheduling_question',
]);
const CALLBACK_STATUSES = new Set(['accepted', 'sent', 'delivered', 'failed']);
const FINAL_OR_IN_FLIGHT = new Set(['Sending', 'Accepted', 'Sent', 'Delivered']);
const MAX_ATTEMPTS = 3;

function formulaString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildIdempotencyKey({ jobId, channel, destination, messageType, message }) {
  return createHash('sha256')
    .update([jobId, channel, destination, messageType, message].join('\u001f'))
    .digest('hex');
}

function airtableStatus(providerStatus) {
  if (providerStatus === 'delivered') return 'Delivered';
  if (providerStatus === 'sent') return 'Sent';
  if (providerStatus === 'accepted') return 'Accepted';
  return 'Failed';
}

function customerReference(job) {
  return job.fields['Customer Name'] || job.fields['Job / Customer'] || job.id;
}

async function pendingOwnerApproval(deps, jobId) {
  const approvals = await deps.listRecords(TABLES.APPROVALS, { maxRecords: 200 });
  return approvals.find((record) => (
    record.fields.Status === 'Pending'
    && Array.isArray(record.fields.Job)
    && record.fields.Job.includes(jobId)
  )) || null;
}

async function findMessageByKey(deps, key) {
  const rows = await deps.listRecords(TABLES.MESSAGES, {
    maxRecords: 10,
    filterByFormula: `{Idempotency Key}='${formulaString(key)}'`,
  });
  return rows[0] || null;
}

async function findMessageForCallback(deps, { providerMessageId, idempotencyKey }) {
  if (providerMessageId) {
    const rows = await deps.listRecords(TABLES.MESSAGES, {
      maxRecords: 10,
      filterByFormula: `{Provider Message ID}='${formulaString(providerMessageId)}'`,
    });
    if (rows[0]) return rows[0];
  }
  if (idempotencyKey) return findMessageByKey(deps, idempotencyKey);
  return null;
}

function resolveChannel(job, channel) {
  if (channel === 'auto') return job.fields.Phone ? 'sms' : 'email';
  return channel;
}

export function createRelayDeliveryService(overrides = {}) {
  const deps = {
    createRecord,
    getRecord,
    listRecords,
    logActivity,
    updateRecord,
    provider: createRelayProviderFromEnv(),
    now: () => new Date().toISOString(),
    ...overrides,
  };

  async function createDraft({ jobId, message, messageType, channel = 'sms' }) {
    if (!MESSAGE_TYPES.has(messageType)) throw new Error(`Unsupported RELAY message type: ${messageType}`);
    const job = await deps.getRecord(TABLES.JOBS, jobId);
    const chosenChannel = resolveChannel(job, channel);
    const destination = chosenChannel === 'email' ? job.fields.Email : job.fields.Phone;
    const key = buildIdempotencyKey({ jobId, channel: chosenChannel, destination: destination || '', messageType, message });
    const existing = await findMessageByKey(deps, key);

    if (existing) {
      await deps.updateRecord(TABLES.JOBS, jobId, {
        'RELAY Reply Draft': message,
        'RELAY Next Action': 'Draft is ready in RELAY Messages. Owner must press Send; AI cannot send customer messages.',
      });
      return { ...existing, duplicateDraft: true };
    }

    const now = deps.now();
    const draft = await deps.createRecord(TABLES.MESSAGES, {
      Message: `RELAY draft — ${messageType} — ${now}`,
      Job: [jobId],
      'Idempotency Key': key,
      Channel: chosenChannel.toUpperCase(),
      Destination: destination || '',
      'Message Type': messageType,
      Body: message,
      Status: 'Pending',
      Provider: deps.provider?.name || 'webhook',
      Attempt: 0,
      'Created At': now,
      'Customer Reference': customerReference(job),
    });

    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY Reply Draft': message,
      'RELAY Next Action': 'Draft is ready in RELAY Messages. Owner must press Send; AI cannot send customer messages.',
    });
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'customer_message_drafted',
      status: 'Done',
      detail: `Draft ${draft.id} created for owner review. No external send occurred.`,
    });
    return draft;
  }

  async function sendOwnerApprovedMessage({ messageId, retry = false }) {
    const ledger = await deps.getRecord(TABLES.MESSAGES, messageId);
    const jobId = Array.isArray(ledger.fields.Job) ? ledger.fields.Job[0] : null;
    if (!jobId) throw new Error('RELAY message has no linked job');
    const job = await deps.getRecord(TABLES.JOBS, jobId);
    const status = ledger.fields.Status || 'Pending';

    if (FINAL_OR_IN_FLIGHT.has(status)) {
      return {
        sent: ['Sent', 'Delivered'].includes(status),
        delivered: status === 'Delivered',
        accepted: ['Accepted', 'Sent', 'Delivered'].includes(status),
        duplicate: true,
        status,
        providerMessageId: ledger.fields['Provider Message ID'] || null,
        idempotencyKey: ledger.fields['Idempotency Key'],
      };
    }
    if (status === 'Opted Out') return { sent: false, delivered: false, blocked: true, status, reason: 'Customer is opted out of SMS messaging' };
    if (status === 'Failed' && !retry) {
      return { sent: false, delivered: false, retryRequired: true, status, reason: ledger.fields['Failure Reason'] || 'Previous send failed' };
    }
    if (!['Pending', 'Failed', 'Blocked'].includes(status)) throw new Error(`RELAY message ${messageId} is not sendable from status ${status}`);

    const approval = await pendingOwnerApproval(deps, jobId);
    if (job.fields['RELAY State'] === 'Awaiting Owner' || approval) {
      const reason = approval
        ? `Owner Inbox approval ${approval.id} is still pending`
        : 'Job is awaiting consequential owner approval';
      await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'owner_send_blocked', status: 'Blocked', detail: reason, consequential: true });
      return { sent: false, delivered: false, blocked: true, status, reason };
    }

    const channel = String(ledger.fields.Channel || 'SMS').toLowerCase();
    const destination = ledger.fields.Destination || (channel === 'email' ? job.fields.Email : job.fields.Phone);
    if (channel === 'sms' && job.fields['RELAY SMS Opted Out']) {
      const reason = 'Customer is opted out of SMS messaging';
      await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'owner_send_blocked_opt_out', status: 'Blocked', detail: reason });
      return { sent: false, delivered: false, blocked: true, status: 'Opted Out', reason };
    }
    if (!destination) return { sent: false, delivered: false, blocked: true, reason: `No customer ${channel} destination is available` };

    const priorAttempt = Number(ledger.fields.Attempt || 0);
    if (priorAttempt >= MAX_ATTEMPTS) {
      return { sent: false, delivered: false, blocked: true, status, reason: `Maximum retry attempts (${MAX_ATTEMPTS}) reached` };
    }

    const attempt = priorAttempt + 1;
    const now = deps.now();
    await deps.updateRecord(TABLES.MESSAGES, messageId, {
      Status: 'Sending',
      Attempt: attempt,
      'Last Attempt At': now,
      'Failure Reason': '',
    });

    const result = await deps.provider.send({
      idempotencyKey: ledger.fields['Idempotency Key'],
      jobId,
      customerReference: ledger.fields['Customer Reference'] || customerReference(job),
      channel,
      destination,
      messageType: ledger.fields['Message Type'],
      message: ledger.fields.Body,
      customerName: job.fields['Customer Name'] || null,
    });

    if (!result.ok) {
      const failureReason = String(result.failureReason || 'Outbound provider did not confirm success').slice(0, 10000);
      await deps.updateRecord(TABLES.MESSAGES, messageId, {
        Status: result.status === 'blocked' ? 'Blocked' : 'Failed',
        'Provider Status': result.status || 'failed',
        'Failure Reason': failureReason,
        'Provider Detail': result.providerDetail || '',
      });
      await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'owner_message_send_failed', status: result.status === 'blocked' ? 'Blocked' : 'Error', detail: failureReason });
      return { sent: false, delivered: false, accepted: false, status: result.status || 'failed', reason: failureReason, attempt };
    }

    const providerStatus = result.status;
    const confirmedAt = result.confirmedAt || deps.now();
    const fields = {
      Status: airtableStatus(providerStatus),
      Provider: result.provider || deps.provider?.name || 'webhook',
      'Provider Message ID': result.providerMessageId,
      'Provider Status': providerStatus,
      'Provider Detail': result.providerDetail || '',
      'Failure Reason': '',
    };
    if (providerStatus === 'sent' || providerStatus === 'delivered') fields['Sent At'] = confirmedAt;
    if (providerStatus === 'delivered') fields['Delivered At'] = confirmedAt;
    await deps.updateRecord(TABLES.MESSAGES, messageId, fields);

    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY Reply Draft': ledger.fields.Body,
      ...(providerStatus === 'sent' || providerStatus === 'delivered' ? { 'Last Contacted': confirmedAt } : {}),
      'RELAY State': 'Awaiting Customer',
      'RELAY Next Action': providerStatus === 'delivered'
        ? 'Owner-sent message was provider-confirmed delivered. Await customer response.'
        : providerStatus === 'sent'
          ? 'Owner-sent message was provider-confirmed sent. Await delivery/customer response.'
          : 'Owner explicitly sent the message; provider accepted it. Await status callback before claiming sent/delivered.',
    });
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: `owner_message_${providerStatus}`,
      status: 'Done',
      detail: JSON.stringify({ messageId, channel, destination, provider: result.provider, providerMessageId: result.providerMessageId, providerStatus }).slice(0, 20000),
    });

    return {
      accepted: true,
      sent: providerStatus === 'sent' || providerStatus === 'delivered',
      delivered: providerStatus === 'delivered',
      channel,
      destination,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: providerStatus,
      idempotencyKey: ledger.fields['Idempotency Key'],
      attempt,
    };
  }

  async function applyDeliveryCallback({ providerMessageId, idempotencyKey, status, timestamp, failureReason, providerDetail }) {
    const normalized = String(status || '').toLowerCase();
    if (!CALLBACK_STATUSES.has(normalized)) throw new Error(`Unsupported RELAY callback status: ${status}`);
    const ledger = await findMessageForCallback(deps, { providerMessageId, idempotencyKey });
    if (!ledger) throw new Error('No RELAY message matches the callback identifiers');

    const when = timestamp || deps.now();
    const fields = {
      Status: airtableStatus(normalized),
      'Provider Status': normalized,
      'Failure Reason': normalized === 'failed' ? String(failureReason || 'Provider reported failure').slice(0, 10000) : '',
      'Provider Detail': providerDetail ? String(providerDetail).slice(0, 10000) : ledger.fields['Provider Detail'] || '',
    };
    if (providerMessageId) fields['Provider Message ID'] = providerMessageId;
    if (normalized === 'sent' || normalized === 'delivered') fields['Sent At'] = ledger.fields['Sent At'] || when;
    if (normalized === 'delivered') fields['Delivered At'] = when;
    await deps.updateRecord(TABLES.MESSAGES, ledger.id, fields);

    const jobId = Array.isArray(ledger.fields.Job) ? ledger.fields.Job[0] : null;
    if (jobId) {
      if (normalized === 'sent' || normalized === 'delivered') await deps.updateRecord(TABLES.JOBS, jobId, { 'Last Contacted': when });
      await deps.logActivity({
        agent: 'RELAY',
        jobId,
        actionType: `provider_status_${normalized}`,
        status: normalized === 'failed' ? 'Error' : 'Done',
        detail: normalized === 'failed' ? fields['Failure Reason'] : `Provider confirmed ${normalized} for ${providerMessageId || idempotencyKey}`,
      });
    }
    return { updated: true, status: normalized, delivered: normalized === 'delivered', sent: normalized === 'sent' || normalized === 'delivered' };
  }

  async function applyOptOut({ jobId, destination, source = 'STOP', timestamp }) {
    if (!jobId) throw new Error('jobId is required to apply a RELAY opt-out');
    const when = timestamp || deps.now();
    const job = await deps.getRecord(TABLES.JOBS, jobId);
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY SMS Opted Out': true,
      'RELAY Opted Out At': when,
      'RELAY Opt-Out Source': source,
      'RELAY Next Action': 'Customer opted out of SMS. Do not send SMS unless a compliant opt-in is recorded.',
    });
    await deps.createRecord(TABLES.MESSAGES, {
      Message: `SMS opt-out — ${when}`,
      Job: [jobId],
      'Idempotency Key': buildIdempotencyKey({ jobId, channel: 'sms', destination: destination || job.fields.Phone || '', messageType: 'opt_out', message: source }),
      Channel: 'SMS',
      Destination: destination || job.fields.Phone || '',
      'Message Type': 'opt_out',
      Body: '',
      Status: 'Opted Out',
      Provider: deps.provider?.name || 'webhook',
      Attempt: 0,
      'Created At': when,
      'Customer Reference': customerReference(job),
      'Provider Detail': `Opt-out source: ${source}`,
    });
    await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'customer_sms_opted_out', status: 'Done', detail: `SMS opt-out recorded from ${source}` });
    return { optedOut: true, jobId, timestamp: when };
  }

  return { createDraft, sendOwnerApprovedMessage, applyDeliveryCallback, applyOptOut };
}

export async function createRelayDraft(args) {
  return createRelayDeliveryService().createDraft(args);
}

export async function sendOwnerApprovedMessage(args) {
  return createRelayDeliveryService().sendOwnerApprovedMessage(args);
}

export async function applyDeliveryCallback(args) {
  return createRelayDeliveryService().applyDeliveryCallback(args);
}

export async function applyRelayOptOut(args) {
  return createRelayDeliveryService().applyOptOut(args);
}
