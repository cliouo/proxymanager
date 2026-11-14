'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, EyeOff, Plus, Waypoints } from 'lucide-react';
import type { ProxyGroup } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Button, Code, EmptyState, Skeleton } from '@/ui/primitives';
import { groupTypeMeta, isBuiltinPolicy, PolicyChip, useLineColors } from '@/ui/viz/lines';
import { NodeName, RegionStrip } from '@/ui/viz/nodes';
import { Note } from './bits';
import { useWorkspace } from './context';
import { renderErrorText } from './data';
import { prettyPattern, resolvedNodes, sourceLabel } from './model';

interface Graph {
  children: Map<string, Set<string>>;
  parents: Map<string, Set<string>>;
}

function buildGraph(groups: ProxyGroup[]): Graph {
  const names = new Set(groups.map((g) => g.name));
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!children.has(from)) children.set(from, new Set());
    if (!parents.has(to)) parents.set(to, new Set());
    children.get(from)!.add(to);
    parents.get(to)!.add(from);
  };
  for (const g of groups) {
    for (const member of g.proxies ?? []) if (names.has(member)) link(g.name, member);
    const dp = g['dialer-proxy'];
    if (dp && names.has(dp)) link(g.name, dp);
  }
  return { children, parents };
}

function Members({ group }: { group: ProxyGroup }) {
  const ws = useWorkspace();
  const nodes = resolvedNodes(group, ws.summaryCtx);
  if (group.kind === 'single-sub') {
    const sub = group.bound_subscription_id ? ws.catalog.subsById.get(group.bound_subscription_id) : undefined;
    const broken = ws.brokenBindings.get(group.id);
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
        <span className="inline-flex h-6 items-center rounded-full border border-line bg-surface-2 px-2">绑定 · {sourceLabel(sub)}</span>
        {broken ? (
          <span className="inline-flex items-center gap-1 text-bad">
            <AlertTriangle size={12} />
            没有节点
          </span>
        ) : nodes ? (
          <RegionStrip names={nodes} max={5} />
        ) : null}
      </div>
    );
  }
  const explicit = group.proxies ?? [];
  const groupNames = ws.summaryCtx.groupNames;
  const policyMembers = explicit.filter((m) => groupNames.has(m) || isBuiltinPolicy(m));
  const nodeMembers = explicit.filter((m) => !groupNames.has(m) && !isBuiltinPolicy(m));
  const auto = !!group['include-all-proxies'];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {policyMembers.map((m) => (
        <PolicyChip key={m} policy={m} size="sm" />
      ))}
      {nodeMembers.slice(0, 2).map((m) => (
        <span key={m} className="inline-flex h-5 max-w-[150px] items-center rounded-full border border-line bg-surface px-1.5 text-[11px] text-ink-2">
          <NodeName name={m} />
        </span>
      ))}
      {nodeMembers.length > 2 && <span className="text-[11px] text-ink-3">+{nodeMembers.length - 2} 个节点</span>}
      {auto && (
        <>
          {group.filter ? (
            <Code className="max-w-[180px] truncate">{prettyPattern(group.filter)}</Code>
          ) : (
            <span className="inline-flex h-5 items-center rounded-full border border-line bg-surface-2 px-1.5 text-[11px] text-ink-2">全部节点</span>
          )}
          {nodes && (nodes.length > 0 ? <RegionStrip names={nodes} max={5} /> : <span className="text-[11px] text-warn">没有匹配的节点</span>)}
        </>
      )}
    </div>
  );
}

function LineCard({
  group,
  dim,
  linked,
  onFocus,
}: {
  group: ProxyGroup;
  dim: boolean;
  linked: boolean;
  onFocus: (name: string | null) => void;
}) {
  const ws = useWorkspace();
  const { color } = useLineColors();
  const c = color(group.name);
  const meta = groupTypeMeta(group.type);
  const TypeIcon = meta.icon;
  const rules = ws.ruleCounts[group.name] ?? 0;
  return (
    <button
      type="button"
      onClick={() => void ws.select(group.id)}
      onMouseEnter={() => onFocus(group.name)}
      onMouseLeave={() => onFocus(null)}
      onFocus={() => onFocus(group.name)}
      onBlur={() => onFocus(null)}
      className={cn(
        'relative flex w-full flex-col gap-2.5 overflow-hidden rounded-xl border bg-surface py-3 pl-4 pr-3 text-left shadow-xs',
        'transition-[opacity,border-color,box-shadow,transform] duration-200 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        dim ? 'border-line opacity-35' : linked ? 'border-line-strong' : 'border-line hover:border-line-strong',
      )}
      style={linked ? { background: `color-mix(in srgb, ${c} 5%, var(--surface))` } : undefined}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: c }} />
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] font-semibold text-ink">{group.name}</span>
        {group.hidden && <EyeOff size={12} className="shrink-0 text-ink-4" />}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-ink-3">
          <TypeIcon size={12} strokeWidth={1.9} />
          {meta.short}
          {rules > 0 && (
            <>
              <span className="text-ink-4">·</span>
              <span className="tnum">{rules} 条规则</span>
            </>
          )}
        </span>
      </span>
      <Members group={group} />
    </button>
  );
}

