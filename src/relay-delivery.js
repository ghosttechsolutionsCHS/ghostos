import { createHash } from 'node:crypto';
import {
  TABLES,
  createRecord,
  getRecord,
  listRecords,
  logActivity,
  updateRecord,
} from './airtable.js';

const MESSAGE_TYPES = new Set([
  'clarification',
  'quote',
  'follow_up',
  'status_update',
  'scheduling_question',
]);
const CALLBACK_STATUSES = new Set(['accepted', 'sent', 'delivered', 'failed']);
const EDITABLE_STATUSES = new Set(['Pending', 'Blocked', 'Failed']);

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
        'RELAY Next Action': 'Draft is ready in RELAY Messages. Review/edit it, copy it, send it personally, then mark it sent manually.',
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
      Provider: '',
      'Provider Status': '',
      Attempt: 0,
      'Created At': now,
      'Customer Reference': customerReference(job),
      'Send Method': '',
    });

    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY Reply Draft': message,
      'RELAY Next Action': 'Draft is ready in RELAY Messages. Review/edit it, copy it, send it personally, then mark it sent manually.',
    });
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'customer_message_drafted',
      status: 'Done',
      detail: `Draft ${draft.id} created for manual owner copy/send. No external send occurred.`,
    });
    return draft;
  }

  async function updateDraft({ messageId, message }) {
    const body = String(message || '').trim();
    if (!body) throw new Error('Draft message cannot be empty');
    if (body.length > 20000) throw new Error('Draft message is too long');

    const ledger = await deps.getRecord(TABLES.MESSAGES, messageId);
    const status = ledger.fields.Status || 'Pending';
    if (!EDITABLE_STATUSES.has(status)) {
      throw new Error(`RELAY message ${messageId} cannot be edited from status ${status}`);
    }
    const jobId = Array.isArray(ledger.fields.Job) ? ledger.fields.Job[0] : null;
    if (!jobId) throw new Error('RELAY message has no linked job');
    const job = await deps.getRecord(TABLES.JOBS, jobId);
    const channel = String(ledger.fields.Channel || 'SMS').toLowerCase();
    const destination = ledger.fields.Destination || (channel === 'email' ? job.fields.Email : job.fields.Phone) || '';
    const messageType = ledger.fields['Message Type'] || 'follow_up';
    const key = buildIdempotencyKey({ jobId, channel, destination, messageType, message: body });

    const updated = await deps.updateRecord(TABLES.MESSAGES, messageId, {
      Body: body,
      'Idempotency Key': key,
      Status: 'Pending',
      Provider: '',
      'Provider Message ID': '',
      'Provider Status': '',
      'Provider Detail': '',
      'Failure Reason': '',
      Attempt: 0,
      'Last Attempt At': null,
      'Manual Sent At': null,
      'Send Method': '',
      'Sent At': null,
      'Delivered At': null,
    });
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY Reply Draft': body,
      'RELAY Next Action': 'Draft updated. Copy it, send it personally from your phone, then mark it sent manually.',
    });
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'customer_message_draft_edited',
      status: 'Done',
      detail: `Draft ${messageId} edited by owner. No external send occurred.`,
    });
    return updated;
  }

  async function markManuallySent({ messageId, message, method = 'owner_phone_copy_paste' }) {
    let ledger = await deps.getRecord(TABLES.MESSAGES, messageId);
    const status = ledger.fields.Status || 'Pending';
    if (ledger.fields['Send Method'] === 'owner_phone_copy_paste' && ledger.fields['Manual Sent At']) {
      return {
        sent: true,
        delivered: false,
        duplicate: true,
        manual: true,
        status: 'Sent',
        manualSentAt: ledger.fields['Manual Sent At'],
        method: ledger.fields['Send Method'],
      };
    }
    if (!EDITABLE_STATUSES.has(status)) {
      throw new Error(`RELAY message ${messageId} cannot be manually marked sent from status ${status}`);
    }

    const jobId = Array.isArray(ledger.fields.Job) ? ledger.fields.Job[0] : null;
    if (!jobId) throw new Error('RELAY message has no linked job');
    const job = await deps.getRecord(TABLES.JOBS, jobId);
    const channel = String(ledger.fields.Channel || 'SMS').toLowerCase();
    if (channel === 'sms' && job.fields['RELAY SMS Opted Out']) {
      return { sent: false, delivered: false, blocked: true, reason: 'Customer is marked opted out of SMS. Do not send this text.' };
    }

    if (message !== undefined && String(message).trim() !== String(ledger.fields.Body || '').trim()) {
      await updateDraft({ messageId, message });
      ledger = await deps.getRecord(TABLES.MESSAGES, messageId);
    }

    const when = deps.now();
    const sendMethod = String(method || 'owner_phone_copy_paste').slice(0, 250);
    await deps.updateRecord(TABLES.MESSAGES, messageId, {
      Status: 'Sent',
      'Manual Sent At': when,
      'Send Method': sendMethod,
      'Sent At': when,
      'Delivered At': null,
      Provider: 'Manual owner report',
      'Provider Message ID': '',
      'Provider Status': 'owner_reported_sent',
      'Provider Detail': 'Owner reported sending this message manually outside GhostOS. Delivery was not verified.',
      'Failure Reason': '',
    });
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY Reply Draft': ledger.fields.Body,
      'Last Contacted': when,
      'RELAY State': 'Awaiting Customer',
      'RELAY Next Action': 'Owner reported this message sent manually from their phone. Await customer response. Delivery is not verified.',
    });
    await deps.logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'owner_reported_manual_send',
      status: 'Done',
      detail: JSON.stringify({ messageId, method: sendMethod, sentAt: when, deliveryVerified: false }).slice(0, 20000),
    });

    return { sent: true, delivered: false, manual: true, status: 'Sent', manualSentAt: when, method: sendMethod };
  }

  // Legacy provider callbacks remain isolated for historical provider-tracked records only.
  // They are not part of normal GhostOS operation and are never required for manual copy/send.
  async function applyDeliveryCallback({ providerMessageId, idempotencyKey, status, timestamp, failureReason, providerDetail }) {
    const normalized = String(status || '').toLowerCase();
    if (!CALLBACK_STATUSES.has(normalized)) throw new Error(`Unsupported RELAY callback status: ${status}`);
    const ledger = await findMessageForCallback(deps, { providerMessageId, idempotencyKey });
    if (!ledger) throw new Error('No RELAY message matches the callback identifiers');
    if (ledger.fields['Send Method'] === 'owner_phone_copy_paste' || ledger.fields['Manual Sent At']) {
      throw new Error('Manual owner-reported messages cannot be updated by provider delivery callbacks');
    }

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
        actionType: `legacy_provider_status_${normalized}`,
        status: normalized === 'failed' ? 'Error' : 'Done',
        detail: normalized === 'failed' ? fields['Failure Reason'] : `Legacy provider confirmed ${normalized} for ${providerMessageId || idempotencyKey}`,
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
      'RELAY Next Action': 'Customer is marked opted out of SMS. Keep this visible for owner reference and do not prepare/send SMS unless a compliant opt-in is recorded.',
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
      Provider: '',
      Attempt: 0,
      'Created At': when,
      'Customer Reference': customerReference(job),
      'Provider Detail': `Opt-out source: ${source}`,
      'Send Method': '',
    });
    await deps.logActivity({ agent: 'RELAY', jobId, actionType: 'customer_sms_opted_out', status: 'Done', detail: `SMS opt-out recorded from ${source}` });
    return { optedOut: true, jobId, timestamp: when };
  }

  return { createDraft, updateDraft, markManuallySent, applyDeliveryCallback, applyOptOut };
}

export async function createRelayDraft(args) {
  return createRelayDeliveryService().createDraft(args);
}

export async function updateRelayDraft(args) {
  return createRelayDeliveryService().updateDraft(args);
}

export async function markRelayManuallySent(args) {
  return createRelayDeliveryService().markManuallySent(args);
}

export async function applyDeliveryCallback(args) {
  return createRelayDeliveryService().applyDeliveryCallback(args);
}

export async function applyRelayOptOut(args) {
  return createRelayDeliveryService().applyOptOut(args);
}
