import { getMarketingApprovalInbox, decideMarketingItem } from '../../src/daily-marketing.js';
import { ownerAuthorized } from '../../src/owner-session.js';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
function secret(){return globalThis.Netlify?.env?.get?.('GHOSTOS_WEBHOOK_SECRET')||process.env.GHOSTOS_WEBHOOK_SECRET||''}

export default async(req)=>{
  const configured=secret();
  if(!configured)return json({ok:false,error:'GhostOS is not configured'},503);
  if(!ownerAuthorized(req,configured))return json({ok:false,error:'Unauthorized'},401);
  try{
    if(req.method==='GET')return json({ok:true,data:await getMarketingApprovalInbox()});
    if(req.method==='POST'){
      const body=await req.json();
      return json({ok:true,data:await decideMarketingItem(body)});
    }
    return json({ok:false,error:'Method not allowed'},405);
  }catch(error){
    console.error('Marketing approval error',error?.message||error);
    return json({ok:false,error:error?.message||'Marketing approval failed'},500);
  }
};
export const config={path:'/api/marketing-approval'};
