function n(value) { const x = Number(value); return Number.isFinite(x) ? x : 0; }
function text(value) { return value == null ? '' : String(value); }

export function emptyMarketingSnapshot({ provider = 'windsor', configured = false, error = null } = {}) {
  return {
    source: { provider, configured, fetchedAt: new Date().toISOString(), error },
    snapshots: [],
    channelMetrics: [],
    campaignMetrics: [],
    attribution: [],
    recommendations: [],
    agentActivity: [],
  };
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

export function normalizeMarketingRows(rows = []) {
  const clean = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  const campaignMetrics = clean.map((row, index) => {
    const spend = n(row.spend ?? row.cost ?? row.amount_spent);
    const leads = n(row.leads ?? row.conversions ?? row.lead_count);
    const completedJobs = n(row.completed_jobs ?? row.completedJobs ?? row.jobs_completed);
    const revenue = n(row.revenue ?? row.conversion_value ?? row.sales_revenue);
    const grossProfit = n(row.gross_profit ?? row.grossProfit ?? row.gross_contribution);
    return {
      id: text(row.id || row.campaign_id || `${row.platform || row.source || 'unknown'}:${row.campaign || row.campaign_name || index}`),
      provider: 'windsor',
      channel: text(row.channel || row.platform || row.source),
      platform: text(row.platform || row.source),
      campaign: text(row.campaign || row.campaign_name || row.name),
      spend,
      leads,
      completedJobs,
      revenue,
      grossProfit,
      costPerLead: leads > 0 ? spend / leads : null,
      cac: completedJobs > 0 ? spend / completedJobs : null,
      profitAfterSpend: grossProfit - spend,
      rawAvailable: true,
    };
  });

  const byChannel = new Map();
  for (const row of campaignMetrics) {
    const key = row.channel || row.platform || 'Unknown';
    const current = byChannel.get(key) || { channel: key, spend:0, leads:0, completedJobs:0, revenue:0, grossProfit:0 };
    current.spend += row.spend; current.leads += row.leads; current.completedJobs += row.completedJobs;
    current.revenue += row.revenue; current.grossProfit += row.grossProfit;
    byChannel.set(key, current);
  }
  const channelMetrics = [...byChannel.values()].map((row) => ({
    ...row,
    costPerLead: row.leads > 0 ? row.spend / row.leads : null,
    cac: row.completedJobs > 0 ? row.spend / row.completedJobs : null,
    profitAfterSpend: row.grossProfit - row.spend,
  }));
  return { campaignMetrics, channelMetrics };
}

export function createMarketingDataService({ env = process.env, fetchImpl = fetch } = {}) {
  const endpoint = String(env.WINDSOR_API_URL || '').trim();
  const apiKey = String(env.WINDSOR_API_KEY || '').trim();
  return {
    provider: 'windsor',
    configured: Boolean(endpoint),
    async snapshot() {
      if (!endpoint) return emptyMarketingSnapshot({ configured: false });
      try {
        const headers = { accept: 'application/json' };
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const response = await fetchImpl(endpoint, { method: 'GET', headers });
        if (!response.ok) return emptyMarketingSnapshot({ configured: true, error: `Windsor source returned HTTP ${response.status}` });
        const payload = await response.json();
        const rows = rowsFromPayload(payload);
        const normalized = normalizeMarketingRows(rows);
        return {
          source: { provider: 'windsor', configured: true, fetchedAt: new Date().toISOString(), error: null },
          snapshots: [{ capturedAt: new Date().toISOString(), rowCount: rows.length }],
          channelMetrics: normalized.channelMetrics,
          campaignMetrics: normalized.campaignMetrics,
          attribution: [],
          recommendations: [],
          agentActivity: [],
        };
      } catch (error) {
        return emptyMarketingSnapshot({ configured: true, error: String(error?.message || 'Windsor read failed').slice(0, 500) });
      }
    },
  };
}

export async function getExternalMarketingSnapshot(options = {}) {
  return createMarketingDataService(options).snapshot();
}
