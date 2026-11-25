'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import { Boxes, Link2, MoreHorizontal, Pencil, Plus, RadioTower, RefreshCw, RotateCcw, Trash2, Workflow } from 'lucide-react';
import { DataView } from '@/ui/agent';
import { errorMessage } from '@/ui/data/api';
import { usePools, useSources } from '@/ui/data/hooks';
import { cn } from '@/ui/lib/cn';
import { relativeTime } from '@/ui/lib/format';
import {
  Badge,
  Button,
  copyText,
  EmptyState,
  Menu,
  Monogram,
  notify,
  SearchInput,
  Skeleton,
  Switch,
  Tabs,
  TabPanel,
} from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { HealthPill, sourceHealth, TrafficMeter, trafficOf } from '@/ui/viz/health';
import { deletePool, deleteSource, refreshSource, setPoolEnabled, setSourceEnabled } from './actions';
import { AddSourceDialog, NewPoolDialog } from './create-dialogs';
import {
  activeMembers,
  canServerRefresh,
  knownNodeCount,
  poolLink,
  resolvePoolMembers,
  sortSources,
  sourceLink,
  sourceMode,
  sourceTitle,
  type Pool,
  type Source,
} from './model';
import { TAB_SCROLL, useSubBase } from './shared';
import { intentProps } from '@/ui/shell/prefetch';

function nodeLine(source: Source): string {
  if (!source.enabled) return '不提供节点';
  const mode = sourceMode(source);
  if (mode === 'local') return '本地节点';
  const count = knownNodeCount(source);
  if (mode === 'manual') return count !== null ? `${count} 个节点 · 手动导入` : '等待导入';
  const health = source.fetch_health;
  if (!health) return '尚未拉取';
  if (count === null) return '暂无可用节点';
  return `${count} 个节点 · ${relativeTime('fresh_at' in health ? health.fresh_at : health.attempted_at)}更新`;
}

async function copyLink(url: string | null, label: string) {
  if (!url) return;
  if (await copyText(url)) notify.success(`已复制「${label}」的分发链接`);
  else notify.error(new Error('复制失败，请手动复制'));
}

