// Netlify Functions v2. The filename determines the default route, so this
// handler is served at /.netlify/functions/ghostos (and /api/ghostos via the
// redirect in netlify.toml).

const HEALTH = {
  ok: true,
  service: 'ghostos',
  status: 'online',
};

export default async (req) => {
  // GET/HEAD act as an unauthenticated health probe so the endpoint can be
  // verified from a browser or an uptime check without the webhook secret.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return Response.json(
      { ...HEALTH, time: new Date().toISOString() },
      { headers: { 'cache-control': 'no-store' } }
    );
  }

  if (req.method !== 'POST') {
    return Response.json(
      { ok: false, error: 'Method not allowed' },
      { status: 405, headers: { allow: 'GET, HEAD, POST' } }
    );
  }

  const expected = process.env.GHOSTOS_WEBHOOK_SECRET;
  if (expected && req.headers.get('x-ghostos-secret') !== expected) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const recordId = body.recordId || body.record_id || null;
    const lead = body.lead || body;

    // Imported lazily: the agent graph and its SDK are only needed for real
    // webhook traffic, so a cold start or health check never pays that cost
    // (and a misconfigured key cannot take the whole endpoint down).
    const { processLead } = await import('../../src/ghostos.js');
    const output = await processLead(recordId, lead);

    return Response.json({ ok: true, output });
  } catch (e) {
    console.error('GhostOS function error:', e);
    return Response.json(
      { ok: false, error: e?.message || 'GhostOS error' },
      { status: 500 }
    );
  }
};
