'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  AlertTriangle,
  ArrowUpRight,
  CircleCheck,
  FileCode2,
  Layers,
  ListTree,
  MonitorSmartphone,
  MoreHorizontal,
  Plus,
  QrCode,
  RadioTower,
  ScrollText,
  Sparkles,
  Unplug,
} from 'lucide-react';
import { DataView } from '@/ui/agent';
import {
  useAllRules,
  useDashboard,
  useDevices,
  useGroups,
  usePools,
  usePreview,
  useSources,
} from '@/ui/data/hooks';
import type { Collection, Profile, SubscriptionAdminView } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { formatCount, relativeTime } from '@/ui/lib/format';
import { opIcon, opLabel } from '@/ui/lib/ops';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CopyIcon,
  EmptyState,

  Menu,
  Monogram,
  Numeral,
  Skeleton,
  StatusDot,
  Tooltip,
  useCopy,
} from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { profileTitle, useSourceLabel } from '@/ui/shell/profile-switcher';
import { useScope } from '@/ui/shell/scope';
import { openAssistant, openShare } from '@/ui/shell/state';
import { HealthPill, sourceHealth, TrafficMeter, trafficOf } from '@/ui/viz/health';
import { GROUP_TYPES, useLineColors } from '@/ui/viz/lines';
import { countRegions, Flag } from '@/ui/viz/nodes';
import { FlowMap } from '@/ui/viz/sankey';
import { buildFlow } from './flow-data';

/* ─── helpers ────────────────────────────────────────────────────────── */

function profileSources(
  profile: Profile,
  sources: SubscriptionAdminView[] | undefined,
  pools: Collection[] | undefined,
): { mode: 'none' | 'subscription' | 'collection'; pool?: Collection; list: SubscriptionAdminView[] } {
  const source = profile.source;
  if (!source || source.type === 'none' || !sources) return { mode: 'none', list: [] };
  if (source.type === 'subscription') {
    return { mode: 'subscription', list: sources.filter((s) => s.id === source.id) };
  }
  const pool = pools?.find((p) => p.id === source.id);
  if (!pool) return { mode: 'collection', list: [] };
  const byId = new Map(sources.map((s) => [s.id, s]));
  const list: SubscriptionAdminView[] = [];
  const seen = new Set<string>();
  for (const id of pool.subscription_ids) {
    const sub = byId.get(id);
    if (sub && !seen.has(sub.id)) {
      list.push(sub);
      seen.add(sub.id);
    }
  }
  for (const sub of sources) {
    if (!seen.has(sub.id) && sub.tags.some((t) => pool.subscription_tags.includes(t))) {
      list.push(sub);
      seen.add(sub.id);
    }
  }
  return { mode: 'collection', pool, list };
}

/* ─── KPI strip ──────────────────────────────────────────────────────── */

function Kpi({
  label,
  value,
  sub,
  href,
  icon: Icon,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  href?: string;
  icon: typeof Layers;
  loading?: boolean;
}) {
  const body = (
    <div className="group relative flex h-full flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
        <Icon size={13} strokeWidth={1.9} />
        {label}
        {href && (
          <ArrowUpRight size={12} className="ml-auto text-ink-4 opacity-0 transition group-hover:opacity-100" />
        )}
      </div>
      {loading ? <Skeleton className="h-9 w-16" /> : <Numeral value={value} className="text-[40px]" />}
      <div className="min-h-[18px] truncate text-xs text-ink-3">{loading ? <Skeleton className="h-3 w-24" /> : sub}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-colors hover:bg-surface-2/60">
      {body}
    </Link>
  ) : (
    body
  );
}

/* ─── page ───────────────────────────────────────────────────────────── */

