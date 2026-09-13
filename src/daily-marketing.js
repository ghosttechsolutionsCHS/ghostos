import { runAgent } from './ai-provider.js';
import { TABLES, listRecords, updateRecord, logActivity } from './airtable.js';
import { echo, scout, beacon, forge, horizon } from './growth.js';
import { getMondayMarketingSnapshot } from './monday-marketing.js';

const TZ='America/New_York';
const DAILY_AD_AUTH=Object.freeze({dailyMax:10,firstSevenDaysMax:70,radiusMiles:25,market:'Charleston / North Charleston, SC',metaBudgetAuthorized:false});
function localDate(d=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function clean(v,max=30000){return String(v||'').slice(0,max)}
function selectName(v){return typeof v==='string'?v:v?.name||''}
function isMarketingItem(row){const f=row.fields||{};return Boolean(f.Platform||f['Content Type']||f.Fingerprint)}
function forDate(row,date){return String(row.fields?.['Planned Date']||'').slice(0,10)===date}
function pending(row){return selectName(row.fields?.['Owner Decision'])==='Pending'||(!row.fields?.['Owner Decision']&&['Needs Owner','Ready for Owner'].includes(selectName(row.fields?.Status)))}

export async function getMarketingApprovalInbox({date=localDate()}={}){
  const [work,snapshot]=await Promise.all([listRecords(TABLES.GROWTH_WORK,{maxRecords:300}),getMondayMarketingSnapshot()]);
  const items=work.filter(isMarketingItem).filter(r=>forDate(r,date)||pending(r)).sort((a,b)=>new Date(b.fields?.['Updated At']||b.fields?.['Created At']||0)-new Date(a.fields?.['Updated At']||a.fields?.['Created At']||0));
  return {date,greeting:'Good morning. Here is what your company prepared today.',items,summary:{pending:items.filter(pending).length,newLeads:snapshot.metrics.newLeads,bookedJobs:snapshot.metrics.bookedJobs,completedJobs:snapshot.metrics.completedJobs,grossProfit:snapshot.metrics.grossProfit},advertising:{googleAds:{authorization:DAILY_AD_AUTH,performance:snapshot.paidAcquisition.performance,executionConnectionAvailable:false,status:'Authorized within owner ceiling — Google Ads write connection required before launch'},meta:{status:'Strategy only — paid Meta Ads connection/budget not authorized'}},beacon:snapshot.beacon,horizon:snapshot.horizon,windsor:snapshot.windsor,boundaries:{organicAutoPublish:false,customerAutoSend:false,automaticPurchases:false,googleAdsDailyMax:10,googleAdsFirstSevenDaysMax:70,metaSpendAuthorized:false}};
}

export async function decideMarketingItem({id,decision,edit=''}){
  if(!id||!['Approved','Rejected'].includes(decision))throw new Error('id and Approved/Rejected decision are required');
  const rows=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300});const row=rows.find(r=>r.id===id);if(!row||!isMarketingItem(row))throw new Error('Marketing approval item not found');
  const f=row.fields||{};const now=new Date().toISOString();const isPublishable=['Instagram','Facebook','Instagram + Facebook'].includes(String(f.Platform||''));
  const fields={'Owner Decision':decision,'Updated At':now,Status:decision==='Approved'?'Ready for Owner':'Rejected','Publishing Status':decision==='Rejected'?'Rejected':isPublishable?'Approved — Publishing Connection Required':undefined};
  if(edit)fields['Owner Edit']=clean(edit);
  await updateRecord(TABLES.GROWTH_WORK,id,fields);
  await logActivity({agent:'ATLAS',actionType:'marketing_owner_decision',status:decision==='Approved'?'Done':'Blocked',detail:`${decision}: ${f['Growth Item']||id}. ${isPublishable&&decision==='Approved'?'Publishing connection is still required; nothing was posted.':''}`,consequential:true});
  return {id,decision,published:false,publishingStatus:fields['Publishing Status']||null};
}

