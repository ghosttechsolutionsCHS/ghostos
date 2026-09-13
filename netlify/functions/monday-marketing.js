import { getMondayMarketingSnapshot } from '../../src/monday-marketing.js';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});

export default async(req)=>{
  if(req.method!=='GET')return json({ok:false,error:'Method not allowed'},405);
  const configured=process.env.GHOSTOS_WEBHOOK_SECRET;
  if(!configured)return json({ok:false,error:'GhostOS is not configured'},503);
  if(req.headers.get('x-ghostos-secret')!==configured)return json({ok:false,error:'Unauthorized'},401);
  try{return json({ok:true,data:await getMondayMarketingSnapshot()});}
  catch(error){console.error('Monday marketing snapshot failed',error?.message||error);return json({ok:false,error:error?.message||'Monday marketing failed'},500);}
};

export const config={path:'/api/monday-marketing'};
