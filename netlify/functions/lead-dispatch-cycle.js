import { runLeadDispatchCycle } from '../../src/lead-dispatch.js';

export default async () => {
  try {
    const result = await runLeadDispatchCycle({ maxLeads: 5 });
    return Response.json({ ok:true, ...result }, { headers:{ 'cache-control':'no-store' } });
  } catch (error) {
    console.error('GhostOS lead dispatch cycle failed', error?.message || error);
    return Response.json({ ok:false, error:error?.message || 'Lead dispatch cycle failed' }, { status:500, headers:{ 'cache-control':'no-store' } });
  }
};

export const config = { schedule: '*/2 * * * *' };
