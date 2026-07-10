'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import styles from './history.module.css';

interface RuleSnapshot {
  id: string;
  anchor: string;
  type: string;
  value: string;
  policy: string;
}

type AuditTarget =
  | { kind: 'rule'; id: string }
  | { kind: 'proxy'; name: string }
  | { kind: 'proxy-group'; name: string }
  | { kind: 'base'; field?: string };

interface AuditEvent {
  id: string;
  ts: number;
  op: string;
  actor: string;
  ruleId?: string;
  target?: AuditTarget;
  before?: unknown;
  after?: unknown;
  undone_by?: string;
  undoes?: string;
}

const PAGE_SIZE = 100;

type Glyph = 'create' | 'update' | 'delete' | 'undo' | 'ai';

const GLYPH_SYM: Record<Glyph, string> = {
  create: '●',
  update: '◐',
  delete: '●',
  undo: '○',
  ai: '✦',
};

/** The action is the op's last dotted segment; the scenario prefix is ignored. */
function actionOf(op: string): string {
  const i = op.lastIndexOf('.');
  return i === -1 ? op : op.slice(i + 1);
}

const VERBS: Record<string, { label: string; glyph: Glyph }> = {
  create: { label: '新增', glyph: 'create' },
  'batch-create': { label: '批量新增', glyph: 'create' },
  'create-pool-chain': { label: '建链', glyph: 'create' },
  update: { label: '修改', glyph: 'update' },
  patch: { label: '修改', glyph: 'update' },
  'set-section': { label: '设置', glyph: 'update' },
  'set-fixed-chain': { label: '设固定链', glyph: 'update' },
  'update-pool-members': { label: '改链成员', glyph: 'update' },
  mark: { label: '标记', glyph: 'update' },
  delete: { label: '删除', glyph: 'delete' },
  'delete-section': { label: '删除', glyph: 'delete' },
  'delete-pool-chain': { label: '删链', glyph: 'delete' },
  'clear-chain': { label: '清链', glyph: 'delete' },
};

/** AI-authored events get the purple ✦ glyph regardless of verb. */
function isAiActor(actor: string): boolean {
  return /ai|assistant|助手/i.test(actor);
}

function describeOp(op: string, actor: string): { label: string; glyph: Glyph } {
  const v = actionOf(op);
  const base = VERBS[v] ?? { label: v, glyph: 'update' as Glyph };
  return isAiActor(actor) ? { ...base, glyph: 'ai' } : base;
}

function valueHint(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 48 ? `${v.slice(0, 48)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `${v.length} 项`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.slice(0, 4).join('、') + (keys.length > 4 ? '…' : '');
  }
  return String(v);
}

/** Renders the event detail by target kind, in v2 chips/code idiom. */
function EventBody({ e, undone }: { e: AuditEvent; undone: boolean }) {
  const kind = e.target?.kind ?? (e.ruleId ? 'rule' : undefined);

  if (kind === 'rule') {
    const before = e.before as RuleSnapshot | undefined;
    const after = e.after as RuleSnapshot | undefined;
    const snap = after ?? before;
    if (!snap) return null;
    const policyChange =
      before && after && before.policy !== after.policy
        ? `${before.policy} → ${after.policy}`
        : null;
    return (
      <>
        <span className="tag">{snap.anchor}</span>
        <code className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {snap.type}
        </code>
        <code
          className="mono"
          style={{
            fontSize: 12,
            color: undone ? 'var(--faint)' : 'var(--fg)',
            textDecoration: undone ? 'line-through' : undefined,
          }}
        >
          {snap.value || '—'}
        </code>
        <span style={{ color: 'var(--faint)' }}>→</span>
        <span className={`pill plain ${undone ? 'idle' : 'acc'}`} style={{ height: 18 }}>
          {snap.policy}
        </span>
        {policyChange && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
            ({policyChange})
          </span>
        )}
      </>
    );
  }

  if (kind === 'base') {
    const field = e.target?.kind === 'base' ? e.target.field : undefined;
    const hint = valueHint(e.after ?? e.before);
    return (
      <>
        {field && (
          <code className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
            {field}
          </code>
        )}
        {hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}
      </>
    );
  }

  if ((kind === 'proxy' || kind === 'proxy-group') && e.target && 'name' in e.target) {
    return (
      <code className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
        {e.target.name}
      </code>
    );
  }

  return null;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const md = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  if (same(d, now)) return `今天 · ${md}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (same(d, yesterday)) return `昨天 · ${md}`;
  return md;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 搜索匹配文本:op / actor / 目标名 / 字段 / 规则快照的值与策略。 */
function eventHaystack(e: AuditEvent): string {
  const parts: string[] = [e.op, e.actor];
  const t = e.target;
  if (t) {
    if ('name' in t) parts.push(t.name);
    if (t.kind === 'base' && t.field) parts.push(t.field);
  }
  for (const v of [e.before, e.after]) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = v as Partial<RuleSnapshot>;
      if (typeof r.anchor === 'string') parts.push(r.anchor);
      if (typeof r.type === 'string') parts.push(r.type);
      if (typeof r.value === 'string') parts.push(r.value);
      if (typeof r.policy === 'string') parts.push(r.policy);
    }
  }
  return parts.join(' ').toLowerCase();
}

