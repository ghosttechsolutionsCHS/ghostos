import { TABLES, createRecord, getRecord, logActivity, updateRecord } from './airtable.js';
import { assertTransition } from './state-machine.js';

const TZ = 'America/New_York';
const ACTIVE_JOB_STATES = new Set(['New Lead','Need Quote','Quoted','Awaiting Customer','Part Approval','Part Ordered','Scheduled','In Progress']);
const CLOSED_BUILDER_STATES = new Set(['Done','Rejected']);

function n(value) { const x = Number(value); return Number.isFinite(x) ? x : 0; }
function when(value) { const t = value ? new Date(value).getTime() : NaN; return Number.isFinite(t) ? t : null; }
function localDate(value = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(value); }
function label(record, fallback) { return record?.fields?.['Job / Customer'] || record?.fields?.Opportunity || record?.fields?.['Growth Item'] || record?.fields?.Request || fallback; }
function dueScore(value, now = Date.now()) {
  const t = when(value); if (!t) return 0;
  const delta = t - now;
  if (delta < 0) return 45;
  if (delta <= 3 * 60 * 60 * 1000) return 35;
  if (localDate(new Date(t)) === localDate(new Date(now))) return 25;
  if (delta <= 24 * 60 * 60 * 1000) return 15;
  return 0;
}
function priority(score) { return score >= 90 ? 'Critical' : score >= 70 ? 'High' : score >= 45 ? 'Normal' : 'Low'; }

