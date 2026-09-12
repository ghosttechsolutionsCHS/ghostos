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

const ROUTINE_TYPES = new Set([
  'clarification',
  'quote',
  'follow_up',
  'status_update',
  'scheduling_question',
]);
const ACTIVE_OR_CONFIRMED = new Set(['Pending', 'Sending', 'Accepted', 'Sent', 'Delivered']);
const CALLBACK_STATUSES = new Set(['accepted', 'sent', 'delivered', 'failed']);
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

  async function blockMessage({ job, jobId, message, messageType, channel, destination, key, status, reason }) {
    const now = deps.now();
    const existing = await findMessageByKey(deps, key);
    if (!existing) {
      await deps.createRecord(TABLES.MESSAGES, {
        Message: `RELAY ${messageType} — ${now}`,
        Job: [jobId],
        'Idempotency Key': key,
        Channel: channel.toUpperCase(),
        Destination: destination || '',
        'Message Type': messageType,
        Body: message,
        Status: status,
        Provider: deps.provider?.name || 'webhook',
        Attempt: 0,
        'Created At': now,
        'Failure Reason': reason,
        'Customer Reference': customerReference(job),
      });
    }
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'routine_message_blocked',
      status: 'Blocked',
      detail: reason,
      consequential: status === 'Blocked',
    });
    return { sent: false, delivered: false, blocked: true, reason, idempotencyKey: key };
  }

  async function deliverRoutineMessage({ jobId, message, messageType, channel = 'auto', retry = false }) {
    if (!ROUTINE_TYPES.has(messageType)) {
      throw new Error(`Message type ${messageType} is not eligible for automatic RELAY delivery`);
    }

    const job = await deps.getRecord(TABLES.JOBS, jobId);
    const chosenChannel = channel === 'auto'
      ? (job.fields.Phone ? 'sms' : 'email')
      : channel;
    const destination = chosenChannel === 'email' ? job.fields.Email : job.fields.Phone;
    const key = buildIdempotencyKey({ jobId, channel: chosenChannel, destination: destination || '', messageType, message });

    if (job.fields['RELAY State'] === 'Awaiting Owner') {
      return blockMessage({ job, jobId, message, messageType, channel: chosenChannel, destination, key, status: 'Blocked', reason: 'RELAY cannot auto-send while the job is awaiting owner approval' });
    }
    const approval = await pendingOwnerApproval(deps, jobId);
    if (approval) {
      return blockMessage({ job, jobId, message, messageType, channel: chosenChannel, destination, key, status: 'Blocked', reason: `RELAY cannot auto-send while Owner Inbox approval ${approval.id} is pending` });
    }
    if (chosenChannel === 'sms' && job.fields['RELAY SMS Opted Out']) {
      return blockMessage({ job, jobId, message, messageType, channel: chosenChannel, destination, key, status: 'Opted Out', reason: 'Customer is opted out of SMS messaging' });
    }
    if (!destination) {
      return blockMessage({ job, jobId, message, messageType, channel: chosenChannel, destination, key, status: 'Blocked', reason: `No customer ${chosenChannel} destination is available` });
    }

    let ledger = await findMessageByKey(deps, key);
    if (ledger && ACTIVE_OR_CONFIRMED.has(ledger.fields.Status)) {
      await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'routine_message_duplicate_prevented', status: 'Done', detail: `Duplicate send prevented for ${key}` });
      return {
        sent: ['Sent', 'Delivered'].includes(ledger.fields.Status),
        delivered: ledger.fields.Status === 'Delivered',
        accepted: ['Accepted', 'Sent', 'Delivered'].includes(ledger.fields.Status),
        duplicate: true,
        idempotencyKey: key,
        providerMessageId: ledger.fields['Provider Message ID'] || null,
        status: ledger.fields.Status,
      };
    }

    const priorAttempt = Number(ledger?.fields.Attempt || 0);
    if (ledger && !retry) {
      return { sent: false, delivered: false, duplicate: true, retryRequired: true, status: ledger.fields.Status, reason: ledger.fields['Failure Reason'] || 'Previous attempt did not succeed', idempotencyKey: key };
    }
    if (priorAttempt >= MAX_ATTEMPTS) {
      return { sent: false, delivered: false, blocked: true, status: ledger?.fields.Status || 'Failed', reason: `Maximum retry attempts (${MAX_ATTEMPTS}) reached`, idempotencyKey: key };
    }

    const now = deps.now();
    const attempt = priorAttempt + 1;
    const initialFields = {
      Message: `RELAY ${messageType} — ${now}`,
      Job: [jobId],
      'Idempotency Key': key,
      Channel: chosenChannel.toUpperCase(),
      Destination: destination,
      'Message Type': messageType,
      Body: message,
      Status: 'Sending',
      Provider: deps.provider?.name || 'webhook',
      Attempt: attempt,
      'Last Attempt At': now,
      'Failure Reason': '',
      'Customer Reference': customerReference(job),
    };
    if (!ledger) {
      initialFields['Created At'] = now;
      ledger = await deps.createRecord(TABLES.MESSAGES, initialFields);
    } else {
      ledger = await deps.updateRecord(TABLES.MESSAGES, ledger.id, initialFields);
    }

    const result = await deps.provider.send({
      idempotencyKey: key,
      jobId,
      customerReference: customerReference(job),
      channel: chosenChannel,
      destination,
      messageType,
      message,
      customerName: job.fields['Customer Name'] || null,
    });

    if (!result.ok) {
      const failureReason = String(result.failureReason || 'Outbound provider did not confirm success').slice(0, 10000);
      await deps.updateRecord(TABLES.MESSAGES, ledger.id, {
        Status: result.status === 'blocked' ? 'Blocked' : 'Failed',
        'Provider Status': result.status || 'failed',
        'Failure Reason': failureReason,
        'Provider Detail': result.providerDetail || '',
      });
      await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'routine_message_delivery_failed', status: result.status === 'blocked' ? 'Blocked' : 'Error', detail: failureReason });
      return { sent: false, delivered: false, accepted: false, status: result.status || 'failed', reason: failureReason, idempotencyKey: key, attempt };
    }

    const status = airtableStatus(result.status);
    const confirmedAt = result.confirmedAt || deps.now();
    const fields = {
      Status: status,
      Provider: result.provider || deps.provider?.name || 'webhook',
      'Provider Message ID': result.providerMessageId,
      'Provider Status': result.status,
      'Provider Detail': result.providerDetail || '',
      'Failure Reason': '',
    };
    if (result.status === 'sent' || result.status === 'delivered') fields['Sent At'] = confirmedAt;
    if (result.status === 'delivered') fields['Delivered At'] = confirmedAt;
    await deps.updateRecord(TABLES.MESSAGES, ledger.id, fields);

    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY Reply Draft': message,
      ...(result.status === 'sent' || result.status === 'delivered' ? { 'Last Contacted': confirmedAt } : {}),
      'RELAY State': 'Awaiting Customer',
      'RELAY Next Action': result.status === 'delivered'
        ? 'Provider confirmed delivery. Await customer response and follow up only when due.'
        : result.status === 'sent'
          ? 'Provider confirmed the message was sent. Await delivery/customer response.'
          : 'Provider accepted the message. Await a delivery status callback before claiming it was sent or delivered.',
    });
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: `routine_message_${result.status}`,
      status: 'Done',
      detail: JSON.stringify({ channel: chosenChannel, destination, provider: result.provider, providerMessageId: result.providerMessageId, providerStatus: result.status, idempotencyKey: key }).slice(0, 20000),
    });

    return {
      accepted: true,
      sent: result.status === 'sent' || result.status === 'delivered',
      delivered: result.status === 'delivered',
      channel: chosenChannel,
      destination,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: result.status,
      idempotencyKey: key,
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
      if (normalized === 'sent' || normalized === 'delivered') {
        await deps.updateRecord(TABLES.JOBS, jobId, { 'Last Contacted': when });
      }
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

  return { deliverRoutineMessage, applyDeliveryCallback, applyOptOut };
}

export async function deliverRoutineMessage(args) {
  return createRelayDeliveryService().deliverRoutineMessage(args);
}

export async function applyDeliveryCallback(args) {
  return createRelayDeliveryService().applyDeliveryCallback(args);
}

export async function applyRelayOptOut(args) {
  return createRelayDeliveryService().applyOptOut(args);
}
