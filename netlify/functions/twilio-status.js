import twilio from 'twilio';
import { applyDeliveryCallback } from '../../src/relay-delivery.js';
import { formDataToObject, normalizeTwilioStatus, twilioFailureReason } from '../../src/twilio-adapter.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

function env(name) {
  return Netlify.env.get(name);
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const authToken = env('TWILIO_AUTH_TOKEN');
  const callbackUrl = env('TWILIO_STATUS_CALLBACK_URL');
  const signature = req.headers.get('x-twilio-signature');
  if (!authToken || !callbackUrl) return json({ ok: false, error: 'Twilio callback validation is not configured' }, 503);

  const formData = await req.formData();
  const params = formDataToObject(formData);
  if (!signature || !twilio.validateRequest(authToken, signature, callbackUrl, params)) {
    return json({ ok: false, error: 'Invalid Twilio signature' }, 401);
  }

  const providerMessageId = params.MessageSid || params.SmsSid;
  const rawStatus = String(params.MessageStatus || params.SmsStatus || '').toLowerCase();
  if (!providerMessageId || !rawStatus) return json({ ok: false, error: 'Twilio MessageSid and MessageStatus are required' }, 400);

  const normalized = normalizeTwilioStatus(rawStatus);
  const failureReason = normalized === 'failed'
    ? twilioFailureReason({ status: rawStatus, errorCode: params.ErrorCode })
    : undefined;

  try {
    const result = await applyDeliveryCallback({
      providerMessageId,
      status: normalized,
      timestamp: new Date().toISOString(),
      failureReason,
      providerDetail: JSON.stringify({ twilioStatus: rawStatus, errorCode: params.ErrorCode || null }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Twilio status update failed' }, 400);
  }
};
