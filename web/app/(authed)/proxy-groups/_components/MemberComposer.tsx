'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { ProxyGroup } from '@/schemas';
import { BUILTINS, REGIONS, type SubscriptionLite } from '../_lib/model';
import {
  buildGroupGraph,
  groupNodesBySub,
  matchFilter,
  wouldCycle,
  type SubBucket,
} from '../_lib/useAvailableMembers';

/**
 * The member composer — the centrepiece that replaces hand-typed `proxies`.
 * Renders up to two sources:
 *   - 自动纳入 (include-all-proxies + filter) with a live match preview
 *   - 手选成员 (ordered, drag-to-reorder chips) fed by a slide-over picker
 */
export interface MemberComposerProps {
  selfName: string;
  proxies: string[];
  filter: string;
  excludeFilter: string;
  includeAllProxies: boolean;
  onProxies: (next: string[]) => void;
  onFilter: (v: string) => void;
  onExcludeFilter: (v: string) => void;
  onIncludeAllProxies: (v: boolean) => void;
  // True when any include-all flag is set (proxies/providers/all) — gates the
  // live match preview. The checkbox itself toggles include-all-proxies, but a
  // migrated group may carry include-all-providers, and its filter still
  // resolves against the node set, so the count should still show.
  autoActive: boolean;
  // Region quick-fill sets filter AND suggests a name in one atomic update.
  onRegionFill?: (filter: string, nameSuggestion: string) => void;
  nodeNames: string[];
  subs: SubscriptionLite[];
  groups: ProxyGroup[];
  previewError: string | null;
  showAuto: boolean;
  showManual: boolean;
  emphasizeAuto?: boolean;
}

export function MemberComposer(props: MemberComposerProps) {
  const { showAuto, showManual, emphasizeAuto } = props;
  const auto = showAuto ? <AutoIncludeBox {...props} /> : null;
  const manual = showManual ? <ManualPickBox {...props} /> : null;
  return (
    <div className="space-y-4">
      <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
        成员来源
      </h3>
      {emphasizeAuto ? (
        <>
          {auto}
          {manual}
        </>
      ) : (
        <>
          {manual}
          {auto}
        </>
      )}
    </div>
  );
}

/* ─── 自动纳入 ───────────────────────────────────────────────────────── */

