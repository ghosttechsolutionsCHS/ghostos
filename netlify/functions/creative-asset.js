import { TABLES,getRecord } from '../../src/airtable.js';
import { creativeFrameCount,renderCreativeJpeg } from '../../src/creative-provider.js';

export default async(req)=>{
  try{
    if(req.method!=='GET')return new Response('Method not allowed',{status:405});
    const u=new URL(req.url),id=u.searchParams.get('id')||'',frame=Number(u.searchParams.get('frame')||1);
    if(!/^rec[A-Za-z0-9]{14}$/.test(id))return new Response('Invalid creative id',{status:400});
    const row=await getRecord(TABLES.GROWTH_WORK,id),f=row.fields||{};
    if(f.Agent!=='ECHO'||!['Instagram','Facebook','Instagram + Facebook'].includes(String(f.Platform||'')))return new Response('Creative not available',{status:404});
    const count=creativeFrameCount(f);if(!Number.isInteger(frame)||frame<1||frame>count)return new Response('Frame not available',{status:404});
    const image=await renderCreativeJpeg(f,frame);
    return new Response(image,{status:200,headers:{'content-type':'image/jpeg','cache-control':'public, max-age=300, stale-while-revalidate=3600','x-content-type-options':'nosniff'}});
  }catch(error){console.error('Creative asset render failed',error?.message||error);return new Response('Creative unavailable',{status:500});}
};
export const config={path:'/api/creative-asset'};
