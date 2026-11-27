'use client';

import {
  acquireTakeover,
  agentTools,
  beginClosedQueryCleanup,
  consumeTakeoverRouteDrifted,
  customTools,
  executeCustomTool,
  findCustomTool,
  getAgent,
  hasMainSkeletons,
  isBuiltinOwnerValid,
  markTakeoverActing,
  runAgentAct,
  runAgentQuery,
  settleRouteCommit,
  waitForBusySubmitSettle,
  waitForRouteChange,
  waitIfPaused,
  type AgentStep,
  type AppAgent,
} from '@/ui/agent';
import { ApiError, api, errorMessage } from '@/ui/data/api';
import type { AssistantConfig } from '@/ui/data/types';
import {
  analyzeToolError,
  extractActOutcomeCounts,
  extractOpenOverlays,
  type RunDiagnosticRecorder,
  type ToolErrorAnalysis,
} from './diagnostics';
import { describeInput } from './labels';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolDispatchResult {
  kind: 'snapshot' | 'query' | 'act' | 'custom' | 'error';
  data: unknown;
  modelContent: string;
}

export const MAX_ROUNDS = 40;

export function toOpenAiTools(): OpenAiTool[] {
  return [...agentTools, ...customTools].map(({ name, description, inputSchema }) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: inputSchema as Record<string, unknown>,
    },
  }));
}

