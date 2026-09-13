import { getDashboardSnapshot } from '../../src/airtable.js';
import { ownerAuthorized } from '../../src/owner-session.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

export default async (req) => {
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const secret = Netlify.env.get('GHOSTOS_WEBHOOK_SECRET') || '';
  if (!secret) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (!ownerAuthorized(req, secret)) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    return json({ ok: true, ...(await getDashboardSnapshot()) });
  } catch (error) {
    console.error('GhostOS dashboard error', error);
    return json({ ok: false, error: error?.message || 'Dashboard error' }, 500);
  }
};
