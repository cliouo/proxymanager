'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { InlineUrl } from '@/components/ui/InlineUrl';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Placeholder, Reveal } from '@/components/ui/Reveal';
import { StatusDot } from '@/components/ui/StatusDot';
import { ApiError, api } from '@/lib/client/api';
import { type Collection, dedupLabel } from '@/lib/types/collection';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Subscription {
  id: string;
  name: string;
  kind: 'remote' | 'local';
  enabled: boolean;
  url?: string;
  ua_override?: string;
  ttl_ms: number;
  content?: string;
  tags: string[];
  last_synced_at?: number;
  last_traffic?: {
    upload: number;
    download: number;
    total: number;
    expire: number;
  };
  last_error?: string;
}

interface Meta {
  subProvidersBase: string;
}

type Tab = 'subs' | 'collections';

function fmtTime(s: number | undefined): string {
  if (!s) return '从未';
  const diff = Date.now() / 1000 - s;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  return new Date(s * 1000).toLocaleString('zh-CN');
}

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<Tab>('subs');
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();
  const tabsId = useId();
  const subsTabRef = useRef<HTMLButtonElement>(null);
  const collectionsTabRef = useRef<HTMLButtonElement>(null);

  const handleTablistKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next: Tab = tab === 'subs' ? 'collections' : 'subs';
        setTab(next);
        requestAnimationFrame(() => {
          (next === 'subs' ? subsTabRef : collectionsTabRef).current?.focus();
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setTab('subs');
        requestAnimationFrame(() => subsTabRef.current?.focus());
      } else if (e.key === 'End') {
        e.preventDefault();
        setTab('collections');
        requestAnimationFrame(() => collectionsTabRef.current?.focus());
      }
    },
    [tab],
  );

  const startBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const endBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Tab 切换时，避免另一 tab 里残留的"编辑/新增"状态泄漏回来
  useEffect(() => {
    setEditingId(null);
    setAdding(false);
  }, [tab]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, m, cl] = await Promise.all([
        api<{ data: Subscription[] }>('/api/v1/subscriptions'),
        api<{ data: Meta }>('/api/v1/meta'),
        api<{ data: Collection[] }>('/api/v1/collections'),
      ]);
      setSubs(list.data);
      setMeta(m.data);
      setCollections(cl.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onRefresh(id: string) {
    startBusy(id);
    try {
      await api(`/api/v1/subscriptions/${id}/refresh`, { method: 'POST' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      endBusy(id);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('确定删除该订阅源？')) return;
    startBusy(id);
    try {
      await api(`/api/v1/subscriptions/${id}`, { method: 'DELETE' });
      setSubs((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      endBusy(id);
    }
  }

  async function onToggle(sub: Subscription) {
    startBusy(sub.id);
    try {
      const res = await api<{ data: Subscription }>(`/api/v1/subscriptions/${sub.id}`, {
        method: 'PATCH',
        body: { enabled: !sub.enabled },
      });
      setSubs((prev) => prev.map((s) => (s.id === sub.id ? res.data : s)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      endBusy(sub.id);
    }
  }

  async function onSaveEdit(id: string, patch: Record<string, unknown>) {
    startBusy(id);
    try {
      const res = await api<{ data: Subscription }>(`/api/v1/subscriptions/${id}`, {
        method: 'PATCH',
        body: patch,
      });
      setSubs((prev) => prev.map((s) => (s.id === id ? res.data : s)));
      setEditingId(null);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setError(msg);
      throw err; // EditForm 内 catch 仍可显示 inline 错误
    } finally {
      endBusy(id);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1
            className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            订阅源
          </h1>
          <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">
            {subs.length} 单订阅 · {collections.length} 聚合 · 远程订阅自动缓存
          </p>
        </div>
        {tab === 'subs' ? (
          <Button onClick={() => setAdding((v) => !v)}>{adding ? '取消' : '+ 新增订阅'}</Button>
        ) : (
          <Button onClick={() => router.push('/collections?mode=create&from=subs')}>
            + 新建聚合
          </Button>
        )}
      </header>

      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="订阅源类型"
        onKeyDown={handleTablistKey}
        className="flex gap-0 border-b border-[var(--color-border)] -mx-1 px-1"
      >
        <TabButton
          ref={subsTabRef}
          active={tab === 'subs'}
          onClick={() => setTab('subs')}
          count={subs.length}
          controlsId={`${tabsId}-panel-subs`}
          tabId={`${tabsId}-tab-subs`}
        >
          单订阅
        </TabButton>
        <TabButton
          ref={collectionsTabRef}
          active={tab === 'collections'}
          onClick={() => setTab('collections')}
          count={collections.length}
          controlsId={`${tabsId}-panel-collections`}
          tabId={`${tabsId}-tab-collections`}
        >
          聚合
        </TabButton>
      </div>

      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[#F4D8D2]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {tab === 'subs' && adding && (
        <AddForm
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      )}

      {tab === 'subs' ? (
        <section
          id={`${tabsId}-panel-subs`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-subs`}
        >
          {!loaded ? (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <SubSkeleton />
              <SubSkeleton />
            </ul>
          ) : subs.length === 0 && !adding ? (
            <EmptyState onAdd={() => setAdding(true)} />
          ) : (
            <Reveal when={loaded}>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {subs.map((sub, idx) => (
                  <Dossier
                    key={sub.id}
                    sub={sub}
                    index={idx + 1}
                    providerUrl={meta ? `${meta.subProvidersBase}/${sub.name}` : ''}
                    pending={busyIds.has(sub.id)}
                    editing={editingId === sub.id}
                    anyEditing={editingId !== null}
                    onRefresh={() => onRefresh(sub.id)}
                    onDelete={() => onDelete(sub.id)}
                    onToggle={() => onToggle(sub)}
                    onEditStart={() => setEditingId(sub.id)}
                    onEditCancel={() => setEditingId(null)}
                    onEditSave={(patch) => onSaveEdit(sub.id, patch)}
                  />
                ))}
              </ul>
            </Reveal>
          )}
        </section>
      ) : (
        <section
          id={`${tabsId}-panel-collections`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-collections`}
        >
          {!loaded ? (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <SubSkeleton />
              <SubSkeleton />
            </ul>
          ) : collections.length === 0 ? (
            <CollectionEmpty />
          ) : (
            <Reveal when={loaded}>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {collections.map((c, idx) => (
                  <CollectionCard key={c.id} c={c} subs={subs} index={idx + 1} />
                ))}
              </ul>
            </Reveal>
          )}
        </section>
      )}
    </div>
  );
}

function TabButton({
  ref,
  active,
  onClick,
  count,
  controlsId,
  tabId,
  children,
}: {
  ref?: RefObject<HTMLButtonElement | null>;
  active: boolean;
  onClick: () => void;
  count: number;
  controlsId: string;
  tabId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={controlsId}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`pm-focus-ring relative px-4 py-2 text-[13px] font-medium leading-none transition-colors active:scale-[0.98] rounded-sm ${
        active
          ? 'text-[var(--color-ink)]'
          : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      <span className="inline-flex items-baseline gap-2">
        {children}
        <span className="text-[11px] tabular-nums font-mono text-[var(--color-muted)]">
          {count}
        </span>
      </span>
      <span
        aria-hidden
        className={`absolute left-2 right-2 bottom-[-1px] h-[2px] bg-[var(--color-primary)] rounded-full transition-opacity duration-200 ease-out ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </button>
  );
}

function CollectionEmpty() {
  const router = useRouter();
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-sunk)]/50 px-8 py-12 text-center">
      <p
        className="font-serif text-[20px] font-medium text-[var(--color-fg-soft)] leading-[1.25] tracking-[-0.01em]"
        style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
      >
        还没有聚合
      </p>
      <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">
        聚合把多个单订阅合并成一份 provider，可在 base.yaml 用名字引用。
      </p>
      <div className="mt-5">
        <Button onClick={() => router.push('/collections?mode=create&from=subs')}>
          + 新建第一个聚合
        </Button>
      </div>
    </div>
  );
}

function CollectionCard({
  c,
  subs,
  index,
}: {
  c: Collection;
  subs: Subscription[];
  index: number;
}) {
  const router = useRouter();
  const subById = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);
  const members = useMemo(() => {
    const ids = new Set(c.subscription_ids);
    if (c.subscription_tags.length > 0) {
      for (const s of subs) {
        if (s.tags?.some((t) => c.subscription_tags.includes(t))) ids.add(s.id);
      }
    }
    return [...ids]
      .map((id) => subById.get(id))
      .filter((s): s is Subscription => !!s);
  }, [c, subs, subById]);

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden grid grid-cols-[40px_1fr] lg:grid-cols-[88px_1fr] xl:grid-cols-[96px_1fr]">
      {/* 左侧档案条：与 Dossier 对称的三段（序号 + NO. / StatusDot / Edit IconButton 列） */}
      <div className="border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] flex flex-col items-center lg:items-stretch lg:py-2 py-0">
        <div className="flex flex-col items-center justify-center flex-1 lg:flex-none lg:py-1">
          <span
            className="font-serif text-[18px] lg:text-[24px] xl:text-[28px] leading-none font-medium tabular-nums tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
            aria-label={`聚合 ${index}`}
          >
            {String(index).padStart(2, '0')}
          </span>
          <span
            aria-hidden
            className="hidden lg:block mt-0.5 text-[9px] uppercase tracking-[0.1em] font-mono text-[var(--color-muted-strong)]"
          >
            NO.
          </span>
        </div>
        <div className="hidden lg:flex flex-col items-center gap-1 py-2 border-t border-[var(--color-border)]">
          <StatusDot tone="on" />
          <span className="text-[10px] uppercase tracking-[0.06em] font-mono text-[var(--color-muted)] leading-none">
            聚合
          </span>
        </div>
        <div className="hidden lg:flex flex-col items-center gap-0.5 py-2 mt-auto border-t border-[var(--color-border)]">
          <IconLinkButton
            href={`/collections?id=${encodeURIComponent(c.id)}&from=subs`}
            title={`编辑聚合 ${c.name}`}
            label="✎"
          />
        </div>
      </div>

      <div className="p-3 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="lg:hidden">
            <StatusDot tone="on" />
          </span>
          <h2
            className="font-serif text-[16px] lg:text-[18px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--color-ink)] truncate"
            style={{ fontVariationSettings: '"opsz" 48, "SOFT" 40' }}
            title={c.name}
          >
            {c.name}
          </h2>
          <Badge tone="neutral">聚合</Badge>
          {c.updated_at && (
            <span className="text-[10px] uppercase tracking-[0.06em] font-mono text-[var(--color-muted)] ml-auto whitespace-nowrap shrink-0 hidden md:inline">
              更新 · {fmtTime(c.updated_at)}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/collections?id=${encodeURIComponent(c.id)}&from=subs`)}
            className="lg:hidden ml-auto"
            aria-label={`编辑聚合 ${c.name}`}
            title="编辑（前往聚合管理页）"
          >
            <span aria-hidden>✎</span> 编辑
          </Button>
        </div>
        <div className="text-[11px] text-[var(--color-muted)] font-mono tabular-nums">
          {dedupLabel(c.dedup_by)} · {members.length} 成员
          {c.name_prefix && ` · 前缀「${c.name_prefix}」`}
        </div>
        {members.length > 0 && (
          <div
            className="text-[11px] text-[var(--color-fg-soft)] font-mono truncate"
            title={members.map((m) => m.name).join(', ')}
          >
            {members.slice(0, 6).map((m) => m.name).join(' · ')}
            {members.length > 6 && (
              <span className="text-[var(--color-muted)]"> +{members.length - 6}</span>
            )}
          </div>
        )}
        {c.subscription_tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {c.subscription_tags.map((t) => (
              <Badge key={t} tone="neutral">
                #{t}
              </Badge>
            ))}
          </div>
        )}
        {c.notes && (
          <p
            className="text-[11px] text-[var(--color-muted)] leading-[1.5] line-clamp-1"
            title={c.notes}
          >
            {c.notes}
          </p>
        )}
        <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted-strong)] font-mono">
          base.yaml 引用 ↳ <code className="text-[var(--color-fg-soft)]">{c.name}</code>
        </div>
      </div>
    </li>
  );
}

/** Strip 内的链接型 IconButton，外观与 IconButton 一致但走 router.push。 */
function IconLinkButton({
  href,
  title,
  label,
}: {
  href: string;
  title: string;
  label: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      title={title}
      aria-label={title}
      className="pm-focus-ring w-7 h-7 rounded inline-flex items-center justify-center text-[13px] leading-none transition-colors active:scale-[0.98] text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)]"
    >
      <span aria-hidden>{label}</span>
    </button>
  );
}

function SubSkeleton() {
  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] grid grid-cols-[40px_1fr] lg:grid-cols-[88px_1fr] xl:grid-cols-[96px_1fr] overflow-hidden">
      <div className="border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] flex items-center justify-center py-3">
        <div className="pm-pulse h-4 w-5 rounded bg-[var(--color-border-strong)]" />
      </div>
      <div className="p-3 space-y-2">
        <Placeholder rows={1} className="max-w-[200px]" />
        <Placeholder rows={2} />
      </div>
    </li>
  );
}

function CompactTraffic({
  traffic,
}: {
  traffic: { upload: number; download: number; total: number };
}) {
  const used = traffic.upload + traffic.download;
  const pct = traffic.total > 0 ? Math.min(100, (used / traffic.total) * 100) : 0;
  const ulPct =
    traffic.total > 0 ? Math.min(100, (traffic.upload / traffic.total) * 100) : 0;
  const dlPct = Math.max(0, pct - ulPct);
  return (
    <div className="flex items-center gap-3 text-[11px] tabular-nums">
      <span className="text-[var(--color-muted)] font-mono shrink-0 whitespace-nowrap">
        <span className="text-[var(--color-fg)]">↑</span> {fmtBytes(traffic.upload)} ·{' '}
        <span className="text-[var(--color-fg)]">↓</span> {fmtBytes(traffic.download)} /{' '}
        {fmtBytes(traffic.total)}
      </span>
      <div className="relative h-1.5 flex-1 rounded-full bg-[var(--color-bg-strong)] overflow-hidden min-w-[60px]">
        <div
          className="absolute left-0 top-0 bottom-0 bg-[var(--color-plum)]"
          style={{ width: `${ulPct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 bg-[var(--color-primary)]"
          style={{ left: `${ulPct}%`, width: `${dlPct}%` }}
        />
      </div>
      <span className="font-mono text-[var(--color-fg)] shrink-0 tabular-nums">
        {pct.toFixed(pct < 10 ? 1 : 0)}%
      </span>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!n) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${units[i]}`;
}

function Dossier({
  sub,
  index,
  providerUrl,
  pending,
  editing,
  anyEditing,
  onRefresh,
  onDelete,
  onToggle,
  onEditStart,
  onEditCancel,
  onEditSave,
}: {
  sub: Subscription;
  index: number;
  providerUrl: string;
  pending: boolean;
  editing: boolean;
  anyEditing: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const tone = editing ? 'off' : sub.last_error ? 'error' : sub.enabled ? 'on' : 'off';
  const statusLabel = editing
    ? '编辑中'
    : sub.last_error
      ? '异常'
      : sub.enabled
        ? '已启用'
        : '已停用';
  const dimmed = anyEditing && !editing;

  return (
    <li
      className={`rounded-lg border bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden grid grid-cols-[40px_1fr] lg:grid-cols-[88px_1fr] xl:grid-cols-[96px_1fr] transition-[border-color,opacity] duration-150 ease-out ${
        editing
          ? 'border-[var(--color-primary)]/40'
          : 'border-[var(--color-border)]'
      } ${dimmed ? 'opacity-50' : ''}`}
    >
      {/* Left strip ——
        · <lg: 紧凑序号（2 列网格密度优先）
        · lg+:  DESIGN.md §Page Patterns.4 三段（序号 + NO. 铭牌 / StatusDot + 状态 / IconButton 列） */}
      <div className="border-r border-[var(--color-border)] bg-[var(--color-bg-sunk)] flex flex-col items-center lg:items-stretch lg:py-2 py-0">
        {/* 段 1 ：大序号 + NO. 铭牌 */}
        <div className="flex flex-col items-center justify-center flex-1 lg:flex-none lg:py-1">
          <span
            className="font-serif text-[18px] lg:text-[24px] xl:text-[28px] leading-none font-medium tabular-nums tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
            aria-label={`订阅 ${index} · ${statusLabel}`}
          >
            {String(index).padStart(2, '0')}
          </span>
          <span
            aria-hidden
            className="hidden lg:block mt-0.5 text-[9px] uppercase tracking-[0.1em] font-mono text-[var(--color-muted-strong)]"
          >
            NO.
          </span>
        </div>

        {/* 段 2 ：状态点 + 文字（仅 lg+） */}
        <div className="hidden lg:flex flex-col items-center gap-1 py-2 border-t border-[var(--color-border)]">
          <StatusDot tone={tone} />
          <span className="text-[10px] uppercase tracking-[0.06em] font-mono text-[var(--color-muted)] leading-none">
            {statusLabel}
          </span>
        </div>

        {/* 段 3 ：IconButton 列（仅 lg+ 且非编辑态）—— 顶到底 */}
        {!editing && (
          <div className="hidden lg:flex flex-col items-center gap-0.5 py-2 mt-auto border-t border-[var(--color-border)]">
            <IconButton
              onClick={onEditStart}
              disabled={pending || anyEditing}
              title="编辑"
              label="✎"
            />
            {sub.kind === 'remote' && (
              <IconButton
                onClick={onRefresh}
                disabled={pending || anyEditing || !sub.enabled}
                title="立即拉取"
                label="⟲"
              />
            )}
            <IconButton
              onClick={onToggle}
              disabled={pending || anyEditing}
              title={sub.enabled ? '停用' : '启用'}
              label={sub.enabled ? '⏸' : '▶'}
            />
            <IconButton
              onClick={onDelete}
              disabled={pending || anyEditing}
              title="删除"
              label="✕"
              tone="danger"
            />
          </div>
        )}
      </div>

      {/* Right content */}
      <div className="p-3 min-w-0 flex flex-col gap-2">
        {editing ? (
          <EditForm sub={sub} onCancel={onEditCancel} onSave={onEditSave} />
        ) : (
          <>
            {/* Header row：状态点 · 名字 · 类型 · 元数据 · 操作组（<lg 才显示状态点 + 操作组，lg+ 已搬到左侧 strip） */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="lg:hidden">
                <StatusDot tone={tone} />
              </span>
              <h2
                className="font-serif text-[16px] lg:text-[18px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--color-ink)] truncate"
                style={{ fontVariationSettings: '"opsz" 48, "SOFT" 40' }}
                title={sub.name}
              >
                {sub.name}
              </h2>
              <Badge tone="neutral">{sub.kind === 'remote' ? '远程' : '本地'}</Badge>
              {sub.tags.length > 0 && (
                <span className="text-[11px] text-[var(--color-muted)] font-mono truncate hidden md:inline">
                  {sub.tags.slice(0, 3).join(' · ')}
                </span>
              )}
              <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-muted)] font-mono ml-auto whitespace-nowrap shrink-0 hidden md:inline">
                TTL · {Math.round(sub.ttl_ms / 1000)}s · 同步 · {fmtTime(sub.last_synced_at)}
              </span>
              <div className="flex items-center gap-0.5 shrink-0 lg:hidden">
                <IconButton
                  onClick={onEditStart}
                  disabled={pending || anyEditing}
                  title="编辑"
                  label="✎"
                />
                {sub.kind === 'remote' && (
                  <IconButton
                    onClick={onRefresh}
                    disabled={pending || anyEditing || !sub.enabled}
                    title="立即拉取"
                    label="⟲"
                  />
                )}
                <IconButton
                  onClick={onToggle}
                  disabled={pending || anyEditing}
                  title={sub.enabled ? '停用' : '启用'}
                  label={sub.enabled ? '⏸' : '▶'}
                />
                <IconButton
                  onClick={onDelete}
                  disabled={pending || anyEditing}
                  title="删除"
                  label="✕"
                  tone="danger"
                />
              </div>
            </div>

            {/* Provider URL —— token 默认遮蔽，复制按钮始终拷完整 URL */}
            <InlineUrl value={providerUrl} mask />

            {/* Compact traffic line —— 单行：数字 · 条 · 百分比 */}
            {sub.last_traffic && sub.last_traffic.total > 0 && (
              <CompactTraffic traffic={sub.last_traffic} />
            )}

            {sub.last_error && (
              <div className="rounded-md bg-[#F4D8D2]/30 border border-[var(--color-danger)]/30 px-2 py-1 text-[11px] text-[var(--color-danger)] break-words">
                <span className="text-[10px] uppercase tracking-[0.08em] font-semibold mr-1.5">
                  错误
                </span>
                {sub.last_error}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  title,
  tone = 'neutral',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  tone?: 'neutral' | 'danger';
}) {
  const colors =
    tone === 'danger'
      ? 'text-[var(--color-danger)] hover:bg-[var(--color-danger)]/8'
      : 'text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`pm-focus-ring w-7 h-7 rounded inline-flex items-center justify-center text-[13px] leading-none transition-colors active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed ${colors}`}
    >
      <span aria-hidden>{label}</span>
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-sunk)]/50 px-8 py-16 text-center">
      <p className="font-serif text-[20px] font-medium text-[var(--color-fg-soft)] leading-[1.25] tracking-[-0.01em]"
        style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
      >
        还没有订阅源
      </p>
      <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">
        添加远程订阅 URL 或本地 YAML 内容来开始。
      </p>
      <div className="mt-5">
        <Button onClick={onAdd}>+ 添加第一个订阅</Button>
      </div>
    </div>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const [kind, setKind] = useState<'remote' | 'local'>('remote');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [ua, setUa] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [ttlSec, setTtlSec] = useState(Math.round(DEFAULT_TTL_MS / 1000));
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        enabled,
        ttl_ms: Math.max(1000, ttlSec * 1000),
        tags,
      };
      if (kind === 'remote') {
        body.url = url.trim();
        if (ua.trim()) body.ua_override = ua.trim();
      } else {
        body.content = content;
      }
      await api('/api/v1/subscriptions', { method: 'POST', body });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-5"
    >
      <h2
        className="font-serif text-[20px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--color-ink)]"
        style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
      >
        新增订阅源
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <FormField label="类型">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'remote' | 'local')}>
            <option value="remote">远程 (URL)</option>
            <option value="local">本地 (内联 YAML)</option>
          </Select>
        </FormField>
        <FormField label="名称 (slug)">
          <Input
            placeholder="airport-a"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9-]+"
            required
          />
        </FormField>
        <FormField label="拉取 TTL (秒)">
          <Input
            type="number"
            min={1}
            value={ttlSec}
            onChange={(e) => setTtlSec(Math.max(1, Number(e.target.value) || 0))}
            disabled={kind === 'local'}
          />
        </FormField>
        <FormField label="标签">
          <Input
            placeholder="premium, asia"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </FormField>
      </div>

      {kind === 'remote' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="上游 URL">
            <Input
              type="url"
              placeholder="https://airport/sub?token=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </FormField>
          <FormField label="UA 覆写">
            <Input
              placeholder="可选，如 clash.meta/1.18.0"
              value={ua}
              onChange={(e) => setUa(e.target.value)}
            />
          </FormField>
        </div>
      ) : (
        <FormField
          label={
            <span className="flex items-baseline gap-2">
              <span>节点内容</span>
              <span className="normal-case tracking-normal font-normal text-[10px] text-[var(--color-muted)]">
                clash yaml · 或多行 ss:// vmess:// vless:// trojan:// hy2:// tuic:// anytls:// wireguard:// … · 或 base64
              </span>
            </span>
          }
        >
          <Textarea
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              'ss://YWVz…@host:8388#HK-01\nvmess://eyJ2…\nvless://uuid@host:443?type=ws&path=/#JP-02\ntrojan://pass@host:443?sni=foo#US-03\nanytls://pwd@host:8443?sni=h.com#AT-1\n\n# 也可以贴 Clash YAML：\n# proxies:\n#   - { name: my-node, type: ss, ... }'
            }
            required
            className="text-[12px] font-mono"
          />
        </FormField>
      )}

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-fg-soft)] cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-[var(--color-primary)] w-3.5 h-3.5"
          />
          立即启用
        </label>
        <Button type="submit" disabled={pending || !name}>
          {pending ? '提交中…' : '创建'}
        </Button>
      </div>

      {error && (
        <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2]/40 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </form>
  );
}

function EditForm({
  sub,
  onCancel,
  onSave,
}: {
  sub: Subscription;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(sub.name);
  const [url, setUrl] = useState(sub.url ?? '');
  const [content, setContent] = useState(sub.content ?? '');
  const [ua, setUa] = useState(sub.ua_override ?? '');
  const [tagsInput, setTagsInput] = useState(sub.tags.join(', '));
  const [ttlSec, setTtlSec] = useState(Math.max(1, Math.round(sub.ttl_ms / 1000)));
  const [enabled, setEnabled] = useState(sub.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const patch: Record<string, unknown> = {
        name: name.trim(),
        enabled,
        ttl_ms: Math.max(1000, ttlSec * 1000),
        tags,
      };
      if (sub.kind === 'remote') {
        patch.url = url.trim();
        patch.ua_override = ua.trim();
      } else {
        patch.content = content;
      }
      await onSave(patch);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2
            className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            编辑订阅源
          </h2>
          <Badge tone="neutral">{sub.kind === 'remote' ? '远程' : '本地'}</Badge>
          <span className="text-[10px] uppercase tracking-[0.08em] font-mono text-[var(--color-muted)]">
            类型不可改
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            disabled={pending}
          >
            取消
          </Button>
          <Button type="submit" size="sm" disabled={pending || !name.trim()}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FormField label="名称 (slug)">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9-]+"
            required
          />
        </FormField>
        <FormField label="拉取 TTL (秒)">
          <Input
            type="number"
            min={1}
            value={ttlSec}
            onChange={(e) => setTtlSec(Math.max(1, Number(e.target.value) || 0))}
            disabled={sub.kind === 'local'}
          />
        </FormField>
        <FormField label="标签">
          <Input
            placeholder="premium, asia"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </FormField>
      </div>

      {sub.kind === 'remote' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="上游 URL">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </FormField>
          <FormField label="UA 覆写">
            <Input
              placeholder="留空 = 不覆写"
              value={ua}
              onChange={(e) => setUa(e.target.value)}
            />
          </FormField>
        </div>
      ) : (
        <FormField
          label={
            <span className="flex items-baseline gap-2">
              <span>节点内容</span>
              <span className="normal-case tracking-normal font-normal text-[10px] text-[var(--color-muted)]">
                clash yaml · 或多行 ss:// vmess:// vless:// anytls:// wireguard:// … · 或 base64
              </span>
            </span>
          }
        >
          <Textarea
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            className="text-[12px] font-mono"
          />
        </FormField>
      )}

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-[var(--color-border)] flex-wrap">
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-fg-soft)] cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-[var(--color-primary)] w-3.5 h-3.5"
          />
          启用
        </label>
        {error && (
          <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2]/40 rounded-md px-3 py-1.5 max-w-full break-words">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
