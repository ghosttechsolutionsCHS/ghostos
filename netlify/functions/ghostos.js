import { z } from 'zod';
import { processLead } from '../../src/ghostos.js';

const requestSchema = z.object({
  recordId: z.string().trim().min(1).max(128).optional(),
  record_id: z.string().trim().min(1).max(128).optional(),
  lead: z.unknown().optional(),
}).passthrough();

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

export default async (req) => {
  if (req.method === 'GET') {
    return json({ ok: true, service: 'GhostOS', status: 'online' });
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const configuredSecret = process.env.GHOSTOS_WEBHOOK_SECRET;
  if (!configuredSecret) {
    console.error('GHOSTOS_WEBHOOK_SECRET is not configured');
    return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  }

  if (req.headers.get('x-ghostos-secret') !== configuredSecret) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    const parsed = requestSchema.parse(await req.json());
    const recordId = parsed.recordId || parsed.record_id || null;
    const lead = parsed.lead ?? parsed;

    const output = await processLead(recordId, lead);
    return json({ ok: true, output });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json({ ok: false, error: 'Invalid request payload', details: error.issues }, 400);
    }

    console.error('GhostOS webhook error', error);
    return json({ ok: false, error: error?.message || 'GhostOS error' }, 500);
  }
};
