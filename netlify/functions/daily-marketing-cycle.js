function secret(){return globalThis.Netlify?.env?.get?.('GHOSTOS_WEBHOOK_SECRET')||process.env.GHOSTOS_WEBHOOK_SECRET}
export default async(req)=>{
  const configured=secret();if(!configured)throw new Error('GhostOS is not configured');
  const origin=new URL(req.url).origin;
  const response=await fetch(`${origin}/.netlify/functions/daily-marketing-background`,{method:'POST',headers:{'x-ghostos-secret':configured}});
  if(!response.ok&&response.status!==202)throw new Error(`Daily marketing background dispatch failed: HTTP ${response.status}`);
};
// 11:15 UTC = 7:15am EDT / 6:15am EST: preparation starts before the owner's workday.
export const config={schedule:'15 11 * * *'};