export function Overview() {
  const router = useRouter();
  const { profile, profileId, path } = useScope();
  const dashboard = useDashboard(profileId);
  const preview = usePreview(profile);
  const groups = useGroups(profileId);
  const rules = useAllRules(profileId);
  const devices = useDevices(profileId);
  const sources = useSources();
  const pools = usePools();
  const { color } = useLineColors();
  const sourceLabel = useSourceLabel(profile);
  const { copied, copy } = useCopy();

  const sortedGroups = useMemo(() => (groups.data ?? []).slice().sort((a, b) => a.rank - b.rank), [groups.data]);
  const flow = useMemo(
    () => (rules.data && groups.data ? buildFlow(rules.data, sortedGroups, color) : null),
    [rules.data, groups.data, sortedGroups, color],
  );
  const supply = useMemo(() => profileSources(profile, sources.data, pools.data), [profile, sources.data, pools.data]);
  const nodeNames = useMemo(() => preview.data?.node_names ?? [], [preview.data]);
  const regions = useMemo(() => countRegions(nodeNames), [nodeNames]);

  const counts = dashboard.data?.counts;
  const breakdown = dashboard.data?.groupTypeBreakdown ?? {};
  const activeRules = rules.data?.filter((r) => r.enabled !== false).length;
  const disabledRules = rules.data ? rules.data.length - (activeRules ?? 0) : 0;
  const subscriptionUrl = dashboard.data?.meta.subscriptionUrl;
  const isTemplate = profile.kind === 'template';

  const failing = supply.list.filter((s) => {
    const tone = sourceHealth(s).tone;
    return tone === 'bad' || tone === 'warn';
  });
  const warnings = useMemo(() => preview.data?.warnings ?? [], [preview.data]);
  const collisions = useMemo(() => preview.data?.collisions ?? [], [preview.data]);
  const unmatched = useMemo(() => preview.data?.unmatched_anchors ?? [], [preview.data]);
  const renderError = preview.error;

  const breakdownText = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${GROUP_TYPES[type as keyof typeof GROUP_TYPES]?.short ?? type}`)
    .join(' · ');

  const overviewSummaryItems = useMemo(() => {
    const items: Array<{ value: string; label: string }> = [
      {
        value: 'nodes',
        label: `节点：${preview.data ? preview.data.inlined_proxy_count : '加载中'}（${sourceLabel}）`,
      },
      {
        value: 'groups',
        label: `策略组：${counts?.proxyGroups ?? 0}${breakdownText ? `（${breakdownText}）` : ''}`,
      },
      {
        value: 'rules',
        label: `规则：启用 ${activeRules ?? 0}${disabledRules > 0 ? ` / 共 ${rules.data?.length}` : ''}（${counts?.anchors ?? 0} 个锚点）`,
      },
      {
        value: 'devices',
        label: `设备：${dashboard.data?.deviceCounts.total ?? 0}${dashboard.data?.deviceCounts.tailscale ? `（${dashboard.data.deviceCounts.tailscale} 台启用 Tailscale）` : ''}`,
      },
    ];
    if (supply.mode === 'none') items.push({ value: 'alert:no-source', label: '提示：尚未绑定节点来源' });
    if (renderError) items.push({ value: 'alert:render', label: `错误：最终配置渲染失败（${String((renderError as Error).message ?? renderError)}）` });
    for (const s of failing) {
      items.push({ value: `alert:source:${s.id}`, label: `订阅源异常：${s.display_name || s.name}（${sourceHealth(s).detail}）` });
    }
    if (collisions.length > 0) {
      items.push({ value: 'alert:collisions', label: `重名合并：${collisions.length} 个节点（${collisions.slice(0, 3).map((c) => c.name).join('、')}）` });
    }
    if (unmatched.length > 0) {
      items.push({ value: 'alert:unmatched', label: `缺少锚点：${unmatched.join('、')}` });
    }
    for (const [i, w] of warnings.entries()) {
      items.push({ value: `alert:warn:${i}`, label: `渲染提示：${w}` });
    }
    for (const r of regions.slice(0, 8)) {
      items.push({ value: `region:${r.region ?? 'other'}`, label: `地区分布：${r.zh} ${r.count} 个` });
    }
    return items;
  }, [
    preview.data,
    sourceLabel,
    counts,
    breakdownText,
    activeRules,
    disabledRules,
    rules.data,
    dashboard.data,
    supply.mode,
    renderError,
    failing,
    collisions,
    unmatched,
    warnings,
    regions,
  ]);

  return (
    <Page width="wide">
      <PageHeader
        documentTitle={`总览 · ${profileTitle(profile)}`}
        eyebrow={
          <>
            <span>配置文件</span>
            <span className="font-mono text-[11px] text-ink-2">{profile.name}</span>
            {isTemplate && <Badge>模版</Badge>}
          </>
        }
        title={
          <span className="flex items-center gap-3">
            <Monogram name={profileTitle(profile)} colorKey={profile.id} size={34} />
            {profileTitle(profile)}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <RadioTower size={13} className="text-ink-3" />
              {sourceLabel}
            </span>
            {profile.notes && (
              <>
                <span className="text-ink-4">·</span>
                <span className="text-ink-3">{profile.notes}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            {!isTemplate && (
              <div className="flex items-center rounded-md shadow-xs">
                <Button
                  variant="primary"
                  className="rounded-r-none"
                  disabled={!subscriptionUrl}
                  onClick={() => subscriptionUrl && void copy(subscriptionUrl, '订阅链接已复制，可直接粘贴到客户端')}
                  icon={<CopyIcon copied={copied} size={14} />}
                >
                  复制订阅链接
                </Button>
                <Tooltip content="二维码与设备链接">
                  <Button variant="primary" iconOnly className="rounded-l-none border-l border-inverse-ink/15" icon={QrCode} onClick={openShare} aria-label="二维码与设备链接" />
                </Tooltip>
              </div>
            )}
            <Menu
              trigger={<Button iconOnly icon={MoreHorizontal} aria-label="更多" />}
              items={[
                { label: '查看最终配置', icon: ScrollText, onSelect: () => router.push(path('output')) },
                { label: '编辑基础配置', icon: FileCode2, onSelect: () => router.push(path('base')) },
                'separator',
                {
                  label: '让 AI 体检这份配置',
                  icon: Sparkles,
                  onSelect: () => openAssistant('帮我检查一下这份配置有没有问题，并给出改进建议'),
                },
              ]}
            />
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {/* attention strip */}
        {(supply.mode === 'none' || failing.length > 0 || warnings.length > 0 || collisions.length > 0 || unmatched.length > 0 || !!renderError) && (
          <div className="flex animate-rise flex-col gap-2">
            {supply.mode === 'none' && (
              <Notice
                tone="accent"
                icon={Unplug}
                title="还没有绑定节点来源"
                body="这份配置目前不会注入任何订阅节点。绑定一个订阅源或聚合订阅后，策略组才有节点可选。"
                action={
                  <Button size="sm" variant="secondary" onClick={() => router.push('/profiles')}>
                    去绑定
                  </Button>
                }
              />
            )}
            {renderError ? (
              <Notice tone="bad" icon={AlertTriangle} title="最终配置渲染失败" body={String((renderError as Error).message ?? renderError)} />
            ) : null}
            {failing.length > 0 && (
              <Notice
                tone={failing.some((s) => sourceHealth(s).tone === 'bad') ? 'bad' : 'warn'}
                icon={AlertTriangle}
                title={`${failing.length} 个节点来源需要留意`}
                body={failing.map((s) => `${s.display_name || s.name}：${sourceHealth(s).detail}`).join('；')}
                action={
                  <Button size="sm" variant="secondary" onClick={() => router.push('/sources')}>
                    查看
                  </Button>
                }
              />
            )}
            {collisions.length > 0 && (
              <Notice
                tone="warn"
                icon={Layers}
                title={`${collisions.length} 个节点因重名被合并`}
                body={collisions.slice(0, 3).map((c) => c.name).join('、') + (collisions.length > 3 ? ' 等' : '') + '。可在节点处理流程里加「重复节点」步骤或改名。'}
              />
            )}
            {unmatched.length > 0 && (
              <Notice
                tone="warn"
                icon={ListTree}
                title="有规则找不到插入位置"
                body={`基础配置里缺少锚点：${unmatched.join('、')}。这些规则不会出现在最终配置中。`}
                action={
                  <Button size="sm" variant="secondary" onClick={() => router.push(path('base'))}>
                    打开基础配置
                  </Button>
                }
              />
            )}
            {warnings.map((w) => (
              <Notice key={w} tone="warn" icon={AlertTriangle} title="渲染提示" body={w} />
            ))}
          </div>
        )}

        {/* KPI strip */}
        <DataView
          label="配置总览状态"
          summary={`${profileTitle(profile)} · ${preview.data ? `${preview.data.inlined_proxy_count} 节点` : '节点加载中'} · ${counts?.proxyGroups ?? 0} 策略组 · ${activeRules ?? 0} 规则 · ${dashboard.data?.deviceCounts.total ?? 0} 设备`}
          items={overviewSummaryItems}
        >
          <Card className="grid animate-rise grid-cols-2 overflow-hidden @3xl/main:grid-cols-4 [&>*]:border-line @max-3xl/main:[&>*:nth-child(-n+2)]:border-b @max-3xl/main:[&>*:nth-child(odd)]:border-r @3xl/main:[&>*:not(:last-child)]:border-r">
          <Kpi
            label="节点"
            icon={RadioTower}
            loading={preview.isLoading}
            value={preview.data ? formatCount(preview.data.inlined_proxy_count) : '—'}
            sub={
              preview.data
                ? (preview.data.subscriptions?.length ?? 0) > 0
                  ? `来自 ${preview.data.subscriptions!.length} 个订阅源`
                  : '没有注入订阅节点'
                : renderError
                  ? '渲染失败'
                  : undefined
            }
            href="/sources"
          />
          <Kpi
            label="策略组"
            icon={Layers}
            loading={!counts}
            value={counts?.proxyGroups ?? 0}
            sub={breakdownText || '还没有策略组'}
            href={path('groups')}
          />
          <Kpi
            label="规则"
            icon={ListTree}
            loading={!rules.data}
            value={
              <>
                {activeRules ?? 0}
                {disabledRules > 0 && <span className="text-[22px] text-ink-4"> / {rules.data?.length}</span>}
              </>
            }
            sub={disabledRules > 0 ? `${disabledRules} 条已停用` : `${counts?.anchors ?? 0} 个插入位置`}
            href={path('rules')}
          />
          <Kpi
            label="设备"
            icon={MonitorSmartphone}
            loading={!dashboard.data}
            value={dashboard.data?.deviceCounts.total ?? 0}
            sub={
              dashboard.data?.deviceCounts.tailscale
                ? `${dashboard.data.deviceCounts.tailscale} 台启用 Tailscale`
                : '共享同一份配置'
            }
            href={path('devices')}
          />
          </Card>
        </DataView>

        <div className="grid gap-6 @4xl/main:grid-cols-[minmax(0,1fr)_380px]">
          {/* flow map */}
          <Card className="min-w-0 animate-rise overflow-hidden [animation-delay:60ms]">
            <CardHeader
              title="分流图"
              description="每条规则把一类流量送上一条线路。线越粗，指向它的规则越多；悬停查看，点右侧线路进入规则。"
              actions={
                <Button asChild size="sm" variant="ghost" trailingIcon={ArrowUpRight}>
                  <Link href={path('rules')}>全部规则</Link>
                </Button>
              }
            />
            <div className="px-4 pb-5 pt-1">
              {!flow ? (
                <div className="flex flex-col gap-3 py-2">
                  {[...Array(6)].map((_, i) => (
                    <Skeleton key={i} className="h-7" style={{ width: `${88 - i * 7}%` }} />
                  ))}
                </div>
              ) : flow.total === 0 ? (
                <EmptyState
                  compact
                  icon={ListTree}
                  title="还没有规则"
                  description="规则决定什么流量走哪个策略组。"
                  actions={
                    <Button size="sm" variant="primary" icon={Plus} onClick={() => router.push(`${path('rules')}?compose=1`)}>
                      添加规则
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="hidden sm:block">
                    <FlowMap
                      left={flow.left}
                      right={flow.right}
                      links={flow.links}
                      height={Math.max(260, Math.min(520, Math.max(flow.left.length, flow.right.length) * 40))}
                      onRightClick={(policy) => router.push(`${path('rules')}?policy=${encodeURIComponent(policy)}`)}
                    />
                  </div>
                  <FlowList flow={flow} onPick={(policy) => router.push(`${path('rules')}?policy=${encodeURIComponent(policy)}`)} />
                </>
              )}
            </div>
          </Card>

          {/* supply */}
          <Card className="animate-rise [animation-delay:120ms]">
            <CardHeader
              title="节点来源"
              description={
                supply.mode === 'collection' && supply.pool
                  ? `聚合订阅「${supply.pool.name}」· ${supply.list.length} 个订阅源`
                  : supply.mode === 'subscription'
                    ? '单个订阅源'
                    : '未绑定'
              }
              actions={
                <Button asChild size="sm" variant="ghost" trailingIcon={ArrowUpRight}>
                  <Link href={supply.pool ? `/pools/${supply.pool.id}` : '/sources'}>管理</Link>
                </Button>
              }
            />
            <div className="flex flex-col divide-y divide-line border-t border-line">
              {sources.isLoading ? (
                [...Array(3)].map((_, i) => (
                  <div key={i} className="flex flex-col gap-2 px-4 py-3.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-2 w-full" />
                  </div>
                ))
              ) : supply.list.length === 0 ? (
                <EmptyState
                  compact
                  icon={RadioTower}
                  title="没有节点来源"
                  description="添加机场订阅或自建节点，再绑定到这份配置。"
                  actions={
                    <Button size="sm" variant="secondary" icon={Plus} onClick={() => router.push('/sources?new=1')}>
                      添加订阅源
                    </Button>
                  }
                />
              ) : (
                supply.list.map((sub) => {
                  const health = sourceHealth(sub);
                  const traffic = trafficOf(sub.fetch_health);
                  const injected = preview.data?.nodes_by_sub?.[sub.name]?.length;
                  return (
                    <Link key={sub.id} href={`/sources/${sub.id}`} className="group flex flex-col gap-2.5 px-4 py-3.5 transition-colors hover:bg-surface-2/50">
                      <div className="flex items-center gap-2.5">
                        <Monogram name={sub.display_name || sub.name} colorKey={sub.id} size={26} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink">{sub.display_name || sub.name}</div>
                          <div className="tnum text-[11px] text-ink-3">
                            {injected !== undefined ? `注入 ${injected} 个节点` : sub.kind === 'local' ? '本地节点' : '—'}
                          </div>
                        </div>
                        <HealthPill view={health} />
                      </div>
                      {traffic && <TrafficMeter traffic={traffic} compact />}
                    </Link>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        <div className="grid gap-6 @3xl/main:grid-cols-3">
          {/* regions */}
          <Card className="animate-rise [animation-delay:160ms]">
            <CardHeader title="节点分布" description={nodeNames.length ? `${nodeNames.length} 个节点，按地区` : '按地区统计'} />
            <div className="px-4 pb-4">
              {preview.isLoading ? (
                <div className="flex flex-col gap-2.5">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-5" />
                  ))}
                </div>
              ) : regions.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-3">暂无节点</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {regions.slice(0, 8).map((r) => {
                    const pct = (r.count / nodeNames.length) * 100;
                    return (
                      <li key={r.region ?? 'other'} className="grid grid-cols-[22px_56px_1fr_28px] items-center gap-2 text-xs">
                        <Flag region={r.region} size={15} />
                        <span className="truncate text-ink-2">{r.zh}</span>
                        <span className="relative h-1.5 overflow-hidden rounded-full bg-surface-3">
                          <span className="absolute inset-y-0 left-0 rounded-full bg-ink/80" style={{ width: `${Math.max(pct, 3)}%` }} />
                        </span>
                        <span className="tnum text-right text-ink-3">{r.count}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          {/* devices */}
          <Card className="animate-rise [animation-delay:200ms]">
            <CardHeader
              title="设备"
              description="每台设备一条专属订阅链接"
              actions={
                <Button asChild size="sm" variant="ghost" trailingIcon={ArrowUpRight}>
                  <Link href={path('devices')}>管理</Link>
                </Button>
              }
            />
            <div className="flex flex-col divide-y divide-line border-t border-line">
              {devices.isLoading ? (
                [...Array(3)].map((_, i) => <Skeleton key={i} className="mx-4 my-3 h-6" />)
              ) : (devices.data ?? []).length === 0 ? (
                <EmptyState
                  compact
                  icon={MonitorSmartphone}
                  title="还没有设备"
                  description="不同设备需要不同端口或 TUN 设置时，再单独添加。"
                  actions={
                    <Button size="sm" variant="secondary" icon={Plus} onClick={() => router.push(`${path('devices')}?new=1`)}>
                      添加设备
                    </Button>
                  }
                />
              ) : (
                devices.data!.map((device) => (
                  <DeviceRow
                    key={device.id}
                    name={device.display_name || device.name}
                    slug={device.name}
                    patchCount={Object.keys(device.base_patch ?? {}).length}
                    href={path(`devices/${device.id}`)}
                    url={subscriptionUrl && !isTemplate ? `${subscriptionUrl}/${encodeURIComponent(device.name)}` : undefined}
                  />
                ))
              )}
            </div>
          </Card>

          {/* activity */}
          <Card className="animate-rise [animation-delay:240ms]">
            <CardHeader
              title="最近操作"
              actions={
                <Button asChild size="sm" variant="ghost" trailingIcon={ArrowUpRight}>
                  <Link href="/history">全部</Link>
                </Button>
              }
            />
            <div className="px-4 pb-4">
              {!dashboard.data ? (
                <div className="flex flex-col gap-3">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-5" />
                  ))}
                </div>
              ) : dashboard.data.recentEventSummaries.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-3">还没有操作记录</p>
              ) : (
                <ol className="relative flex flex-col gap-3.5 before:absolute before:bottom-1 before:left-[11px] before:top-1 before:w-px before:bg-line">
                  {dashboard.data.recentEventSummaries.map((event) => {
                    const Icon = opIcon(event.op);
                    return (
                      <li key={event.id} className="relative flex items-center gap-3">
                        <span className="relative z-10 flex size-[23px] shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-3">
                          <Icon size={12} strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                          {opLabel(event.op)}
                          {event.undoes && <span className="ml-1 text-xs text-ink-3">（撤销）</span>}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-3">{relativeTime(event.ts)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </Card>
        </div>

        <RenderFooter
          buildId={preview.data?.build_id}
          renderedAt={preview.data?.rendered_at}
          ok={!renderError && !!preview.data}
          href={path('output')}
        />
      </div>
    </Page>
  );
}

/* ─── pieces ─────────────────────────────────────────────────────────── */

function Notice({
  tone,
  icon: Icon,
  title,
  body,
  action,
}: {
  tone: 'accent' | 'warn' | 'bad';
  icon: typeof AlertTriangle;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const tones = {
    accent: 'border-accent-line/70 bg-accent-soft/60 [&_svg.notice-icon]:text-accent',
    warn: 'border-warn/25 bg-warn-soft/70 [&_svg.notice-icon]:text-warn',
    bad: 'border-bad/25 bg-bad-soft/70 [&_svg.notice-icon]:text-bad',
  };
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', tones[tone])}>
      <Icon size={16} className="notice-icon mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-2">{body}</p>
      </div>
      {action}
    </div>
  );
}

function FlowList({ flow, onPick }: { flow: NonNullable<ReturnType<typeof buildFlow>>; onPick: (policy: string) => void }) {
  const totals = new Map<string, number>();
  for (const link of flow.links) totals.set(link.to, (totals.get(link.to) ?? 0) + link.value);
  const max = Math.max(...totals.values());
  return (
    <ul className="flex flex-col gap-2 sm:hidden">
      {flow.right.map((node) => {
        const value = totals.get(node.id) ?? 0;
        return (
          <li key={node.id}>
            <UiButton type="button" onClick={() => onPick(node.id)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-left">
              <span className="truncate text-[13px] font-medium text-ink">{node.label}</span>
              <span className="tnum text-xs text-ink-3">{value} 条</span>
              <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <span className="block h-full rounded-full" style={{ width: `${(value / max) * 100}%`, background: node.color }} />
              </span>
            </UiButton>
          </li>
        );
      })}
    </ul>
  );
}

function DeviceRow({
  name,
  slug,
  patchCount,
  href,
  url,
}: {
  name: string;
  slug: string;
  patchCount: number;
  href: string;
  url?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2">
          <MonitorSmartphone size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
          <span className="block truncate text-[11px] text-ink-3">
            <span className="font-mono">{slug}</span> · {patchCount ? `${patchCount} 处差异` : '与共享配置一致'}
          </span>
        </span>
      </Link>
      {url && (
        <Tooltip content={copied ? '已复制' : '复制设备订阅链接'}>
          <UiButton
            type="button"
            onClick={() => void copy(url, `已复制「${name}」的订阅链接`)}
            className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label={`复制「${name}」的订阅链接`}
          >
            <CopyIcon copied={copied} />
          </UiButton>
        </Tooltip>
      )}
    </div>
  );
}

function RenderFooter({ buildId, renderedAt, ok, href }: { buildId?: string; renderedAt?: number; ok: boolean; href: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-ink-3">
      <span className="flex items-center gap-2">
        {ok ? <CircleCheck size={14} className="text-ok" /> : <StatusDot tone="idle" />}
        {ok ? '最终配置可以正常渲染' : '正在检查最终配置…'}
        {buildId && (
          <>
            <span className="text-ink-4">·</span>
            <span>
              build <span className="font-mono text-ink-2">{buildId}</span>
            </span>
          </>
        )}
        {renderedAt && (
          <>
            <span className="text-ink-4">·</span>
            {relativeTime(renderedAt)}渲染
          </>
        )}
      </span>
      <Link href={href} className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-ink">
        查看最终配置 <ArrowUpRight size={12} />
      </Link>
    </div>
  );
}


