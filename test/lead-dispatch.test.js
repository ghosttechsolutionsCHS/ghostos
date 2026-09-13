import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLeadDispatcher } from '../src/lead-dispatch.js';
import { TABLES } from '../src/airtable.js';

function memoryHarness({ jobFields = {}, failFirst = false } = {}) {
  const jobs = new Map([['job1',{ id:'job1', fields:{ 'Job / Customer':'Test lead', 'Customer Name':'Test', Phone:'8435550100', Status:'New Lead', ...jobFields } }]]);
  const messages=[];
  const activity=[];
  let processorCalls=0;
  let shouldFail=failFirst;
  let tick=0;
  const now=()=>new Date(1_800_000_000_000 + tick++*1000).toISOString();
  const logActivity=async(e)=>{activity.push({...e,fields:{Agent:e.agent,'Action Type':e.actionType,Status:e.status||'Done',Detail:e.detail,'Created At':now()}});};
  const updateRecord=async(table,id,fields)=>{assert.equal(table,TABLES.JOBS);const row=jobs.get(id);Object.assign(row.fields,fields);return row;};
  const createRecord=async(table,fields)=>{
    if(table===TABLES.MESSAGES){const row={id:`msg${messages.length+1}`,fields:{...fields}};messages.push(row);return row;}
    throw new Error(`unexpected create table ${table}`);
  };
  const createRelayDraft=async({jobId,message,messageType,channel})=>{
    const existing=messages.find(m=>m.fields.Job.includes(jobId)&&m.fields.Body===message&&m.fields['Message Type']===messageType);
    if(existing)return existing;
    const row=await createRecord(TABLES.MESSAGES,{Job:[jobId],Body:message,'Message Type':messageType,Channel:channel,Status:'Pending','Idempotency Key':`agent-${jobId}`});
    await logActivity({agent:'RELAY',jobId,actionType:'customer_message_drafted',status:'Done',detail:`Draft ${row.id} created for manual owner copy/send.`});
    jobs.get(jobId).fields['RELAY Reply Draft']=message;
    jobs.get(jobId).fields['RELAY State']='Need More Info';
    return row;
  };
  const processLead=async(jobId)=>{
    processorCalls++;
    if(shouldFail){shouldFail=false;throw new Error('simulated agent failure');}
    await logActivity({agent:'ATLAS',jobId,actionType:'run_started',status:'Running',detail:'GhostOS company processing started.'});
    await createRelayDraft({jobId,message:'Hi — one quick question so I can help with your repair.',messageType:'clarification',channel:'auto'});
    await logActivity({agent:'ATLAS',jobId,actionType:'run_completed',status:'Done',detail:'Lead triaged and RELAY draft prepared.'});
    return 'ok';
  };
  const deps={
    createRecord,
    getRecord:async(table,id)=>{assert.equal(table,TABLES.JOBS);return jobs.get(id);},
    listRecords:async(table)=>table===TABLES.JOBS?[...jobs.values()]:table===TABLES.MESSAGES?messages:[],
    updateRecord,logActivity,createRelayDraft,processLead,now,
  };
  return { jobs,messages,activity,deps,get processorCalls(){return processorCalls;} };
}

test('exact live state: blank dispatch fields + New Lead + existing RELAY Reply Draft + empty RELAY Messages is backfilled', async()=>{
  const h=memoryHarness({jobFields:{'RELAY Reply Draft':'Existing production triage text','RELAY State':'Need More Info'}});
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],undefined);
  assert.equal(h.jobs.get('job1').fields.Status,'New Lead');
  assert.equal(h.messages.length,0);
  assert.equal(h.activity.length,0);

  const cycle=await createLeadDispatcher(h.deps).runCycle({maxLeads:5});
  assert.equal(cycle.newLeadsSeen,1);
  assert.equal(cycle.leadsEligible,1);
  assert.equal(cycle.leadsProcessed,1);
  assert.equal(cycle.draftsRecoveredOrCreated,1);
  assert.deepEqual(cycle.failures,[]);
  assert.equal(h.processorCalls,0,'existing draft must be recovered without regenerating customer text');
  assert.equal(h.messages.length,1);
  assert.equal(h.messages[0].fields.Body,'Existing production triage text');
  assert.equal(h.messages[0].fields.Status,'Pending');
  assert.equal(h.messages[0].fields.Channel,'SMS');
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Processed');
  assert.ok(h.activity.some(a=>a.actionType==='customer_message_draft_recovered'&&a.agent==='RELAY'));
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_completed'&&a.agent==='ATLAS'));
  const summary=h.activity.find(a=>a.actionType==='lead_dispatch_cycle_summary');
  assert.ok(summary,'every scheduled cycle must persist a structured summary');
  assert.match(summary.detail,/"leadsScanned":1/);
  assert.match(summary.detail,/"leadsEligible":1/);
  assert.match(summary.detail,/"draftsRecoveredOrCreated":1/);

  await createLeadDispatcher(h.deps).runCycle({maxLeads:5});
  assert.equal(h.messages.length,1,'second cycle must not create a duplicate');
  assert.equal(h.processorCalls,0);
  const latestSummary=h.activity.filter(a=>a.actionType==='lead_dispatch_cycle_summary').at(-1);
  assert.match(latestSummary.detail,/dispatch_processed/);
});

