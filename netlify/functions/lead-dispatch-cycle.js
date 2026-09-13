import { runLeadDispatchCycle } from '../../src/lead-dispatch.js';

function safeError(error) {
  return {
    code: error?.error || error?.code || error?.statusCode || error?.status || error?.name || 'UNKNOWN_ERROR',
    message: String(error?.message || error || 'Lead dispatch cycle failed').slice(0, 4000),
    statusCode: error?.statusCode || error?.status || null,
  };
}

export default async () => {
  try {
    const result = await runLeadDispatchCycle({ maxLeads: 5 });
    const payload = { ok:true, ...result };
    console.log('GhostOS lead dispatch cycle completed', JSON.stringify(payload));
    return Response.json(payload, { headers:{ 'cache-control':'no-store' } });
  } catch (error) {
    const airtableError = safeError(error);
    const payload = { ok:false, error:airtableError };
    console.error('GhostOS lead dispatch cycle failed', JSON.stringify(payload));
    return Response.json(payload, { status:500, headers:{ 'cache-control':'no-store' } });
  }
};

export const config = { schedule: '*/2 * * * *' };
