import { runAirtableWriteHealthCheck } from '../../src/airtable-health.js';

export default async () => {
  const result = await runAirtableWriteHealthCheck();
  const verified = Boolean(result.writeSucceeded && result.readAfterWriteSucceeded);
  const payload = {
    readSucceeded: Boolean(result.readSucceeded),
    writeSucceeded: verified,
    statusCode: result.error?.statusCode || (verified ? 200 : null),
    airtableCode: result.error?.code || null,
    message: result.error?.message || (verified
      ? 'Airtable read, write, and read-after-write succeeded.'
      : 'Airtable health check did not complete.'),
  };

  if (verified) console.log('GhostOS Airtable write health check', JSON.stringify(payload));
  else console.error('GhostOS Airtable write health check failed', JSON.stringify(payload));

  return Response.json(payload, {
    status: verified ? 200 : 500,
    headers: { 'cache-control': 'no-store' },
  });
};

export const config = {
  schedule: '* * * * *',
  path: '/api/airtable-write-health',
};
