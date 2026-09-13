import { TABLES, listRecords, updateRecord, logActivity, createApproval } from './airtable.js';
import { createWindsorMarketingReader } from './windsor-marketing.js';

const DEFAULT_BASE='https://connectors.windsor.ai';
const TZ='America/New_York';
export const MARKETING_AUTH=Object.freeze({configuredAverageDailyBudgetMaxUsd:10,firstSevenDaysObservedSpendMaxUsd:70,radiusMiles:25});
export const WINDSOR_ACCOUNTS=Object.freeze({facebook_organic:'1293599907163519',instagram:'17841441821741678',google_ads:'675-352-4819'});
const SOCIAL_ACTIONS=new Set(['create_post','create_photo_post','create_image_post','create_carousel_post','create_story','create_video_post']);
const GOOGLE_ACTIONS=new Set(['create_campaign','create_ad_group','create_ad_asset','create_responsive_search_ad','pause_campaign','enable_campaign','pause_ad_group','enable_ad_group','pause_ad','enable_ad','push_keywords','push_negative_keywords','update_keywords','remove_keywords','remove_negative_keywords','update_ad_group','set_campaign_budget','set_campaign_bidding_strategy','set_campaign_geo_targeting','set_campaign_language_targeting','set_ad_schedule','set_cpc_bid_ceiling','set_max_cpc','set_target_cpa','set_target_roas']);
const CAMPAIGN_ACTIONS=new Set(['pause_campaign','enable_campaign','set_campaign_budget','set_campaign_bidding_strategy','set_campaign_geo_targeting','set_campaign_language_targeting','set_ad_schedule','set_cpc_bid_ceiling','set_target_cpa','set_target_roas']);
const AD_GROUP_ACTIONS=new Set(['enable_ad_group','pause_ad_group','update_ad_group','set_max_cpc','push_keywords','update_keywords','remove_keywords']);

