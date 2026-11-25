'use client';

import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, EyeOff, Plus, Waypoints } from 'lucide-react';
import { DataView } from '@/ui/agent';
import type { ProxyGroup } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Button, EmptyState, Kbd, notify, SearchInput, Skeleton } from '@/ui/primitives';
import { groupTypeMeta, useLineColors } from '@/ui/viz/lines';
import { useWorkspace } from './context';
import { reorderGroups } from './data';
import { hasUnsavedEdits } from './guard';
import { lockX } from './members';
import { bucketBySection, memberSummary, type Bucket } from './model';

function Row({
  group,
  selected,
  onNavigate,
}: {
  group: ProxyGroup;
  selected: boolean;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  const ws = useWorkspace();
  const { color } = useLineColors();
  const meta = groupTypeMeta(group.type);
  const TypeIcon = meta.icon;
  const rules = ws.ruleCounts[group.name] ?? 0;
  const broken = ws.brokenBindings.get(group.id);
  return (
    <UiButton
      render={
        <Link
          href={ws.hrefFor(group.id)}
          data-group-id={group.id}
          draggable={false}
          aria-current={selected ? 'page' : undefined}
        />
      }
      aria-label={`选择策略组「${group.name}」`}
      onClick={(event) => onNavigate(event as unknown as MouseEvent<HTMLAnchorElement>, group.id)}
      className={cn(
        'group/row relative flex items-center gap-2 rounded-lg py-2 pl-4 pr-2.5 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-accent/40',
        selected ? 'bg-accent-soft/70' : 'hover:bg-surface-2',
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-2 left-1.5 w-[3px] rounded-full"
        style={{ background: color(group.name) }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate text-[13px] font-medium', selected ? 'text-ink' : 'text-ink')}>{group.name}</span>
          {group.hidden && (
            <span title="在客户端隐藏" className="shrink-0 text-ink-4">
              <EyeOff size={12} />
            </span>
          )}
          {broken && (
            <span title={broken} className="shrink-0 text-bad">
              <AlertTriangle size={12} />
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-ink-3">
          <TypeIcon size={11} strokeWidth={1.9} className="shrink-0" />
          <span className="shrink-0">{meta.short}</span>
          <span className="text-ink-4">·</span>
          <span className="truncate">{memberSummary(group, ws.summaryCtx)}</span>
        </span>
      </span>
      {rules > 0 && (
        <span
          title={`${rules} 条规则把流量送到这里`}
          className={cn(
            'tnum shrink-0 rounded-full px-1.5 text-[11px] font-medium leading-5',
            selected ? 'bg-surface text-ink-2' : 'bg-surface-2 text-ink-3',
          )}
        >
          {rules}
        </span>
      )}
    </UiButton>
  );
}

function SortableRow(props: Parameters<typeof Row>[0]) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.group.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative touch-manipulation', isDragging && 'z-10 rounded-lg bg-surface shadow-md ring-1 ring-line')}
    >
      <Row {...props} />
    </div>
  );
}

function matches(group: ProxyGroup, query: string): boolean {
  const q = query.toLowerCase();
  const haystack = [group.name, group.section, group.filter, group['exclude-filter'], groupTypeMeta(group.type).label, ...(group.proxies ?? [])];
  return haystack.some((value) => value?.toLowerCase().includes(q));
}

export function GroupList() {
  const ws = useWorkspace();
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lastDragEnd = useRef(0);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );

  const buckets = useMemo(() => bucketBySection(ws.groups), [ws.groups]);
  const results = useMemo(() => (query.trim() ? ws.groups.filter((g) => matches(g, query.trim())) : null), [ws.groups, query]);
  const visible = results ?? buckets.flatMap((b) => b.groups);

  const persist = (next: Bucket[]) => {
    reorderGroups(ws.profileId, next.flatMap((b) => b.groups)).catch((error) => notify.error(error, '顺序没有保存'));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    lastDragEnd.current = performance.now();
    if (!over || active.id === over.id) return;
    const bucket = buckets.find((b) => b.groups.some((g) => g.id === active.id));
    if (!bucket || !bucket.groups.some((g) => g.id === over.id)) return;
    const from = bucket.groups.findIndex((g) => g.id === active.id);
    const to = bucket.groups.findIndex((g) => g.id === over.id);
    persist(buckets.map((b) => (b === bucket ? { ...b, groups: arrayMove(b.groups, from, to) } : b)));
  };

  const onNavigate = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (performance.now() - lastDragEnd.current < 250) {
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (hasUnsavedEdits()) {
      event.preventDefault();
      void ws.select(id);
    }
  };

  const focusRow = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-group-id="${id}"]`)?.focus();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const id = (event.target as HTMLElement).closest('[data-group-id]')?.getAttribute('data-group-id');
    if (!id) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    if (event.altKey) {
      if (results) return;
      const bucket = buckets.find((b) => b.groups.some((g) => g.id === id));
      if (!bucket) return;
      const from = bucket.groups.findIndex((g) => g.id === id);
      const to = from + step;
      if (to < 0 || to >= bucket.groups.length) return;
      persist(buckets.map((b) => (b === bucket ? { ...b, groups: arrayMove(b.groups, from, to) } : b)));
      requestAnimationFrame(() => focusRow(id));
      return;
    }
    const index = visible.findIndex((g) => g.id === id);
    const next = visible[index + step];
    if (!next) return;
    void ws.select(next.id).then(() => focusRow(next.id));
  };

  const loading = !ws.book.data && !ws.book.error;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs @3xl/main:max-h-[calc(100dvh-48px)]">
      <div className="flex flex-col gap-2.5 border-b border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-ink">
            全部线路 <span className="tnum ml-0.5 font-normal text-ink-3">{ws.book.data ? ws.groups.length : ''}</span>
          </div>
          <Button size="sm" variant="primary" icon={Plus} onClick={ws.openCreate}>
            新建
          </Button>
        </div>
        <SearchInput aria-label="搜索策略组" value={query} onChange={setQuery} placeholder="搜索名字、正则或成员…" inputSize="sm" />
      </div>

      <DataView
        label="策略组列表"
        summary={`共 ${ws.groups.length} 个策略组${results ? `（匹配 ${results.length} 个）` : ''}`}
        items={visible.map((g) => ({
          value: g.id,
          label: `${g.name} · ${groupTypeMeta(g.type).short} · ${memberSummary(g, ws.summaryCtx)}${ws.ruleCounts[g.name] ? ` · ${ws.ruleCounts[g.name]} 条规则` : ''}${ws.brokenBindings.has(g.id) ? ' · 绑定异常' : ''}`,
        }))}
      >
      <div ref={listRef} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="flex flex-col gap-1 p-1">
            {[...Array(9)].map((_, i) => (
              <div key={i} className="flex items-center gap-2.5 py-2 pl-1">
                <Skeleton className="h-8 w-[3px] rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                  <Skeleton className="h-2.5 w-2/5" />
                </div>
              </div>
            ))}
          </div>
        ) : ws.book.error && !ws.book.data ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <p className="text-xs text-bad">策略组没有加载出来</p>
            <Button size="sm" onClick={() => void ws.book.refetch()}>
              重试
            </Button>
          </div>
        ) : ws.groups.length === 0 ? (
          <EmptyState
            compact
            icon={Waypoints}
            title="还没有策略组"
            description="先建一个手动选择组，再按地区建几个自动测速组。"
          />
        ) : results ? (
          results.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-ink-3">没有匹配「{query.trim()}」的策略组</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {results.map((g) => (
                <Row key={g.id} group={g} selected={g.id === ws.selectedId} onNavigate={onNavigate} />
              ))}
            </div>
          )
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[lockX]}>
            {buckets.map((bucket) => (
              <div key={bucket.section || '__none'} className="flex flex-col gap-0.5 pb-1">
                <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5 text-[11px] font-medium text-ink-3">
                  <span>{bucket.section || '未分组'}</span>
                  <span className="tnum text-ink-4">{bucket.groups.length}</span>
                </div>
                <SortableContext items={bucket.groups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
                  {bucket.groups.map((g) => (
                    <SortableRow key={g.id} group={g} selected={g.id === ws.selectedId} onNavigate={onNavigate} />
                  ))}
                </SortableContext>
              </div>
            ))}
          </DndContext>
        )}
      </div>
      </DataView>

      {ws.groups.length > 1 && !results && (
        <div className="hidden items-center gap-1.5 border-t border-line px-3 py-2 text-[11px] text-ink-3 @3xl/main:flex">
          拖动或 <Kbd>⌥</Kbd>
          <Kbd>↑↓</Kbd> 调整顺序，客户端里按这个顺序显示
        </div>
      )}
    </div>
  );
}
