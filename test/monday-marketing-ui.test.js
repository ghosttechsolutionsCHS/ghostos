import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page=await readFile(new URL('../public/monday-marketing.html',import.meta.url),'utf8');
const api=await readFile(new URL('../netlify/functions/monday-marketing.js',import.meta.url),'utf8');
const launch=await readFile(new URL('../src/monday-marketing.js',import.meta.url),'utf8');

test('Monday launch owner view exposes required acquisition and economics sections',()=>{
  for(const label of ['ATLAS Monday Marketing Brief','Today’s marketing actions','Prepared paid campaign','ECHO organic queue','SCOUT free opportunities','BEACON funnel fixes','HORIZON profit attribution','Owner attention'])assert.match(page,new RegExp(label));
  for(const label of ['New leads','Booked jobs','Completed jobs','Spend','Revenue','Parts cost','Gross profit','CAC'])assert.match(page,new RegExp(label));
});

test('Monday launch preserves external-action boundaries',()=>{
  assert.match(launch,/externalWriteAuthorized:false/);
  assert.match(launch,/automaticPosting:false/);
  assert.match(launch,/googleAdsWrites:false/);
  assert.match(launch,/organicAutoPublish:false/);
  assert.match(launch,/automaticPurchases:false/);
  assert.match(launch,/relayManualSend:true/);
  assert.doesNotMatch(launch,/execute_action|launchCampaign|updateBudget|publishPost|purchasePart/);
});

test('Monday API is authenticated and read-only',()=>{
  assert.match(api,/req\.method!=='GET'/);
  assert.match(api,/GHOSTOS_WEBHOOK_SECRET/);
  assert.match(api,/getMondayMarketingSnapshot/);
  assert.doesNotMatch(api,/POST|PUT|PATCH|DELETE/);
});
