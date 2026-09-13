import test from 'node:test';
import assert from 'node:assert/strict';
import { runAirtableWriteHealthCheck, AIRTABLE_HEALTH_VERSION } from '../src/airtable-health.js';

test('health check proves read, write and read-after-write without touching customer data', async () => {
  const activity = [];
  const control = [{ id:'ctl1', fields:{ Active:true } }];
  const result = await runAirtableWriteHealthCheck({
    tokenLoaded:true,
    now:()=> '2026-09-13T01:40:00.000Z',
    listRecords:async(table)=> table === 'GhostOS Control' ? control : activity,
    createRecord:async(table, fields)=> {
      assert.equal(table, 'Agent Activity');
      assert.equal(fields['Action Type'], 'airtable_write_health_check');
      assert.match(fields.Detail, new RegExp(AIRTABLE_HEALTH_VERSION));
      assert.equal(fields.Job, undefined);
      const row={ id:'health1', fields };
      activity.push(row);
      return row;
    },
    getRecord:async(table,id)=> {
      assert.equal(table,'Agent Activity');
      return activity.find((row)=>row.id===id) || null;
    },
  });
  assert.equal(result.tokenLoaded,true);
  assert.equal(result.baseReachable,true);
  assert.equal(result.readSucceeded,true);
  assert.equal(result.writeAttempted,true);
  assert.equal(result.writeSucceeded,true);
  assert.equal(result.readAfterWriteSucceeded,true);
  assert.equal(result.healthRecordId,'health1');
  assert.equal(result.error,null);
});

test('health check is idempotent by diagnostic version and does not create repeated records', async () => {
  const existing={ id:'health-existing', fields:{ Detail:`proof ${AIRTABLE_HEALTH_VERSION}`, 'Action Type':'airtable_write_health_check' } };
  let creates=0;
  const result=await runAirtableWriteHealthCheck({
    tokenLoaded:true,
    listRecords:async(table)=> table === 'GhostOS Control' ? [] : [existing],
    createRecord:async()=>{creates++; throw new Error('should not create');},
    getRecord:async()=>existing,
  });
  assert.equal(creates,0);
  assert.equal(result.writeSucceeded,true);
  assert.equal(result.readAfterWriteSucceeded,true);
  assert.equal(result.reusedExistingProof,true);
});

test('health check returns exact sanitized Airtable code/message on write failure', async () => {
  const error=Object.assign(new Error('You are not authorized to perform this operation'), { error:'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', statusCode:403 });
  const result=await runAirtableWriteHealthCheck({
    tokenLoaded:true,
    listRecords:async()=>[],
    createRecord:async()=>{throw error;},
    getRecord:async()=>null,
  });
  assert.equal(result.baseReachable,true);
  assert.equal(result.readSucceeded,true);
  assert.equal(result.writeAttempted,true);
  assert.equal(result.writeSucceeded,false);
  assert.equal(result.readAfterWriteSucceeded,false);
  assert.equal(result.error.code,'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND');
  assert.equal(result.error.statusCode,403);
  assert.match(result.error.message,/not authorized/);
});
