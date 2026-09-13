import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwnerPartTiers } from '../src/owner-part-tiers.js';
const d='iPhone 17 Pro Max';
const a={id:'a',partName:'Soft OLED',compatibility:d,vendor:'A',vendorUrl:'https://example.com/a',sourceTier:'Standard',partType:'Screen',partCost:90,shipping:5,stockStatus:'Available',researchStatus:'Verified',recommended:true};
test('single trustworthy option is shown without invented companions',()=>{const r=normalizeOwnerPartTiers([a],d);assert.equal(r.length,1);assert.equal(r[0].tier,'Medium');assert.equal(r[0].recommended,true)});
