'use client';

import { useSyncExternalStore } from 'react';
import { errorMessage } from '@/ui/data/api';
import { keys } from '@/ui/data/hooks';
import { fetchQuery } from '@/ui/data/query';
import {
  MAX_ROUNDS,
  ModelError,
  fetchAssistantConfig,
  isAbortError,
  repairTranscript,
  runAgent,
  type AgentEvent,
  type AgentStatus,
  type ChatMessage,
} from './agent';
import { previewText } from './format';
import { describeInput, describeResult, resultError } from './labels';
import { buildSystemPrompt, type AssistantRuntimeContext } from './prompt';

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

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
  error?: string;
}
export interface NoticeItem {
  id: string;
  type: 'notice';
  tone: 'error' | 'info';
  text: string;
  retry?: boolean;
  settings?: boolean;
}
export type Item = UserItem | AssistantItem | ToolItem | NoticeItem;

export interface Conversation {
  items: Item[];
  messages: ChatMessage[];
  running: boolean;
}

const EMPTY: Conversation = { items: [], messages: [], running: false };
const STORAGE_KEY = 'pm.assistant.v2';
let convo: Conversation | null = null;
let controller: AbortController | null = null;
let persistTimer: number | null = null;
const listeners = new Set<() => void>();

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function settle(item: Item): Item {
  if (item.type === 'assistant' && item.streaming) return { ...item, streaming: false };
  if (item.type === 'tool' && (item.status === 'pending' || item.status === 'running')) {
    return { ...item, status: 'error', error: '页面刷新，调用被中断。' };
  }
  return item;
}

function hydrate(): Conversation {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as { v?: number; items?: unknown; messages?: unknown };
    if (parsed.v !== 2 || !Array.isArray(parsed.items) || !Array.isArray(parsed.messages)) return { ...EMPTY };
    return {
      items: (parsed.items as Item[]).map(settle),
      messages: repairTranscript(parsed.messages as ChatMessage[]),
      running: false,
    };
  } catch {
    return { ...EMPTY };
  }
}

function read(): Conversation {
  if (!convo) convo = hydrate();
  return convo;
}

function persist() {
  if (!convo || typeof window === 'undefined') return;
  try {
    if (!convo.items.length && !convo.messages.length) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, items: convo.items, messages: convo.messages }));
  } catch {
    /* storage full or unavailable */
  }
}

function schedulePersist() {
  if (typeof window === 'undefined' || persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, 600);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => persist());
}

function update(fn: (current: Conversation) => Conversation) {
  convo = fn(read());
  schedulePersist();
  for (const listener of listeners) listener();
}

function patchItem<T extends Item>(id: string, fn: (item: T) => Item) {
  update((c) => ({ ...c, items: c.items.map((item) => (item.id === id ? fn(item as T) : item)) }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConversation(): Conversation {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

function errorText(error: unknown): { text: string; settings: boolean } {
  if (error instanceof ModelError) return { text: error.message, settings: error.kind === 'auth' || error.kind === 'network' };
  return { text: errorMessage(error), settings: false };
}

async function run(context: AssistantRuntimeContext, userText?: string) {
  if (controller) return;
  const activeController = new AbortController();
  controller = activeController;

  update((c) => {
    let messages = c.messages;
    if (userText) {
      const last = messages[messages.length - 1];
      messages =
        last?.role === 'user'
          ? [...messages.slice(0, -1), { role: 'user', content: `${last.content ?? ''}\n\n${userText}` }]
          : [...messages, { role: 'user', content: userText }];
    }
    const items = c.items.filter((item) => !(item.type === 'notice' && item.retry));
    if (userText) items.push({ id: uid(), type: 'user', text: userText });
    return { ...c, items, messages, running: true };
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
    patchItem<AssistantItem>(assistantId, (item) => ({
      ...item,
      reasoning: item.reasoning + reasoning,
      text: item.text + content,
      thinkingMs: item.thinkingMs ?? ms,
    }));
  };
  const scheduleFlush = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const addItem = (item: Item) => update((c) => ({ ...c, items: [...c.items, item] }));
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
        update((c) => ({
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
        patchItem<ToolItem>(id, (item) => ({
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
        const failed = result.kind === 'error';
        patchItem<ToolItem>(id, (item) => ({
          ...item,
          status: failed ? 'error' : 'done',
          kind: result.kind,
          summary: failed ? null : describeResult(result.kind, result.data),
          preview: previewText(result.data),
          error: failed ? resultError(result.data) : undefined,
        }));
        break;
      }
      case 'transcript':
        update((c) => ({ ...c, messages: event.messages }));
        break;
    }
  };

  let status: AgentStatus | 'error' = 'error';
  try {
    const config = await fetchQuery(keys.assistantConfig, fetchAssistantConfig);
    if (!config) {
      addItem({ id: uid(), type: 'notice', tone: 'error', text: 'AI 助手还没有配置模型。', settings: true });
    } else {
      status = await runAgent({
        config,
        system: buildSystemPrompt(context),
        messages: read().messages,
        signal: activeController.signal,
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
    update((c) => ({
      ...c,
      items: c.items.filter((item) => item.id !== failedId && !(item.type === 'tool' && item.status === 'pending')),
    }));
    if (activeController.signal.aborted || isAbortError(error)) {
      status = 'interrupted';
      addItem({ id: uid(), type: 'notice', tone: 'info', text: '已停止' });
    } else {
      const { text, settings } = errorText(error);
      addItem({ id: uid(), type: 'notice', tone: 'error', text, retry: true, settings });
    }
  } finally {
    flush();
    if (controller === activeController) controller = null;
    update((c) => ({ ...c, running: false }));
  }
}

export function sendMessage(context: AssistantRuntimeContext, text: string) {
  const trimmed = text.trim();
  if (!trimmed || controller) return;
  void run(context, trimmed);
}

export function retry(context: AssistantRuntimeContext) {
  void run(context);
}

export function stop() {
  controller?.abort();
}

export function clearConversation() {
  controller?.abort();
  convo = { ...EMPTY };
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}
