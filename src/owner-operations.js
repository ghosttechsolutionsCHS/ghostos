function numOrNull(value) { const n = Number(value); return value === '' || value == null || !Number.isFinite(n) ? null : n; }
function dateValue(row, field) { return new Date(row?.fields?.[field] || row?.createdTime || 0).getTime(); }
function linkedTo(row, jobId) { return Array.isArray(row?.fields?.Job) && row.fields.Job.includes(jobId); }
function newest(rows, field = 'Created At') { return [...rows].sort((a,b)=>dateValue(b,field)-dateValue(a,field))[0] || null; }
function isVerified(part) { return String(part?.fields?.['Research Status'] || '').toLowerCase() === 'verified'; }
function hasKnownPrice(part) { return isVerified(part) && numOrNull(part?.fields?.['Unit Cost']) !== null; }

export function humanizeActivityDetail(actionType, detail) {
  const raw = String(detail || '').trim();
  if (!raw) return '';
  if (actionType === 'ai_execution') {
    try {
      const value = JSON.parse(raw);
      return `${value.provider || 'AI'} · ${value.model || 'model'} · ${value.success ? 'completed' : 'failed'}${value.latencyMs != null ? ` · ${(Number(value.latencyMs)/1000).toFixed(1)}s` : ''}`;
    } catch { return 'AI execution completed'; }
  }
  if (actionType === 'quote_generated') {
    try {
      const value = JSON.parse(raw);
      const total = numOrNull(value.total), gp = numOrNull(value.grossProfit), margin = numOrNull(value.grossMargin);
      return `Quote ${total == null ? 'calculated' : `$${total.toFixed(2)}`}${gp == null ? '' : ` · expected profit $${gp.toFixed(2)}`}${margin == null ? '' : ` · ${(margin*100).toFixed(1)}% margin`}`;
    } catch { return 'Quote economics calculated'; }
  }
  if (actionType === 'parts_quote_continuation_completed') {
    try {
      const value = JSON.parse(raw);
      if (value.completed) return 'Parts + quote continuation completed';
      if (value.waitingForVerifiedPart) return 'Quote withheld until verified part economics are complete';
      return 'Parts + quote continuation paused safely';
    } catch { return 'Parts + quote continuation completed'; }
  }
  return raw.length > 500 ? `${raw.slice(0,497)}...` : raw;
}

function pipelineSummary(jobId, parts, quotes, activity, messages) {
  const jobActivity = activity.filter((row)=>linkedTo(row, jobId));
  const actions = new Set(jobActivity.map((row)=>row.fields['Action Type']));
  const steps = [];
  if (actions.has('customer_message_drafted')) steps.push('RELAY draft ready');
  if (parts.length) steps.push(`SUPPLY researched ${parts.length} option${parts.length===1?'':'s'}`);
  if (actions.has('quote_generated') || quotes.length) steps.push('LEDGER calculated quote economics');
  else if (parts.some(hasKnownPrice)) steps.push('LEDGER evaluating economics');
  const linkedMessages = messages.filter((row)=>linkedTo(row, jobId));
  if (linkedMessages.some((row)=>String(row.fields['Message Type']||'').toLowerCase().includes('quote'))) steps.push('RELAY quote draft ready');
  else if (linkedMessages.some((row)=>['Pending','Blocked','Failed'].includes(row.fields.Status))) steps.push('RELAY holding draft ready');
  return steps.length ? steps.join(' → ') : 'Waiting for pipeline activity';
}

function partSummary(row) {
  const f = row.fields || {};
  return {
    id: row.id,
    partName: f['Part / SKU'] || '',
    compatibility: f.Device || f.Compatibility || '',
    vendor: f.Vendor || '',
    vendorUrl: f['Vendor URL'] || '',
    tier: f['Research Tier'] || '',
    partType: f['Part Type'] || '',
    partCost: numOrNull(f['Unit Cost']),
    shipping: numOrNull(f.Shipping),
    shippingInfo: f['Shipping Info'] || '',
    stockStatus: f['Stock Status'] || 'UNKNOWN',
    researchStatus: f['Research Status'] || 'UNVERIFIED',
    purchaseStatus: f['Purchase Status'] || '',
    recommended: Boolean(f.Recommended),
    verifiedAt: f['Researched At'] || row.createdTime || null,
    notes: f.Notes || '',
  };
}

