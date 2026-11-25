'use client';

import { createElement, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ChevronDown,
  CornerUpLeft,
  Globe,
  History,
  RefreshCw,
  TriangleAlert,
  Undo2,
  Wand2,
} from 'lucide-react';
import { api, ApiError, errorMessage, request } from '@/ui/data/api';
import { refreshProfile, refreshShared, useProfiles, usePools, useSources } from '@/ui/data/hooks';
import { useIsomorphicLayoutEffect, useQuery } from '@/ui/data/query';
import type { AuditEvent, HistoryPage as HistoryPageData, Profile } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { relativeTime } from '@/ui/lib/format';
import { opIcon } from '@/ui/lib/ops';
import { Badge, Button, Card, EmptyState, Monogram, Skeleton, Tooltip, confirmAction, notify } from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { profilePath } from '@/ui/shell/scope';
import { PolicyChip } from '@/ui/viz/lines';
import { fetchLedgerHead, LEDGER_KEY, LEDGER_PAGE } from './ledger';
import {
  actorLabel,
  canUndo,
  clockTime,
  dayKey,
  dayLabel,
  eventTitle,
  exactTime,
  snapshot,
  snapshotDiff,
  str,
  type Snapshot,
} from './model';

const PAGE = LEDGER_PAGE;

/* ─── clock (re-renders relative times every 30s) ────────────────────── */

const subscribeClock = (tick: () => void) => {
  const timer = window.setInterval(tick, 30_000);
  return () => window.clearInterval(timer);
};
const readClock = () => Math.floor(Date.now() / 30_000) * 30_000;
const useNow = () => useSyncExternalStore(subscribeClock, readClock, () => 0);

/* ─── data: first page in the query cache, older pages appended by cursor ── */

