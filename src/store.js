// GhostOS persistence layer (Netlify Database / Postgres).
// Every reader degrades to an empty result instead of throwing, so the console
// still renders real empty states when the database is unreachable.
import { getDatabase } from '@netlify/database';

let cached = null;

function db() {
  if (!cached) cached = getDatabase();
  return cached;
}

export async function safe(fn, fallback) {
  try {
    return { ok: true, data: await fn(db().sql) };
  } catch (e) {
    return { ok: false, error: e?.message || 'database unavailable', data: fallback };
  }
}

export const JOB_STATUSES = [
  'new',
  'diagnosing',
  'quoted',
  'approved',
  'awaiting_parts',
  'in_progress',
  'ready',
  'completed',
  'closed_lost'
];

export const QUICK_ACTIONS = {
  claim: { label: 'Claim', status: 'diagnosing', agent: 'RELAY', note: 'Owner claimed the job.' },
  quote: { label: 'Mark quoted', status: 'quoted', agent: 'LEDGER', note: 'Quote sent to customer.' },
  approve: { label: 'Customer approved', status: 'approved', agent: 'ATLAS', note: 'Customer approved the repair.' },
  order_parts: { label: 'Parts ordered', status: 'awaiting_parts', agent: 'SUPPLY', note: 'Parts ordered for this job.' },
  start: { label: 'Start repair', status: 'in_progress', agent: 'FORGE', note: 'Repair started on the bench.' },
  ready: { label: 'Ready for pickup', status: 'ready', agent: 'DISPATCH', note: 'Device ready for pickup or delivery.' },
  complete: { label: 'Complete', status: 'completed', agent: 'LEDGER', note: 'Job completed and handed off.' },
  lose: { label: 'Close as lost', status: 'closed_lost', agent: 'ECHO', note: 'Job closed without work.' },
  escalate: { label: 'Escalate to owner', status: null, agent: 'ATLAS', note: 'Escalated to the owner inbox.' }
};

const int = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const money = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number.parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, 6000);
};

/* ---------------------------------------------------------------- events --- */

export async function logAgentEvent({ agent, kind = 'info', summary, detail = null, jobId = null }) {
  return safe(
    (sql) => sql`
      INSERT INTO agent_events (agent, kind, summary, detail, job_id)
      VALUES (${String(agent).toUpperCase()}, ${kind}, ${summary}, ${detail}, ${jobId})
      RETURNING *`,
    []
  );
}

export function agentEvents(limit = 40, agent = null) {
  return safe(
    (sql) =>
      agent
        ? sql`SELECT * FROM agent_events WHERE agent = ${agent.toUpperCase()} ORDER BY created_at DESC LIMIT ${limit}`
        : sql`SELECT * FROM agent_events ORDER BY created_at DESC LIMIT ${limit}`,
    []
  );
}

export function agentActivityCounts() {
  return safe(
    (sql) => sql`
      SELECT agent,
             COUNT(*)::int AS events,
             MAX(created_at) AS last_event,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS events_24h
      FROM agent_events GROUP BY agent`,
    []
  );
}

/* ------------------------------------------------------------------ jobs --- */

