import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { AGENTS } from './agents.js';
import {
  OWNER_ACTIONS,
  newTrackingCode,
  publicLabelFor,
  isValidJobStatus,
  type OwnerActionKey,
} from './jobs-model.js';

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

/** Locked rows are guardrails; agents cannot write them, only the owner can. */
const DEFAULT_SETTINGS = [
  { key: 'storefront_fund_target', value: '15000', label: 'Storefront fund target', locked: false },
  { key: 'daily_ad_spend_limit', value: '0', label: 'Daily ad spend limit', locked: true },
  { key: 'part_purchase_approval_threshold', value: '0', label: 'Parts purchase needing approval (over)', locked: true },
  { key: 'service_radius_miles', value: '25', label: 'Mobile service radius', locked: false },
];

let bootstrapped = false;

/**
 * Idempotent first-run setup: the ten agents and the default operating
 * settings. Seeds structure only — never invented business records.
 */
export async function ensureBootstrap(): Promise<void> {
  if (bootstrapped) return;
  for (const a of AGENTS) {
    await db
      .insert(t.agents)
      .values({
        key: a.key,
        name: a.name,
        department: a.department,
        mission: a.mission,
        sortOrder: a.sortOrder,
        status: 'idle',
        nextAction: 'Awaiting first instruction',
      })
      .onConflictDoUpdate({
        target: t.agents.key,
        set: { name: a.name, department: a.department, mission: a.mission, sortOrder: a.sortOrder },
      });
  }
  for (const s of DEFAULT_SETTINGS) {
    await db.insert(t.settings).values(s).onConflictDoNothing();
  }
  bootstrapped = true;
}

export async function logActivity(
  agentKey: string,
  summary: string,
  kind = 'note',
  meta?: Record<string, unknown>,
): Promise<void> {
  await db.insert(t.activity).values({ agentKey, summary, kind, meta });
  await db
    .update(t.agents)
    .set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(t.agents.key, agentKey));
}

