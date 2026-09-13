import { TABLES, listRecords } from './airtable.js';
import { createWindsorMarketingReader, summarizeGoogleAds } from './windsor-marketing.js';

const TZ='America/New_York';
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function day(v){if(!v)return null;const d=new Date(v);if(Number.isNaN(d.getTime()))return null;return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function todayISO(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}
function linkedToday(job,today){return day(job.createdTime)===today}
function sumRows(rows,field){return rows.reduce((s,r)=>s+n(r[field]),0)}

export const MONDAY_PAID_PLAN=Object.freeze({
  name:'Ghost Tech Local Repair — Charleston / North Charleston',
  status:'PREPARED_NOT_LAUNCHED',
  geography:'Approximately 25 miles around North Charleston / Charleston, SC',
  dailyTarget:{min:10,max:15},weeklyHardCeiling:200,
  objective:'Profitable completed repair jobs and cash generated, not clicks or impressions.',
  services:['iPhone / phone screen repair','Computer / laptop repair','Mobile tech repair'],
  keywordThemes:['iphone screen repair near me','phone screen repair charleston','mobile phone repair charleston','computer repair charleston','laptop repair near me','mobile tech repair'],
  negativeThemes:['free','jobs','career','training','course','parts only','wholesale','diy','manual'],
  externalWriteAuthorized:false,
});

export const ORGANIC_CONTENT_QUEUE=Object.freeze([
  {channel:'Instagram + Facebook',type:'Real repair result',title:'Before/after repair proof',draft:'Cracked screen? We come to you — Charleston & surrounding areas. Use a real completed repair photo, state the actual device and verified result, then invite customers to request a quote.',requiresRealAsset:true},
  {channel:'Instagram + Facebook',type:'Convenience',title:'Mobile repair service',draft:'Skip the repair-shop waiting room. Ghost Tech Solutions offers mobile/on-site tech repair across Charleston and surrounding areas. Message us with your device and issue for a quote.',requiresRealAsset:false},
  {channel:'Instagram + Facebook',type:'Trust',title:'What happens after you request a quote',draft:'Send us your device + issue → we verify parts and pricing → you review the quote → we schedule the repair. No surprise part ordering and no automatic charges.',requiresRealAsset:false},
  {channel:'Instagram + Facebook',type:'Service spotlight',title:'Laptop/computer repair',draft:'Laptop running slow, not booting, or giving you trouble? Ghost Tech Solutions provides mobile computer and laptop repair in the Charleston area. Tell us the symptoms and we’ll help determine the next step.',requiresRealAsset:false},
]);

export const FREE_ACQUISITION_QUEUE=Object.freeze([
  {rank:1,channel:'Nextdoor',opportunity:'Publish a compliant local business/service post for Charleston/North Charleston neighborhoods.',why:'High local intent and geographic relevance.',ruleCheckRequired:true,automaticPosting:false},
  {rank:2,channel:'Facebook local groups',opportunity:'Identify Charleston/North Charleston community groups that explicitly allow local service recommendations or business posts; prepare one useful non-spam post per permitted group.',why:'Local repair requests often appear in community recommendation threads.',ruleCheckRequired:true,automaticPosting:false},
  {rank:3,channel:'Facebook Marketplace',opportunity:'Where current Marketplace rules permit service listings, prepare a transparent mobile tech repair listing with real pricing language and service area.',why:'High-intent local browsing; must verify current category/rules before posting.',ruleCheckRequired:true,automaticPosting:false},
  {rank:4,channel:'Referral / local partners',opportunity:'Ask existing local businesses where Ghost Tech has a real relationship to display a QR/business card and refer repair customers; track referred jobs by source.',why:'Free acquisition with strong trust and measurable job economics.',ruleCheckRequired:false,automaticPosting:false},
]);

function attributionBreakdown(jobs){
  const map=new Map();
  for(const j of jobs){const f=j.fields||{};const source=String(f['UTM Campaign']||f['UTM Source']||f['Lead Source']||'Unattributed');const x=map.get(source)||{source,leads:0,bookedJobs:0,completedJobs:0,revenue:0,partsCost:0,grossProfit:0};x.leads++;if(['Scheduled','In Progress','Completed'].includes(f.Status))x.bookedJobs++;if(f.Status==='Completed')x.completedJobs++;x.revenue+=n(f['Revenue Collected']);x.partsCost+=n(f['Parts Cost']);x.grossProfit+=n(f['Gross Profit']);map.set(source,x)}
  return [...map.values()].sort((a,b)=>b.grossProfit-a.grossProfit);
}

function beaconSignals(windsor){
  const fixes=[];const ga=windsor.sources.ga4, sc=windsor.sources.searchConsole, gbp=windsor.sources.businessProfile, clarity=windsor.sources.clarity;
  if(ga?.available){const quoteSubmits=sumRows(ga.rows,'conversions_ads_conversion_request_quote_1');const sessions=sumRows(ga.rows,'sessions');fixes.push({source:'GA4',severity:'info',finding:`${sessions} sessions and ${quoteSubmits} request-quote key events in the selected window.`,action:'Keep quote-submit tracking as a primary funnel KPI and validate lead-to-job attribution in GhostOS.'})}
  if(sc?.configured&&!sc.available)fixes.push({source:'Search Console',severity:'attention',finding:'No Search Console rows returned for the selected window.',action:'Do not claim rankings yet; verify indexing/property data and prioritize service/location pages once query data appears.'});
  if(gbp?.available){const calls=sumRows(gbp.rows,'call_clicks'),web=sumRows(gbp.rows,'website_clicks');fixes.push({source:'Google Business Profile',severity:calls+web===0?'attention':'info',finding:`${calls} call clicks and ${web} website clicks in the selected window.`,action:calls+web===0?'Improve local profile/service completeness and keep attribution ready before scaling paid traffic.':'Track GBP calls/website clicks through to booked and completed jobs.'})}
  if(clarity?.available){const homepage=clarity.rows.filter(r=>String(r.url||'').replace(/\/$/,'')==='https://ghosttechsolution.com');const dead=sumRows(homepage,'dead_click_sessions_count'),rage=sumRows(homepage,'rage_click_sessions_count');const scroll=homepage.filter(r=>r.metric_type==='ScrollDepth').reduce((m,r)=>Math.max(m,n(r.average_scroll_depth)),0);if(dead||rage||scroll<25)fixes.push({source:'Microsoft Clarity',severity:'high',finding:`Homepage shows ${dead} dead-click sessions, ${rage} rage-click sessions, and ${scroll.toFixed(1)}% reported average scroll depth in available Clarity rows.`,action:'Inspect the homepage hero/primary CTA first; remove misleading clickable elements and make the quote action obvious above the fold.'})}
  return fixes;
}

export async function getMondayMarketingSnapshot({env=process.env,fetchImpl=fetch,now=new Date()}={}){
  const [jobs,windsor]=await Promise.all([listRecords(TABLES.JOBS,{maxRecords:500}),createWindsorMarketingReader({env,fetchImpl}).snapshot()]);
  const today=todayISO(now);const newToday=jobs.filter(j=>linkedToday(j,today));
  const bookedToday=newToday.filter(j=>['Scheduled','In Progress','Completed'].includes(j.fields.Status));
  const completedToday=jobs.filter(j=>j.fields.Status==='Completed'&&(day(j.fields['Customer Picked Up At'])===today||day(j.fields['Repair Finished At'])===today));
  const revenue=completedToday.reduce((s,j)=>s+n(j.fields['Revenue Collected']),0),partsCost=completedToday.reduce((s,j)=>s+n(j.fields['Parts Cost']),0),grossProfit=completedToday.reduce((s,j)=>s+n(j.fields['Gross Profit']),0);
  const paid=summarizeGoogleAds(windsor.sources.googleAds);
  const attribution=attributionBreakdown(jobs);
  const ownerAttention=[];
  if(!windsor.configured)ownerAttention.push('Add WINDSOR_API_KEY to the Netlify runtime so GhostOS can read the connected Windsor accounts.');
  ownerAttention.push('Google Ads launch remains owner-controlled. Review the prepared local Search campaign before any spend or account modification.');
  if(!paid.available)ownerAttention.push(`Google Ads performance is not available: ${paid.status}.`);
  const unattributed=jobs.filter(j=>!j.fields['Lead Source']&&!j.fields['UTM Source']&&!j.fields['UTM Campaign']).length;if(unattributed)ownerAttention.push(`${unattributed} job(s) lack lead-source/UTM attribution; profitability by channel will remain incomplete until those sources are captured.`);
  const todayActions=[
    {agent:'FORGE',action:'Review the prepared high-intent local Search campaign, conversion tracking, $10–15/day target and $200/week hard ceiling. No launch without owner authorization.'},
    {agent:'ECHO',action:'Choose real repair assets and prepare the first organic post; do not claim a result that did not happen and do not auto-publish.'},
    {agent:'SCOUT',action:'Work the ranked free-acquisition queue manually, verify each platform/group rule, and log the source on every resulting lead.'},
    {agent:'BEACON',action:'Fix the highest-confidence funnel friction surfaced by GA4/GBP/Clarity before paying to send more traffic.'},
    {agent:'HORIZON',action:'Compare lead source → booked/completed jobs → revenue/parts cost/gross profit and recommend scaling only where completed-job economics support it.'},
  ];
  return {generatedAt:new Date().toISOString(),market:'Charleston / North Charleston, SC',radiusMiles:25,todayActions,paidAcquisition:{plan:MONDAY_PAID_PLAN,performance:paid},organicContentQueue:ORGANIC_CONTENT_QUEUE,freeAcquisitionQueue:FREE_ACQUISITION_QUEUE,beacon:{fixes:beaconSignals(windsor),sources:windsor.sources},horizon:{attribution},metrics:{newLeads:newToday.length,bookedJobs:bookedToday.length,completedJobs:completedToday.length,spend:paid.available?paid.spend:null,revenue,partsCost,grossProfit,cac:paid.available&&completedToday.length>0?paid.spend/completedToday.length:null},ownerAttention,windsor:{configured:windsor.configured,fetchedAt:windsor.fetchedAt,sourceStatus:Object.fromEntries(Object.entries(windsor.sources).map(([k,v])=>[k,{configured:v.configured,available:v.available,error:v.error,rowCount:v.rows.length}]))},boundaries:{googleAdsWrites:false,organicAutoPublish:false,automaticPurchases:false,relayManualSend:true,weeklyAdCeiling:200}};
}
