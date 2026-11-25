'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, CircleAlert, FileCode2, Filter, GripVertical, Hand, Link2, Plus, RefreshCw, X } from 'lucide-react';
import { DataView } from '@/ui/agent';
import type { ProxyGroup, ProxyGroupType } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Field, Input, MultiCombobox, Select, Skeleton, Switch, type ComboOption } from '@/ui/primitives';
import { LineDot, PolicyChip, useLineColors } from '@/ui/viz/lines';
import { describeNode, Flag, NodeName } from '@/ui/viz/nodes';
import { NodeChip, Note } from './bits';
import { useWorkspace } from './context';
import { renderErrorText } from './data';
import {
  ADAPTER_TYPES,
  ancestorsOf,
  BUILTIN_OPTIONS,
  memberKind,
  manualMembersEmptyHint,
  memberSummary,
  REGION_PRESETS,
  sourceLabel,
  type Draft,
  type DraftErrors,
  type MemberKind,
  type MemberMode,
} from './model';

export const lockX: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const KIND_LABEL: Record<MemberKind, string> = { group: '策略组', node: '节点', builtin: '内置', missing: '找不到' };

/* ─── member options ─────────────────────────────────────────────────── */

/** Everything a group may list as a member, grouped 策略组 / 节点 / 内置. */
export function useMemberOptions(selfName: string | null) {
  const ws = useWorkspace();
  const { color } = useLineColors();
  const { groups, frontPools, catalog, summaryCtx } = ws;
  return useMemo(() => {
    const ancestors = selfName ? ancestorsOf(selfName, groups) : new Set<string>();
    const subOfNode = new Map<string, string>();
    for (const [sub, names] of Object.entries(catalog.bySub ?? {})) for (const n of names) subOfNode.set(n, sub);
    const subLabel = new Map((catalog.sources ?? []).map((s) => [s.name, sourceLabel(s)]));
    const groupNames = new Set(groups.map((g) => g.name));
    const nodeSet = catalog.names ? new Set(catalog.names) : null;
    const options: ComboOption[] = [];
    for (const g of groups) {
      if (g.name === selfName || frontPools.has(g.name)) continue;
      const loops = ancestors.has(g.name);
      options.push({
        value: g.name,
        label: g.name,
        group: '策略组',
        icon: <LineDot color={color(g.name)} size={8} />,
        description: loops ? '它已经包含当前组，再加入会循环引用' : memberSummary(g, summaryCtx),
        disabled: loops,
      });
    }
    for (const name of catalog.names ?? []) {
      const info = describeNode(name);
      const sub = subOfNode.get(name);
      options.push({
        value: name,
        label: info.label,
        group: '节点',
        icon: <Flag region={info.region} size={13} />,
        keywords: [info.zh ?? '', sub ?? ''],
        description: sub ? (subLabel.get(sub) ?? sub) : undefined,
      });
    }
    for (const b of BUILTIN_OPTIONS) {
      options.push({
        value: b.name,
        label: b.name,
        group: '内置',
        description: b.label,
        keywords: [b.label],
        icon: <LineDot color={color(b.name)} size={8} hollow />,
      });
    }
    return { options, kindOf: (name: string) => memberKind(name, groupNames, nodeSet) };
  }, [selfName, groups, frontPools, catalog, summaryCtx, color]);
}

/* ─── ordered pick list ──────────────────────────────────────────────── */

