import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function ownerScript(){
  const html=fs.readFileSync(new URL('../public/owner.html',import.meta.url),'utf8');
  const match=html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match,'owner inline script should exist');
  return match[1];
}

test('owner inline browser script parses',()=>{
  assert.doesNotThrow(()=>new Function(ownerScript()));
});

test('owner navigation still initializes when sessionStorage is unavailable',()=>{
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',innerHTML:'',classList:{add(){},remove(){},toggle(){}}});
    return elements.get(id);
  };
  let clickHandler=null;
  const document={
    getElementById:id=>element(id),
    querySelectorAll:()=>[],
    addEventListener:(type,handler)=>{if(type==='click')clickHandler=handler;}
  };
  const location={hash:'#home'};
  const storageError=Object.assign(new Error('Access to storage is not allowed from this context.'),{name:'SecurityError'});
  const sandbox={
    document,
    location,
    sessionStorage:{getItem(){throw storageError;},setItem(){throw storageError;}},
    navigator:{clipboard:{writeText:async()=>{}}},
    alert(){},
    prompt(){return null;},
    fetch(){throw new Error('fetch should not run without a key');},
    console
  };

  const instrumented=`${ownerScript()}\n;globalThis.__ownerTest={title:()=>document.getElementById('pageTitle').textContent,error:()=>document.getElementById('err').textContent,hash:()=>location.hash};`;
  assert.doesNotThrow(()=>vm.runInNewContext(instrumented,sandbox));
  assert.equal(typeof clickHandler,'function');
  clickHandler({target:{closest:()=>({dataset:{view:'marketing'}})}});
  assert.equal(sandbox.__ownerTest.title(),'Marketing');
  assert.equal(sandbox.__ownerTest.hash(),'marketing');
  assert.match(sandbox.__ownerTest.error(),/Browser storage is unavailable/);
});
