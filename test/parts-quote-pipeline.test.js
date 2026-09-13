import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TABLES } from '../src/airtable.js';
import { calculateQuote } from '../src/quotes.js';
import { createPartsQuotePipeline, minimumNormalQuoteFromVerifiedCost, repairLeadNeedsPart } from '../src/parts-quote-pipeline.js';
import { createSupplyStore } from '../src/supply.js';

function makeJob(fields = {}) {
  return {
    id: 'job-saif',
    fields: {
      'Job / Customer': 'Saif - Apple (iPhone) - iPhone 17 Pro Max - Cracked screen',
      'Customer Name': 'Saif',
      'Device / Service': 'Apple (iPhone) - iPhone 17 Pro Max',
      Issue: 'Just broken glass. Touch works fine - Cracked screen',
      Status: 'New Lead',
      'RELAY State': 'Awaiting Owner',
      'RELAY Reply Draft': 'I’m checking inventory for the correct screen.',
      ...fields,
    },
  };
}

function pipelineHarness({ researchMode = 'verified' } = {}) {
  const job = makeJob();
  const parts = [];
  const quotes = [];
  const drafts = [];
  const activity = [];
  let researchCalls = 0;
  let quoteCalls = 0;

  const getRecord = async (table, id) => {
    assert.equal(table, TABLES.JOBS);
    assert.equal(id, job.id);
    return job;
  };
  const listRecords = async (table) => {
    if (table === TABLES.PARTS) return parts;
    if (table === TABLES.QUOTES) return quotes;
    return [];
  };
  const updateRecord = async (table, id, fields) => {
    assert.equal(table, TABLES.JOBS);
    assert.equal(id, job.id);
    Object.assign(job.fields, fields);
    return job;
  };
  const logActivity = async (entry) => { activity.push(entry); return { id: `act${activity.length}`, fields: entry }; };
  const createRelayDraft = async ({ jobId, message, messageType, channel }) => {
    assert.equal(jobId, job.id);
    assert.equal(channel, 'auto');
    const existing = drafts.find((row) => row.fields.Body === message && row.fields['Message Type'] === messageType);
    if (existing) return existing;
    const row = { id: `draft${drafts.length + 1}`, fields: { Job: [jobId], Body: message, 'Message Type': messageType, Status: 'Pending' } };
    drafts.push(row);
    return row;
  };
  const createQuoteForJob = async (args) => {
    quoteCalls += 1;
    assert.equal(args.purchaseRequired, false, 'pipeline must never request an automatic purchase');
    assert.equal(args.pricingException, false);
    const economics = calculateQuote(args);
    const row = { id: `quote${quotes.length + 1}`, fields: { Job: [args.jobId], Status: 'Approved', 'Total Quote': economics.total } };
    quotes.push(row);
    return { quote: row, economics, approval: { required: false, type: null, reason: null } };
  };
  const researchParts = async () => {
    researchCalls += 1;
    if (researchMode === 'verified') {
      parts.push({
        id: 'part1',
        fields: {
          Job: [job.id],
          'Part / SKU': 'iPhone 17 Pro Max OLED Screen Assembly',
          Device: 'Apple (iPhone) - iPhone 17 Pro Max',
          Vendor: 'Injured Gadgets',
          'Vendor URL': 'https://www.injuredgadgets.com/example-screen',
          'Unit Cost': 120,
          Shipping: 10,
          'Research Tier': 'Standard',
          'Research Status': 'Verified',
          'Stock Status': 'In Stock',
          Recommended: true,
        },
      });
    } else {
      parts.push({
        id: 'part-unverified',
        fields: {
          Job: [job.id],
          'Part / SKU': 'iPhone 17 Pro Max Screen',
          Device: 'Apple (iPhone) - iPhone 17 Pro Max',
          Vendor: 'Injured Gadgets',
          'Research Tier': 'Standard',
          'Research Status': 'Unverified',
          'Stock Status': 'UNKNOWN',
        },
      });
    }
  };

  const pipeline = createPartsQuotePipeline({ getRecord, listRecords, updateRecord, logActivity, createRelayDraft, createQuoteForJob, researchParts });
  return { job, parts, quotes, drafts, activity, pipeline, get researchCalls(){return researchCalls;}, get quoteCalls(){return quoteCalls;} };
}

test('Saif-shaped fresh cracked-screen repair automatically delegates to SUPPLY then LEDGER then RELAY', async () => {
  const h = pipelineHarness({ researchMode: 'verified' });
  assert.equal(repairLeadNeedsPart(h.job), true);

  const result = await h.pipeline.run(h.job.id);
  assert.equal(result.completed, true);
  assert.equal(h.researchCalls, 1);
  assert.equal(h.quoteCalls, 1);
  assert.equal(h.quotes.length, 1);
  assert.equal(h.drafts.filter((d) => d.fields['Message Type'] === 'quote').length, 1);
  assert.ok(h.activity.some((a) => a.agent === 'SUPPLY' && a.status === 'Running' && a.actionType === 'parts_research_started'));
  assert.ok(h.activity.some((a) => a.agent === 'LEDGER' && a.status === 'Running' && a.actionType === 'quote_economics_started'));
  assert.match(h.job.fields['RELAY Next Action'], /Owner reviews\/edits/);
  assert.equal(h.job.fields['RELAY State'], 'Awaiting Owner');
});

