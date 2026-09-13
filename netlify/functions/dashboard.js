import { getDashboardSnapshot } from '../../src/airtable.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

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
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const secret = Netlify.env.get('GHOSTOS_WEBHOOK_SECRET') || '';
  const ownerSession = Netlify.env.get('GHOSTOS_OWNER_SESSION_TOKEN') || '';
  const headerAuthorized = safeEqual(req.headers.get('x-ghostos-secret') || '', secret);
  const cookieAuthorized = safeEqual(getCookie(req, 'ghostos_owner'), ownerSession);
  if (!secret && !ownerSession) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (!headerAuthorized && !cookieAuthorized) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    return json({ ok: true, ...(await getDashboardSnapshot()) });
  } catch (error) {
    console.error('GhostOS dashboard error', error);
    return json({ ok: false, error: error?.message || 'Dashboard error' }, 500);
  }
};
