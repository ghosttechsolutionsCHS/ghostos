import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('processed repair continuation is scheduled, newest-first, bounded, and skips jobs with existing parts or quotes', async () => {
  const source = await readFile(new URL('../netlify/functions/parts-quote-cycle.js', import.meta.url), 'utf8');

  assert.match(source, /GhostOS Dispatch Status.*Processed/);
  assert.match(source, /repairLeadNeedsPart/);
  assert.match(source, /RELAY State.*Need More Info/);
  assert.match(source, /!parts\.some/);
  assert.match(source, /!quotes\.some/);
  assert.match(source, /sort\(\(a, b\) => new Date\(b\.createdTime/);
  assert.match(source, /const selected = candidates\[0\]/);
  assert.match(source, /schedule: '\*\/2 \* \* \* \*'/);
  assert.match(source, /researchParts: ghostos\.runSupplyResearchForJob/);
  assert.doesNotMatch(source, /markRelayManuallySent|sendSms|sendEmail|purchasePart|orderPart/);
});
