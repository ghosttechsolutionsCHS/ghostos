const CONFIRMED_STATUSES = new Set(['accepted', 'sent', 'delivered']);
const SECRET_KEY_PATTERN = /(secret|token|password|authorization|api[-_]?key|credential)/i;

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function redactSecrets(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(item, depth + 1),
  ]));
}

function safeProviderDetail(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10000);
  try { return JSON.stringify(redactSecrets(value)).slice(0, 10000); } catch { return '[unserializable provider detail]'; }
}

export class WebhookRelayProvider {
  constructor({ url, secret, fetchImpl = globalThis.fetch } = {}) {
    this.name = 'webhook';
    this.url = url;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async send(request) {
    if (!this.url) {
      return { ok: false, status: 'blocked', failureReason: 'RELAY_OUTBOUND_WEBHOOK_URL is not configured' };
    }
    if (typeof this.fetchImpl !== 'function') throw new Error('No fetch implementation is available for RELAY provider');

    const headers = {
      'content-type': 'application/json',
      'x-ghostos-idempotency-key': request.idempotencyKey,
    };
    if (this.secret) headers['x-ghostos-relay-secret'] = this.secret;

    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          source: 'GhostOS/RELAY',
          idempotencyKey: request.idempotencyKey,
          jobId: request.jobId,
          customerReference: request.customerReference || null,
          channel: request.channel,
          destination: request.destination,
          messageType: request.messageType,
          message: request.message,
          customerName: request.customerName || null,
        }),
      });
    } catch (error) {
      return { ok: false, status: 'failed', failureReason: `Provider network failure: ${error?.message || String(error)}` };
    }

    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    if (!response.ok) {
      return {
        ok: false,
        status: 'failed',
        httpStatus: response.status,
        failureReason: body?.error || body?.failureReason || `Provider returned HTTP ${response.status}`,
        providerDetail: safeProviderDetail(body || text),
      };
    }

    const status = normalizeStatus(body?.status);
    const providerMessageId = body?.messageId || body?.providerMessageId || null;
    const confirmed = body?.ok === true && Boolean(providerMessageId) && CONFIRMED_STATUSES.has(status);

    if (!confirmed) {
      return {
        ok: false,
        status: 'failed',
        failureReason: 'Provider response did not confirm success with ok=true, a message ID, and an accepted/sent/delivered status',
        providerDetail: safeProviderDetail(body || text),
      };
    }

    return {
      ok: true,
      provider: body?.provider || this.name,
      providerMessageId: String(providerMessageId),
      status,
      confirmedAt: body?.timestamp || body?.confirmedAt || new Date().toISOString(),
      providerDetail: safeProviderDetail(body?.detail || body),
    };
  }
}

export function createRelayProviderFromEnv(options = {}) {
  return new WebhookRelayProvider({
    url: process.env.RELAY_OUTBOUND_WEBHOOK_URL,
    secret: process.env.RELAY_OUTBOUND_WEBHOOK_SECRET,
    fetchImpl: options.fetchImpl || globalThis.fetch,
  });
}
