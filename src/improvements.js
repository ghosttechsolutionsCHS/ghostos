import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { TABLES, listRecords, getRecord, updateRecord, logActivity } from './airtable.js';
import { createBuilderRequest, analyzeBuilderRequest, createBuildProposal } from './builder.js';

const MODEL = process.env.GHOSTOS_MODEL || 'gpt-5.6-sol';
const DEFAULT_REPO = 'ghosttechsolutionsCHS/ghostos';
export const MAX_AUTONOMOUS_SUGGESTIONS_PER_DAY = 3;
export const DEDUP_WINDOW_DAYS = 30;
const FEEDBACK_SUPPRESSION_DAYS = 90;
const HIGH_RISK = /\b(security|auth(?:entication|orization)?|secret|credential|token|password|permission|owner|payment|refund|purchase|contract|spend|advertis|delete|drop\s+table|truncate|destructive|migration)\b/i;
const COSMETIC_ONLY = /\b(color|font|spacing|shadow|border radius|cosmetic|animation only|reword label)\b/i;
const SECRET_PATH = /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|private[-_]?key|token).*)/i;
const SAFE_CODE_PATHS = ['package.json','netlify.toml','src/ghostos.js','src/tools.js','src/builder.js','src/airtable.js','src/state-machine.js'];

function requireEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured`); return value; }
function repoName() { return process.env.GHOSTOS_GITHUB_REPO || DEFAULT_REPO; }
function dayMs(days) { return days * 86400000; }
function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function fingerprint(problem, change) { return createHash('sha256').update(`${normalize(problem)}|${normalize(change)}`).digest('hex').slice(0, 24); }
function tokens(value) { return new Set(normalize(value).split(' ').filter((x) => x.length > 3)); }
function similarity(a, b) { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let shared = 0; for (const t of A) if (B.has(t)) shared++; return shared / Math.max(A.size, B.size); }
function forcedHigh(candidate) { return HIGH_RISK.test(`${candidate.problem}\n${candidate.proposedChange}\n${candidate.filesLikelyAffected}`); }
function safeSnippet(value, max = 12000) { return String(value || '').replace(/gh[opsu]_[A-Za-z0-9_]+/g, '[REDACTED]').slice(0, max); }
function clampScore(value) { return Math.max(1, Math.min(10, Math.round(Number(value || 0)))); }
function combinedScore(impact, engineering) { return Math.round((impact * 0.65 + engineering * 0.35) * 10) / 10; }

async function githubRead(path) {
  const token = requireEnv('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${repoName()}${path}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'GhostOS-BUILDER-v3' } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return data;
}
async function repoSnapshot() {
  const main = await githubRead('/branches/main');
  const tree = await githubRead(`/git/trees/${main.commit.sha}?recursive=1`);
  const files = (tree.tree || []).filter((i) => i.type === 'blob' && !SECRET_PATH.test(i.path)).map((i) => ({ path: i.path, size: i.size })).slice(0, 500);
  const excerpts = {};
  for (const path of SAFE_CODE_PATHS) {
    try {
      const data = await githubRead(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=main`);
      if (data?.content) excerpts[path] = safeSnippet(Buffer.from(data.content, 'base64').toString('utf8'), 12000);
    } catch { /* evidence is best-effort */ }
  }
  return { mainCommit: main.commit.sha, files, excerpts };
}

async function recentSignals() {
  const [activity, builders, controls, repository] = await Promise.all([
    listRecords(TABLES.ACTIVITY, { maxRecords: 300 }),
    listRecords(TABLES.BUILDER, { maxRecords: 250 }),
    listRecords(TABLES.CONTROL, { maxRecords: 150 }),
    repoSnapshot(),
  ]);
  const since = Date.now() - dayMs(14);
  const recentActivity = activity.filter((r) => new Date(r.fields['Created At'] || 0).getTime() >= since)
    .map((r) => ({ agent: r.fields.Agent, action: r.fields['Action Type'], status: r.fields.Status, detail: safeSnippet(r.fields.Detail, 1500), at: r.fields['Created At'] })).slice(0, 180);
  const feedback = builders.filter((r) => r.fields['Feedback Outcome'] && r.fields['Feedback Outcome'] !== 'None')
    .map((r) => ({ problem: r.fields.Problem || r.fields.Goal || r.fields.Request, outcome: r.fields['Feedback Outcome'], risk: r.fields.Risk, impact: r.fields['Impact Score'], engineeringValue: r.fields['Engineering Value Score'], at: r.fields['Updated At'] })).slice(0, 100);
  const activeControls = controls.filter((r) => r.fields.Active !== false).map((r) => ({ rule: r.fields['Rule / Setting'], category: r.fields.Category, value: safeSnippet(r.fields.Value, 1000) }));
  return { recentActivity, feedback, activeControls, repository };
}

