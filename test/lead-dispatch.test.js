import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLeadDispatcher } from '../src/lead-dispatch.js';
import { TABLES } from '../src/airtable.js';

function memoryHarness({ jobFields = {}, failFirst = false } = {}) {
  const jobs = new Map([['job1',{ id:'job1', fields:{ 'Job / Customer':'Test lead', CustomerName:'Test', Phone:'8435550100', Status:'New Lead', ...jobFields } }]]);
  const messages=[];
  const activity=[];
  let processorCalls=0;
  let shouldFail=failFirst;
  const now=()=>new Date(1_800_000_000_000 + activity.length*1000).toISOString();
  const logActivity=async(e)=>{activity.push({...e,fields:{Agent:e.agent,'Action Type':e.actionType,Status:e.status||'Done',Detail:e.detail,'Created At':now()}});};
  const updateRecord=async(table,id,fields)=>{assert.equal(table,TABLES.JOBS);const row=jobs.get(id);Object.assign(row.fields,fields);return row;};
  const createRelayDraft=async({jobId,message,messageType,channel})=>{
    const existing=messages.find(m=>m.fields.Job.includes(jobId)&&m.fields.Body===message&&m.fields['Message Type']===messageType);
    if(existing)return existing;
    const row={id:`msg${messages.length+1}`,fields:{Job:[jobId],Body:message,'Message Type':messageType,Channel:channel,Status:'Pending'}};
    messages.push(row);
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
    getRecord:async(table,id)=>{assert.equal(table,TABLES.JOBS);return jobs.get(id);},
    listRecords:async(table)=>table===TABLES.JOBS?[...jobs.values()]:table===TABLES.MESSAGES?messages:[],
    updateRecord,logActivity,createRelayDraft,processLead,now,
  };
  return { jobs,messages,activity,deps,get processorCalls(){return processorCalls;} };
}

test('reproduces production failure and fixes it: visible New Lead is actually dispatched through ATLAS/RELAY', async()=>{
  const h=memoryHarness();
  assert.equal(h.jobs.get('job1').fields.Status,'New Lead');
  assert.equal(h.messages.length,0);
  assert.equal(h.activity.length,0);

  const result=await createLeadDispatcher(h.deps).runCycle({maxLeads:5});
  assert.equal(result.candidates,1);
  assert.equal(h.processorCalls,1);
  assert.equal(h.messages.length,1);
  assert.equal(h.messages[0].fields.Status,'Pending');
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Processed');
  assert.match(h.jobs.get('job1').fields['RELAY Reply Draft'],/quick question/);
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_started'&&a.status==='Running'));
  assert.ok(h.activity.some(a=>a.actionType==='customer_message_drafted'&&a.agent==='RELAY'));
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_completed'&&a.agent==='ATLAS'));

  await createLeadDispatcher(h.deps).runCycle({maxLeads:5});
  assert.equal(h.processorCalls,1,'processed lead must not run the agent twice');
  assert.equal(h.messages.length,1,'retry/refresh must not create a duplicate draft');
});

test('backfills current production shape: existing RELAY Reply Draft but zero message ledger rows', async()=>{
  const h=memoryHarness({jobFields:{'RELAY Reply Draft':'Existing triage text','RELAY State':'Need More Info'}});
  const result=await createLeadDispatcher(h.deps).dispatchLead('job1',{source:'scheduled_dispatcher'});
  assert.equal(result.reconciled,true);
  assert.equal(h.processorCalls,0,'existing triage text should be recovered, not regenerated');
  assert.equal(h.messages.length,1);
  assert.equal(h.messages[0].fields.Body,'Existing triage text');
  assert.ok(h.activity.some(a=>a.actionType==='customer_message_draft_recovered'));
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Processed');

  await createLeadDispatcher(h.deps).dispatchLead('job1',{force:true,source:'owner_retry'});
  assert.equal(h.messages.length,1,'explicit retry is idempotent when result already exists');
});

test('failed automatic processing is recorded and explicit owner retry can recover safely', async()=>{
  const h=memoryHarness({failFirst:true});
  await assert.rejects(()=>createLeadDispatcher(h.deps).dispatchLead('job1',{source:'scheduled_dispatcher'}),/simulated agent failure/);
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Failed');
  assert.match(h.jobs.get('job1').fields['GhostOS Dispatch Error'],/simulated/);
  assert.ok(h.activity.some(a=>a.actionType==='lead_dispatch_failed'));

  const recovered=await createLeadDispatcher(h.deps).dispatchLead('job1',{force:true,source:'owner_retry'});
  assert.equal(recovered.processed,true);
  assert.equal(h.jobs.get('job1').fields['GhostOS Dispatch Status'],'Processed');
  assert.equal(h.messages.length,1);
});

test('integration surface is scheduled, authenticated, manual-send only, and preserves BUILDER guardrails', async()=>{
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
