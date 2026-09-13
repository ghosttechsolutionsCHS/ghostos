import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('scheduled dispatcher persists safe stage trace without changing business logic', async () => {
  const source = await readFile(new URL('../netlify/functions/lead-dispatch-cycle.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /^import .*lead-dispatch/m, 'lead-dispatch must initialize inside handler try/catch');
  assert.match(source, /await Promise\.all\(\[/);
  assert.match(source, /import\('\.\.\/\.\.\/src\/lead-dispatch\.js'\)/);
  assert.match(source, /createLeadDispatcher\(tracedDeps\)\.runCycle/);
  assert.match(source, /TABLES\.ACTIVITY/);
  assert.match(source, /actionType: 'lead_dispatch_trace'/);

  for (const stage of [
    'scan_started',
    'module_import_started',
    'module_import_complete',
    'leads_loaded',
    'lead_selected',
    'existing_draft_found',
    'relay_message_checked',
    'relay_message_reused',
    'relay_message_created',
    'job_updated',
    'activity_written',
    'openai_agent_started',
    'openai_agent_complete',
    'openai_agent_failed',
    'cycle_complete',
  ]) {
    assert.match(source, new RegExp(`'${stage}'`), `missing trace stage ${stage}`);
  }

  assert.match(source, /failure: safeError\(error\)/);
  assert.match(source, /schedule: '\*\/2 \* \* \* \*'/);
});
