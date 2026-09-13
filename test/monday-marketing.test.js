import test from 'node:test';
import assert from 'node:assert/strict';
import { MONDAY_PAID_PLAN, ORGANIC_CONTENT_QUEUE, FREE_ACQUISITION_QUEUE } from '../src/monday-marketing.js';
import { createWindsorMarketingReader, summarizeGoogleAds } from '../src/windsor-marketing.js';

test('FORGE plan is prepared but cannot write or exceed owner ceiling',()=>{
  assert.equal(MONDAY_PAID_PLAN.status,'PREPARED_NOT_LAUNCHED');
  assert.deepEqual(MONDAY_PAID_PLAN.dailyTarget,{min:10,max:15});
  assert.equal(MONDAY_PAID_PLAN.weeklyHardCeiling,200);
  assert.equal(MONDAY_PAID_PLAN.externalWriteAuthorized,false);
  assert.match(MONDAY_PAID_PLAN.geography,/25 miles/i);
  assert.match(MONDAY_PAID_PLAN.objective,/profitable completed repair jobs/i);
});

test('organic and free queues remain manual and truthful',()=>{
  assert.ok(ORGANIC_CONTENT_QUEUE.length>=3);
  assert.ok(ORGANIC_CONTENT_QUEUE.some(x=>x.requiresRealAsset));
  assert.ok(FREE_ACQUISITION_QUEUE.length>=3);
  assert.ok(FREE_ACQUISITION_QUEUE.every(x=>x.automaticPosting===false));
  assert.ok(FREE_ACQUISITION_QUEUE.some(x=>x.ruleCheckRequired));
});

test('Windsor reader reports missing runtime credential without fabricating metrics',async()=>{
  const reader=createWindsorMarketingReader({env:{},fetchImpl:async()=>{throw new Error('should not fetch')}});
  const snap=await reader.snapshot();
  assert.equal(snap.configured,false);
  assert.equal(snap.sources.googleAds.available,false);
  const paid=summarizeGoogleAds(snap.sources.googleAds);
  assert.equal(paid.spend,null);
  assert.equal(paid.campaigns.length,0);
});

test('Windsor Google Ads summary uses only returned rows',async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify([{campaign:'Screen Search',campaign_id:'1',spend:12.5,clicks:4,impressions:100,conversions:1,conversion_value:160}]),{status:200,headers:{'content-type':'application/json'}});
  const reader=createWindsorMarketingReader({env:{WINDSOR_API_KEY:'test-key'},fetchImpl});
  const source=await reader.readSource('googleAds');
  const paid=summarizeGoogleAds(source);
  assert.equal(paid.available,true);
  assert.equal(paid.spend,12.5);
  assert.equal(paid.conversions,1);
  assert.equal(paid.campaigns[0].name,'Screen Search');
});
