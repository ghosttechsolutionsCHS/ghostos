import { timingSafeEqual } from 'node:crypto';
import { applyDeliveryCallback, applyRelayOptOut } from '../../src/relay-delivery.js';

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { allow: 'POST' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const expected = process.env.RELAY_OUTBOUND_WEBHOOK_SECRET;
  if (!expected) {
    return { statusCode: 503, body: JSON.stringify({ error: 'RELAY callback authentication is not configured' }) };
  }
  const supplied = event.headers?.['x-ghostos-relay-secret'] || event.headers?.['X-Ghostos-Relay-Secret'];
  if (!secureEqual(supplied, expected)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  try {
    if (payload.type === 'delivery_status') {
      if (!payload.providerMessageId && !payload.idempotencyKey) {
        return { statusCode: 400, body: JSON.stringify({ error: 'providerMessageId or idempotencyKey is required' }) };
      }
      if (!payload.status) return { statusCode: 400, body: JSON.stringify({ error: 'status is required' }) };
      const result = await applyDeliveryCallback({
        providerMessageId: payload.providerMessageId,
        idempotencyKey: payload.idempotencyKey,
        status: payload.status,
        timestamp: payload.timestamp,
        failureReason: payload.failureReason,
        providerDetail: payload.providerDetail,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    }

    if (payload.type === 'opt_out') {
      if (!payload.jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required' }) };
      const result = await applyRelayOptOut({
        jobId: payload.jobId,
        destination: payload.destination,
        source: payload.source || 'STOP',
        timestamp: payload.timestamp,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unsupported callback type' }) };
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error?.message || 'Callback failed' }) };
  }
};