export function SourceCard({ source, subBase }: { source: Source; subBase: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<{ base: boolean; next: boolean } | null>(null);
  const enabled = optimistic && optimistic.base === source.enabled ? optimistic.next : source.enabled;
  const health = sourceHealth(source);
  const traffic = source.traffic ?? trafficOf(source.fetch_health) ?? source.manual_snapshot?.traffic;
  const title = sourceTitle(source);
  const refreshable = canServerRefresh(source);
  return (
    <article
      className={cn(
        'group relative flex flex-col gap-3.5 rounded-xl border border-line bg-surface p-4 shadow-xs transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md',
        !enabled && 'bg-surface-2/40',
      )}
    >
      <UiButton
        render={<Link href={`/sources/${source.id}`} {...intentProps(`/sources/${source.id}`)} />}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`打开「${title}」`}
      />
      <div className="flex items-start gap-3">
        <Monogram name={title} colorKey={source.id} size={34} className={cn(!enabled && 'opacity-50 grayscale')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold tracking-tight text-ink">{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-ink-3">{source.name}</span>
            <Badge tone="outline">{source.kind === 'local' ? '本地' : '远程'}</Badge>
          </div>
        </div>
        <div className="relative z-10 flex items-center gap-0.5">
          <Switch
            size="sm"
            checked={enabled}
            disabled={busy}
            label={enabled ? `停用「${title}」` : `启用「${title}」`}
            data-agent-confirm={enabled ? `停用订阅源「${title}」` : `启用订阅源「${title}」`}
            onCheckedChange={async (on) => {
              setOptimistic({ base: source.enabled, next: on });
              setBusy(true);
              const ok = await setSourceEnabled(source, on);
              setBusy(false);
              if (!ok) setOptimistic(null);
            }}
          />
          <Menu
            items={[
              ...(refreshable
                ? [
                    {
                      label: '刷新',
                      icon: RefreshCw,
                      confirm: `刷新订阅源「${title}」`,
                      onSelect: async () => {
                        setBusy(true);
                        await refreshSource(source);
                        setBusy(false);
                      },
                    },
                  ]
                : []),
              {
                label: '复制分发链接',
                icon: Link2,
                disabled: !subBase,
                onSelect: () => void copyLink(subBase ? sourceLink(subBase, source) : null, title),
              },
              { label: '编辑', icon: Pencil, onSelect: () => router.push(`/sources/${source.id}?tab=settings`) },
              'separator',
              { label: '删除', icon: Trash2, tone: 'danger', onSelect: () => void deleteSource(source) },
            ]}
            trigger={<Button size="sm" variant="ghost" iconOnly icon={MoreHorizontal} aria-label={`「${title}」的更多操作`} loading={busy} />}
          />
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <HealthPill view={health} />
        <span className="tnum min-w-0 truncate text-xs text-ink-3">{nodeLine(source)}</span>
      </div>
      {traffic && source.enabled && <TrafficMeter traffic={traffic} compact />}
      {source.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {source.tags.map((tag) => (
            <span key={tag} className="rounded-md bg-surface-2 px-1.5 py-px text-[11px] text-ink-3">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function PoolCard({ pool, sources, subBase }: { pool: Pool; sources: Source[]; subBase: string | null }) {
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<{ base: boolean; next: boolean } | null>(null);
  const enabled = optimistic && optimistic.base === pool.enabled ? optimistic.next : pool.enabled;
  const members = resolvePoolMembers(pool, sources);
  const active = activeMembers(members);
  const steps = pool.operators.filter((op) => !op.disabled).length;
  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col gap-3.5 rounded-xl border border-line bg-surface p-4 shadow-xs transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md',
        !enabled && 'bg-surface-2/40',
      )}
    >
      <UiButton
        render={<Link href={`/pools/${pool.id}`} {...intentProps(`/pools/${pool.id}`)} />}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`打开「${pool.name}」`}
      />
      <div className="flex items-start gap-3">
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[28%] border border-line bg-surface-2 text-ink-2">
          <Boxes size={17} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold tracking-tight text-ink">{pool.name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{pool.slug ?? pool.id.slice(0, 8)}</div>
        </div>
        <div className="relative z-10 flex items-center gap-0.5">
          <Switch
            size="sm"
            checked={enabled}
            disabled={busy}
            label={enabled ? `停用「${pool.name}」` : `启用「${pool.name}」`}
            data-agent-confirm={enabled ? `停用聚合订阅「${pool.name}」` : `启用聚合订阅「${pool.name}」`}
            onCheckedChange={async (on) => {
              setOptimistic({ base: pool.enabled, next: on });
              setBusy(true);
              const ok = await setPoolEnabled(pool, on);
              setBusy(false);
              if (!ok) setOptimistic(null);
            }}
          />
          <Menu
            items={[
              {
                label: '复制分发链接',
                icon: Link2,
                disabled: !subBase,
                onSelect: () => void copyLink(subBase ? poolLink(subBase, pool) : null, pool.name),
              },
              'separator',
              { label: '删除', icon: Trash2, tone: 'danger', onSelect: () => void deletePool(pool) },
            ]}
            trigger={<Button size="sm" variant="ghost" iconOnly icon={MoreHorizontal} aria-label={`「${pool.name}」的更多操作`} />}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {members.slice(0, 5).map((m) => (
            <Monogram
              key={m.id}
              name={m.source ? sourceTitle(m.source) : '?'}
              colorKey={m.id}
              size={22}
              className={cn('ring-2 ring-surface', !m.source?.enabled && 'opacity-40 grayscale')}
            />
          ))}
        </div>
        <span className="tnum text-xs text-ink-3">
          {active.length} 个订阅源
          {members.length > active.length && ` · ${members.length - active.length} 个停用`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1">
          <Workflow size={12} />
          {steps ? `${steps} 个处理步骤` : '无处理步骤'}
        </span>
        {pool.subscription_tags.map((tag) => (
          <span key={tag} className="rounded-md bg-accent-soft px-1.5 py-px text-[11px] text-accent" title="带这个标签的订阅源会自动加入">
            #{tag}
          </span>
        ))}
      </div>
      {pool.notes && <p className="line-clamp-2 text-xs leading-relaxed text-ink-3">{pool.notes}</p>}
    </article>
  );
}

function CardSkeletons() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 @4xl/main:grid-cols-3">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-[34px] rounded-[28%]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-1.5 w-full" />
        </div>
      ))}
    </div>
  );
}

