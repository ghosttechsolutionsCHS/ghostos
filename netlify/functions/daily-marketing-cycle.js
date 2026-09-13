import { runDailyMarketingCycle } from '../../src/daily-marketing.js';

export default async()=>{
  try{await runDailyMarketingCycle();}
  catch(error){console.error('Daily marketing cycle failed',error?.message||error);throw error;}
};

// 11:15 UTC = 7:15am EDT / 6:15am EST: prepared before the owner's workday.
export const config={schedule:'15 11 * * *'};
