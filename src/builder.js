import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { TABLES, createRecord, getRecord, logActivity, updateRecord } from './airtable.js';

const MODEL = process.env.GHOSTOS_MODEL || 'gpt-5.6-sol';
const DEFAULT_REPO = 'ghosttechsolutionsCHS/ghostos';
const PROPOSAL_PREFIX = 'builder/';
const SECRET_PATH = /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|private[-_]?key|token).*)/i;
const WORKFLOW_PATH = /^\.github\/workflows\//i;
const HIGH_RISK_PATH = /^(netlify\.toml|src\/builder\.js|src\/airtable\.js|src\/ghostos\.js|src\/tools\.js|netlify\/functions\/(?:approval|builder|ghostos)\.js|public\/dashboard\.html)$/i;
const HIGH_RISK_TEXT = /\b(auth(?:entication|orization)?|security|secret|password|token|permission|owner approval|payment|refund|purchase|contract|spend|advertis|delete|drop table|migration|destructive)\b/i;
const FORBIDDEN_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE)\b)/i;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
function repoName() { return process.env.GHOSTOS_GITHUB_REPO || DEFAULT_REPO; }
function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
function cleanPath(path) {
  const value = String(path || '').replace(/^\/+/, '');
  if (!value || value.includes('..') || value.includes('\\') || SECRET_PATH.test(value)) throw new Error('Repository path is not allowed');
  return value;
}
function assertProposalBranch(branch) {
  if (!branch || branch === 'main' || !branch.startsWith(PROPOSAL_PREFIX)) throw new Error('BUILDER writes are restricted to builder/* proposal branches');
}
function requestNeedsHighRisk(fields = {}) {
  return fields.Risk === 'High' || HIGH_RISK_TEXT.test(`${fields.Goal || ''}\n${fields.Context || ''}\n${fields['Implementation Plan'] || ''}\n${fields['Files Affected'] || ''}`);
}
function safeDetail(value) { return String(value || '').replace(/gh[opsu]_[A-Za-z0-9_]+/g, '[REDACTED]').slice(0, 20000); }

async function github(path, { method = 'GET', body } = {}) {
  const token = requireEnv('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${repoName()}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28', 'user-agent': 'GhostOS-BUILDER',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`GitHub operation failed (${response.status}): ${safeDetail(data?.message || 'unknown error')}`);
  return data;
}

export async function createBuilderRequest({ goal, context = '', priority = 'Normal', requestedBy = 'Owner' }) {
  const now = new Date().toISOString();
  const request = await createRecord(TABLES.BUILDER, {
    Request: String(goal).slice(0, 250), Status: 'Queued', Priority: priority, 'Requested By': requestedBy,
    Goal: String(goal), Context: String(context || ''), 'Build Status': 'Not Started', 'CI Status': 'Not Run',
    'Owner Decision': 'Pending', 'Created At': now, 'Updated At': now,
  });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_request_created', detail: `Builder request ${request.id}: ${String(goal).slice(0, 300)}` });
  return request;
}

const getRequestTool = tool({
  name: 'get_builder_request', description: 'Read the current Builder Request from Airtable.',
  parameters: z.object({ requestId: z.string().min(1) }),
  async execute({ requestId }) { return getRecord(TABLES.BUILDER, requestId); },
});
const listRepoFilesTool = tool({
  name: 'list_repo_files', description: 'List non-secret repository files from main. Read-only.', parameters: z.object({}),
  async execute() {
    const branch = await github('/branches/main');
    const tree = await github(`/git/trees/${branch.commit.sha}?recursive=1`);
    return (tree.tree || []).filter((i) => i.type === 'blob' && !SECRET_PATH.test(i.path)).map((i) => ({ path: i.path, size: i.size })).slice(0, 1500);
  },
});
const readRepoFileTool = tool({
  name: 'read_repo_file', description: 'Read one non-secret UTF-8 repository file from main.',
  parameters: z.object({ path: z.string().min(1).max(500) }),
  async execute({ path }) {
    const safe = cleanPath(path); const data = await github(`/contents/${encodePath(safe)}?ref=main`);
    if (data.type !== 'file' || !data.content) throw new Error('Path is not a readable file');
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    return text.length > 120000 ? `${text.slice(0, 120000)}\n...[truncated]` : text;
  },
});
const savePlanTool = tool({
  name: 'save_builder_plan', description: 'Save grounded implementation plan/risk. Does not modify GitHub.',
  parameters: z.object({ requestId: z.string().min(1), implementationPlan: z.string().min(1).max(50000), risk: z.enum(['Low','Medium','High']), filesAffected: z.string().min(1).max(20000), verificationPlan: z.string().min(1).max(30000), result: z.string().max(30000).optional() }),
  async execute(args) {
    const current = await getRecord(TABLES.BUILDER, args.requestId);
    const forcedHigh = requestNeedsHighRisk({ ...current.fields, Risk: args.risk, 'Implementation Plan': args.implementationPlan, 'Files Affected': args.filesAffected });
    const risk = forcedHigh ? 'High' : args.risk;
    return updateRecord(TABLES.BUILDER, args.requestId, {
      Status: 'Planned', 'Implementation Plan': args.implementationPlan, Risk: risk, 'Files Affected': args.filesAffected,
      'Verification Plan': args.verificationPlan, Result: args.result || 'Plan prepared. Owner may choose Build Proposal.',
      'Build Status': risk === 'High' ? 'Awaiting High-Risk Confirmation' : 'Not Started', 'Updated At': new Date().toISOString(),
    });
  },
});

