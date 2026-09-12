import { sendOwnerApprovedMessage } from '../../src/relay-delivery.js';

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
    const { messageId, retry = false } = await req.json();
    if (!messageId) return json({ ok: false, error: 'messageId is required' }, 400);

    const result = await sendOwnerApprovedMessage({ messageId, retry: Boolean(retry) });
    const status = result.blocked ? 409 : result.retryRequired ? 409 : 200;
    return json({ ok: !result.blocked && !result.retryRequired, ...result }, status);
  } catch (error) {
    console.error('GhostOS RELAY owner-send error', error?.message || error);
    return json({ ok: false, error: error?.message || 'RELAY send error' }, 500);
  }
};