export async function setAgentState(
  key: string,
  patch: Partial<{ status: string; currentTask: string; latestResult: string; nextAction: string }>,
): Promise<void> {
  await db
    .update(t.agents)
    .set({ ...patch, lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(t.agents.key, key));
}

export const listAgents = () => db.select().from(t.agents).orderBy(t.agents.sortOrder);
export const listActivity = (limit = 40) =>
  db.select().from(t.activity).orderBy(desc(t.activity.createdAt)).limit(limit);
export const listInbox = (status = 'pending') =>
  db.select().from(t.inboxItems).where(eq(t.inboxItems.status, status)).orderBy(desc(t.inboxItems.createdAt));
export const listJobs = () => db.select().from(t.jobs).orderBy(desc(t.jobs.updatedAt));
export const listCustomers = () => db.select().from(t.customers).orderBy(desc(t.customers.createdAt));
export const listCampaigns = () => db.select().from(t.campaigns).orderBy(desc(t.campaigns.updatedAt));
export const listContent = () => db.select().from(t.contentItems).orderBy(desc(t.contentItems.createdAt));
export const listChannels = () => db.select().from(t.acquisitionChannels).orderBy(t.acquisitionChannels.name);
export const listParts = () => db.select().from(t.inventoryParts).orderBy(t.inventoryParts.partName);
export const listFinance = (limit = 100) =>
  db.select().from(t.financeEntries).orderBy(desc(t.financeEntries.occurredAt)).limit(limit);
export const listGrowth = () => db.select().from(t.growthOpportunities).orderBy(desc(t.growthOpportunities.updatedAt));
export const listProposals = () => db.select().from(t.builderProposals).orderBy(desc(t.builderProposals.createdAt));
export const listSettings = () => db.select().from(t.settings).orderBy(t.settings.key);
export const listRuns = (limit = 25) =>
  db.select().from(t.agentRuns).orderBy(desc(t.agentRuns.createdAt)).limit(limit);

export async function recordRun(row: {
  agentKey: string;
  prompt: string;
  output: string;
  model: string;
  status: string;
  errorMessage?: string;
}): Promise<void> {
  await db.insert(t.agentRuns).values({ ...row, errorMessage: row.errorMessage ?? '' });
}

/** Real numbers for the ATLAS briefing and the Finance view. */
export async function metrics() {
  const jobs = await listJobs();
  const finance = await listFinance(1000);
  const inbox = await listInbox('pending');
  const parts = await listParts();

  const open = jobs.filter((j) => !['completed', 'cancelled'].includes(j.status));
  const ready = jobs.filter((j) => j.status === 'ready_for_pickup');
  const awaitingParts = jobs.filter((j) => j.status === 'awaiting_parts');
  const inRepair = jobs.filter((j) => j.status === 'in_repair');

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const revenue = finance.filter((f) => f.entryType === 'revenue');
  const expenses = finance.filter((f) => f.entryType === 'expense');
  const fund = finance.filter((f) => f.entryType === 'storefront_fund');
  const inMonth = (d: Date | null) => !!d && new Date(d) >= monthStart;

  const revenueMonth = revenue.filter((f) => inMonth(f.occurredAt)).reduce((s, f) => s + num(f.amount), 0);
  const expenseMonth = expenses.filter((f) => inMonth(f.occurredAt)).reduce((s, f) => s + num(f.amount), 0);
  const target = num((await listSettings()).find((s) => s.key === 'storefront_fund_target')?.value) || 0;

  return {
    openJobs: open.length,
    readyForPickup: ready.length,
    inRepair: inRepair.length,
    awaitingParts: awaitingParts.length,
    pendingDecisions: inbox.length,
    revenueMonth,
    expenseMonth,
    profitMonth: revenueMonth - expenseMonth,
    revenueAllTime: revenue.reduce((s, f) => s + num(f.amount), 0),
    storefrontFund: fund.reduce((s, f) => s + num(f.amount), 0),
    storefrontTarget: target,
    lowStockParts: parts.filter((p) => p.quantityOnHand <= p.reorderAt).length,
    totalCustomers: (await listCustomers()).length,
  };
}

export async function createJob(input: {
  device: string;
  issue: string;
  customerName?: string;
  phone?: string;
  quotedPrice?: number | null;
  priority?: string;
  notes?: string;
}) {
  let customerId: number | null = null;
  if (input.customerName?.trim()) {
    const [c] = await db
      .insert(t.customers)
      .values({
        name: input.customerName.trim(),
        phone: input.phone ?? '',
        stage: 'customer',
        source: 'direct',
      })
      .returning();
    customerId = c.id;
  }
  const [job] = await db
    .insert(t.jobs)
    .values({
      trackingCode: newTrackingCode(),
      customerId,
      device: input.device,
      issue: input.issue,
      status: 'intake',
      publicStatus: publicLabelFor('intake'),
      priority: input.priority ?? 'normal',
      notes: input.notes ?? '',
      quotedPrice: input.quotedPrice != null ? String(input.quotedPrice) : null,
    })
    .returning();
  await logActivity('RELAY', `New job ${job.trackingCode}: ${input.device} — ${input.issue}`, 'job_created', {
    jobId: job.id,
  });
  return job;
}

export async function setJobStatus(jobId: number, status: string) {
  if (!isValidJobStatus(status)) throw new Error(`Unknown job status: ${status}`);
  const [job] = await db
    .update(t.jobs)
    .set({ status, publicStatus: publicLabelFor(status), updatedAt: new Date() })
    .where(eq(t.jobs.id, jobId))
    .returning();
  if (job) {
    await logActivity('DISPATCH', `Job ${job.trackingCode} moved to ${publicLabelFor(status)}`, 'job_status', {
      jobId,
      status,
    });
  }
  return job;
}

/**
 * The five quick owner actions. Each one is a state transition plus its real
 * side effects: a timestamp, a timeline entry, and for payment a LEDGER record
 * that feeds the storefront fund.
 */
export async function applyOwnerAction(action: OwnerActionKey, jobId: number, amount?: number) {
  const def = OWNER_ACTIONS[action];
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: def.toStatus,
    publicStatus: publicLabelFor(def.toStatus),
    updatedAt: now,
    [def.stamp]: now,
  };
  if (action === 'collected_payment' && amount != null) patch.amountCollected = String(amount);

  const [job] = await db.update(t.jobs).set(patch).where(eq(t.jobs.id, jobId)).returning();
  if (!job) throw new Error(`Job ${jobId} not found`);

  await logActivity('DISPATCH', `${def.summary} — ${job.trackingCode} (${job.device})`, 'owner_action', {
    jobId,
    action,
  });

  if (action === 'collected_payment') {
    const collected = amount ?? num(job.quotedPrice);
    if (collected > 0) {
      await db.insert(t.financeEntries).values({
        entryType: 'revenue',
        category: 'repair',
        amount: String(collected),
        note: `Payment collected for ${job.trackingCode}`,
        jobId,
      });
      // A fixed share of every completed job compounds toward the storefront.
      const share = Math.round(collected * 0.2 * 100) / 100;
      if (share > 0) {
        await db.insert(t.financeEntries).values({
          entryType: 'storefront_fund',
          category: 'auto_allocation',
          amount: String(share),
          note: `20% of ${job.trackingCode} allocated to storefront fund`,
          jobId,
        });
      }
      await logActivity('LEDGER', `Logged $${collected.toFixed(2)} revenue and $${share.toFixed(2)} to the storefront fund`, 'finance', { jobId });
    }
  }
  return job;
}

