import twilio from 'twilio';
import { TABLES, listRecords, logActivity } from '../../src/airtable.js';
import { processLead } from '../../src/ghostos.js';
import { applyRelayOptOut } from '../../src/relay-delivery.js';
import { formDataToObject, normalizePhone } from '../../src/twilio-adapter.js';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const twiml = (status = 200) => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
  status,
  headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
});

function env(name) {
  return Netlify.env.get(name);
}

async function findJobByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  const jobs = await listRecords(TABLES.JOBS, { maxRecords: 500 });
  const matches = jobs.filter((job) => normalizePhone(job.fields.Phone) === target);
  return matches.find((job) => !['Completed', 'Lost / Declined'].includes(job.fields.Status)) || matches[0] || null;
}

export default async (req) => {
  if (req.method !== 'POST') return twiml(405);

  const authToken = env('TWILIO_AUTH_TOKEN');
  const inboundUrl = env('TWILIO_INBOUND_WEBHOOK_URL');
  const signature = req.headers.get('x-twilio-signature');
  if (!authToken || !inboundUrl) return twiml(503);

  const formData = await req.formData();
  const params = formDataToObject(formData);
  if (!signature || !twilio.validateRequest(authToken, signature, inboundUrl, params)) return twiml(401);

  const from = String(params.From || '');
  const body = String(params.Body || '');
  const optOutType = String(params.OptOutType || '').toUpperCase();
  const job = await findJobByPhone(from);

  if (optOutType === 'STOP' || STOP_WORDS.has(body.trim().toUpperCase())) {
    if (job) {
      await applyRelayOptOut({
        jobId: job.id,
        destination: from,
        source: optOutType === 'STOP' ? 'Twilio Advanced Opt-Out STOP' : `Twilio STOP keyword: ${body.trim().toUpperCase()}`,
        timestamp: new Date().toISOString(),
      });
    }
    return twiml();
  }

  if (!job) return twiml();

  try {
    await logActivity({
      agent: 'RELAY',
      jobId: job.id,
      actionType: 'customer_sms_received',
      status: 'Done',
      detail: `Inbound SMS received from customer; RELAY will analyze and may prepare a draft. Provider message ID: ${params.MessageSid || params.SmsSid || 'unknown'}`,
    });
    await processLead(job.id, {
      source: 'twilio_inbound_sms',
      from,
      to: params.To || null,
      message: body,
      providerMessageId: params.MessageSid || params.SmsSid || null,
    });
  } catch (error) {
    await logActivity({
      agent: 'RELAY',
      jobId: job.id,
      actionType: 'customer_sms_analysis_failed',
      status: 'Error',
      detail: error?.message || 'Inbound SMS analysis failed',
    });
  }

  // Intentionally empty: GhostOS never auto-replies. Any response becomes a dashboard draft.
  return twiml();
};
