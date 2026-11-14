'use client';

/**
 * Browser-side agent loop for the AI assistant.
 *
 * The model is called directly from the browser with the user's own
 * OpenAI-compatible credentials (GET /assistant/config); the system prompt and
 * tool schemas come from GET /assistant/bootstrap. Every tool call the model
 * makes is executed through POST /assistant/tool, which runs reads inline and
 * turns writes into a one-time confirmation token — nothing is ever written
 * without the user pressing 确认执行 (POST /assistant/confirm).
 *
 * The request body mirrors `lib/ai/deepseek.ts` (model, thinking,
 * reasoning_effort | temperature, max_tokens, tools, tool_choice) with
 * `stream: true`. `reasoning_content` is echoed back on assistant turns, which
 * DeepSeek's thinking mode requires once a turn has made tool calls.
 */

import type { ChatMessage, ToolCall } from '@/lib/ai/deepseek';
import type { ToolDispatchResult } from '@/lib/ai/toolDispatchTypes';
import type { DeepSeekTool } from '@/lib/ai/toolSchema';
import { ApiError, api, errorMessage, request } from '@/ui/data/api';
import type { AssistantConfig } from '@/ui/data/types';

export type { ChatMessage, ToolCall, ToolDispatchResult };

/** Safety cap on model round-trips for one user turn. */
export const MAX_ROUNDS = 12;

/** Audit label for every assistant-originated tool / confirm call. */
const AI_HEADERS = { 'X-Source': 'ai_chat' };

/* ─── config + bootstrap ─────────────────────────────────────────────── */

export interface Bootstrap {
  systemPrompt: string;
  tools: DeepSeekTool[];
}

