import { z } from 'zod';
import { applyOwnerJobAction } from '../../src/operations.js';

const schema=z.object({
  jobId:z.string().min(1),
  action:z.enum(['picked_up','started_repair','finished_repair','collected_payment','customer_picked_up','add_note']),
  note:z.string().max(10000).optional().default(''),
  amount:z.number().positive().optional(),
  paymentMethod:z.enum(['Jim','Cash']).optional(),
});
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});

export default async(req)=>{
  if(req.method!=='POST')return json({ok:false,error:'Method not allowed'},405);
  const secret=process.env.GHOSTOS_WEBHOOK_SECRET;
  if(!secret)return json({ok:false,error:'GhostOS is not configured'},503);
  if(req.headers.get('x-ghostos-secret')!==secret)return json({ok:false,error:'Unauthorized'},401);
  try{
    const body=schema.parse(await req.json());
    if(body.action==='collected_payment'&&(body.amount===undefined||!body.paymentMethod))return json({ok:false,error:'Collected Payment requires amount and paymentMethod (Jim or Cash)'},400);
    const result=await applyOwnerJobAction(body);
    return json({ok:true,...result});
  }catch(error){
    if(error instanceof z.ZodError)return json({ok:false,error:'Invalid owner action',details:error.issues},400);
    console.error('GhostOS owner job action failed',error?.message||error);
    return json({ok:false,error:error?.message||'Owner job action failed'},409);
  }
};
