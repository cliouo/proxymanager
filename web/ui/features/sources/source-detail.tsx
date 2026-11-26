'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Check, Download, Link2, MoreHorizontal, Power, PowerOff, RadioTower, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { DataView } from '@/ui/agent';
import { errorMessage } from '@/ui/data/api';
import { refreshShared, useSource, useSources } from '@/ui/data/hooks';
import { formatDate, relativeTime } from '@/ui/lib/format';
import { Badge, Button, Card, EmptyState, Menu, Monogram, notify, Skeleton, TabPanel, Tabs, useCopy } from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { HealthPill, sourceHealth, TrafficMeter, trafficOf } from '@/ui/viz/health';
import { PipelineEditor } from '@/ui/pipeline/pipeline-editor';
import { NamingLink, NamingSetupPrompt } from './naming-entry';
import { deleteSource, patchSource, refreshSource, setSourceEnabled } from './actions';
import { ManualImportDialog } from './manual-import';
import { canServerRefresh, msToMinutes, sourceLink, sourceMode, sourceTitle, type Source } from './model';
import { SourceSettings } from './source-settings';
import { DistributionPanel, NodesPanel, TAB_SCROLL, UsagePanel, useSubBase, useTabParam } from './shared';

const TABS = ['nodes', 'pipeline', 'settings', 'usage', 'share'] as const;

function Facts({ source }: { source: Source }) {
  const traffic = source.traffic ?? trafficOf(source.fetch_health) ?? source.manual_snapshot?.traffic;
  const health = source.fetch_health;
  const mode = sourceMode(source);
  const cells: Array<{ label: string; value: React.ReactNode }> = [];
  if (mode === 'auto') {
    cells.push({
      label: '上次拉取',
      value: health ? relativeTime(health.attempted_at) : '还没有',
    });
    cells.push({ label: '缓存时长', value: `${msToMinutes(source.ttl_ms)} 分钟` });
    cells.push({ label: '拉取失败时', value: source.fetch_failure_policy === 'fail-closed' ? '阻断' : '沿用缓存' });
  } else if (mode === 'server-manual') {
    cells.push({ label: '上次刷新', value: source.manual_snapshot ? relativeTime(source.manual_snapshot.updated_at) : '还没有' });
    cells.push({ label: '缓存策略', value: '永久缓存（仅手动刷新）' });
    cells.push({ label: '缓存节点', value: source.manual_snapshot ? `${source.manual_snapshot.proxy_count} 个` : '—' });
  } else if (mode === 'manual') {
    cells.push({ label: '上次导入', value: source.manual_snapshot ? relativeTime(source.manual_snapshot.updated_at) : '还没有' });
    cells.push({ label: '导入节点', value: source.manual_snapshot ? `${source.manual_snapshot.proxy_count} 个` : '—' });
  }
  if (!traffic && cells.length === 0) return null;
  const factItems = [
    ...(traffic
      ? [
          {
            value: 'traffic',
            label: `流量：已用 ${Math.round(((traffic.upload + traffic.download) / Math.max(traffic.total || 1, 1)) * 100)}%${traffic.expire > 0 ? ` · ${formatDate(traffic.expire)} 到期` : ''}`,
          },
        ]
      : []),
    ...cells.map((cell) => ({ value: cell.label, label: `${cell.label}：${String(cell.value)}` })),
  ];
  return (
    <DataView label="订阅源概览" summary={factItems.map((i) => i.label).join('；')} items={factItems}>
      <Card className="grid gap-px overflow-hidden bg-line sm:grid-cols-[1.4fr_repeat(3,1fr)]">
        {traffic && (
          <div className="bg-surface px-4 py-3">
            <div className="mb-1.5 text-2xs text-ink-3">
              流量{traffic.expire > 0 ? ` · ${formatDate(traffic.expire)} 到期` : ''}
            </div>
            <TrafficMeter traffic={traffic} />
          </div>
        )}
        {cells.map((cell) => (
          <div key={cell.label} className="bg-surface px-4 py-3">
            <div className="text-2xs text-ink-3">{cell.label}</div>
            <div className="tnum mt-1 text-[13px] font-medium text-ink">{cell.value}</div>
          </div>
        ))}
      </Card>
    </DataView>
  );
}

