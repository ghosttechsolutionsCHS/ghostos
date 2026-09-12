const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  return json({
    ok: false,
    error: 'Provider-based RELAY sending is disabled. Copy the draft, send it personally, then use Mark as Sent.',
  }, 410);
};
