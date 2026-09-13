import Anthropic from '@anthropic-ai/sdk';
import { Agent, run as openaiRun, tool as openaiTool, webSearchTool as openaiWebSearchTool } from '@openai/agents';
import { z } from 'zod';
import { logActivity } from './airtable.js';

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';
const FALLBACK_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class AIProviderError extends Error {
  constructor(provider, message, { statusCode = null, code = null, cause = null } = {}) {
    super(message, { cause });
    this.name = 'AIProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function defineTool({ name, description, parameters, execute }) {
  if (!name || typeof execute !== 'function') throw new Error('AI tool requires name and execute');
  return { type: 'ghostos_function', name, description: description || '', parameters: parameters || z.object({}), execute };
}

export function providerConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  if (!['anthropic', 'openai'].includes(provider)) throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  return {
    provider,
    anthropicModel: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    openaiModel: env.GHOSTOS_MODEL || env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    openaiFallbackEnabled: String(env.AI_OPENAI_FALLBACK_ENABLED || '').toLowerCase() === 'true',
  };
}

function redactSecrets(value) {
  let text = String(value || '');
  for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]) {
    if (secret && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .slice(0, 4000);
}

export function safeAIError(error) {
  return {
    statusCode: Number(error?.statusCode || error?.status || 0) || null,
    code: redactSecrets(error?.code || error?.error?.type || error?.name || 'AI_ERROR'),
    message: redactSecrets(error?.message || 'AI provider request failed'),
  };
}

function anthropicClient(overrides = {}) {
  const apiKey = overrides.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIProviderError('anthropic', 'Anthropic runtime credential is not configured');
  return overrides.client || new Anthropic({ apiKey });
}

function collectUrls(value, found = new Set()) {
  if (!value) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found);
    return found;
  }
  if (typeof value !== 'object') return found;
  if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) found.add(value.url);
  for (const nested of Object.values(value)) collectUrls(nested, found);
  return found;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

function guardSupplyEvidence(input, evidenceUrls) {
  if (!input || !Array.isArray(input.parts)) return input;
  const evidence = new Set((evidenceUrls || []).map(normalizeUrl).filter(Boolean));
  return {
    ...input,
    parts: input.parts.map((part) => {
      if (!part?.verified) return part;
      const url = normalizeUrl(part.vendorUrl);
      if (url && evidence.has(url)) return part;
      return {
        ...part,
        verified: false,
        notes: [part.notes, 'Verification downgraded: product URL was not present in live web-search evidence captured for this execution.'].filter(Boolean).join('\n'),
      };
    }),
  };
}

function textFromAnthropic(content = []) {
  return content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n').trim();
}

function schemaForTool(item) {
  if (item?.parameters && typeof item.parameters.parse === 'function') return z.toJSONSchema(item.parameters);
  if (item?.parameters && typeof item.parameters === 'object') return item.parameters;
  return { type: 'object', properties: {}, additionalProperties: false };
}

function anthropicTools(tools, { webSearch = false } = {}) {
  const result = tools.map((item) => ({
    name: item.name,
    description: item.description || '',
    input_schema: schemaForTool(item),
  }));
  if (webSearch) {
    result.unshift({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 8,
      user_location: { type: 'approximate', city: 'North Charleston', region: 'South Carolina', country: 'US', timezone: 'America/New_York' },
    });
  }
  return result;
}

async function invokeTool(item, rawInput, context) {
  const input = item.name === 'store_supply_results' && context.provider === 'anthropic'
    ? guardSupplyEvidence(rawInput, context.evidenceUrls)
    : rawInput;
  if (typeof item.execute === 'function') {
    const parsed = item.parameters?.parse ? item.parameters.parse(input || {}) : input || {};
    return item.execute(parsed, context);
  }
  if (typeof item.invoke === 'function') {
    return item.invoke({ context: { ghostosProvider: context.provider, evidenceUrls: context.evidenceUrls || [] } }, JSON.stringify(input || {}));
  }
  throw new Error(`Tool ${item.name || '(unknown)'} is not executable`);
}

