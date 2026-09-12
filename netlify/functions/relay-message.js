import { markRelayManuallySent, updateRelayDraft } from '../../src/relay-delivery.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

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
