import test from 'node:test';
import assert from 'node:assert/strict';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { runAgent } from '../src/ai-provider.js';

function fakeClient(responses) {
  const queue = [...responses];
  return { messages: { async create() { return queue.shift(); } } };
}

test('Claude adapter executes existing @openai/agents deterministic function tools', async () => {
  const calls = [];
  const existingTool = tool({
    name: 'existing_deterministic_tool',
    description: 'Existing GhostOS-style tool wrapper',
    parameters: z.object({ value: z.string() }),
    async execute({ value }) { calls.push(value); return { stored: value }; },
  });
  const client = fakeClient([
    { content: [{ type: 'tool_use', id: 'call1', name: 'existing_deterministic_tool', input: { value: 'works' } }] },
    { content: [{ type: 'text', text: 'done' }] },
  ]);
  const result = await runAgent({ name: 'HEALTH', instructions: '', tools: [existingTool] }, 'run it', {
    env: { AI_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    anthropic: { client, apiKey: 'test-only' },
    observerAgent: 'HEALTH',
    maxTurns: 3,
  });
  assert.deepEqual(calls, ['works']);
  assert.equal(result.finalOutput, 'done');
});
