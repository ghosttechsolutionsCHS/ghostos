import { runMarketingExecutionCycle } from '../../src/marketing-execution.js';
function secret(){return globalThis.Netlify?.env?.get?.('GHOSTOS_WEBHOOK_SECRET')||process.env.GHOSTOS_WEBHOOK_SECRET}
export default async(req)=>{
  const configured=secret();if(!configured)throw new Error('GhostOS is not configured');
  if(req.headers.get('x-ghostos-secret')!==configured)throw new Error('Unauthorized');
  const result=await runMarketingExecutionCycle();
  console.log('Marketing execution cycle',JSON.stringify(result));
};
