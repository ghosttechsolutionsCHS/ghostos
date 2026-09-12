import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const builderSource = await readFile(new URL('../src/builder.js', import.meta.url), 'utf8');
const functionSource = await readFile(new URL('../netlify/functions/builder.js', import.meta.url), 'utf8');
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

test('HIGH-risk changes require separate explicit owner confirmation', () => {
  assert.match(builderSource, /High-Risk Confirmed/);
  assert.match(builderSource, /confirmHighRisk/);
  assert.match(builderSource, /HIGH-risk owner confirmation required before branch creation/);
  assert.match(builderSource, /Sensitive files require HIGH-risk owner confirmation/);
  assert.match(functionSource, /confirm_high_risk/);
});

test('merge is blocked until fresh CI succeeds and explicit owner approval occurs', () => {
  assert.match(builderSource, /refreshProposalStatus\(requestId\)/);
  assert.match(builderSource, /CI Status.*Success/s);
  assert.match(builderSource, /Ready for Owner Merge/);
  assert.match(builderSource, /Owner Decision.*Approved to Merge/s);
  assert.match(builderSource, /\/pulls\/\$\{prNumber\}\/merge/);
  assert.match(functionSource, /approve_merge/);
});

test('BUILDER v2 creates PRs against main but never treats PR creation as merge approval', () => {
  assert.match(builderSource, /head: branch, base: 'main'/);
  assert.match(builderSource, /Owner Decision': 'Pending'/);
  assert.match(builderSource, /builder_pr_created/);
  assert.match(builderSource, /builder_owner_merge_approved/);
});

test('dashboard exposes mobile owner proposal controls and preserves manual RELAY flow', () => {
  assert.match(dashboardSource, /Build Proposal/);
  assert.match(dashboardSource, /Confirm HIGH RISK/);
  assert.match(dashboardSource, /Refresh Checks/);
  assert.match(dashboardSource, /Approve Build \/ Merge/);
  assert.match(dashboardSource, />Reject</);
  assert.match(dashboardSource, /Copy Message/);
  assert.match(dashboardSource, /Mark as Sent/);
  assert.doesNotMatch(dashboardSource, />Send<\/button>/);
  assert.match(dashboardSource, /@media\(max-width:760px\)/);
});