function PickRow({
  name,
  index,
  kind,
  isDefault,
  onRemove,
}: {
  name: string;
  index: number;
  kind: MemberKind;
  isDefault: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: name,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative flex min-h-10 items-center gap-2 bg-surface py-1.5 pl-1.5 pr-2 first:rounded-t-lg last:rounded-b-lg',
        isDragging && 'z-10 rounded-lg shadow-md ring-1 ring-line',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`拖动调整「${name}」的顺序`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-4 hover:bg-surface-2 hover:text-ink-2 active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
      <span className="tnum w-4 shrink-0 text-right text-[11px] text-ink-4">{index + 1}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {kind === 'group' || kind === 'builtin' ? (
          <PolicyChip policy={name} size="sm" />
        ) : kind === 'node' ? (
          <NodeName name={name} className="text-[13px] text-ink" />
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-bad" title="这个名字既不是节点也不是策略组，最终配置可能会因此失败">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="truncate">{name}</span>
          </span>
        )}
        {isDefault && <Badge tone="accent">默认</Badge>}
      </span>
      <span className={cn('shrink-0 text-[11px]', kind === 'missing' ? 'text-bad' : 'text-ink-4')}>{KIND_LABEL[kind]}</span>
      <UiButton
        type="button"
        onClick={onRemove}
        aria-label={`移除「${name}」`}
        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-4 hover:bg-surface-2 hover:text-ink"
      >
        <X size={13} />
      </UiButton>
    </li>
  );
}

export function PickList({
  value,
  onChange,
  type,
  options,
  kindOf,
  addLabel = '添加成员',
  emptyHint,
  error,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  type: ProxyGroupType;
  options: ComboOption[];
  kindOf: (name: string) => MemberKind;
  addLabel?: string;
  emptyHint?: ReactNode;
  error?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onChange(arrayMove(value, value.indexOf(String(active.id)), value.indexOf(String(over.id))));
  };
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[lockX]}>
          <SortableContext items={value} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {value.map((name, index) => (
                <PickRow
                  key={name}
                  name={name}
                  index={index}
                  kind={kindOf(name)}
                  isDefault={type === 'select' && index === 0 && value.length > 1}
                  onRemove={() => onChange(value.filter((v) => v !== name))}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : (
        emptyHint && (
          <div className="rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-xs leading-relaxed text-ink-3">
            {emptyHint}
          </div>
        )
      )}
      <div className="flex flex-wrap items-center gap-2">
        <MultiCombobox
          value={value}
          onChange={onChange}
          options={options}
          className="[&>span]:hidden"
          width={330}
          searchPlaceholder="搜索策略组、节点或内置策略…"
          emptyText="没有匹配的成员"
          trigger={
            <Button size="sm" icon={Plus}>
              {addLabel}
            </Button>
          }
        />
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
    </div>
  );
}

/* ─── mode picker ────────────────────────────────────────────────────── */

const MODES: Array<{ value: Exclude<MemberMode, 'raw'>; icon: typeof Hand; title: string; body: string }> = [
  { value: 'manual', icon: Hand, title: '手选成员', body: '自己挑节点、其他策略组或直连，可拖动排序' },
  { value: 'auto', icon: Filter, title: '全部节点 + 筛选', body: '自动纳入所有节点，可用正则只留一部分' },
  { value: 'bound', icon: Link2, title: '绑定订阅源', body: '只用一个订阅源的节点，随订阅自动更新' },
];

function ModePicker({ value, onChange }: { value: MemberMode; onChange: (mode: MemberMode) => void }) {
  return (
    <RadioGroup
      aria-label="成员来源"
      value={value === 'raw' ? null : value}
      onValueChange={(next) => {
        if (next) onChange(next as MemberMode);
      }}
      className="grid gap-2 sm:grid-cols-3"
    >
      {MODES.map((mode) => {
        const active = value === mode.value;
        const Icon = mode.icon;
        return (
          <Radio
            key={mode.value}
            value={mode.value}
            aria-label={mode.title}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              active ? 'border-accent-line bg-accent-soft/60 shadow-xs' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/60',
            )}
          >
            <span
              className={cn(
                'mt-px flex size-6 shrink-0 items-center justify-center rounded-md',
                active ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-3',
              )}
            >
              <Icon size={13} strokeWidth={1.9} />
            </span>
            <span className="min-w-0">
              <span className={cn('block text-[13px] font-medium', active ? 'text-ink' : 'text-ink-2')}>{mode.title}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">{mode.body}</span>
            </span>
          </Radio>
        );
      })}
    </RadioGroup>
  );
}

/* ─── auto: include all + regex ──────────────────────────────────────── */

