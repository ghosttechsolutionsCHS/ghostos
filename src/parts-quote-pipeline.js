import { TABLES, getRecord, listRecords, logActivity, updateRecord } from './airtable.js';
import { MIN_NORMAL_GROSS_MARGIN, createQuoteForJob } from './quotes.js';
import { createRelayDraft } from './relay-delivery.js';

const PART_KEYWORDS = [
  'cracked', 'broken glass', 'screen', 'display', 'oled', 'lcd', 'digitizer',
  'battery', 'charging port', 'charge port', 'camera', 'back glass', 'speaker',
  'microphone', 'mic', 'button', 'housing', 'connector', 'replacement',
];
const UNUSABLE_STOCK = ['unknown', 'unverified', 'out of stock', 'unavailable', 'discontinued', 'backorder', 'backordered'];

function text(value) { return String(value ?? '').trim(); }
function lower(value) { return text(value).toLowerCase(); }
function linkedToJob(row, jobId) { return Array.isArray(row.fields?.Job) && row.fields.Job.includes(jobId); }
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
function ceilMoney(value) { return Math.ceil((Number(value) + Number.EPSILON) * 100) / 100; }

export function repairLeadNeedsPart(job) {
  const source = [job?.fields?.['Device / Service'], job?.fields?.Issue, job?.fields?.Notes, job?.fields?.['Job / Customer']]
    .map(lower).join(' ');
  return Boolean(source) && PART_KEYWORDS.some((keyword) => source.includes(keyword));
}