export const builderAgent = new Agent({
  name: 'BUILDER', model: MODEL,
  instructions: `You are BUILDER for GhostOS. Inspect current main and make a precise engineering plan. Never request/read secrets. Mark HIGH RISK for security/authentication, payments, spending, owner permissions, secrets, destructive data operations, migrations, contracts/purchases, or changes that could weaken approval controls. Never propose deleting Airtable tables/data automatically. Always save a grounded plan with exact likely files and verification steps.`,
  tools: [getRequestTool, listRepoFilesTool, readRepoFileTool, savePlanTool],
});

function executionTools(requestId) {
  const readBranchFile = tool({
    name: 'read_proposal_file', description: 'Read a non-secret UTF-8 file from this request proposal branch.',
    parameters: z.object({ path: z.string().min(1).max(500) }),
    async execute({ path }) {
      const req = await getRecord(TABLES.BUILDER, requestId); const branch = req.fields.Branch; assertProposalBranch(branch);
      const safe = cleanPath(path); const data = await github(`/contents/${encodePath(safe)}?ref=${encodeURIComponent(branch)}`);
      if (data.type !== 'file' || !data.content) throw new Error('Path is not readable');
      return Buffer.from(data.content, 'base64').toString('utf8').slice(0, 160000);
    },
  });
  const writeBranchFile = tool({
    name: 'write_proposal_file', description: 'Create or replace one UTF-8 file ONLY on this builder proposal branch. Never main.',
    parameters: z.object({ path: z.string().min(1).max(500), content: z.string().max(180000), reason: z.string().min(1).max(1000) }),
    async execute({ path, content, reason }) {
      const req = await getRecord(TABLES.BUILDER, requestId); const branch = req.fields.Branch; assertProposalBranch(branch);
      const safe = cleanPath(path);
      if (WORKFLOW_PATH.test(safe)) throw new Error('BUILDER v2 may not modify CI workflow files');
      if (FORBIDDEN_CONTENT.test(content)) throw new Error('Potential destructive/secret content blocked');
      if ((HIGH_RISK_PATH.test(safe) || HIGH_RISK_TEXT.test(`${reason}\n${content.slice(0, 20000)}`)) && !(req.fields.Risk === 'High' && req.fields['High-Risk Confirmed'])) {
        throw new Error('Sensitive change requires HIGH risk classification and separate owner confirmation');
      }
      let existing = null;
      try { existing = await github(`/contents/${encodePath(safe)}?ref=${encodeURIComponent(branch)}`); } catch (e) { if (!/404/.test(e.message)) throw e; }
      const body = { message: `BUILDER proposal: ${safe}`, content: Buffer.from(content, 'utf8').toString('base64'), branch };
      if (existing?.sha) body.sha = existing.sha;
      const result = await github(`/contents/${encodePath(safe)}`, { method: 'PUT', body });
      await updateRecord(TABLES.BUILDER, requestId, { 'Proposed Commit': result.commit?.sha || '', 'Updated At': new Date().toISOString() });
      await logActivity({ agent: 'BUILDER', actionType: 'builder_branch_file_written', status: 'Running', detail: `${requestId} ${branch} ${safe}` });
      return { path: safe, commit: result.commit?.sha };
    },
  });
  const finishTool = tool({
    name: 'finish_build_proposal', description: 'Save summary after all proposal branch edits are complete. Does not merge.',
    parameters: z.object({ summary: z.string().min(1).max(30000) }),
    async execute({ summary }) {
      return updateRecord(TABLES.BUILDER, requestId, { 'Build Summary': summary, 'Build Status': 'Writing Changes', 'Updated At': new Date().toISOString() });
    },
  });
  return [getRequestTool, readBranchFile, writeBranchFile, finishTool];
}

