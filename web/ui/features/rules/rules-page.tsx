'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  Ban,
  ClipboardCopy,
  CircleCheck,
  FlaskConical,
  ListTree,
  MoreHorizontal,
  Plus,
  X,
} from 'lucide-react';
import { useAnchors, useGroups, usePolicies, useRuleSets } from '@/ui/data/hooks';
import { setQueryData } from '@/ui/data/query';
import { keys } from '@/ui/data/hooks';
import type { Rule } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import {
  Button,
  Combobox,
  confirmAction,
  copyText,
  EmptyState,
  Kbd,
  Menu,
  notify,
  SearchInput,
  Select,
  Skeleton,
  Tooltip,
} from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { Page, PageHeader } from '@/ui/shell/page';
import { useScope } from '@/ui/shell/scope';
import { BUILTIN_LABEL, isBuiltinPolicy, LineDot, PolicyChip, useLineColors } from '@/ui/viz/lines';
import { RuleComposer, usePolicyOptions, type ComposerHandle } from './composer';
import { isActiveMatch, RULE_TYPES, ruleText, sectionize, type AnchorSection } from './rule-model';
import { RouteTester } from './route-tester';
import { RuleRow } from './rule-row';
import { RuleSheet } from './rule-sheet';
import { afterRuleWrite, fetchRuleBook, patchBookLocally, ruleApi, useRuleBook, type RuleBook } from './use-rule-book';

const DND_A11Y = {
  screenReaderInstructions: {
    draggable: '按空格键拿起规则，用上下方向键移动，再按空格键放下；按 Esc 取消。',
  },
  announcements: {
    onDragStart: () => '已拿起规则。',
    onDragOver: ({ over }: { over: { id: string | number } | null }) => (over ? '移动到新位置。' : '不在可放置的位置。'),
    onDragEnd: ({ over }: { over: { id: string | number } | null }) => (over ? '已放下规则。' : '已取消。'),
    onDragCancel: () => '已取消拖动。',
  },
};

function computeRank(prev: Rule | undefined, next: Rule | undefined): number | null {
  if (prev && next) return next.rank - prev.rank >= 2 ? Math.floor((prev.rank + next.rank) / 2) : null;
  if (prev) return prev.rank + 10;
  if (next) return next.rank - 10;
  return 10;
}

