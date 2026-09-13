import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function ownerHtml(){
  return fs.readFileSync(new URL('../public/owner.html',import.meta.url),'utf8');
}

function ownerScript(){
  const match=ownerHtml().match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match,'owner inline script should exist');
  return match[1];
}

test('owner inline browser script parses',()=>{
  assert.doesNotThrow(()=>new Function(ownerScript()));
});

test('owner initialization guards browser storage before navigation wiring',()=>{
  const script=ownerScript();
  assert.match(script,/function readSession\(k\)\{try\{return sessionStorage\.getItem\(k\)\|\|''\}catch\(e\)\{storageError=e;return ''\}\}/);
  assert.match(script,/function writeSession\(k,v\)\{try\{sessionStorage\.setItem\(k,v\)\}catch\(e\)\{storageError=e\}\}/);
  assert.match(script,/key=readSession\('ghostosKey'\)/);
  assert.doesNotMatch(script,/let key=sessionStorage\.getItem\('ghostosKey'\)/);
  assert.match(script,/document\.addEventListener\('click',e=>\{const b=e\.target\.closest\('\[data-view\]'\);if\(b\)setView\(b\.dataset\.view\)\}\)/);
  assert.match(script,/setView\(location\.hash\.replace\('#',''\)\|\|'home'\)/);
});

test('backend failures surface an error without disabling owner navigation',()=>{
  const script=ownerScript();
  assert.match(script,/function showLoadError\(e\)\{showErr\(e\);\$\('#homeLine'\)\.textContent='Company data could not be loaded\. Navigation is still available\.'\}/);
  assert.match(script,/async function refreshAll\(\)\{try\{[\s\S]*?\}catch\(e\)\{showLoadError\(e\)\}\}/);
  assert.ok(script.indexOf("document.addEventListener('click'") < script.indexOf('async function refreshAll()'),'navigation is wired independently of API refresh execution');
});

test('mobile marketing and approvals entry points bootstrap owner UI without cross-page redirect',()=>{
  const marketing=fs.readFileSync(new URL('../public/marketing.html',import.meta.url),'utf8');
  const approvals=fs.readFileSync(new URL('../public/approvals.html',import.meta.url),'utf8');
  assert.match(marketing,/fetch\('\/owner\.html'/);
  assert.match(marketing,/setView\('marketing'\)/);
  assert.doesNotMatch(marketing,/location\.replace/);
  assert.match(approvals,/fetch\('\/owner\.html'/);
  assert.match(approvals,/setView\('approvals'\)/);
  assert.doesNotMatch(approvals,/location\.replace/);
});
