import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPartsQuoteOverview, humanizeActivityDetail } from '../src/owner-operations.js';

const job={id:'job1',fields:{'Customer Name':'Saif','Job / Customer':'Saif - iPhone 17 Pro Max','Device / Service':'iPhone 17 Pro Max',Issue:'Cracked screen',Status:'New Lead','RELAY State':'Part Research','RELAY Next Action':'SUPPLY research stored. Continue to verified quote economics.'}};
const parts=[
  {id:'p1',fields:{Job:['job1'],'Part / SKU':'Premium Refurbished OLED Screen','Device':'iPhone 17 Pro Max',Vendor:'Injured Gadgets','Vendor URL':'https://example.com/ig','Research Tier':'Standard','Research Status':'Verified','Stock Status':'Listed; exact stock UNVERIFIED',Recommended:true,'Researched At':'2026-09-13T04:14:46Z'}},
  {id:'p2',fields:{Job:['job1'],'Part / SKU':'Soft OLED','Device':'iPhone 17 Pro Max',Vendor:'MobileSentrix','Vendor URL':'https://example.com/ms','Research Tier':'Budget','Research Status':'Verified','Stock Status':'Available','Unit Cost':79.22,'Researched At':'2026-09-13T04:14:47Z'}},
];
const activity=[
  {fields:{Job:['job1'],Agent:'SUPPLY','Action Type':'parts_research_stored',Status:'Done',Detail:'2 option(s) stored','Created At':'2026-09-13T04:15:03Z'}},
  {fields:{Job:['job1'],Agent:'ATLAS','Action Type':'parts_quote_pipeline_waiting',Status:'Done',Detail:'Final quote withheld because verified usable part economics are incomplete.','Created At':'2026-09-13T04:15:02Z'}},
  {fields:{Job:['job1'],Agent:'RELAY','Action Type':'customer_message_drafted',Status:'Done',Detail:'Holding draft ready','Created At':'2026-09-13T04:15:02Z'}},
];
const messages=[{fields:{Job:['job1'],Status:'Pending','Message Type':'status_update','Created At':'2026-09-13T04:15:02Z'}}];

test('owner overview keeps all SUPPLY options visible and refuses to invent quote',()=>{
  const [view]=buildPartsQuoteOverview({jobs:[job],parts,quotes:[],activity,messages});
  assert.equal(view.customer,'Saif');
  assert.equal(view.parts.length,2);
  assert.equal(view.recommendedPart.vendor,'Injured Gadgets');
  assert.equal(view.recommendedPart.partCost,null);
  assert.equal(view.pricingCard.ready,false);
  assert.equal(view.pricingCard.label,'QUOTE NOT READY');
  assert.match(view.quoteWithheldReason,/no verified price/i);
  assert.match(view.pipelineSummary,/SUPPLY researched 2 options/);
  assert.match(view.pipelineSummary,/RELAY holding draft ready/);
});

test('owner overview shows persisted quote economics exactly',()=>{
  const quote={id:'q1',fields:{Job:['job1'],Status:'Approved','Total Quote':220,'Labor Price':120,'Parts Price':100,'Parts Cost':79.22,'Gross Profit':140.78,'Gross Margin':0.6399,'Created At':'2026-09-13T04:20:00Z'}};
  const [view]=buildPartsQuoteOverview({jobs:[job],parts,quotes:[quote],activity,messages});
  assert.equal(view.pricingCard.ready,true);
  assert.equal(view.pricingCard.total,220);
  assert.equal(view.pricingCard.partCost,79.22);
  assert.equal(view.pricingCard.grossProfit,140.78);
  assert.equal(view.pricingCard.grossMargin,0.6399);
  assert.deepEqual(view.pricingCard.blockers,[]);
});

test('agent activity JSON becomes human-readable while raw activity remains elsewhere',()=>{
  const text=humanizeActivityDetail('ai_execution',JSON.stringify({provider:'anthropic',model:'claude-sonnet-4-6',success:true,latencyMs:53788}));
  assert.equal(text,'anthropic · claude-sonnet-4-6 · completed · 53.8s');
});
