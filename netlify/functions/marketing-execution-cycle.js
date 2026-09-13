function secret(){return globalThis.Netlify?.env?.get?.('GHOSTOS_WEBHOOK_SECRET')||process.env.GHOSTOS_WEBHOOK_SECRET}
export default async(req)=>{
  const configured=secret();if(!configured)throw new Error('GhostOS is not configured');
  const origin=new URL(req.url).origin;
  const response=await fetch(`${origin}/.netlify/functions/marketing-execution-background`,{method:'POST',headers:{'x-ghostos-secret':configured}});
  if(!response.ok&&response.status!==202)throw new Error(`Marketing execution background dispatch failed: HTTP ${response.status}`);
};
export const config={schedule:'*/5 * * * *'};
