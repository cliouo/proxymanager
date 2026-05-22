'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Placeholder, Reveal } from '@/components/ui/Reveal';
import { TimelineEvent, TimelineGroup } from '@/components/ui/Timeline';
import { ApiError, api } from '@/lib/client/api';

interface RuleSnapshot {
  id: string;
  anchor: string;
  type: string;
  value: string;
  policy: string;
}

interface AuditEvent {
  id: string;
  ts: number;
  op: 'rule.create' | 'rule.update' | 'rule.delete';
  actor: string;
  ruleId: string;
  before?: RuleSnapshot;
  after?: RuleSnapshot;
  undone_by?: string;
  undoes?: string;
}

const PAGE_SIZE = 100;

function opGlyph(op: AuditEvent['op'], isUndo: boolean): 'create' | 'update' | 'delete' | 'undo' {
  if (isUndo) return 'undo';
  if (op === 'rule.create') return 'create';
  if (op === 'rule.update') return 'update';
  return 'delete';
}

function opLabel(op: AuditEvent['op']): string {
  if (op === 'rule.create') return '新增';
  if (op === 'rule.update') return '修改';
  return '删除';
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (same(d, yesterday)) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function HistoryPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [undoing, setUndoing] = useState<Set<string>>(new Set());

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

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; events: AuditEvent[] }>();
    for (const e of events) {
      const k = dayKey(e.ts);
      if (!map.has(k)) map.set(k, { label: dayLabel(e.ts), events: [] });
      map.get(k)!.events.push(e);
    }
    return [...map.entries()].map(([key, val]) => ({ key, ...val }));
  }, [events]);

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1
            className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            操作历史
          </h1>
          <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">
            每次规则改动都会落库。点撤销可回滚，撤销本身也会被记录。
          </p>
        </div>
        <Button variant="secondary" onClick={() => load()} disabled={loading}>
          {loading && events.length === 0 ? '加载中…' : '刷新'}
        </Button>
      </header>

      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[#F4D8D2]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {!loaded ? (
        <div className="space-y-6 pl-4">
          <Placeholder rows={2} className="max-w-[160px]" />
          <Placeholder rows={4} />
          <Placeholder rows={3} />
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-sunk)]/40 px-8 py-16 text-center">
          <p
            className="font-serif text-[20px] font-medium text-[var(--color-fg-soft)] leading-[1.25] tracking-[-0.01em]"
            style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
          >
            空白账本
          </p>
          <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">
            对规则做任何改动后会在这里看到。
          </p>
        </div>
      ) : (
        <Reveal when={loaded} className="space-y-8">
          {groups.map((g) => (
            <TimelineGroup key={g.key} label={g.label}>
              {g.events.map((e) => {
                const undone = !!e.undone_by;
                const isUndo = !!e.undoes;
                const target = e.after ?? e.before;
                const policyChange =
                  e.op === 'rule.update' && e.before && e.after && e.before.policy !== e.after.policy
                    ? `${e.before.policy} → ${e.after.policy}`
                    : null;
                return (
                  <TimelineEvent
                    key={e.id}
                    glyph={opGlyph(e.op, isUndo)}
                    time={timeLabel(e.ts)}
                    actor={e.actor}
                    faded={undone}
                    action={
                      !undone && !isUndo ? (
                        <button
                          type="button"
                          onClick={() => onUndo(e)}
                          disabled={undoing.has(e.id)}
                          className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors px-1.5 py-0.5 rounded active:scale-[0.96] disabled:opacity-30"
                        >
                          {undoing.has(e.id) ? '…' : '撤销'}
                        </button>
                      ) : undefined
                    }
                  >
                    <span className="inline-flex items-center gap-1.5 flex-wrap">
                      <span className="text-[var(--color-muted)] font-medium">
                        {opLabel(e.op)}
                      </span>
                      {target && (
                        <>
                          <Badge tone="neutral">{target.anchor}</Badge>
                          <code className="font-mono text-[12px] text-[var(--color-muted)]">
                            {target.type}
                          </code>
                          <code
                            className={`font-mono text-[12px] ${
                              undone
                                ? 'line-through text-[var(--color-muted)]'
                                : 'text-[var(--color-fg)]'
                            }`}
                          >
                            {target.value || '—'}
                          </code>
                          <span className="text-[var(--color-muted)]">→</span>
                          <Badge tone={undone ? 'neutral' : 'accent'}>{target.policy}</Badge>
                          {policyChange && (
                            <span className="text-[11px] text-[var(--color-muted)] font-mono ml-1">
                              ({policyChange})
                            </span>
                          )}
                        </>
                      )}
                      {undone && (
                        <span className="ml-1 text-[11px] text-[var(--color-plum)] italic">
                          已撤销
                        </span>
                      )}
                    </span>
                  </TimelineEvent>
                );
              })}
            </TimelineGroup>
          ))}
        </Reveal>
      )}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            onClick={() => oldestTs !== undefined && load(oldestTs)}
            disabled={loading}
          >
            {loading ? '加载中…' : '加载更早 ↓'}
          </Button>
        </div>
      )}
    </div>
  );
}
