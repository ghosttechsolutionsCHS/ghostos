import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketingDataService, normalizeMarketingRows } from '../src/marketing-data.js';

test('unconfigured Windsor service returns explicit empty structures without fabricated data',async()=>{
  const snapshot=await createMarketingDataService({env:{},fetchImpl:async()=>{throw new Error('should not call')}}).snapshot();
  assert.equal(snapshot.source.provider,'windsor');
  assert.equal(snapshot.source.configured,false);
  assert.deepEqual(snapshot.channelMetrics,[]);
  assert.deepEqual(snapshot.campaignMetrics,[]);
  assert.deepEqual(snapshot.attribution,[]);
  assert.deepEqual(snapshot.recommendations,[]);
  assert.deepEqual(snapshot.agentActivity,[]);
});

test('normalizer calculates profitability metrics from supplied rows only',()=>{
  const result=normalizeMarketingRows([{platform:'Google Ads',campaign:'Screen Repair',spend:200,leads:20,completed_jobs:5,revenue:1000,gross_profit:600}]);
  assert.equal(result.campaignMetrics.length,1);
  assert.equal(result.campaignMetrics[0].costPerLead,10);
  assert.equal(result.campaignMetrics[0].cac,40);
  assert.equal(result.campaignMetrics[0].profitAfterSpend,400);
  assert.equal(result.channelMetrics[0].grossProfit,600);
});

test('Windsor provider is read-only and reports source errors safely',async()=>{
  let request;
  const service=createMarketingDataService({
    env:{WINDSOR_API_URL:'https://example.test/windsor',WINDSOR_API_KEY:'secret-value'},
    fetchImpl:async(url,options)=>{request={url,options};return {ok:false,status:503,json:async()=>({})};},
  });
  const snapshot=await service.snapshot();
  assert.equal(request.options.method,'GET');
  assert.equal(snapshot.source.configured,true);
  assert.equal(snapshot.source.error,'Windsor source returned HTTP 503');
  assert.equal(JSON.stringify(snapshot).includes('secret-value'),false);
});