test('fresh New Lead with no prior draft executes real ATLAS/RELAY chain and persists activity', async()=>{
  const h=memoryHarness();
  const result=await createLeadDispatcher(h.deps).runCycle({maxLeads:5});
  assert.equal(result.leadsEligible,1);
  assert.equal(h.processorCalls,1);
  assert.equal(h.messages.length,1);
  assert.equal(h.messages[0].fields.Status,'Pending');
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Processed');
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_started'&&a.status==='Running'));
  assert.ok(h.activity.some(a=>a.actionType==='customer_message_drafted'&&a.agent==='RELAY'));
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_completed'&&a.agent==='ATLAS'));
});

test('pre-reconciliation failure is no longer silent: failed write is persisted and cycle summary records failure', async()=>{
  const h=memoryHarness({jobFields:{'RELAY Reply Draft':'Existing triage text','RELAY State':'Need More Info'}});
  h.deps.createRecord=async(table)=>{if(table===TABLES.MESSAGES)throw new Error('simulated Airtable message write failure');throw new Error('unexpected table');};
  const result=await createLeadDispatcher(h.deps).runCycle({maxLeads:5});
  assert.equal(result.failures.length,1);
  assert.match(result.failures[0].error,/simulated Airtable message write failure/);
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Failed');
  assert.match(h.jobs.get('job1').fields['GhostOS Dispatch Error'],/simulated Airtable message write failure/);
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_failed'));
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_cycle_summary'&&a.status==='Error'));
});

test('failed agent execution is recorded and explicit owner retry can recover safely', async()=>{
  const h=memoryHarness({failFirst:true});
  await assert.rejects(()=>createLeadDispatcher(h.deps).dispatchLead('job1',{source:'scheduled_dispatcher'}),/simulated agent failure/);
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Failed');
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_failed'));
  const recovered=await createLeadDispatcher(h.deps).dispatchLead('job1',{force:true,source:'owner_retry'});
  assert.equal(recovered.processed,true);
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Processed');
  assert.equal(h.messages.length,1);
});

test('integration surface remains scheduled, authenticated, manual-send only, and preserves BUILDER guardrails', async()=>{
  const cycle=await readFile(new URL('../netlify/functions/lead-dispatch-cycle.js',import.meta.url),'utf8');
  const endpoint=await readFile(new URL('../netlify/functions/lead-dispatch.js',import.meta.url),'utf8');
  const relay=await readFile(new URL('../src/relay-delivery.js',import.meta.url),'utf8');
  const builder=await readFile(new URL('../src/builder.js',import.meta.url),'utf8');
  const ghostos=await readFile(new URL('../src/ghostos.js',import.meta.url),'utf8');
  assert.match(cycle,/schedule: '\*\/2 \* \* \* \*'/);
  assert.match(endpoint,/x-ghostos-secret/);
  assert.match(endpoint,/owner_retry/);
  assert.match(ghostos,/When the real job Status is New Lead, you MUST make a concrete persisted next step/);
  assert.match(relay,/owner_phone_copy_paste/);
  assert.match(relay,/No external send occurred/);
  assert.match(builder,/branch === 'main'/);
  assert.match(builder,/High-Risk Confirmed/);
  assert.match(builder,/Ready for Owner Merge/);
});
