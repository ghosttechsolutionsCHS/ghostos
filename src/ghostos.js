import { Agent, run, webSearchTool } from '@openai/agents';
import Airtable from 'airtable';

const TABLE = 'Leads & Jobs';
const base = () => new Airtable({apiKey: process.env.AIRTABLE_PAT}).base(process.env.AIRTABLE_BASE_ID);

async function updateLead(id, fields){ await base()(TABLE).update(id, fields); }

const relay = new Agent({
  name:'RELAY', model:'gpt-5.6-sol',
  instructions:`You are RELAY, customer support and sales for Ghost Tech Solutions in North Charleston SC. Diagnose lead information, decide what is missing, prepare concise natural customer replies, and move profitable legitimate repairs toward booking. Never invent price, diagnosis, stock, compatibility, or availability.`
});

const supply = new Agent({
  name:'SUPPLY', model:'gpt-5.6-sol', tools:[webSearchTool({searchContextSize:'medium'})],
  instructions:`You are SUPPLY for Ghost Tech Solutions. Research repair parts on the live web. Find three real options when possible: BUDGET, STANDARD, PREMIUM. Prefer Injured Gadgets, then reputable repair-parts vendors. Verify exact model compatibility, live product page, price, stock, shipping and quality. Never invent a URL, price or stock. Mark anything not verified as UNVERIFIED. Recommend the best balance of reliability and margin. Never purchase.`
});

const ledger = new Agent({
  name:'LEDGER', model:'gpt-5.6-sol',
  instructions:`You are LEDGER. Analyze repair economics. Use only supplied verified numbers. Calculate expected gross profit and flag weak margins. Never fabricate costs or revenue.`
});

const dispatch = new Agent({
  name:'DISPATCH', model:'gpt-5.6-sol',
  instructions:`You are DISPATCH. Plan repair scheduling and mobile service within 25 miles, normal availability 8 AM-8 PM. Do not promise a time that has not been confirmed.`
});

const atlas = new Agent({
  name:'ATLAS', model:'gpt-5.6-sol',
  instructions:`You are ATLAS, autonomous general manager of Ghost Tech Solutions. Optimize sustainable legitimate profitable completed jobs and cash, not vanity metrics. Delegate to specialists. Routine research, analysis, drafting and internal decisions should happen without owner interruption. Require owner approval before purchases, refunds, contracts, unusual pricing, material ad-spend changes, or other consequential external actions. Never claim an action occurred unless a tool/result proves it. Return a compact manager decision with ACTION, OWNER_APPROVAL_NEEDED, CUSTOMER_REPLY, INTERNAL_NOTES.`,
  tools:[
    relay.asTool({toolName:'relay',toolDescription:'Analyze and respond to a customer lead.'}),
    supply.asTool({toolName:'supply',toolDescription:'Research and compare live repair parts.'}),
    ledger.asTool({toolName:'ledger',toolDescription:'Analyze repair economics and margins.'}),
    dispatch.asTool({toolName:'dispatch',toolDescription:'Plan scheduling and mobile service.'})
  ]
});

export async function processLead(recordId, lead){
  const input = `Process this lead end-to-end. Use specialists as needed. Do not purchase anything or invent facts.\nLEAD:\n${JSON.stringify(lead,null,2)}`;
  const result = await run(atlas,input,{maxTurns:12});
  const output = String(result.finalOutput || '');
  if(recordId) await updateLead(recordId, {'RELAY Next Action': output.slice(0,90000)});
  return output;
}
