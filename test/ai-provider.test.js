import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AIProviderError, checkAnthropicHealth, defineTool, providerConfig, runAgent, safeAIError } from '../src/ai-provider.js';

function fakeClient(responses) {
  const queue = [...responses];
  const requests = [];
  return {
    requests,
    messages: {
      async create(request) {
        requests.push(request);
        const next = queue.shift();
        if (next instanceof Error || (next && next.__throw)) throw next.error || next;
        if (!next) throw new Error('Fake Anthropic response queue exhausted');
        return next;
      },
    },
  };
}

const env = {
  AI_PROVIDER: 'anthropic',
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',
  GHOSTOS_MODEL: 'gpt-5.6-sol',
};

test('Claude basic structured runtime response uses Anthropic as the default provider', async () => {
  const client = fakeClient([{ content: [{ type: 'text', text: 'GHOSTOS_OK' }] }]);
  const result = await runAgent({ name: 'HEALTH', instructions: 'Reply concisely.', tools: [] }, 'health', {
    env,
    anthropic: { client, apiKey: 'test-only' },
    observerAgent: 'HEALTH',
  });
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.equal(result.finalOutput, 'GHOSTOS_OK');
  assert.equal(client.requests.length, 1);
});

test('ATLAS-style orchestration executes deterministic tools through Claude tool use', async () => {
  const calls = [];
  const getJob = defineTool({
    name: 'get_job', description: 'Read a job', parameters: z.object({ recordId: z.string() }),
    async execute(input) { calls.push(['get_job', input]); return { id: input.recordId, status: 'New Lead' }; },
  });
  const client = fakeClient([
    { content: [{ type: 'tool_use', id: 'tool1', name: 'get_job', input: { recordId: 'rec-test' } }] },
    { content: [{ type: 'text', text: 'EXECUTIVE_SUMMARY:\nLead read and triaged.' }] },
  ]);
  const result = await runAgent({ name: 'ATLAS', instructions: 'Read the job first.', tools: [getJob] }, 'Process rec-test', {
    env, anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH', maxTurns: 3,
  });
  assert.deepEqual(calls, [['get_job', { recordId: 'rec-test' }]]);
  assert.match(result.finalOutput, /Lead read and triaged/);
  assert.equal(client.requests[1].messages.at(-1).role, 'user');
  assert.equal(client.requests[1].messages.at(-1).content[0].type, 'tool_result');
});

test('RELAY-style drafting remains a persisted draft tool action, not a send action', async () => {
  const drafts = [];
  const saveDraft = defineTool({
    name: 'save_relay_draft', description: 'Save owner-review draft only',
    parameters: z.object({ recordId: z.string(), reply: z.string() }),
    async execute(input) { drafts.push(input); return { draftId: 'draft1', status: 'Pending', externalSend: false }; },
  });
  const client = fakeClient([
    { content: [{ type: 'tool_use', id: 'tool1', name: 'save_relay_draft', input: { recordId: 'job1', reply: 'Hi — one quick question.' } }] },
    { content: [{ type: 'text', text: 'Draft saved for owner review.' }] },
  ]);
  await runAgent({ name: 'RELAY', instructions: 'Draft only. Never send.', tools: [saveDraft] }, 'Draft a clarification.', {
    env, anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH', maxTurns: 3,
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].reply, 'Hi — one quick question.');
});

test('SUPPLY keeps verified=true only when product URL exists in captured live-search evidence', async () => {
  let stored;
  const store = defineTool({
    name: 'store_supply_results', description: 'Store parts',
    parameters: z.object({ jobId: z.string(), parts: z.array(z.object({ vendorUrl: z.string().url(), verified: z.boolean(), partOrSku: z.string() })) }),
    async execute(input) { stored = input; return { stored: input.parts.length }; },
  });
  const url = 'https://www.injuredgadgets.com/example-iphone-17-pro-max-screen';
  const client = fakeClient([
    { content: [
      { type: 'web_search_tool_result', tool_use_id: 'server-search', content: [{ type: 'web_search_result', url, title: 'iPhone 17 Pro Max Screen' }] },
      { type: 'tool_use', id: 'tool1', name: 'store_supply_results', input: { jobId: 'saif', parts: [{ vendorUrl: url, verified: true, partOrSku: '17PM Screen' }] } },
    ] },
    { content: [{ type: 'text', text: 'Verified result stored.' }] },
  ]);
  await runAgent({ name: 'SUPPLY', webSearch: true, instructions: 'Use live web evidence.', tools: [store] }, 'Research a real screen.', {
    env, anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH', maxTurns: 3,
  });
  assert.equal(stored.parts[0].verified, true);
  assert.equal(stored.parts[0].vendorUrl, url);
  assert.equal(client.requests[0].tools[0].type, 'web_search_20250305');
});