export interface AutoResult {
  matched: string[];
  error: string | null;
  excludeError: string | null;
  typeDropped: number;
}

const PREVIEW_LIMIT = 60;

/** Live list of matched nodes; failed renders and empty matches explain themselves. */
export function MatchPreview({ auto, filter, extraCount = 0 }: { auto: AutoResult; filter: string; extraCount?: number }) {
  const { catalog } = useWorkspace();
  const [showRest, setShowRest] = useState(false);
  if (!catalog.names) {
    if (catalog.error) {
      return (
        <Note tone="warn" icon={AlertTriangle} title="暂时无法预览匹配结果">
          最终配置当前渲染失败：{renderErrorText(catalog.error)}
        </Note>
      );
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {[...Array(8)].map((_, i) => (
          <Skeleton key={i} className="h-6 rounded-full" style={{ width: 70 + ((i * 37) % 60) }} />
        ))}
      </div>
    );
  }
  if (auto.error) {
    return (
      <Note tone="bad" icon={CircleAlert} title="正则无法使用">
        {auto.error}
      </Note>
    );
  }
  const matchedSet = new Set(auto.matched);
  const rest = catalog.names.filter((n) => !matchedSet.has(n));
  return (
    <DataView
      label="匹配节点预览"
      summary={`匹配 ${auto.matched.length} / ${catalog.names.length} 个节点${auto.typeDropped > 0 ? `（排除 ${auto.typeDropped} 个协议）` : ''}`}
      items={auto.matched.map((name) => ({ value: name, label: name }))}
    >
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
          <span>
            匹配 <span className="tnum font-semibold text-ink">{auto.matched.length}</span> / {catalog.names.length} 个节点
            {auto.typeDropped > 0 && <span>（另有 {auto.typeDropped} 个因协议类型被排除）</span>}
          </span>
          {rest.length > 0 && (
            <UiButton type="button" onClick={() => setShowRest((v) => !v)} className="font-medium text-ink-2 hover:text-ink">
              {showRest ? '隐藏未匹配的' : `看看未匹配的 ${rest.length} 个`}
            </UiButton>
          )}
        </div>
        {auto.matched.length === 0 ? (
          <p className="text-xs text-warn">
            {extraCount > 0 ? '没有节点被自动纳入，组里只剩固定成员。' : '没有任何节点匹配。保存后这个组没有可用成员，最终配置会校验失败。'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {auto.matched.slice(0, PREVIEW_LIMIT).map((name) => (
              <NodeChip key={name} name={name} filter={filter} />
            ))}
            {auto.matched.length > PREVIEW_LIMIT && (
              <span className="inline-flex h-6 items-center px-1.5 text-xs text-ink-3">+{auto.matched.length - PREVIEW_LIMIT}</span>
            )}
          </div>
        )}
        {showRest && rest.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
            {rest.slice(0, PREVIEW_LIMIT).map((name) => (
              <NodeChip key={name} name={name} muted />
            ))}
          </div>
        )}
      </div>
    </DataView>
  );
}

