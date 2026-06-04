'use client';

/**
 * Browser-side agent loop (Claude Code style). The conversation and the
 * tool-call loop live here, in the page; the model is called DIRECTLY from the
 * browser (no Vercel in the path → no 60s function cap, no streaming timeout).
 * Tools run either in-browser (see assistantTools) or via the short
 * `/api/v1/assistant/tool` endpoint. The system prompt + tool schemas come
 * from `/api/v1/assistant/bootstrap` (so we never bundle the server registry).
 *
 * Writes still go through the server confirm token (the dispatch endpoint
 * mints it; the user authorises via /api/v1/assistant/confirm) — the model
 * running client-side does not loosen the write gate.
 */

import type { ChatMessage, ToolCall } from '@/lib/ai/deepseek';
import type { ToolDispatchResult } from '@/lib/ai/toolDispatchTypes';
import type { DeepSeekTool } from '@/lib/ai/toolSchema';
import { api } from '@/lib/client/api';
import { getCachedConfig } from '@/lib/client/assistant-config';
import { isClientTool, runClientTool } from '@/lib/client/assistantTools';

/** Safety cap on model round-trips per turn (no wall-clock limit applies now). */
const MAX_ITERATIONS = 25;

export type AgentEvent =
  | { type: 'tool_call'; id: string; name: string }
  | { type: 'component'; id: string; name: string; kind: string; data: unknown }
  | { type: 'assistant_delta'; content: string }
  | { type: 'error'; message: string };

export class AssistantNotConfiguredError extends Error {
  constructor() {
    super('AI 助手尚未配置');
    this.name = 'AssistantNotConfiguredError';
  }
}

interface Bootstrap {
  systemPrompt: string;
  tools: DeepSeekTool[];
}

let bootstrapPromise: Promise<Bootstrap> | null = null;
function getBootstrap(): Promise<Bootstrap> {
  if (!bootstrapPromise) {
    bootstrapPromise = api<{ data: Bootstrap }>('/api/v1/assistant/bootstrap')
      .then((r) => r.data)
      .catch((e) => {
        bootstrapPromise = null; // allow retry
        throw e;
      });
  }
  return bootstrapPromise;
}

interface ModelTurn {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  streamed: boolean;
}

/** One streamed chat completion straight to the model API. */
async function streamModelTurn(
  cfg: NonNullable<ReturnType<typeof getCachedConfig>>,
  systemPrompt: string,
  tools: DeepSeekTool[],
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ModelTurn> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    max_tokens: cfg.maxTokens,
    stream: true,
    thinking: { type: cfg.thinking },
  };
  if (cfg.thinking === 'enabled') body.reasoning_effort = cfg.reasoningEffort;
  else body.temperature = 0.3;

  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`模型请求失败（${res.status}）${detail.slice(0, 300)}`);
  }

  let content = '';
  let reasoning = '';
  let streamed = false;
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk: { choices?: Array<{ delta?: Record<string, unknown> }> };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        streamed = true;
        onDelta(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          const idx = tc.index ?? 0;
          const cur = byIndex.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          byIndex.set(idx, cur);
        }
      }
    }
  }

  const toolCalls: ToolCall[] = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
  return { content, reasoning, toolCalls, streamed };
}

async function dispatch(name: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolDispatchResult> {
  try {
    if (isClientTool(name)) return await runClientTool(name, rawInput);
    const res = await api<{ data: ToolDispatchResult }>('/api/v1/assistant/tool', {
      method: 'POST',
      body: { name, input: rawInput },
      signal,
    });
    return res.data;
  } catch (err) {
    const data = { error: err instanceof Error ? err.message : String(err) };
    return { kind: 'error', data, modelContent: JSON.stringify(data) };
  }
}

/**
 * Run one user turn to completion (possibly many model round-trips + tool
 * calls). Streams events out via `onEvent`. Returns the FULL updated transcript
 * (for persistence) only on success — on error/abort it throws and the caller
 * keeps its prior transcript, so a failed/interrupted turn isn't persisted
 * (mirrors the old server semantics; the next message resends cleanly).
 */
export async function runAgentTurn(opts: {
  priorMessages: ChatMessage[];
  userMessage: string;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}): Promise<ChatMessage[]> {
  const cfg = getCachedConfig();
  if (!cfg) throw new AssistantNotConfiguredError();
  const { systemPrompt, tools } = await getBootstrap();

  const convo: ChatMessage[] = [...opts.priorMessages, { role: 'user', content: opts.userMessage }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const turn = await streamModelTurn(
      cfg,
      systemPrompt,
      tools,
      convo,
      (chunk) => opts.onEvent({ type: 'assistant_delta', content: chunk }),
      opts.signal,
    );

    convo.push({
      role: 'assistant',
      content: turn.content || null,
      ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
      ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
    });

    if (!turn.toolCalls.length) {
      // Final answer. If the provider returned content without streaming it,
      // surface it once so the bubble isn't empty.
      if (turn.content && !turn.streamed) opts.onEvent({ type: 'assistant_delta', content: turn.content });
      return convo;
    }

    for (const call of turn.toolCalls) {
      opts.onEvent({ type: 'tool_call', id: call.id, name: call.function.name });
      let rawInput: unknown = {};
      try {
        rawInput = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* malformed args → dispatch surfaces a validation error */
      }
      const result = await dispatch(call.function.name, rawInput, opts.signal);
      opts.onEvent({
        type: 'component',
        id: call.id,
        name: call.function.name,
        kind: result.kind,
        data: result.data,
      });
      convo.push({ role: 'tool', tool_call_id: call.id, content: result.modelContent });
    }
  }

  // Hit the round-trip cap — return what we have so it persists; the panel can
  // surface a note. (Far more headroom than the old 8 now that there's no 60s.)
  opts.onEvent({ type: 'assistant_delta', content: '\n\n_（已达到单轮工具调用上限，先就目前结果作答。）_' });
  return convo;
}
