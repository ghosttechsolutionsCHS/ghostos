import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwnerPartTiers } from '../src/owner-part-tiers.js';
const d='iPhone 17 Pro Max';
const a={id:'a',partName:'LCD',compatibility:d,vendor:'A',vendorUrl:'https://example.com/a',sourceTier:'Budget',partType:'Screen',partCost:60,shipping:5,stockStatus:'Available',researchStatus:'Verified',recommended:false};
const b={id:'b',partName:'OEM',compatibility:d,vendor:'B',vendorUrl:'https://example.com/b',sourceTier:'Premium',partType:'Screen',partCost:120,shipping:5,stockStatus:'Available',researchStatus:'Verified',recommended:false};
test('two verified options remain two tiers',()=>{const r=normalizeOwnerPartTiers([a,b],d);assert.equal(r.length,2);assert.deepEqual(r.map(x=>x.tier),['Cheap','Expensive'])});