test('quote recommendation uses the existing 30% normal-margin boundary and verified landed cost', () => {
  const pricing = minimumNormalQuoteFromVerifiedCost(130);
  const economics = calculateQuote(pricing);
  assert.equal(pricing.partsCost, 130);
  assert.equal(pricing.partsPrice, 130);
  assert.equal(pricing.otherFees, 0);
  assert.ok(economics.grossMargin >= 0.30);
  assert.ok(economics.total >= 130);
});

test('repeated pipeline cycles do not duplicate quotes or RELAY quote drafts', async () => {
  const h = pipelineHarness({ researchMode: 'verified' });
  await h.pipeline.run(h.job.id);
  const first = { research: h.researchCalls, quotes: h.quotes.length, drafts: h.drafts.length };
  const second = await h.pipeline.run(h.job.id);

  assert.equal(second.duplicate, true);
  assert.equal(h.researchCalls, first.research);
  assert.equal(h.quotes.length, first.quotes);
  assert.equal(h.drafts.length, first.drafts);
});

test('unverified or unavailable part research cannot produce a fake final quote', async () => {
  const h = pipelineHarness({ researchMode: 'unverified' });
  const result = await h.pipeline.run(h.job.id);

  assert.equal(result.waitingForVerifiedPart, true);
  assert.equal(h.quoteCalls, 0);
  assert.equal(h.quotes.length, 0);
  assert.equal(h.drafts.filter((d) => d.fields['Message Type'] === 'quote').length, 0);
  assert.equal(h.drafts.filter((d) => d.fields['Message Type'] === 'follow_up').length, 1);
  assert.match(h.job.fields['RELAY Next Action'], /Waiting for verified compatible part/);
});

test('SUPPLY persistence refreshes same job/part/tier/vendor instead of creating duplicates', async () => {
  const rows = [];
  const job = makeJob();
  const activity = [];
  const deps = {
    now: () => '2026-09-13T03:30:00.000Z',
    listRecords: async (table) => table === TABLES.PARTS ? rows : [],
    createRecord: async (table, fields) => {
      assert.equal(table, TABLES.PARTS);
      const row = { id: `part${rows.length + 1}`, fields: { ...fields } };
      rows.push(row);
      return row;
    },
    updateRecord: async (table, id, fields) => {
      if (table === TABLES.JOBS) { Object.assign(job.fields, fields); return job; }
      assert.equal(table, TABLES.PARTS);
      const row = rows.find((item) => item.id === id);
      Object.assign(row.fields, fields);
      return row;
    },
    logActivity: async (entry) => { activity.push(entry); return { id: `act${activity.length}`, fields: entry }; },
  };
  const store = createSupplyStore(deps);
  const research = [{
    tier: 'Standard',
    partOrSku: 'iPhone 17 Pro Max OLED Screen Assembly',
    compatibility: 'Apple (iPhone) - iPhone 17 Pro Max',
    partType: 'Screen Assembly',
    vendor: 'Injured Gadgets',
    vendorUrl: 'https://www.injuredgadgets.com/example-screen',
    unitCost: 120,
    shipping: 10,
    shippingInfo: '$10 shipping',
    stockStatus: 'In Stock',
    verified: true,
    recommended: true,
  }];

  await store.store(job.id, research);
  await store.store(job.id, research);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields['Research Status'], 'Verified');
  assert.equal(rows[0].fields['Purchase Status'], 'Researching');
  assert.equal(rows[0].fields['Unit Cost'], 120);
  assert.equal(rows[0].fields.Shipping, 10);
});

test('SUPPLY persists UNKNOWN/UNVERIFIED without fabricated price or URL', async () => {
  const rows = [];
  const job = makeJob();
  const store = createSupplyStore({
    listRecords: async () => rows,
    createRecord: async (_table, fields) => { const row = { id: 'part1', fields: { ...fields } }; rows.push(row); return row; },
    updateRecord: async (table, _id, fields) => { if (table === TABLES.JOBS) { Object.assign(job.fields, fields); return job; } return rows[0]; },
    logActivity: async () => ({ id: 'act1' }),
    now: () => '2026-09-13T03:30:00.000Z',
  });

  await store.store(job.id, [{ tier:'Standard', partOrSku:'UNKNOWN compatible screen', compatibility:job.fields['Device / Service'], vendor:'Injured Gadgets', stockStatus:'UNKNOWN', verified:false }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields['Research Status'], 'Unverified');
  assert.equal('Unit Cost' in rows[0].fields, false);
  assert.equal('Shipping' in rows[0].fields, false);
  assert.equal('Vendor URL' in rows[0].fields, false);
});

test('Parts + Quote pipeline contains no automatic purchase or customer-send execution path', async () => {
  const source = await readFile(new URL('../src/parts-quote-pipeline.js', import.meta.url), 'utf8');
  assert.match(source, /purchaseRequired: false/);
  assert.doesNotMatch(source, /markRelayManuallySent|sendSms|sendEmail|purchasePart|orderPart/);
  assert.match(source, /createRelayDraft/);
});
