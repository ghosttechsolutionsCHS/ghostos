import { TABLES, listRecords, updateRecord, logActivity } from './airtable.js';
import { createWindsorMarketingReader } from './windsor-marketing.js';

const DEFAULT_BASE='https://connectors.windsor.ai';
export const MARKETING_AUTH=Object.freeze({dailyMaxUsd:10,firstSevenDaysMaxUsd:70,radiusMiles:25});
export const WINDSOR_ACCOUNTS=Object.freeze({facebook_organic:'1293599907163519',instagram:'17841441821741678',google_ads:'675-352-4819'});
const SOCIAL_ACTIONS=new Set(['create_post','create_photo_post','create_image_post','create_carousel_post','create_story','create_video_post']);
const GOOGLE_ACTIONS=new Set(['create_campaign','create_ad_group','create_ad_asset','create_responsive_search_ad','pause_campaign','enable_campaign','pause_ad_group','enable_ad_group','pause_ad','enable_ad','push_keywords','push_negative_keywords','update_keywords','remove_keywords','remove_negative_keywords','set_campaign_budget','set_campaign_bidding_strategy','set_campaign_geo_targeting','set_campaign_language_targeting','set_ad_schedule','set_cpc_bid_ceiling','set_max_cpc','set_target_cpa','set_target_roas']);

