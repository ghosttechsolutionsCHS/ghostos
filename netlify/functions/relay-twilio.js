import { timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import { buildTwilioCreateOptions, normalizeTwilioCreateResult } from '../../src/twilio-adapter.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

function env(name) {
  return Netlify.env.get(name);
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const relaySecret = env('RELAY_OUTBOUND_WEBHOOK_SECRET');
  if (!relaySecret) return json({ ok: false, error: 'RELAY provider authentication is not configured' }, 503);
  if (!secureEqual(req.headers.get('x-ghostos-relay-secret'), relaySecret)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let payload;
  try { payload = await req.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  if (String(payload.channel || '').toLowerCase() !== 'sms') {
    return json({ ok: false, error: 'Twilio adapter currently supports SMS only' }, 400);
  }
  if (!payload.destination || !payload.message || !payload.idempotencyKey) {
    return json({ ok: false, error: 'destination, message, and idempotencyKey are required' }, 400);
  }

  const accountSid = env('TWILIO_ACCOUNT_SID');
  const authToken = env('TWILIO_AUTH_TOKEN');
  if (!accountSid || !authToken) {
    return json({ ok: false, error: 'Twilio account credentials are not configured' }, 503);
  }

  try {
    const options = buildTwilioCreateOptions({
      to: payload.destination,
      body: payload.message,
      statusCallback: env('TWILIO_STATUS_CALLBACK_URL'),
      messagingServiceSid: env('TWILIO_MESSAGING_SERVICE_SID'),
      fromNumber: env('TWILIO_FROM_NUMBER'),
    });
    const client = twilio(accountSid, authToken);
    const message = await client.messages.create(options);
    const result = normalizeTwilioCreateResult(message);

    if (!result.ok) {
      return json({
        ok: false,
        provider: 'twilio',
        providerMessageId: result.providerMessageId || null,
        status: result.status || 'failed',
        failureReason: result.failureReason || 'Twilio did not accept the message',
      }, 502);
    }

    return json({
      ok: true,
      provider: 'twilio',
      messageId: result.providerMessageId,
      status: result.status,
      timestamp: result.confirmedAt,
      detail: result.detail,
    });
  } catch (error) {
    const status = Number(error?.status || 0);
    const code = error?.code ? `Twilio error ${error.code}` : 'Twilio request failed';
    return json({
      ok: false,
      provider: 'twilio',
      status: 'failed',
      failureReason: `${code}${status ? ` (HTTP ${status})` : ''}`,
    }, 502);
  }
};
