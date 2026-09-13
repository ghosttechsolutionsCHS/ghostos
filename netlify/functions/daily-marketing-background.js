import { runDailyMarketingCycle } from '../../src/daily-marketing.js';
function secret(){return globalThis.Netlify?.env?.get?.('GHOSTOS_WEBHOOK_SECRET')||process.env.GHOSTOS_WEBHOOK_SECRET}
export default async(req)=>{
  const configured=secret();if(!configured||req.headers.get('x-ghostos-secret')!==configured){console.error('Daily marketing background unauthorized');return;}
  try{await runDailyMarketingCycle();}catch(error){console.error('Daily marketing background failed',error?.message||error);throw error;}
};
