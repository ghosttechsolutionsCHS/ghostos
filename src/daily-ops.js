import { TABLES, createRecord, getDashboardSnapshot, listRecords, logActivity } from './airtable.js';
import { buildAttentionQueue, todayLocalISO } from './operations.js';
import { ownerTiersForJob } from './owner-tier-projection.js';

const TZ = 'America/New_York';
function n(v){const x=Number(v);return Number.isFinite(x)?x:0;}
function day(v){if(!v)return null;const d=new Date(v);if(Number.isNaN(d.getTime()))return null;return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function today(v){return day(v)===todayLocalISO();}
function latestToday(records,cycle,date){return records.filter(r=>r.fields.Cycle===cycle&&r.fields.Date===date).sort((a,b)=>new Date(b.fields['Generated At']||0)-new Date(a.fields['Generated At']||0))[0]||null;}

function withOwnerTiers(base){
  const byJob=new Map((base.jobs||[]).map((job)=>[job.id,job]));
  const partsQuotes=(base.partsQuotes||[]).map((row)=>{
    const job=byJob.get(row.jobId);if(!job)return row;
    const tiers=ownerTiersForJob(job,base.parts||[]);
    const recommended=tiers.find((p)=>p.recommended)||tiers.find((p)=>p.tier==='Medium')||tiers[0]||null;
    const ready=recommended?.economics?.ready?recommended.economics:null;
    const blockers=[...(row.pricingCard?.blockers||[]),...tiers.filter((p)=>!p.economics?.ready).map((p)=>`${p.tier}: ${p.economics?.reason||'verified economics incomplete'}`)];
    const pricingCard=row.quote?.total!=null?row.pricingCard:(ready?{...ready,ready:true,label:'Recommended Quote',blockers:[],derivedFromTier:recommended.tier}:{...row.pricingCard,ready:false,label:'QUOTE NOT READY',blockers:[...new Set(blockers)]});
    return {...row,parts:tiers,recommendedPart:recommended,pricingCard,quoteWithheldReason:pricingCard.ready?'':pricingCard.blockers.join(' ')};
  });
  return {...base,partsQuotes};
}

export async function getOperationsSnapshot(){
  const [rawBase,dailyOps]=await Promise.all([getDashboardSnapshot(),listRecords(TABLES.DAILY_OPS,{maxRecords:90})]);
  const base=withOwnerTiers(rawBase);
  const attentionQueue=buildAttentionQueue({
    jobs:base.jobs,parts:base.parts,quotes:base.quotes,approvals:base.approvals,messages:base.messages,builderRequests:base.builderRequests,
    growthWork:base.growthDivision?.work||[],growthOpportunities:base.growthDivision?.opportunities||[],marketing:base.growthDivision?.marketing||[],
  });
  const date=todayLocalISO();
  const todayJobs=base.jobs.filter(r=>today(r.createdTime));
  const completedToday=base.jobs.filter(r=>today(r.fields['Customer Picked Up At']) || (r.fields.Status==='Completed'&&today(r.fields['Repair Finished At'])));
  const quotesToday=base.quotes.filter(r=>today(r.fields['Created At']||r.createdTime));
  const cashToday=base.cash.filter(r=>r.fields.Date===date);
  const customerPaymentsToday=cashToday.filter(r=>r.fields.Type==='Customer Payment');
  const growthToday=(base.growthDivision?.work||[]).filter(r=>today(r.fields['Updated At']||r.fields['Created At']||r.createdTime));
  const waitingCustomers=base.jobs.filter(r=>['Quoted','Awaiting Customer'].includes(r.fields.Status));
  const jobsNeedingAction=attentionQueue.filter(i=>['Job','RELAY Messages','Parts','Quotes'].includes(i.source));
  const quoteFollowups=attentionQueue.filter(i=>i.source==='Quotes'||(i.agent==='RELAY'&&i.jobId&&waitingCustomers.some(j=>j.id===i.jobId)));
  const partBlockers=attentionQueue.filter(i=>i.source==='Parts'||i.agent==='SUPPLY');
  const appointmentsToday=base.jobs.filter(r=>today(r.fields.Appointment));
  const builderAttention=attentionQueue.filter(i=>i.agent==='BUILDER');
  const ownerDecisions=attentionQueue.filter(i=>i.source==='Owner Inbox');
  const cashIn=cashToday.reduce((s,r)=>s+n(r.fields['Money In']),0),cashOut=cashToday.reduce((s,r)=>s+n(r.fields['Money Out']),0);
  const revenueCollected=customerPaymentsToday.reduce((s,r)=>s+n(r.fields['Money In']),0);
  const completedRevenue=completedToday.reduce((s,r)=>s+n(r.fields['Revenue Collected']),0),completedGrossProfit=completedToday.reduce((s,r)=>s+n(r.fields['Gross Profit']),0);
  const daily={date,newLeads:todayJobs.length,jobsNeedingAction:jobsNeedingAction.length,waitingCustomers:waitingCustomers.length,quoteFollowups:quoteFollowups.length,partBlockers:partBlockers.length,appointmentsToday:appointmentsToday.length,quotesPrepared:quotesToday.length,jobsCompleted:completedToday.length,revenueCollected,grossProfitCompleted:completedGrossProfit,completedRevenue,cashIn,cashOut,netCash:cashIn-cashOut,growthActivity:growthToday.length,builderAttention:builderAttention.length,ownerDecisions:ownerDecisions.length};
  return {...base,attentionQueue,dailyOperations:{date,metrics:daily,morningBrief:latestToday(dailyOps,'Morning Brief',date),nightCloseout:latestToday(dailyOps,'Night Closeout',date),records:dailyOps.slice(0,30)}};
}

export function compactDailyContext(snapshot,cycle){
  const q=snapshot.attentionQueue.slice(0,18).map(i=>({priority:i.priority,agent:i.agent,subject:i.subject,action:i.action,why:i.why,due:i.due,ownerRequired:i.ownerRequired,source:i.source}));
  const jobs=snapshot.jobs.filter(j=>['New Lead','Need Quote','Quoted','Awaiting Customer','Part Approval','Part Ordered','Scheduled','In Progress'].includes(j.fields.Status)).slice(0,30).map(j=>({id:j.id,name:j.fields['Job / Customer'],status:j.fields.Status,repairStage:j.fields['Repair Stage'],appointment:j.fields.Appointment,followUpDue:j.fields['Follow-Up Due'],quotedPrice:j.fields['Quoted Price'],revenue:j.fields['Revenue Collected'],partsCost:j.fields['Parts Cost'],next:j.fields['RELAY Next Action']}));
  return {cycle,date:snapshot.dailyOperations.date,metrics:snapshot.dailyOperations.metrics,attentionQueue:q,jobs,marketing:snapshot.growthDivision?.totals||{},growthWork:(snapshot.growthDivision?.work||[]).slice(0,12).map(r=>({agent:r.fields.Agent,type:r.fields['Work Type'],status:r.fields.Status,result:r.fields['Latest Result'],next:r.fields['Next Action']})),builder:snapshot.builderRequests.slice(0,12).map(r=>({request:r.fields.Request,status:r.fields.Status,buildStatus:r.fields['Build Status'],ci:r.fields['CI Status'],ownerDecision:r.fields['Owner Decision'],failure:r.fields['Failure Reason']})),ownerInbox:snapshot.approvals.slice(0,12).map(r=>({type:r.fields.Type,summary:r.fields.Summary,action:r.fields['Requested Action'],requestedBy:r.fields['Requested By']}))};
}

export async function storeDailyCycle(cycle,brief,status='Ready'){
  if(!['Morning Brief','Night Closeout'].includes(cycle))throw new Error('Unsupported daily operations cycle');
  const now=new Date().toISOString(),date=todayLocalISO();
  const record=await createRecord(TABLES.DAILY_OPS,{'Daily Ops':`${date} — ${cycle}`,Date:date,Cycle:cycle,Brief:String(brief||'').slice(0,90000),'Generated At':now,'ATLAS Status':status});
  await logActivity({agent:'ATLAS',actionType:cycle==='Morning Brief'?'morning_company_brief':'night_closeout',status:status==='Ready'?'Done':'Error',detail:String(brief||'').slice(0,10000)});
  return record;
}
