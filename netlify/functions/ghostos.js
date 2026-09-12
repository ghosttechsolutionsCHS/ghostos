import { processLead } from '../../src/ghostos.js';

export default async (req) => {
  if(req.method !== 'POST') return new Response('Method not allowed',{status:405});
  const secret=req.headers.get('x-ghostos-secret');
  if(process.env.GHOSTOS_WEBHOOK_SECRET && secret!==process.env.GHOSTOS_WEBHOOK_SECRET) return new Response('Unauthorized',{status:401});
  try{
    const body=await req.json();
    const recordId=body.recordId || body.record_id || null;
    const lead=body.lead || body;
    const output=await processLead(recordId,lead);
    return Response.json({ok:true,output});
  }catch(e){
    console.error(e);
    return Response.json({ok:false,error:e?.message || 'GhostOS error'},{status:500});
  }
};
