import { agentByKey } from './agents.js';
import { complete, llmConfigured } from './llm.js';
import { MODEL } from './env.js';
import * as repo from './repo.js';

/**
 * ATLAS.
 *
 * The briefing is computed from real rows first and only then narrated by the
 * model. That ordering matters: the owner always gets true numbers and a real
 * priority list, and the language model is an enhancement layer rather than a
 * dependency. If reasoning is unavailable the briefing still stands on its own.
 */

const money = (n: number) => `$${n.toFixed(2)}`;

export interface Briefing {
  headline: string;
  lines: string[];
  priorities: string[];
  metrics: Awaited<ReturnType<typeof repo.metrics>>;
  narrative: string;
  narrativeAvailable: boolean;
  narrativeReason?: string;
  model: string;
  generatedAt: string;
}

export async function buildBriefing(opts: { narrate?: boolean } = {}): Promise<Briefing> {
  const m = await repo.metrics();
  const agents = await repo.listAgents();

  const lines: string[] = [];
  lines.push(`${m.openJobs} open job${m.openJobs === 1 ? '' : 's'} in the shop.`);
  if (m.inRepair) lines.push(`${m.inRepair} on the bench right now.`);
  if (m.readyForPickup) lines.push(`${m.readyForPickup} ready for pickup and waiting on the customer.`);
  if (m.awaitingParts) lines.push(`${m.awaitingParts} blocked on parts.`);
  lines.push(`${money(m.revenueMonth)} collected this month, ${money(m.profitMonth)} net of logged costs.`);
  if (m.storefrontTarget > 0) {
    const pct = Math.min(100, Math.round((m.storefrontFund / m.storefrontTarget) * 100));
    lines.push(`Storefront fund at ${money(m.storefrontFund)} of ${money(m.storefrontTarget)} (${pct}%).`);
  }
  if (m.lowStockParts) lines.push(`${m.lowStockParts} part line${m.lowStockParts === 1 ? '' : 's'} at or below reorder level.`);

  // Priorities are ranked by what actually blocks money, owner decisions first.
  const priorities: string[] = [];
  if (m.pendingDecisions) priorities.push(`Clear ${m.pendingDecisions} decision${m.pendingDecisions === 1 ? '' : 's'} in your inbox — agents are blocked on you.`);
  if (m.readyForPickup) priorities.push(`Chase ${m.readyForPickup} completed repair${m.readyForPickup === 1 ? '' : 's'} waiting on pickup and payment.`);
  if (m.awaitingParts) priorities.push(`Follow up on ${m.awaitingParts} job${m.awaitingParts === 1 ? '' : 's'} held up by parts.`);
  if (m.lowStockParts) priorities.push(`Restock ${m.lowStockParts} low part line${m.lowStockParts === 1 ? '' : 's'} before they block a repair.`);
  if (!m.openJobs) priorities.push('No open jobs — acquisition is the constraint. SCOUT and FORGE are where to push.');
  if (!priorities.length) priorities.push('Nothing is blocked. Keep the bench moving.');

  const headline = m.pendingDecisions
    ? `${m.pendingDecisions} decision${m.pendingDecisions === 1 ? '' : 's'} need you`
    : m.openJobs
      ? `${m.openJobs} job${m.openJobs === 1 ? '' : 's'} moving, nothing blocked on you`
      : 'Shop is clear — time to fill the pipeline';

  let narrative = '';
  let narrativeAvailable = false;
  let narrativeReason: string | undefined;

  if (opts.narrate !== false && llmConfigured()) {
    const atlas = agentByKey('ATLAS')!;
    const context = [
      `Open jobs: ${m.openJobs}, in repair: ${m.inRepair}, ready for pickup: ${m.readyForPickup}, awaiting parts: ${m.awaitingParts}`,
      `Pending owner decisions: ${m.pendingDecisions}`,
      `Revenue this month: ${money(m.revenueMonth)}, logged costs: ${money(m.expenseMonth)}`,
      `Storefront fund: ${money(m.storefrontFund)} of ${money(m.storefrontTarget)}`,
      `Department states: ${agents.map((a) => `${a.key}=${a.status}`).join(', ')}`,
    ].join('\n');

    const res = await complete(
      atlas.instructions,
      `Write the owner's morning briefing in at most three sentences. Use only these figures; do not invent any others.\n\n${context}`,
      { maxTokens: 900 },
    );
    narrative = res.text.trim();
    narrativeAvailable = res.ok;
    narrativeReason = res.unavailableReason;
    await repo.recordRun({
      agentKey: 'ATLAS',
      prompt: 'company briefing',
      output: narrative,
      model: res.model,
      status: res.ok ? 'ok' : 'unavailable',
      errorMessage: res.unavailableReason ?? '',
    });
  } else if (!llmConfigured()) {
    narrativeReason = 'OPENAI_API_KEY is not configured';
  }

  return {
    headline,
    lines,
    priorities,
    metrics: m,
    narrative,
    narrativeAvailable,
    narrativeReason,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}

/** Natural-language chat with ATLAS, grounded in the real operating figures. */
export async function askAtlas(message: string): Promise<{
  ok: boolean;
  reply: string;
  reason?: string;
  grounding: string[];
}> {
  const atlas = agentByKey('ATLAS')!;
  const m = await repo.metrics();
  const agents = await repo.listAgents();
  const jobs = (await repo.listJobs()).slice(0, 15);
  const inbox = await repo.listInbox('pending');

  const grounding = [
    `Open jobs ${m.openJobs}; in repair ${m.inRepair}; ready for pickup ${m.readyForPickup}; awaiting parts ${m.awaitingParts}.`,
    `Revenue this month ${money(m.revenueMonth)}; logged costs ${money(m.expenseMonth)}; storefront fund ${money(m.storefrontFund)} of ${money(m.storefrontTarget)}.`,
    `Pending owner decisions: ${inbox.length}${inbox.length ? ` (${inbox.map((i) => i.title).join('; ')})` : ''}.`,
    `Departments: ${agents.map((a) => `${a.key} ${a.status}`).join(', ')}.`,
    jobs.length
      ? `Recent jobs: ${jobs.map((j) => `${j.trackingCode} ${j.device} [${j.status}]`).join('; ')}.`
      : 'No jobs recorded yet.',
  ];

  await repo.setAgentState('ATLAS', { status: 'working', currentTask: `Answering: ${message.slice(0, 80)}` });

  const res = await complete(
    `${atlas.instructions}\n\nYou are answering the owner directly in a mobile dashboard. Be concise and concrete. Use only the supplied company state; if something is not in it, say you do not have it rather than guessing.`,
    `Company state:\n${grounding.join('\n')}\n\nOwner asks: ${message}`,
    { maxTokens: 1200 },
  );

  await repo.recordRun({
    agentKey: 'ATLAS',
    prompt: message,
    output: res.text,
    model: res.model,
    status: res.ok ? 'ok' : 'unavailable',
    errorMessage: res.unavailableReason ?? '',
  });

  if (res.ok) {
    await repo.setAgentState('ATLAS', {
      status: 'idle',
      currentTask: '',
      latestResult: res.text.slice(0, 400),
      nextAction: 'Standing by for the next instruction',
    });
    await repo.logActivity('ATLAS', `Answered the owner: ${message.slice(0, 90)}`, 'chat');
    return { ok: true, reply: res.text, grounding };
  }

  await repo.setAgentState('ATLAS', {
    status: 'error',
    currentTask: '',
    latestResult: `Reasoning unavailable: ${res.unavailableReason ?? 'unknown error'}`,
    nextAction: 'Resolve the OpenAI configuration, then retry',
  });
  return { ok: false, reply: '', reason: res.unavailableReason, grounding };
}

/** Ask a single department agent to think about its own area. */
export async function runDepartment(key: string): Promise<{ ok: boolean; output: string; reason?: string }> {
  const def = agentByKey(key);
  if (!def) throw new Error(`Unknown agent: ${key}`);
  const m = await repo.metrics();

  await repo.setAgentState(def.key, { status: 'working', currentTask: `Reviewing ${def.department.toLowerCase()}` });

  const res = await complete(
    def.instructions,
    `Current company state: ${JSON.stringify(m)}.\n\nIn under 120 words, give your single highest-leverage next action for your department. State plainly if you need the owner to decide something, and name what you would escalate: ${def.escalates.join(', ')}.`,
    { maxTokens: 900 },
  );

  await repo.recordRun({
    agentKey: def.key,
    prompt: 'department review',
    output: res.text,
    model: res.model,
    status: res.ok ? 'ok' : 'unavailable',
    errorMessage: res.unavailableReason ?? '',
  });

  if (res.ok) {
    await repo.setAgentState(def.key, {
      status: 'idle',
      currentTask: '',
      latestResult: res.text.slice(0, 500),
      nextAction: 'Awaiting the next cycle',
    });
    await repo.logActivity(def.key, `${def.key} reviewed ${def.department.toLowerCase()}`, 'review');
    return { ok: true, output: res.text };
  }

  await repo.setAgentState(def.key, {
    status: 'error',
    currentTask: '',
    latestResult: `Reasoning unavailable: ${res.unavailableReason ?? 'unknown'}`,
    nextAction: 'Resolve the OpenAI configuration, then retry',
  });
  return { ok: false, output: '', reason: res.unavailableReason };
}