async function runSpecialist(agent,prompt,maxTurns=12){
  const result=await runAgent(agent,prompt,{maxTurns,observerAgent:agent.name});return clean(result.finalOutput||'',12000);
}

export async function runDailyMarketingCycle({now=new Date()}={}){
  const date=localDate(now);const existing=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300});
  const already=existing.filter(r=>forDate(r,date)&&isMarketingItem(r));
  if(already.length>=3)return {date,skipped:true,reason:'daily_marketing_already_prepared',items:already.length};
  await logActivity({agent:'ATLAS',actionType:'daily_marketing_cycle_started',status:'Running',detail:`Preparing owner-review marketing work for ${date}. No publishing, customer sending, purchasing, or unauthorized spend.`});
  const context=await getMondayMarketingSnapshot({now});
  const shared=`Today is ${date} in Charleston. Use only verified GhostOS/Windsor/public-web evidence. Never fabricate metrics, customers, jobs, reviews, repair results, rankings, group rules, ad results or attribution. Owner approval is required before organic/group publishing. Save each approval item to Growth Work with Owner Decision Pending, Planned Date ${date}, a deterministic Fingerprint, and Publishing Status Draft — Owner Review when applicable.`;
  const results=[];
  results.push(await runSpecialist(echo,`${shared}\nPrepare TODAY'S organic package for BOTH Instagram and Facebook: at least one feed post and one Story. Rotate away from repetitive ads using the recent organic performance and actual business context. Each saved item must include platform, content type, creative brief (or a verified real asset reference only if it truly exists), caption/draft, CTA, rotating relevant hashtags, recommended posting time, purpose. For non-customer creative, label it as an AI/graphic concept, never a real completed repair. Do not publish.`));
  results.push(await runSpecialist(scout,`${shared}\nResearch Charleston, North Charleston, West Ashley, Mount Pleasant, Summerville, Goose Creek and nearby Facebook/community opportunities. For each worthwhile Facebook group, verify available rules from public evidence before recommending a post. Save only strong opportunities and include group name/area, audience relevance, rule summary, proposed post, timing, group/evidence URL, and Posting Confidence. If rules are unavailable or unclear, confidence must be Low or Medium and do not imply posting is allowed. Never pose as a customer, spam, or post.`));
  results.push(await runSpecialist(beacon,`${shared}\nUse connected GA4, Search Console, Google Business Profile and Microsoft Clarity evidence. Turn actual friction/query/local data into plain-English prioritized website/SEO actions. Clarity is request-limited: use the daily snapshot already supplied by get_growth_data and do not wastefully poll. If Search Console has no rows, say unavailable and do not invent rankings. Queue BUILDER only for a specific evidence-backed technical change, preserving BUILDER controls. Save consequential customer-facing website recommendations for review.`));
  results.push(await runSpecialist(forge,`${shared}\nOwner authorization is $10/day maximum and $70 total maximum for the first 7 days, about 25 miles around Charleston/North Charleston. Google Ads is a top priority, but the current GhostOS connection is read-only. Research/recommend only genuinely policy-eligible truthful services, with special attention to B2B Business IT, POS setup, business networking/Wi-Fi and device deployment. Never disguise prohibited consumer technical-support/repair services or circumvent policy. Do not claim launch: mark execution as Publishing/Ads Connection Required. No Meta spend is authorized.`));
  results.push(await runSpecialist(horizon,`${shared}\nCompare channel attention using actual lead -> booked job -> completed job -> revenue -> parts cost -> gross profit -> spend economics. Do not call engagement success when it has no customer/profit evidence. Identify what deserves ATLAS attention today; missing attribution stays missing.`));
  await logActivity({agent:'ATLAS',actionType:'daily_marketing_cycle_completed',status:'Done',detail:`Daily marketing preparation completed for ${date}. Specialists prepared drafts/research only; no external publish/send/purchase/ad write occurred.`});
  return {date,skipped:false,specialists:['ECHO','SCOUT','BEACON','FORGE','HORIZON'],externalActionsTaken:false,results};
}

export {DAILY_AD_AUTH,localDate};