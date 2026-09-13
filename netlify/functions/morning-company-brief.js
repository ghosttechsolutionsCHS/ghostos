import { generateDailyOperationsCycle } from '../../src/ghostos.js';

export default async()=>{
  try{return Response.json({ok:true,...(await generateDailyOperationsCycle('Morning Brief'))},{headers:{'cache-control':'no-store'}});}
  catch(error){console.error('Morning Company Brief failed',error?.message||error);return Response.json({ok:false,error:error?.message||'Morning brief failed'},{status:500,headers:{'cache-control':'no-store'}});}
};

// Netlify schedules are UTC; 13:00 UTC keeps this in the early-morning Eastern operating window year-round.
export const config={schedule:'0 13 * * *'};
