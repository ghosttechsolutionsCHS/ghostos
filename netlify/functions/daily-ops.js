import { getOperationsSnapshot } from '../../src/daily-ops.js';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async(req)=>{
  if(req.method!=='GET')return json({ok:false,error:'Method not allowed'},405);
  const configured=process.env.GHOSTOS_WEBHOOK_SECRET;
  if(!configured)return json({ok:false,error:'GhostOS is not configured'},503);
  if(req.headers.get('x-ghostos-secret')!==configured)return json({ok:false,error:'Unauthorized'},401);
  try{return json({ok:true,data:await getOperationsSnapshot()});}
  catch(error){console.error('Daily Operations snapshot failed',error?.message||error);return json({ok:false,error:error?.message||'Daily Operations failed'},500);}
};
