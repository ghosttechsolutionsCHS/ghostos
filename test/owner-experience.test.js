import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { creativeFrameCount, creativeDimensions, renderCreativeJpeg } from '../src/creative-provider.js';

test('owner UI is mobile-first and exposes required primary navigation',()=>{
  const html=fs.readFileSync(new URL('../public/owner.html',import.meta.url),'utf8');
  for(const label of ['Home','Marketing','Jobs','Approvals','More'])assert.ok(html.includes(`>${label}<`)||html.includes(`>${label} `),label);
  assert.match(html,/viewport-fit=cover/);
  assert.match(html,/@media\(max-width:720px\)/);
  assert.match(html,/grid-template-columns:repeat\(5,1fr\)/);
  assert.match(html,/min-height:48px/);
  assert.match(html,/storystrip/);
  assert.match(html,/APPROVE|Approve/);
  assert.match(html,/Reject/);
  assert.ok(!html.includes('Raw Detail'));
});

test('marketing creatives are real raster assets with feed and story dimensions',async()=>{
  const feed={Platform:'Instagram','Content Type':'Feed Post','Growth Item':'Mobile tech repair','Purpose':'Charleston & surrounding areas',CTA:'Message Ghost Tech'};
  assert.deepEqual(creativeDimensions(feed),{width:1080,height:1350});
  assert.equal(creativeFrameCount(feed),1);
  const jpg=await renderCreativeJpeg(feed,1);const meta=await sharp(jpg).metadata();
  assert.equal(meta.format,'jpeg');assert.equal(meta.width,1080);assert.equal(meta.height,1350);
  const story={Platform:'Instagram','Content Type':'Story','Draft Content':'Frame 1: Tech problem?\nFrame 2: We come to you.\nFrame 3: Message Ghost Tech.',CTA:'Book now'};
  assert.equal(creativeFrameCount(story),3);assert.deepEqual(creativeDimensions(story),{width:1080,height:1920});
  const storyJpg=await renderCreativeJpeg(story,2);const storyMeta=await sharp(storyJpg).metadata();assert.equal(storyMeta.width,1080);assert.equal(storyMeta.height,1920);
});

test('daily marketing keeps employee homework away from owner',()=>{
  const src=fs.readFileSync(new URL('../src/daily-marketing.js',import.meta.url),'utf8');
  assert.match(src,/SKIP or REVIEW ANYWAY/);
  assert.match(src,/queue_site_builder_request/);
  assert.match(src,/do NOT tell the owner to implement UTMs\/GCLID/i);
  assert.match(src,/Needs Owner.*reserved/i);
  assert.match(src,/creativePublicUrl/);
});

test('working execution and safety files remain untouched by owner UI tests',()=>{
  const owner=fs.readFileSync(new URL('../public/owner.html',import.meta.url),'utf8');
  assert.match(owner,/GhostOS never sends this automatically/);
  assert.match(owner,/Cheap \/ Medium \/ Expensive/);
  assert.match(owner,/average daily budgets are not a hard calendar-day charge cap/i);
});