export function buildAttentionQueue({ jobs = [], parts = [], quotes = [], approvals = [], messages = [], builderRequests = [], growthWork = [], growthOpportunities = [], marketing = [] }, now = Date.now()) {
  const items = [];
  const add = (item) => items.push({ ...item, score: Math.max(0, Math.min(120, item.score || 0)) });
  const jobsById = new Map(jobs.map((r) => [r.id, r]));

  for (const a of approvals.filter((r) => r.fields.Status === 'Pending')) {
    const jobId = Array.isArray(a.fields.Job) ? a.fields.Job[0] : null;
    add({ key:`approval:${a.id}`, score:105, agent:a.fields['Requested By'] || 'ATLAS', subject:jobId ? label(jobsById.get(jobId), jobId) : (a.fields.Approval || a.fields.Type || 'Owner decision'), action:a.fields['Requested Action'] || 'Review and decide', why:a.fields.Summary || 'A consequential action is blocked on owner approval.', due:a.fields['Created At'] || null, ownerRequired:true, source:'Owner Inbox', recordId:a.id, jobId });
  }

  for (const j of jobs) {
    const f = j.fields || {}; if (!ACTIVE_JOB_STATES.has(f.Status)) continue;
    const subject = label(j, j.id); let score = 35; let agent = 'ATLAS'; let action = f['RELAY Next Action'] || 'Review job and set the next concrete action.'; let why = `Job is ${f.Status}.`; let due = f['Follow-Up Due'] || f.Appointment || null;
    if (f.Status === 'New Lead') { score=92; agent='RELAY'; action='Triage lead and prepare the next customer draft/quote step.'; why='New lead has not been worked yet.'; }
    else if (f.Status === 'Need Quote') { score=82; agent='LEDGER'; action='Complete economics/quote inputs and prepare the quote.'; why='Customer cannot move forward until pricing is ready.'; }
    else if (['Quoted','Awaiting Customer'].includes(f.Status)) { score=55; agent='RELAY'; action=f['RELAY Next Action'] || 'Review whether customer follow-up is due and prepare a draft if needed.'; why='Quoted job is waiting on customer movement.'; }
    else if (f.Status === 'Part Approval') { score=80; agent='SUPPLY'; action='Resolve the part/purchase blocker through the existing approval workflow.'; why='Job is blocked on a part decision.'; }
    else if (f.Status === 'Part Ordered') { score=58; agent='DISPATCH'; action='Confirm part arrival/ETA and prepare scheduling.'; why='Job cannot progress until part logistics are ready.'; }
    else if (f.Status === 'Scheduled') { score=70; agent='DISPATCH'; action='Prepare for the scheduled appointment/device handoff.'; why='Scheduled work has a time-sensitive commitment.'; }
    else if (f.Status === 'In Progress') { score=72; agent='DISPATCH'; action=f['Repair Stage']==='Repair Finished' ? 'Collect payment and complete customer pickup.' : 'Continue the physical repair workflow to the next stage.'; why='Device is actively in Ghost Tech custody/workflow.'; }
    score += dueScore(due, now);
    add({ key:`job:${j.id}:${agent}:${f.Status}`, score, agent, subject, action, why, due, ownerRequired:false, source:'Job', recordId:j.id, jobId:j.id });
  }

  for (const m of messages.filter((r) => ['Pending','Failed','Blocked'].includes(r.fields.Status))) {
    const jobId = Array.isArray(m.fields.Job) ? m.fields.Job[0] : null;
    const job = jobId ? jobsById.get(jobId) : null;
    add({ key:`relay:${jobId || m.id}`, score: job?.fields?.Status === 'New Lead' ? 88 : 62, agent:'RELAY', subject:job ? label(job, jobId) : (m.fields['Customer Reference'] || 'Customer draft'), action:'Review/edit the draft, tap Copy, send it personally, then Mark as Sent.', why:'RELAY has a customer message draft waiting for the owner’s manual send workflow.', due:job?.fields?.['Follow-Up Due'] || m.fields['Created At'] || null, ownerRequired:true, source:'RELAY Messages', recordId:m.id, jobId });
  }

  for (const p of parts) {
    const f=p.fields||{}; const jobId=Array.isArray(f.Job)?f.Job[0]:null;
    if (!jobId || !jobsById.has(jobId)) continue;
    if (['Approval Needed','Researching'].includes(f['Purchase Status']) || f['Research Status']==='Unverified') {
      add({ key:`part:${jobId}`, score:f['Purchase Status']==='Approval Needed'?78:60, agent:'SUPPLY', subject:label(jobsById.get(jobId), jobId), action:f['Purchase Status']==='Approval Needed'?'Review the recommended part and existing owner approval requirement.':'Finish/verify part research before quoting or repair.', why:'A parts issue is blocking or weakening job readiness.', due:f.ETA || null, ownerRequired:f['Purchase Status']==='Approval Needed', source:'Parts', recordId:p.id, jobId });
    }
  }

  for (const q of quotes) {
    const f=q.fields||{}; const jobId=Array.isArray(f.Job)?f.Job[0]:null; const job=jobId?jobsById.get(jobId):null;
    if (!job || ['Completed','Lost / Declined'].includes(job.fields.Status)) continue;
    if (['Draft','Pending','Approved'].includes(f.Status) || job.fields.Status==='Quoted') add({ key:`quote:${jobId}`, score:58+dueScore(job.fields['Follow-Up Due'],now), agent:'RELAY', subject:label(job,jobId), action:'Check quote follow-up timing and prepare the next customer draft if due.', why:'An open quote has not yet converted to a completed job.', due:job.fields['Follow-Up Due'] || f['Created At'] || null, ownerRequired:false, source:'Quotes', recordId:q.id, jobId });
  }

  for (const w of growthWork.filter((r)=>['Draft','Ready for Owner','Needs Owner'].includes(r.fields.Status))) {
    const f=w.fields||{}; const needs=f.Status==='Needs Owner' || Boolean(f['Owner Approval Required']);
    add({ key:`growth:${w.id}`, score:needs?72:38, agent:f.Agent || 'ATLAS', subject:f['Growth Item'] || w.id, action:f['Next Action'] || (needs?'Review the growth recommendation and decide.':'Review the growth draft when operational work is clear.'), why:f['Latest Result'] || 'Growth Division work is waiting for review/action.', due:null, ownerRequired:needs, source:'Growth Work', recordId:w.id });
  }

  for (const b of builderRequests.filter((r)=>!CLOSED_BUILDER_STATES.has(r.fields.Status))) {
    const f=b.fields||{}; const needsOwner=['Ready for Owner','Ready for Owner Merge','Awaiting Owner'].includes(f['Build Status']) || ['Build Approved','Merge Approved'].includes(f['Owner Decision']);
    const blocked=f['CI Status']==='Failed' || Boolean(f['Failure Reason']);
    if (needsOwner || blocked) add({ key:`builder:${b.id}`, score:needsOwner?76:66, agent:'BUILDER', subject:f.Request || b.id, action:needsOwner?'Review the Builder proposal/status and take the explicit owner action if appropriate.':'Resolve the failed/blocked Builder proposal before it can progress.', why:blocked?(f['Failure Reason']||'Builder validation is blocked.'):'A Builder proposal is waiting at an owner-controlled boundary.', due:f['Updated At'] || null, ownerRequired:needsOwner, source:'Builder', recordId:b.id });
  }

  for (const o of growthOpportunities.filter((r)=>!['Completed','Dismissed','Rejected'].includes(r.fields.Status))) {
    if (!o.fields['Recommended Action']) continue;
    add({ key:`opportunity:${o.id}`, score:30, agent:'HORIZON', subject:o.fields.Opportunity || o.id, action:o.fields['Recommended Action'], why:'A stored growth opportunity has a recommended next step.', due:null, ownerRequired:false, source:'Growth Opportunity', recordId:o.id });
  }

  for (const c of marketing) {
    if (!c.fields['Next Action']) continue;
    add({ key:`marketing:${c.id}`, score:35, agent:'FORGE', subject:c.fields['Channel / Campaign'] || c.id, action:c.fields['Next Action'], why:'Stored marketing performance has an outstanding optimization action.', due:null, ownerRequired:false, source:'Marketing', recordId:c.id });
  }

  const best = new Map();
  for (const item of items) { const existing=best.get(item.key); if (!existing || item.score>existing.score) best.set(item.key,item); }
  return [...best.values()].map((item)=>({ ...item, priority:priority(item.score) })).sort((a,b)=>b.score-a.score || ((when(a.due)||Infinity)-(when(b.due)||Infinity))).slice(0,60);
}

