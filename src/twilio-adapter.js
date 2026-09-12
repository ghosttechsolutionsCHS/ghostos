export const TWILIO_SUCCESS_STATUSES = new Set(['accepted', 'queued', 'sending', 'sent', 'delivered']);
export const TWILIO_FAILURE_STATUSES = new Set(['failed', 'undelivered']);

export function normalizeTwilioStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'delivered') return 'delivered';
  if (value === 'sent') return 'sent';
  if (['accepted', 'queued', 'sending'].includes(value)) return 'accepted';
  if (TWILIO_FAILURE_STATUSES.has(value)) return 'failed';
  return 'accepted';
}

export function twilioFailureReason({ status, errorCode, errorMessage } = {}) {
  const pieces = [];
  if (status) pieces.push(`Twilio status ${status}`);
  if (errorCode) pieces.push(`error ${errorCode}`);
  if (errorMessage) pieces.push(String(errorMessage));
  return pieces.join(': ') || 'Twilio reported message failure';
}

export function buildTwilioCreateOptions({
  to,
  body,
  statusCallback,
  messagingServiceSid,
  fromNumber,
}) {
  if (!to) throw new Error('Twilio destination is required');
  if (!body) throw new Error('Twilio message body is required');
  if (!statusCallback) throw new Error('TWILIO_STATUS_CALLBACK_URL is not configured');
  if (!messagingServiceSid && !fromNumber) {
    throw new Error('Configure TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER');
  }

  return {
    to,
    body,
    statusCallback,
    ...(messagingServiceSid ? { messagingServiceSid } : { from: fromNumber }),
  };
}

export function normalizeTwilioCreateResult(message) {
  const status = normalizeTwilioStatus(message?.status);
  const failed = TWILIO_FAILURE_STATUSES.has(String(message?.status || '').toLowerCase());
  if (!message?.sid) {
    return {
      ok: false,
      status: 'failed',
      failureReason: 'Twilio did not return a Message SID',
    };
  }
  if (failed) {
    return {
      ok: false,
      provider: 'twilio',
      providerMessageId: message.sid,
      status: 'failed',
      failureReason: twilioFailureReason({
        status: message.status,
        errorCode: message.errorCode,
        errorMessage: message.errorMessage,
      }),
    };
  }

  return {
    ok: true,
    provider: 'twilio',
    providerMessageId: message.sid,
    status,
    confirmedAt: message.dateUpdated?.toISOString?.() || message.dateCreated?.toISOString?.() || new Date().toISOString(),
    detail: {
      twilioStatus: message.status || null,
      errorCode: message.errorCode || null,
    },
  };
}

export function formDataToObject(formData) {
  const params = {};
  for (const [key, value] of formData.entries()) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      params[key] = Array.isArray(params[key]) ? [...params[key], value] : [params[key], value];
    } else {
      params[key] = value;
    }
  }
  return params;
}

export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}
