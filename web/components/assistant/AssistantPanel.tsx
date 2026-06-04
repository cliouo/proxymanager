'use client';

/**
 * Global assistant — a right-side drawer available on every authed page.
 *
 * The agent loop runs IN THE BROWSER (see lib/client/assistantAgent): it calls
 * the model API directly (no Vercel function in the path → no 60s cap), runs
 * tools in-browser or via the short /api/v1/assistant/tool endpoint, and
 * streams each step here as a typed event — tool-call chips, prefab result
 * cards, the model's streaming Markdown, and a retryable error banner.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/ai/deepseek';
import { AssistantNotConfiguredError, runAgentTurn } from '@/lib/client/assistantAgent';
import { loadAssistantConfig } from '@/lib/client/assistant-config';
import { CollapsibleResult, ResultCard, type ConfirmResolution } from './cards';
import { ErrorBanner } from './ErrorBanner';
import { Markdown } from './Markdown';

type AssistantBlock =
  | {
      type: 'tool';
      id: string;
      name: string;
      status: 'running' | 'done';
      kind?: string;
      data?: unknown;
    }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string };

type UiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; blocks: AssistantBlock[] };

const TOOL_LABELS: Record<string, string> = {
  search_mihomo_docs: '查询 mihomo 文档',
  get_base_overview: '读取配置概览',
  list_rules: '读取规则列表',
  get_config_outline: '读取配置目录',
  get_config_section: '读取配置区块',
  get_config_full: '读取完整配置',
  add_rule: '准备新增规则',
  update_rule: '准备修改规则',
  delete_rule: '准备删除规则',
  list_rule_providers: '读取规则集库',
  fetch_url: '抓取外部链接',
  create_rule_provider: '准备新增规则集',
  update_rule_provider: '准备修改规则集',
  delete_rule_provider: '准备删除规则集',
  localize_rule_provider: '准备转为本地托管',
  set_config_section: '准备修改配置区块',
  delete_config_section: '准备删除配置区块',
};

const EXAMPLES = [
  '我现在有哪些策略组？',
  'rule-providers 的 behavior 有哪些取值？',
  '把 figma.com 加一条规则走香港',
];

function newConversationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Persist the conversation so a refresh / reopen restores it. The browser now
// OWNS the transcript (the agent loop runs client-side), so we store both the
// rendered `messages` (UiMessage[]) and the raw model `convo` (ChatMessage[])
// that future turns continue from. Bounded by a TTL so very old threads start
// fresh rather than feed the model stale context.
const STORE_KEY = 'pm.assistant.v1';
const STORE_TTL_MS = 2 * 60 * 60 * 1000;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface Persisted {
  conversationId: string;
  messages: UiMessage[];
  convo?: ChatMessage[];
  savedAt: number;
}

interface Restored {
  conversationId: string;
  messages: UiMessage[];
  convo: ChatMessage[];
}

function loadPersisted(): Restored | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    if (!p || !CID_RE.test(p.conversationId) || !Array.isArray(p.messages)) return null;
    if (Date.now() - (p.savedAt ?? 0) > STORE_TTL_MS) return null; // thread too old
    // Settle any tool block left mid-flight by a refresh (no stuck spinner).
    const messages = p.messages.map((m) =>
      m.role === 'assistant'
        ? {
            role: 'assistant' as const,
            blocks: m.blocks.map((b) =>
              b.type === 'tool' && b.status === 'running' ? { ...b, status: 'done' as const } : b,
            ),
          }
        : m,
    );
    return { conversationId: p.conversationId, messages, convo: Array.isArray(p.convo) ? p.convo : [] };
  } catch {
    return null;
  }
}

function persist(conversationId: string, messages: UiMessage[], convo: ChatMessage[]): void {
  if (typeof window === 'undefined') return;
  const write = (msgs: UiMessage[], cv: ChatMessage[]) =>
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ conversationId, messages: msgs, convo: cv, savedAt: Date.now() } satisfies Persisted),
    );
  try {
    write(messages, convo);
  } catch {
    // localStorage quota: keep only the most recent slice, else give up.
    try {
      write(messages.slice(-12), convo.slice(-24));
    } catch {
      /* ignore */
    }
  }
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Keys the server-side transcript; a fresh id starts a clean context.
  const [conversationId, setConversationId] = useState(newConversationId);
  // Restore from localStorage after mount (avoids SSR hydration mismatch).
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Aborts the in-flight turn. Tied to the (always-mounted) component, NOT to
  // `open` — closing the drawer only hides UI; the stream keeps running in the
  // background and reopening shows its live state. We abort only on an explicit
  // 中断 click or when the tab unloads.
  const abortRef = useRef<AbortController | null>(null);
  // The raw model transcript (system prompt excluded) the agent continues from.
  // Owned by the browser now; persisted alongside the rendered messages.
  const [convo, setConvo] = useState<ChatMessage[]>([]);

  useEffect(() => {
    const p = loadPersisted();
    if (p) {
      setConversationId(p.conversationId);
      setMessages(p.messages);
      setConvo(p.convo);
    }
    setHydrated(true);
    // Refresh the DeepSeek config cache from KV once per page load ("刷新即更新").
    // The browser-side agent loop reads this cache per turn.
    void loadAssistantConfig();
  }, []);

  useEffect(() => {
    if (!hydrated) return; // don't clobber stored state before restore runs
    persist(conversationId, messages, convo);
  }, [hydrated, conversationId, messages, convo]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  /**
   * Replace a confirm-write block with its terminal form once the user acts, so
   * the *settled* state (executed result / cancelled) is what gets persisted —
   * not a pending card holding a spent one-time token.
   */
  function resolveConfirm(id: string, res: ConfirmResolution) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.role !== 'assistant') return m;
        const idx = m.blocks.findIndex((x) => x.type === 'tool' && x.id === id);
        if (idx === -1) return m;
        const old = m.blocks[idx];
        if (old.type !== 'tool' || old.kind !== 'confirm-write') return m;
        const blocks = m.blocks.slice();
        blocks[idx] =
          res.status === 'executed'
            ? { ...old, kind: res.result.kind, data: res.result.data }
            : { ...old, kind: 'confirm-cancelled' };
        return { role: 'assistant', blocks };
      }),
    );
  }

  /** Persist that a write-result block was undone, so a refresh keeps 已撤销. */
  function markBlockUndone(id: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.role !== 'assistant') return m;
        const idx = m.blocks.findIndex((x) => x.type === 'tool' && x.id === id);
        if (idx === -1) return m;
        const old = m.blocks[idx];
        if (old.type !== 'tool') return m;
        const blocks = m.blocks.slice();
        blocks[idx] = { ...old, data: { ...(old.data as Record<string, unknown>), undone: true } };
        return { role: 'assistant', blocks };
      }),
    );
  }

  function updateLastAssistant(fn: (blocks: AssistantBlock[]) => AssistantBlock[]) {
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant') {
        copy[copy.length - 1] = { role: 'assistant', blocks: fn(last.blocks) };
      }
      return copy;
    });
  }

  function handleEvent(ev: Record<string, unknown>) {
    switch (ev.type) {
      case 'tool_call':
        updateLastAssistant((b) => [
          ...b,
          { type: 'tool', id: String(ev.id), name: String(ev.name), status: 'running' },
        ]);
        break;
      case 'component':
        updateLastAssistant((b) => {
          const idx = b.findIndex((x) => x.type === 'tool' && x.id === ev.id);
          const resolved: AssistantBlock = {
            type: 'tool',
            id: String(ev.id),
            name: String(ev.name),
            status: 'done',
            kind: String(ev.kind),
            data: ev.data,
          };
          if (idx === -1) return [...b, resolved];
          const copy = b.slice();
          copy[idx] = resolved;
          return copy;
        });
        break;
      case 'assistant_delta':
        // Stream the model's answer: append to the trailing text block, or
        // open a new one (e.g. when text follows tool chips).
        updateLastAssistant((b) => {
          const last = b[b.length - 1];
          if (last && last.type === 'text') {
            const copy = b.slice();
            copy[copy.length - 1] = { type: 'text', content: last.content + String(ev.content) };
            return copy;
          }
          return [...b, { type: 'text', content: String(ev.content) }];
        });
        break;
      case 'error':
        updateLastAssistant((b) => [...b, { type: 'error', message: String(ev.message) }]);
        break;
    }
  }

  async function runTurn(message: string) {
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setMessages((prev) => [...prev, { role: 'assistant', blocks: [] }]);
    try {
      // The agent loop runs in the browser and calls the model directly. On
      // success it returns the full transcript to continue from next turn; on
      // error/abort it throws and we keep the prior transcript (so the failed
      // turn isn't persisted and a resend is clean).
      const next = await runAgentTurn({
        priorMessages: convo,
        userMessage: message,
        signal: controller.signal,
        onEvent: handleEvent,
      });
      setConvo(next);
    } catch (err) {
      if (err instanceof AssistantNotConfiguredError) {
        updateLastAssistant((b) => [
          ...b,
          {
            type: 'error',
            message:
              '尚未配置 AI 凭证——请到左侧「AI 配置」页填入 DeepSeek 的 Base URL / 模型 / API Key 后再使用。',
          },
        ]);
      } else if (err instanceof DOMException && err.name === 'AbortError') {
        // User hit 中断 — settle any running tool chip and leave a quiet marker.
        updateLastAssistant((b) => {
          const settled = b.map((x) =>
            x.type === 'tool' && x.status === 'running' ? { ...x, status: 'done' as const } : x,
          );
          return [...settled, { type: 'text', content: '_（已中断）_' }];
        });
      } else {
        updateLastAssistant((b) => [
          ...b,
          { type: 'error', message: err instanceof Error ? err.message : String(err) },
        ]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  /** User-initiated 中断 of the running turn. */
  function stop() {
    abortRef.current?.abort();
  }

  function sendText(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setMessages((prev) => [...prev, { role: 'user', content: t }]);
    void runTurn(t);
  }

  function send() {
    if (!input.trim() || busy) return;
    const t = input;
    setInput('');
    sendText(t);
  }

  /**
   * Drop the last (failed) assistant turn and re-run the last user message.
   * The server didn't persist the failed turn, so resending is clean.
   */
  function retry() {
    if (busy) return;
    let base = messages;
    if (base.length > 0 && base[base.length - 1].role === 'assistant') base = base.slice(0, -1);
    const lastUser = base[base.length - 1];
    if (!lastUser || lastUser.role !== 'user') return;
    setMessages(base);
    void runTurn(lastUser.content);
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-12 items-center gap-2 rounded-full bg-[var(--color-primary)] px-5 text-[14px] font-medium text-[var(--color-on-primary)] shadow-[var(--shadow-card-lift)] transition-colors hover:bg-[var(--color-primary-hover)]"
          aria-label={busy ? '配置助手（后台执行中）' : '打开配置助手'}
        >
          {busy ? (
            <span className="pm-spin inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <span className="text-[16px] leading-none">✦</span>
          )}
          {busy ? '执行中…' : '配置助手'}
        </button>
      )}

      {open && (
        <div className="pm-slide-in-right fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-[var(--shadow-modal)]">
          <header className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <span className="text-[18px] leading-none text-[var(--color-primary)]">✦</span>
              <div className="flex flex-col leading-tight">
                <span
                  className="font-serif text-[17px] font-medium text-[var(--color-ink)]"
                  style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
                >
                  配置助手
                </span>
                <span className="text-[11px] text-[var(--color-muted-strong)]">
                  DeepSeek · 接 mihomo 官方文档
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3 text-[13px]">
              {messages.length > 0 && (
                <button
                  onClick={() => {
                    setMessages([]);
                    setConvo([]);
                    setConversationId(newConversationId());
                  }}
                  disabled={busy}
                  className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-40"
                >
                  清空
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-[16px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-auto px-5 py-4">
            {messages.length === 0 ? (
              <div className="mt-8 flex flex-col items-center">
                <div className="text-center text-[13px] leading-relaxed text-[var(--color-muted)]">
                  问我任何 mihomo / clash 配置问题，
                  <br />
                  我会查官方文档、结合你当前配置作答。
                </div>
                <div className="mt-5 flex w-full flex-col gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => sendText(ex)}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-[13px] text-[var(--color-fg-soft)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--color-primary-soft)] px-3.5 py-2 text-[13px] leading-relaxed text-[var(--color-fg)]">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex flex-col gap-2">
                      {m.blocks.map((b, j) => {
                        if (b.type === 'tool') {
                          if (b.status === 'running') {
                            return (
                              <div
                                key={j}
                                className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]"
                              >
                                <span className="pm-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
                                {TOOL_LABELS[b.name] ?? b.name} …
                              </div>
                            );
                          }
                          const kind = b.kind ?? 'error';
                          // Interactive / actionable cards face the user directly;
                          // read-data results are AI-facing, shown as a collapsed trace.
                          if (
                            kind === 'confirm-write' ||
                            kind === 'confirm-cancelled' ||
                            kind === 'write-result' ||
                            kind === 'error'
                          ) {
                            return (
                              <ResultCard
                                key={j}
                                kind={kind}
                                data={b.data}
                                onResolved={(r) => resolveConfirm(b.id, r)}
                                onUndone={() => markBlockUndone(b.id)}
                              />
                            );
                          }
                          return (
                            <CollapsibleResult
                              key={j}
                              label={TOOL_LABELS[b.name] ?? b.name}
                              kind={kind}
                              data={b.data}
                            />
                          );
                        }
                        if (b.type === 'error') {
                          return (
                            <ErrorBanner
                              key={j}
                              message={b.message}
                              onRetry={!busy && i === messages.length - 1 ? retry : undefined}
                            />
                          );
                        }
                        return <Markdown key={j} content={b.content} />;
                      })}
                    </div>
                  ),
                )}
                {busy && (
                  <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                    <span className="pm-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
                    正在思考 …
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-[var(--color-border)] p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="问配置问题，Enter 发送…"
                className="max-h-32 flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-border-active)]"
              />
              {busy ? (
                <button
                  onClick={stop}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-[14px] font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-hover)]"
                  aria-label="中断执行"
                  title="点击中断"
                >
                  <span className="pm-spin inline-block h-3.5 w-3.5 rounded-full border-2 border-[var(--color-muted)] border-t-transparent" />
                  停止
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!input.trim()}
                  className="h-9 rounded-lg bg-[var(--color-primary)] px-4 text-[14px] font-medium text-[var(--color-on-primary)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
