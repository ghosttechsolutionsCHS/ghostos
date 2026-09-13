import { z } from 'zod';
import { runAgent, defineTool } from './ai-provider.js';
import { TABLES, createRecord, listRecords, updateRecord, logActivity } from './airtable.js';
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

const saveMarketingCardTool=defineTool({
  name:'save_marketing_approval_card',
  description:'Persist one structured owner-review marketing card. This NEVER publishes, sends, purchases, changes an ad account, or spends money. Use a deterministic fingerprint so retries do not duplicate work.',
  parameters:z.object({
    agent:z.enum(['ECHO','SCOUT','BEACON','FORGE','HORIZON']),title:z.string().min(3).max(250),workType:z.enum(['Content Draft','Free Acquisition','SEO / Website','Marketing Analysis','Executive Input']),platform:z.string().min(2).max(100),contentType:z.string().min(2).max(100),plannedDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),fingerprint:z.string().min(6).max(250),
    purpose:z.string().min(3).max(10000),draftContent:z.string().max(30000).optional(),creativeBrief:z.string().max(30000).optional(),creativeAssetUrl:z.string().url().optional(),cta:z.string().max(1000).optional(),hashtags:z.string().max(5000).optional(),recommendedPostingTime:z.string().max(200).optional(),evidence:z.string().max(30000).optional(),evidenceUrl:z.string().url().optional(),groupRules:z.string().max(30000).optional(),postingConfidence:z.enum(['High — Rules Support Posting','Medium — Some Rules Unclear','Low — Do Not Post Yet']).optional(),moneyInvolved:z.number().nonnegative().optional(),nextAction:z.string().max(10000).optional(),ownerApprovalRequired:z.boolean().default(true),
  }),
  async execute(a){
    const existing=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300});const prior=existing.find(r=>String(r.fields?.Fingerprint||'')===a.fingerprint);if(prior)return {id:prior.id,deduped:true,externalActionTaken:false};
    const now=new Date().toISOString();const social=['Instagram','Facebook','Instagram + Facebook'].includes(a.platform);
    const rec=await createRecord(TABLES.GROWTH_WORK,{'Growth Item':a.title,Agent:a.agent,'Work Type':a.workType,Status:a.ownerApprovalRequired?'Needs Owner':'Ready for Owner','Current Task':`Prepared for ${a.plannedDate}`,'Latest Result':a.purpose,'Next Action':a.nextAction||'Owner: Approve, Edit, or Reject.','Evidence / Context':a.evidence||'','Draft Content':a.draftContent||'','Channel / Partner':a.platform,'URL / Contact':a.evidenceUrl,Platform:a.platform,'Content Type':a.contentType,'Creative Brief':a.creativeBrief||'','Creative Asset URL':a.creativeAssetUrl,CTA:a.cta||'',Hashtags:a.hashtags||'','Recommended Posting Time':a.recommendedPostingTime||'',Purpose:a.purpose,'Money Involved':a.moneyInvolved,'Publishing Status':social?'Draft — Owner Review':undefined,'Owner Decision':'Pending','Group Rules':a.groupRules||'','Posting Confidence':a.postingConfidence,'Planned Date':a.plannedDate,Fingerprint:a.fingerprint,'Evidence URL':a.evidenceUrl,'Owner Approval Required':a.ownerApprovalRequired,'Created At':now,'Updated At':now});
    await logActivity({agent:a.agent,actionType:'marketing_card_prepared',status:a.ownerApprovalRequired?'Blocked':'Done',detail:`${a.contentType}: ${a.title}. Owner review required=${a.ownerApprovalRequired}. No external action taken.`,consequential:a.ownerApprovalRequired});return {id:rec.id,deduped:false,externalActionTaken:false};
  }
});
function specialist(agent){return {...agent,tools:[...(agent.tools||[]),saveMarketingCardTool]}}

export async function getMarketingApprovalInbox({date=localDate()}={}){
  const [work,snapshot]=await Promise.all([listRecords(TABLES.GROWTH_WORK,{maxRecords:300}),getMondayMarketingSnapshot()]);
  const items=work.filter(isMarketingItem).filter(r=>forDate(r,date)||pending(r)).sort((a,b)=>new Date(b.fields?.['Updated At']||b.fields?.['Created At']||0)-new Date(a.fields?.['Updated At']||a.fields?.['Created At']||0));
  return {date,greeting:'Good morning. Here is what your company prepared today.',items,summary:{pending:items.filter(pending).length,newLeads:snapshot.metrics.newLeads,bookedJobs:snapshot.metrics.bookedJobs,completedJobs:snapshot.metrics.completedJobs,grossProfit:snapshot.metrics.grossProfit},advertising:{googleAds:{authorization:DAILY_AD_AUTH,performance:snapshot.paidAcquisition.performance,executionConnectionAvailable:false,status:'Authorized within owner ceiling — Google Ads write connection required before launch'},meta:{status:'Strategy only — paid Meta Ads connection/budget not authorized'}},beacon:snapshot.beacon,horizon:snapshot.horizon,windsor:snapshot.windsor,boundaries:{organicAutoPublish:false,customerAutoSend:false,automaticPurchases:false,googleAdsDailyMax:10,googleAdsFirstSevenDaysMax:70,metaSpendAuthorized:false}};
}

