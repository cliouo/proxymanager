'use client';

/**
 * Conversation store for the assistant — one conversation per profile id,
 * kept outside React so a running turn survives the panel closing or moving
 * between the dock and the sheet. Persisted to sessionStorage (throttled).
 */

import { useSyncExternalStore } from 'react';
import { ApiError, errorMessage } from '@/ui/data/api';
import { keys, refreshProfile, refreshProfiles, refreshShared } from '@/ui/data/hooks';
import { fetchQuery } from '@/ui/data/query';
import {
  MAX_ROUNDS,
  ModelError,
  confirmWrite,
  fetchAssistantConfig,
  isAbortError,
  loadBootstrap,
  repairTranscript,
  runAgent,
  type AgentEvent,
  type AgentStatus,
  type ChatMessage,
} from './agent';
import { previewText } from './format';
import { describeInput, describeResult, resultError } from './labels';

export interface ProfileTarget {
  id: string;
  name: string;
  label: string;
}

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';
export type ConfirmStatus = 'pending' | 'confirming' | 'done' | 'unknown' | 'failed' | 'cancelled' | 'expired';

export interface UserItem {
  id: string;
  type: 'user';
  text: string;
}
export interface AssistantItem {
  id: string;
  type: 'assistant';
  text: string;
  reasoning: string;
  streaming: boolean;
  thinkingMs?: number;
  truncated?: boolean;
}
export interface ToolItem {
  id: string;
  type: 'tool';
  slot: string;
  name: string;
  status: ToolStatus;
  input?: unknown;
  hint?: string | null;
  kind?: string;
  summary?: string | null;
  preview?: string;
  untrusted?: boolean;
  error?: string;
}
export interface ConfirmItem {
  id: string;
  type: 'confirm';
  slot: string;
  name: string;
  summary: string;
  diff: unknown;
  token: string;
  expiresAt: number;
  status: ConfirmStatus;
  result?: string;
  undoable?: boolean;
  error?: string;
  issues?: string[];
}
export interface NoticeItem {
  id: string;
  type: 'notice';
  tone: 'error' | 'info';
  text: string;
  retry?: boolean;
  settings?: boolean;
}
export type Item = UserItem | AssistantItem | ToolItem | ConfirmItem | NoticeItem;

export interface Conversation {
  items: Item[];
  /** Model transcript (no system message). */
  messages: ChatMessage[];
  /** Confirm-card outcomes waiting to be told to the model. */
  queued: string[];
  running: boolean;
}

/* ─── store ──────────────────────────────────────────────────────────── */

const EMPTY: Conversation = { items: [], messages: [], queued: [], running: false };
const STORAGE_PREFIX = 'pm.assistant.v1:';
const convos = new Map<string, Conversation>();
const controllers = new Map<string, AbortController>();
const persistTimers = new Map<string, number>();
const listeners = new Set<() => void>();

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function settle(item: Item): Item {
  if (item.type === 'assistant' && item.streaming) return { ...item, streaming: false };
  if (item.type === 'tool' && (item.status === 'pending' || item.status === 'running')) {
    return { ...item, status: 'error', error: '页面刷新，调用被中断。' };
  }
  if (item.type === 'confirm' && item.status === 'confirming') {
    return { ...item, status: 'unknown', error: '执行途中页面刷新了，结果未知。' };
  }
  return item;
}

function hydrate(profileId: string): Conversation {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as { v?: number; items?: unknown; messages?: unknown; queued?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.items) || !Array.isArray(parsed.messages)) return { ...EMPTY };
    return {
      items: (parsed.items as Item[]).map(settle),
      messages: repairTranscript(parsed.messages as ChatMessage[]),
      queued: Array.isArray(parsed.queued) ? parsed.queued.filter((q): q is string => typeof q === 'string') : [],
      running: false,
    };
  } catch {
    return { ...EMPTY };
  }
}

function read(profileId: string): Conversation {
  let convo = convos.get(profileId);
  if (!convo) {
    convo = hydrate(profileId);
    convos.set(profileId, convo);
  }
  return convo;
}