function val(v){return typeof v==='string'?v:v?.name||''}
function safeError(error,apiKey=''){return String(error?.message||error||'Marketing execution failed').replaceAll(apiKey||'\u0000','[REDACTED]').replace(/api_key=[^&\s]+/gi,'api_key=[REDACTED]').slice(0,4000)}
function parsePayload(raw){if(!raw)return {};try{return typeof raw==='string'?JSON.parse(raw):raw}catch{throw new Error('Execution Payload JSON is invalid')}}
function dollarsToMicros(v){return Math.round(Number(v)*1_000_000)}
function localDate(d=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function completedGoogleRows(rows){return rows.filter(r=>r.fields?.['Execution Connector']==='google_ads'&&val(r.fields?.['Execution Status'])==='Completed')}

function assertBudget(action,p){
  const daily=dollarsToMicros(MARKETING_AUTH.configuredAverageDailyBudgetMaxUsd),week=dollarsToMicros(MARKETING_AUTH.firstSevenDaysObservedSpendMaxUsd);
  if(action==='create_campaign'){
    const amount=Number(p.budget_amount_micros);if(!Number.isFinite(amount)||amount<=0)throw new Error('Campaign configured average daily budget is required');
    if(amount>daily)throw new Error('Budget guard blocked configured Google average daily budget above $10/day');
    if((p.status||'paused')!=='paused')throw new Error('Campaign creation must be paused; enablement is a separate guarded action');
  }
  if(action==='set_campaign_budget'){
    const amount=Number(p.amount_micros);if(!Number.isFinite(amount)||amount<=0)throw new Error('Campaign budget amount is required');
    const max=p.budget_type==='lifetime'?week:daily;if(amount>max)throw new Error(`Budget guard blocked ${p.budget_type||'daily'} budget above owner authorization`);
    if(p.apply_to_shared_budget)throw new Error('Shared-budget mutation is blocked because it could increase effective spend outside this authorization');
  }
  if(action==='set_campaign_geo_targeting'){
    const positiveLocations=(p.locations||[]).filter(x=>!x.negative);if(positiveLocations.length)throw new Error('Geo guard requires proximity targeting; positive broad location targets are blocked');
    const proximities=p.proximities||[];if(!proximities.length)throw new Error('Geo guard requires a Charleston-area proximity target');
    for(const x of proximities){const miles=String(x.radius_units||'').toUpperCase()==='KILOMETERS'?Number(x.radius)/1.609344:Number(x.radius);if(!Number.isFinite(miles)||miles>MARKETING_AUTH.radiusMiles)throw new Error('Geo guard blocked radius above 25 miles');}
  }
}
export function validateExecutionSpec({connector,action,payload}){
  if(!['facebook_organic','instagram','google_ads'].includes(connector))throw new Error('Unsupported marketing execution connector');
  if(connector==='facebook_organic'&&!['create_post','create_photo_post'].includes(action))throw new Error('Unsupported Facebook Organic action');
  if(connector==='instagram'&&!SOCIAL_ACTIONS.has(action))throw new Error('Unsupported Instagram action');
  if(connector==='google_ads'&&!GOOGLE_ACTIONS.has(action))throw new Error('Unsupported Google Ads action');
  if(connector==='google_ads')assertBudget(action,payload||{});return true;
}

export function getManagedGoogleRegistry(rows=[]){
  const campaigns=new Map(),adGroups=new Map();
  for(const r of completedGoogleRows(rows)){
    const f=r.fields||{},action=String(f['Execution Action']||''),payload=parsePayload(f['Execution Payload JSON']),providerId=String(f['Provider Object ID']||'').trim(),at=f['Execution Completed At']||f['Execution Started At']||f['Created At']||r.createdTime||null;
    if(action==='create_campaign'&&providerId)campaigns.set(providerId,{id:providerId,createdAt:at,configuredAverageDailyBudgetUsd:Number(payload.budget_amount_micros||0)/1_000_000,sourceRecordId:r.id,firstEnabledAt:null,lastControlAction:'create_campaign',lastControlAt:at,spendGuardPausedAt:f['Spend Guard Paused At']||null});
  }
  for(const r of completedGoogleRows(rows)){
    const f=r.fields||{},action=String(f['Execution Action']||''),payload=parsePayload(f['Execution Payload JSON']),providerId=String(f['Provider Object ID']||'').trim();
    if(action==='create_ad_group'&&providerId&&campaigns.has(String(payload.campaign_id||'')))adGroups.set(providerId,{id:providerId,campaignId:String(payload.campaign_id),sourceRecordId:r.id});
  }
  const ordered=completedGoogleRows(rows).sort((a,b)=>new Date(a.fields?.['Execution Completed At']||0)-new Date(b.fields?.['Execution Completed At']||0));
  for(const r of ordered){
    const f=r.fields||{},action=String(f['Execution Action']||''),payload=parsePayload(f['Execution Payload JSON']),campaignId=String(payload.campaign_id||''),at=f['Execution Completed At']||f['Execution Started At']||f['Created At']||r.createdTime||null,c=campaigns.get(campaignId);if(!c)continue;
    if(action==='enable_campaign'){if(!c.firstEnabledAt)c.firstEnabledAt=at;c.lastControlAction=action;c.lastControlAt=at;}
    if(action==='pause_campaign'){c.lastControlAction=action;c.lastControlAt=at;}
  }
  return {campaigns,adGroups,campaignIds:new Set(campaigns.keys()),adGroupIds:new Set(adGroups.keys())};
}

export function assertManagedGoogleTarget(action,payload={},registry){
  if(action==='create_campaign')return true;if(!registry)throw new Error('GhostOS managed Google Ads registry is required');
  if(action==='create_ad_group'){if(!registry.campaignIds.has(String(payload.campaign_id||'')))throw new Error('Blocked Google Ads action targeting a campaign not registered as GhostOS-managed');return true;}
  if(action==='create_ad_asset'){
    if(payload.level==='campaign'&&!registry.campaignIds.has(String(payload.campaign_id||'')))throw new Error('Blocked asset change on unrelated Google Ads campaign');
    if(payload.level==='ad_group'&&!registry.adGroupIds.has(String(payload.ad_group_id||'')))throw new Error('Blocked asset change on unrelated Google Ads ad group');return true;
  }
  if(action==='create_responsive_search_ad'||AD_GROUP_ACTIONS.has(action)||action==='enable_ad'||action==='pause_ad'){
    if(!registry.adGroupIds.has(String(payload.ad_group_id||'')))throw new Error('Blocked Google Ads action targeting an ad group not registered as GhostOS-managed');return true;
  }
  if(action==='push_negative_keywords'||action==='remove_negative_keywords'){
    if(payload.level==='campaign'){if(!registry.campaignIds.has(String(payload.campaign_id||'')))throw new Error('Blocked negative-keyword change on unrelated Google Ads campaign');return true;}
    if(payload.level==='ad_group'){if(!registry.adGroupIds.has(String(payload.ad_group_id||'')))throw new Error('Blocked negative-keyword change on unrelated Google Ads ad group');return true;}
    throw new Error('Negative-keyword action requires explicit campaign or ad-group level');
  }
  if(CAMPAIGN_ACTIONS.has(action)){const id=String(payload.campaign_id||'');if(!registry.campaignIds.has(id))throw new Error('Blocked Google Ads action targeting a campaign not registered as GhostOS-managed');return true;}
  throw new Error('Blocked Google Ads action without an explicit GhostOS-managed target');
}

function managedSpendSnapshot(source,registry,now=new Date()){
  if(!source?.configured)return {reportingAvailable:false,reason:'Windsor Google Ads runtime is not configured',todayObservedSpend:null,firstSevenDayObservedSpend:null,activeCampaignIds:[],managedRows:[]};
  const managedRows=(source.rows||[]).filter(r=>registry.campaignIds.has(String(r.campaign_id||''))),statusByCampaign=new Map();for(const row of managedRows)if(row.campaign_status)statusByCampaign.set(String(row.campaign_id),String(row.campaign_status).toUpperCase());
  const activeCampaignIds=[...registry.campaigns.values()].filter(c=>!c.spendGuardPausedAt&&(statusByCampaign.get(c.id)==='ENABLED'||(!statusByCampaign.has(c.id)&&c.lastControlAction==='enable_campaign'))).map(c=>c.id);
  const launchTimes=[...registry.campaigns.values()].map(c=>Date.parse(c.firstEnabledAt||'')).filter(Number.isFinite),launchAt=launchTimes.length?Math.min(...launchTimes):null,firstSevenEnd=launchAt==null?null:launchAt+7*86400000,today=localDate(now);let todayObservedSpend=0,firstSevenDayObservedSpend=0;
  for(const row of managedRows){const spend=Number(row.spend||0)||0,day=String(row.date||'').slice(0,10),t=Date.parse(day);if(day===today)todayObservedSpend+=spend;if(launchAt!=null&&Number.isFinite(t)&&t>=launchAt-86400000&&t<firstSevenEnd)firstSevenDayObservedSpend+=spend;}
  return {reportingAvailable:Boolean(source.available)||managedRows.length>0,reason:source.error||null,todayObservedSpend,firstSevenDayObservedSpend:launchAt==null?0:firstSevenDayObservedSpend,portfolioFirstEnabledAt:launchAt==null?null:new Date(launchAt).toISOString(),firstSevenEndsAt:firstSevenEnd==null?null:new Date(firstSevenEnd).toISOString(),activeCampaignIds,managedRows};
}

async function surfaceSpendAlert({summary,amount,detail}){
  const approvals=await listRecords(TABLES.APPROVALS,{maxRecords:200}),duplicate=approvals.some(r=>r.fields?.Status==='Pending'&&String(r.fields?.Summary||'')===summary);if(duplicate)return false;
  await createApproval({type:'Marketing Spend Anomaly',amount,summary,requestedAction:detail,requestedBy:'FORGE'});await logActivity({agent:'ATLAS',actionType:'google_ads_spend_owner_attention',status:'Blocked',detail:`${summary}. ${detail}`,consequential:true});return true;
}

async function executeWindsor({connector,action,payload,env=process.env,fetchImpl=fetch,registry=null}){
  const apiKey=String(env.WINDSOR_API_KEY||'').trim();if(!apiKey)throw new Error('WINDSOR_API_KEY is not configured');validateExecutionSpec({connector,action,payload});if(connector==='google_ads')assertManagedGoogleTarget(action,payload,registry);
  const account=WINDSOR_ACCOUNTS[connector];if(!account)throw new Error(`No approved Windsor account mapping for ${connector}`);const base=String(env.WINDSOR_API_BASE_URL||DEFAULT_BASE).replace(/\/$/,'');const url=new URL(`${base}/${connector}/actions`);url.searchParams.set('api_key',apiKey);
  const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'GhostOS-Windsor/1.0'},body:JSON.stringify({account,action,params:payload||{}})});const text=await response.text();let data;try{data=JSON.parse(text)}catch{data={result:text}}if(!response.ok)throw new Error(`Windsor ${connector}/${action} returned HTTP ${response.status}: ${String(data?.error||data?.message||data?.result||'request failed').slice(0,1000)}`);return data;
}
function providerMeta(data,action=''){
  const preferred=action==='create_campaign'?'campaign_id':action==='create_ad_group'?'ad_group_id':null,seen=new Set();let id=null,permalink=null;
  function walk(v){if(!v||seen.has(v)||typeof v!=='object')return;seen.add(v);if(preferred&&v[preferred]!=null&&!id)id=String(v[preferred]);for(const [k,x] of Object.entries(v)){if(!id&&/(^id$|_id$)/i.test(k)&&['string','number'].includes(typeof x))id=String(x);if(!permalink&&/(permalink|url)$/i.test(k)&&typeof x==='string'&&/^https?:\/\//i.test(x))permalink=x;walk(x)}}walk(data);return {id,permalink};
}

export async function monitorManagedGoogleSpend({rows,now=new Date(),env=process.env,fetchImpl=fetch}={}){
  const registry=getManagedGoogleRegistry(rows||[]);if(!registry.campaignIds.size)return {skipped:true,reason:'no_ghostos_managed_campaigns'};
  const source=await createWindsorMarketingReader({env,fetchImpl}).readSource('googleAds'),observed=managedSpendSnapshot(source,registry,now),managed=[...registry.campaigns.values()];
  const budgetViolation=managed.find(c=>c.configuredAverageDailyBudgetUsd>MARKETING_AUTH.configuredAverageDailyBudgetMaxUsd);if(budgetViolation)await surfaceSpendAlert({summary:`GhostOS-managed Google campaign ${budgetViolation.id} has a configured average daily budget above $10`,amount:budgetViolation.configuredAverageDailyBudgetUsd,detail:'Owner attention required. GhostOS will not increase this budget; review the provider configuration. Google average daily budget is not a guarantee of a calendar-day charge cap.'});
  if(observed.activeCampaignIds.length&&!observed.reportingAvailable){await surfaceSpendAlert({summary:'Google Ads spend reporting unavailable for an active GhostOS-managed campaign',amount:null,detail:'FORGE cannot reliably observe spend right now. Provider reporting can lag; the $70 protection is best-effort and cannot guarantee against delayed platform-reported spend.'});return {...observed,registry,alerted:true};}
  if(observed.todayObservedSpend>MARKETING_AUTH.configuredAverageDailyBudgetMaxUsd)await surfaceSpendAlert({summary:`Observed Google Ads spend is $${observed.todayObservedSpend.toFixed(2)} today`,amount:observed.todayObservedSpend,detail:'Observed calendar-day spend exceeded the configured $10 average daily budget. Google may overdeliver relative to an average daily budget; this is an anomaly alert, not proof the configured budget changed.'});
  const thresholdReached=observed.firstSevenDayObservedSpend>=MARKETING_AUTH.firstSevenDaysObservedSpendMaxUsd,paused=[];if(thresholdReached){
    for(const campaignId of observed.activeCampaignIds){const c=registry.campaigns.get(campaignId);try{await executeWindsor({connector:'google_ads',action:'pause_campaign',payload:{campaign_id:campaignId},env,fetchImpl,registry});const pausedAt=new Date().toISOString();await updateRecord(TABLES.GROWTH_WORK,c.sourceRecordId,{'Spend Guard Paused At':pausedAt,'Next Action':'Owner: review Google Ads spend guard pause before any re-enable.','Latest Result':`FORGE automatically paused this GhostOS-managed campaign after observed first-7-day spend reached $${observed.firstSevenDayObservedSpend.toFixed(2)}. Provider reporting can lag; this is a best-effort protection.`,'Updated At':pausedAt});await logActivity({agent:'FORGE',actionType:'google_ads_spend_guard_paused',status:'Done',detail:`Paused GhostOS-managed campaign ${campaignId} at observed first-7-day spend $${observed.firstSevenDayObservedSpend.toFixed(2)}.`,consequential:true});paused.push(campaignId);}catch(error){await surfaceSpendAlert({summary:`Failed to pause GhostOS-managed Google campaign ${campaignId} after observed first-7-day spend reached $${observed.firstSevenDayObservedSpend.toFixed(2)}`,amount:observed.firstSevenDayObservedSpend,detail:`Immediate owner attention required. ${safeError(error,env.WINDSOR_API_KEY)}`});}}
    await surfaceSpendAlert({summary:`Observed first-7-day Google Ads spend reached $${observed.firstSevenDayObservedSpend.toFixed(2)}`,amount:observed.firstSevenDayObservedSpend,detail:`GhostOS paused ${paused.length} active GhostOS-managed campaign(s). This $70 protection is a best-effort execution guard because Google/Windsor reporting can lag; it is not a guarantee against spend reported later.`});
  }
  return {...observed,thresholdReached,paused,managedCampaignIds:[...registry.campaignIds]};
}

export async function runMarketingExecutionCycle({now=new Date(),env=process.env,fetchImpl=fetch}={}){
  if(String(env.MARKETING_EXECUTION_ENABLED||'').toLowerCase()!=='true')return {skipped:true,reason:'marketing_execution_disabled'};
  const rows=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300}),registry=getManagedGoogleRegistry(rows),spendMonitor=await monitorManagedGoogleSpend({rows,now,env,fetchImpl});
  const due=rows.filter(r=>val(r.fields?.['Owner Decision'])==='Approved'&&['Approved','Scheduled'].includes(val(r.fields?.['Execution Status']))&&r.fields?.['Execution Connector']&&r.fields?.['Execution Action']&&r.fields?.['Execution Payload JSON']&&!r.fields?.['Provider Object ID']&&(!r.fields?.['Scheduled At']||Date.parse(r.fields['Scheduled At'])<=now.getTime())),row=due[0];if(!row)return {skipped:true,reason:'no_due_approved_execution',spendMonitor};
  const f=row.fields||{},connector=String(f['Execution Connector']||''),action=String(f['Execution Action']||''),payload=parsePayload(f['Execution Payload JSON']);validateExecutionSpec({connector,action,payload});if(connector==='google_ads')assertManagedGoogleTarget(action,payload,registry);
  if(connector==='google_ads'&&action==='enable_campaign'){
    const c=registry.campaigns.get(String(payload.campaign_id||''));if(c?.spendGuardPausedAt)throw new Error('Spend guard blocked re-enablement after an automatic first-7-day authorization pause; new owner authorization is required');
    if(spendMonitor.firstSevenDayObservedSpend>=MARKETING_AUTH.firstSevenDaysObservedSpendMaxUsd)throw new Error('Spend guard blocked campaign enablement because observed first-7-day spend reached the $70 authorization');
    if(spendMonitor.reportingAvailable===false&&c?.firstEnabledAt)throw new Error('Spend guard blocked re-enablement because current observed spend reporting is unavailable');
  }
  await updateRecord(TABLES.GROWTH_WORK,row.id,{'Execution Status':'Executing','Execution Started At':now.toISOString(),'Execution Error':'','Updated At':now.toISOString()});
  try{
    const result=await executeWindsor({connector,action,payload,env,fetchImpl,registry}),meta=providerMeta(result,action),done=new Date().toISOString();await updateRecord(TABLES.GROWTH_WORK,row.id,{'Execution Status':'Completed','Publishing Status':connector==='google_ads'?undefined:'Published — Connected Confirmation','Provider Object ID':meta.id||f['Execution Idempotency Key']||row.id,'Provider Permalink':meta.permalink,'Execution Completed At':done,'Latest Result':`Provider confirmed ${connector}/${action}. ${String(result?.result||result?.message||'Completed').slice(0,5000)}`,'Updated At':done});await logActivity({agent:connector==='google_ads'?'FORGE':'ECHO',actionType:'marketing_execution_completed',status:'Done',detail:`Provider confirmed ${connector}/${action} for ${f['Growth Item']||row.id}.`,consequential:true});return {skipped:false,id:row.id,completed:true,connector,action,providerId:meta.id,spendMonitor};
  }catch(error){const msg=safeError(error,env.WINDSOR_API_KEY),failed=new Date().toISOString();await updateRecord(TABLES.GROWTH_WORK,row.id,{'Execution Status':'Failed — Owner Attention','Execution Error':msg,'Latest Result':`Execution failed/ambiguous. Automatic retry is disabled to avoid duplicate external actions. ${msg}`,'Updated At':failed});await logActivity({agent:connector==='google_ads'?'FORGE':'ECHO',actionType:'marketing_execution_failed',status:'Error',detail:msg,consequential:true});return {skipped:false,id:row.id,failed:true,error:msg,spendMonitor};}
}
