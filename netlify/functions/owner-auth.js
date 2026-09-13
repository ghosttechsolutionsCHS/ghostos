function getCookie(req, name) {
  const cookie = req.headers.get('cookie') || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const bootstrap = Netlify.env.get('GHOSTOS_OWNER_BOOTSTRAP_TOKEN') || '';
  const session = Netlify.env.get('GHOSTOS_OWNER_SESSION_TOKEN') || '';
  const supplied = url.searchParams.get('t') || '';
  const current = getCookie(req, 'ghostos_owner');
  const alreadyAuthorized = safeEqual(current, session);
  const bootstrapAuthorized = safeEqual(supplied, bootstrap);

  if (!session || (!alreadyAuthorized && !bootstrapAuthorized)) {
    return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });

  if (bootstrapAuthorized) {
    headers.append('set-cookie', `ghostos_owner=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  }

  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening GhostOS</title><body style="background:#090d18;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><div>Opening GhostOS…</div><script>try{sessionStorage.setItem('ghostosKey','session')}catch(e){}location.replace('/command-center.html')</script></body>`, { status: 200, headers });
};

export const config = { path: '/owner-auth' };