function useLedger() {
  const loaded = useRef(PAGE);
  // Invalidation refetches from the top with everything already shown, so no event falls between pages.
  const head = useQuery<HistoryPageData>(LEDGER_KEY, () => fetchLedgerHead(Math.min(500, loaded.current)));
  const [tail, setTail] = useState<{ base: HistoryPageData; events: AuditEvent[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const live = tail && tail.base === head.data ? tail : null;

  const events = useMemo(() => {
    const seen = new Set<string>();
    return [...(head.data?.data ?? []), ...(live?.events ?? [])].filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  }, [head.data, live]);
  const cursor = live ? live.cursor : (head.data?.meta.nextCursor ?? null);

  useIsomorphicLayoutEffect(() => {
    loaded.current = Math.max(PAGE, events.length);
  });

  const loadMore = async () => {
    const base = head.data;
    if (!cursor || !base) return;
    setLoadingMore(true);
    try {
      const page = await request<HistoryPageData>('/history', { query: { limit: PAGE, cursor } });
      setTail((previous) => ({
        base,
        events: [...(previous && previous.base === base ? previous.events : []), ...page.data],
        cursor: page.meta.nextCursor,
      }));
    } catch (error) {
      notify.error(error, '加载更早的记录失败');
    } finally {
      setLoadingMore(false);
    }
  };

  return { head, events, cursor, loadMore, loadingMore };
}

/* ─── page ───────────────────────────────────────────────────────────── */

export function HistoryPage() {
  const now = useNow();
  const { head, events, cursor, loadMore, loadingMore } = useLedger();
  const { data: profiles } = useProfiles();
  const [busyId, setBusyId] = useState<string | null>(null);

  const days = useMemo(() => {
    const groups: Array<{ key: string; ts: number; events: AuditEvent[] }> = [];
    for (const event of events) {
      const key = dayKey(event.ts);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.events.push(event);
      else groups.push({ key, ts: event.ts, events: [event] });
    }
    return groups;
  }, [events]);
  const loadedIds = useMemo(() => new Set(events.map((e) => e.id)), [events]);

  const undo = async (event: AuditEvent) => {
    const title = eventTitle(event.op);
    const ok = await confirmAction({
      title: '撤销这条操作？',
      description: `会把「${title}」造成的改动还原。还原前同样会预演最终配置，撤销本身也会记一条历史。`,
      confirmText: '撤销',
    });
    if (!ok) return;
    setBusyId(event.id);
    try {
      await api.post(`/history/${event.id}/undo`);
      notify.success('已撤销', title);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) notify.info('这条操作已经被撤销过了');
      else if (error instanceof ApiError && error.status === 422 && !error.issues.length)
        notify.warn('这条操作无法撤销', '它没有安全的还原路径，请手动改回去。');
      else notify.error(error, '撤销失败');
    } finally {
      setBusyId(null);
      const fallback = profiles?.find((p) => p.name === 'default')?.id;
      const pid = profiles?.some((p) => p.id === event.profileId) ? event.profileId : fallback;
      if (pid) refreshProfile(pid);
      refreshShared();
    }
  };

  const jumpTo = (id: string) => {
    const node = document.getElementById(`ev-${id}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.animate(
      [{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'var(--accent-soft)', offset: 0.4 }, { backgroundColor: 'transparent' }],
      { duration: 1600, easing: 'ease-out' },
    );
  };

  return (
    <Page width="narrow">
      <PageHeader
        title="操作历史"
        eyebrow={
          <>
            <Badge icon={Globe}>全账户</Badge>
            <span>包含所有配置文件的改动</span>
          </>
        }
        description="规则、规则集、设备和链式代理等改动会记在这里。能安全还原的条目带「撤销」；排序、初始化和智能命名只做记录。"
        actions={
          <Tooltip content="刷新">
            <Button iconOnly icon={RefreshCw} aria-label="刷新" loading={head.isValidating && !!head.data} onClick={() => void head.refetch()} />
          </Tooltip>
        }
      />

      {head.error && !head.data ? (
        <Card className="flex flex-col items-start gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <TriangleAlert size={16} className="shrink-0 text-bad" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">操作历史加载失败</div>
            <p className="mt-0.5 text-xs text-ink-3">{errorMessage(head.error)}</p>
          </div>
          <Button size="sm" icon={RefreshCw} loading={head.isValidating} onClick={() => void head.refetch()}>
            重试
          </Button>
        </Card>
      ) : !head.data ? (
        <LedgerSkeleton />
      ) : events.length === 0 ? (
        <Card>
          <EmptyState
            icon={History}
            title="还没有操作记录"
            description="修改规则、规则集、设备或链式代理之后，记录会出现在这里。"
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          {days.map((day) => (
            <section key={day.key} className="flex animate-rise flex-col gap-2.5">
              <h2 className="flex items-baseline justify-between px-1">
                <span className="text-[15px] font-semibold tracking-tight text-ink">{dayLabel(day.ts, now)}</span>
                <span className="tnum text-xs text-ink-3">{day.events.length} 条</span>
              </h2>
              <Card as="div" className="overflow-hidden">
                <ol className="divide-y divide-line">
                  {day.events.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      now={now}
                      profiles={profiles}
                      busy={busyId === event.id}
                      onUndo={() => void undo(event)}
                      onJump={loadedIds.has(event.undoes ?? '') ? () => jumpTo(event.undoes!) : undefined}
                    />
                  ))}
                </ol>
              </Card>
            </section>
          ))}
          <div className="flex justify-center">
            {cursor ? (
              <Button loading={loadingMore} icon={ChevronDown} onClick={() => void loadMore()}>
                加载更早的记录
              </Button>
            ) : (
              <span className="text-xs text-ink-4">没有更早的记录了 · 最多保留最近 1000 条</span>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

/* ─── one ledger row ─────────────────────────────────────────────────── */

function EventRow({
  event,
  now,
  profiles,
  busy,
  onUndo,
  onJump,
}: {
  event: AuditEvent;
  now: number;
  profiles: Profile[] | undefined;
  busy: boolean;
  onUndo: () => void;
  onJump?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const icon = event.undoes ? CornerUpLeft : event.target?.kind === 'naming-source' ? Wand2 : opIcon(event.op);
  const undone = !!event.undone_by;
  const hasDiff = event.before !== undefined || event.after !== undefined;
  const naming = event.target?.kind === 'naming-source';

  return (
    <li id={`ev-${event.id}`} className="flex gap-3 px-4 py-3.5 sm:gap-4">
      <Tooltip content={exactTime(event.ts)}>
        <time dateTime={new Date(event.ts).toISOString()} className="tnum w-10 shrink-0 pt-1 font-mono text-[11.5px] text-ink-3">
          {clockTime(event.ts)}
        </time>
      </Tooltip>
      <span
        className={cn(
          'mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-full border',
          event.undoes ? 'border-accent-line bg-accent-soft text-accent' : 'border-line bg-surface-2 text-ink-2',
        )}
      >
        {createElement(icon, { size: 13, strokeWidth: 1.9 })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('text-[13.5px] font-medium text-ink', undone && 'text-ink-3 line-through decoration-ink-4')}>
            {eventTitle(event.op)}
          </span>
          {undone && <Badge icon={Undo2}>已撤销</Badge>}
          <ProfileTag event={event} profiles={profiles} />
        </div>
        <div className="mt-1 min-w-0 text-xs text-ink-2">
          <Subject event={event} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
          <span>{actorLabel(event.actor)}</span>
          <span className="text-ink-4">·</span>
          <Tooltip content={exactTime(event.ts)}>
            <span>{relativeTime(event.ts, now || undefined)}</span>
          </Tooltip>
          {event.undoes && (
            <>
              <span className="text-ink-4">·</span>
              {onJump ? (
                <button type="button" onClick={onJump} className="font-medium text-accent hover:underline">
                  撤销了另一条操作
                </button>
              ) : (
                <span>撤销了另一条操作</span>
              )}
            </>
          )}
          {hasDiff && (
            <>
              <span className="text-ink-4">·</span>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-0.5 font-medium text-ink-2 hover:text-ink"
              >
                {open ? '收起改动' : '查看改动'}
                <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
              </button>
            </>
          )}
        </div>
        {naming && <NamingHint event={event} />}
        {open && hasDiff && <DiffView before={event.before} after={event.after} />}
      </div>
      {canUndo(event) && (
        <div className="shrink-0">
          <Button size="sm" variant="ghost" icon={Undo2} loading={busy} onClick={onUndo}>
            撤销
          </Button>
        </div>
      )}
    </li>
  );
}

function ProfileTag({ event, profiles }: { event: AuditEvent; profiles: Profile[] | undefined }) {
  if (event.scope === 'global') return <Badge icon={Globe}>全局</Badge>;
  if (!event.profileId || !profiles) return null;
  const profile = profiles.find((p) => p.id === event.profileId);
  if (!profile) {
    // Naming events carry an opaque profile handle, not an id — nothing to show.
    return event.target?.kind === 'naming-source' ? null : <Badge tone="outline">已删除的配置文件</Badge>;
  }
  return (
    <Link href={profilePath(profile.name)} className="rounded-md outline-none focus-visible:shadow-[var(--ring)]">
      <Badge className="gap-1.5 pl-1 hover:border-line-strong">
        <Monogram name={profileTitle(profile)} colorKey={profile.id} size={13} />
        {profileTitle(profile)}
      </Badge>
    </Link>
  );
}

/* ─── subject line ───────────────────────────────────────────────────── */

function Subject({ event }: { event: AuditEvent }) {
  const before = snapshot(event.before);
  const after = snapshot(event.after);
  const target = event.target;
  const kind = target?.kind ?? (event.ruleId ? 'rule' : undefined);

  if (kind === 'rule' && (after ?? before)) return <RuleSubject before={before} after={after} />;
  if (target?.kind === 'proxy-group') {
    const members = Array.isArray(after?.members) ? after.members.length : undefined;
    return (
      <Line label="策略组">
        <PolicyChip policy={target.name} size="sm" />
        {members !== undefined && <span className="text-ink-3">{members} 个成员</span>}
      </Line>
    );
  }
  if (target?.kind === 'rule-set') {
    const source = str((after ?? before)?.source);
    return (
      <Line label="规则集">
        <span className="font-mono text-ink">{target.name}</span>
        {source && <span className="text-ink-3">{source === 'remote' ? '远程' : '本地托管'}</span>}
      </Line>
    );
  }
  if (target?.kind === 'device') {
    const display = str((after ?? before)?.display_name);
    return (
      <Line label="设备">
        <span className="text-ink">{display ?? target.name}</span>
        {display && <span className="font-mono text-ink-3">{target.name}</span>}
      </Line>
    );
  }
  if (target?.kind === 'base') {
    return (
      <Line label="基础配置">
        <span className="font-mono text-ink">{target.field || '整份 YAML'}</span>
      </Line>
    );
  }
  if (target?.kind === 'proxy') {
    return (
      <Line label="节点">
        <span className="text-ink">{target.name}</span>
      </Line>
    );
  }
  if (target?.kind === 'naming-source') {
    const mode = str(after?.mode);
    return (
      <Line label={target.type === 'subscription' ? '订阅源' : '聚合订阅'}>
        <span className="text-ink">{target.name}</span>
        {mode && <span className="text-ink-3">{{ added: '新增命名规则', replaced: '替换命名规则', removed: '移除命名规则', disabled: '关闭智能命名' }[mode] ?? mode}</span>}
      </Line>
    );
  }
  if (event.op === 'setup.bootstrap') {
    return <span className="text-ink-2">创建了默认配置文件：2 个策略组、1 条兜底规则</span>;
  }
  if (event.op === 'rules.move' || event.op === 'proxy-groups.reorder') {
    const count = Array.isArray(event.after) ? event.after.length : undefined;
    return (
      <span className="text-ink-2">
        {event.op === 'rules.move' ? '同一插入位置下的规则' : '策略组'}重新排序{count ? ` · ${count} 项` : ''}
      </span>
    );
  }
  if (target?.kind === 'profile') return <span className="text-ink-2">整份配置文件</span>;
  return null;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-ink-3">{label}</span>
      {children}
    </span>
  );
}

function RuleSubject({ before, after }: { before: Snapshot | null; after: Snapshot | null }) {
  const rule = (after ?? before)!;
  const type = str(rule.type);
  const value = str(rule.value);
  const policy = str(rule.policy);
  const previous = before && after && str(before.policy) !== policy ? str(before.policy) : undefined;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {type && <Badge mono>{type}</Badge>}
      {value && <span className="max-w-full truncate font-mono text-[12px] text-ink">{value}</span>}
      {policy && <ArrowRight size={12} className="shrink-0 text-ink-4" />}
      {previous && (
        <>
          <PolicyChip policy={previous} size="sm" muted className="line-through" />
          <ArrowRight size={12} className="shrink-0 text-ink-4" />
        </>
      )}
      {policy && <PolicyChip policy={policy} size="sm" />}
      {rule.enabled === false && <Badge>已停用</Badge>}
    </span>
  );
}

/* ─── naming guidance ────────────────────────────────────────────────── */

function NamingHint({ event }: { event: AuditEvent }) {
  const sources = useSources();
  const pools = usePools();
  const target = event.target?.kind === 'naming-source' ? event.target : null;
  if (!target) return null;
  // The history API hides raw ids for naming events, so find the source by its name.
  const id =
    target.type === 'subscription'
      ? sources.data?.find((s) => (s.display_name?.trim() || s.name) === target.name || s.name === target.name)?.id
      : pools.data?.find((p) => p.name === target.name)?.id;
  const href = id ? `${target.type === 'subscription' ? '/sources' : '/pools'}/${id}/naming` : '/sources';
  return (
    <p className="mt-2 flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
      <Wand2 size={12} className="shrink-0 text-ink-3" />
      命名变更不能在这里撤销，请在智能命名工作台回滚。
      <Link href={href} className="ml-auto shrink-0 font-medium text-accent hover:underline">
        去回滚
      </Link>
    </p>
  );
}

/* ─── before / after diff ────────────────────────────────────────────── */

function DiffView({ before, after }: { before: unknown; after: unknown }) {
  const lines = useMemo(() => snapshotDiff(before, after), [before, after]);
  return (
    <div className="mt-2.5 animate-rise overflow-hidden rounded-lg border border-line bg-sunken">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-ink-3">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-bad/60" />
          改动前
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-ok/60" />
          改动后
        </span>
      </div>
      <pre className="max-h-[360px] overflow-auto py-1.5 font-mono text-[11.5px] leading-[1.6]">
        {lines.map((line, index) =>
          line.kind === 'gap' ? (
            <div key={index} className="px-3 py-0.5 text-[11px] italic text-ink-4">
              ⋯ {line.text}
            </div>
          ) : (
            <div
              key={index}
              className={cn(
                'whitespace-pre-wrap break-all px-3',
                line.kind === 'add' && 'bg-ok-soft text-ok',
                line.kind === 'del' && 'bg-bad-soft text-bad',
                line.kind === 'same' && 'text-ink-3',
              )}
            >
              <span aria-hidden className="mr-2 inline-block w-2 select-none opacity-70">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
              {line.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

function LedgerSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      <Skeleton className="mx-1 h-4 w-16" />
      <Card as="div" className="divide-y divide-line">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-4 px-4 py-3.5">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="size-[26px] rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5" style={{ width: `${36 + ((i * 17) % 30)}%` }} />
              <Skeleton className="h-3" style={{ width: `${54 + ((i * 11) % 30)}%` }} />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
