import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayDeliveryService } from '../src/relay-delivery.js';

function memoryDeps({ jobFields = {} } = {}) {
  const jobs = new Map([['job1', { id: 'job1', fields: {
    'Job / Customer': 'Test Customer',
    'Customer Name': 'Test Customer',
    Phone: '+18435550199',
    Email: 'customer@example.com',
    Status: 'Quoted',
    'RELAY State': 'Awaiting Customer',
    ...jobFields,
  } }]]);
  const messages = [];
  const activity = [];
  let seq = 1;

  const deps = {
    now: () => '2026-09-12T23:30:00.000Z',
    async getRecord(table, id) {
      if (table === 'Leads & Jobs') return structuredClone(jobs.get(id));
      if (table === 'RELAY Messages') return structuredClone(messages.find((r) => r.id === id));
      throw new Error(`Unexpected get ${table}`);
    },
    async listRecords(table, options = {}) {
      if (table === 'RELAY Messages') {
        const formula = options.filterByFormula || '';
        const keyMatch = formula.match(/\{Idempotency Key\}='([^']+)'/);
        const providerMatch = formula.match(/\{Provider Message ID\}='([^']+)'/);
        return structuredClone(messages.filter((record) => {
          if (keyMatch) return record.fields['Idempotency Key'] === keyMatch[1];
          if (providerMatch) return record.fields['Provider Message ID'] === providerMatch[1];
          return true;
        }));
      }
      return [];
    },
    async createRecord(table, fields) {
      if (table !== 'RELAY Messages') throw new Error(`Unexpected create ${table}`);
      const record = { id: `relay${seq++}`, fields: structuredClone(fields) };
      messages.push(record);
      return structuredClone(record);
    },
    async updateRecord(table, id, fields) {
      if (table === 'Leads & Jobs') {
        const record = jobs.get(id);
        Object.assign(record.fields, structuredClone(fields));
        return structuredClone(record);
      }
      if (table === 'RELAY Messages') {
        const record = messages.find((item) => item.id === id);
        Object.assign(record.fields, structuredClone(fields));
        return structuredClone(record);
      }
      throw new Error(`Unexpected update ${table}`);
    },
    async logActivity(entry) { activity.push(structuredClone(entry)); return entry; },
  };

  return { deps, messages, jobs, activity };
}

const draftArgs = {
  jobId: 'job1',
  message: 'Your repair quote is ready.',
  messageType: 'quote',
  channel: 'sms',
};

test('creating a RELAY draft requires no outbound provider and sends nothing', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);

  assert.equal(memory.messages.length, 1);
  assert.equal(draft.fields.Status, 'Pending');
  assert.equal(draft.fields.Provider, '');
  assert.equal(draft.fields['Send Method'], '');
  assert.equal(memory.jobs.get('job1').fields['Last Contacted'], undefined);
});

test('owner can edit a draft before copying without sending anything', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  const updated = await service.updateDraft({ messageId: draft.id, message: 'Updated customer message.' });

  assert.equal(updated.fields.Body, 'Updated customer message.');
  assert.equal(updated.fields.Status, 'Pending');
  assert.equal(updated.fields['Manual Sent At'], null);
  assert.equal(memory.jobs.get('job1').fields['RELAY Reply Draft'], 'Updated customer message.');
  assert.equal(memory.jobs.get('job1').fields['Last Contacted'], undefined);
});

test('manual Mark as Sent records owner report, timestamp and method but never delivery', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  const result = await service.markManuallySent({ messageId: draft.id });

  assert.equal(result.sent, true);
  assert.equal(result.delivered, false);
  assert.equal(result.manual, true);
  assert.equal(memory.messages[0].fields.Status, 'Sent');
  assert.equal(memory.messages[0].fields['Manual Sent At'], '2026-09-12T23:30:00.000Z');
  assert.equal(memory.messages[0].fields['Send Method'], 'owner_phone_copy_paste');
  assert.equal(memory.messages[0].fields['Provider Status'], 'owner_reported_sent');
  assert.equal(memory.messages[0].fields['Delivered At'], null);
  assert.equal(memory.jobs.get('job1').fields['Last Contacted'], '2026-09-12T23:30:00.000Z');
  assert.match(memory.jobs.get('job1').fields['RELAY Next Action'], /Delivery is not verified/i);
});

test('Mark as Sent stores final edited text if owner changed it before sending', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  await service.markManuallySent({ messageId: draft.id, message: 'This is the exact text I sent.' });

  assert.equal(memory.messages[0].fields.Body, 'This is the exact text I sent.');
  assert.equal(memory.jobs.get('job1').fields['RELAY Reply Draft'], 'This is the exact text I sent.');
});

test('duplicate Mark as Sent is idempotent', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  const first = await service.markManuallySent({ messageId: draft.id });
  const second = await service.markManuallySent({ messageId: draft.id });

  assert.equal(first.sent, true);
  assert.equal(second.sent, true);
  assert.equal(second.duplicate, true);
  assert.equal(memory.messages[0].fields['Manual Sent At'], first.manualSentAt);
});

test('SMS opt-out keeps draft visible but blocks manual Mark as Sent', async () => {
  const memory = memoryDeps({ jobFields: { 'RELAY SMS Opted Out': true } });
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  const result = await service.markManuallySent({ messageId: draft.id });

  assert.equal(result.blocked, true);
  assert.match(result.reason, /opted out/i);
  assert.equal(memory.messages[0].fields.Status, 'Pending');
  assert.equal(memory.messages[0].fields['Manual Sent At'], undefined);
});

test('manual owner-reported sends can never be upgraded to Delivered by a provider callback', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  await service.markManuallySent({ messageId: draft.id });

  await assert.rejects(
    service.applyDeliveryCallback({ idempotencyKey: memory.messages[0].fields['Idempotency Key'], status: 'delivered' }),
    /Manual owner-reported messages cannot be updated/i,
  );
  assert.equal(memory.messages[0].fields['Delivered At'], null);
});

test('legacy provider callback behavior remains isolated for historical provider-tracked records', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const draft = await service.createDraft(draftArgs);
  Object.assign(memory.messages[0].fields, {
    Status: 'Sent',
    Provider: 'legacy-provider',
    'Provider Message ID': 'legacy-123',
    'Provider Status': 'sent',
    'Send Method': '',
    'Manual Sent At': null,
  });

  const callback = await service.applyDeliveryCallback({
    providerMessageId: 'legacy-123',
    status: 'delivered',
    timestamp: '2026-09-12T23:35:00.000Z',
  });

  assert.equal(callback.delivered, true);
  assert.equal(memory.messages[0].fields.Status, 'Delivered');
  assert.equal(memory.messages[0].fields['Delivered At'], '2026-09-12T23:35:00.000Z');
});