async function canStoreCandidate(candidate) {
  const all = await listRecords(TABLES.BUILDER, { maxRecords: 400 });
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  const createdToday = all.filter((r) => r.fields['Suggestion Source'] === 'BUILDER Autonomous' && String(r.fields['Self Generated At'] || '').slice(0, 10) === today);
  if (createdToday.length >= MAX_AUTONOMOUS_SUGGESTIONS_PER_DAY) return { ok: false, reason: 'daily_cap' };
  const fp = fingerprint(candidate.problem, candidate.proposedChange);
  for (const r of all) {
    const f = r.fields || {}, created = new Date(f['Self Generated At'] || f['Created At'] || 0).getTime();
    const recentEnough = created && now - created <= dayMs(DEDUP_WINDOW_DAYS);
    const snoozed = f['Dismissed Until'] && new Date(f['Dismissed Until']).getTime() > now;
    const feedbackSuppressed = ['Rejected','Dismissed'].includes(f['Feedback Outcome']) && created && now - created <= dayMs(FEEDBACK_SUPPRESSION_DAYS);
    const similar = similarity(`${candidate.problem} ${candidate.proposedChange}`, `${f.Problem || f.Goal || ''} ${f['Proposed Change'] || f['Implementation Plan'] || ''}`) >= 0.72;
    if (f['Suggestion Fingerprint'] === fp || ((recentEnough || feedbackSuppressed || snoozed) && similar)) return { ok: false, reason: snoozed ? 'snoozed_duplicate' : 'duplicate' };
  }
  return { ok: true, fp };
}

async function storeCandidate(candidate) {
  const impactScore = clampScore(candidate.impactScore), engineeringValue = clampScore(candidate.engineeringValueScore), suggestionScore = combinedScore(impactScore, engineeringValue);
  const risk = forcedHigh(candidate) ? 'High' : candidate.risk;
  if (impactScore < 6 || engineeringValue < 5 || suggestionScore < 6.3) return { skipped: true, reason: 'low_value' };
  if (candidate.complexity === 'Large' && suggestionScore < 8) return { skipped: true, reason: 'low_value_large_change' };
  if (COSMETIC_ONLY.test(`${candidate.problem} ${candidate.proposedChange}`) && suggestionScore < 9) return { skipped: true, reason: 'cosmetic' };
  const allowed = await canStoreCandidate(candidate); if (!allowed.ok) return { skipped: true, reason: allowed.reason };
  const request = await createBuilderRequest({ goal: candidate.problem, context: `Evidence:\n${candidate.evidence}\n\nExpected benefit:\n${candidate.expectedBenefit}\n\nProposed change:\n${candidate.proposedChange}`, priority: suggestionScore >= 9 ? 'High' : suggestionScore >= 7 ? 'Normal' : 'Low', requestedBy: 'BUILDER' });
  const now = new Date().toISOString();
  const updated = await updateRecord(TABLES.BUILDER, request.id, {
    'Suggestion Source': 'BUILDER Autonomous', Problem: candidate.problem, Evidence: candidate.evidence, 'Expected Benefit': candidate.expectedBenefit,
    'Proposed Change': candidate.proposedChange, Risk: risk, 'Estimated Complexity': candidate.complexity, 'Files Affected': candidate.filesLikelyAffected,
    'Verification Plan': candidate.verificationPlan, 'Impact Score': impactScore, 'Engineering Value Score': engineeringValue, 'Suggestion Score': suggestionScore,
    'Suggestion Fingerprint': allowed.fp, 'Self Generated At': now, 'Feedback Outcome': 'None', 'Updated At': now,
  });
  await logActivity({ agent: 'BUILDER', actionType: 'autonomous_improvement_suggested', detail: `${request.id} rank=${suggestionScore} impact=${impactScore} eng=${engineeringValue} risk=${risk}: ${safeSnippet(candidate.problem, 500)}` });
  return { request: updated, skipped: false };
}

