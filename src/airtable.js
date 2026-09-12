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
  BUILDER: 'Builder Requests',
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function compactFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function base() {
  return new Airtable({ apiKey: requireEnv('AIRTABLE_PAT') }).base(requireEnv('AIRTABLE_BASE_ID'));
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
  return controls.filter((item) => item.fields.Active !== false).map((item) => ({
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
    Approval: `${type}: ${summary}`.slice(0, 250), Type: type, Status: 'Pending', Summary: String(summary || ''),
    'Requested Action': String(requestedAction || ''), 'Requested By': requestedBy, 'Created At': stamp,
  };
  if (jobId) fields.Job = [jobId];
  if (quoteId) fields.Quote = [quoteId];
  if (amount !== undefined && amount !== null && Number.isFinite(Number(amount))) fields.Amount = Number(amount);
  const record = await createRecord(TABLES.APPROVALS, fields);
  await logActivity({ agent: requestedBy, jobId, actionType: 'owner_approval_requested', status: 'Blocked', detail: `${type}: ${summary}`, consequential: true });
  return record;
}

export async function getDashboardSnapshot() {
  const [jobs, parts, quotes, approvals, activity, cash, messages, controls, builderRequests] = await Promise.all([
    listRecords(TABLES.JOBS, { maxRecords: 300 }),
    listRecords(TABLES.PARTS, { maxRecords: 300 }),
    listRecords(TABLES.QUOTES, { maxRecords: 300 }),
    listRecords(TABLES.APPROVALS, { maxRecords: 200 }),
    listRecords(TABLES.ACTIVITY, { maxRecords: 200 }),
    listRecords(TABLES.CASH, { maxRecords: 500 }),
    listRecords(TABLES.MESSAGES, { maxRecords: 300 }),
    listRecords(TABLES.CONTROL, { maxRecords: 200 }),
    listRecords(TABLES.BUILDER, { maxRecords: 200 }),
  ]);

  const pendingApprovals = approvals.filter((r) => r.fields.Status === 'Pending');
  const completed = jobs.filter((r) => r.fields.Status === 'Completed');
  const lost = jobs.filter((r) => r.fields.Status === 'Lost / Declined');
  const activeJobs = jobs.filter((r) => !['Completed', 'Lost / Declined'].includes(r.fields.Status));
  const newLeads = jobs.filter((r) => ['New Lead', 'Need Quote'].includes(r.fields.Status));
  const researchedParts = parts.filter((r) => Boolean(r.fields['Research Status']));
  const moneyIn = cash.reduce((sum, r) => sum + Number(r.fields['Money In'] || 0), 0);
  const moneyOut = cash.reduce((sum, r) => sum + Number(r.fields['Money Out'] || 0), 0);
  const quotedPipeline = activeJobs.reduce((sum, r) => sum + Number(r.fields['Quoted Price'] || 0), 0);
  const revenueCollected = jobs.reduce((sum, r) => sum + Number(r.fields['Revenue Collected'] || 0), 0);
  const partsCost = jobs.reduce((sum, r) => sum + Number(r.fields['Parts Cost'] || 0), 0);
  const grossProfit = jobs.reduce((sum, r) => sum + Number(r.fields['Gross Profit'] || 0), 0);
  const relayDrafts = messages.filter((r) => ['Pending', 'Failed', 'Blocked'].includes(r.fields.Status));
  const builderOpen = builderRequests.filter((r) => !['Done', 'Rejected'].includes(r.fields.Status));
  const completionRate = jobs.length ? completed.length / Math.max(1, completed.length + lost.length) : 0;
  const avgTicket = completed.length ? completed.reduce((sum, r) => sum + Number(r.fields['Revenue Collected'] || 0), 0) / completed.length : 0;

  const agentNames = ['ATLAS', 'RELAY', 'SUPPLY', 'LEDGER', 'DISPATCH', 'BUILDER'];
  const agents = agentNames.map((name) => {
    const recent = activity.filter((r) => r.fields.Agent === name)
      .sort((a, b) => new Date(b.fields['Created At'] || 0) - new Date(a.fields['Created At'] || 0))[0];
    return { name, status: recent?.fields.Status || 'Idle', lastAction: recent?.fields['Action Type'] || null, detail: recent?.fields.Detail || null, at: recent?.fields['Created At'] || null };
  });

  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      totalJobs: jobs.length, activeJobs: activeJobs.length, newLeads: newLeads.length, completedJobs: completed.length,
      pendingApprovals: pendingApprovals.length, relayDrafts: relayDrafts.length, builderOpen: builderOpen.length,
      partsResearched: researchedParts.length, quotes: quotes.length, quotedPipeline, revenueCollected, partsCost, grossProfit,
      cashIn: moneyIn, cashOut: moneyOut, netCash: moneyIn - moneyOut, completionRate, avgTicket,
    },
    agents,
    jobs: jobs.sort((a,b)=>new Date(b.fields['Last Contacted']||0)-new Date(a.fields['Last Contacted']||0)).slice(0,100),
    quotes: quotes.slice(0,100),
    approvals: pendingApprovals.slice(0,50),
    messages: messages.sort((a,b)=>new Date(b.fields['Created At']||0)-new Date(a.fields['Created At']||0)).slice(0,150),
    parts: parts.sort((a,b)=>new Date(b.fields['Researched At']||0)-new Date(a.fields['Researched At']||0)).slice(0,150),
    cash: cash.slice(0,150),
    controls: controls.filter((r)=>r.fields.Active !== false).slice(0,100),
    builderRequests: builderRequests.sort((a,b)=>new Date(b.fields['Updated At']||b.fields['Created At']||0)-new Date(a.fields['Updated At']||a.fields['Created At']||0)).slice(0,100),
    activity: activity.sort((a,b)=>new Date(b.fields['Created At']||0)-new Date(a.fields['Created At']||0)).slice(0,100),
  };
}
