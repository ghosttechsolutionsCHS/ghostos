import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition } from '../src/state-machine.js';

test('allows normal lead progression', () => {
  assert.equal(canTransition('New Lead', 'Need Quote'), true);
  assert.equal(canTransition('Need Quote', 'Quoted'), true);
  assert.equal(canTransition('Quoted', 'Awaiting Customer'), true);
  assert.equal(canTransition('Scheduled', 'In Progress'), true);
  assert.equal(canTransition('In Progress', 'Completed'), true);
});

test('blocks unsafe state jumps', () => {
  assert.equal(canTransition('New Lead', 'Completed'), false);
  assert.equal(canTransition('Completed', 'In Progress'), false);
  assert.throws(() => assertTransition('New Lead', 'Part Ordered'), /Invalid job state transition/);
});

test('allows lost jobs to be reopened only as new leads', () => {
  assert.equal(canTransition('Lost / Declined', 'New Lead'), true);
  assert.equal(canTransition('Lost / Declined', 'Completed'), false);
});
