'use client';

import { useMemo, useState } from 'react';
import { CircleAlert, Copy, Link2, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import { matchFilter } from '@/lib/proxies/filterMatch';
import { errorMessage } from '@/ui/data/api';
import { refreshProfile, useChains, useGroups, useParsed, useRuleSummary } from '@/ui/data/hooks';
import { cn } from '@/ui/lib/cn';
import { DataView } from '@/ui/agent';
import { Badge, Button, Card, confirmAction, copyText, EmptyState, Menu, notify, Skeleton, type MenuEntry } from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { useScope } from '@/ui/shell/scope';
import { PolicyChip } from '@/ui/viz/lines';
import { NodeName, RegionStrip } from '@/ui/viz/nodes';
import { EditPoolDialog, NewChainDialog, type PickerData } from './chain-dialogs';
import { ChainDiagram, Endpoint } from './chain-diagram';
import { chainViews, nodesOf, runChainOp, STRATEGY_META, type ChainView } from './model';

const KIND_LABEL: Record<ChainView['kind'], string> = { fixed: '固定前置', pool: '前置池', smart: '智能前置池' };

export function ChainsPage() {
  const { profileId } = useScope();
  const chains = useChains(profileId);
  const groups = useGroups(profileId);
  const parsed = useParsed(profileId);
  const summary = useRuleSummary(profileId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Extract<ChainView, { kind: 'pool' | 'smart' }> | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const views = useMemo(
    () => (chains.data && groups.data ? chainViews(chains.data, groups.data) : null),
    [chains.data, groups.data],
  );
  const nodeTypes = useMemo(() => new Map(nodesOf(parsed.data).map((p) => [p.name, p.type])), [parsed.data]);
  const nodeNames = useMemo(() => [...nodeTypes.keys()], [nodeTypes]);
  const groupNames = useMemo(() => new Set((groups.data ?? []).map((g) => g.name)), [groups.data]);
  const pickerData: PickerData = {
    parsed: parsed.data,
    parsedError: parsed.error,
    retryParsed: () => void parsed.refetch(),
    groups: groups.data ?? [],
  };

  const usage = (chainName: string) => {
    const rules = summary.data?.policies[chainName] ?? 0;
    const refs = (groups.data ?? []).filter((g) => g.proxies?.includes(chainName)).map((g) => g.name);
    return { rules, refs };
  };

  const remove = async (view: ChainView) => {
    const { rules, refs } = usage(view.chainName);
    const users = [rules ? `${rules} 条规则` : '', refs.length ? `策略组 ${refs.join('、')}` : ''].filter(Boolean).join('、');
    const ok = await confirmAction({
      title: `删除链路「${view.chainName}」？`,
      description: `${view.kind === 'fixed' ? '' : `前置池「${view.poolName}」会一并删除。`}${
        users
          ? `它正被 ${users} 使用，需要先把这些引用改成别的策略，否则删除会被拒绝。`
          : '删除后客户端里不再有这个策略组，可以在「操作历史」里撤销。'
      }`,
      confirmText: '确认删除',
      confirmHint: '删除后客户端里不再有这个链式代理策略组',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await runChainOp(profileId, view.kind === 'fixed' ? 'clear-chain' : 'delete-pool-chain', { chainName: view.chainName });
      refreshProfile(profileId);
      notify.success('已删除链路', view.chainName);
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  const loadError = chains.error ?? groups.error;

  return (
    <Page>
      <PageHeader
        title="链式代理"
        description="流量先经过前置节点，再从落地节点出去；用于固定落地 IP 或解锁。"
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!groups.data}>
            新建链路
          </Button>
        }
      />

      {loadError && !views ? (
        <Card className="flex items-center gap-3 px-4 py-3.5 text-sm">
          <CircleAlert size={16} className="shrink-0 text-bad" />
          <span className="min-w-0 flex-1 text-ink-2">链路加载失败：{errorMessage(loadError)}</span>
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={() => {
              void chains.refetch();
              void groups.refetch();
            }}
          >
            重试
          </Button>
        </Card>
      ) : !views ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} className="flex flex-col gap-4 p-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-[5px] w-full rounded-full" />
              <div className="flex justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-28" />
              </div>
            </Card>
          ))}
        </div>
      ) : views.length === 0 ? (
        <Card className="animate-rise">
          <EmptyState
            icon={Link2}
            title="还没有链式代理"
            description="例如：先连香港 IPLC（快、稳），再从美国家宽出去（干净的落地 IP）。创建后会生成一个策略组，在规则里选择它即可使用。"
            actions={
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                新建链路
              </Button>
            }
          />
        </Card>
      ) : (
        <DataView
          label="链式代理列表"
          summary={`共 ${views.length} 条链路`}
          items={views.map((v) => ({
            value: v.chainName,
            label: `${v.chainName} [${KIND_LABEL[v.kind]}] · ${
              v.kind === 'fixed'
                ? `${v.front} → ${v.backend}`
                : v.kind === 'pool'
                  ? `${v.poolName} (${v.members.length} 成员) → ${v.backend}`
                  : `${v.poolName} (筛选: ${v.smart.filter || '全部'}) → ${v.backend}`
            }`,
          }))}
        >
          <div className="flex flex-col gap-3">
            {views.map((view, index) => {
              const { rules, refs } = usage(view.chainName);
              const menu: MenuEntry[] = [
                ...(view.kind === 'pool'
                  ? [{ label: '编辑前置成员', icon: Users, onSelect: () => setEditing(view) }]
                  : view.kind === 'smart'
                    ? [{ label: '调整筛选与测速', icon: SlidersHorizontal, onSelect: () => setEditing(view) }]
                    : []),
                {
                  label: '复制策略组名',
                  icon: Copy,
                  onSelect: () => void copyText(view.chainName).then((ok) => ok && notify.success('已复制', view.chainName)),
                },
                'separator',
                { label: '删除链路', icon: Trash2, tone: 'danger', onSelect: () => void remove(view) },
              ];
              const front =
                view.kind === 'fixed' ? (
                  <Endpoint
                    name={view.front}
                    isGroup={groupNames.has(view.front)}
                    meta={groupNames.has(view.front) ? '策略组' : nodeTypes.get(view.front)}
                  />
                ) : (
                  <Endpoint
                    name={view.poolName}
                    isGroup
                    meta={
                      view.kind === 'pool'
                        ? `前置池 · ${view.members.length} 个成员 · 客户端里切换`
                        : `智能前置池 · ${STRATEGY_META[view.smart.strategy].label} · 每 ${view.smart.interval} 秒测速`
                    }
                  />
                );
              const matched =
                view.kind === 'smart' && parsed.data ? matchFilter(nodeNames, view.smart.filter || undefined).matched : null;
              return (
                <Card
                  key={view.chainName}
                  as="article"
                  className={cn(
                    'flex animate-rise flex-col gap-4 p-4 transition-shadow',
                    fresh === view.chainName && 'border-accent-line shadow-[var(--ring)]',
                  )}
                >
                  <header className="flex items-start gap-3">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <PolicyChip policy={view.chainName} className="max-w-full" />
                      <Badge tone="outline">{KIND_LABEL[view.kind]}</Badge>
                    </div>
                    <span className="hidden shrink-0 pt-1 text-xs text-ink-3 sm:inline">
                      {rules || refs.length
                        ? [rules ? `${rules} 条规则` : '', refs.length ? `${refs.length} 个策略组` : ''].filter(Boolean).join(' · ') + ' 在用'
                        : '还没有规则使用'}
                    </span>
                    <Menu
                      items={menu}
                      trigger={
                        <Button variant="ghost" size="sm" iconOnly icon={MoreHorizontal} aria-label={`链路 ${index + 1} 的更多操作`} />
                      }
                    />
                  </header>
                  <ChainDiagram
                    lineName={view.chainName}
                    front={front}
                    backend={<Endpoint name={view.backend} meta={nodeTypes.get(view.backend) ?? '落地节点'} />}
                  />
                  {view.kind === 'pool' && (
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
                      <span className="mr-1 text-xs text-ink-3">成员</span>
                      {view.members.map((member) => (
                        <span key={member} className="inline-flex h-6 max-w-[220px] items-center rounded-md border border-line bg-surface px-1.5 text-xs shadow-xs">
                          <NodeName name={member} />
                        </span>
                      ))}
                    </div>
                  )}
                  {view.kind === 'smart' && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3 text-xs text-ink-3">
                      <span>
                        筛选{' '}
                        <code className="rounded-[5px] border border-line bg-surface-2 px-1 py-px font-mono text-[11.5px] text-ink-2">
                          {view.smart.filter || '全部节点'}
                        </code>
                      </span>
                      {matched && (
                        <>
                          <span>
                            当前匹配 <span className="tnum font-medium text-ink">{matched.length}</span> 个
                          </span>
                          <RegionStrip names={matched} max={5} />
                        </>
                      )}
                      <span className="basis-full text-2xs text-ink-4 sm:basis-auto">订阅更新、节点改名后自动跟着变</span>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </DataView>
      )}

      <NewChainDialog
        open={creating}
        onOpenChange={setCreating}
        profileId={profileId}
        data={pickerData}
        onCreated={(chainName) => {
          setCreating(false);
          setFresh(chainName);
        }}
      />
      <EditPoolDialog view={editing} onClose={() => setEditing(null)} profileId={profileId} data={pickerData} />
    </Page>
  );
}