function val(v){return typeof v==='string'?v:v?.name||''}
function safeError(error,apiKey=''){return String(error?.message||error||'Marketing execution failed').replaceAll(apiKey||'\u0000','[REDACTED]').replace(/api_key=[^&\s]+/gi,'api_key=[REDACTED]').slice(0,4000)}
function parsePayload(raw){if(!raw)return {};try{return typeof raw==='string'?JSON.parse(raw):raw}catch{throw new Error('Execution Payload JSON is invalid')}}
function dollarsToMicros(v){return Math.round(Number(v)*1_000_000)}
function assertBudget(action,p){
  const daily=dollarsToMicros(MARKETING_AUTH.dailyMaxUsd),week=dollarsToMicros(MARKETING_AUTH.firstSevenDaysMaxUsd);
  if(action==='create_campaign'){
    if(Number(p.budget_amount_micros)>daily)throw new Error('Budget guard blocked campaign creation above $10/day');
    if((p.status||'paused')!=='paused')throw new Error('Campaign creation must be paused; enablement is a separate guarded action');
  }
  if(action==='set_campaign_budget'){
    const max=p.budget_type==='lifetime'?week:daily;
    if(Number(p.amount_micros)>max)throw new Error(`Budget guard blocked ${p.budget_type||'daily'} budget above owner authorization`);
    if(p.apply_to_shared_budget)throw new Error('Shared-budget mutation is blocked because it could increase effective spend outside this authorization');
  }
  if(action==='set_campaign_geo_targeting'){
    for(const x of p.proximities||[])if(String(x.radius_units||'').toUpperCase()==='MILES'&&Number(x.radius)>MARKETING_AUTH.radiusMiles)throw new Error('Geo guard blocked radius above 25 miles');
  }
}
export function validateExecutionSpec({connector,action,payload}){
  if(!['facebook_organic','instagram','google_ads'].includes(connector))throw new Error('Unsupported marketing execution connector');
  if(connector==='facebook_organic'&&!['create_post','create_photo_post'].includes(action))throw new Error('Unsupported Facebook Organic action');
  if(connector==='instagram'&&!SOCIAL_ACTIONS.has(action))throw new Error('Unsupported Instagram action');
  if(connector==='google_ads'&&!GOOGLE_ACTIONS.has(action))throw new Error('Unsupported Google Ads action');
  if(connector==='google_ads')assertBudget(action,payload||{});
  return true;
}
async function firstSevenDaySpend(){
  const source=await createWindsorMarketingReader().readSource('googleAds');
  if(!source.available)return {known:false,spend:null};
  const cutoff=Date.now()-7*86400000;let spend=0;
  for(const row of source.rows||[]){const d=Date.parse(row.date);if(Number.isFinite(d)&&d>=cutoff)spend+=Number(row.spend||0)||0}
  return {known:true,spend};
}
async function executeWindsor({connector,action,payload,env=process.env,fetchImpl=fetch}){
  const apiKey=String(env.WINDSOR_API_KEY||'').trim();if(!apiKey)throw new Error('WINDSOR_API_KEY is not configured');
  validateExecutionSpec({connector,action,payload});
  if(connector==='google_ads'&&action==='enable_campaign'){
    const seven=await firstSevenDaySpend();
    if(!seven.known)throw new Error('Spend guard cannot verify the last-7-day Google Ads spend; enablement blocked');
    if(seven.spend>=MARKETING_AUTH.firstSevenDaysMaxUsd)throw new Error('Spend guard blocked enablement because the $70 first-seven-day ceiling is reached');
  }
  const account=WINDSOR_ACCOUNTS[connector];if(!account)throw new Error(`No approved Windsor account mapping for ${connector}`);
  const base=String(env.WINDSOR_API_BASE_URL||DEFAULT_BASE).replace(/\/$/,'');const url=new URL(`${base}/${connector}/actions`);url.searchParams.set('api_key',apiKey);
  const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'GhostOS-Windsor/1.0'},body:JSON.stringify({account,action,params:payload||{}})});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data={result:text}}
  if(!response.ok)throw new Error(`Windsor ${connector}/${action} returned HTTP ${response.status}: ${String(data?.error||data?.message||data?.result||'request failed').slice(0,1000)}`);
  return data;
}
function providerMeta(data){
  const seen=new Set();let id=null,permalink=null;
  function walk(v){if(!v||seen.has(v)||typeof v!=='object')return;if(typeof v==='object')seen.add(v);for(const [k,x] of Object.entries(v)){if(!id&&/(^id$|_id$)/i.test(k)&&['string','number'].includes(typeof x))id=String(x);if(!permalink&&/(permalink|url)$/i.test(k)&&typeof x==='string'&&/^https?:\/\//i.test(x))permalink=x;walk(x)}}walk(data);return {id,permalink};
}
export async function runMarketingExecutionCycle({now=new Date(),env=process.env,fetchImpl=fetch}={}){
  if(String(env.MARKETING_EXECUTION_ENABLED||'').toLowerCase()!=='true')return {skipped:true,reason:'marketing_execution_disabled'};
  const rows=await listRecords(TABLES.GROWTH_WORK,{maxRecords:300});
  const due=rows.filter(r=>val(r.fields?.['Owner Decision'])==='Approved'&&['Approved','Scheduled'].includes(val(r.fields?.['Execution Status']))&&r.fields?.['Execution Connector']&&r.fields?.['Execution Action']&&r.fields?.['Execution Payload JSON']&&!r.fields?.['Provider Object ID']&&(!r.fields?.['Scheduled At']||Date.parse(r.fields['Scheduled At'])<=now.getTime()));
  const row=due[0];if(!row)return {skipped:true,reason:'no_due_approved_execution'};
  const f=row.fields||{},connector=String(f['Execution Connector']||''),action=String(f['Execution Action']||''),payload=parsePayload(f['Execution Payload JSON']);
  validateExecutionSpec({connector,action,payload});
  await updateRecord(TABLES.GROWTH_WORK,row.id,{'Execution Status':'Executing','Execution Started At':now.toISOString(),'Execution Error':'','Updated At':now.toISOString()});
  try{
    const result=await executeWindsor({connector,action,payload,env,fetchImpl});const meta=providerMeta(result),done=new Date().toISOString();
    await updateRecord(TABLES.GROWTH_WORK,row.id,{'Execution Status':'Completed','Publishing Status':connector==='google_ads'?undefined:'Published — Connected Confirmation','Provider Object ID':meta.id||f['Execution Idempotency Key']||row.id,'Provider Permalink':meta.permalink,'Execution Completed At':done,'Latest Result':`Provider confirmed ${connector}/${action}. ${String(result?.result||result?.message||'Completed').slice(0,5000)}`,'Updated At':done});
    await logActivity({agent:connector==='google_ads'?'FORGE':'ECHO',actionType:'marketing_execution_completed',status:'Done',detail:`Provider confirmed ${connector}/${action} for ${f['Growth Item']||row.id}.`,consequential:true});return {skipped:false,id:row.id,completed:true,connector,action,providerId:meta.id};
  }catch(error){const msg=safeError(error,env.WINDSOR_API_KEY),failed=new Date().toISOString();await updateRecord(TABLES.GROWTH_WORK,row.id,{'Execution Status':'Failed — Owner Attention','Execution Error':msg,'Latest Result':`Execution failed/ambiguous. Automatic retry is disabled to avoid duplicate external actions. ${msg}`,'Updated At':failed});await logActivity({agent:connector==='google_ads'?'FORGE':'ECHO',actionType:'marketing_execution_failed',status:'Error',detail:msg,consequential:true});return {skipped:false,id:row.id,failed:true,error:msg};}
}
