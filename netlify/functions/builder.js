import { analyzeBuilderRequest, createBuilderRequest } from '../../src/builder.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const secret = process.env.GHOSTOS_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (req.headers.get('x-ghostos-secret') !== secret) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    const body = await req.json();
    if (body.action === 'create') {
      if (!body.goal || String(body.goal).trim().length < 5) return json({ ok: false, error: 'goal is required' }, 400);
      const request = await createBuilderRequest({
        goal: String(body.goal).trim(),
        context: String(body.context || ''),
        priority: body.priority || 'Normal',
        requestedBy: 'Owner',
      });
      return json({ ok: true, request });
    }
    if (body.action === 'analyze') {
      if (!body.requestId) return json({ ok: false, error: 'requestId is required' }, 400);
      const request = await analyzeBuilderRequest(body.requestId);
      return json({ ok: true, request });
    }
    return json({ ok: false, error: 'Unsupported action' }, 400);
  } catch (error) {
    console.error('GhostOS BUILDER error', error?.message || error);
    return json({ ok: false, error: error?.message || 'BUILDER request failed' }, 500);
  }
};