/** Assistant config, or null when it has never been set up (404). */
export async function fetchAssistantConfig(): Promise<AssistantConfig | null> {
  try {
    return await api.get<AssistantConfig>('/assistant/config');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

let bootstrapPromise: Promise<Bootstrap> | null = null;

/** System prompt + tool schemas, fetched once per page session (retried after a failure). */
export function loadBootstrap(): Promise<Bootstrap> {
  if (!bootstrapPromise) {
    bootstrapPromise = api.get<Bootstrap>('/assistant/bootstrap').catch((error: unknown) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

/* ─── errors ─────────────────────────────────────────────────────────── */

export type ModelErrorKind = 'auth' | 'rate' | 'server' | 'network' | 'request' | 'stream';

/** A failure talking to the model API. Messages are user-facing and never contain the key. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  constructor(kind: ModelErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Strip anything that looks like a credential before text reaches the screen. */
function scrub(text: string, apiKey: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('••••');
  return out
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '$1-••••')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••');
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function completionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`;
}

async function httpError(res: Response, config: AssistantConfig): Promise<ModelError> {
  let detail = '';
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      const err = json.error;
      detail =
        typeof err === 'string'
          ? err
          : typeof err?.message === 'string'
            ? err.message
            : typeof json.message === 'string'
              ? json.message
              : text;
    } catch {
      detail = text;
    }
  } catch {
    /* body unreadable */
  }
  detail = scrub(detail.replace(/\s+/g, ' ').trim(), config.apiKey).slice(0, 240);
  const suffix = detail ? `：${detail}` : '';
  const status = res.status;
  if (status === 401 || status === 403) {
    return new ModelError('auth', `模型服务拒绝了请求（${status}），请检查 API Key 是否有效${suffix}`, status);
  }
  if (status === 402 || status === 429) {
    return new ModelError('rate', `模型服务暂时不可用（${status}），可能是额度不足或请求太频繁${suffix}`, status);
  }
  if (status >= 500) {
    return new ModelError('server', `模型服务出错（${status}），请稍后重试${suffix}`, status);
  }
  return new ModelError('request', `模型请求失败（${status}）${suffix}`, status);
}

/* ─── SSE ────────────────────────────────────────────────────────────── */

/** Incremental `text/event-stream` parser: feeds each event's joined `data:` payload to `onData`. */
export function createSseParser(onData: (data: string) => void) {
  let buffer = '';
  const dispatch = (block: string) => {
    const lines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== 'data') continue;
      const value = colon === -1 ? '' : line.slice(colon + 1);
      lines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    if (lines.length) onData(lines.join('\n'));
  };
  return {
    push(text: string) {
      buffer += text;
      // A trailing CR may be the first half of a CRLF split across chunks.
      let carry = '';
      if (buffer.endsWith('\r')) {
        carry = '\r';
        buffer = buffer.slice(0, -1);
      }
      buffer = buffer.replace(/\r\n?/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        dispatch(block);
        index = buffer.indexOf('\n\n');
      }
      buffer += carry;
    },
    flush() {
      const rest = buffer.replace(/\r\n?/g, '\n').trim();
      buffer = '';
      if (rest) dispatch(rest);
    },
  };
}

/* ─── one model round ────────────────────────────────────────────────── */

export interface ModelRound {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  aborted: boolean;
}

export type RoundDelta =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool-announced'; index: number; name: string };

interface StreamedToolCall {
  id: string;
  name: string;
  args: string;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

function buildBody(config: AssistantConfig, system: string, tools: DeepSeekTool[], messages: ChatMessage[]) {
  const thinking = config.thinking ?? 'enabled';
  const body: Json = {
    model: config.model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    // Thinking mode emits reasoning + answer; leave headroom for both.
    max_tokens: config.maxTokens ?? 8192,
    stream: true,
    thinking: { type: thinking },
  };
  if (thinking === 'enabled') body.reasoning_effort = config.reasoningEffort ?? 'high';
  else body.temperature = 0.3;
  return body;
}

/** Stream one chat completion. Aborts resolve with `aborted: true` and the partial text. */
export async function streamModelRound(options: {
  config: AssistantConfig;
  system: string;
  tools: DeepSeekTool[];
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: RoundDelta) => void;
}): Promise<ModelRound> {
  const { config, signal, onDelta } = options;
  const round: ModelRound = { content: '', reasoning: '', toolCalls: [], finishReason: null, aborted: false };
  const calls = new Map<number, StreamedToolCall>();
  let lastIndex = -1;

  const takeToolCalls = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const fn = isRecord(item.function) ? item.function : {};
      const id = typeof item.id === 'string' ? item.id : '';
      let index: number;
      if (typeof item.index === 'number') index = item.index;
      else if (id && lastIndex >= 0 && calls.get(lastIndex)?.id && calls.get(lastIndex)?.id !== id) index = lastIndex + 1;
      else index = Math.max(lastIndex, 0);
      lastIndex = index;
      const current = calls.get(index) ?? { id: '', name: '', args: '' };
      if (id) current.id = id;
      if (typeof fn.name === 'string' && fn.name && !current.name) {
        current.name = fn.name;
        onDelta({ type: 'tool-announced', index, name: fn.name });
      }
      if (typeof fn.arguments === 'string') current.args += fn.arguments;
      else if (isRecord(fn.arguments)) current.args += JSON.stringify(fn.arguments);
      calls.set(index, current);
    }
  };

  const takeMessage = (message: Json) => {
    const reasoning =
      typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : typeof message.reasoning === 'string'
          ? message.reasoning
          : '';
    if (reasoning) {
      round.reasoning += reasoning;
      onDelta({ type: 'reasoning', text: reasoning });
    }
    if (typeof message.content === 'string' && message.content) {
      round.content += message.content;
      onDelta({ type: 'content', text: message.content });
    }
    takeToolCalls(message.tool_calls);
  };

  const takeChunk = (chunk: unknown) => {
    if (!isRecord(chunk)) return;
    if (chunk.error) {
      const err = chunk.error;
      const message = isRecord(err) && typeof err.message === 'string' ? err.message : typeof err === 'string' ? err : '';
      throw new ModelError('stream', `模型服务在回答途中出错${message ? `：${scrub(message, config.apiKey).slice(0, 240)}` : ''}`);
    }
    const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) return;
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
    if (delta) takeMessage(delta);
    if (typeof choice.finish_reason === 'string') round.finishReason = choice.finish_reason;
  };

  let res: Response;
  try {
    res = await fetch(completionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildBody(config, options.system, options.tools, options.messages)),
      signal,
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return { ...round, aborted: true };
    throw new ModelError(
      'network',
      `无法连接到模型服务（${hostOf(config.baseUrl)}）。请检查网络，并确认 Base URL 正确、允许浏览器直接访问。`,
    );
  }
  if (!res.ok) throw await httpError(res, config);

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.body || contentType.includes('application/json')) {
    // Provider ignored `stream: true` — take the whole message at once.
    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return { ...round, aborted: true };
      throw new ModelError('stream', '模型返回的内容无法解析。');
    }
    takeChunk(json);
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    const parser = createSseParser((data) => {
      if (done) return;
      if (data.trim() === '[DONE]') {
        done = true;
        return;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // keep-alive noise / partial vendor extras
      }
      takeChunk(chunk);
    });
    try {
      while (!done) {
        const { done: ended, value } = await reader.read();
        if (ended) {
          parser.push(decoder.decode());
          parser.flush();
          break;
        }
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        round.aborted = true;
      } else if (error instanceof ModelError) {
        throw error;
      } else {
        throw new ModelError('network', '与模型服务的连接中断了，请重试。');
      }
    } finally {
      if (done || round.aborted) reader.cancel().catch(() => undefined);
    }
  }

  round.toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({
      id: call.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args },
    }));
  return round;
}

/* ─── tools + confirmation ───────────────────────────────────────────── */

function errorResult(message: string): ToolDispatchResult {
  const data = { error: message };
  return { kind: 'error', data, modelContent: JSON.stringify(data) };
}

/** Execute one tool call on the server for `profileId`. Never throws except on abort. */
export async function dispatchTool(
  profileId: string,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolDispatchResult> {
  try {
    const res = await request<{ data?: ToolDispatchResult }>('/assistant/tool', {
      method: 'POST',
      query: { profileId },
      body: { name, input },
      headers: AI_HEADERS,
      signal,
    });
    const result = res?.data;
    if (!result || typeof result.kind !== 'string' || typeof result.modelContent !== 'string') {
      return errorResult('工具返回了无法识别的结果。');
    }
    return result;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return errorResult(errorMessage(error));
  }
}

export type ConfirmOutcome =
  | { kind: 'write-result'; summary: string; op: string; undoable: boolean; modelContent: string }
  | { kind: 'unknown-outcome'; modelContent: string };

/** Run an authorised write. Throws ApiError (409 = token expired/used, 422 = rejected …). */
export async function confirmWrite(token: string): Promise<ConfirmOutcome> {
  const res = await request<{ data?: Json }>('/assistant/confirm', {
    method: 'POST',
    body: { token },
    headers: AI_HEADERS,
  });
  const payload = isRecord(res?.data) ? res.data : {};
  const modelContent =
    typeof payload.modelContent === 'string'
      ? payload.modelContent
      : 'The write outcome is unknown. Do not retry automatically; re-read the target profile to verify the current state.';
  if (payload.kind === 'write-result' && isRecord(payload.data)) {
    const data = payload.data;
    const events = Array.isArray(data.events) ? data.events : [];
    return {
      kind: 'write-result',
      summary: typeof data.summary === 'string' ? data.summary : '',
      op: typeof data.op === 'string' ? data.op : '',
      undoable: events.some((event) => isRecord(event) && event.undoable === true),
      modelContent,
    };
  }
  return { kind: 'unknown-outcome', modelContent };
}

/* ─── transcript hygiene ─────────────────────────────────────────────── */

/**
 * Make a transcript valid for the API: every assistant tool call gets a tool
 * reply (calls cut short by a reload or a stop are answered as interrupted)
 * and stray tool replies are dropped.
 */
export function repairTranscript(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let open: string[] = [];
  const closeOpen = () => {
    for (const id of open) {
      out.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ error: '调用被中断，未执行。' }) });
    }
    open = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      const at = message.tool_call_id ? open.indexOf(message.tool_call_id) : -1;
      if (at === -1) continue;
      open.splice(at, 1);
      out.push(message);
      continue;
    }
    closeOpen();
    out.push(message);
    if (message.role === 'assistant' && message.tool_calls?.length) open = message.tool_calls.map((call) => call.id);
  }
  closeOpen();
  return out;
}

/* ─── the loop ───────────────────────────────────────────────────────── */

export type AgentEvent =
  | { type: 'round-start'; round: number }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool-announced'; slot: string; name: string }
  | { type: 'round-end'; round: number; finishReason: string | null }
  | { type: 'tool-start'; slot: string; name: string; input: unknown }
  | { type: 'tool-result'; slot: string; name: string; input: unknown; result: ToolDispatchResult }
  | { type: 'transcript'; messages: ChatMessage[] };

export type AgentStatus = 'done' | 'interrupted' | 'cap';

export const slotId = (round: number, index: number) => `${round}:${index}`;

const INTERRUPTED_NOTE = '（用户中断了这次回答）';

/**
 * Run the model ↔ tool loop until the model answers without tool calls, the
 * user stops it, or MAX_ROUNDS is reached. The transcript is reported through
 * `transcript` events as it grows, so a thrown error never loses progress.
 */
export async function runAgent(options: {
  config: AssistantConfig;
  bootstrap: Bootstrap;
  /** Extra context appended to the system prompt (active profile …). */
  context: string;
  profileId: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<AgentStatus> {
  const { config, bootstrap, profileId, signal, onEvent } = options;
  const system = `${bootstrap.systemPrompt}${options.context}`;
  const convo = repairTranscript(options.messages);
  const commit = () => onEvent({ type: 'transcript', messages: [...convo] });

  const interrupt = (partial: string) => {
    convo.push({ role: 'assistant', content: partial ? `${partial}\n\n${INTERRUPTED_NOTE}` : INTERRUPTED_NOTE });
    // Calls that never ran still need a reply before the next request.
    onEvent({ type: 'transcript', messages: repairTranscript(convo) });
    return 'interrupted' as const;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) return interrupt('');
    onEvent({ type: 'round-start', round });
    const turn = await streamModelRound({
      config,
      system,
      tools: bootstrap.tools,
      messages: convo,
      signal,
      onDelta: (delta) => {
        if (delta.type === 'tool-announced') onEvent({ type: 'tool-announced', slot: slotId(round, delta.index), name: delta.name });
        else onEvent(delta);
      },
    });
    onEvent({ type: 'round-end', round, finishReason: turn.finishReason });
    if (turn.aborted) return interrupt(turn.content);

    convo.push({
      role: 'assistant',
      content: turn.content || null,
      ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
      ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
    });
    commit();
    if (!turn.toolCalls.length) return 'done';

    for (const [index, call] of turn.toolCalls.entries()) {
      const slot = slotId(round, index);
      const name = call.function.name;
      let input: unknown = {};
      let parseFailed = false;
      try {
        input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
      } catch {
        parseFailed = true;
      }
      if (signal.aborted) {
        // Unanswered calls are closed out by repairTranscript.
        return interrupt('');
      }
      onEvent({ type: 'tool-start', slot, name, input });
      let result: ToolDispatchResult;
      if (parseFailed) {
        result = errorResult('工具参数不是合法的 JSON，请重新生成参数后再调用。');
      } else {
        try {
          result = await dispatchTool(profileId, name, input, signal);
        } catch {
          return interrupt('');
        }
      }
      onEvent({ type: 'tool-result', slot, name, input, result });
      convo.push({ role: 'tool', tool_call_id: call.id, content: result.modelContent });
      commit();
    }
  }
  return 'cap';
}