export function SourceDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const detail = useSource(id);
  const list = useSources();
  const source = detail.data ?? list.data?.find((s) => s.id === id);
  const subBase = useSubBase();
  const { tab, setTab, visited } = useTabParam(TABS, 'nodes');
  const { copied, copy } = useCopy();
  const [busy, setBusy] = useState<'refresh' | 'mode' | null>(null);
  const [importing, setImporting] = useState(false);
  const [pipelineDirty, setPipelineDirty] = useState(false);

  if (!source) {
    if (detail.error) {
      const missing = (detail.error as { status?: number }).status === 404;
      return (
        <Page>
          <PageHeader title={missing ? '找不到这个订阅源' : '加载失败'} back={{ href: '/sources', label: '节点来源' }} />
          <EmptyState
            icon={RadioTower}
            title={missing ? '它可能已经被删除了' : errorMessage(detail.error)}
            actions={
              missing ? (
                <Button asChild variant="secondary">
                  <Link href="/sources">回到节点来源</Link>
                </Button>
              ) : (
                <Button icon={RotateCcw} onClick={() => void detail.refetch()}>
                  重试
                </Button>
              )
            }
          />
        </Page>
      );
    }
    return (
      <Page>
        <div className="flex flex-col gap-4 pt-9">
          <Skeleton className="h-3 w-20" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-[28%]" />
            <Skeleton className="h-7 w-48" />
          </div>
          <Skeleton className="h-4 w-72" />
          <Skeleton className="mt-6 h-10 w-full" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </Page>
    );
  }

  const title = sourceTitle(source);
  const health = sourceHealth(source);
  const mode = sourceMode(source);
  const link = subBase ? sourceLink(subBase, source) : null;

  const backToAuto = async () => {
    setBusy('mode');
    try {
      await patchSource(source, { refresh_mode: 'server-auto' });
      notify.success('已改回平台自动拉取');
      refreshShared();
      void refreshSource(source, true);
    } catch (error) {
      notify.error(error, '切换失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHeader
        back={{ href: '/sources', label: '节点来源' }}
        documentTitle={`${title} · 订阅源`}
        eyebrow={
          <>
            <span>订阅源</span>
            <span className="font-mono text-[11px] text-ink-2">{source.name}</span>
            <Badge tone="outline">{source.kind === 'local' ? '本地' : '远程'}</Badge>
            {mode === 'server-manual' && <Badge tone="neutral">仅手动刷新</Badge>}
          </>
        }
        title={
          <span className="flex items-center gap-3">
            <Monogram name={title} colorKey={source.id} size={36} />
            <span className="min-w-0 truncate">{title}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <HealthPill view={health} />
            <span className="text-ink-2">{health.detail}</span>
            {mode === 'manual' && (
              <Button
                size="xs"
                variant="link"
                loading={busy === 'mode'}
                data-agent-confirm={`将「${title}」改回平台自动拉取`}
                onClick={() => void backToAuto()}
              >
                改回平台自动拉取
              </Button>
            )}
          </span>
        }
        actions={
          <>
            <NamingLink href={`/sources/${source.id}/naming`} dirty={pipelineDirty} />
            {canServerRefresh(source) && (
              <Button
                variant={mode === 'server-manual' && !source.manual_snapshot ? 'primary' : undefined}
                icon={RefreshCw}
                loading={busy === 'refresh'}
                data-agent-confirm={`刷新订阅源「${title}」`}
                onClick={async () => {
                  setBusy('refresh');
                  await refreshSource(source);
                  setBusy(null);
                }}
              >
                {mode === 'server-manual' ? '手动刷新' : '刷新'}
              </Button>
            )}
            {mode === 'manual' && source.enabled && (
              <Button icon={Download} onClick={() => setImporting(true)}>
                手动导入
              </Button>
            )}
            <Button icon={copied ? Check : Link2} disabled={!link} onClick={() => link && void copy(link, '已复制分发链接')}>
              复制链接
            </Button>
            <Menu
              items={[
                ...((mode === 'auto' || mode === 'server-manual') && source.enabled
                  ? [{ label: '手动导入…', icon: Download, onSelect: () => setImporting(true) }, 'separator' as const]
                  : []),
                source.enabled
                  ? { label: '停用', icon: PowerOff, confirm: `停用订阅源「${title}」`, onSelect: () => void setSourceEnabled(source, false) }
                  : { label: '启用', icon: Power, confirm: `启用订阅源「${title}」`, onSelect: () => void setSourceEnabled(source, true) },
                { label: '删除', icon: Trash2, tone: 'danger' as const, onSelect: async () => (await deleteSource(source)) && router.push('/sources') },
              ]}
              trigger={<Button iconOnly icon={MoreHorizontal} aria-label="更多操作" />}
            />
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Facts source={source} />
        <Tabs
          label="订阅源详情标签页"
          value={tab}
          onValueChange={setTab}
          className={TAB_SCROLL}
          tabs={[
            { value: 'nodes', label: '节点' },
            { value: 'pipeline', label: '处理流程', count: source.operators.length || undefined },
            { value: 'settings', label: '设置' },
            { value: 'usage', label: '使用情况' },
            { value: 'share', label: '分发' },
          ]}
        >
          <div className="pt-6">
            {visited.has('nodes') && (
              <TabPanel value="nodes" forceMount className="outline-none data-[state=inactive]:hidden">
                <NodesPanel
                  target={{ kind: 'subscription', id: source.id }}
                  operators={source.operators}
                  version={source.updated_at}
                  enabled={source.enabled}
                />
              </TabPanel>
            )}
            {visited.has('pipeline') && (
              <TabPanel value="pipeline" forceMount className="outline-none data-[state=inactive]:hidden">
                <NamingSetupPrompt href={`/sources/${source.id}/naming`} operators={source.operators} dirty={pipelineDirty} />
                <PipelineEditor
                  target={{ kind: 'subscription', id: source.id }}
                  operators={source.operators}
                  updatedAt={source.updated_at}
                  namingHref={`/sources/${source.id}/naming`}
                  onDirtyChange={setPipelineDirty}
                  active={tab === 'pipeline'}
                  originHint={source.kind === 'local' ? '来自你粘贴的节点内容' : '拉取并解析订阅后得到的节点'}
                />
              </TabPanel>
            )}
            {visited.has('settings') && (
              <TabPanel value="settings" forceMount className="outline-none data-[state=inactive]:hidden">
                {detail.data ? (
                  <SourceSettings key={detail.data.updated_at ?? 0} source={detail.data} active={tab === 'settings'} />
                ) : detail.error ? (
                  <EmptyState
                    icon={RadioTower}
                    title={errorMessage(detail.error)}
                    actions={
                      <Button icon={RotateCcw} onClick={() => void detail.refetch()}>
                        重试
                      </Button>
                    }
                  />
                ) : (
                  <Skeleton className="h-64 w-full rounded-xl" />
                )}
              </TabPanel>
            )}
            {visited.has('usage') && (
              <TabPanel value="usage" forceMount className="outline-none data-[state=inactive]:hidden">
                <UsagePanel kind="subscription" id={source.id} />
              </TabPanel>
            )}
            {visited.has('share') && (
              <TabPanel value="share" forceMount className="outline-none data-[state=inactive]:hidden">
                <DistributionPanel label={title} path={(base) => sourceLink(base, source)} />
              </TabPanel>
            )}
          </div>
        </Tabs>
      </div>

      {source.kind === 'remote' && <ManualImportDialog source={source} open={importing} onOpenChange={setImporting} />}
    </Page>
  );
}
