import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../public/command-center.html',import.meta.url),'utf8');
const toml=fs.readFileSync(new URL('../netlify.toml',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/i)?.[1]||'';

test('command center browser script parses',()=>{
  assert.ok(script);
  assert.doesNotThrow(()=>new Function(script));
});

test('navigation is wired independently of backend loading',()=>{
  assert.match(script,/function setView\(v\)/);
  assert.match(script,/document\.addEventListener\('click'/);
  assert.match(script,/Promise\.allSettled/);
  assert.ok(script.indexOf("document.addEventListener('click'") < script.indexOf('async function refresh()'));
});

test('owner entry points are Netlify rewrites, not fragile browser redirects',()=>{
  for(const path of ['/owner.html','/marketing.html','/approvals.html']){
    assert.match(toml,new RegExp(`from = "${path.replace('.','\\.')}"[\\s\\S]*?to = "/command-center\\.html"[\\s\\S]*?force = true`));
  }
});

test('agent floor and all five owner views exist',()=>{
  assert.match(html,/id="agentFloor"/);
  for(const view of ['home','marketing','jobs','approvals','more']) assert.match(html,new RegExp(`id="view-${view}"`));
  for(const agent of ['ATLAS','ECHO','SCOUT','BEACON','FORGE','HORIZON','RELAY','SUPPLY','LEDGER','DISPATCH','BUILDER']) assert.match(html,new RegExp(agent));
});
