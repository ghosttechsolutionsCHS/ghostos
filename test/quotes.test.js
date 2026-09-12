import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, quoteNeedsOwnerApproval } from '../src/quotes.js';

test('calculates quote economics deterministically', () => {
  const result = calculateQuote({ laborPrice: 120, partsPrice: 100, otherFees: 10, partsCost: 80 });
  assert.deepEqual(result, {
    labor: 120,
    parts: 100,
    fees: 10,
    cost: 80,
    total: 230,
    grossProfit: 150,
    grossMargin: 150 / 230,
  });
});

test('standard strong-margin quote does not require owner approval', () => {
  assert.deepEqual(quoteNeedsOwnerApproval({ grossMargin: 0.5 }), { required: false, type: null, reason: null });
});

test('parts purchase is consequential', () => {
  const result = quoteNeedsOwnerApproval({ grossMargin: 0.5, purchaseRequired: true });
  assert.equal(result.required, true);
  assert.equal(result.type, 'Purchase');
});

test('low margin quote requires pricing approval', () => {
  const result = quoteNeedsOwnerApproval({ grossMargin: 0.2 });
  assert.equal(result.required, true);
  assert.equal(result.type, 'Pricing Exception');
});
