import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayDeliveryService } from '../src/relay-delivery.js';

function memoryDeps({ jobFields = {}, approvals = [], providerResult } = {}) {
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
  let sends = 0;
  let seq = 1;

  const deps = {
    now: () => '2026-09-12T23:30:00.000Z',
    provider: {
      name: 'test-provider',
      async send() {
        sends += 1;
        return providerResult || {
          ok: true,
          provider: 'test-provider',
          providerMessageId: 'msg-123',
          status: 'sent',
          confirmedAt: '2026-09-12T23:30:00.000Z',
        };
      },
    },
    async getRecord(table, id) {
      if (table === 'Leads & Jobs') return structuredClone(jobs.get(id));
      throw new Error(`Unexpected get ${table}`);
    },
    async listRecords(table, options = {}) {
      if (table === 'Owner Inbox') return structuredClone(approvals);
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

  return {
    deps,
    messages,
    jobs,
    activity,
    get sends() { return sends; },
  };
}

const messageArgs = {
  jobId: 'job1',
  message: 'Your repair quote is ready.',
  messageType: 'quote',
  channel: 'sms',
};

test('marks sent only after provider confirms success and stores provider metadata', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const result = await service.deliverRoutineMessage(messageArgs);

  assert.equal(result.sent, true);
  assert.equal(result.delivered, false);
  assert.equal(result.providerMessageId, 'msg-123');
  assert.equal(memory.sends, 1);
  assert.equal(memory.messages.length, 1);
  assert.equal(memory.messages[0].fields.Status, 'Sent');
  assert.equal(memory.messages[0].fields['Provider Message ID'], 'msg-123');
  assert.equal(memory.messages[0].fields.Destination, '+18435550199');
  assert.equal(memory.messages[0].fields.Job[0], 'job1');
  assert.equal(memory.messages[0].fields['Sent At'], '2026-09-12T23:30:00.000Z');
});

test('provider failure is recorded and is never reported as sent or delivered', async () => {
  const memory = memoryDeps({
    providerResult: { ok: false, status: 'failed', failureReason: 'carrier rejected destination' },
  });
  const service = createRelayDeliveryService(memory.deps);
  const result = await service.deliverRoutineMessage(messageArgs);

  assert.equal(result.sent, false);
  assert.equal(result.delivered, false);
  assert.equal(memory.messages[0].fields.Status, 'Failed');
  assert.match(memory.messages[0].fields['Failure Reason'], /carrier rejected/);
  assert.equal(memory.jobs.get('job1').fields['Last Contacted'], undefined);
});

test('duplicate prevention reuses the same ledger entry and never sends twice', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const first = await service.deliverRoutineMessage(messageArgs);
  const second = await service.deliverRoutineMessage(messageArgs);

  assert.equal(first.sent, true);
  assert.equal(second.duplicate, true);
  assert.equal(memory.sends, 1);
  assert.equal(memory.messages.length, 1);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
});

test('SMS opt-out blocks provider calls and records an opted-out ledger result', async () => {
  const memory = memoryDeps({ jobFields: { 'RELAY SMS Opted Out': true } });
  const service = createRelayDeliveryService(memory.deps);
  const result = await service.deliverRoutineMessage(messageArgs);

  assert.equal(result.blocked, true);
  assert.match(result.reason, /opted out/i);
  assert.equal(memory.sends, 0);
  assert.equal(memory.messages[0].fields.Status, 'Opted Out');
});

test('pending Owner Inbox approval blocks sending even if RELAY State is not Awaiting Owner', async () => {
  const memory = memoryDeps({
    approvals: [{ id: 'approval1', fields: { Status: 'Pending', Job: ['job1'] } }],
  });
  const service = createRelayDeliveryService(memory.deps);
  const result = await service.deliverRoutineMessage(messageArgs);

  assert.equal(result.blocked, true);
  assert.match(result.reason, /Owner Inbox approval/);
  assert.equal(memory.sends, 0);
  assert.equal(memory.messages[0].fields.Status, 'Blocked');
});

test('failed sends require explicit retry and remain capped/idempotent', async () => {
  let attempt = 0;
  const memory = memoryDeps();
  memory.deps.provider.send = async () => {
    attempt += 1;
    return attempt === 1
      ? { ok: false, status: 'failed', failureReason: 'temporary provider failure' }
      : { ok: true, provider: 'test-provider', providerMessageId: 'msg-retry', status: 'sent', confirmedAt: '2026-09-12T23:31:00.000Z' };
  };
  const service = createRelayDeliveryService(memory.deps);
  const first = await service.deliverRoutineMessage(messageArgs);
  const withoutRetry = await service.deliverRoutineMessage(messageArgs);
  const retried = await service.deliverRoutineMessage({ ...messageArgs, retry: true });

  assert.equal(first.sent, false);
  assert.equal(withoutRetry.retryRequired, true);
  assert.equal(retried.sent, true);
  assert.equal(memory.messages.length, 1);
  assert.equal(memory.messages[0].fields.Attempt, 2);
});

test('delivery callback upgrades a sent message to delivered only on provider confirmation', async () => {
  const memory = memoryDeps();
  const service = createRelayDeliveryService(memory.deps);
  const sent = await service.deliverRoutineMessage(messageArgs);
  const callback = await service.applyDeliveryCallback({
    providerMessageId: sent.providerMessageId,
    status: 'delivered',
    timestamp: '2026-09-12T23:35:00.000Z',
  });

  assert.equal(callback.delivered, true);
  assert.equal(memory.messages[0].fields.Status, 'Delivered');
  assert.equal(memory.messages[0].fields['Delivered At'], '2026-09-12T23:35:00.000Z');
});
