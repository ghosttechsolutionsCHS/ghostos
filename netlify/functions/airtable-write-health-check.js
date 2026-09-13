import { runAirtableWriteHealthCheck } from '../../src/airtable-health.js';

export default async () => {
  const tokenLoaded = Boolean(globalThis.Netlify?.env?.get?.('AIRTABLE_PAT') || process.env.AIRTABLE_PAT);
  const result = await runAirtableWriteHealthCheck({ tokenLoaded });
  const payload = { ok: result.writeSucceeded && result.readAfterWriteSucceeded, ...result };
  if (payload.ok) console.log('GhostOS Airtable write health check', JSON.stringify(payload));
  else console.error('GhostOS Airtable write health check failed', JSON.stringify(payload));
  return Response.json(payload, { status: payload.ok ? 200 : 500, headers: { 'cache-control': 'no-store' } });
};

// Published deploys only. The core is idempotent by health-check version, so only one
// labeled Agent Activity record is created for this diagnostic version.
export const config = { schedule: '* * * * *' };
