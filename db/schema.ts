import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * GhostOS operating store.
 *
 * Postgres is the source of truth for everything the dashboard renders.
 * Airtable stays the owner's business database and is mirrored in/out through
 * the sync endpoints when a PAT is configured, so the dashboard keeps working
 * whether or not Airtable is reachable.
 */

/** One row per department agent. Status drives the dashboard cards. */
export const agents = pgTable('agents', {
  key: text().primaryKey(), // ATLAS, FORGE, ECHO, ...
  name: text().notNull(),
  department: text().notNull(),
  mission: text().notNull().default(''),
  status: text().notNull().default('idle'), // working | waiting | needs_owner | idle | error
  currentTask: text('current_task').notNull().default(''),
  latestResult: text('latest_result').notNull().default(''),
  nextAction: text('next_action').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const customers = pgTable(
  'customers',
  {
    id: serial().primaryKey(),
    name: text().notNull(),
    phone: text().notNull().default(''),
    email: text().notNull().default(''),
    source: text().notNull().default('direct'), // scout | referral | paid | walk_in | direct
    stage: text().notNull().default('lead'), // lead | contacted | quoted | customer | repeat | lost
    notes: text().notNull().default(''),
    airtableRecordId: text('airtable_record_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('customers_stage_idx').on(t.stage)],
);

/**
 * Repair jobs. `status` is the internal pipeline; `publicStatus` is the
 * customer-safe label the Ghost Tech website can sync later via the
 * site-sync feed, keyed by `trackingCode`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: serial().primaryKey(),
    trackingCode: text('tracking_code').notNull().unique(),
    customerId: integer('customer_id').references(() => customers.id),
    device: text().notNull().default(''),
    issue: text().notNull().default(''),
    status: text().notNull().default('intake'),
    publicStatus: text('public_status').notNull().default('Received'),
    priority: text().notNull().default('normal'), // low | normal | high
    quotedPrice: numeric('quoted_price', { precision: 10, scale: 2 }),
    partsCost: numeric('parts_cost', { precision: 10, scale: 2 }),
    amountCollected: numeric('amount_collected', { precision: 10, scale: 2 }),
    assignedTo: text('assigned_to').notNull().default(''),
    notes: text().notNull().default(''),
    airtableRecordId: text('airtable_record_id'),
    promisedAt: timestamp('promised_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    repairStartedAt: timestamp('repair_started_at', { withTimezone: true }),
    repairFinishedAt: timestamp('repair_finished_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('jobs_status_idx').on(t.status)],
);

/**
 * Owner Inbox. Only genuine owner decisions land here — money, contracts,
 * unusual pricing, or anything an agent is explicitly barred from self-approving.
 * Routine operations are logged to `activity` instead.
 */
export const inboxItems = pgTable(
  'inbox_items',
  {
    id: serial().primaryKey(),
    agentKey: text('agent_key').notNull().default('ATLAS'),
    kind: text().notNull(), // purchase | pricing | refund | contract | adspend | builder_change | escalation
    title: text().notNull(),
    detail: text().notNull().default(''),
    recommendation: text().notNull().default(''),
    amount: numeric({ precision: 10, scale: 2 }),
    urgency: text().notNull().default('normal'), // low | normal | high
    status: text().notNull().default('pending'), // pending | approved | declined
    jobId: integer('job_id').references(() => jobs.id),
    payload: jsonb().$type<Record<string, unknown>>(),
    resolution: text().notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('inbox_status_idx').on(t.status)],
);

/** Append-only company timeline. Routine agent work is recorded here. */
export const activity = pgTable(
  'activity',
  {
    id: serial().primaryKey(),
    agentKey: text('agent_key').notNull(),
    kind: text().notNull().default('note'),
    summary: text().notNull(),
    meta: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('activity_created_idx').on(t.createdAt)],
);

/** FORGE — paid marketing. */
export const campaigns = pgTable('campaigns', {
  id: serial().primaryKey(),
  name: text().notNull(),
  channel: text().notNull().default('google'),
  status: text().notNull().default('draft'), // draft | active | paused | ended
  dailyBudget: numeric('daily_budget', { precision: 10, scale: 2 }),
  spendToDate: numeric('spend_to_date', { precision: 10, scale: 2 }).default('0'),
  leads: integer().notNull().default(0),
  bookedJobs: integer('booked_jobs').notNull().default(0),
  notes: text().notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** ECHO — content and social. */
export const contentItems = pgTable('content_items', {
  id: serial().primaryKey(),
  platform: text().notNull().default('facebook'),
  title: text().notNull(),
  body: text().notNull().default(''),
  status: text().notNull().default('draft'), // draft | needs_review | scheduled | posted
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** SCOUT — free customer acquisition channels. */
export const acquisitionChannels = pgTable('acquisition_channels', {
  id: serial().primaryKey(),
  name: text().notNull(),
  kind: text().notNull().default('organic'), // organic | community | referral | marketplace
  status: text().notNull().default('active'),
  leadsThisMonth: integer('leads_this_month').notNull().default(0),
  notes: text().notNull().default(''),
  lastWorkedAt: timestamp('last_worked_at', { withTimezone: true }),
});

/** SUPPLY — parts and inventory. */
export const inventoryParts = pgTable('inventory_parts', {
  id: serial().primaryKey(),
  partName: text('part_name').notNull(),
  deviceModel: text('device_model').notNull().default(''),
  tier: text().notNull().default('standard'), // budget | standard | premium
  vendor: text().notNull().default(''),
  vendorUrl: text('vendor_url').notNull().default(''),
  unitCost: numeric('unit_cost', { precision: 10, scale: 2 }),
  quantityOnHand: integer('quantity_on_hand').notNull().default(0),
  reorderAt: integer('reorder_at').notNull().default(1),
  verified: boolean().notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** LEDGER — money in, money out, storefront fund. */
export const financeEntries = pgTable(
  'finance_entries',
  {
    id: serial().primaryKey(),
    entryType: text('entry_type').notNull(), // revenue | expense | storefront_fund
    category: text().notNull().default('general'),
    amount: numeric({ precision: 10, scale: 2 }).notNull(),
    note: text().notNull().default(''),
    jobId: integer('job_id').references(() => jobs.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('finance_type_idx').on(t.entryType)],
);

/** HORIZON — growth and partnerships. */
export const growthOpportunities = pgTable('growth_opportunities', {
  id: serial().primaryKey(),
  title: text().notNull(),
  kind: text().notNull().default('partnership'), // partnership | b2b | expansion | storefront
  stage: text().notNull().default('identified'), // identified | contacted | negotiating | won | lost
  potentialValue: numeric('potential_value', { precision: 10, scale: 2 }),
  contact: text().notNull().default(''),
  notes: text().notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** BUILDER — proposed improvements to GhostOS itself. Advisory only. */
export const builderProposals = pgTable('builder_proposals', {
  id: serial().primaryKey(),
  title: text().notNull(),
  area: text().notNull().default('general'),
  rationale: text().notNull().default(''),
  proposedChange: text('proposed_change').notNull().default(''),
  risk: text().notNull().default('low'), // low | medium | high
  requiresOwner: boolean('requires_owner').notNull().default(true),
  status: text().notNull().default('proposed'), // proposed | approved | declined | applied
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Record of every agent reasoning run, for auditability. */
export const agentRuns = pgTable('agent_runs', {
  id: serial().primaryKey(),
  agentKey: text('agent_key').notNull(),
  prompt: text().notNull().default(''),
  output: text().notNull().default(''),
  model: text().notNull().default(''),
  status: text().notNull().default('ok'), // ok | error | unavailable
  errorMessage: text('error_message').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Operating settings. Rows flagged `locked` are guardrails that agents —
 * BUILDER included — are never allowed to change; only the owner can.
 */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: text().notNull().default(''),
  label: text().notNull().default(''),
  locked: boolean().notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