export function partIsUsableForQuote(part, job) {
  if (part?.fields?.['Research Status'] !== 'Verified') return false;
  const unitCost = numberOrNull(part.fields?.['Unit Cost']);
  const shipping = numberOrNull(part.fields?.Shipping);
  if (unitCost === null || unitCost <= 0 || shipping === null) return false;
  if (!/^https?:\/\//i.test(text(part.fields?.['Vendor URL']))) return false;

  const stock = lower(part.fields?.['Stock Status']);
  if (!stock || UNUSABLE_STOCK.some((value) => stock.includes(value))) return false;

  const jobDevice = lower(job?.fields?.['Device / Service']);
  const compatibility = lower(part.fields?.Device);
  if (jobDevice && compatibility && !compatibility.includes(jobDevice) && !jobDevice.includes(compatibility)) return false;
  return true;
}

export function minimumNormalQuoteFromVerifiedCost(partsCost) {
  const cost = numberOrNull(partsCost);
  if (cost === null || cost <= 0) throw new Error('Verified landed parts cost must be greater than zero');
  const total = ceilMoney(cost / (1 - MIN_NORMAL_GROSS_MARGIN));
  const laborPrice = Math.round((total - cost) * 100) / 100;
  return { partsCost: cost, partsPrice: cost, laborPrice, otherFees: 0, total };
}

function choosePart(parts, job) {
  const usable = parts.filter((part) => partIsUsableForQuote(part, job));
  return usable.find((part) => part.fields?.Recommended === true)
    || usable.find((part) => part.fields?.['Research Tier'] === 'Standard')
    || usable[0]
    || null;
}

function quoteForJob(quotes, jobId) {
  return quotes.find((row) => linkedToJob(row, jobId) && ['Approved', 'Ready for Owner'].includes(row.fields?.Status)) || null;
}

function holdingMessage(job) {
  const device = text(job.fields?.['Device / Service']) || 'your device';
  return `I’m still verifying the correct compatible part, current price, and availability for ${device}. I don’t want to give you a final quote until those details are confirmed. I’ll keep the quote on hold until the part information is verified.`;
}

function quoteMessage(job, total) {
  const name = text(job.fields?.['Customer Name']);
  const device = text(job.fields?.['Device / Service']) || 'your device';
  const greeting = name ? `Hi ${name}, ` : '';
  return `${greeting}I verified a compatible part and put together the repair quote for ${device}. The current quote is $${Number(total).toFixed(2)}. Part pricing and availability were verified during this research pass and can change before a part is ordered. If you’d like to move forward, let me know and I’ll confirm the next step.`;
}

export function createPartsQuotePipeline(overrides = {}) {
  const deps = {
    getRecord,
    listRecords,
    logActivity,
    updateRecord,
    createQuoteForJob,
    createRelayDraft,
    researchParts: null,
    ...overrides,
  };

  async function run(jobId) {
    let job = await deps.getRecord(TABLES.JOBS, jobId);
    if (!job) throw new Error('Repair pipeline job not found');
    if (!repairLeadNeedsPart(job)) return { applicable: false, jobId, reason: 'No clear part requirement' };
    if (job.fields?.['RELAY State'] === 'Need More Info') {
      return { applicable: true, jobId, completed: false, waitingForCustomerInfo: true };
    }

    const existingQuotes = await deps.listRecords(TABLES.QUOTES, { maxRecords: 300 });
    const existingQuote = quoteForJob(existingQuotes, jobId);
    if (existingQuote) {
      return { applicable: true, jobId, completed: true, duplicate: true, quoteId: existingQuote.id };
    }

    let parts = (await deps.listRecords(TABLES.PARTS, { maxRecords: 500 })).filter((row) => linkedToJob(row, jobId));
    let selected = choosePart(parts, job);

    if (!selected) {
      if (typeof deps.researchParts !== 'function') throw new Error('SUPPLY research runner is not configured');
      await deps.updateRecord(TABLES.JOBS, jobId, {
        'RELAY State': 'Part Research',
        'RELAY Next Action': 'SUPPLY is researching a verified compatible part, live price, shipping, and availability.',
      });
      await deps.logActivity({
        agent: 'SUPPLY', jobId, actionType: 'parts_research_started', status: 'Running',
        detail: 'Researching compatible repair parts. No purchase will be made.',
      });
      await deps.researchParts(jobId, job);
      job = await deps.getRecord(TABLES.JOBS, jobId);
      parts = (await deps.listRecords(TABLES.PARTS, { maxRecords: 500 })).filter((row) => linkedToJob(row, jobId));
      selected = choosePart(parts, job);
    }

    if (!selected) {
      const message = holdingMessage(job);
      const draft = await deps.createRelayDraft({ jobId, message, messageType: 'follow_up', channel: 'auto' });
      await deps.updateRecord(TABLES.JOBS, jobId, {
        'RELAY State': 'Part Research',
        'RELAY Reply Draft': message,
        'RELAY Next Action': 'Waiting for verified compatible part price, shipping, and availability. Retry SUPPLY research before creating a final quote.',
      });
      await deps.logActivity({
        agent: 'ATLAS', jobId, actionType: 'parts_quote_pipeline_waiting', status: 'Done',
        detail: 'Final quote withheld because verified usable part economics are incomplete. RELAY holding draft is ready for owner review.',
      });
      return { applicable: true, jobId, completed: false, waitingForVerifiedPart: true, draftId: draft.id };
    }

    const unitCost = numberOrNull(selected.fields?.['Unit Cost']);
    const shipping = numberOrNull(selected.fields?.Shipping);
    const landedCost = Math.round((unitCost + shipping) * 100) / 100;
    const pricing = minimumNormalQuoteFromVerifiedCost(landedCost);
    const customerMessage = quoteMessage(job, pricing.total);
    const summary = [
      selected.fields?.['Part / SKU'],
      selected.fields?.Vendor,
      selected.fields?.['Research Tier'],
      selected.fields?.['Vendor URL'],
    ].filter(Boolean).join(' | ');

    await deps.logActivity({
      agent: 'LEDGER', jobId, actionType: 'quote_economics_started', status: 'Running',
      detail: `Calculating quote from verified landed parts cost $${landedCost.toFixed(2)} using existing GhostOS margin rules.`,
    });

    const quoteResult = await deps.createQuoteForJob({
      jobId,
      jobName: job.fields?.['Job / Customer'],
      laborPrice: pricing.laborPrice,
      partsPrice: pricing.partsPrice,
      otherFees: pricing.otherFees,
      partsCost: pricing.partsCost,
      recommendedPartSummary: summary,
      customerMessage,
      internalNotes: `Parts + Quote Pipeline v1. Selected verified part record ${selected.id}. No purchase was made.`,
      pricingException: false,
      purchaseRequired: false,
    });

    if (quoteResult.approval?.required) {
      await deps.updateRecord(TABLES.JOBS, jobId, {
        'RELAY State': 'Awaiting Owner',
        'RELAY Next Action': `Quote requires existing Owner Inbox approval: ${quoteResult.approval.reason}`,
      });
      return { applicable: true, jobId, completed: false, quoteId: quoteResult.quote.id, approvalRequired: true };
    }

    const draft = await deps.createRelayDraft({ jobId, message: customerMessage, messageType: 'quote', channel: 'auto' });
    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY State': 'Awaiting Owner',
      'RELAY Reply Draft': customerMessage,
      'RELAY Next Action': 'Quote draft is ready. Owner reviews/edits it, copies it, sends personally, then marks it sent manually.',
    });
    await deps.logActivity({
      agent: 'ATLAS', jobId, actionType: 'parts_quote_pipeline_completed', status: 'Done',
      detail: `Verified part ${selected.id} -> quote ${quoteResult.quote.id} -> RELAY draft ${draft.id}. No purchase or customer send occurred.`,
    });

    return {
      applicable: true,
      jobId,
      completed: true,
      partId: selected.id,
      quoteId: quoteResult.quote.id,
      draftId: draft.id,
      economics: quoteResult.economics,
    };
  }

  return { run };
}
