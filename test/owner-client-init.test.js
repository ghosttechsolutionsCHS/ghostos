import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function ownerScript(){
  const html=fs.readFileSync(new URL('../public/owner.html',import.meta.url),'utf8');
  const match=html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match,'owner inline script should exist');
  return match[1];
}

test('owner inline browser script parses',()=>{
  assert.doesNotThrow(()=>new Function(ownerScript()));
});
