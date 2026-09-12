import Airtable from 'airtable';

export const TABLES = Object.freeze({
  JOBS: 'Leads & Jobs',
  PARTS: 'Parts & Inventory',
  QUOTES: 'Quotes',
  APPROVALS: 'Owner Inbox',
  ACTIVITY: 'Agent Activity',
  MESSAGES: 'RELAY Messages',
  CASH: 'Cash & Storefront',
  CONTROL: 'GhostOS Control',
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function compactFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

export function base() {
  return new Airtable({ apiKey: requireEnv('AIRTABLE_PAT') })
    .base(requireEnv('AIRTABLE_BASE_ID'));
}

export async function getRecord(table, id) {
  const record = await base()(table).find(id);
  return { id: record.id, fields: record.fields };
}

export async function listRecords(table, options = {}) {
  const selectOptions = { maxRecords: options.maxRecords || 100 };
  if (options.view) selectOptions.view = options.view;
  if (options.filterByFormula) selectOptions.filterByFormula = options.filterByFormula;
  if (options.sort) selectOptions.sort = options.sort;

  const records = await base()(table).select(selectOptions).all();
  return records.map((record) => ({ id: record.id, fields: record.fields }));
}

export async function createRecord(table, fields) {
  const record = await base()(table).create(compactFields(fields), { typecast: true });
  return { id: record.id, fields: record.fields };
}

export async function updateRecord(table, id, fields) {
  const record = await base()(table).update(id, compactFields(fields), { typecast: true });
  return { id: record.id, fields: record.fields };
}

export async function logActivity({ agent, jobId, actionType, status = 'Done', detail = '', consequential = false }) {
  const stamp = new Date().toISOString();
  const fields = {
    Event: `${agent} — ${actionType} — ${stamp}`,
    Agent: agent,
    'Action Type': actionType,
    Status: status,
    Detail: String(detail || '').slice(0, 90000),
    Consequential: Boolean(consequential),
    'Created At': stamp,
  };
  if (jobId) fields.Job = [jobId];
  return createRecord(TABLES.ACTIVITY, fields);
}

export async function readActiveControls() {
  const controls = await listRecords(TABLES.CONTROL, { maxRecords: 200 });
  return controls
    .filter((item) => item.fields.Active !== false)
    .map((item) => ({
      id: item.id,
      rule: item.fields['Rule / Setting'],
      category: item.fields.Category,
      value: item.fields.Value,
      notes: item.fields.Notes,
    }));
}

export async function createApproval({ type, jobId, quoteId, amount, summary, requestedAction, requestedBy = 'ATLAS' }) {
  const stamp = new Date().toISOString();
  const fields = {
    Approval: `${type}: ${summary}`.slice(0, 250),
    Type: type,
    Status: 'Pending',
    Summary: String(summary || ''),
    'Requested Action': String(requestedAction || ''),
    'Requested By': requestedBy,
    'Created At': stamp,
  };
  if (jobId) fields.Job = [jobId];
  if (quoteId) fields.Quote = [quoteId];
  if (amount !== undefined && amount !== null && Number.isFinite(Number(amount))) fields.Amount = Number(amount);

  const record = await createRecord(TABLES.APPROVALS, fields);
  await logActivity({
    agent: requestedBy,
    jobId,
    actionType: 'owner_approval_requested',
    status: 'Blocked',
    detail: `${type}: ${summary}`,
    consequential: true,
  });
  return record;
}

export async function getDashboardSnapshot() {
  const [jobs, parts, quotes, approvals, activity, cash] = await Promise.all([
    listRecords(TABLES.JOBS, { maxRecords: 200 }),
    listRecords(TABLES.PARTS, { maxRecords: 200 }),
    listRecords(TABLES.QUOTES, { maxRecords: 200 }),
    listRecords(TABLES.APPROVALS, { maxRecords: 200 }),
    listRecords(TABLES.ACTIVITY, { maxRecords: 100 }),
    listRecords(TABLES.CASH, { maxRecords: 500 }),
  ]);

  const pendingApprovals = approvals.filter((r) => r.fields.Status === 'Pending');
  const completed = jobs.filter((r) => r.fields.Status === 'Completed');
  const activeJobs = jobs.filter((r) => !['Completed', 'Lost / Declined'].includes(r.fields.Status));
  const researchedParts = parts.filter((r) => Boolean(r.fields['Research Status']));
  const moneyIn = cash.reduce((sum, r) => sum + Number(r.fields['Money In'] || 0), 0);
  const moneyOut = cash.reduce((sum, r) => sum + Number(r.fields['Money Out'] || 0), 0);
  const quotedPipeline = jobs.reduce((sum, r) => sum + Number(r.fields['Quoted Price'] || 0), 0);
  const revenueCollected = jobs.reduce((sum, r) => sum + Number(r.fields['Revenue Collected'] || 0), 0);

  const agents = ['ATLAS', 'RELAY', 'SUPPLY', 'LEDGER', 'DISPATCH'].map((name) => {
    const recent = activity
      .filter((r) => r.fields.Agent === name)
      .sort((a, b) => new Date(b.fields['Created At'] || 0) - new Date(a.fields['Created At'] || 0))[0];
    return {
      name,
      status: recent?.fields.Status || 'Idle',
      lastAction: recent?.fields['Action Type'] || null,
      detail: recent?.fields.Detail || null,
      at: recent?.fields['Created At'] || null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      totalJobs: jobs.length,
      activeJobs: activeJobs.length,
      completedJobs: completed.length,
      pendingApprovals: pendingApprovals.length,
      partsResearched: researchedParts.length,
      quotes: quotes.length,
      quotedPipeline,
      revenueCollected,
      cashIn: moneyIn,
      cashOut: moneyOut,
      netCash: moneyIn - moneyOut,
    },
    agents,
    jobs: jobs.slice(0, 50),
    quotes: quotes.slice(0, 50),
    approvals: pendingApprovals.slice(0, 50),
    activity: activity
      .sort((a, b) => new Date(b.fields['Created At'] || 0) - new Date(a.fields['Created At'] || 0))
      .slice(0, 50),
  };
}
