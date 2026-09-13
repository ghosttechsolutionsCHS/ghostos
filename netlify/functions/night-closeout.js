import { generateDailyOperationsCycle } from '../../src/ghostos.js';

export default async () => {
  try {
    const result = await generateDailyOperationsCycle('Night Closeout');
    return Response.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('Night Closeout failed', error?.message || error);
    return Response.json({ ok: false, error: error?.message || 'Night closeout failed' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
};

export const config = { schedule: '0 2 * * *' };
