import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { TABLES, createRecord, getRecord, logActivity, updateRecord } from './airtable.js';

const MODEL = process.env.GHOSTOS_MODEL || 'gpt-5.6-sol';
const DEFAULT_REPO = 'ghosttechsolutionsCHS/ghostos';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function repoName() {
  return process.env.GHOSTOS_GITHUB_REPO || DEFAULT_REPO;
}

async function github(path) {
  const token = requireEnv('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${repoName()}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'GhostOS-BUILDER',
    },
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json();
}

export async function createBuilderRequest({ goal, context = '', priority = 'Normal', requestedBy = 'Owner' }) {
  const now = new Date().toISOString();
  const request = await createRecord(TABLES.BUILDER, {
    Request: String(goal).slice(0, 250),
    Status: 'Queued',
    Priority: priority,
    'Requested By': requestedBy,
    Goal: String(goal),
    Context: String(context || ''),
    'Created At': now,
    'Updated At': now,
  });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_request_created', detail: `Builder request ${request.id}: ${String(goal).slice(0, 300)}` });
  return request;
}

const getRequestTool = tool({
  name: 'get_builder_request',
  description: 'Read the current Builder Request from Airtable before analyzing it.',
  parameters: z.object({ requestId: z.string().min(1) }),
  async execute({ requestId }) { return getRecord(TABLES.BUILDER, requestId); },
});

const listRepoFilesTool = tool({
  name: 'list_repo_files',
  description: 'List repository files from main. Read-only. Use this to understand the existing architecture before proposing changes.',
  parameters: z.object({}),
  async execute() {
    const branch = await github('/branches/main');
    const tree = await github(`/git/trees/${branch.commit.sha}?recursive=1`);
    return (tree.tree || []).filter((item) => item.type === 'blob').map((item) => ({ path: item.path, size: item.size })).slice(0, 1500);
  },
});

const readRepoFileTool = tool({
  name: 'read_repo_file',
  description: 'Read one UTF-8 repository file from main. Never use this for secrets or binary files.',
  parameters: z.object({ path: z.string().min(1).max(500) }),
  async execute({ path }) {
    if (path.includes('..')) throw new Error('Invalid repository path');
    const data = await github(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=main`);
    if (data.type !== 'file' || !data.content) throw new Error('Path is not a readable file');
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    if (text.length > 120000) return `${text.slice(0, 120000)}\n...[truncated]`;
    return text;
  },
});

const savePlanTool = tool({
  name: 'save_builder_plan',
  description: 'Save BUILDER analysis back to the Builder Request. This does not change GitHub, deploy, or execute code.',
  parameters: z.object({
    requestId: z.string().min(1),
    implementationPlan: z.string().min(1).max(50000),
    risk: z.enum(['Low', 'Medium', 'High']),
    filesAffected: z.string().min(1).max(20000),
    verificationPlan: z.string().min(1).max(30000),
    result: z.string().max(30000).optional(),
  }),
  async execute({ requestId, implementationPlan, risk, filesAffected, verificationPlan, result }) {
    return updateRecord(TABLES.BUILDER, requestId, {
      Status: 'Planned',
      'Implementation Plan': implementationPlan,
      Risk: risk,
      'Files Affected': filesAffected,
      'Verification Plan': verificationPlan,
      Result: result || 'Plan prepared. No repository changes were executed by BUILDER.',
      'Updated At': new Date().toISOString(),
    });
  },
});

export const builderAgent = new Agent({
  name: 'BUILDER',
  model: MODEL,
  instructions: `You are BUILDER, the internal software engineering agent for Ghost Tech Solutions. Your job is to inspect the current GhostOS main branch and turn an engineering request into a precise implementation plan. You are read-only with respect to GitHub in this version: never claim you committed, merged, deployed, changed code, or changed configuration. Always inspect the Builder Request first, list repository files, and read the minimum relevant files needed to ground your plan. Preserve existing behavior unless the request explicitly changes it. Pay special attention to security boundaries, manual RELAY messaging, Airtable schema compatibility, Netlify functions, owner approval controls, tests, and secrets. Never request or expose secret values. Finish by calling save_builder_plan with a concrete ordered plan, risk, exact likely files affected, and a verification plan.`,
  tools: [getRequestTool, listRepoFilesTool, readRepoFileTool, savePlanTool],
});

export async function analyzeBuilderRequest(requestId) {
  requireEnv('OPENAI_API_KEY');
  requireEnv('AIRTABLE_PAT');
  requireEnv('AIRTABLE_BASE_ID');
  requireEnv('GITHUB_TOKEN');
  const current = await getRecord(TABLES.BUILDER, requestId);
  if (['Done', 'Rejected'].includes(current.fields.Status)) throw new Error(`Builder request is already ${current.fields.Status}`);
  await updateRecord(TABLES.BUILDER, requestId, { Status: 'Analyzing', 'Updated At': new Date().toISOString() });
  await logActivity({ agent: 'BUILDER', actionType: 'builder_analysis_started', status: 'Running', detail: `Analyzing ${requestId}` });
  try {
    const result = await run(builderAgent, `Analyze Builder Request ${requestId}. Inspect the current main branch and save a grounded implementation plan. Do not change GitHub.`, { maxTurns: 18 });
    const output = String(result.finalOutput || '').trim();
    await logActivity({ agent: 'BUILDER', actionType: 'builder_analysis_completed', status: 'Done', detail: output.slice(0, 20000) || `Plan saved for ${requestId}` });
    return getRecord(TABLES.BUILDER, requestId);
  } catch (error) {
    await updateRecord(TABLES.BUILDER, requestId, { Status: 'Blocked', Result: String(error?.message || error).slice(0, 30000), 'Updated At': new Date().toISOString() });
    await logActivity({ agent: 'BUILDER', actionType: 'builder_analysis_failed', status: 'Error', detail: error?.message || String(error) });
    throw error;
  }
}
