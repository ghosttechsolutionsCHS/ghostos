import test from 'node:test';
import assert from 'node:assert/strict';
import { tierEconomics } from '../src/owner-part-tiers.js';

const part={partCost:95,shipping:5,stockStatus:'Available'};

test('tier economics uses landed cost and existing margin rule',()=>{
  const r=tierEconomics(part);
  assert.equal(r.ready,true);
  assert.equal(r.partsCost,100);
  assert.equal(r.total,142.86);
  assert.equal(r.grossProfit,42.86);
  assert.ok(r.grossMargin>=0.30);
});

test('unknown shipping or stock keeps tier economics not ready',()=>{
  assert.equal(tierEconomics({...part,shipping:null}).ready,false);
  assert.equal(tierEconomics({...part,stockStatus:'UNKNOWN'}).ready,false);
});
