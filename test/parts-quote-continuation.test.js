import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recentContinuationInFlight } from '../netlify/functions/parts-quote-cycle.js';

test('processed repair continuation is scheduled, newest-first, bounded, and skips jobs with existing parts or quotes', async () => {
  const source = await readFile(new URL('../netlify/functions/parts-quote-cycle.js', import.meta.url), 'utf8');

  assert.match(source, /GhostOS Dispatch Status.*Processed/);
  assert.match(source, /repairLeadNeedsPart/);
  assert.match(source, /RELAY State.*Need More Info/);
  assert.match(source, /!parts\.some/);
  assert.match(source, /!quotes\.some/);
  assert.match(source, /recentContinuationInFlight/);
  assert.match(source, /sort\(\(a, b\) => new Date\(b\.createdTime/);
  assert.match(source, /const selected = candidates\[0\]/);
  assert.match(source, /schedule: '\*\/2 \* \* \* \*'/);
  assert.match(source, /researchParts: ghostos\.runSupplyResearchForJob/);
  assert.doesNotMatch(source, /markRelayManuallySent|sendSms|sendEmail|purchasePart|orderPart/);
});

test('fresh continuation start blocks overlapping cycle until a newer terminal event exists', () => {
  const now = Date.parse('2026-09-13T04:15:00.000Z');
  const start = { createdTime:'2026-09-13T04:14:30.000Z', fields:{ Job:['job1'], 'Action Type':'parts_quote_continuation_started', 'Created At':'2026-09-13T04:14:30.000Z' } };
  assert.equal(recentContinuationInFlight([start], 'job1', now), true);

  const done = { createdTime:'2026-09-13T04:14:55.000Z', fields:{ Job:['job1'], 'Action Type':'parts_quote_continuation_completed', 'Created At':'2026-09-13T04:14:55.000Z' } };
  assert.equal(recentContinuationInFlight([start, done], 'job1', now), false);
});

test('stale continuation lock expires so provider failures remain retryable', () => {
  const now = Date.parse('2026-09-13T04:18:01.000Z');
  const start = { createdTime:'2026-09-13T04:14:30.000Z', fields:{ Job:['job1'], 'Action Type':'parts_quote_continuation_started', 'Created At':'2026-09-13T04:14:30.000Z' } };
  assert.equal(recentContinuationInFlight([start], 'job1', now), false);
});
