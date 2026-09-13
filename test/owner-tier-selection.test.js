import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwnerPartTiers } from '../src/owner-part-tiers.js';

const device='iPhone 17 Pro Max';
const part=(id,cost,tier,name,extra={})=>({id,partName:name,compatibility:device,vendor:`Vendor ${id}`,vendorUrl:`https://example.com/${id}`,sourceTier:tier,partType:'Screen',partCost:cost,shipping:5,stockStatus:'Available',researchStatus:'Verified',recommended:false,verifiedAt:'2026-09-13T05:00:00Z',notes:'',...extra});

test('owner tiers are Cheap Medium Expensive with Medium recommended when appropriate',()=>{
  const rows=[part('a',60,'Budget','LCD'),part('b',85,'Standard','Soft OLED',{recommended:true}),part('c',125,'Premium','OEM Refurbished OLED'),part('d',95,'Standard','OLED')];
  const tiers=normalizeOwnerPartTiers(rows,device);
  assert.deepEqual(tiers.map((p)=>p.tier),['Cheap','Medium','Expensive']);
  assert.deepEqual(tiers.map((p)=>p.id),['a','b','c']);
  assert.equal(tiers[1].recommended,true);
});

test('only real trustworthy options are shown',()=>{
  const tiers=normalizeOwnerPartTiers([part('a',60,'Budget','LCD'),part('c',125,'Premium','OEM',{researchStatus:'UNVERIFIED'})],device);
  assert.equal(tiers.length,1);
  assert.equal(tiers[0].id,'a');
});