function quoteSummary(row) {
  if (!row) return null;
  const f = row.fields || {};
  return {
    id: row.id,
    status: f.Status || '',
    total: numOrNull(f['Total Quote']),
    laborPrice: numOrNull(f['Labor Price']),
    partsPrice: numOrNull(f['Parts Price']),
    otherFees: numOrNull(f['Other Fees']),
    partsCost: numOrNull(f['Parts Cost']),
    grossProfit: numOrNull(f['Gross Profit']),
    grossMargin: numOrNull(f['Gross Margin']),
    recommendedPartSummary: f['Recommended Part Summary'] || '',
    ownerApprovalRequired: Boolean(f['Owner Approval Required']),
    ownerApprovalStatus: f['Owner Approval Status'] || '',
    createdAt: f['Created At'] || row.createdTime || null,
  };
}

function quoteBlockers(job, parts, quote) {
  if (quote?.total != null) return [];
  const blockers = [];
  if (!parts.length) blockers.push('SUPPLY has not stored any part research yet.');
  const recommended = parts.find((part)=>part.recommended) || null;
  if (recommended && recommended.partCost == null) blockers.push(`Recommended ${recommended.vendor || 'part'} option has no verified price.`);
  if (parts.length && !parts.some((part)=>part.researchStatus === 'Verified' && part.partCost != null)) blockers.push('No researched option has both VERIFIED status and a known part cost.');
  if (parts.some((part)=>part.stockStatus === 'UNKNOWN' || /UNVERIFIED/i.test(part.stockStatus))) blockers.push('At least one relevant stock/availability result remains UNKNOWN or UNVERIFIED.');
  const next = String(job.fields['RELAY Next Action'] || '').trim();
  if (next && !blockers.some((item)=>item.includes(next))) blockers.push(next);
  if (!blockers.length) blockers.push('Quote economics have not been persisted yet; GhostOS will not invent a final number.');
  return [...new Set(blockers)];
}

export function buildPartsQuoteOverview({ jobs = [], parts = [], quotes = [], activity = [], messages = [] } = {}) {
  return jobs.map((job) => {
    const linkedParts = parts.filter((row)=>linkedTo(row, job.id)).map(partSummary);
    const linkedQuotes = quotes.filter((row)=>linkedTo(row, job.id));
    const latestQuote = quoteSummary(newest(linkedQuotes));
    const recommendedPart = linkedParts.find((part)=>part.recommended) || linkedParts.find((part)=>part.researchStatus === 'Verified' && part.partCost != null) || linkedParts[0] || null;
    const supplyActivity = newest(activity.filter((row)=>linkedTo(row, job.id) && row.fields.Agent === 'SUPPLY'));
    const ledgerActivity = newest(activity.filter((row)=>linkedTo(row, job.id) && row.fields.Agent === 'LEDGER'));
    const blockers = quoteBlockers(job, linkedParts, latestQuote);
    return {
      jobId: job.id,
      customer: job.fields['Customer Name'] || '',
      jobName: job.fields['Job / Customer'] || job.id,
      device: job.fields['Device / Service'] || '',
      issue: job.fields.Issue || '',
      jobStatus: job.fields.Status || '',
      pipelineStage: job.fields['RELAY State'] || job.fields['Repair Stage'] || job.fields.Status || '',
      supplyStatus: supplyActivity?.fields?.Status || (linkedParts.length ? 'Done' : 'Idle'),
      supplyLatestResult: supplyActivity ? humanizeActivityDetail(supplyActivity.fields['Action Type'], supplyActivity.fields.Detail) : '',
      ledgerStatus: ledgerActivity?.fields?.Status || (latestQuote ? 'Done' : 'Idle'),
      ledgerLatestResult: ledgerActivity ? humanizeActivityDetail(ledgerActivity.fields['Action Type'], ledgerActivity.fields.Detail) : '',
      pipelineSummary: pipelineSummary(job.id, linkedParts, linkedQuotes, activity, messages),
      recommendedPart,
      parts: linkedParts,
      quote: latestQuote,
      pricingCard: latestQuote?.total != null ? {
        ready: true, label: 'Recommended Quote', total: latestQuote.total, partCost: latestQuote.partsCost,
        laborPrice: latestQuote.laborPrice, partsPrice: latestQuote.partsPrice, otherFees: latestQuote.otherFees,
        grossProfit: latestQuote.grossProfit, grossMargin: latestQuote.grossMargin, blockers: [],
      } : {
        ready: false, label: 'QUOTE NOT READY', total: null, partCost: recommendedPart?.partCost ?? null,
        laborPrice: null, partsPrice: null, otherFees: null, grossProfit: null, grossMargin: null, blockers,
      },
      quoteWithheldReason: blockers.join(' '),
    };
  });
}

export function humanizeAgentState(agent, latestActivity, growthWork) {
  if (growthWork?.fields?.['Latest Result']) return String(growthWork.fields['Latest Result']);
  if (!latestActivity) return null;
  return humanizeActivityDetail(latestActivity.fields['Action Type'], latestActivity.fields.Detail);
}
