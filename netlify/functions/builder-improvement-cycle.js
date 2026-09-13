import { runImprovementCycle } from '../../src/improvements.js';

export default async () => {
  try {
    const result = await runImprovementCycle({ allowAutonomousProposal: true });
    return Response.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('GhostOS improvement cycle failed', error?.message || error);
    return Response.json({ ok: false, error: error?.message || 'Improvement cycle failed' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
};

export const config = { schedule: '17 13 * * *' };