export function RegionQuickFill({ onPick }: { onPick: (preset: (typeof REGION_PRESETS)[number]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-ink-3">快速填入</span>
      {REGION_PRESETS.map((preset) => (
        <UiButton
          key={preset.code}
          type="button"
          onClick={() => onPick(preset)}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface px-2 text-[11px] text-ink-2 transition hover:border-line-strong hover:text-ink"
        >
          <Flag region={preset.code} size={12} />
          {preset.label}
        </UiButton>
      ))}
    </div>
  );
}

function AutoFields({
  draft,
  set,
  errors,
  auto,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: DraftErrors;
  auto: AutoResult;
}) {
  const { catalog } = useWorkspace();
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const yaml of catalog.types?.values() ?? []) counts.set(yaml.toLowerCase(), (counts.get(yaml.toLowerCase()) ?? 0) + 1);
    return counts;
  }, [catalog.types]);
  const typeOptions: ComboOption[] = ADAPTER_TYPES.map((t) => ({
    value: t.value,
    label: t.value,
    description: typeCounts.get(t.yaml) ? `${typeCounts.get(t.yaml)} 个节点` : '当前没有这类节点',
  }));
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="筛选正则"
        optional
        error={errors.filter}
        hint="名字里任意位置匹配就会被纳入；多个正则用 ` 分隔。留空表示全部节点。"
      >
        {(id) => (
          <div className="flex flex-col gap-2">
            <Input
              id={id}
              mono
              value={draft.filter}
              invalid={!!errors.filter}
              placeholder="例如 (?i)港|HK|Hong Kong"
              onChange={(event) => set({ filter: event.target.value })}
            />
            <RegionQuickFill onPick={(preset) => set({ filter: preset.pattern })} />
          </div>
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="排除" optional error={errors.excludeFilter} hint="名字匹配的节点会被去掉，固定成员也一样。">
          {(id) => (
            <Input
              id={id}
              mono
              value={draft.excludeFilter}
              invalid={!!errors.excludeFilter}
              placeholder="例如 (?i)到期|剩余|官网"
              onChange={(event) => set({ excludeFilter: event.target.value })}
            />
          )}
        </Field>
        <Field label="排除协议类型" optional hint="按节点协议排除，例如不要 Shadowsocks。">
          {() => (
            <MultiCombobox
              value={draft.excludeType}
              onChange={(value) => set({ excludeType: value })}
              options={typeOptions}
              placeholder="选择类型"
              searchPlaceholder="搜索协议…"
              renderChip={(value) => <span className="font-mono text-[11px]">{value}</span>}
            />
          )}
        </Field>
      </div>
      <MatchPreview auto={auto} filter={draft.filter} extraCount={draft.proxies.length} />
    </div>
  );
}

/* ─── bound: single subscription ─────────────────────────────────────── */

function BoundFields({
  draft,
  set,
  errors,
  brokenReason,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: DraftErrors;
  brokenReason: string | undefined;
}) {
  const { catalog } = useWorkspace();
  const sources = catalog.sources ?? [];
  const selected = sources.find((s) => s.id === draft.boundSubscriptionId);
  const nodes = selected && catalog.bySub ? (catalog.bySub[selected.name] ?? []) : null;
  const options = sources.map((sub) => {
    const inProfile = !catalog.profileSubIds || catalog.profileSubIds.has(sub.id);
    const count = catalog.bySub?.[sub.name]?.length;
    const usable = sub.enabled && inProfile;
    return {
      value: sub.id,
      label: sourceLabel(sub),
      description: !sub.enabled
        ? '已停用'
        : !inProfile
          ? '这份配置没有用到它'
          : count !== undefined
            ? `${count} 个节点`
            : sub.kind === 'local'
              ? '本地节点'
              : '远程订阅',
      disabled: !usable && sub.id !== draft.boundSubscriptionId,
    };
  });
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="订阅源"
        error={errors.members}
        hint="成员就是这个订阅源经过节点处理后留下的全部节点；订阅更新后自动跟随，不用手动维护。"
      >
        {(id) => (
          <Select
            id={id}
            value={draft.boundSubscriptionId || undefined}
            onValueChange={(value) => set({ boundSubscriptionId: value })}
            options={options}
            placeholder="选择要绑定的订阅源"
            invalid={!!errors.members}
          />
        )}
      </Field>
      {brokenReason && draft.boundSubscriptionId && (
        <Note tone="bad" icon={AlertTriangle} title="这个组现在拿不到任何节点">
          {brokenReason}。最终配置会因此渲染失败——换一个订阅源，或改用其他成员方式。
        </Note>
      )}
      {selected && nodes && nodes.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 p-3">
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            <RefreshCw size={12} />
            当前 <span className="tnum font-semibold text-ink">{nodes.length}</span> 个节点，来自「{sourceLabel(selected)}」
          </div>
          <div className="flex flex-wrap gap-1.5">
            {nodes.slice(0, PREVIEW_LIMIT).map((name) => (
              <NodeChip key={name} name={name} />
            ))}
            {nodes.length > PREVIEW_LIMIT && <span className="px-1.5 text-xs text-ink-3">+{nodes.length - PREVIEW_LIMIT}</span>}
          </div>
        </div>
      )}
      {selected && !nodes && catalog.error && !brokenReason ? (
        <Note tone="warn" icon={AlertTriangle}>
          最终配置当前渲染失败，暂时看不到这个订阅源的节点：{renderErrorText(catalog.error)}
        </Note>
      ) : null}
    </div>
  );
}