function discoveryAgent(createdIds) {
  const save = tool({
    name: 'save_improvement_suggestion', description: 'Save one evidence-backed, worthwhile GhostOS improvement. Daily cap, value threshold and deduplication are enforced by code.',
    parameters: z.object({
      problem: z.string().min(10).max(8000), evidence: z.string().min(10).max(12000), expectedBenefit: z.string().min(10).max(8000), proposedChange: z.string().min(10).max(12000),
      risk: z.enum(['Low','Medium','High']), complexity: z.enum(['Small','Medium','Large']), filesLikelyAffected: z.string().min(1).max(10000), verificationPlan: z.string().min(10).max(12000),
      impactScore: z.number().min(1).max(10), engineeringValueScore: z.number().min(1).max(10),
    }),
    async execute(candidate) { const result = await storeCandidate(candidate); if (result.request?.id) createdIds.push(result.request.id); return result; },
  });
  return new Agent({ name: 'BUILDER-IMPROVEMENT-REVIEW', model: MODEL, tools: [save], instructions: `You are the GhostOS continuous-improvement reviewer. Use only evidence supplied in the prompt, including recent Agent Activity, owner feedback, business controls, and a safe repository snapshot. Identify at most three high-value improvements from failed/repetitive workflows, repeated owner actions, agent errors, dashboard friction, stale/unused paths, missing validation, business-control mismatches, or recurring manual tasks that can safely be automated. Do not invent evidence. Do not suggest cosmetic work unless it materially reduces errors or owner effort. Avoid ideas similar to rejected/dismissed feedback. Score Business Impact 1-10 and Engineering Value 1-10 separately. Every saved suggestion must include Problem, Evidence, Expected Benefit, Proposed Change, Risk, Estimated Complexity, likely files, verification plan and both scores. Security, auth, secrets, permissions, payments, spending, contracts, destructive data, migrations, or owner-control changes MUST be HIGH risk. Never suggest weakening approval/security boundaries.` });
}

export async function runImprovementCycle({ allowAutonomousProposal = true } = {}) {
  requireEnv('OPENAI_API_KEY'); requireEnv('AIRTABLE_PAT'); requireEnv('AIRTABLE_BASE_ID'); requireEnv('GITHUB_TOKEN');
  const signals = await recentSignals(), createdIds = [];
  await logActivity({ agent: 'BUILDER', actionType: 'improvement_cycle_started', status: 'Running', detail: 'Scanning operations, owner feedback, controls and safe repository evidence for worthwhile improvements.' });
  await run(discoveryAgent(createdIds), `Review these GhostOS signals and save only worthwhile improvements. Respect the daily cap and avoid repeated low-value ideas.\n\nSIGNALS:\n${JSON.stringify(signals).slice(0, 120000)}`, { maxTurns: 12 });
  const outcomes = [];
  for (const id of createdIds) {
    let record = await getRecord(TABLES.BUILDER, id);
    if (record.fields.Risk === 'High') { outcomes.push({ id, state: 'high_risk_suggestion_only' }); continue; }
    try {
      record = await analyzeBuilderRequest(id); const f = record.fields || {};
      if (allowAutonomousProposal && f.Risk === 'Low' && Number(f['Impact Score'] || 0) >= 8 && Number(f['Engineering Value Score'] || 0) >= 7 && Number(f['Suggestion Score'] || 0) >= 8 && ['Small','Medium'].includes(f['Estimated Complexity'])) {
        const proposal = await createBuildProposal(id); outcomes.push({ id, state: proposal?.blocked ? 'proposal_blocked' : 'low_risk_proposal_created' });
      } else outcomes.push({ id, state: 'analyzed' });
    } catch (error) { outcomes.push({ id, state: 'analysis_failed', error: safeSnippet(error?.message || error, 500) }); }
  }
  await logActivity({ agent: 'BUILDER', actionType: 'improvement_cycle_completed', detail: `Created ${createdIds.length} suggestion(s). ${JSON.stringify(outcomes).slice(0, 5000)}` });
  return { created: createdIds.length, createdIds, outcomes, limits: { daily: MAX_AUTONOMOUS_SUGGESTIONS_PER_DAY, dedupDays: DEDUP_WINDOW_DAYS } };
}

export async function recordSuggestionFeedback(requestId, outcome, { snoozeDays = 7 } = {}) {
  const allowed = ['Build Approved','Merge Approved','Merged','Rejected','Dismissed','Snoozed']; if (!allowed.includes(outcome)) throw new Error('Unsupported feedback outcome');
  const fields = { 'Feedback Outcome': outcome, 'Updated At': new Date().toISOString() };
  if (outcome === 'Dismissed') { fields.Status = 'Rejected'; fields['Build Status'] = 'Rejected'; }
  if (outcome === 'Snoozed') fields['Dismissed Until'] = new Date(Date.now() + dayMs(Math.max(1, Math.min(90, snoozeDays)))).toISOString();
  const updated = await updateRecord(TABLES.BUILDER, requestId, fields);
  await logActivity({ agent: 'BUILDER', actionType: `builder_feedback_${outcome.toLowerCase().replace(/\s+/g,'_')}`, detail: `${requestId}: ${outcome}` });
  return updated;
}
