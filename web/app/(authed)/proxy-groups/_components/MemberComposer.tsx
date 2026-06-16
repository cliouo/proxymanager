'use client';

import { useMemo, useState } from 'react';
import { type ProxyGroup, frontPoolGroupNames } from '@/schemas';
import { BUILTINS, REGIONS, type SubscriptionLite } from '../_lib/model';
import {
  buildGroupGraph,
  groupNodesBySub,
  matchFilter,
  wouldCycle,
  type NodesBySub,
  type SubBucket,
} from '../_lib/useAvailableMembers';
import styles from '../proxyGroups.module.css';

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
  autoActive: boolean;
  onRegionFill?: (filter: string, nameSuggestion: string) => void;
  nodeNames: string[];
  nodesBySub: NodesBySub;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
    <div>
      <div className={styles.refHead} style={{ marginTop: 0 }}>
        自动纳入 · include-all-proxies + filter
      </div>

      <div className="field" style={{ marginBottom: 12 }}>
        <label>include-all-proxies</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34 }}>
          <button
            type="button"
            className="switch"
            aria-pressed={includeAllProxies}
            onClick={() => onIncludeAllProxies(!includeAllProxies)}
          />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            以全部已解析节点为筛选基底(打开后 filter 在全部节点里筛)
          </span>
        </div>
      </div>

      <div className={styles.formGrid}>
        <div className="field">
          <label>
            filter <span style={{ color: 'var(--faint)', fontWeight: 400 }}>正则,命中即纳入</span>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
              placeholder="如 香港|HK"
              spellCheck={false}
            />
            <RegionQuickFill onPick={(r) => onRegionFill?.(r.filter, r.nameSuggestion)} />
          </div>
        </div>
        <div className="field">
          <label>
            exclude-filter{' '}
            <span style={{ color: 'var(--faint)', fontWeight: 400 }}>正则,命中即排除</span>
          </label>
          <input
            className="input mono"
            value={excludeFilter}
            onChange={(e) => onExcludeFilter(e.target.value)}
            placeholder="如 到期|流量"
            spellCheck={false}
          />
        </div>
      </div>

      <div className={styles.rePreview}>
        {match.error ? (
          <div
            className="count"
            style={{ color: 'var(--danger)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}
          >
            正则错误:{match.error}
          </div>
        ) : previewError ? (
          <div
            className="count"
            style={{ color: 'var(--warn)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}
          >
            节点列表暂不可用,命中数无法计算;可照常保存,filter 渲染时生效。
          </div>
        ) : !autoActive ? (
          <div
            className="count"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}
          >
            未开启 include-all-proxies — filter 只会作用于手选 / use 引入的成员。
          </div>
        ) : !filter.trim() ? (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>
            纳入全部 <b style={{ color: 'var(--accent)' }}>{nodeNames.length}</b> 个节点(未设
            filter)。
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn ghost sm"
              style={{ paddingLeft: 0 }}
              onClick={() => setListOpen((v) => !v)}
            >
              实时预览:命中 <b style={{ color: 'var(--accent)' }}>{match.matched.length}</b> /{' '}
              {nodeNames.length} 个节点 {listOpen ? '收起 ▴' : '展开 ▾'}
            </button>
            {listOpen && (
              <div className={styles.nodeBox} style={{ marginTop: 8 }}>
                {match.matched.length === 0 ? (
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>无匹配节点</span>
                ) : (
                  match.matched.map((n) => (
                    <span key={n} className="mem in" style={{ cursor: 'default' }}>
                      {n}
                    </span>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RegionQuickFill({ onPick }: { onPick: (r: (typeof REGIONS)[number]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.regionWrap}>
      <button type="button" className="btn sm" onClick={() => setOpen((v) => !v)}>
        地区快填 ▾
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setOpen(false)} />
          <div className={styles.regionPop} style={{ zIndex: 20 }}>
            {REGIONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => {
                  onPick(r);
                  setOpen(false);
                }}
              >
                <span>{r.label}</span>
                <span>{r.code}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── 手选成员 ───────────────────────────────────────────────────────── */

/** mem chip modifier classes by member kind. */
function memClass(name: string, groupNames: Set<string>, nodeSet: Set<string>): string {
  if ((BUILTINS as readonly string[]).includes(name)) return 'mem in builtin';
  if (groupNames.has(name)) return 'mem in group';
  if (nodeSet.has(name)) return 'mem in';
  return 'mem in'; // unknown — still a manual pick
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
    <div>
      <div
        className={styles.refHead}
        style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <span>手选成员 · proxies {proxies.length}</span>
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setPickerOpen(true)}
        >
          ＋ 添加成员
        </button>
      </div>

      {proxies.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0' }}>
          (无) 点「＋ 添加成员」从内置 / 节点 / 其他策略组里选——不用手打字。
        </p>
      ) : (
        <div className={styles.memberPool}>
          {proxies.map((name, i) => (
            <span
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
              className={memClass(name, groupNames, nodeSet)}
              style={{ cursor: 'grab' }}
              title="拖动调整顺序"
            >
              {name}
              <button
                type="button"
                onClick={() => remove(name)}
                className="x"
                aria-label={`移除 ${name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {proxies.length > 1 && (
        <div className="hint" style={{ marginTop: 8 }}>
          拖动芯片调整顺序 · 渲染顺序即排列顺序。
        </div>
      )}

      {pickerOpen && (
        <MemberPicker
          selfName={selfName}
          selected={proxies}
          onChange={onProxies}
          groups={groups}
          subs={props.subs}
          nodeNames={nodeNames}
          nodesBySub={props.nodesBySub}
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
  nodesBySub,
  previewError,
  onClose,
}: {
  selfName: string;
  selected: string[];
  onChange: (next: string[]) => void;
  groups: ProxyGroup[];
  subs: SubscriptionLite[];
  nodeNames: string[];
  nodesBySub: NodesBySub;
  previewError: string | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const sel = useMemo(() => new Set(selected), [selected]);

  const graph = useMemo(() => buildGroupGraph(groups), [groups]);
  // Front pools (groups used as a chained-proxy dialer-proxy) are internal
  // plumbing — don't offer them as members. Keep any that are already selected
  // so the user can still see + remove them here.
  const pools = useMemo(() => frontPoolGroupNames(groups), [groups]);
  const otherGroups = useMemo(
    () =>
      groups
        .filter((g) => g.name !== selfName && (!pools.has(g.name) || sel.has(g.name)))
        .map((g) => g.name),
    [groups, selfName, pools, sel],
  );
  const { buckets, unfiled } = useMemo(
    () => groupNodesBySub(nodeNames, subs, nodesBySub),
    [nodeNames, subs, nodesBySub],
  );

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
    <div className={styles.pickerBg}>
      <div className={styles.spacer} onClick={onClose} />
      <div className={styles.picker}>
        <div className={styles.pickerHead}>
          <h3>添加成员到「{selfName || '新策略组'}」</h3>
          <button type="button" className="x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className={styles.pickerSearch}>
          <div className="search">
            <input
              className="input"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索节点 / 策略组…"
            />
          </div>
        </div>

        <div className={styles.pickerBody}>
          {filteredBuiltins.length > 0 && (
            <PickerSection title="内置">
              <div className={styles.memberPool}>
                {filteredBuiltins.map((name) => (
                  <Chip
                    key={name}
                    name={name}
                    selected={sel.has(name)}
                    onClick={() => toggle(name)}
                    builtin
                  />
                ))}
              </div>
            </PickerSection>
          )}

          {filteredGroups.length > 0 && (
            <PickerSection title={`策略组 · ${filteredGroups.length}`}>
              <div className={styles.memberPool}>
                {filteredGroups.map((name) => {
                  const cyclic = wouldCycle(selfName, name, graph);
                  return (
                    <Chip
                      key={name}
                      name={name}
                      selected={sel.has(name)}
                      disabled={cyclic}
                      group
                      title={cyclic ? '会与本组形成循环引用,客户端无法加载' : undefined}
                      onClick={() => toggle(name)}
                    />
                  );
                })}
              </div>
            </PickerSection>
          )}

          {previewError && (
            <p style={{ fontSize: 12, color: 'var(--warn)' }}>
              节点列表来自最近一次预览,现在不可用——可先选内置 /
              策略组,或到「最终配置」重新预览后再回来。
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
              title={`未归类节点 · ${filteredUnfiled.length}`}
              nodes={filteredUnfiled}
              sel={sel}
              toggle={toggle}
              bulk={bulk}
              defaultOpen={!!query}
            />
          )}
        </div>

        <div className={styles.pickerFoot}>
          <span className={styles.sel}>
            已选 {selected.length}
            {selected.length > 0
              ? `:${selected.slice(0, 6).join(' · ')}${selected.length > 6 ? ' …' : ''}`
              : ''}
          </span>
          <button type="button" className="btn primary" onClick={onClose}>
            完成
          </button>
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
  const label = bucket.sub.display_name || bucket.sub.name;
  return (
    <NodeBucketRaw
      title={`节点 · ${label} · ${shown.length}`}
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
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => bulk(nodes, !allSelected)}
          >
            {allSelected ? '全不选' : '全选'}
          </button>
          <button type="button" className={styles.linkBtn} onClick={() => setOpen((v) => !v)}>
            {open ? '收起 ▴' : '展开 ▾'}
          </button>
        </div>
      }
    >
      {open && (
        <div className={styles.memberPool}>
          {nodes.slice(0, 300).map((name) => (
            <Chip key={name} name={name} selected={sel.has(name)} onClick={() => toggle(name)} />
          ))}
          {nodes.length > 300 && (
            <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>
              … 还有 {nodes.length - 300} 个,搜索以缩小范围
            </span>
          )}
        </div>
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
    <section className={styles.pickerSection}>
      <div className={styles.pickerSectionHead}>
        <h4>{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function Chip({
  name,
  selected,
  disabled,
  title,
  group,
  builtin,
  onClick,
}: {
  name: string;
  selected: boolean;
  disabled?: boolean;
  title?: string;
  group?: boolean;
  builtin?: boolean;
  onClick: () => void;
}) {
  const cls = [
    'mem',
    selected && !disabled ? 'in' : '',
    group ? 'group' : '',
    builtin ? 'builtin' : '',
    disabled ? 'dead' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" disabled={disabled} title={title} onClick={onClick} className={cls}>
      {selected && !disabled ? '✓ ' : ''}
      {name}
      {disabled ? ' ⊘' : ''}
    </button>
  );
}