export async function decideMarketingItem({id,decision,edit=''}){
  if(!id||!['Approved','Rejected'].includes(decision))throw new Error('id and Approved/Rejected decision are required');
  const rows=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300});const row=rows.find(r=>r.id===id);if(!row||!isMarketingItem(row))throw new Error('Marketing approval item not found');
  const f=row.fields||{};if(selectName(f['Owner Decision'])!=='Pending')throw new Error(`Marketing item is already ${selectName(f['Owner Decision'])||'resolved'}`);
  const now=new Date().toISOString();const isPublishable=['Instagram','Facebook','Instagram + Facebook'].includes(String(f.Platform||''));
  const fields={'Owner Decision':decision,'Updated At':now,Status:decision==='Approved'?'Ready for Owner':'Rejected','Publishing Status':decision==='Rejected'?'Rejected':isPublishable?'Approved — Publishing Connection Required':undefined};if(edit)fields['Owner Edit']=clean(edit);
  await updateRecord(TABLES.GROWTH_WORK,id,fields);await logActivity({agent:'ATLAS',actionType:'marketing_owner_decision',status:decision==='Approved'?'Done':'Blocked',detail:`${decision}: ${f['Growth Item']||id}. ${isPublishable&&decision==='Approved'?'Publishing connection is still required; nothing was posted.':''}`,consequential:true});
  return {id,decision,published:false,publishingStatus:fields['Publishing Status']||null};
}

async function runSpecialist(agent,prompt,maxTurns=12){const a=specialist(agent);const result=await runAgent(a,prompt,{maxTurns,observerAgent:a.name});return clean(result.finalOutput||'',12000)}

export async function runDailyMarketingCycle({now=new Date()}={}){
  const date=localDate(now);const existing=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300});const already=existing.filter(r=>forDate(r,date)&&isMarketingItem(r));if(already.length>=3)return {date,skipped:true,reason:'daily_marketing_already_prepared',items:already.length};
  await logActivity({agent:'ATLAS',actionType:'daily_marketing_cycle_started',status:'Running',detail:`Preparing owner-review marketing work for ${date}. No publishing, customer sending, purchasing, or unauthorized spend.`});
  const shared=`Today is ${date} in Charleston. Use get_growth_data first. Use only verified GhostOS/Windsor/public-web evidence. Never fabricate metrics, customers, jobs, reviews, repair results, rankings, group rules, ad results or attribution. Save each worthwhile owner item with save_marketing_approval_card. Owner approval is required before organic/group publishing. Planned Date must be ${date}; use a stable fingerprint like ${date}:AGENT:platform:type:topic. Nothing you save is published.`;const results=[];
  results.push(await runSpecialist(echo,`${shared}\nPrepare TODAY'S organic package for BOTH Instagram and Facebook: at least one feed post and one Story. Rotate topics among phone repair, cracked screens, computers/laptops, PC builds, Wi-Fi/networking, Business IT/POS, mobile service, educational tips, common problems, Charleston-local trust/convenience and CTAs. Each card needs creative brief, caption, CTA, varied relevant hashtags, target platform, recommended time and purpose. A non-customer creative must be labeled AI/graphic concept; never present it as a real customer/result. Do not publish.`));
  results.push(await runSpecialist(scout,`${shared}\nResearch Charleston, North Charleston, West Ashley, Mount Pleasant, Summerville, Goose Creek and nearby Facebook/community opportunities. Before recommending a Facebook group, verify available rules from live public evidence. Save group name/area, relevance, rule summary, proposed post, timing, group/evidence URL and Posting Confidence. If rules are unavailable/unclear, confidence must be Low or Medium and never imply posting is allowed. Never pose as a customer, spam, or post.`));
  results.push(await runSpecialist(beacon,`${shared}\nUse connected GA4, Search Console, Google Business Profile and Microsoft Clarity evidence. Turn actual friction/query/local data into plain-English prioritized actions. Clarity is request-limited: use get_growth_data's existing snapshot once and do not repeatedly poll it. If Search Console has no rows, say unavailable. Queue BUILDER only for a specific evidence-backed technical change, preserving BUILDER controls. Save customer-facing website/SEO recommendations for review.`));
  results.push(await runSpecialist(forge,`${shared}\nOwner authorization: Google Ads max $10/day and $70 total in first 7 days, ~25 miles Charleston/North Charleston. Current GhostOS Google Ads connection is read-only, so prepare policy-eligible acquisition decisions but DO NOT claim launch or modify an ad account. Prioritize genuinely eligible B2B Business IT, POS setup, business networking/Wi-Fi and device deployment. Never disguise prohibited consumer repair/technical-support services or circumvent policy. Save an Ad Decision card with money involved <=10/day and explicitly say Ads Connection Required. No Meta budget is authorized.`));
  results.push(await runSpecialist(horizon,`${shared}\nCompare channels using actual spend -> lead -> booked job -> completed job -> revenue -> parts cost -> gross profit -> CAC/cash evidence. Engagement without customers is not success. Save only a decision that genuinely deserves owner attention; missing attribution stays missing.`));
  await logActivity({agent:'ATLAS',actionType:'daily_marketing_cycle_completed',status:'Done',detail:`Daily marketing preparation completed for ${date}. Specialists prepared drafts/research only; no external publish/send/purchase/ad write occurred.`});return {date,skipped:false,specialists:['ECHO','SCOUT','BEACON','FORGE','HORIZON'],externalActionsTaken:false,results};
}

export {DAILY_AD_AUTH,localDate};