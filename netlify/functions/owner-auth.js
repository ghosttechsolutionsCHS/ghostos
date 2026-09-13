import { ownerAuthorized, ownerSessionFor, validBootstrapToken } from '../../src/owner-session.js';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const secret = Netlify.env.get('GHOSTOS_WEBHOOK_SECRET') || '';
  if (!secret) return new Response('GhostOS is not configured', { status: 503, headers: { 'cache-control': 'no-store' } });

  const url = new URL(req.url);
  const supplied = url.searchParams.get('t') || '';
  const alreadyAuthorized = ownerAuthorized(req, secret);
  const bootstrapAuthorized = validBootstrapToken(supplied);

  if (!alreadyAuthorized && !bootstrapAuthorized) {
    return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });

  if (bootstrapAuthorized) {
    const session = ownerSessionFor(secret);
    headers.append('set-cookie', `ghostos_owner=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  }

  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening GhostOS</title><body style="background:#090d18;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><div>Opening GhostOS…</div><script>location.replace('/command-center.html')</script></body>`, { status: 200, headers });
};

export const config = { path: '/owner-auth' };
