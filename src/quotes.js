import { TABLES, createApproval, createRecord, getRecord, logActivity, updateRecord } from './airtable.js';
import { assertTransition } from './state-machine.js';

export const MIN_NORMAL_GROSS_MARGIN = 0.30;

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function calculateQuote({ laborPrice = 0, partsPrice = 0, otherFees = 0, partsCost = 0 }) {
  const labor = money(laborPrice);
  const parts = money(partsPrice);
  const fees = money(otherFees);
  const cost = money(partsCost);
  const total = money(labor + parts + fees);
  const grossProfit = money(total - cost);
  const grossMargin = total > 0 ? grossProfit / total : 0;
  return { labor, parts, fees, cost, total, grossProfit, grossMargin };
}

export function quoteNeedsOwnerApproval({ grossMargin, pricingException = false, purchaseRequired = false }) {
  if (pricingException) return { required: true, type: 'Pricing Exception', reason: 'Quote uses a pricing exception.' };
  if (purchaseRequired) return { required: true, type: 'Purchase', reason: 'A parts purchase is required before the job can proceed.' };
  if (grossMargin < MIN_NORMAL_GROSS_MARGIN) return { required: true, type: 'Pricing Exception', reason: `Expected gross margin is below ${(MIN_NORMAL_GROSS_MARGIN * 100).toFixed(0)}%.` };
  return { required: false, type: null, reason: null };
}

async function moveJobForQuote(jobId, targetStatus, fields) {
  let job = await getRecord(TABLES.JOBS, jobId);
  let current = job.fields.Status || 'New Lead';

  if (current === 'New Lead' && targetStatus !== 'Awaiting Customer') {
    assertTransition(current, 'Need Quote');
    await updateRecord(TABLES.JOBS, jobId, { Status: 'Need Quote', 'RELAY State': 'Ready to Quote' });
    current = 'Need Quote';
  }

  assertTransition(current, targetStatus);
  return updateRecord(TABLES.JOBS, jobId, { ...fields, Status: targetStatus });
}

export async function createQuoteForJob({
  jobId,
  jobName,
  laborPrice,
  partsPrice,
  otherFees,
  partsCost,
  recommendedPartSummary,
  customerMessage,
  internalNotes,
  pricingException = false,
  purchaseRequired = false,
}) {
  const economics = calculateQuote({ laborPrice, partsPrice, otherFees, partsCost });
  if (economics.total <= 0) throw new Error('Quote total must be greater than zero');

  const approval = quoteNeedsOwnerApproval({ grossMargin: economics.grossMargin, pricingException, purchaseRequired });
  const stamp = new Date().toISOString();
  const quote = await createRecord(TABLES.QUOTES, {
    Quote: `${jobName || jobId} — ${stamp}`,
    Job: [jobId],
    Status: approval.required ? 'Ready for Owner' : 'Approved',
    'Labor Price': economics.labor,
    'Parts Price': economics.parts,
    'Other Fees': economics.fees,
    'Total Quote': economics.total,
    'Parts Cost': economics.cost,
    'Gross Profit': economics.grossProfit,
    'Gross Margin': economics.grossMargin,
    'Recommended Part Summary': recommendedPartSummary || '',
    'Customer Message': customerMessage || '',
    'Internal Notes': internalNotes || '',
    'Owner Approval Required': approval.required,
    'Owner Approval Status': approval.required ? 'Pending' : 'Not Required',
    'Created At': stamp,
  });

  const targetStatus = approval.required && approval.type === 'Purchase' ? 'Part Approval' : 'Quoted';
  await moveJobForQuote(jobId, targetStatus, {
    'Quoted Price': economics.total,
    'Parts Cost': economics.cost,
    'RELAY State': 'Awaiting Owner',
    'RELAY Reply Draft': customerMessage || '',
    'RELAY Next Action': approval.required
      ? `Owner approval required: ${approval.reason}`
      : 'Quote is approved. Prepare the RELAY quote draft for owner review/copy/send; GhostOS must not send it automatically.',
  });

  if (approval.required) {
    await createApproval({
      type: approval.type,
      jobId,
      quoteId: quote.id,
      amount: approval.type === 'Purchase' ? economics.cost : economics.total,
      summary: approval.reason,
      requestedAction: approval.type === 'Purchase'
        ? `Approve parts spend of $${economics.cost.toFixed(2)} for this job.`
        : `Approve quote of $${economics.total.toFixed(2)} at ${(economics.grossMargin * 100).toFixed(1)}% expected gross margin.`,
      requestedBy: 'ATLAS',
    });
  }

  await logActivity({
    agent: 'LEDGER',
    jobId,
    actionType: 'quote_generated',
    status: approval.required ? 'Blocked' : 'Done',
    detail: JSON.stringify(economics),
    consequential: approval.required,
  });

  return { quote, economics, approval };
}
