import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const builderSource = await readFile(new URL('../src/builder.js', import.meta.url), 'utf8');
const dashboardSource = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');

test('BUILDER GitHub integration is read-only by construction', () => {
  assert.match(builderSource, /list_repo_files/);
  assert.match(builderSource, /read_repo_file/);
  assert.match(builderSource, /save_builder_plan/);
  assert.doesNotMatch(builderSource, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
  assert.doesNotMatch(builderSource, /\/git\/refs|\/pulls|\/merges/);
});

test('company dashboard exposes Builder planning and preserves manual RELAY copy flow', () => {
  assert.match(dashboardSource, /BUILDER/);
  assert.match(dashboardSource, /Analyze Codebase/);
  assert.match(dashboardSource, /Copy Message/);
  assert.match(dashboardSource, /Mark as Sent/);
  assert.doesNotMatch(dashboardSource, />Retry</);
  assert.doesNotMatch(dashboardSource, />Send<\/button>/);
});