function persist(profileId: string) {
  const convo = convos.get(profileId);
  if (!convo) return;
  try {
    const key = STORAGE_PREFIX + profileId;
    if (!convo.items.length && !convo.messages.length) window.sessionStorage.removeItem(key);
    else
      window.sessionStorage.setItem(
        key,
        JSON.stringify({ v: 1, items: convo.items, messages: convo.messages, queued: convo.queued }),
      );
  } catch {
    /* storage full or unavailable — keep the conversation in memory only */
  }
}

function schedulePersist(profileId: string) {
  if (typeof window === 'undefined' || persistTimers.has(profileId)) return;
  persistTimers.set(
    profileId,
    window.setTimeout(() => {
      persistTimers.delete(profileId);
      persist(profileId);
    }, 600),
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const id of convos.keys()) persist(id);
  });
}

function update(profileId: string, fn: (convo: Conversation) => Conversation) {
  convos.set(profileId, fn(read(profileId)));
  schedulePersist(profileId);
  for (const listener of listeners) listener();
}

function patchItem<T extends Item>(profileId: string, id: string, fn: (item: T) => Item) {
  update(profileId, (c) => ({ ...c, items: c.items.map((item) => (item.id === id ? fn(item as T) : item)) }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConversation(profileId: string | null): Conversation {
  return useSyncExternalStore(
    subscribe,
    () => (profileId ? read(profileId) : EMPTY),
    () => EMPTY,
  );
}

/* ─── running a turn ─────────────────────────────────────────────────── */

function contextFor(target: ProfileTarget): string {
  return `\n\n---\n当前上下文：用户正在配置文件「${target.label}」（name: ${target.name}）中与你对话。规则、策略组、基础配置和设备类工具都作用于这份配置文件；订阅源、聚合订阅与规则集为所有配置文件共享。`;
}

function errorText(error: unknown): { text: string; settings: boolean } {
  if (error instanceof ModelError) return { text: error.message, settings: error.kind === 'auth' || error.kind === 'network' };
  return { text: errorMessage(error), settings: false };
}

async function run(target: ProfileTarget, userText?: string) {
  const pid = target.id;
  if (controllers.has(pid)) return;
  const controller = new AbortController();
  controllers.set(pid, controller);

  update(pid, (c) => {
    let messages = c.messages;
    const parts = [...c.queued, ...(userText ? [userText] : [])];
    if (parts.length) {
      const text = parts.join('\n\n');
      const last = messages[messages.length - 1];
      // Keep strict user/assistant alternation: fold into a trailing user turn.
      messages =
        last?.role === 'user'
          ? [...messages.slice(0, -1), { role: 'user', content: `${last.content ?? ''}\n\n${text}` }]
          : [...messages, { role: 'user', content: text }];
    }
    const items = c.items.filter((item) => !(item.type === 'notice' && item.retry));
    if (userText) items.push({ id: uid(), type: 'user', text: userText });
    return { ...c, items, messages, queued: [], running: true };
  });

  let assistantId: string | null = null;
  let pending = { reasoning: '', content: '' };
  let frame = 0;
  let thinkStart = 0;
  let thinkingMs: number | undefined;
  const slots = new Map<string, string>();

  const endThinking = () => {
    if (thinkStart && thinkingMs === undefined) thinkingMs = Date.now() - thinkStart;
  };
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!assistantId) return;
    const { reasoning, content } = pending;
    pending = { reasoning: '', content: '' };
    const ms = thinkingMs;
    patchItem<AssistantItem>(pid, assistantId, (item) => ({
      ...item,
      reasoning: item.reasoning + reasoning,
      text: item.text + content,
      thinkingMs: item.thinkingMs ?? ms,
    }));
  };
  const scheduleFlush = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const addItem = (item: Item) => update(pid, (c) => ({ ...c, items: [...c.items, item] }));
  const ensureTool = (slot: string, name: string) => {
    let id = slots.get(slot);
    if (!id) {
      id = uid();
      slots.set(slot, id);
      addItem({ id, type: 'tool', slot, name, status: 'pending' });
    }
    return id;
  };

  const onEvent = (event: AgentEvent) => {
    switch (event.type) {
      case 'round-start':
        flush();
        assistantId = uid();
        thinkStart = 0;
        thinkingMs = undefined;
        addItem({ id: assistantId, type: 'assistant', text: '', reasoning: '', streaming: true });
        break;
      case 'reasoning':
        if (!thinkStart) thinkStart = Date.now();
        pending.reasoning += event.text;
        scheduleFlush();
        break;
      case 'content':
        endThinking();
        pending.content += event.text;
        scheduleFlush();
        break;
      case 'tool-announced':
        endThinking();
        flush();
        ensureTool(event.slot, event.name);
        break;
      case 'round-end': {
        endThinking();
        flush();
        const id = assistantId;
        assistantId = null;
        if (!id) break;
        update(pid, (c) => ({
          ...c,
          items: c.items.flatMap((item) => {
            if (item.id !== id || item.type !== 'assistant') return [item];
            if (!item.text.trim() && !item.reasoning.trim()) return [];
            return [{ ...item, streaming: false, truncated: event.finishReason === 'length' || undefined }];
          }),
        }));
        break;
      }
      case 'tool-start': {
        const id = ensureTool(event.slot, event.name);
        patchItem<ToolItem>(pid, id, (item) => ({
          ...item,
          status: 'running',
          input: event.input,
          hint: describeInput(event.name, event.input),
        }));
        break;
      }
      case 'tool-result': {
        const id = ensureTool(event.slot, event.name);
        const { result } = event;
        if (result.kind === 'confirm-write' && result.data && typeof result.data === 'object') {
          const data = result.data as Record<string, unknown>;
          patchItem<ToolItem>(pid, id, () => ({
            id,
            type: 'confirm',
            slot: event.slot,
            name: typeof data.action === 'string' ? data.action : event.name,
            summary: typeof data.summary === 'string' ? data.summary : '',
            diff: data.diff,
            token: typeof data.token === 'string' ? data.token : '',
            expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + 300_000,
            status: 'pending',
          }));
        } else {
          const failed = result.kind === 'error';
          patchItem<ToolItem>(pid, id, (item) => ({
            ...item,
            status: failed ? 'error' : 'done',
            kind: result.kind,
            untrusted: result.untrusted || undefined,
            summary: failed ? null : describeResult(result.kind, result.data),
            preview: previewText(result.data),
            error: failed ? resultError(result.data) : undefined,
          }));
        }
        break;
      }
      case 'transcript':
        update(pid, (c) => ({ ...c, messages: event.messages }));
        break;
    }
  };

  let status: AgentStatus | 'error' = 'error';
  try {
    const [config, bootstrap] = await Promise.all([
      fetchQuery(keys.assistantConfig, fetchAssistantConfig),
      loadBootstrap(),
    ]);
    if (!config) {
      addItem({ id: uid(), type: 'notice', tone: 'error', text: 'AI 助手还没有配置模型。', settings: true });
    } else {
      status = await runAgent({
        config,
        bootstrap,
        context: contextFor(target),
        profileId: pid,
        messages: read(pid).messages,
        signal: controller.signal,
        onEvent,
      });
      if (status === 'interrupted') addItem({ id: uid(), type: 'notice', tone: 'info', text: '已停止' });
      if (status === 'cap') {
        addItem({
          id: uid(),
          type: 'notice',
          tone: 'info',
          text: `已连续调用 ${MAX_ROUNDS} 轮工具，先停在这里；回复「继续」可以接着做。`,
        });
      }
    }
  } catch (error) {
    flush();
    const failedId = assistantId;
    // Drop the half-streamed round and calls that never ran — they are not in the transcript.
    update(pid, (c) => ({
      ...c,
      items: c.items.filter((item) => item.id !== failedId && !(item.type === 'tool' && item.status === 'pending')),
    }));
    if (controller.signal.aborted || isAbortError(error)) {
      status = 'interrupted';
      addItem({ id: uid(), type: 'notice', tone: 'info', text: '已停止' });
    } else {
      const { text, settings } = errorText(error);
      addItem({ id: uid(), type: 'notice', tone: 'error', text, retry: true, settings });
    }
  } finally {
    flush();
    controllers.delete(pid);
    update(pid, (c) => ({ ...c, running: false }));
  }
  // Confirm cards resolved while the model was busy: let it react now.
  if (status === 'done' && read(pid).queued.length) void run(target);
}

/* ─── public actions ─────────────────────────────────────────────────── */

export function sendMessage(target: ProfileTarget, text: string) {
  const trimmed = text.trim();
  if (!trimmed || controllers.has(target.id)) return;
  void run(target, trimmed);
}

export function retry(target: ProfileTarget) {
  void run(target);
}

export function stop(profileId: string) {
  controllers.get(profileId)?.abort();
}

export function clearConversation(profileId: string) {
  controllers.get(profileId)?.abort();
  convos.set(profileId, { ...EMPTY });
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + profileId);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}

