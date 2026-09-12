import { TABLES, getRecord, listRecords } from '../../src/airtable.js';
import { markRelayManuallySent, updateRelayDraft } from '../../src/relay-delivery.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

async function manualSendBlockReason(messageId) {
  const message = await getRecord(TABLES.MESSAGES, messageId);
  const jobId = Array.isArray(message.fields.Job) ? message.fields.Job[0] : null;
  if (!jobId) return 'RELAY message has no linked job';
  const job = await getRecord(TABLES.JOBS, jobId);
  if (job.fields['RELAY State'] === 'Awaiting Owner') return 'Job is awaiting consequential owner approval';
  const approvals = await listRecords(TABLES.APPROVALS, { maxRecords: 200 });
  const pending = approvals.find((record) => (
    record.fields.Status === 'Pending'
    && Array.isArray(record.fields.Job)
    && record.fields.Job.includes(jobId)
  ));
  return pending ? `Owner Inbox approval ${pending.id} is still pending` : null;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const secret = process.env.GHOSTOS_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (req.headers.get('x-ghostos-secret') !== secret) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    const { action, messageId, message } = await req.json();
    if (!messageId) return json({ ok: false, error: 'messageId is required' }, 400);

    if (action === 'update_draft') {
      const updated = await updateRelayDraft({ messageId, message });
      return json({ ok: true, messageId: updated.id, status: updated.fields?.Status || 'Pending' });
    }

    if (action === 'mark_sent') {
      const blocked = await manualSendBlockReason(messageId);
      if (blocked) return json({ ok: false, blocked: true, error: blocked }, 409);
      const result = await markRelayManuallySent({
        messageId,
        message,
        method: 'owner_phone_copy_paste',
      });
      return json({ ok: !result.blocked, ...result }, result.blocked ? 409 : 200);
    }

    return json({ ok: false, error: 'Unsupported action' }, 400);
  } catch (error) {
    console.error('GhostOS RELAY manual-message error', error?.message || error);
    return json({ ok: false, error: error?.message || 'RELAY message update failed' }, 500);
  }
};
