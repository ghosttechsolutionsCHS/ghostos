import { env, MODEL } from './env.js';

/**
 * Minimal OpenAI client over fetch — no SDK, so there is no version surface to
 * drift. Every failure is returned as data rather than thrown, because the
 * dashboard must stay usable when reasoning is unavailable.
 */

export interface LlmResult {
  ok: boolean;
  text: string;
  model: string;
  /** Set when the call could not be made, for display and for agent_runs. */
  unavailableReason?: string;
  status?: number;
}

export function llmConfigured(): boolean {
  return !!env('OPENAI_API_KEY');
}

export async function complete(
  system: string,
  user: string,
  opts: { maxTokens?: number } = {},
): Promise<LlmResult> {
  const key = env('OPENAI_API_KEY');
  if (!key) {
    return { ok: false, text: '', model: MODEL, unavailableReason: 'OPENAI_API_KEY is not configured' };
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: opts.maxTokens ?? 1200,
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Surface the provider's own wording; it is the actionable part.
      const msg = data?.error?.message || `OpenAI request failed (${res.status})`;
      return { ok: false, text: '', model: MODEL, unavailableReason: msg, status: res.status };
    }

    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      return { ok: false, text: '', model: MODEL, unavailableReason: 'Model returned an empty response', status: res.status };
    }
    return { ok: true, text, model: MODEL, status: res.status };
  } catch (e: any) {
    return { ok: false, text: '', model: MODEL, unavailableReason: e?.message || 'Network error calling OpenAI' };
  }
}
