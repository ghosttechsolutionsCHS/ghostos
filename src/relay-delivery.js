import { TABLES, getRecord, logActivity, updateRecord } from './airtable.js';

const ROUTINE_TYPES = new Set([
  'clarification',
  'quote',
  'follow_up',
  'status_update',
  'scheduling_question',
]);

export async function deliverRoutineMessage({ jobId, message, messageType, channel = 'auto' }) {
  if (!ROUTINE_TYPES.has(messageType)) {
    throw new Error(`Message type ${messageType} is not eligible for automatic RELAY delivery`);
  }

  const job = await getRecord(TABLES.JOBS, jobId);
  if (job.fields['RELAY State'] === 'Awaiting Owner') {
    throw new Error('RELAY cannot auto-send while the job is awaiting owner approval');
  }

  const url = process.env.RELAY_OUTBOUND_WEBHOOK_URL;
  if (!url) {
    await logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'routine_message_not_sent',
      status: 'Blocked',
      detail: 'RELAY_OUTBOUND_WEBHOOK_URL is not configured. Draft remains in Airtable.',
    });
    return { delivered: false, reason: 'RELAY_OUTBOUND_WEBHOOK_URL is not configured' };
  }

  const destination = channel === 'email'
    ? job.fields.Email
    : channel === 'sms'
      ? job.fields.Phone
      : (job.fields.Phone || job.fields.Email);

  if (!destination) {
    return { delivered: false, reason: 'No customer phone or email is available for delivery' };
  }

  const chosenChannel = channel === 'auto'
    ? (job.fields.Phone ? 'sms' : 'email')
    : channel;

  const headers = { 'content-type': 'application/json' };
  if (process.env.RELAY_OUTBOUND_WEBHOOK_SECRET) {
    headers['x-ghostos-relay-secret'] = process.env.RELAY_OUTBOUND_WEBHOOK_SECRET;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'GhostOS/RELAY',
      jobId,
      channel: chosenChannel,
      destination,
      messageType,
      message,
      customerName: job.fields['Customer Name'] || null,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    await logActivity({
      agent: 'RELAY',
      jobId,
      actionType: 'routine_message_delivery_failed',
      status: 'Error',
      detail: `HTTP ${response.status}: ${responseText.slice(0, 2000)}`,
    });
    throw new Error(`Outbound RELAY provider failed with HTTP ${response.status}`);
  }

  let providerResult = null;
  try { providerResult = responseText ? JSON.parse(responseText) : null; } catch { providerResult = { raw: responseText }; }

  const now = new Date().toISOString();
  await updateRecord(TABLES.JOBS, jobId, {
    'RELAY Reply Draft': message,
    'Last Contacted': now,
    'RELAY State': 'Awaiting Customer',
    'RELAY Next Action': 'Routine message delivered. Await customer response and follow up only when due.',
  });
  await logActivity({
    agent: 'RELAY',
    jobId,
    actionType: 'routine_message_delivered',
    status: 'Done',
    detail: JSON.stringify({ channel: chosenChannel, destination, providerResult }).slice(0, 20000),
  });

  return { delivered: true, channel: chosenChannel, destination, providerResult };
}