function AutoIncludeBox({
  filter,
  excludeFilter,
  includeAllProxies,
  autoActive,
  onFilter,
  onExcludeFilter,
  onIncludeAllProxies,
  onRegionFill,
  nodeNames,
  previewError,
}: MemberComposerProps) {
  const [listOpen, setListOpen] = useState(false);
  const match = useMemo(
    () => matchFilter(nodeNames, filter, excludeFilter),
    [nodeNames, filter, excludeFilter],
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
      <div className="px-4 py-2.5 flex items-baseline gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-sunk)]">
        <span className="text-[13px] font-medium text-[var(--color-fg)]">自动纳入</span>
        <span className="font-mono text-[11px] text-[var(--color-muted)]">
          include-all-proxies + filter
        </span>
      </div>
      <div className="p-4 space-y-3">
        <label className="flex items-center gap-2 text-[13px] cursor-pointer">
          <input
            type="checkbox"
            checked={includeAllProxies}
            onChange={(e) => onIncludeAllProxies(e.target.checked)}
            className="rounded border-[var(--color-border)]"
          />
          <span>纳入全部节点</span>
          <span className="text-[var(--color-muted)] text-[12px]">(打开后,filter 在全部节点里筛)</span>
        </label>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
              placeholder="filter 正则,如 香港|HK"
              className="font-mono text-[12px]"
            />
            <RegionQuickFill onPick={(r) => onRegionFill?.(r.filter, r.nameSuggestion)} />
          </div>
          <Input
            value={excludeFilter}
            onChange={(e) => onExcludeFilter(e.target.value)}
            placeholder="exclude-filter 正则(排除),可留空"
            className="font-mono text-[12px]"
          />
        </div>

        {/* Live preview */}
        {match.error ? (
          <p className="text-[12px] text-[var(--color-danger)]">正则错误:{match.error}</p>
        ) : previewError ? (
          <p className="text-[12px] text-[var(--color-warn)]">
            节点列表暂不可用(上次预览失败),命中数无法计算;可照常保存,filter 会在渲染时生效。
          </p>
        ) : !autoActive ? (
          <p className="text-[12px] text-[var(--color-muted)]">
            未开启「纳入全部节点」——filter 只会作用于手选成员 / use 引入的成员。
          </p>
        ) : !filter.trim() ? (
          <p className="text-[12px] text-[var(--color-fg-soft)]">
            纳入全部 <strong>{nodeNames.length}</strong> 个节点(未设 filter)。
          </p>
        ) : (
          <div className="text-[12px]">
            <button
              type="button"
              onClick={() => setListOpen((v) => !v)}
              className="text-[var(--color-fg-soft)] hover:text-[var(--color-fg)]"
            >
              ✓ 命中{' '}
              <strong className="text-[var(--color-primary-hover)]">{match.matched.length}</strong> 个节点{' '}
              <span className="text-[var(--color-muted)]">{listOpen ? '收起 ▴' : '展开 ▾'}</span>
            </button>
            {listOpen && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 flex flex-wrap gap-1">
                {match.matched.length === 0 ? (
                  <span className="text-[var(--color-muted)]">无匹配节点</span>
                ) : (
                  match.matched.map((n) => (
                    <span
                      key={n}
                      className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-bg-sunk)] text-[var(--color-fg-soft)]"
                    >
                      {n}
                    </span>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RegionQuickFill({ onPick }: { onPick: (r: (typeof REGIONS)[number]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
        地区快填 ▾
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-20 w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1">
            {REGIONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => {
                  onPick(r);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--color-surface-hover)] flex justify-between"
              >
                <span>{r.label}</span>
                <span className="font-mono text-[var(--color-muted)]">{r.code}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── 手选成员 ───────────────────────────────────────────────────────── */

function classify(
  name: string,
  groupNames: Set<string>,
  nodeSet: Set<string>,
): { tone: 'accent' | 'neutral' | 'success' | 'warn'; label: string } {
  if ((BUILTINS as readonly string[]).includes(name)) return { tone: 'success', label: '内置' };
  if (groupNames.has(name)) return { tone: 'accent', label: '策略组' };
  if (nodeSet.has(name)) return { tone: 'neutral', label: '节点' };
  return { tone: 'warn', label: '未知' };
}

function ManualPickBox(props: MemberComposerProps) {
  const { proxies, onProxies, groups, nodeNames, selfName } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const groupNames = useMemo(() => new Set(groups.map((g) => g.name)), [groups]);
  const nodeSet = useMemo(() => new Set(nodeNames), [nodeNames]);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= proxies.length) return;
    const next = [...proxies];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onProxies(next);
  };
  const remove = (name: string) => onProxies(proxies.filter((p) => p !== name));

  return (
    <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-sunk)]">
        <span className="text-[13px] font-medium text-[var(--color-fg)]">手选成员</span>
        <span className="font-mono text-[11px] text-[var(--color-muted)]">proxies · {proxies.length}</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={() => setPickerOpen(true)}
        >
          + 添加成员
        </Button>
      </div>
      <div className="p-3">
        {proxies.length === 0 ? (
          <p className="text-[12px] text-[var(--color-muted)] px-1 py-2">
            (无) 点「+ 添加成员」从内置 / 节点 / 其他策略组里选——不用手打字。
          </p>
        ) : (
          <ul className="space-y-1">
            {proxies.map((name, i) => {
              const c = classify(name, groupNames, nodeSet);
              return (
                <li
                  key={`${name}-${i}`}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== i) {
                      move(dragIndex, i);
                      setDragIndex(i);
                    }
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[13px] cursor-grab active:cursor-grabbing ${
                    dragIndex === i
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]'
                      : 'border-transparent hover:bg-[var(--color-bg-sunk)]'
                  }`}
                >
                  <span className="text-[var(--color-muted)] select-none" aria-hidden>
                    ⠿
                  </span>
                  <span className="font-mono flex-1 truncate">{name}</span>
                  <Badge tone={c.tone}>{c.label}</Badge>
                  <button
                    type="button"
                    onClick={() => remove(name)}
                    className="text-[var(--color-muted)] hover:text-[var(--color-danger)] px-1"
                    aria-label={`移除 ${name}`}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {proxies.length > 1 && (
          <p className="text-[11px] text-[var(--color-muted)] px-1 pt-2">拖动 ⠿ 调整顺序。</p>
        )}
      </div>

      {pickerOpen && (
        <MemberPicker
          selfName={selfName}
          selected={proxies}
          onChange={onProxies}
          groups={groups}
          subs={props.subs}
          nodeNames={nodeNames}
          previewError={props.previewError}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

/* ─── slide-over picker ──────────────────────────────────────────────── */

function MemberPicker({
  selfName,
  selected,
  onChange,
  groups,
  subs,
  nodeNames,
  previewError,
  onClose,
}: {
  selfName: string;
  selected: string[];
  onChange: (next: string[]) => void;
  groups: ProxyGroup[];
  subs: SubscriptionLite[];
  nodeNames: string[];
  previewError: string | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const sel = useMemo(() => new Set(selected), [selected]);

  const graph = useMemo(() => buildGroupGraph(groups), [groups]);
  const otherGroups = useMemo(
    () => groups.filter((g) => g.name !== selfName).map((g) => g.name),
    [groups, selfName],
  );
  const { buckets, unfiled } = useMemo(() => groupNodesBySub(nodeNames, subs), [nodeNames, subs]);

  // Single-update mutators (avoid stale-closure loops on bulk select).
  const toggle = (name: string) =>
    onChange(sel.has(name) ? selected.filter((p) => p !== name) : [...selected, name]);
  const bulk = (names: string[], add: boolean) =>
    onChange(
      add
        ? [...selected, ...names.filter((n) => !sel.has(n))]
        : selected.filter((p) => !names.includes(p)),
    );

  const match = (name: string) => !query || name.toLowerCase().includes(query);
  const filteredBuiltins = (BUILTINS as readonly string[]).filter(match);
  const filteredGroups = otherGroups.filter(match);
  const filteredUnfiled = unfiled.filter(match);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-[440px] max-w-[92vw] h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] flex flex-col shadow-xl">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <h3 className="text-[14px] font-medium text-[var(--color-fg)]">
            添加成员到「{selfName || '新策略组'}」
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-fg)] text-[16px]"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-3 border-b border-[var(--color-border)]">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="🔍 搜索节点 / 策略组 …"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {filteredBuiltins.length > 0 && (
            <PickerSection title="内置">
              <ChipWrap>
                {filteredBuiltins.map((name) => (
                  <Chip key={name} name={name} selected={sel.has(name)} onClick={() => toggle(name)} />
                ))}
              </ChipWrap>
            </PickerSection>
          )}

          {filteredGroups.length > 0 && (
            <PickerSection title={`策略组 (${filteredGroups.length})`}>
              <ChipWrap>
                {filteredGroups.map((name) => {
                  const cyclic = wouldCycle(selfName, name, graph);
                  return (
                    <Chip
                      key={name}
                      name={name}
                      selected={sel.has(name)}
                      disabled={cyclic}
                      title={cyclic ? '会与本组形成循环引用,mihomo 无法加载' : undefined}
                      onClick={() => toggle(name)}
                    />
                  );
                })}
              </ChipWrap>
            </PickerSection>
          )}

          {previewError && (
            <p className="text-[12px] text-[var(--color-warn)]">
              节点列表来自最近一次预览,现在不可用——可先选内置 / 策略组,或到「最终配置」重新预览后再回来。
            </p>
          )}

          {buckets.map((b) => (
            <NodeBucket
              key={b.sub.id}
              bucket={b}
              query={query}
              sel={sel}
              toggle={toggle}
              bulk={bulk}
            />
          ))}

          {filteredUnfiled.length > 0 && (
            <NodeBucketRaw
              title={`未归类节点 (${filteredUnfiled.length})`}
              nodes={filteredUnfiled}
              sel={sel}
              toggle={toggle}
              bulk={bulk}
              defaultOpen={!!query}
            />
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] flex items-center gap-3">
          <span className="text-[12px] text-[var(--color-muted)] flex-1 truncate">
            已选 {selected.length}
            {selected.length > 0
              ? `:${selected.slice(0, 6).join(' · ')}${selected.length > 6 ? ' …' : ''}`
              : ''}
          </span>
          <Button type="button" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}

function NodeBucket({
  bucket,
  query,
  sel,
  toggle,
  bulk,
}: {
  bucket: SubBucket;
  query: string;
  sel: Set<string>;
  toggle: (name: string) => void;
  bulk: (names: string[], add: boolean) => void;
}) {
  const shown = bucket.nodes.filter((n) => !query || n.toLowerCase().includes(query));
  if (shown.length === 0) return null;
  const prefix = bucket.sub.node_prefix?.trim();
  return (
    <NodeBucketRaw
      title={`节点 · ${bucket.sub.name}${prefix ? ` [${prefix}]` : ''} (${shown.length})`}
      nodes={shown}
      sel={sel}
      toggle={toggle}
      bulk={bulk}
      defaultOpen={!!query}
    />
  );
}

function NodeBucketRaw({
  title,
  nodes,
  sel,
  toggle,
  bulk,
  defaultOpen,
}: {
  title: string;
  nodes: string[];
  sel: Set<string>;
  toggle: (name: string) => void;
  bulk: (names: string[], add: boolean) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const allSelected = nodes.every((n) => sel.has(n));
  return (
    <PickerSection
      title={title}
      action={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => bulk(nodes, !allSelected)}
            className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            {allSelected ? '全不选' : '全选'}
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            {open ? '收起 ▴' : '展开 ▾'}
          </button>
        </div>
      }
    >
      {open && (
        <ChipWrap>
          {nodes.slice(0, 300).map((name) => (
            <Chip key={name} name={name} selected={sel.has(name)} onClick={() => toggle(name)} mono />
          ))}
          {nodes.length > 300 && (
            <span className="text-[11px] text-[var(--color-muted)] self-center">
              … 还有 {nodes.length - 300} 个,搜索以缩小范围
            </span>
          )}
        </ChipWrap>
      )}
    </PickerSection>
  );
}

function PickerSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
          {title}
        </h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function ChipWrap({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function Chip({
  name,
  selected,
  disabled,
  title,
  mono,
  onClick,
}: {
  name: string;
  selected: boolean;
  disabled?: boolean;
  title?: string;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`px-2.5 py-1 rounded border text-[12px] transition-colors ${mono ? 'font-mono' : ''} ${
        disabled
          ? 'border-[var(--color-border)] text-[var(--color-muted)] opacity-50 cursor-not-allowed line-through'
          : selected
            ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]'
            : 'border-[var(--color-border)] text-[var(--color-fg-soft)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      {selected ? '✓ ' : ''}
      {name}
    </button>
  );
}
