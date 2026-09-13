import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAttentionQueue } from '../src/operations.js';

const operations = await readFile(new URL('../src/operations.js', import.meta.url), 'utf8');
const daily = await readFile(new URL('../src/daily-ops.js', import.meta.url), 'utf8');
const ghostos = await readFile(new URL('../src/ghostos.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const builder = await readFile(new URL('../src/builder.js', import.meta.url), 'utf8');
const relay = await readFile(new URL('../src/relay-delivery.js', import.meta.url), 'utf8');
const netlify = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');

function r(id, fields = {}) { return { id, fields }; }

test('live attention queue ranks owner decisions and urgent leads above routine growth work and deduplicates sources', () => {
  const queue = buildAttentionQueue({
    jobs:[r('job1',{'Job / Customer':'Urgent phone','Status':'New Lead'}),r('job2',{'Job / Customer':'Quoted laptop','Status':'Quoted'})],
    approvals:[r('ap1',{Status:'Pending',Approval:'Purchase approval',Summary:'Part required','Requested Action':'Approve part','Requested By':'SUPPLY',Job:['job2']})],
    messages:[r('msg1',{Status:'Pending',Job:['job1'],'Customer Reference':'Lead'})],
    growthWork:[r('g1',{Agent:'ECHO',Status:'Ready for Owner','Growth Item':'Post draft','Latest Result':'Draft ready'})],
  });
  assert.equal(queue[0].source, 'Owner Inbox');
  assert.equal(queue[0].ownerRequired, true);
  assert.ok(queue.some(i => i.agent === 'RELAY' && i.jobId === 'job1'));
  assert.ok(queue.findIndex(i => i.source === 'Growth Work') > queue.findIndex(i => i.source === 'Owner Inbox'));
  assert.equal(new Set(queue.map(i => i.key)).size, queue.length);
});

test('Daily Operations includes one morning brief, one night closeout and no per-agent notification fanout', () => {
  assert.match(ghostos, /Morning Company Brief/);
  assert.match(ghostos, /Night Closeout/);
  assert.match(ghostos, /Do not create separate per-agent notifications/);
  assert.match(daily, /attentionQueue/);
  assert.match(daily, /jobsNeedingAction/);
  assert.match(daily, /appointmentsToday/);
  assert.match(daily, /grossProfitCompleted/);
  assert.match(daily, /builderAttention/);
  assert.match(daily, /ownerDecisions/);
});

test('physical repair owner actions record stages, timestamps and downstream states', () => {
  for (const value of ['Device Picked Up','Repair Started','Repair Finished','Customer Picked Up']) assert.match(operations, new RegExp(value));
  for (const value of ['Device Picked Up At','Repair Started At','Repair Finished At','Customer Picked Up At']) assert.match(operations, new RegExp(value));
  assert.match(operations, /RELAY Next Action/);
  assert.match(operations, /customer_picked_up/);
  assert.match(operations, /Status='Completed'|return 'Completed'/);
});

test('Collected Payment supports only Jim and Cash, updates revenue and cash, and never uses Square', () => {
  assert.match(operations, /\['Jim','Cash'\]\.includes\(paymentMethod\)/);
  assert.match(operations, /'Revenue Collected'=previous\+value|fields\['Revenue Collected'\]=previous\+value/);
  assert.match(operations, /TABLES\.CASH/);
  assert.match(operations, /'Money In':value/);
  assert.doesNotMatch(operations, /paymentMethod.*Square|Square.*paymentMethod/);
});

test('dashboard exposes Daily Operations views, queue fields and six owner repair actions', () => {
  for (const label of ['Today','What Needs Attention Now','Morning Brief','Night Closeout','Owner Decisions','Picked Up Device','Started Repair','Finished Repair','Collected Payment','Customer Picked Up','Add Note']) assert.match(dashboard,new RegExp(label));
  for (const label of ['Priority','Agent','Action Needed','Why It Matters','Due','Owner?']) assert.match(dashboard,new RegExp(label.replace('?','\\?')));
  assert.match(dashboard,/Draft → Edit → Copy Message → you send → Mark as Sent/);
  assert.match(dashboard,/Payment method must be exactly Jim or Cash/);
});

test('Daily Operations is additive and routed without changing RELAY manual-send or BUILDER approval boundaries', () => {
  assert.match(netlify,/\/api\/daily-ops/);
  assert.match(netlify,/\/api\/job-action/);
  assert.match(relay,/owner_phone_copy_paste/);
  assert.match(relay,/Manual Sent At/);
  assert.match(builder,/branch === 'main'/);
  assert.match(builder,/High-Risk Confirmed/);
  assert.match(builder,/Ready for Owner Merge/);
  assert.match(builder,/CI Status.*Success/s);
  assert.doesNotMatch(operations,/approveAndMergeProposal|mergePullRequest|merge_pull_request/);
});