export default function HistoryPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [undoing, setUndoing] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  const load = useCallback(async (beforeTs?: number) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (beforeTs !== undefined) qs.set('before_ts', String(beforeTs));
      const res = await api<{ data: AuditEvent[] }>(`/api/v1/history?${qs.toString()}`);
      setEvents((prev) => (beforeTs === undefined ? res.data : [...prev, ...res.data]));
      setHasMore(res.data.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onUndo(event: AuditEvent) {
    setUndoing((prev) => new Set(prev).add(event.id));
    setError(null);
    try {
      const res = await api<{ data: { event: AuditEvent; inverse: AuditEvent } }>(
        `/api/v1/history/${event.id}/undo`,
        { method: 'POST' },
      );
      setEvents((prev) => {
        const next = prev.map((e) => (e.id === event.id ? res.data.event : e));
        return [res.data.inverse, ...next];
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUndoing((prev) => {
        const n = new Set(prev);
        n.delete(event.id);
        return n;
      });
    }
  }

  const oldestTs = useMemo(
    () => (events.length > 0 ? events[events.length - 1].ts : undefined),
    [events],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? events.filter((e) => eventHaystack(e).includes(q)) : events),
    [events, q],
  );

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; events: AuditEvent[] }>();
    for (const e of filtered) {
      const k = dayKey(e.ts);
      if (!map.has(k)) map.set(k, { label: dayLabel(e.ts), events: [] });
      map.get(k)!.events.push(e);
    }
    return [...map.entries()].map(([key, val]) => ({ key, ...val }));
  }, [filtered]);

  return (
    <>
      <PageTopbar contentMaxWidth={860}>
        <h1>操作历史</h1>
        {/* P2-19: the audit log is account-wide (history/route.ts has no profile
            filter), so a per-profile pill was misleading — use the neutral one. */}
        <ScopePill neutral />
        <span className="crumb">每次写操作都有快照 · 可撤销</span>
        <div className="grow" />
        <div className={`search ${styles.search}`}>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索操作 / 对象…"
          />
        </div>
        <button className="btn sm" onClick={() => load()} disabled={loading}>
          {loading && events.length === 0 ? '加载中…' : '刷新'}
        </button>
      </PageTopbar>

      {error && (
        <div
          className="panel"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)',
            background: 'var(--danger-dim)',
            color: 'var(--danger)',
            padding: '11px 14px',
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {!loaded ? (
        <div
          className="pm-pulse"
          style={{ color: 'var(--faint)', fontSize: 13, padding: '8px 12px' }}
        >
          正在读取操作历史 …
        </div>
      ) : events.length === 0 ? (
        <div
          className="panel"
          style={{ textAlign: 'center', padding: '56px 24px', borderStyle: 'dashed' }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-2)' }}>空白账本</div>
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--muted)' }}>
            对配置做任何写操作后会在这里看到。
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 0' }}>无匹配。</p>
      ) : (
        groups.map((g) => (
          <div key={g.key}>
            <div className="tl-day">{g.label}</div>
            {g.events.map((e) => {
              const undone = !!e.undone_by;
              const isUndo = !!e.undoes;
              const { label, glyph } = describeOp(e.op, e.actor);
              const finalGlyph: Glyph = isUndo ? 'undo' : glyph;
              return (
                <div className="tl-item" key={e.id}>
                  <span className="t num">{timeLabel(e.ts)}</span>
                  <span className={`glyph ${finalGlyph}`}>{GLYPH_SYM[finalGlyph]}</span>
                  <div className="body">
                    <div
                      className="op"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                    >
                      <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>{label}</span>
                      <EventBody e={e} undone={undone} />
                    </div>
                    <div className="meta">
                      <span>{e.op}</span>
                      <span>{e.actor}</span>
                      {undone && (
                        <span className="pill idle plain" style={{ height: 16 }}>
                          已被撤销
                        </span>
                      )}
                    </div>
                  </div>
                  {!undone && !isUndo && (
                    <button
                      className="btn sm undo-btn"
                      onClick={() => onUndo(e)}
                      disabled={undoing.has(e.id)}
                    >
                      {undoing.has(e.id) ? '…' : '撤销'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button
            className="btn"
            onClick={() => oldestTs !== undefined && load(oldestTs)}
            disabled={loading}
          >
            {loading ? '加载中…' : '加载更早'}
          </button>
        </div>
      )}
    </>
  );
}
