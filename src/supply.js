import { TABLES, createRecord, listRecords, logActivity, updateRecord } from './airtable.js';

function text(value) { return String(value ?? '').trim(); }
function lower(value) { return text(value).toLowerCase(); }
function linkedToJob(row, jobId) { return Array.isArray(row.fields?.Job) && row.fields.Job.includes(jobId); }
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
function canonicalUrl(value) {
  try {
    const url = new URL(text(value));
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch { return ''; }
}
function researchKey(part) {
  return [lower(part.tier), lower(part.vendor), lower(part.partOrSku)].join('|');
}
function rowResearchKey(row) {
  return [lower(row.fields?.['Research Tier']), lower(row.fields?.Vendor), lower(row.fields?.['Part / SKU'])].join('|');
}

export function normalizeSupplyPart(part = {}) {
  const verified = Boolean(part.verified);
  const unitCost = numberOrNull(part.unitCost);
  const shipping = numberOrNull(part.shipping);
  const vendorUrl = /^https?:\/\//i.test(text(part.vendorUrl)) ? text(part.vendorUrl) : '';
  const compatibility = text(part.compatibility || part.device) || 'UNKNOWN';
  const stockStatus = text(part.stockStatus) || 'UNKNOWN';
  const shippingInfo = text(part.shippingInfo) || (shipping === null ? 'UNKNOWN' : `$${shipping.toFixed(2)}`);
  const notes = [
    `Compatibility: ${compatibility}`,
    `Shipping: ${shippingInfo}`,
    `Verification: ${verified ? 'VERIFIED' : 'UNVERIFIED'}`,
    text(part.notes),
  ].filter(Boolean).join('\n');

  return {
    tier: text(part.tier) || 'Standard',
    partOrSku: text(part.partOrSku) || 'UNKNOWN',
    device: compatibility,
    partType: text(part.partType) || '',
    vendor: text(part.vendor) || 'UNKNOWN',
    vendorUrl,
    unitCost,
    shipping,
    stockStatus,
    verified,
    notes,
    recommended: Boolean(part.recommended),
  };
}

export function createSupplyStore(overrides = {}) {
  const deps = { createRecord, listRecords, logActivity, updateRecord, now: () => new Date().toISOString(), ...overrides };

  async function store(jobId, rawParts = []) {
    if (!jobId) throw new Error('jobId is required');
    if (!Array.isArray(rawParts) || !rawParts.length) throw new Error('At least one researched part is required');

    const existingRows = (await deps.listRecords(TABLES.PARTS, { maxRecords: 500 })).filter((row) => linkedToJob(row, jobId));
    const stored = [];
    const stamp = deps.now();

    for (const rawPart of rawParts.slice(0, 3)) {
      const part = normalizeSupplyPart(rawPart);
      const key = researchKey(part);
      const urlKey = canonicalUrl(part.vendorUrl);
      const existing = existingRows.find((row) => urlKey && canonicalUrl(row.fields?.['Vendor URL']) === urlKey)
        || existingRows.find((row) => rowResearchKey(row) === key);
      const fields = {
        'Part / SKU': part.partOrSku,
        Job: [jobId],
        Device: part.device,
        'Part Type': part.partType,
        Vendor: part.vendor,
        'Purchase Status': 'Researching',
        'Research Tier': part.tier,
        'Research Status': part.verified ? 'Verified' : 'Unverified',
        'Stock Status': part.stockStatus,
        'Researched At': stamp,
        Recommended: part.recommended,
        Notes: part.notes,
      };
      if (part.vendorUrl) fields['Vendor URL'] = part.vendorUrl;
      if (part.unitCost !== null) fields['Unit Cost'] = part.unitCost;
      if (part.shipping !== null) fields.Shipping = part.shipping;

      let record;
      if (existing) {
        record = await deps.updateRecord(TABLES.PARTS, existing.id, fields);
      } else {
        record = await deps.createRecord(TABLES.PARTS, fields);
        existingRows.push(record);
      }
      stored.push(record);
    }

    await deps.updateRecord(TABLES.JOBS, jobId, {
      'RELAY State': 'Part Research',
      'RELAY Next Action': stored.some((row) => row.fields?.['Research Status'] === 'Verified')
        ? 'SUPPLY research stored. Continue to verified quote economics.'
        : 'SUPPLY could not verify a usable part yet. Keep the customer informed truthfully and retry research before final quoting.',
    });
    await deps.logActivity({
      agent: 'SUPPLY',
      jobId,
      actionType: 'parts_research_stored',
      status: 'Done',
      detail: `${stored.length} option(s) stored or refreshed without purchasing anything.`,
    });

    return stored;
  }

  return { store };
}

export async function storeSupplyResults(jobId, parts) {
  return createSupplyStore().store(jobId, parts);
}