function tellModel(target: ProfileTarget, note: string, kick = true) {
  update(target.id, (c) => ({ ...c, queued: [...c.queued, `【确认卡结果】${note}`] }));
  if (kick && !controllers.has(target.id)) void run(target);
}

export function markExpired(profileId: string, itemId: string) {
  patchItem<ConfirmItem>(profileId, itemId, (item) => (item.status === 'pending' ? { ...item, status: 'expired' } : item));
}

export async function resolveConfirm(target: ProfileTarget, itemId: string, decision: 'confirm' | 'cancel') {
  const pid = target.id;
  const item = read(pid).items.find((i): i is ConfirmItem => i.id === itemId && i.type === 'confirm');
  if (!item || item.status !== 'pending') return;
  const what = `「${item.summary}」`;

  if (decision === 'cancel') {
    patchItem<ConfirmItem>(pid, itemId, (i) => ({ ...i, status: 'cancelled' }));
    tellModel(target, `用户取消了${what}，没有执行任何改动。`);
    return;
  }

  patchItem<ConfirmItem>(pid, itemId, (i) => ({ ...i, status: 'confirming' }));
  const refresh = () => {
    refreshProfile(pid);
    refreshShared();
    if (item.name.includes('profile')) refreshProfiles();
  };
  try {
    const outcome = await confirmWrite(item.token);
    refresh();
    if (outcome.kind === 'write-result') {
      patchItem<ConfirmItem>(pid, itemId, (i) => ({
        ...i,
        status: 'done',
        result: outcome.summary || i.summary,
        undoable: outcome.undoable || undefined,
      }));
      tellModel(target, `用户已确认，${what}执行成功。执行结果：${outcome.modelContent}`);
    } else {
      patchItem<ConfirmItem>(pid, itemId, (i) => ({ ...i, status: 'unknown' }));
      tellModel(target, `用户确认了${what}，但服务器没有返回明确结果：${outcome.modelContent}`);
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      patchItem<ConfirmItem>(pid, itemId, (i) => ({ ...i, status: 'expired' }));
      tellModel(target, `${what}的确认已失效（超时或已使用），没有执行。`, false);
      return;
    }
    if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) {
      // The request may have reached the server: the write could have happened.
      refresh();
      patchItem<ConfirmItem>(pid, itemId, (i) => ({ ...i, status: 'unknown', error: errorMessage(error) }));
      tellModel(target, `用户确认了${what}，但执行结果未知（${errorMessage(error)}）。不要自动重试，先请用户核对当前状态。`);
      return;
    }
    const issues = error.issues.map((issue) => issue.message).slice(0, 6);
    patchItem<ConfirmItem>(pid, itemId, (i) => ({ ...i, status: 'failed', error: errorMessage(error), issues }));
    tellModel(target, `用户确认了${what}，但执行失败：${errorMessage(error)}。不要自动重试，先向用户说明原因。`);
  }
}