export async function resolveInboxItem(id: number, decision: 'approved' | 'declined', note: string) {
  const [item] = await db
    .update(t.inboxItems)
    .set({ status: decision, resolution: note, resolvedAt: new Date() })
    .where(eq(t.inboxItems.id, id))
    .returning();
  if (item) {
    await logActivity(item.agentKey, `Owner ${decision} — ${item.title}${note ? `: ${note}` : ''}`, 'decision', {
      inboxId: id,
    });
    const stillPending = (await listInbox('pending')).some((i) => i.agentKey === item.agentKey);
    if (!stillPending) {
      await setAgentState(item.agentKey, {
        status: 'idle',
        currentTask: '',
        nextAction: decision === 'approved' ? 'Carrying out the approved decision' : 'Reworking the declined proposal',
      });
    }
  }
  return item;
}

export async function raiseDecision(input: {
  agentKey: string;
  kind: string;
  title: string;
  detail?: string;
  recommendation?: string;
  amount?: number | null;
  urgency?: string;
  jobId?: number | null;
}) {
  const [item] = await db
    .insert(t.inboxItems)
    .values({
      agentKey: input.agentKey,
      kind: input.kind,
      title: input.title,
      detail: input.detail ?? '',
      recommendation: input.recommendation ?? '',
      amount: input.amount != null ? String(input.amount) : null,
      urgency: input.urgency ?? 'normal',
      jobId: input.jobId ?? null,
    })
    .returning();
  await setAgentState(input.agentKey, {
    status: 'needs_owner',
    currentTask: input.title,
    nextAction: 'Waiting on the owner decision',
  });
  return item;
}

/** Generic insert used by the department views' add forms. */
const TABLES = {
  customers: t.customers,
  campaigns: t.campaigns,
  content: t.contentItems,
  channels: t.acquisitionChannels,
  parts: t.inventoryParts,
  finance: t.financeEntries,
  growth: t.growthOpportunities,
} as const;

export type TableKey = keyof typeof TABLES;
export const isTableKey = (k: string): k is TableKey => k in TABLES;

export async function insertRow(key: TableKey, values: Record<string, unknown>) {
  const [row] = await db.insert(TABLES[key] as any).values(values).returning();
  return row;
}

/** Locked settings are refused here — the guardrail is code, not a prompt. */
export async function updateSetting(key: string, value: string, actor: 'owner' | 'agent') {
  const [existing] = await db.select().from(t.settings).where(eq(t.settings.key, key));
  if (!existing) throw new Error(`Unknown setting: ${key}`);
  if (existing.locked && actor !== 'owner') {
    throw new Error(`Setting "${key}" is a locked guardrail and cannot be changed by an agent`);
  }
  const [row] = await db
    .update(t.settings)
    .set({ value, updatedAt: new Date() })
    .where(eq(t.settings.key, key))
    .returning();
  return row;
}

export async function publicJobFeed() {
  const jobs = await listJobs();
  return jobs
    .filter((j) => j.status !== 'cancelled')
    .map((j) => ({
      trackingCode: j.trackingCode,
      device: j.device,
      status: j.publicStatus,
      updatedAt: j.updatedAt,
    }));
}