export function RulesPage() {
  const { profile, profileId } = useScope();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const book = useRuleBook(profileId);
  const anchors = useAnchors(profileId);
  const policies = usePolicies(profileId);
  const ruleSets = useRuleSets(profileId);
  const groups = useGroups(profileId);
  const { color } = useLineColors();
  const policyOptions = usePolicyOptions(policies.data);
  const composerRef = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const policyFilter = searchParams.get('policy') ?? '';
  const typeFilter = searchParams.get('type') ?? '';
  const statusFilter = searchParams.get('status') ?? '';
  const urlQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastPicked = useRef<string | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [testerOpen, setTesterOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Debounce the search box into the URL.
  useEffect(() => {
    if (query === urlQuery) return;
    const timer = window.setTimeout(() => setParams({ q: query.trim() || null }), 220);
    return () => window.clearTimeout(timer);
  }, [query, urlQuery, setParams]);

  useEffect(() => {
    if (searchParams.get('compose') === '1') {
      composerRef.current?.focus();
      setParams({ compose: null });
    }
  }, [searchParams, setParams]);

  useHotkey('/', () => searchRef.current?.querySelector('input')?.focus());
  useHotkey('n', () => composerRef.current?.focus());
  useHotkey('escape', () => setSelected(new Set()), { enabled: selected.size > 0, allowInInput: false });

  const rules = useMemo(() => book.data?.rules ?? [], [book.data]);
  const anchorList = useMemo(() => {
    if (anchors.data) return anchors.data;
    return [...new Set(rules.map((r) => r.anchor))];
  }, [anchors.data, rules]);

  /* evaluation order + positions (unfiltered) */
  const ordered = useMemo(() => sectionize(rules, anchorList), [rules, anchorList]);
  const { positions, enabledOrdered } = useMemo(() => {
    const map = new Map<string, number>();
    const list: Rule[] = [];
    for (const section of ordered) {
      if (!section.known) continue;
      for (const rule of section.rules) {
        if (rule.enabled === false) continue;
        list.push(rule);
        map.set(rule.id, list.length);
      }
    }
    return { positions: map, enabledOrdered: list };
  }, [ordered]);
  const terminus = useMemo(() => rules.find((r) => isActiveMatch(r)) ?? null, [rules]);

  /* filters */
  const q = urlQuery.trim().toLowerCase();
  const hasFilters = !!(policyFilter || typeFilter || statusFilter || q);
  const passes = useCallback(
    (rule: Rule) => {
      if (policyFilter && rule.policy !== policyFilter) return false;
      if (typeFilter && rule.type !== typeFilter) return false;
      if (statusFilter === 'off' && rule.enabled !== false) return false;
      if (q) {
        const hay = `${rule.value} ${rule.note ?? ''} ${(rule.options ?? []).join(' ')} ${rule.policy} ${rule.type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    },
    [policyFilter, typeFilter, statusFilter, q],
  );
  const sections: AnchorSection[] = useMemo(
    () =>
      ordered
        .map((section) => ({ ...section, rules: section.rules.filter((r) => r !== terminus && passes(r)) }))
        .filter((section) => section.rules.length > 0 || (!hasFilters && section.known)),
    [ordered, passes, terminus, hasFilters],
  );
  const visibleTerminus = terminus && passes(terminus) ? terminus : null;
  const flatVisible = useMemo(
    () => [...sections.flatMap((s) => s.rules), ...(visibleTerminus ? [visibleTerminus] : [])],
    [sections, visibleTerminus],
  );

  /* policy chips */
  const policyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rule of rules) counts.set(rule.policy, (counts.get(rule.policy) ?? 0) + 1);
    const rank = new Map((groups.data ?? []).map((g) => [g.name, g.rank]));
    return [...counts.entries()].sort((a, b) => {
      const ra = rank.get(a[0]);
      const rb = rank.get(b[0]);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [rules, groups.data]);
  const disabledCount = rules.filter((r) => r.enabled === false).length;
  const typesPresent = useMemo(() => [...new Set(rules.map((r) => r.type))], [rules]);

  /* selection */
  const selecting = selected.size > 0;
  const toggleSelect = useCallback(
    (id: string, shift: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        if (shift && lastPicked.current) {
          const ids = flatVisible.map((r) => r.id);
          const a = ids.indexOf(lastPicked.current);
          const b = ids.indexOf(id);
          if (a >= 0 && b >= 0) {
            for (const rid of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(rid);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastPicked.current = id;
    },
    [flatVisible],
  );

  /* mutations */
  const refetchBook = book.refetch;
  const onToggle = useCallback(
    async (rule: Rule, enabled: boolean) => {
      patchBookLocally(profileId, (list) => list.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
      try {
        await ruleApi.patch(profileId, rule, { enabled });
        afterRuleWrite(profileId);
      } catch (error) {
        notify.error(error, enabled ? '启用失败' : '停用失败');
        void refetchBook();
      }
    },
    [profileId, refetchBook],
  );

  const bookVersion = book.data?.version ?? 0;
  const onMove = useCallback(
    async (rule: Rule, direction: 'up' | 'down') => {
      try {
        await ruleApi.move(profileId, rule.id, direction, bookVersion);
        afterRuleWrite(profileId);
      } catch (error) {
        notify.error(error, '移动失败');
      }
    },
    [profileId, bookVersion],
  );

  const onDelete = useCallback(
    async (rule: Rule) => {
      const ok = await confirmAction({
        title: '删除这条规则？',
        description: `${ruleText(rule)}。可以在操作历史中撤销。`,
        confirmText: '删除',
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await ruleApi.remove(profileId, rule.id);
        notify.success('规则已删除');
        afterRuleWrite(profileId);
      } catch (error) {
        notify.error(error, '删除失败');
      }
    },
    [profileId],
  );

  const onDuplicate = useCallback(
    async (rule: Rule) => {
      try {
        const copy = await ruleApi.create(profileId, {
          anchor: rule.anchor,
          type: rule.type,
          value: rule.type === 'MATCH' ? '' : rule.value,
          policy: rule.policy,
          options: rule.options,
          note: rule.note ? `${rule.note}（副本）` : '副本',
          enabled: false,
        });
        notify.success('已复制为一条停用的规则', '修改后再启用');
        afterRuleWrite(profileId);
        setEditing(copy);
      } catch (error) {
        notify.error(error, '复制失败');
      }
    },
    [profileId],
  );

  const placeRule = useCallback(
    async (list: Rule[], index: number, anchor: string) => {
      const rule = list[index];
      let rank = computeRank(list[index - 1], list[index + 1]);
      let target = rule;
      if (rank === null) {
        try {
          await ruleApi.normalize(profileId, anchor);
          const fresh: RuleBook = await fetchRuleBook(profileId);
          setQueryData(keys.scoped(profileId, 'rule-book'), fresh);
          const byId = new Map(fresh.rules.map((r) => [r.id, r]));
          const prev = list[index - 1] ? byId.get(list[index - 1].id) : undefined;
          const next = list[index + 1] ? byId.get(list[index + 1].id) : undefined;
          target = byId.get(rule.id) ?? rule;
          rank = computeRank(prev, next);
        } catch (error) {
          notify.error(error, '整理排序失败');
          return;
        }
      }
      if (rank === null) return;
      const finalRank = rank;
      patchBookLocally(profileId, (rs) => rs.map((r) => (r.id === rule.id ? { ...r, rank: finalRank } : r)));
      try {
        await ruleApi.patch(profileId, target, { rank: finalRank });
        afterRuleWrite(profileId);
      } catch (error) {
        notify.error(error, '调整顺序失败');
        void refetchBook();
      }
    },
    [profileId, refetchBook],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const section = sections.find((s) => s.rules.some((r) => r.id === active.id));
    if (!section || !section.rules.some((r) => r.id === over.id)) {
      notify.info('只能在同一个锚点内拖动', '要换锚点，请打开规则修改「插入位置」');
      return;
    }
    const from = section.rules.findIndex((r) => r.id === active.id);
    const to = section.rules.findIndex((r) => r.id === over.id);
    const moved = arrayMove(section.rules, from, to);
    void placeRule(moved, moved.findIndex((r) => r.id === active.id), section.anchor);
  };

  const runBatch = async (
    label: string,
    build: (rule: Rule) => Parameters<typeof ruleApi.batch>[1][number],
  ) => {
    const targets = rules.filter((r) => selected.has(r.id));
    if (!targets.length) return;
    setBatchBusy(true);
    try {
      const results = await ruleApi.batch(profileId, targets.map(build));
      const failed = results.filter((r) => r.status >= 400);
      if (failed.length) notify.warn(`${results.length - failed.length} 条成功，${failed.length} 条失败`, failed[0].error?.detail ?? failed[0].error?.title);
      else notify.success(`已${label} ${results.length} 条规则`);
      setSelected(new Set());
      afterRuleWrite(profileId);
    } catch (error) {
      notify.error(error, `批量${label}失败`);
    } finally {
      setBatchBusy(false);
    }
  };

  const reveal = useCallback(
    (ruleId: string) => {
      if (hasFilters) {
        setQuery('');
        setParams({ policy: null, type: null, status: null, q: null });
      }
      setFlash(ruleId);
      // The row may not exist yet (right after creating it) — wait for it to render.
      let tries = 0;
      const seek = () => {
        const el = document.getElementById(`rule-${ruleId}`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        else if (tries++ < 30) window.setTimeout(seek, 100);
      };
      window.setTimeout(seek, 60);
      window.setTimeout(() => setFlash((current) => (current === ruleId ? null : current)), 3200);
    },
    [hasFilters, setParams],
  );

  const copyAll = async () => {
    const text = enabledOrdered.map((r) => `- ${ruleText(r)}`).join('\n');
    if (await copyText(text)) notify.success(`已复制 ${enabledOrdered.length} 条生效规则`, '按最终配置中的顺序');
  };

  const normalizeAll = async () => {
    try {
      await ruleApi.normalize(profileId);
      notify.success('已整理排序', '顺序不变，序号重新按 10 递增');
      afterRuleWrite(profileId);
    } catch (error) {
      notify.error(error, '整理失败');
    }
  };

  const loading = book.isLoading;
  const total = rules.length;
  const draggable = !hasFilters && !selecting;

  return (
    <Page width="wide">
      <PageHeader
        title="规则"
        documentTitle={`规则 · ${profile.display_name || profile.name}`}
        description={
          <>
            从上往下逐条匹配，<span className="text-ink">第一条命中的规则决定流量走哪条线路</span>；都没命中时走底部的兜底规则。
          </>
        }
        actions={
          <>
            <Button icon={FlaskConical} variant={testerOpen ? 'subtle' : 'secondary'} onClick={() => setTesterOpen((v) => !v)}>
              路由测试
            </Button>
            <Menu
              trigger={<Button iconOnly icon={MoreHorizontal} aria-label="更多" />}
              items={[
                { label: '复制全部生效规则', icon: ClipboardCopy, onSelect: () => void copyAll() },
                { label: '整理排序序号', icon: ArrowDownWideNarrow, onSelect: () => void normalizeAll() },
              ]}
            />
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <RuleComposer
          ref={composerRef}
          profileId={profileId}
          anchors={anchorList}
          policies={policies.data}
          ruleSets={ruleSets.data}
          rules={rules}
          onCreated={(rule) => reveal(rule.id)}
        />

        <AnimatePresence initial={false}>
          {testerOpen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <RouteTester ordered={enabledOrdered} ruleSets={ruleSets.data} onReveal={reveal} onClose={() => setTesterOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* filter bar */}
        <div className="sticky top-0 z-20 -mx-2 flex flex-col gap-2 bg-panel/92 px-2 py-2 backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-2">
            <div ref={searchRef} className="w-full sm:w-[260px]">
              <SearchInput value={query} onChange={setQuery} placeholder="搜索内容、备注、去向…" shortcut={<Kbd>/</Kbd>} />
            </div>
            <div className="w-[150px]">
              <Select
                value={typeFilter || 'all'}
                onValueChange={(v) => setParams({ type: v === 'all' ? null : v })}
                options={[
                  { value: 'all', label: '全部类型' },
                  ...typesPresent.map((t) => ({ value: t, label: RULE_TYPES[t].label, description: t })),
                ]}
              />
            </div>
            {hasFilters && (
              <Button
                size="sm"
                variant="ghost"
                icon={X}
                onClick={() => {
                  setQuery('');
                  setParams({ policy: null, type: null, status: null, q: null });
                }}
              >
                清除筛选
              </Button>
            )}
            <span className="ml-auto text-xs text-ink-3">
              {loading ? '载入中…' : hasFilters ? `显示 ${flatVisible.length} / ${total} 条` : `${total} 条 · ${enabledOrdered.length} 条生效`}
            </span>
          </div>
          <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [mask-image:linear-gradient(to_right,#000_calc(100%-32px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <FilterChip active={!policyFilter && statusFilter !== 'off'} onClick={() => setParams({ policy: null, status: null })}>
              全部 <span className="tnum text-ink-3">{total}</span>
            </FilterChip>
            {policyCounts.map(([policy, count]) => (
              <FilterChip key={policy} active={policyFilter === policy} onClick={() => setParams({ policy: policyFilter === policy ? null : policy, status: null })}>
                <LineDot color={color(policy)} size={8} hollow={isBuiltinPolicy(policy)} />
                {policy}
                <span className="tnum text-ink-3">{count}</span>
              </FilterChip>
            ))}
            {disabledCount > 0 && (
              <FilterChip active={statusFilter === 'off'} onClick={() => setParams({ status: statusFilter === 'off' ? null : 'off', policy: null })}>
                <Ban size={11} className="text-ink-3" />
                已停用 <span className="tnum text-ink-3">{disabledCount}</span>
              </FilterChip>
            )}
          </div>
        </div>

        {/* the line */}
        {loading ? (
          <div className="flex flex-col gap-2 pl-8">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-9" style={{ width: `${96 - (i % 3) * 8}%` }} />
            ))}
          </div>
        ) : total === 0 ? (
          <EmptyState
            icon={ListTree}
            title="还没有规则"
            description="在上面的输入框里粘贴一个域名、网址或 IP 段，选好去向，回车就能添加第一条规则。"
          />
        ) : flatVisible.length === 0 ? (
          <EmptyState
            compact
            icon={ListTree}
            title="没有符合筛选的规则"
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setQuery('');
                  setParams({ policy: null, type: null, status: null, q: null });
                }}
              >
                清除筛选
              </Button>
            }
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={DND_A11Y}>
            <div className="flex flex-col gap-5">
              {sections.map((section) => (
                <section key={section.anchor} aria-label={`锚点 ${section.anchor}`}>
                  <SectionHeader section={section} total={ordered.find((s) => s.anchor === section.anchor)?.rules.length ?? 0} />
                  {section.rules.length === 0 ? (
                    <p className="ml-8 rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-3">这个锚点下还没有规则</p>
                  ) : (
                    <SortableContext items={section.rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                      <ol>
                        {section.rules.map((rule, index) => {
                          const sectionIndex = section.rules.indexOf(rule);
                          return (
                            <RuleRow
                              key={rule.id}
                              rule={rule}
                              position={section.known ? (positions.get(rule.id) ?? null) : null}
                              color={color(rule.policy)}
                              first={index === 0}
                              last={index === section.rules.length - 1}
                              selected={selected.has(rule.id)}
                              selecting={selecting}
                              flash={flash === rule.id}
                              draggable={draggable && section.known}
                              canMoveUp={sectionIndex > 0}
                              canMoveDown={sectionIndex < section.rules.length - 1}
                              onSelect={toggleSelect}
                              onOpen={setEditing}
                              onToggle={onToggle}
                              onMove={onMove}
                              onDelete={onDelete}
                              onDuplicate={onDuplicate}
                            />
                          );
                        })}
                      </ol>
                    </SortableContext>
                  )}
                </section>
              ))}
              {visibleTerminus ? (
                <Terminus rule={visibleTerminus} color={color(visibleTerminus.policy)} position={positions.get(visibleTerminus.id) ?? null} onOpen={setEditing} flash={flash === visibleTerminus.id} />
              ) : !hasFilters && !terminus ? (
                <div className="ml-8 flex items-center gap-2 rounded-lg border border-dashed border-warn/40 bg-warn-soft/50 px-3 py-2.5 text-xs text-ink-2">
                  <AlertTriangle size={14} className="text-warn" />
                  没有兜底规则：前面都没命中的流量会按 Mihomo 默认直连。在类型里选「兜底」即可添加。
                </div>
              ) : null}
            </div>
          </DndContext>
        )}
      </div>

      {/* batch bar */}
      <AnimatePresence>
        {selecting && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="pointer-events-none sticky bottom-4 z-30 mt-6 flex justify-center"
          >
            <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface p-1.5 pl-4 shadow-lg">
              <span className="mr-2 text-[13px] text-ink-2">
                已选 <span className="tnum font-semibold text-ink">{selected.size}</span> 条
              </span>
              <Button size="sm" variant="ghost" icon={CircleCheck} loading={batchBusy} onClick={() => void runBatch('启用', (r) => ({ op: 'update', id: r.id, patch: { enabled: true } }))}>
                启用
              </Button>
              <Button size="sm" variant="ghost" icon={Ban} loading={batchBusy} onClick={() => void runBatch('停用', (r) => ({ op: 'update', id: r.id, patch: { enabled: false } }))}>
                停用
              </Button>
              <Combobox
                value={null}
                onChange={(policy) => void runBatch(`改为「${policy}」`, (r) => ({ op: 'update', id: r.id, patch: { policy } }))}
                options={policyOptions}
                placeholder="改去向"
                align="center"
                trigger={
                  <Button size="sm" variant="ghost" icon={Plus}>
                    改去向…
                  </Button>
                }
              />
              <Button
                size="sm"
                variant="danger-ghost"
                loading={batchBusy}
                onClick={async () => {
                  const ok = await confirmAction({
                    title: `删除 ${selected.size} 条规则？`,
                    description: '可以在操作历史中逐条撤销。',
                    confirmText: '删除',
                    tone: 'danger',
                  });
                  if (ok) void runBatch('删除', (r) => ({ op: 'delete', id: r.id }));
                }}
              >
                删除
              </Button>
              <Tooltip content="取消选择" shortcut="Esc">
                <Button size="sm" variant="ghost" iconOnly icon={X} aria-label="取消选择" onClick={() => setSelected(new Set())} />
              </Tooltip>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <RuleSheet
        rule={editing}
        onClose={() => setEditing(null)}
        profileId={profileId}
        anchors={anchorList}
        policies={policies.data}
        ruleSets={ruleSets.data}
        hasOtherActiveMatch={!!terminus && terminus.id !== editing?.id}
      />
    </Page>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-colors',
        active ? 'border-ink bg-ink text-panel [&_.text-ink-3]:text-panel/60' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function SectionHeader({ section, total }: { section: AnchorSection; total: number }) {
  return (
    <div className="mb-1 flex items-center gap-2 pl-[3px]">
      <span className="flex size-[22px] items-center justify-center rounded-md border border-line bg-surface text-ink-3 shadow-xs">
        <ListTree size={12} />
      </span>
      <span className="font-mono text-[12px] font-semibold text-ink">{section.anchor}</span>
      <span className="text-[11px] text-ink-3">锚点 · {total} 条</span>
      {!section.known && (
        <span className="flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">
          <AlertTriangle size={11} />
          基础配置里没有这个锚点，这些规则不会生效
        </span>
      )}
    </div>
  );
}

function Terminus({
  rule,
  color,
  position,
  onOpen,
  flash,
}: {
  rule: Rule;
  color: string;
  position: number | null;
  onOpen: (rule: Rule) => void;
  flash: boolean;
}) {
  return (
    <div id={`rule-${rule.id}`} className="grid grid-cols-[28px_minmax(0,1fr)] items-center">
      <div className="flex justify-center" aria-hidden>
        <span className="relative flex size-[18px] items-center justify-center rounded-full bg-panel" style={{ boxShadow: `inset 0 0 0 3px ${color}` }}>
          <span className="size-[6px] rounded-full" style={{ background: color }} />
        </span>
      </div>
      <button
        type="button"
        onClick={() => onOpen(rule)}
        className={cn(
          'flex min-h-12 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-left shadow-xs transition hover:border-line-strong hover:shadow-sm',
          flash && 'animate-[pulse-flash_1.6s_ease-out]',
        )}
      >
        <span className="tnum font-mono text-[11px] text-ink-4">{position ?? '—'}</span>
        <span className="flex flex-col">
          <span className="text-[13px] font-semibold text-ink">终点 · 兜底</span>
          <span className="text-[11px] text-ink-3">前面的规则都没命中时，流量走这里</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[11px] text-ink-3">MATCH</span>
          <span className="text-ink-4">→</span>
          <PolicyChip policy={rule.policy} />
          {isBuiltinPolicy(rule.policy) && <span className="text-xs text-ink-3">{BUILTIN_LABEL[rule.policy]}</span>}
        </span>
      </button>
    </div>
  );
}
