import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const growth = await readFile(new URL('../src/growth.js', import.meta.url), 'utf8');
const ghostos = await readFile(new URL('../src/ghostos.js', import.meta.url), 'utf8');
const airtable = await readFile(new URL('../src/airtable.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const builder = await readFile(new URL('../src/builder.js', import.meta.url), 'utf8');
const improvements = await readFile(new URL('../src/improvements.js', import.meta.url), 'utf8');

test('Growth Division defines all five agents with constrained authority', () => {
  for (const name of ['FORGE','ECHO','SCOUT','BEACON','HORIZON']) assert.match(growth, new RegExp(`name: '${name}'`));
  assert.match(growth, /NEVER increase spend, launch\/pause ads, alter budgets/);
  assert.match(growth, /Never autonomously publish/);
  assert.match(growth, /No spam, scraping-based blasts, mass unsolicited outreach/);
  assert.match(growth, /NEVER modify production directly or bypass BUILDER controls/);
  assert.match(growth, /Never negotiate, agree to terms, sign, or create a contract\/deal/);
});

test('FORGE uses completed-job economics rather than vanity metrics', () => {
  assert.match(growth, /completedJobs > 0 \? spend \/ completedJobs : null/);
  assert.match(growth, /profitAfterSpend = grossProfit - spend/);
  assert.match(growth, /Measure success by profitable completed jobs, never clicks\/impressions/);
});

test('growth work is review-only and consequential growth actions create owner approval', () => {
  assert.match(growth, /externalActionTaken: false/);
  assert.match(growth, /approvalType: z\.enum\(\['Ad Spend','Contract','Other'\]\)/);
  assert.match(growth, /createApproval\(/);
  assert.match(growth, /ownerApprovalRequired/);
  assert.doesNotMatch(growth, /messages\.create|campaigns\.create|publishPost|launchCampaign|updateBudget/);
});

test('BEACON can only route technical work into existing BUILDER workflow', () => {
  assert.match(growth, /queue_site_builder_request/);
  assert.match(growth, /createBuilderRequest/);
  assert.match(growth, /productionChanged: false/);
  assert.doesNotMatch(growth, /approveAndMergeProposal|merge_pull_request|\/merge/);
});

test('ATLAS manages all 11 agents and emits one executive summary', () => {
  for (const name of ['ATLAS','FORGE','ECHO','SCOUT','BEACON','RELAY','SUPPLY','DISPATCH','LEDGER','HORIZON','BUILDER']) assert.match(ghostos, new RegExp(name));
  assert.match(ghostos, /Do not emit separate noisy notifications/);
  for (const heading of ['EXECUTIVE_SUMMARY:','OPERATIONS:','GROWTH:','FINANCE:','OWNER_DECISIONS:','NEXT_ACTIONS:','CUSTOMER_DRAFT:']) assert.match(ghostos, new RegExp(heading));
});

test('dashboard exposes all 11 agents and Growth Division operating state', () => {
  for (const name of ['ATLAS','FORGE','ECHO','SCOUT','BEACON','RELAY','SUPPLY','DISPATCH','LEDGER','HORIZON','BUILDER']) assert.match(dashboard, new RegExp(name));
  for (const state of ['Working','Waiting','Needs Owner','Idle']) assert.match(dashboard, new RegExp(state));
  for (const label of ['Current Task','Latest Result','Next Action','Last Activity','Growth Division']) assert.match(dashboard, new RegExp(label));
  assert.match(dashboard, /Copy Message/);
  assert.match(dashboard, /Mark as Sent/);
  assert.match(dashboard, /Approve Build \/ Merge/);
  assert.match(dashboard, /@media\(max-width:760px\)/);
});

test('Airtable snapshot includes growth data without replacing existing operating tables', () => {
  for (const table of ["JOBS: 'Leads & Jobs'","BUILDER: 'Builder Requests'","MARKETING: 'Marketing Channels'","GROWTH: 'Growth Opportunities'","GROWTH_WORK: 'Growth Work'"]) assert.match(airtable, new RegExp(table.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(airtable, /agentNames = \['ATLAS','FORGE','ECHO','SCOUT','BEACON','RELAY','SUPPLY','DISPATCH','LEDGER','HORIZON','BUILDER'\]/);
});

test('BUILDER v2/v3 core guardrails remain present and Growth Division cannot merge code', () => {
  assert.match(builder, /branch === 'main'/);
  assert.match(builder, /High-Risk Confirmed/);
  assert.match(builder, /Ready for Owner Merge/);
  assert.match(builder, /CI Status.*Success/s);
  assert.match(improvements, /MAX_AUTONOMOUS_SUGGESTIONS_PER_DAY = 3/);
  assert.match(improvements, /DEDUP_WINDOW_DAYS = 30/);
  assert.doesNotMatch(growth, /approveAndMergeProposal|confirmHighRisk|refreshProposalStatus/);
});
