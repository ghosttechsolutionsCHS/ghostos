const DEFAULT_BASE='https://connectors.windsor.ai';

const SOURCES=Object.freeze({
  googleAds:{connector:'google_ads',preset:'last_30dT',fields:['date','campaign','campaign_id','spend','clicks','impressions','conversions','conversion_value']},
  ga4:{connector:'googleanalytics4',preset:'last_30dT',fields:['date','sessions','totalusers','conversions_ads_conversion_request_quote_1','session_default_channel_group','landing_page']},
  searchConsole:{connector:'searchconsole',preset:'last_30dT',fields:['date','query','page','clicks','impressions','ctr','position']},
  businessProfile:{connector:'google_my_business',preset:'last_30dT',fields:['date','call_clicks','website_clicks']},
  clarity:{connector:'microsoft_clarity',preset:'last_3dT',fields:['date','metric_type','total_session_count','distinct_user_count','average_scroll_depth','rage_click_sessions_count','dead_click_sessions_count','quickback_click_sessions_count','url']},
  facebookOrganic:{connector:'facebook_organic',preset:'last_30dT',fields:['date','post_id','post_clicks','post_impressions']},
  instagram:{connector:'instagram',preset:'last_30dT',fields:['date','media_id','media_caption','media_type','media_reach','media_engagement']},
});

function rows(payload){
  if(Array.isArray(payload))return payload;
  for(const key of ['data','rows','result'])if(Array.isArray(payload?.[key]))return payload[key];
  return [];
}
function safeMessage(error){return String(error?.message||'Windsor read failed').replace(/api_key=[^&\s]+/gi,'api_key=[REDACTED]').slice(0,300)}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}

export function createWindsorMarketingReader({env=process.env,fetchImpl=fetch}={}){
  const apiKey=String(env.WINDSOR_API_KEY||'').trim();
  const base=String(env.WINDSOR_API_BASE_URL||DEFAULT_BASE).replace(/\/$/,'');
  async function readSource(name){
    const spec=SOURCES[name];
    if(!spec)throw new Error(`Unknown Windsor source: ${name}`);
    if(!apiKey)return {name,connector:spec.connector,configured:false,available:false,rows:[],error:'WINDSOR_API_KEY is not configured in the runtime.'};
    const url=new URL(`${base}/${spec.connector}`);
    url.searchParams.set('api_key',apiKey);url.searchParams.set('fields',spec.fields.join(','));url.searchParams.set('date_preset',spec.preset);url.searchParams.set('_max_rows','500');
    try{
      const response=await fetchImpl(url,{headers:{accept:'application/json','user-agent':'GhostOS-Windsor/1.0'}});
      if(!response.ok)return {name,connector:spec.connector,configured:true,available:false,rows:[],error:`Windsor ${spec.connector} returned HTTP ${response.status}`};
      const data=rows(await response.json());
      return {name,connector:spec.connector,configured:true,available:data.length>0,rows:data,error:null};
    }catch(error){return {name,connector:spec.connector,configured:true,available:false,rows:[],error:safeMessage(error)}}
  }
  async function snapshot(){
    const names=Object.keys(SOURCES);const settled=await Promise.all(names.map(readSource));
    return {provider:'windsor',configured:Boolean(apiKey),fetchedAt:new Date().toISOString(),sources:Object.fromEntries(settled.map(x=>[x.name,x]))};
  }
  return {configured:Boolean(apiKey),readSource,snapshot};
}

export function summarizeGoogleAds(source){
  if(!source?.configured)return {available:false,status:'Runtime credential missing',spend:null,clicks:null,impressions:null,conversions:null,conversionValue:null,campaigns:[]};
  if(!source.available)return {available:false,status:source.error||'No Google Ads rows returned for the selected period',spend:null,clicks:null,impressions:null,conversions:null,conversionValue:null,campaigns:[]};
  const map=new Map();
  for(const row of source.rows){const key=String(row.campaign_id||row.campaign||'unknown');const c=map.get(key)||{id:key,name:String(row.campaign||key),spend:0,clicks:0,impressions:0,conversions:0,conversionValue:0};c.spend+=n(row.spend);c.clicks+=n(row.clicks);c.impressions+=n(row.impressions);c.conversions+=n(row.conversions);c.conversionValue+=n(row.conversion_value);map.set(key,c)}
  const campaigns=[...map.values()];return {available:true,status:'Live Windsor data',spend:campaigns.reduce((s,x)=>s+x.spend,0),clicks:campaigns.reduce((s,x)=>s+x.clicks,0),impressions:campaigns.reduce((s,x)=>s+x.impressions,0),conversions:campaigns.reduce((s,x)=>s+x.conversions,0),conversionValue:campaigns.reduce((s,x)=>s+x.conversionValue,0),campaigns};
}

export {SOURCES as WINDSOR_MARKETING_SOURCES};