export async function fetchAssistantConfig(): Promise<AssistantConfig | null> {
  try {
    return await api.get<AssistantConfig>('/assistant/config');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export type ModelErrorKind = 'auth' | 'rate' | 'server' | 'network' | 'request' | 'stream';

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

function buildBody(config: AssistantConfig, system: string, tools: OpenAiTool[], messages: ChatMessage[]) {
  const thinking = config.thinking ?? 'enabled';
  const body: Json = {
    model: config.model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    max_tokens: config.maxTokens ?? 8192,
    stream: true,
    thinking: { type: thinking },
  };
  if (thinking === 'enabled') body.reasoning_effort = config.reasoningEffort ?? 'high';
  else body.temperature = 0.3;
  return body;
}

export async function streamModelRound(options: {
  config: AssistantConfig;
  system: string;
  tools: OpenAiTool[];
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
        return;
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

function errorResult(message: string, analysis?: ToolErrorAnalysis): ToolDispatchResult {
  const data: Json = {
    error: message,
    ...(analysis
      ? {
          errorCode: analysis.code,
          errorCodes: analysis.codes,
          ...(analysis.hint ? { hint: analysis.hint } : {}),
        }
      : {}),
  };
  return { kind: 'error', data, modelContent: JSON.stringify(data) };
}

function attachAnalysis(data: unknown, analysis: ToolErrorAnalysis): unknown {
  if (!isRecord(data)) return data;
  return {
    ...data,
    errorCode: analysis.code,
    errorCodes: analysis.codes,
    ...(analysis.failedStepIndex !== undefined ? { failedStepIndex: analysis.failedStepIndex } : {}),
    ...(analysis.completedSteps !== undefined ? { completedSteps: analysis.completedSteps } : {}),
    ...(analysis.hint ? { hint: analysis.hint } : {}),
  };
}

function makeAbortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Aborted', 'AbortError')
    : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

export async function dispatchAgentTool(
  name: string,
  input: unknown,
  options?: {
    signal?: AbortSignal;
    owner?: AbortController;
    onStop?: () => void;
    onSideEffectDispatched?: () => void;
    agent?: AppAgent;
    diagnostics?: RunDiagnosticRecorder;
    round?: number;
    slot?: string;
  },
): Promise<ToolDispatchResult> {
  const target = options?.agent ?? getAgent();
  const signal = options?.signal;
  const owner = options?.owner;
  const diagnostics = options?.diagnostics;
  const round = options?.round ?? 0;
  const slot = options?.slot ?? '0:0';
  const diagBegin = diagnostics?.beginCall(target);

  const safeSnap = () => {
    try {
      return target.snapshot();
    } catch {
      return [];
    }
  };

  try {
    if (name === 'snapshot') {
      const data = target.snapshot();
      const loading = hasMainSkeletons();
      const modelContent = loading
        ? JSON.stringify({
            components: data,
            route: typeof window !== 'undefined' ? window.location.pathname : '',
            loading: true,
            hint: '主区域仍有部分骨架屏在加载；已可见的按钮可直接用 act 操作，若目标数据或列表尚未出现，可调用 wait_for 等待其渲染。',
          })
        : JSON.stringify(data);
      if (diagnostics && diagBegin) {
        diagnostics.finishCall({ round, slot, tool: name, input, status: 'ok', agent: target, begin: diagBegin });
      }
      return { kind: 'snapshot', data, modelContent };
    }
    if (name === 'query') {
      const args = isRecord(input) ? input : {};
      if (args.closed === true) {
        await waitIfPaused(signal, owner);
        if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
        let endActing: () => void = () => {};
        let endCleanup: () => void = () => {};
        if (owner) {
          acquireTakeover(owner, { onStop: options?.onStop, activityLabel: '查询隐藏页面内容' });
          endActing = markTakeoverActing(owner, '查询隐藏页面内容', { mutating: false });
          endCleanup = beginClosedQueryCleanup(owner);
        }
        try {
          const data = await runAgentQuery(args as Parameters<AppAgent['query']>[0], {
            signal,
            source: 'ai_chat',
            owner,
            agent: target,
          });
          // Discard partial arrays if the run was aborted or expired while SDK restored closed tabs.
          if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
          if (isRecord(data) && typeof data.error === 'string') {
            const analysis = analyzeToolError({
              name,
              input,
              data,
              currentSnapshot: safeSnap(),
              lastObservedSnapshot: diagnostics?.getLastObservedSnapshot(),
              recentClosedOverlays: diagnostics?.getRecentClosedOverlays(),
            });
            const enriched = attachAnalysis(data, analysis);
            if (diagnostics && diagBegin) {
              diagnostics.finishCall({
                round,
                slot,
                tool: name,
                input,
                status: 'error',
                agent: target,
                begin: diagBegin,
                analysis,
              });
            }
            return { kind: 'error', data: enriched, modelContent: JSON.stringify(enriched) };
          }
          if (diagnostics && diagBegin) {
            diagnostics.finishCall({ round, slot, tool: name, input, status: 'ok', agent: target, begin: diagBegin });
          }
          return { kind: 'query', data, modelContent: JSON.stringify(data) };
        } finally {
          endActing();
          endCleanup();
        }
      }
      const data = await runAgentQuery(args as Parameters<AppAgent['query']>[0], {
        signal,
        source: 'ai_chat',
        owner,
        agent: target,
      });
      if (isRecord(data) && typeof data.error === 'string') {
        const analysis = analyzeToolError({
          name,
          input,
          data,
          currentSnapshot: safeSnap(),
          lastObservedSnapshot: diagnostics?.getLastObservedSnapshot(),
          recentClosedOverlays: diagnostics?.getRecentClosedOverlays(),
        });
        const enriched = attachAnalysis(data, analysis);
        if (diagnostics && diagBegin) {
          diagnostics.finishCall({
            round,
            slot,
            tool: name,
            input,
            status: 'error',
            agent: target,
            begin: diagBegin,
            analysis,
          });
        }
        return { kind: 'error', data: enriched, modelContent: JSON.stringify(enriched) };
      }
      if (diagnostics && diagBegin) {
        diagnostics.finishCall({ round, slot, tool: name, input, status: 'ok', agent: target, begin: diagBegin });
      }
      return { kind: 'query', data, modelContent: JSON.stringify(data) };
    }
    if (name === 'act') {
      await waitIfPaused(signal, owner);
      if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
      const validSteps = isRecord(input) && Array.isArray(input.steps) && input.steps.length > 0;
      const label = describeInput('act', input) ?? '操作页面';
      let endActing: () => void = () => {};
      if (validSteps && owner) {
        acquireTakeover(owner, { onStop: options?.onStop, activityLabel: label });
        endActing = markTakeoverActing(owner, label, { mutating: true });
      }
      const beforePath = typeof window !== 'undefined' ? window.location.pathname : '';
      const initialDialogs = new Set(
        typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]'))
          : [],
      );
      const pressedTargets: HTMLElement[] = [];
      let navigationIntent = false;
      let expectedPath: string | undefined;
      try {
        if (validSteps) options?.onSideEffectDispatched?.();
        const data = await runAgentAct(input as { steps: AgentStep[] }, {
          signal,
          source: 'ai_chat',
          owner,
          agent: target,
          onNavigationIntent: (nextPath) => {
            navigationIntent = true;
            expectedPath = nextPath;
          },
          onPressedTarget: (el) => {
            pressedTargets.push(el);
          },
        });
        if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
        const ok = !(isRecord(data) && data.ok === false);
        const waitedBusy = ok
          ? await waitForBusySubmitSettle({
              targets: pressedTargets,
              fromPath: beforePath,
              initialDialogs,
              signal,
            })
          : false;
        if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
        if (ok && navigationIntent && typeof window !== 'undefined' && window.location.pathname === beforePath) {
          await waitForRouteChange(beforePath, { signal, expectedPath });
          if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
        }
        const afterPath = typeof window !== 'undefined' ? window.location.pathname : '';
        const navigated = Boolean(beforePath && afterPath && afterPath !== beforePath);
        if (ok && navigated) {
          await settleRouteCommit(signal);
          if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
        }
        if (!ok) {
          const analysis = analyzeToolError({
            name,
            input,
            data,
            currentSnapshot: safeSnap(),
            lastObservedSnapshot: diagnostics?.getLastObservedSnapshot(),
            recentClosedOverlays: diagnostics?.getRecentClosedOverlays(),
          });
          const enriched = attachAnalysis(data, analysis);
          if (diagnostics && diagBegin) {
            diagnostics.finishCall({
              round,
              slot,
              tool: name,
              input,
              status: 'error',
              agent: target,
              begin: diagBegin,
              analysis,
            });
          }
          return { kind: 'error', data: enriched, modelContent: JSON.stringify(enriched) };
        }
        const reportedOpen = isRecord(data)
          ? extractOpenOverlays([
              ...(Array.isArray(data.open) ? (data.open as Parameters<typeof extractOpenOverlays>[0]) : []),
              ...(Array.isArray(data.appeared) ? (data.appeared as Parameters<typeof extractOpenOverlays>[0]) : []),
            ])
          : [];
        const finished = diagnostics && diagBegin
          ? diagnostics.finishCall({
              round,
              slot,
              tool: name,
              input,
              status: 'ok',
              agent: target,
              begin: diagBegin,
              navigated,
              navigationPending: navigationIntent && !navigated,
              reportedOpenOverlays: reportedOpen,
              actOutcome: extractActOutcomeCounts(data),
            })
          : { closedBeforeReturn: [] };
        const overlayClosedNote =
          !navigated && finished.closedBeforeReturn.length > 0
            ? `注意：刚才打开的浮层（${finished.closedBeforeReturn.map((o) => o.label || o.component).join('、')}）在返回前已关闭，下一步操作前请先重新打开或调用 snapshot 确认。`
            : undefined;
        const closedDialogAfterBusy =
          waitedBusy && initialDialogs.size > 0 && Array.from(initialDialogs).some((d) => !d.isConnected);
        let modelContent: string;
        if (navigated && isRecord(data)) {
          // Drop stale pre-navigation form values so the model sees the new route cleanly.
          const { values: _staleValues, ...rest } = data;
          void _staleValues;
          modelContent = JSON.stringify({
            ...rest,
            route: afterPath,
            navigated: { from: beforePath, to: afterPath },
            loading: hasMainSkeletons(),
          });
        } else if (navigationIntent && isRecord(data)) {
          modelContent = JSON.stringify({
            ...data,
            route: afterPath,
            navigationPending: true,
            ...(waitedBusy ? { settledAfterBusy: true } : {}),
            ...(closedDialogAfterBusy ? { dialogClosed: true } : {}),
            ...(overlayClosedNote ? { note: overlayClosedNote } : {}),
          });
        } else if ((overlayClosedNote || waitedBusy) && isRecord(data)) {
          modelContent = JSON.stringify({
            ...data,
            ...(waitedBusy ? { settledAfterBusy: true } : {}),
            ...(closedDialogAfterBusy ? { dialogClosed: true } : {}),
            ...(overlayClosedNote ? { note: overlayClosedNote } : {}),
          });
        } else {
          modelContent = JSON.stringify(data);
        }
        return { kind: 'act', data, modelContent };
      } finally {
        endActing();
      }
    }
    const custom = findCustomTool(name);
    if (custom) {
      if (custom.effect === 'write') {
        await waitIfPaused(signal, owner);
        if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
      }
      const data = await executeCustomTool(name, input, {
        signal,
        source: 'ai_chat',
        owner,
        agent: target,
        onWriteDispatched: custom.effect === 'write' ? options?.onSideEffectDispatched : undefined,
      });
      if (signal?.aborted || !isBuiltinOwnerValid(owner)) throw makeAbortError();
      if (isRecord(data) && data.ok === false) {
        const analysis = analyzeToolError({ name, data, currentSnapshot: [] });
        const enriched = attachAnalysis(data, analysis);
        if (diagnostics && diagBegin) {
          diagnostics.finishCall({
            round,
            slot,
            tool: name,
            input,
            status: 'error',
            agent: target,
            begin: diagBegin,
            analysis,
          });
        }
        return { kind: 'error', data: enriched, modelContent: JSON.stringify(enriched) };
      }
      if (diagnostics && diagBegin) {
        diagnostics.finishCall({ round, slot, tool: name, input, status: 'ok', agent: target, begin: diagBegin });
      }
      return { kind: 'custom', data, modelContent: JSON.stringify(data) };
    }
    const unknownAnalysis: ToolErrorAnalysis = { code: 'invalid_args', codes: ['invalid_args'] };
    if (diagnostics && diagBegin) {
      diagnostics.finishCall({
        round,
        slot,
        tool: name,
        input,
        status: 'error',
        agent: target,
        begin: diagBegin,
        analysis: unknownAnalysis,
      });
    }
    return errorResult(`未知工具：${name}`, unknownAnalysis);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    const errAnalysis: ToolErrorAnalysis = { code: 'unknown', codes: ['unknown'] };
    if (diagnostics && diagBegin) {
      diagnostics.finishCall({
        round,
        slot,
        tool: name,
        input,
        status: 'error',
        agent: target,
        begin: diagBegin,
        analysis: errAnalysis,
      });
    }
    return errorResult(errorMessage(error), errAnalysis);
  }
}

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

export async function runAgent(options: {
  config: AssistantConfig;
  system: string;
  tools?: OpenAiTool[];
  messages: ChatMessage[];
  signal: AbortSignal;
  owner?: AbortController;
  onStop?: () => void;
  agent?: AppAgent;
  diagnostics?: RunDiagnosticRecorder;
  onEvent: (event: AgentEvent) => void;
}): Promise<AgentStatus> {
  const { config, system, signal, owner, onStop, agent, diagnostics, onEvent } = options;
  const tools = options.tools ?? toOpenAiTools();
  const convo = repairTranscript(options.messages);
  const commit = () => onEvent({ type: 'transcript', messages: [...convo] });

  const interrupt = (partial: string) => {
    convo.push({ role: 'assistant', content: partial ? `${partial}\n\n${INTERRUPTED_NOTE}` : INTERRUPTED_NOTE });
    onEvent({ type: 'transcript', messages: repairTranscript(convo) });
    return 'interrupted' as const;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      await waitIfPaused(signal, owner);
    } catch {
      return interrupt('');
    }
    if (signal.aborted) return interrupt('');
    onEvent({ type: 'round-start', round });
    const turn = await streamModelRound({
      config,
      system,
      tools,
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
      try {
        await waitIfPaused(signal, owner);
      } catch {
        return interrupt('');
      }
      const slot = slotId(round, index);
      const name = call.function.name;
      let input: unknown = {};
      let parseFailed = false;
      try {
        input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
      } catch {
        parseFailed = true;
      }
      if (signal.aborted) return interrupt('');
      onEvent({ type: 'tool-start', slot, name, input });
      let result: ToolDispatchResult;
      if (parseFailed) {
        result = errorResult('工具参数不是合法的 JSON，请重新生成参数后再调用。', {
          code: 'invalid_args',
          codes: ['invalid_args'],
        });
      } else if (name !== 'snapshot' && consumeTakeoverRouteDrifted()) {
        result = errorResult('暂停期间页面或配置已切换，请先调用 snapshot 重新确认当前页面后再继续。', {
          code: 'overlay_closed',
          codes: ['overlay_closed'],
        });
      } else {
        let sideEffectDispatched = false;
        try {
          result = await dispatchAgentTool(name, input, {
            signal,
            owner,
            onStop,
            agent,
            diagnostics,
            round,
            slot,
            onSideEffectDispatched: () => {
              sideEffectDispatched = true;
            },
          });
        } catch {
          const abortedResult = sideEffectDispatched
            ? {
                kind: 'error' as const,
                data: {
                  interrupted: true,
                  status: 'dispatched_unverified',
                  error: '操作已发起但在返回前被中断，页面或服务端可能已完成变更。继续前请先调用 snapshot 核对当前状态，勿重复写入。',
                },
                modelContent: JSON.stringify({
                  interrupted: true,
                  status: 'dispatched_unverified',
                  error: '操作已发起但在返回前被中断，页面或服务端可能已完成变更。继续前请先调用 snapshot 核对当前状态，勿重复写入。',
                }),
              }
            : errorResult('调用被中断，未执行。');
          onEvent({ type: 'tool-result', slot, name, input, result: abortedResult });
          convo.push({ role: 'tool', tool_call_id: call.id, content: abortedResult.modelContent });
          commit();
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