export function todayLocalISO() { return localDate(new Date()); }

const ACTIONS = Object.freeze({
  picked_up: { stage:'Device Picked Up', stamp:'Device Picked Up At', activity:'device_picked_up' },
  started_repair: { stage:'Repair Started', stamp:'Repair Started At', activity:'repair_started' },
  finished_repair: { stage:'Repair Finished', stamp:'Repair Finished At', activity:'repair_finished' },
  customer_picked_up: { stage:'Customer Picked Up', stamp:'Customer Picked Up At', activity:'customer_picked_up' },
});

function progressionTarget(status, action) {
  if (action === 'started_repair' || action === 'picked_up') {
    if (['Scheduled','Part Ordered'].includes(status)) return 'In Progress';
  }
  if (action === 'customer_picked_up' && status === 'In Progress') return 'Completed';
  return status;
}

export async function applyOwnerJobAction({ jobId, action, note = '', amount, paymentMethod }) {
  const job = await getRecord(TABLES.JOBS, jobId); const now = new Date().toISOString(); const fields = {};
  if (ACTIONS[action]) {
    const cfg=ACTIONS[action]; fields['Repair Stage']=cfg.stage; fields[cfg.stamp]=now;
    const target=progressionTarget(job.fields.Status, action); if (target !== job.fields.Status) { assertTransition(job.fields.Status,target); fields.Status=target; }
    if (action === 'picked_up') { fields['RELAY State']='Scheduled'; fields['RELAY Next Action']='Device is in Ghost Tech custody. Start repair when ready and keep the physical workflow updated.'; }
    if (action === 'started_repair') { fields['RELAY State']='Scheduled'; fields['RELAY Next Action']='Repair is in progress. Finish repair, collect payment, then complete customer pickup.'; }
    if (action === 'finished_repair') { fields['RELAY State']='Awaiting Customer'; fields['RELAY Next Action']='Repair is finished. Prepare a pickup/payment customer draft if needed; owner sends it manually.'; }
    if (action === 'customer_picked_up') { fields['RELAY State']='Closed'; fields['RELAY Next Action']='Job physically completed and customer picked up the device.'; }
    if (note) fields.Notes=[job.fields.Notes,note].filter(Boolean).join('\n\n').slice(0,90000);
    const updated=await updateRecord(TABLES.JOBS,jobId,fields);
    await logActivity({ agent:'ATLAS', jobId, actionType:cfg.activity, status:'Done', detail:`Owner action: ${cfg.stage}${note?` — ${note}`:''}` });
    return { job:updated, action, downstreamStateUpdated:true };
  }

  if (action === 'collected_payment') {
    const value=n(amount); if (!(value>0)) throw new Error('Payment amount must be greater than 0');
    if (!['Jim','Cash'].includes(paymentMethod)) throw new Error('Payment method must be Jim or Cash');
    const previous=n(job.fields['Revenue Collected']);
    fields['Revenue Collected']=previous+value; fields['Manual Payment Method']=paymentMethod; fields['Payment Collected At']=now; fields['Repair Stage']='Payment Collected';
    fields['RELAY Next Action']=job.fields['Repair Stage']==='Repair Finished'?'Payment collected. Complete customer pickup when the device is handed back.':'Payment collected. Continue the remaining physical workflow.';
    if (note) fields.Notes=[job.fields.Notes,note].filter(Boolean).join('\n\n').slice(0,90000);
    const updated=await updateRecord(TABLES.JOBS,jobId,fields);
    await createRecord(TABLES.CASH,{ 'Transaction / Entry':`Job payment — ${label(job,jobId)}`.slice(0,250), Date:todayLocalISO(), Type:'Customer Payment', 'Money In':value, 'Money Out':0, 'Payment Method':paymentMethod, 'Storefront Eligible':true, Notes:`Owner-recorded payment for job ${jobId}. Daily Operations does not use Square.${note?` ${note}`:''}` });
    await logActivity({ agent:'LEDGER', jobId, actionType:'payment_collected', status:'Done', detail:`Owner recorded ${value.toFixed(2)} via ${paymentMethod}. Revenue and cash ledger updated.` });
    return { job:updated, action, amount:value, paymentMethod, downstreamStateUpdated:true };
  }

  if (action === 'add_note') {
    if (!String(note||'').trim()) throw new Error('Note is required');
    const updated=await updateRecord(TABLES.JOBS,jobId,{ Notes:[job.fields.Notes,String(note).trim()].filter(Boolean).join('\n\n').slice(0,90000) });
    await logActivity({ agent:'ATLAS', jobId, actionType:'owner_note_added', status:'Done', detail:String(note).slice(0,5000) });
    return { job:updated, action, downstreamStateUpdated:false };
  }
  throw new Error('Unsupported owner job action');
}