export function SourcesIndex() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlTab: 'sources' | 'pools' = params.get('tab') === 'pools' ? 'pools' : 'sources';
  const [optimisticTab, setOptimisticTab] = useState<{ from: 'sources' | 'pools'; to: 'sources' | 'pools' } | null>(
    null,
  );
  const tab = optimisticTab && optimisticTab.from === urlTab ? optimisticTab.to : urlTab;
  const creating = params.get('new') === '1';
  const sources = useSources();
  const pools = usePools();
  const subBase = useSubBase();
  const [query, setQuery] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);

  const go = (next: { tab?: string; create?: boolean }) => {
    const targetTab: 'sources' | 'pools' = (next.tab ?? tab) === 'pools' ? 'pools' : 'sources';
    if (next.tab !== undefined) {
      setOptimisticTab(targetTab === urlTab ? null : { from: urlTab, to: targetTab });
    }
    const q = new URLSearchParams();
    if (targetTab === 'pools') q.set('tab', 'pools');
    if (next.create) q.set('new', '1');
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const list = useMemo(() => sortSources(sources.data ?? []), [sources.data]);
  const needle = query.trim().toLowerCase();
  const shownSources = list.filter(
    (s) => !needle || [s.name, s.display_name ?? '', ...s.tags].some((v) => v.toLowerCase().includes(needle)),
  );
  const shownPools = (pools.data ?? []).filter(
    (p) => !needle || [p.name, p.slug ?? '', ...p.subscription_tags].some((v) => v.toLowerCase().includes(needle)),
  );
  const refreshable = list.filter(canServerRefresh);

  const refreshAll = async () => {
    setRefreshingAll(true);
    const results = await Promise.all(refreshable.map((s) => refreshSource(s, true)));
    setRefreshingAll(false);
    const failed = refreshable.filter((_, i) => !results[i]);
    if (failed.length === 0) notify.success(`已刷新 ${results.length} 个订阅源`);
    else notify.warn(`${results.length - failed.length} 个刷新成功，${failed.length} 个失败`, failed.map(sourceTitle).join('、'));
  };

  const loadError = tab === 'sources' ? sources.error : pools.error;

  return (
    <Page>
      <PageHeader
        title="节点来源"
        description="订阅源和聚合订阅由所有配置文件共享：在这里修改，每个用到它的配置文件都会跟着变。"
        actions={
          tab === 'sources' ? (
            <>
              {refreshable.length > 0 && (
                <Button
                  icon={RefreshCw}
                  loading={refreshingAll}
                  data-agent-confirm={`刷新全部 ${refreshable.length} 个订阅源`}
                  onClick={() => void refreshAll()}
                >
                  全部刷新
                </Button>
              )}
              <Button variant="primary" icon={Plus} onClick={() => go({ create: true })}>
                添加订阅源
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={Plus} onClick={() => go({ create: true })}>
              新建聚合订阅
            </Button>
          )
        }
      />
      <Tabs
        label="节点来源分类"
        value={tab}
        onValueChange={(value) => go({ tab: value })}
        className={TAB_SCROLL}
        tabs={[
          { value: 'sources', label: '订阅源', count: sources.data?.length },
          { value: 'pools', label: '聚合订阅', count: pools.data?.length },
        ]}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <p className="text-xs text-ink-3">
            {tab === 'sources'
              ? '订阅源是节点的原始来源：机场订阅或你自己维护的节点。'
              : '聚合订阅把多个订阅源合成一份节点列表，可以整体加工、整体绑定。'}
          </p>
          <SearchInput
            value={query}
            onChange={setQuery}
            aria-label={tab === 'sources' ? '搜索订阅源' : '搜索聚合订阅'}
            placeholder={tab === 'sources' ? '搜索名称、标识或标签' : '搜索聚合订阅'}
            className="w-full sm:w-64"
            inputSize="sm"
          />
        </div>
        {loadError ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-bad/20 bg-bad-soft px-4 py-3 text-sm text-ink-2">
            {errorMessage(loadError)}
            <Button size="sm" icon={RotateCcw} onClick={() => void (tab === 'sources' ? sources.refetch() : pools.refetch())}>
              重试
            </Button>
          </div>
        ) : null}
        <TabPanel value="sources" className="outline-none">
          {sources.isLoading ? (
            <CardSkeletons />
          ) : list.length === 0 ? (
            <EmptyState
              icon={RadioTower}
              title="还没有订阅源"
              description="添加机场给你的订阅链接，或者粘贴自己维护的节点。"
              actions={
                <Button variant="primary" icon={Plus} onClick={() => go({ create: true })}>
                  添加订阅源
                </Button>
              }
            />
          ) : shownSources.length === 0 ? (
            <EmptyState compact title="没有匹配的订阅源" description="换个关键词试试。" />
          ) : (
            <DataView
              label="订阅源列表"
              summary={`共 ${shownSources.length} 个订阅源`}
              items={shownSources.map((source) => ({
                value: source.id,
                label: `${sourceTitle(source)} (${source.name}) · ${source.kind === 'local' ? '本地' : '远程'} · ${source.enabled ? '启用' : '停用'} · ${nodeLine(source)}`,
              }))}
              className="grid animate-rise gap-4 sm:grid-cols-2 @4xl/main:grid-cols-3"
            >
              {shownSources.map((source) => (
                <SourceCard key={source.id} source={source} subBase={subBase} />
              ))}
            </DataView>
          )}
        </TabPanel>
        <TabPanel value="pools" className="outline-none">
          {pools.isLoading ? (
            <CardSkeletons />
          ) : (pools.data ?? []).length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="还没有聚合订阅"
              description="想让一个配置文件同时用上多个机场的节点？先建一个聚合订阅。"
              actions={
                <Button variant="primary" icon={Plus} onClick={() => go({ create: true })}>
                  新建聚合订阅
                </Button>
              }
            />
          ) : shownPools.length === 0 ? (
            <EmptyState compact title="没有匹配的聚合订阅" description="换个关键词试试。" />
          ) : (
            <DataView
              label="聚合订阅列表"
              summary={`共 ${shownPools.length} 个聚合订阅`}
              items={shownPools.map((pool) => {
                const activeCount = activeMembers(resolvePoolMembers(pool, list)).length;
                return {
                  value: pool.id,
                  label: `${pool.name} (${pool.slug ?? pool.id.slice(0, 8)}) · ${pool.enabled ? '启用' : '停用'} · ${activeCount} 个订阅源`,
                };
              })}
              className="grid animate-rise gap-4 sm:grid-cols-2 @4xl/main:grid-cols-3"
            >
              {shownPools.map((pool) => (
                <PoolCard key={pool.id} pool={pool} sources={list} subBase={subBase} />
              ))}
            </DataView>
          )}
        </TabPanel>
      </Tabs>

      <AddSourceDialog
        open={creating && tab === 'sources'}
        onOpenChange={(open) => go({ create: open })}
        sources={sources.data ?? []}
      />
      <NewPoolDialog
        open={creating && tab === 'pools'}
        onOpenChange={(open) => go({ create: open })}
        sources={list}
        pools={pools.data ?? []}
      />
    </Page>
  );
}
