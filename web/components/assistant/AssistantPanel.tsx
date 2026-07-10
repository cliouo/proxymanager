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
import { api } from '@/lib/client/api';
import { AssistantNotConfiguredError, runAgentTurn } from '@/lib/client/assistantAgent';
import { loadAssistantConfig } from '@/lib/client/assistant-config';
import { useAssistant } from './AssistantContext';
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
  // Open state now lives in context so the topbar `.ai-fab` can toggle the
  // drawer; the panel itself stays always-mounted (the stream survives close).
  const { open, setOpen } = useAssistant();
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
  // Index of the message whose pending confirm-write cards are being bulk-approved
  // ("全部同意"), or null. Only one bulk run at a time.
  const [bulkBusy, setBulkBusy] = useState<number | null>(null);
  // P3-21: whether the view is pinned near the bottom. Streamed tokens only
  // auto-scroll while pinned, so the user can scroll up to read earlier content
  // mid-stream; `showJump` toggles the floating 回到最新 button when unpinned.
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // P3-22: debounce the localStorage persist during streaming (a write per token
  // is wasteful). `stateRef` keeps the latest snapshot for the unmount flush.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef({ conversationId, messages, convo });
  stateRef.current = { conversationId, messages, convo };

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

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  // P3-21: recompute pinned state on scroll — "near bottom" = within ~80px.
  function onBodyScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distance <= 80;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  }

  // P3-22: persist the conversation, but debounce (~400ms) while streaming so a
  // single token doesn't hammer localStorage. When settled (not busy) we write
  // immediately, so the final state is always saved.
  useEffect(() => {
    if (!hydrated) return; // don't clobber stored state before restore runs
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (!busy) {
      persist(conversationId, messages, convo);
      return;
    }
    persistTimer.current = setTimeout(() => {
      const s = stateRef.current;
      persist(s.conversationId, s.messages, s.convo);
      persistTimer.current = null;
    }, 400);
  }, [hydrated, busy, conversationId, messages, convo]);

  // P3-22: flush any pending debounced write on unmount so nothing is lost.
  useEffect(
    () => () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        const s = stateRef.current;
        persist(s.conversationId, s.messages, s.convo);
      }
    },
    [],
  );

  // P3-21: follow the stream only while pinned near the bottom; otherwise leave
  // the user's scroll position alone. Reopening the drawer jumps to the latest.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom('auto');
  }, [messages]);

  useEffect(() => {
    if (open) {
      pinnedRef.current = true;
      setShowJump(false);
      scrollToBottom('auto');
    }
  }, [open]);

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

  /**
   * Approve every still-pending confirm-write card in one message ("全部同意").
   * Tokens are spent sequentially in card order — operator writes against one
   * source are order-dependent (a reorder/update assumes prior adds landed), so
   * we must not fire them concurrently. A card that fails is left pending so the
   * user can inspect / retry it individually; the rest still go through.
   */
  async function approveAll(blocks: AssistantBlock[], mIndex: number) {
    if (bulkBusy !== null) return;
    const pending = blocks.filter(
      (b): b is Extract<AssistantBlock, { type: 'tool' }> =>
        b.type === 'tool' && b.kind === 'confirm-write',
    );
    if (pending.length === 0) return;
    setBulkBusy(mIndex);
    // P3-23: count cards that didn't execute so 全部同意 isn't silent on failure.
    let failed = 0;
    try {
      for (const b of pending) {
        const token = (b.data as { token?: string } | undefined)?.token;
        if (!token) {
          failed++;
          continue;
        }
        try {
          const res = await api<{ data: { kind: string; data: unknown } }>(
            '/api/v1/assistant/confirm',
            { method: 'POST', body: { token }, headers: { 'X-Source': 'ai_chat' } },
          );
          resolveConfirm(b.id, { status: 'executed', result: res.data });
        } catch {
          // Leave this card pending — its own 批准并执行 surfaces the real error.
          failed++;
        }
      }
    } finally {
      setBulkBusy(null);
    }
    // P3-23: surface an aggregate failure notice (the per-card retry still works).
    if (failed > 0) {
      setMessages((prev) =>
        prev.map((m, i) =>
          i === mIndex && m.role === 'assistant'
            ? {
                role: 'assistant',
                blocks: [...m.blocks, { type: 'error', message: `${failed} 项确认失败，可逐条重试。` }],
              }
            : m,
        ),
      );
    }
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

  // Always-mounted: closing only removes `.open` (slides off-screen) so an
  // in-flight stream keeps running in the background. The trigger lives in the
  // topbar (`.ai-fab`), wired through AssistantContext.
  return (
    <aside className={`ai-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="ai-head">
        <div className="ident">✦</div>
        <div>
          <b>配置助手</b>
          <span className="model">DeepSeek · 接 mihomo 官方文档 · 浏览器直连</span>
        </div>
        <div style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setMessages([]);
              setConvo([]);
              setConversationId(newConversationId());
            }}
            disabled={busy}
          >
            清空
          </button>
        )}
        <button className="btn ghost sm" onClick={() => setOpen(false)} aria-label="关闭">
          关闭
        </button>
      </div>

      <div className="ai-body" ref={scrollRef} onScroll={onBodyScroll}>
        {messages.length === 0 ? (
          <>
            <div className="ai-msg bot">
              <p>你好，我是配置助手。问我任何 mihomo / clash 配置问题，我会查官方文档、结合你当前配置作答。</p>
              <p>写操作（增删改规则、规则集、配置区块）会先给出 diff 卡片，确认后才执行。</p>
            </div>
            <div className="ai-suggests">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip" onClick={() => sendText(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="ai-msg user">
                  {m.content}
                </div>
              ) : (
                <div key={i} className="ai-msg bot">
                  {m.blocks.map((b, j) => {
                    if (b.type === 'tool') {
                      if (b.status === 'running') {
                        return (
                          <div key={j} className="ai-tool">
                            <span>⚙ {TOOL_LABELS[b.name] ?? b.name}</span>
                            <span className="st run">running</span>
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
                  {(() => {
                    const pending = m.blocks.filter(
                      (b) => b.type === 'tool' && b.kind === 'confirm-write',
                    ).length;
                    const isLast = i === messages.length - 1;
                    // Only once ≥2 cards await AND the turn finished streaming for
                    // the active message (so all cards have arrived first).
                    if (pending < 2 || (isLast && busy)) return null;
                    const running = bulkBusy === i;
                    return (
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => void approveAll(m.blocks, i)}
                          disabled={running || bulkBusy !== null}
                          className="h-8 rounded-lg bg-[var(--color-primary)] px-3 text-[13px] font-medium text-[var(--color-on-primary)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
                        >
                          {running ? '全部执行中…' : `全部同意（${pending}）`}
                        </button>
                        <span className="text-[12px] text-[var(--color-muted)]">
                          一次批准本条消息内待确认的全部写操作
                        </span>
                      </div>
                    );
                  })()}
                </div>
              ),
            )}
            {busy && (
              <div className="ai-tool">
                <span>正在思考</span>
                <span className="st run">running</span>
              </div>
            )}
          </>
        )}
        {/* P3-21: floating jump-to-latest, shown only when scrolled away from bottom. */}
        {showJump && messages.length > 0 && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            aria-label="回到最新"
            style={{
              position: 'sticky',
              bottom: 8,
              alignSelf: 'center',
              zIndex: 5,
              padding: '4px 12px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: 'var(--surface-3)',
              color: 'var(--fg)',
              fontSize: 12,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
              cursor: 'pointer',
            }}
          >
            ↓ 回到最新
          </button>
        )}
      </div>

      <div className="ai-input">
        <div className="box">
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
            placeholder="描述你想修改或查询的内容…"
          />
          {busy ? (
            <button
              className="send"
              onClick={stop}
              aria-label="中断执行"
              title="点击中断"
              style={{ background: 'var(--surface-3)', color: 'var(--fg)' }}
            >
              ■
            </button>
          ) : (
            <button className="send" onClick={send} disabled={!input.trim()} aria-label="发送">
              ↑
            </button>
          )}
        </div>
        <div className="note">
          <span>{busy ? '执行中 · 点 ■ 可中断' : '写操作需二次确认'}</span>
          <span>·</span>
          <span>对话不会离开浏览器</span>
        </div>
      </div>
    </aside>
  );
}