test('SUPPLY no-source path downgrades claimed verification instead of creating fake verified evidence', async () => {
  let stored;
  const store = defineTool({
    name: 'store_supply_results', description: 'Store parts',
    parameters: z.object({ jobId: z.string(), parts: z.array(z.object({ vendorUrl: z.string().url(), verified: z.boolean(), partOrSku: z.string(), notes: z.string().optional() })) }),
    async execute(input) { stored = input; return { stored: input.parts.length }; },
  });
  const client = fakeClient([
    { content: [{ type: 'tool_use', id: 'tool1', name: 'store_supply_results', input: { jobId: 'saif', parts: [{ vendorUrl: 'https://example.invalid/unverified', verified: true, partOrSku: 'Made Up Screen' }] } }] },
    { content: [{ type: 'text', text: 'Research could not verify a usable part.' }] },
  ]);
  await runAgent({ name: 'SUPPLY', webSearch: true, instructions: 'Never fabricate.', tools: [store] }, 'Research.', {
    env, anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH', maxTurns: 3,
  });
  assert.equal(stored.parts[0].verified, false);
  assert.match(stored.parts[0].notes, /Verification downgraded/);
});

test('provider failure does not silently fall back for non-transient Anthropic errors', async () => {
  const error = Object.assign(new Error('invalid request'), { statusCode: 400, code: 'invalid_request_error' });
  const client = fakeClient([{ __throw: true, error }]);
  let fallbackCalls = 0;
  await assert.rejects(() => runAgent({ name: 'HEALTH', instructions: '', tools: [] }, 'x', {
    env: { ...env, AI_OPENAI_FALLBACK_ENABLED: 'true' },
    anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH',
    openaiRunner: async () => { fallbackCalls += 1; return { finalOutput: 'fallback' }; },
  }), (caught) => caught instanceof AIProviderError && caught.statusCode === 400);
  assert.equal(fallbackCalls, 0);
});

test('OpenAI fallback runs only when explicitly enabled and Anthropic fails transiently', async () => {
  const error = Object.assign(new Error('service temporarily unavailable'), { statusCode: 503, code: 'overloaded_error' });
  const client = fakeClient([{ __throw: true, error }]);
  let fallbackCalls = 0;
  const result = await runAgent({ name: 'HEALTH', instructions: '', tools: [] }, 'x', {
    env: { ...env, AI_OPENAI_FALLBACK_ENABLED: 'true' },
    anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH',
    openaiRunner: async ({ model }) => { fallbackCalls += 1; return { finalOutput: 'fallback-ok', model }; },
  });
  assert.equal(result.provider, 'openai');
  assert.equal(result.finalOutput, 'fallback-ok');
  assert.equal(fallbackCalls, 1);
});

test('OpenAI fallback remains disabled by default', async () => {
  const error = Object.assign(new Error('service temporarily unavailable'), { statusCode: 503 });
  const client = fakeClient([{ __throw: true, error }]);
  let fallbackCalls = 0;
  await assert.rejects(() => runAgent({ name: 'HEALTH', instructions: '', tools: [] }, 'x', {
    env, anthropic: { client, apiKey: 'test-only' }, observerAgent: 'HEALTH',
    openaiRunner: async () => { fallbackCalls += 1; return { finalOutput: 'should-not-run' }; },
  }), /temporarily unavailable/);
  assert.equal(fallbackCalls, 0);
});

test('Anthropic health check is read-only and returns only safe runtime metadata', async () => {
  const client = fakeClient([{ content: [{ type: 'text', text: 'GHOSTOS_OK' }] }]);
  const result = await checkAnthropicHealth({ env, anthropic: { client, apiKey: 'test-only' } });
  assert.equal(result.success, true);
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.statusCode, 200);
  assert.equal('apiKey' in result, false);
});

test('AI error sanitizer never returns configured provider credentials', () => {
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-secret-value-123456789';
  try {
    const safe = safeAIError(new Error(`failed with ${process.env.ANTHROPIC_API_KEY}`));
    assert.doesNotMatch(safe.message, /test-secret-value/);
    assert.match(safe.message, /REDACTED/);
  } finally {
    if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropic;
  }
});

test('production-facing source routes direct model execution through provider layer', async () => {
  const [ghostos, growth, builder, improvements, provider, relay] = await Promise.all([
    readFile(new URL('../src/ghostos.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/growth.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/builder.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/improvements.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ai-provider.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/relay-delivery.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(ghostos, /from '@openai\/agents'/);
  assert.doesNotMatch(builder, /\bnew Agent\b|\bawait run\(/);
  assert.doesNotMatch(improvements, /\bnew Agent\b|\bawait run\(/);
  assert.doesNotMatch(growth, /\bnew Agent\b|webSearchTool/);
  assert.match(provider, /AI_PROVIDER/);
  assert.match(provider, /web_search_20250305/);
  assert.match(relay, /owner_phone_copy_paste/);
  assert.doesNotMatch(provider, /console\.log\([^\n]*prompt/i);
});

test('provider config defaults to Anthropic and requires explicit opt-in for fallback', () => {
  const config = providerConfig({});
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.openaiFallbackEnabled, false);
});
