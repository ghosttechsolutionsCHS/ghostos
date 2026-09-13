import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../public/dashboard.html', import.meta.url),'utf8');

test('dashboard exposes dedicated Parts & Quotes owner view',()=>{
  assert.match(html,/data-view="partsquotes"/);
  assert.match(html,/id="view-partsquotes"/);
  assert.match(html,/QUOTE NOT READY/);
  assert.match(html,/Recommended Quote/);
  assert.match(html,/Verified At/);
});

test('dashboard keeps RELAY manual-send workflow and Builder owner controls',()=>{
  assert.match(html,/Copy Message/);
  assert.match(html,/Mark as Sent/);
  assert.match(html,/Send it personally from your phone/);
  assert.match(html,/Approve Build \/ Merge/);
  assert.match(html,/HIGH RISK requires separate owner confirmation/);
});

test('growth dashboard exposes Windsor foundation without fabricating data',()=>{
  assert.match(html,/Marketing Data Provider: Windsor\.ai foundation/);
  assert.match(html,/No Windsor metrics are being fabricated/);
  assert.match(html,/Campaign Metrics/);
  assert.match(html,/Profit After Spend/);
});
