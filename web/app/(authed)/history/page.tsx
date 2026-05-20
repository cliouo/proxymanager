'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
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

export default function HistoryPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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
      // Replace original (now undone) + prepend the inverse event.
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">History</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Every rule mutation gets logged here. Click Undo to reverse a write — the
            inverse is itself recorded.
          </p>
        </div>
        <Button variant="secondary" onClick={() => load()} disabled={loading}>
          {loading && events.length === 0 ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Events{' '}
            <span className="text-[var(--color-muted)] font-normal">({events.length})</span>
          </CardTitle>
        </CardHeader>
        <CardBody className="p-0 overflow-x-auto">
          {events.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-muted)]">
              No events yet. Create or modify a rule and it will appear here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="text-left px-3 py-2 whitespace-nowrap">When</th>
                  <th className="text-left px-3 py-2 whitespace-nowrap">Op</th>
                  <th className="text-left px-3 py-2 whitespace-nowrap">Actor</th>
                  <th className="text-left px-3 py-2">Target</th>
                  <th className="text-left px-3 py-2">Outcome</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <EventRow
                    key={e.id}
                    event={e}
                    pending={undoing.has(e.id)}
                    onUndo={() => onUndo(e)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
        {hasMore && (
          <div className="px-4 py-3 border-t border-[var(--color-border)] flex justify-center">
            <Button
              variant="secondary"
              onClick={() => oldestTs !== undefined && load(oldestTs)}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Load older'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function EventRow({
  event,
  pending,
  onUndo,
}: {
  event: AuditEvent;
  pending: boolean;
  onUndo: () => void;
}) {
  const undone = !!event.undone_by;
  const isUndo = !!event.undoes;
  const target = event.after ?? event.before;
  const policyChange =
    event.op === 'rule.update' && event.before && event.after
      ? event.before.policy !== event.after.policy
        ? `${event.before.policy} → ${event.after.policy}`
        : null
      : null;

  return (
    <tr className="border-b border-[var(--color-border)]/60 align-top">
      <td className="px-3 py-2 whitespace-nowrap text-xs text-[var(--color-muted)] tabular-nums">
        {formatTs(event.ts)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <Badge tone={opTone(event.op)}>{event.op.replace('rule.', '')}</Badge>
        {isUndo && (
          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            undo
          </span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-xs text-[var(--color-muted)]">
        {event.actor}
      </td>
      <td className="px-3 py-2 min-w-0">
        {target ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone="neutral">{target.anchor}</Badge>
            <code className="font-mono text-xs text-[var(--color-muted)]">{target.type}</code>
            <code className={`font-mono ${undone ? 'line-through text-[var(--color-muted)]' : ''}`}>
              {target.value}
            </code>
            <span className="text-[var(--color-muted)]">→</span>
            <Badge tone={undone ? 'neutral' : 'accent'}>{target.policy}</Badge>
          </div>
        ) : (
          <span className="text-xs text-[var(--color-muted)]">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {policyChange && (
          <span className="text-[var(--color-muted)]">{policyChange}</span>
        )}
        {undone && (
          <span className="text-[var(--color-muted)] italic">undone</span>
        )}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {undone || isUndo ? (
          <span className="text-[10px] text-[var(--color-muted)]">—</span>
        ) : (
          <Button size="sm" variant="secondary" onClick={onUndo} disabled={pending}>
            {pending ? '…' : 'Undo'}
          </Button>
        )}
      </td>
    </tr>
  );
}

function opTone(op: AuditEvent['op']): 'accent' | 'warn' | 'danger' {
  switch (op) {
    case 'rule.create':
      return 'accent';
    case 'rule.update':
      return 'warn';
    case 'rule.delete':
      return 'danger';
  }
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour12: false });
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