export function listJobs({ status = null, q = null, limit = 100 } = {}) {
  return safe((sql) => {
    if (status && q) {
      return sql`SELECT * FROM jobs WHERE status = ${status}
        AND (customer_name ILIKE ${'%' + q + '%'} OR device ILIKE ${'%' + q + '%'} OR issue ILIKE ${'%' + q + '%'} OR ref ILIKE ${'%' + q + '%'})
        ORDER BY created_at DESC LIMIT ${limit}`;
    }
    if (status) return sql`SELECT * FROM jobs WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit}`;
    if (q) {
      return sql`SELECT * FROM jobs WHERE
        (customer_name ILIKE ${'%' + q + '%'} OR device ILIKE ${'%' + q + '%'} OR issue ILIKE ${'%' + q + '%'} OR ref ILIKE ${'%' + q + '%'})
        ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return sql`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${limit}`;
  }, []);
}

export function jobStatusCounts() {
  return safe((sql) => sql`SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status`, []);
}

export async function getJob(id) {
  const jid = int(id);
  if (!jid) return { ok: false, error: 'invalid job id', data: null };
  const job = await safe((sql) => sql`SELECT * FROM jobs WHERE id = ${jid}`, []);
  if (!job.ok) return { ok: false, error: job.error, data: null };
  const row = job.data[0];
  if (!row) return { ok: true, data: null };
  const events = await safe(
    (sql) => sql`SELECT * FROM job_events WHERE job_id = ${jid} ORDER BY created_at DESC LIMIT 50`,
    []
  );
  const agents = await safe(
    (sql) => sql`SELECT * FROM agent_events WHERE job_id = ${jid} ORDER BY created_at DESC LIMIT 50`,
    []
  );
  return { ok: true, data: { ...row, events: events.data, agent_events: agents.data } };
}

export async function createJob(input = {}, actor = 'owner') {
  const payload = {
    customer_name: text(input.customer_name) || text(input.name),
    device: text(input.device),
    issue: text(input.issue),
    status: JOB_STATUSES.includes(input.status) ? input.status : 'new',
    priority: ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal',
    quoted_cents: money(input.quoted),
    parts_cost_cents: money(input.parts_cost),
    source: text(input.source) || 'console',
    external_ref: text(input.external_ref),
    lead_payload: input.lead_payload ? JSON.stringify(input.lead_payload) : null,
    atlas_output: text(input.atlas_output)
  };
  if (!payload.customer_name && !payload.device && !payload.issue) {
    return { ok: false, error: 'A job needs at least a customer, a device or an issue.', data: null };
  }
  const created = await safe(
    (sql) => sql`
      INSERT INTO jobs (ref, customer_name, device, issue, status, priority, quoted_cents,
                        parts_cost_cents, source, external_ref, lead_payload, atlas_output)
      VALUES (${'GTS-' + Date.now().toString(36).toUpperCase()}, ${payload.customer_name}, ${payload.device},
              ${payload.issue}, ${payload.status}, ${payload.priority}, ${payload.quoted_cents},
              ${payload.parts_cost_cents}, ${payload.source}, ${payload.external_ref},
              ${payload.lead_payload}::jsonb, ${payload.atlas_output})
      RETURNING *`,
    null
  );
  if (!created.ok) return created;
  const job = created.data[0];
  await safe(
    (sql) => sql`INSERT INTO job_events (job_id, action, note, actor) VALUES (${job.id}, 'created', ${'Intake via ' + payload.source}, ${actor})`,
    null
  );
  await logAgentEvent({
    agent: 'ATLAS',
    kind: 'intake',
    summary: `New job ${job.ref} intake`,
    detail: [payload.customer_name, payload.device, payload.issue].filter(Boolean).join(' - '),
    jobId: job.id
  });
  return { ok: true, data: job };
}

export async function applyJobAction(id, action, note = null, actor = 'owner') {
  const jid = int(id);
  const spec = QUICK_ACTIONS[action];
  if (!jid || !spec) return { ok: false, error: 'Unknown job action.', data: null };

  const updated = spec.status
    ? await safe(
        (sql) => sql`UPDATE jobs SET status = ${spec.status}, updated_at = NOW(),
            closed_at = CASE WHEN ${spec.status} IN ('completed','closed_lost') THEN NOW() ELSE closed_at END
            WHERE id = ${jid} RETURNING *`,
        null
      )
    : await safe((sql) => sql`SELECT * FROM jobs WHERE id = ${jid}`, null);

  if (!updated.ok) return updated;
  const job = updated.data?.[0];
  if (!job) return { ok: false, error: 'Job not found.', data: null };

  await safe(
    (sql) => sql`INSERT INTO job_events (job_id, action, note, actor) VALUES (${jid}, ${action}, ${text(note) || spec.note}, ${actor})`,
    null
  );
  await logAgentEvent({
    agent: spec.agent,
    kind: action,
    summary: `${spec.label} - ${job.ref || 'job ' + jid}`,
    detail: text(note) || spec.note,
    jobId: jid
  });

  if (action === 'escalate') {
    await createInboxItem({
      kind: 'escalation',
      agent: 'ATLAS',
      title: `Owner decision needed on ${job.ref || 'job ' + jid}`,
      body: text(note) || 'Escalated from the jobs board.',
      jobId: jid
    });
  }
  if (action === 'complete' && job.quoted_cents) {
    await safe(
      (sql) => sql`INSERT INTO finance_entries (kind, label, amount_cents, bucket, job_id)
        VALUES ('revenue', ${'Completed ' + (job.ref || 'job ' + jid)}, ${job.quoted_cents}, 'operating', ${jid})`,
      null
    );
  }
  return { ok: true, data: job };
}

/* ------------------------------------------------------------- customers --- */

export function listCustomers({ q = null, limit = 100 } = {}) {
  return safe(
    (sql) =>
      q
        ? sql`SELECT c.*, (SELECT COUNT(*)::int FROM jobs j WHERE j.customer_id = c.id) AS job_count
              FROM customers c WHERE c.name ILIKE ${'%' + q + '%'} OR c.phone ILIKE ${'%' + q + '%'} OR c.email ILIKE ${'%' + q + '%'}
              ORDER BY c.created_at DESC LIMIT ${limit}`
        : sql`SELECT c.*, (SELECT COUNT(*)::int FROM jobs j WHERE j.customer_id = c.id) AS job_count
              FROM customers c ORDER BY c.created_at DESC LIMIT ${limit}`,
    []
  );
}

export async function createCustomer(input = {}) {
  const name = text(input.name);
  if (!name) return { ok: false, error: 'Customer name is required.', data: null };
  const res = await safe(
    (sql) => sql`INSERT INTO customers (name, phone, email, address, source, notes)
      VALUES (${name}, ${text(input.phone)}, ${text(input.email)}, ${text(input.address)},
              ${text(input.source) || 'console'}, ${text(input.notes)}) RETURNING *`,
    null
  );
  if (res.ok) {
    await logAgentEvent({ agent: 'ECHO', kind: 'customer', summary: `Customer record added: ${name}` });
    return { ok: true, data: res.data[0] };
  }
  return res;
}

/* ----------------------------------------------------------------- inbox --- */

export function listInbox({ status = 'open', limit = 60 } = {}) {
  return safe(
    (sql) =>
      status === 'all'
        ? sql`SELECT i.*, j.ref AS job_ref FROM inbox_items i LEFT JOIN jobs j ON j.id = i.job_id ORDER BY i.created_at DESC LIMIT ${limit}`
        : sql`SELECT i.*, j.ref AS job_ref FROM inbox_items i LEFT JOIN jobs j ON j.id = i.job_id
               WHERE i.status = ${status} ORDER BY i.created_at DESC LIMIT ${limit}`,
    []
  );
}

export async function createInboxItem({ kind = 'approval', agent = 'ATLAS', title, body = null, jobId = null }) {
  const t = text(title);
  if (!t) return { ok: false, error: 'Inbox items need a title.', data: null };
  const res = await safe(
    (sql) => sql`INSERT INTO inbox_items (kind, agent, title, body, job_id)
      VALUES (${kind}, ${String(agent).toUpperCase()}, ${t}, ${text(body)}, ${jobId}) RETURNING *`,
    null
  );
  return res.ok ? { ok: true, data: res.data[0] } : res;
}

export async function resolveInboxItem(id, decision, note = null) {
  const iid = int(id);
  if (!iid || !['approved', 'declined', 'dismissed'].includes(decision)) {
    return { ok: false, error: 'Invalid inbox decision.', data: null };
  }
  const res = await safe(
    (sql) => sql`UPDATE inbox_items SET status = ${decision}, resolution = ${text(note)}, resolved_at = NOW()
      WHERE id = ${iid} RETURNING *`,
    null
  );
  if (!res.ok) return res;
  const item = res.data[0];
  if (!item) return { ok: false, error: 'Inbox item not found.', data: null };
  await logAgentEvent({
    agent: item.agent || 'ATLAS',
    kind: 'decision',
    summary: `Owner ${decision}: ${item.title}`,
    detail: text(note),
    jobId: item.job_id
  });
  return { ok: true, data: item };
}

export function inboxOpenCount() {
  return safe((sql) => sql`SELECT COUNT(*)::int AS count FROM inbox_items WHERE status = 'open'`, [{ count: 0 }]);
}

/* ------------------------------------------------------------- inventory --- */

export function listInventory() {
  return safe((sql) => sql`SELECT * FROM inventory_items ORDER BY (qty <= reorder_at) DESC, name ASC LIMIT 200`, []);
}

export async function createInventoryItem(input = {}) {
  const name = text(input.name);
  if (!name) return { ok: false, error: 'Part name is required.', data: null };
  const res = await safe(
    (sql) => sql`INSERT INTO inventory_items (sku, name, category, qty, reorder_at, unit_cost_cents, vendor, source_url, verified)
      VALUES (${text(input.sku)}, ${name}, ${text(input.category)}, ${int(input.qty) ?? 0}, ${int(input.reorder_at) ?? 0},
              ${money(input.unit_cost)}, ${text(input.vendor)}, ${text(input.source_url)}, ${Boolean(input.verified)})
      RETURNING *`,
    null
  );
  if (res.ok) {
    await logAgentEvent({ agent: 'SUPPLY', kind: 'inventory', summary: `Stock record added: ${name}` });
    return { ok: true, data: res.data[0] };
  }
  return res;
}

export async function adjustInventory(id, delta) {
  const iid = int(id);
  const d = int(delta);
  if (!iid || d === null) return { ok: false, error: 'Invalid stock adjustment.', data: null };
  const res = await safe(
    (sql) => sql`UPDATE inventory_items SET qty = GREATEST(0, qty + ${d}), updated_at = NOW() WHERE id = ${iid} RETURNING *`,
    null
  );
  if (!res.ok) return res;
  const item = res.data[0];
  if (item) {
    await logAgentEvent({
      agent: 'SUPPLY',
      kind: 'inventory',
      summary: `${item.name} stock ${d > 0 ? '+' : ''}${d} (now ${item.qty})`
    });
  }
  return { ok: true, data: item };
}

/* --------------------------------------------------------------- content --- */

export function listContent() {
  return safe((sql) => sql`SELECT * FROM content_items ORDER BY created_at DESC LIMIT 100`, []);
}

export async function createContentItem(input = {}) {
  const title = text(input.title);
  if (!title) return { ok: false, error: 'Content needs a title.', data: null };
  const res = await safe(
    (sql) => sql`INSERT INTO content_items (channel, title, body, status, scheduled_for)
      VALUES (${text(input.channel)}, ${title}, ${text(input.body)},
              ${text(input.status) || 'draft'}, ${text(input.scheduled_for)}::timestamptz) RETURNING *`,
    null
  );
  if (res.ok) {
    await logAgentEvent({ agent: 'FORGE', kind: 'content', summary: `Draft saved: ${title}` });
    return { ok: true, data: res.data[0] };
  }
  return res;
}

export function updateContentStatus(id, status) {
  const cid = int(id);
  if (!cid || !['draft', 'review', 'scheduled', 'published', 'archived'].includes(status)) {
    return Promise.resolve({ ok: false, error: 'Invalid content status.', data: null });
  }
  return safe((sql) => sql`UPDATE content_items SET status = ${status} WHERE id = ${cid} RETURNING *`, null);
}

/* ------------------------------------------------------------- marketing --- */

export function listCampaigns() {
  return safe((sql) => sql`SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT 100`, []);
}

export async function createCampaign(input = {}) {
  const name = text(input.name);
  if (!name) return { ok: false, error: 'Campaign name is required.', data: null };
  const res = await safe(
    (sql) => sql`INSERT INTO marketing_campaigns (name, channel, status, budget_cents, spend_cents, leads, notes)
      VALUES (${name}, ${text(input.channel)}, ${text(input.status) || 'planned'}, ${money(input.budget)},
              ${money(input.spend) ?? 0}, ${int(input.leads) ?? 0}, ${text(input.notes)}) RETURNING *`,
    null
  );
  if (res.ok) {
    await logAgentEvent({ agent: 'SCOUT', kind: 'marketing', summary: `Campaign registered: ${name}` });
    return { ok: true, data: res.data[0] };
  }
  return res;
}

/* --------------------------------------------------------------- finance --- */

export function listFinanceEntries(limit = 80) {
  return safe((sql) => sql`SELECT * FROM finance_entries ORDER BY occurred_on DESC, id DESC LIMIT ${limit}`, []);
}

export function financeTotals() {
  return safe(
    (sql) => sql`
      SELECT bucket, kind, COALESCE(SUM(amount_cents), 0)::bigint AS total, COUNT(*)::int AS entries
      FROM finance_entries GROUP BY bucket, kind`,
    []
  );
}

export async function createFinanceEntry(input = {}) {
  const label = text(input.label);
  const amount = money(input.amount);
  const kind = ['revenue', 'expense', 'contribution', 'withdrawal'].includes(input.kind) ? input.kind : null;
  if (!label || amount === null || !kind) {
    return { ok: false, error: 'Entry needs a label, an amount and a kind.', data: null };
  }
  const res = await safe(
    (sql) => sql`INSERT INTO finance_entries (kind, label, amount_cents, bucket, occurred_on)
      VALUES (${kind}, ${label}, ${amount}, ${text(input.bucket) || 'operating'},
              COALESCE(${text(input.occurred_on)}::date, CURRENT_DATE)) RETURNING *`,
    null
  );
  if (res.ok) {
    await logAgentEvent({ agent: 'LEDGER', kind: 'finance', summary: `${kind}: ${label}` });
    return { ok: true, data: res.data[0] };
  }
  return res;
}

/* -------------------------------------------------------------- settings --- */

export async function getSetting(key, fallback = null) {
  const res = await safe((sql) => sql`SELECT value FROM settings WHERE key = ${key}`, []);
  return res.ok && res.data[0] ? res.data[0].value : fallback;
}

export function setSetting(key, value) {
  return safe(
    (sql) => sql`INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() RETURNING *`,
    null
  );
}

/* ------------------------------------------------------------------ chat --- */

export function chatHistory(thread = 'owner', limit = 60) {
  return safe(
    (sql) => sql`SELECT * FROM chat_messages WHERE thread = ${thread} ORDER BY created_at ASC LIMIT ${limit}`,
    []
  );
}

export function appendChatMessage(thread, role, content) {
  return safe(
    (sql) => sql`INSERT INTO chat_messages (thread, role, content) VALUES (${thread || 'owner'}, ${role}, ${content}) RETURNING *`,
    null
  );
}

/* --------------------------------------------------------------- rollups --- */

export function growthRollup() {
  return safe(
    (sql) => sql`
      SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
             COUNT(*)::int AS jobs,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
             COALESCE(SUM(quoted_cents) FILTER (WHERE status = 'completed'), 0)::bigint AS completed_cents
      FROM jobs
      WHERE created_at > NOW() - INTERVAL '12 weeks'
      GROUP BY 1 ORDER BY 1`,
    []
  );
}

export function leadSources() {
  return safe(
    (sql) => sql`SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS jobs FROM jobs GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
    []
  );
}
