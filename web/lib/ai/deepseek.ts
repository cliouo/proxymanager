/**
 * DeepSeek chat client (OpenAI-compatible). Raw fetch — no SDK dependency.
 *
 * Thinking mode is enabled by default for deepseek-v4-pro. Its contract:
 *   - the response carries `reasoning_content` (chain-of-thought) alongside
 *     `content`;
 *   - once a turn makes tool calls, that turn's `reasoning_content` MUST be
 *     passed back on the assistant message in every subsequent request, or
 *     the API returns 400. We therefore round-trip it through ChatMessage.
 *   - temperature/top_p/penalties are unsupported in thinking mode.
 * Set DEEPSEEK_THINKING=disabled to opt out (then we send temperature instead).
 */

import type { DeepSeekTool } from './toolSchema';

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
const THINKING_ENABLED = (process.env.DEEPSEEK_THINKING ?? 'enabled') !== 'disabled';
const REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT ?? 'high';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Chain-of-thought; must be echoed back on assistant turns that made tool calls. */
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AssistantMessage {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

export function hasDeepSeekKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

/**
 * Per-call overrides for the chat client. When provided, these win over the
 * env-derived defaults — the naming-analysis route passes the user's stored
 * assistant config (AI 配置页) so custom base URLs / models / keys are
 * actually used, and the request never depends on DEEPSEEK_API_KEY existing
 * in the server env.
 */
export interface DeepSeekCallConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

/** One non-streaming chat completion with tools. Returns the assistant message. */
export async function deepseekChat(
  messages: ChatMessage[],
  tools: DeepSeekTool[],
  signal?: AbortSignal,
  config?: DeepSeekCallConfig,
): Promise<AssistantMessage> {
  const apiKey = config?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new DeepSeekError('Server misconfigured: missing DEEPSEEK_API_KEY.', 500);
  }
  const baseUrl = config?.baseUrl ?? BASE_URL;
  const model = config?.model ?? MODEL;
  const thinkingEnabled =
    (config?.thinking ?? (THINKING_ENABLED ? 'enabled' : 'disabled')) === 'enabled';
  const reasoningEffort = config?.reasoningEffort ?? REASONING_EFFORT;
  const maxTokens = config?.maxTokens ?? 8192;

  const body: Record<string, unknown> = {
    model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    // Thinking mode emits reasoning + answer; leave headroom for both.
    max_tokens: maxTokens,
    stream: false,
    thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
  };
  if (thinkingEnabled) {
    body.reasoning_effort = reasoningEffort;
  } else {
    // temperature is only honoured outside thinking mode.
    body.temperature = 0.3;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new DeepSeekError(`DeepSeek HTTP ${res.status}: ${detail.slice(0, 500)}`, res.status);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: AssistantMessage }>;
  };
  const message = json.choices?.[0]?.message;
  if (!message) {
    throw new DeepSeekError('DeepSeek returned no message.');
  }
  return {
    content: message.content ?? null,
    reasoning_content: message.reasoning_content ?? null,
    tool_calls: message.tool_calls,
  };
}