function Band({
  title,
  description,
  groups,
  focus,
  related,
  onFocus,
}: {
  title: string;
  description: string;
  groups: ProxyGroup[];
  focus: string | null;
  related: Set<string> | null;
  onFocus: (name: string | null) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <span className="tnum text-xs text-ink-4">{groups.length}</span>
        <span className="truncate text-xs text-ink-3">{description}</span>
      </div>
      <div className="grid gap-2.5 md:grid-cols-2">
        {groups.map((g) => (
          <LineCard
            key={g.id}
            group={g}
            dim={!!related && !related.has(g.name)}
            linked={!!related && related.has(g.name) && g.name !== focus}
            onFocus={onFocus}
          />
        ))}
      </div>
    </section>
  );
}

export function GroupsOverview() {
  const ws = useWorkspace();
  const [focus, setFocus] = useState<string | null>(null);
  const graph = useMemo(() => buildGraph(ws.groups), [ws.groups]);

  const related = useMemo(() => {
    if (!focus) return null;
    return new Set([focus, ...(graph.children.get(focus) ?? []), ...(graph.parents.get(focus) ?? [])]);
  }, [focus, graph]);

  if (!ws.book.data) {
    if (ws.book.error) {
      return (
        <EmptyState
          icon={Waypoints}
          title="策略组没有加载出来"
          description="网络或服务出了点问题。"
          actions={<Button onClick={() => void ws.book.refetch()}>重试</Button>}
        />
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-80" />
        <div className="grid gap-2.5 md:grid-cols-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (ws.groups.length === 0) {
    return (
      <EmptyState
        className="pt-16"
        icon={Waypoints}
        title="这份配置还没有策略组"
        description="策略组是流量的出口线路。常见做法：一个「节点选择」手选组作为入口，再按地区建几个自动测速组。"
        actions={
          <Button variant="primary" icon={Plus} onClick={ws.openCreate}>
            新建策略组
          </Button>
        }
      />
    );
  }

  const direct = ws.groups.filter((g) => (ws.ruleCounts[g.name] ?? 0) > 0);
  const feeders = ws.groups.filter((g) => !(ws.ruleCounts[g.name] ?? 0) && (graph.parents.get(g.name)?.size ?? 0) > 0);
  const idle = ws.groups.filter((g) => !(ws.ruleCounts[g.name] ?? 0) && !(graph.parents.get(g.name)?.size ?? 0));
  const broken = ws.groups.filter((g) => ws.brokenBindings.has(g.id));
  const nodeCount = ws.catalog.names?.length;

  return (
    <div className="flex animate-rise flex-col gap-6">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">线路总览</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-3">
          规则决定流量上哪条线路，线路再从成员里挑出口。悬停一条线路，看它连着哪些线路；点击进入编辑。
        </p>
        <p className="tnum mt-2 text-xs text-ink-2">
          {ws.groups.length} 条线路 · {direct.length} 条被规则直接使用
          {nodeCount !== undefined && ` · ${nodeCount} 个节点`}
        </p>
      </div>

      {broken.length > 0 ? (
        <Note
          tone="bad"
          icon={AlertTriangle}
          title={`「${broken[0].name}」拿不到任何节点`}
          action={
            <Button size="sm" variant="secondary" onClick={() => void ws.select(broken[0].id)}>
              去修复
            </Button>
          }
        >
          {ws.brokenBindings.get(broken[0].id)}，最终配置因此无法渲染，这份配置的所有保存也会被拦下。
        </Note>
      ) : ws.catalog.error ? (
        <Note tone="warn" icon={AlertTriangle} title="最终配置渲染失败">
          {renderErrorText(ws.catalog.error)}
        </Note>
      ) : null}

      <Band
        title="规则直达"
        description="规则直接把流量送到这些线路"
        groups={direct}
        focus={focus}
        related={related}
        onFocus={setFocus}
      />
      <Band
        title="中转线路"
        description="只作为其他线路的成员出现"
        groups={feeders}
        focus={focus}
        related={related}
        onFocus={setFocus}
      />
      <Band
        title="闲置"
        description="没有规则或线路用到它们，可以接入规则或删除"
        groups={idle}
        focus={focus}
        related={related}
        onFocus={setFocus}
      />
    </div>
  );
}