/* ─── composer ───────────────────────────────────────────────────────── */

export function MembersComposer({
  group,
  draft,
  set,
  errors,
  auto,
  brokenReason,
}: {
  group: ProxyGroup;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: DraftErrors;
  auto: AutoResult;
  brokenReason: string | undefined;
}) {
  const { options, kindOf } = useMemberOptions(group.name);
  const { catalog } = useWorkspace();
  const dynamic = draft.mode === 'auto' || (draft.mode === 'raw' && (draft.includeAll || !!group['include-all']));
  const emptyHint = !dynamic && draft.mode === 'raw' && (group.use?.length || group['include-all-providers'])
    ? '手动成员为空；成员由外部 provider 动态提供。'
    : manualMembersEmptyHint(dynamic, catalog.names && !auto.error && !auto.excludeError ? auto.matched.length : null);
  const typeHint =
    draft.type === 'select'
      ? '第一个成员是默认选中的出口。'
      : draft.type === 'fallback'
        ? '按从上到下的顺序尝试，前面的不可用才轮到后面的。'
        : null;
  const extras = [
    group.use?.length ? `use: ${group.use.join(', ')}` : null,
    group['include-all'] ? 'include-all' : null,
    group['include-all-providers'] ? 'include-all-providers' : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      <ModePicker value={draft.mode} onChange={(mode) => set({ mode })} />

      {draft.mode === 'raw' && (
        <Note tone="info" icon={FileCode2} title="原始写法">
          这个策略组是原样导入的，下面按原生字段编辑它；在上面选一种成员方式，就会转成托管的写法。
          {extras.length > 0 && (
            <span className="mt-1 block font-mono text-[11px] text-ink-3">另有：{extras.join(' · ')}（保持不变）</span>
          )}
        </Note>
      )}

      {(draft.mode === 'manual' || draft.mode === 'raw') && (
        <div className="flex flex-col gap-2">
          {typeHint && draft.proxies.length > 1 && <p className="text-xs text-ink-3">{typeHint}</p>}
          <PickList
            value={draft.proxies}
            onChange={(proxies) => set({ proxies })}
            type={draft.type}
            options={options}
            kindOf={kindOf}
            error={errors.members}
            emptyHint={emptyHint}
          />
        </div>
      )}

      {draft.mode === 'raw' && (
        <Field inline label="纳入全部节点" hint="include-all-proxies：把这份配置的全部节点都加进来，再按正则筛选。" className="py-0">
          {(id) => <Switch id={id} checked={draft.includeAll} onCheckedChange={(includeAll) => set({ includeAll })} />}
        </Field>
      )}

      {(draft.mode === 'auto' || (draft.mode === 'raw' && draft.includeAll)) && (
        <AutoFields draft={draft} set={set} errors={errors} auto={auto} />
      )}

      {draft.mode === 'auto' && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <div>
            <div className="text-xs font-medium text-ink-2">固定成员</div>
            <p className="mt-0.5 text-xs text-ink-3">可选。排在自动纳入的节点前面，例如再放一个 DIRECT 或其他策略组。</p>
          </div>
          <PickList
            value={draft.proxies}
            onChange={(proxies) => set({ proxies })}
            type={draft.type}
            options={options}
            kindOf={kindOf}
            addLabel="添加固定成员"
            emptyHint={emptyHint}
          />
        </div>
      )}

      {draft.mode === 'bound' && <BoundFields draft={draft} set={set} errors={errors} brokenReason={brokenReason} />}
    </div>
  );
}
