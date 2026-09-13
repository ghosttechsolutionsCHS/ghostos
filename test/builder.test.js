import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const builderSource = await readFile(new URL('../src/builder.js', import.meta.url), 'utf8');
const improvementsSource = await readFile(new URL('../src/improvements.js', import.meta.url), 'utf8');
const functionSource = await readFile(new URL('../netlify/functions/builder.js', import.meta.url), 'utf8');
const scheduledSource = await readFile(new URL('../netlify/functions/builder-improvement-cycle.js', import.meta.url), 'utf8');
const dashboardSource = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');

test('BUILDER v2 hard-blocks direct writes to main and scopes writes to builder branches', () => {
  assert.match(builderSource, /branch === 'main'/);
  assert.match(builderSource, /startsWith\(PROPOSAL_PREFIX\)/);
  assert.match(builderSource, /write_proposal_file/);
  assert.match(builderSource, /branch \}/);
  assert.doesNotMatch(builderSource, /branch:\s*['"]main['"]/);
});

test('BUILDER v2 blocks secret paths, CI workflow mutation, and destructive SQL', () => {
  assert.match(builderSource, /SECRET_PATH/);
  assert.match(builderSource, /WORKFLOW_PATH/);
  assert.match(builderSource, /Potential destructive\/secret content blocked/);
  assert.match(builderSource, /DROP\\s\+TABLE/);
  assert.doesNotMatch(builderSource, /actions\/secrets|environments\/.*secrets/i);
});

test('HIGH-risk changes still require separate explicit owner confirmation', () => {
  assert.match(builderSource, /High-Risk Confirmed/);
  assert.match(builderSource, /confirmHighRisk/);
  assert.match(builderSource, /HIGH-risk owner confirmation required before branch creation/);
  assert.match(builderSource, /Sensitive files require HIGH-risk owner confirmation/);
  assert.match(functionSource, /confirm_high_risk/);
  assert.match(improvementsSource, /HIGH_RISK/);
  assert.match(improvementsSource, /security\|auth/);
  assert.match(improvementsSource, /payment\|refund\|purchase\|contract\|spend\|advertis/);
});

test('merge remains blocked until fresh CI succeeds and explicit owner approval occurs', () => {
  assert.match(builderSource, /refreshProposalStatus\(requestId\)/);
  assert.match(builderSource, /CI Status.*Success/s);
  assert.match(builderSource, /Ready for Owner Merge/);
  assert.match(builderSource, /Owner Decision.*Approved to Merge/s);
  assert.match(builderSource, /\/pulls\/\$\{prNumber\}\/merge/);
  assert.match(functionSource, /approve_merge/);
  assert.doesNotMatch(improvementsSource, /approveAndMergeProposal/);
});

test('BUILDER v3 caps and deduplicates autonomous suggestions', () => {
  assert.match(improvementsSource, /MAX_AUTONOMOUS_SUGGESTIONS_PER_DAY = 3/);
  assert.match(improvementsSource, /DEDUP_WINDOW_DAYS = 30/);
  assert.match(improvementsSource, /Suggestion Fingerprint/);
  assert.match(improvementsSource, /daily_cap/);
  assert.match(improvementsSource, /similarity/);
  assert.match(improvementsSource, /Rejected','Dismissed/);
});

test('v3 uses operations, controls, feedback and safe repository evidence', () => {
  assert.match(improvementsSource, /recentActivity/);
  assert.match(improvementsSource, /activeControls/);
  assert.match(improvementsSource, /repoSnapshot/);
  assert.match(improvementsSource, /SAFE_CODE_PATHS/);
  assert.match(improvementsSource, /SECRET_PATH/);
});

test('suggestions are ranked by business impact plus engineering value', () => {
  assert.match(improvementsSource, /impact \* 0\.65 \+ engineering \* 0\.35/);
  assert.match(improvementsSource, /Engineering Value Score/);
  assert.match(improvementsSource, /Suggestion Score/);
  assert.match(dashboardSource, /Business/);
  assert.match(dashboardSource, /Engineering/);
  assert.match(dashboardSource, /Suggestion Score/);
});

test('autonomous proposal creation is restricted to clearly LOW risk valuable work', () => {
  assert.match(improvementsSource, /f\.Risk === 'Low'/);
  assert.match(improvementsSource, /Impact Score.*>= 8/s);
  assert.match(improvementsSource, /Engineering Value Score.*>= 7/s);
  assert.match(improvementsSource, /Suggestion Score.*>= 8/s);
  assert.match(improvementsSource, /\['Small','Medium'\]/);
  assert.match(improvementsSource, /createBuildProposal\(id\)/);
  assert.doesNotMatch(improvementsSource, /confirmHighRisk/);
});

test('scheduled loop is periodic but has no merge authority', () => {
  assert.match(scheduledSource, /runImprovementCycle/);
  assert.match(scheduledSource, /schedule: '17 13 \* \* \*'/);
  assert.doesNotMatch(scheduledSource, /merge|approveAndMerge/i);
});

test('owner feedback is recorded and used by future suggestion suppression', () => {
  for (const outcome of ['Build Approved','Merge Approved','Merged','Rejected','Dismissed','Snoozed']) assert.match(improvementsSource, new RegExp(outcome));
  assert.match(functionSource, /recordSuggestionFeedback/);
  assert.match(functionSource, /dismiss/);
  assert.match(functionSource, /snooze/);
});

test('v3 dashboard exposes suggested improvement evidence, impact and owner controls', () => {
  assert.match(dashboardSource, /Suggested Improvements/);
  assert.match(dashboardSource, /Why GhostOS Suggested It/);
  assert.match(dashboardSource, /Expected Impact/);
  assert.match(dashboardSource, /Build Proposal/);
  assert.match(dashboardSource, /Dismiss/);
  assert.match(dashboardSource, /Snooze 7d/);
  assert.match(dashboardSource, /Confirm HIGH RISK/);
  assert.match(dashboardSource, /Approve Build \/ Merge/);
  assert.match(dashboardSource, /Copy Message/);
  assert.match(dashboardSource, /Mark as Sent/);
  assert.doesNotMatch(dashboardSource, />Send<\/button>/);
  assert.match(dashboardSource, /@media\(max-width:760px\)/);
});
