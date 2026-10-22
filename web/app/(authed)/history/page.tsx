'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { useToast } from '@/components/ui/Toast';
import { TimelineSkeleton } from '@/components/ui/Reveal';
import { ACTIVITY_ICON, IconTile } from '@/components/ui/IconTile';
import { actorLabel, describeAuditEvent, groupConsecutive } from '@/lib/ui/auditEventCopy';
import styles from './history.module.css';
import { HistoryCrumb, NamingRollbackHint } from './namingHints';

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
  | { kind: 'rule-set'; name: string }
  | { kind: 'base'; field?: string }
  | { kind: 'profile' }
  | { kind: 'device'; id: string; name: string }
  | { kind: 'naming-source'; type: 'subscription' | 'collection'; id: string; name: string };

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
  undoable?: boolean;
}

const PAGE_SIZE = 100;

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

  if (kind === 'device' && e.target?.kind === 'device') {
    const hint = valueHint(e.after ?? e.before);
    return (
      <>
        <span className="tag">设备 · {e.target.name}</span>
        {hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}
      </>
    );
  }

  if (kind === 'profile') {
    const hint = valueHint(e.after ?? e.before);
    return hint ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span> : null;
  }

  if (kind === 'naming-source' && e.target?.kind === 'naming-source') {
    const hint = valueHint(e.after ?? e.before);
    return (
      <>
        <span className="tag">命名 · {e.target.name}</span>
        {hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}
      </>
    );
  }

  if (
    (kind === 'proxy' || kind === 'proxy-group' || kind === 'rule-set') &&
    e.target &&
    'name' in e.target
  ) {
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toast = useToast();

  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(async (beforeTs?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (beforeTs !== undefined) qs.set('cursor', beforeTs);
      const res = await api<{ data: AuditEvent[]; meta: { nextCursor: string | null } }>(
        `/api/v1/history?${qs.toString()}`,
      );
      setEvents((prev) => (beforeTs === undefined ? res.data : [...prev, ...res.data]));
      setCursor(res.meta.nextCursor);
      setHasMore(res.meta.nextCursor !== null);
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
      // The undo button lives on a row that may be scrolled far below the
      // top-of-page banner; an undo can be refused (e.g. 409 when the
      // recreated group is still referenced). Toast the reason so it's seen
      // without opening the console — the banner keeps the full text.
      const msg = err instanceof ApiError ? err.message : String(err);
      setError(msg);
      toast(msg, { variant: 'error' });
    } finally {
      setUndoing((prev) => {
        const n = new Set(prev);
        n.delete(event.id);
        return n;
      });
    }
  }

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

  function renderItem(e: AuditEvent) {
    const undone = !!e.undone_by;
    const isUndo = !!e.undoes;
    const { title, tone } = describeAuditEvent(e);
    const icon = ACTIVITY_ICON[tone];
    return (
      <div className="tl-item" key={e.id}>
        <IconTile name={icon.name} tone={icon.tone} />
        <div className="body">
          <div className="op">
            <span className="title">{title}</span>
            <EventBody e={e} undone={undone} />
          </div>
          <div className="meta">
            <span>{actorLabel(e.actor)}</span>
            <span className="code">{e.op}</span>
            {undone && (
              <span>
                <span className="pill idle plain" style={{ height: 16 }}>
                  已被撤销
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="aside">
          <NamingRollbackHint e={e} undone={undone} isUndo={isUndo} />
          {!undone && !isUndo && e.undoable !== false && (
            <button
              className="btn sm undo-btn"
              onClick={() => onUndo(e)}
              disabled={undoing.has(e.id)}
            >
              {undoing.has(e.id) ? '…' : '撤销'}
            </button>
          )}
          <span className="t">{timeLabel(e.ts)}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageTopbar contentMaxWidth={860}>
        <h1>操作记录</h1>
        {/* P2-19: the audit log is account-wide (history/route.ts has no profile
            filter), so a per-profile pill was misleading — use the neutral one. */}
        <ScopePill neutral />
        <HistoryCrumb />
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
        <div aria-busy="true" aria-label="正在读取操作历史">
          <TimelineSkeleton rows={8} />
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
            <div className="tl-day">
              {g.label}
              <span className="n">{g.events.length} 条</span>
            </div>
            {groupConsecutive(g.events).map((item) => {
              if (item.kind === 'single') return renderItem(item.event);
              const first = item.events[0];
              const last = item.events[item.events.length - 1];
              const open = expanded.has(first.id);
              const { title, tone } = describeAuditEvent(first);
              const icon = ACTIVITY_ICON[tone];
              const toggle = () =>
                setExpanded((prev) => {
                  const n = new Set(prev);
                  if (open) n.delete(first.id);
                  else n.add(first.id);
                  return n;
                });
              return (
                <div className="tl-run" key={`run-${first.id}`}>
                  <div className="tl-item" onClick={toggle}>
                    <IconTile name={icon.name} tone={icon.tone} />
                    <div className="body">
                      <div className="op">
                        <span className="title">{title}</span>
                        <span className="pill plain idle" style={{ height: 18 }}>
                          连续 {item.events.length} 次
                        </span>
                      </div>
                      <div className="meta">
                        <span>{actorLabel(first.actor)}</span>
                        <span className="code">{first.op}</span>
                      </div>
                    </div>
                    <div className="aside">
                      <button
                        type="button"
                        className="toggle"
                        aria-expanded={open}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggle();
                        }}
                      >
                        {open ? '收起' : '展开'}
                      </button>
                      <span className="t">
                        {timeLabel(last.ts) === timeLabel(first.ts)
                          ? timeLabel(first.ts)
                          : `${timeLabel(last.ts)}–${timeLabel(first.ts)}`}
                      </span>
                    </div>
                  </div>
                  {open && <div className="tl-run-items">{item.events.map(renderItem)}</div>}
                </div>
              );
            })}
          </div>
        ))
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button className="btn" onClick={() => cursor && load(cursor)} disabled={loading}>
            {loading ? '加载中…' : '加载更早'}
          </button>
        </div>
      )}
    </>
  );
}
