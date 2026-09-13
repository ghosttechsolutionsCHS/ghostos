import { z } from 'zod';
import { dispatchLead } from '../../src/lead-dispatch.js';

const schema = z.object({ recordId:z.string().trim().min(1).max(128), force:z.boolean().default(true) });
const json = (body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});

export default async (req) => {
  if (req.method !== 'POST') return json({ok:false,error:'Method not allowed'},405);
  const secret=process.env.GHOSTOS_WEBHOOK_SECRET;
  if (!secret) return json({ok:false,error:'GhostOS is not configured'},503);
  if (req.headers.get('x-ghostos-secret') !== secret) return json({ok:false,error:'Unauthorized'},401);
  try {
    const parsed=schema.parse(await req.json());
    const result=await dispatchLead(parsed.recordId,{force:parsed.force,source:'owner_retry'});
    return json({ok:true,...result});
  } catch (error) {
    if (error instanceof z.ZodError) return json({ok:false,error:'Invalid request payload',details:error.issues},400);
    return json({ok:false,error:error?.message || 'Lead processing failed'},500);
  }
};