export async function analyzeBuilderRequest(requestId) {
  requireEnv('OPENAI_API_KEY'); requireEnv('AIRTABLE_PAT'); requireEnv('AIRTABLE_BASE_ID'); requireEnv('GITHUB_TOKEN');
  const current = await getRecord(TABLES.BUILDER, requestId);
  if (['Done','Rejected'].includes(current.fields.Status)) throw new Error(`Builder request is already ${current.fields.Status}`);
  await updateRecord(TABLES.BUILDER, requestId, { Status: 'Analyzing', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_analysis_started', status: 'Running', detail: `Analyzing ${requestId}` });
  try {
    await run(builderAgent, `Analyze Builder Request ${requestId}. Inspect current main and save the implementation plan.`, { maxTurns: 18 });
    await logActivity({ agent: 'BUILDER', actionType: 'builder_analysis_completed', detail: `Plan saved for ${requestId}` });
    return getRecord(TABLES.BUILDER, requestId);
  } catch (error) {
    await updateRecord(TABLES.BUILDER, requestId, { Status: 'Blocked', 'Build Status': 'Failed', 'Failure Reason': safeDetail(error?.message || error), 'Updated At': new Date().toISOString() });
    await logActivity({ agent: 'BUILDER', actionType: 'builder_analysis_failed', status: 'Error', detail: safeDetail(error?.message || error) }); throw error;
  }
}

export async function confirmHighRisk(requestId) {
  const request = await getRecord(TABLES.BUILDER, requestId);
  if (request.fields.Risk !== 'High') throw new Error('High-risk confirmation is only valid for HIGH-risk requests');
  const updated = await updateRecord(TABLES.BUILDER, requestId, { 'High-Risk Confirmed': true, 'Build Status': 'Not Started', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_high_risk_confirmed', detail: `Owner separately confirmed HIGH-risk request ${requestId}`, consequential: true });
  return updated;
}

export async function createBuildProposal(requestId) {
  requireEnv('OPENAI_API_KEY'); requireEnv('GITHUB_TOKEN');
  const request = await getRecord(TABLES.BUILDER, requestId);
  if (!['Planned','Ready for Build','Blocked'].includes(request.fields.Status)) throw new Error('Request must be analyzed before Build Proposal');
  if (request.fields.Branch || request.fields['PR Number']) throw new Error('A proposal already exists for this request');
  if (requestNeedsHighRisk(request.fields) && !(request.fields.Risk === 'High' && request.fields['High-Risk Confirmed'])) {
    await updateRecord(TABLES.BUILDER, requestId, { Risk: 'High', 'Build Status': 'Awaiting High-Risk Confirmation', 'Updated At': new Date().toISOString() });
    return { blocked: true, reason: 'HIGH-risk owner confirmation required before branch creation' };
  }
  const main = await github('/git/ref/heads/main');
  const branch = `${PROPOSAL_PREFIX}${requestId.replace(/[^A-Za-z0-9]/g,'').slice(-10).toLowerCase()}-${Date.now().toString(36)}`;
  await github('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: main.object.sha } });
  await updateRecord(TABLES.BUILDER, requestId, { Status: 'Building', Branch: branch, 'Build Status': 'Branch Created', 'CI Status': 'Not Run', 'Owner Decision': 'Pending', 'Failure Reason': '', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_branch_created', status: 'Running', detail: `${requestId}: ${branch} from main ${main.object.sha}` });
  const executor = new Agent({
    name: 'BUILDER-EXECUTOR', model: MODEL,
    instructions: `Implement the already-approved Builder Request ${requestId} on its existing builder/* branch. Read the request and relevant files before writing. Preserve unrelated behavior. Never touch secrets, .env files, GitHub workflows, environment settings, Airtable tables/data, purchases/contracts/ad spend, or main. Do not weaken authentication/approval/security. Sensitive changes are allowed only when the request is already HIGH risk and separately owner-confirmed; still preserve or strengthen controls. Use write_proposal_file for complete file contents. Do not delete files. Finish with finish_build_proposal.`,
    tools: executionTools(requestId),
  });
  try {
    await updateRecord(TABLES.BUILDER, requestId, { 'Build Status': 'Writing Changes', 'Updated At': new Date().toISOString() });
    await run(executor, `Implement Builder Request ${requestId} according to its saved Implementation Plan. Make the minimum safe code changes on the proposal branch and save a build summary.`, { maxTurns: 30 });
    return await openOrRefreshProposal(requestId);
  } catch (error) {
    await updateRecord(TABLES.BUILDER, requestId, { Status: 'Blocked', 'Build Status': 'Failed', 'Failure Reason': safeDetail(error?.message || error), 'Updated At': new Date().toISOString() });
    await logActivity({ agent: 'BUILDER', actionType: 'builder_execution_failed', status: 'Error', detail: safeDetail(error?.message || error) }); throw error;
  }
}

async function proposalFiles(branch) {
  const compare = await github(`/compare/main...${encodeURIComponent(branch)}`);
  return (compare.files || []).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes }));
}
function prBody(fields, files, testResults = 'CI pending') {
  return `## BUILDER proposal\n\n${fields['Build Summary'] || fields.Goal || ''}\n\n**Risk:** ${fields.Risk || 'Unknown'}\n\n### Files changed\n${files.map(f=>`- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`).join('\n') || '- None'}\n\n### Test results\n${testResults}\n\n### Verification checklist\n${fields['Verification Plan'] || 'Run syntax checks and full test suite.'}\n\n> Controlled by GhostOS BUILDER v2. Merge requires explicit owner approval and green CI. Never push directly to main.`;
}

export async function openOrRefreshProposal(requestId) {
  const request = await getRecord(TABLES.BUILDER, requestId); const branch = request.fields.Branch; assertProposalBranch(branch);
  const files = await proposalFiles(branch);
  if (!files.length) throw new Error('BUILDER proposal contains no code changes');
  if (files.some(f => SECRET_PATH.test(f.filename) || WORKFLOW_PATH.test(f.filename))) throw new Error('Proposal contains a forbidden file');
  if (files.some(f => HIGH_RISK_PATH.test(f.filename)) && !(request.fields.Risk === 'High' && request.fields['High-Risk Confirmed'])) throw new Error('Sensitive files require HIGH-risk owner confirmation');
  let pr;
  if (request.fields['PR Number']) pr = await github(`/pulls/${request.fields['PR Number']}`);
  else {
    pr = await github('/pulls', { method: 'POST', body: { title: `BUILDER: ${String(request.fields.Request || request.fields.Goal).slice(0, 180)}`, head: branch, base: 'main', body: prBody(request.fields, files), draft: false } });
    await logActivity({ agent: 'BUILDER', actionType: 'builder_pr_created', status: 'Running', detail: `${requestId}: PR #${pr.number} ${pr.html_url}` });
  }
  await updateRecord(TABLES.BUILDER, requestId, {
    Status: 'Ready for Build', 'PR URL': pr.html_url, 'PR Number': pr.number, 'Proposed Commit': pr.head?.sha || '',
    'Files Changed Actual': files.map(f=>`${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`).join('\n'),
    'Build Status': 'CI Running', 'CI Status': 'Pending', 'Updated At': new Date().toISOString(),
  });
  return refreshProposalStatus(requestId);
}

export async function refreshProposalStatus(requestId) {
  const request = await getRecord(TABLES.BUILDER, requestId); const prNumber = Number(request.fields['PR Number']);
  if (!prNumber) throw new Error('No PR exists for this Builder Request');
  const pr = await github(`/pulls/${prNumber}`); const sha = pr.head.sha;
  const [checks, statuses] = await Promise.all([github(`/commits/${sha}/check-runs`), github(`/commits/${sha}/status`)]);
  const githubChecks = (checks.check_runs || []).filter(c => c.app?.slug === 'github-actions');
  const netlify = (statuses.statuses || []).filter(s => String(s.context || '').startsWith('netlify/'));
  const failed = githubChecks.some(c => ['failure','timed_out','cancelled','action_required'].includes(c.conclusion)) || netlify.some(s => ['failure','error'].includes(s.state));
  const pending = !githubChecks.length || githubChecks.some(c => c.status !== 'completed') || githubChecks.some(c => !c.conclusion) || netlify.some(s => s.state === 'pending');
  const success = !failed && !pending && githubChecks.every(c => c.conclusion === 'success') && (!netlify.length || netlify.every(s => s.state === 'success'));
  const ciStatus = failed ? 'Failed' : success ? 'Success' : 'Pending';
  const summary = [
    ...githubChecks.map(c => `GitHub Actions ${c.name}: ${c.status}/${c.conclusion || 'pending'}`),
    ...netlify.map(s => `${s.context}: ${s.state}`),
  ].join('\n') || 'Checks have not started yet.';
  const files = await proposalFiles(request.fields.Branch);
  await github(`/pulls/${prNumber}`, { method: 'PATCH', body: { body: prBody(request.fields, files, summary) } });
  const buildStatus = failed ? 'Merge Blocked' : success ? 'Ready for Owner Merge' : 'CI Running';
  const updated = await updateRecord(TABLES.BUILDER, requestId, { 'CI Status': ciStatus, 'Build Status': buildStatus, 'Test Results': summary, 'Proposed Commit': sha, 'Failure Reason': failed ? 'CI/Netlify validation failed. Merge is blocked.' : '', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_ci_refreshed', status: failed ? 'Error' : success ? 'Done' : 'Running', detail: `${requestId}: ${ciStatus}\n${summary}` });
  return updated;
}

export async function rejectProposal(requestId) {
  const request = await getRecord(TABLES.BUILDER, requestId);
  if (request.fields['PR Number']) await github(`/pulls/${request.fields['PR Number']}`, { method: 'PATCH', body: { state: 'closed' } });
  const updated = await updateRecord(TABLES.BUILDER, requestId, { Status: 'Rejected', 'Build Status': 'Rejected', 'Owner Decision': 'Rejected', Result: 'Proposal rejected by owner. Nothing was merged.', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_proposal_rejected', detail: `Owner rejected ${requestId}`, consequential: true });
  return updated;
}

export async function approveAndMergeProposal(requestId) {
  let request = await refreshProposalStatus(requestId);
  if (request.fields['CI Status'] !== 'Success' || request.fields['Build Status'] !== 'Ready for Owner Merge') throw new Error('Merge blocked until all required CI/tests are green');
  if (request.fields.Risk === 'High' && !request.fields['High-Risk Confirmed']) throw new Error('HIGH-risk proposal requires separate owner confirmation');
  const prNumber = Number(request.fields['PR Number']); const pr = await github(`/pulls/${prNumber}`);
  assertProposalBranch(pr.head?.ref); if (pr.base?.ref !== 'main') throw new Error('Proposal PR base must be main');
  const files = await proposalFiles(pr.head.ref);
  if (files.some(f => SECRET_PATH.test(f.filename) || WORKFLOW_PATH.test(f.filename))) throw new Error('Merge blocked: forbidden file in proposal');
  if (files.some(f => HIGH_RISK_PATH.test(f.filename)) && !(request.fields.Risk === 'High' && request.fields['High-Risk Confirmed'])) throw new Error('Merge blocked: sensitive files require HIGH-risk confirmation');
  await updateRecord(TABLES.BUILDER, requestId, { 'Owner Decision': 'Approved to Merge', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_owner_merge_approved', status: 'Running', detail: `${requestId}: owner approved PR #${prNumber}`, consequential: true });
  const merged = await github(`/pulls/${prNumber}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha: pr.head.sha, commit_title: `BUILDER: ${String(request.fields.Request || request.fields.Goal).slice(0, 180)}` } });
  if (!merged.merged) throw new Error(`GitHub refused merge: ${safeDetail(merged.message)}`);
  request = await updateRecord(TABLES.BUILDER, requestId, { Status: 'Done', 'Build Status': 'Merged', 'Merged Commit': merged.sha, Result: `Owner-approved proposal merged as ${merged.sha}`, 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_pr_merged', detail: `${requestId}: PR #${prNumber} -> ${merged.sha}`, consequential: true });
  return request;
}