async function runAnthropic(agent, prompt, options = {}) {
  const config = providerConfig(options.env);
  const model = options.model || agent.model || config.anthropicModel;
  const client = anthropicClient(options.anthropic || {});
  const maxTurns = Math.max(1, Math.min(40, Number(options.maxTurns || 12)));
  const maxTokens = Math.max(128, Math.min(8192, Number(options.maxTokens || 4096)));
  const tools = agent.tools || [];
  const byName = new Map(tools.map((item) => [item.name, item]));
  const messages = [{ role: 'user', content: String(prompt || '') }];
  const evidenceUrls = new Set();

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: agent.instructions || '',
        messages,
        ...(tools.length || agent.webSearch ? { tools: anthropicTools(tools, { webSearch: Boolean(agent.webSearch) }) } : {}),
      });
    } catch (error) {
      const safe = safeAIError(error);
      throw new AIProviderError('anthropic', safe.message, { statusCode: safe.statusCode, code: safe.code, cause: error });
    }

    collectUrls(response.content, evidenceUrls);
    const toolUses = response.content.filter((block) => block?.type === 'tool_use');
    if (!toolUses.length) {
      const finalOutput = textFromAnthropic(response.content);
      if (!finalOutput) throw new AIProviderError('anthropic', 'Claude returned no final text output');
      return { finalOutput, provider: 'anthropic', model, evidenceUrls: [...evidenceUrls] };
    }

    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const call of toolUses) {
      const item = byName.get(call.name);
      if (!item) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Unknown tool: ${call.name}` });
        continue;
      }
      try {
        const value = await invokeTool(item, call.input || {}, { provider: 'anthropic', model, evidenceUrls: [...evidenceUrls] });
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(value ?? null).slice(0, 100000) });
      } catch (error) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: redactSecrets(error?.message || String(error)) });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new AIProviderError('anthropic', `Claude exceeded maxTurns=${maxTurns}`);
}

function toOpenAITool(item, model) {
  if (item?.type === 'function' && typeof item.invoke === 'function') return item;
  return openaiTool({
    name: item.name,
    description: item.description,
    parameters: item.parameters,
    async execute(input) {
      return item.execute(input, { provider: 'openai', model, evidenceUrls: [] });
    },
  });
}

async function runOpenAI(agent, prompt, options = {}) {
  if (!process.env.OPENAI_API_KEY) throw new AIProviderError('openai', 'OpenAI fallback credential is not configured');
  const config = providerConfig(options.env);
  const model = options.openaiModel || agent.openaiModel || config.openaiModel;
  const tools = (agent.tools || []).map((item) => toOpenAITool(item, model));
  if (agent.webSearch) tools.unshift(openaiWebSearchTool({ searchContextSize: 'medium' }));
  try {
    const runnerAgent = new Agent({ name: agent.name, model, instructions: agent.instructions || '', tools });
    const result = await openaiRun(runnerAgent, String(prompt || ''), { maxTurns: Math.max(1, Math.min(40, Number(options.maxTurns || 12))) });
    return { finalOutput: String(result.finalOutput || '').trim(), provider: 'openai', model, evidenceUrls: [] };
  } catch (error) {
    const safe = safeAIError(error);
    throw new AIProviderError('openai', safe.message, { statusCode: safe.statusCode, code: safe.code, cause: error });
  }
}

function fallbackEligible(error) {
  if (!(error instanceof AIProviderError)) return false;
  if (error.statusCode && FALLBACK_STATUS.has(error.statusCode)) return true;
  return /timeout|temporar|network|connection|overload|unavailable|rate limit|credits/i.test(error.message || '');
}

async function observeAttempt({ agent, jobId, provider, model, success, latencyMs, error }) {
  if (!agent || agent === 'HEALTH') return;
  const safe = error ? safeAIError(error) : null;
  const detail = JSON.stringify({ provider, model, success, latencyMs, ...(safe ? { statusCode: safe.statusCode, code: safe.code, message: safe.message } : {}) });
  try {
    await logActivity({ agent, jobId, actionType: 'ai_execution', status: success ? 'Done' : 'Error', detail, consequential: false });
  } catch (auditError) {
    console.warn('GhostOS AI observability write failed', { agent, provider, model, message: redactSecrets(auditError?.message || auditError) });
  }
}

async function attempt(provider, agent, prompt, options) {
  const started = Date.now();
  const config = providerConfig(options.env);
  const model = provider === 'anthropic'
    ? (options.model || agent.model || config.anthropicModel)
    : (options.openaiModel || agent.openaiModel || config.openaiModel);
  try {
    const result = provider === 'anthropic' ? await runAnthropic(agent, prompt, options) : await runOpenAI(agent, prompt, options);
    await observeAttempt({ agent: options.observerAgent || agent.name, jobId: options.jobId, provider, model: result.model || model, success: true, latencyMs: Date.now() - started });
    return result;
  } catch (error) {
    await observeAttempt({ agent: options.observerAgent || agent.name, jobId: options.jobId, provider, model, success: false, latencyMs: Date.now() - started, error });
    throw error;
  }
}

export async function runAgent(agent, prompt, options = {}) {
  const config = providerConfig(options.env);
  const primary = options.provider || config.provider;
  try {
    return await attempt(primary, agent, prompt, options);
  } catch (error) {
    const allowFallback = options.allowFallback ?? config.openaiFallbackEnabled;
    if (primary !== 'anthropic' || !allowFallback || !fallbackEligible(error)) throw error;
    return attempt('openai', agent, prompt, { ...options, provider: 'openai', allowFallback: false });
  }
}

export function agentAsTool(agent, { toolName, toolDescription, maxTurns = 12 } = {}) {
  return defineTool({
    name: toolName || agent.name.toLowerCase(),
    description: toolDescription || `Delegate a focused task to ${agent.name}.`,
    parameters: z.object({ input: z.string().min(1).max(60000) }),
    async execute({ input }, context = {}) {
      const result = await runAgent(agent, input, { maxTurns, provider: context.provider, allowFallback: false, observerAgent: agent.name });
      return { output: result.finalOutput, provider: result.provider, model: result.model };
    },
  });
}

export async function checkAnthropicHealth(overrides = {}) {
  const config = providerConfig(overrides.env);
  const model = overrides.model || config.anthropicModel;
  const started = Date.now();
  try {
    const client = anthropicClient(overrides.anthropic || {});
    const response = await client.messages.create({
      model,
      max_tokens: 16,
      system: 'You are a runtime health check. Do not use tools.',
      messages: [{ role: 'user', content: 'Reply exactly GHOSTOS_OK' }],
    });
    const output = textFromAnthropic(response.content);
    return { provider: 'anthropic', model, success: output.includes('GHOSTOS_OK'), latencyMs: Date.now() - started, statusCode: 200, code: null, message: output.includes('GHOSTOS_OK') ? 'Anthropic runtime access verified' : 'Anthropic returned an unexpected health response' };
  } catch (error) {
    const safe = safeAIError(error);
    return { provider: 'anthropic', model, success: false, latencyMs: Date.now() - started, statusCode: safe.statusCode, code: safe.code, message: safe.message };
  }
}
