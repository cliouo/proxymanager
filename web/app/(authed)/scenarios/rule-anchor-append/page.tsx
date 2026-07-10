'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import styles from './rules.module.css';

interface Rule {
  id: string;
  anchor: string;
  type: string;
  value: string;
  policy: string;
  rank: number;
  source: 'manual' | 'speedtest' | 'import';
  added_at: number;
  updated_at: number;
  note?: string;
  options?: string[];
  enabled?: boolean;
}

const TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'RULE-SET',
  'GEOIP',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-ASN',
  'SRC-IP-CIDR',
  'DST-PORT',
  'SRC-PORT',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'NETWORK',
  'MATCH',
];

/** Subset surfaced as quick chips (prototype parity); full list still in the form. */
const TYPE_CHIPS = ['DOMAIN-SUFFIX', 'IP-CIDR', 'RULE-SET'];

/** Types that take no value (rendered as `TYPE,policy`). */
const NO_VALUE_TYPES = new Set(['MATCH']);

const isActive = (r: Rule) => r.enabled !== false;

/** Fields a RuleForm emits; parent maps these to a create/patch body. */
interface RuleFields {
  anchor: string;
  type: string;
  value: string;
  policy: string;
  options: string[];
  note: string;
  enabled: boolean;
}

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  // P3-26: server-reported total, so "共 N 条" is accurate even when only the
  // first `limit=500` rules were loaded.
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [anchors, setAnchors] = useState<string[]>([]);
  const [policies, setPolicies] = useState<string[]>([]);
  const [ruleSets, setRuleSets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [filterAnchor, setFilterAnchor] = useState('');
  const [filterPolicy, setFilterPolicy] = useState('');
  const [filterType, setFilterType] = useState('');
  const [query, setQuery] = useState('');
  const [showDisabled, setShowDisabled] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [r, a, p, rs] = await Promise.all([
        api<{ data: Rule[]; meta?: { total: number } }>('/api/v1/rules?limit=500&sort=rank:asc'),
        api<{ data: string[] }>('/api/v1/anchors').catch(() => ({ data: [] as string[] })),
        api<{ data: string[] }>('/api/v1/policies').catch(() => ({ data: [] as string[] })),
        api<{ data: { name: string }[] }>('/api/v1/rule-sets').catch(() => ({ data: [] as { name: string }[] })),
      ]);
      setRules(r.data);
      setServerTotal(r.meta?.total ?? r.data.length);
      setAnchors(a.data);
      setPolicies(p.data);
      setRuleSets(rs.data.map((s) => s.name));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      if (!showDisabled && !isActive(r)) return false;
      if (filterAnchor && r.anchor !== filterAnchor) return false;
      if (filterPolicy && r.policy !== filterPolicy) return false;
      if (filterType && r.type !== filterType) return false;
      if (q) {
        const hay = `${r.value} ${r.note ?? ''} ${(r.options ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rules, filterAnchor, filterPolicy, filterType, query, showDisabled]);

  /** Filtered rules grouped per anchor, anchors in base.yaml order. */
  const groups = useMemo(() => {
    const order = anchors.length ? anchors : [...new Set(rules.map((r) => r.anchor))];
    const byAnchor = new Map<string, Rule[]>();
    for (const r of filtered) {
      const list = byAnchor.get(r.anchor) ?? [];
      list.push(r);
      byAnchor.set(r.anchor, list);
    }
    const known = order.filter((a) => byAnchor.has(a));
    const extra = [...byAnchor.keys()].filter((a) => !order.includes(a));
    return [...known, ...extra].map((anchor) => ({
      anchor,
      rules: byAnchor.get(anchor)!.sort((a, b) => a.rank - b.rank),
    }));
  }, [filtered, anchors, rules]);

  const counts = useMemo(() => {
    const active = rules.filter(isActive).length;
    return { total: rules.length, active, disabled: rules.length - active };
  }, [rules]);

  /** Per-anchor totals, for the anchor filter chips. */
  const anchorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rules) m.set(r.anchor, (m.get(r.anchor) ?? 0) + 1);
    return m;
  }, [rules]);

  /* ── mutations ──────────────────────────────────────────────── */

  async function onDelete(id: string) {
    if (!confirm('确定删除该规则？')) return;
    setBusy(true);
    try {
      await api(`/api/v1/rules/${id}`, { method: 'DELETE' });
      setRules((prev) => prev.filter((r) => r.id !== id));
      if (editingId === id) setEditingId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPatch(id: string, patch: Partial<Rule>) {
    try {
      const res = await api<{ data: Rule }>(`/api/v1/rules/${id}`, { method: 'PATCH', body: patch });
      setRules((prev) => prev.map((r) => (r.id === id ? res.data : r)));
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
      return false;
    }
  }

  async function onToggle(rule: Rule) {
    await onPatch(rule.id, { enabled: !isActive(rule) });
  }

  /** Swap rank with the rank-adjacent sibling in the same anchor (atomic batch). */
  async function onMove(rule: Rule, dir: 'up' | 'down') {
    // P3-28: reordering while a filter hides siblings would swap against a row
    // the user can't see — refuse and explain rather than silently misorder.
    const hasActiveFilter = !!(
      filterAnchor ||
      filterPolicy ||
      filterType ||
      query.trim() ||
      !showDisabled
    );
    if (hasActiveFilter) {
      setError('筛选/搜索激活时无法用 ↑↓ 排序(会与隐藏的规则错位)。请先清除筛选。');
      return;
    }
    const siblings = rules.filter((r) => r.anchor === rule.anchor).sort((a, b) => a.rank - b.rank);
    const i = siblings.findIndex((r) => r.id === rule.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return;
    const other = siblings[j];
    // P3-28: identical ranks make a swap a no-op — give the two rows distinct
    // ranks (rule takes other's slot, other is nudged one step the other way).
    const ranksEqual = other.rank === rule.rank;
    const ruleRank = other.rank;
    const otherRank = ranksEqual ? (dir === 'up' ? other.rank + 1 : other.rank - 1) : rule.rank;
    setBusy(true);
    try {
      await api('/api/v1/rules/batch', {
        method: 'POST',
        body: {
          ops: [
            { op: 'update', id: rule.id, patch: { rank: ruleRank } },
            { op: 'update', id: other.id, patch: { rank: otherRank } },
          ],
        },
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onNormalize(anchor: string) {
    setBusy(true);
    try {
      await api('/api/v1/rules/reorder', { method: 'POST', body: { anchor } });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(f: RuleFields) {
    const body: Record<string, unknown> = {
      anchor: f.anchor,
      type: f.type,
      value: NO_VALUE_TYPES.has(f.type) ? '' : f.value,
      policy: f.policy,
      source: 'manual',
      ...(f.note ? { note: f.note } : {}),
      ...(f.options.length ? { options: f.options } : {}),
      ...(f.enabled ? {} : { enabled: false }),
    };
    await api('/api/v1/rules', { method: 'POST', body });
    await reload();
    setAdding(false);
  }

  async function onEdit(id: string, f: RuleFields) {
    const ok = await onPatch(id, {
      anchor: f.anchor,
      type: f.type,
      value: NO_VALUE_TYPES.has(f.type) ? '' : f.value,
      policy: f.policy,
      options: f.options,
      note: f.note,
      enabled: f.enabled,
    });
    if (ok) setEditingId(null);
  }

  const filtersOn = filterAnchor || filterPolicy || filterType || query || !showDisabled;

  return (
    <>
      {/* —— 页头注入共享 topbar(对齐 v2/rules.html) —— */}
      <PageTopbar>
        <h1>规则</h1>
        <ScopePill />
        {loaded && (
          <span className="crumb num">
            {counts.active} 生效
            {counts.disabled > 0 && ` · ${counts.disabled} 停用`}
            {` · ${groups.length} 个锚点`}
          </span>
        )}
        <div className="grow" />
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setAdding((v) => !v);
            setEditingId(null);
          }}
        >
          {adding ? '取消' : '＋ 新增规则'}
        </button>
      </PageTopbar>

      <div className={styles.ruleToolbar}>
        <div className={styles.chipStrip}>
          <span className={styles.chipLabel}>锚点</span>
          {anchors.map((a) => (
            <button
              key={a}
              type="button"
              className={`chip${filterAnchor === a ? ' on' : ''}`}
              onClick={() => setFilterAnchor((v) => (v === a ? '' : a))}
            >
              {a} · {anchorCounts.get(a) ?? 0}
            </button>
          ))}
          <span style={{ width: 10 }} />
          <span className={styles.chipLabel}>类型</span>
          {TYPE_CHIPS.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip${filterType === t ? ' on' : ''}`}
              onClick={() => setFilterType((v) => (v === t ? '' : t))}
            >
              {t}
            </button>
          ))}
        </div>
        <div className={styles.grow} />
        <label className={styles.formCheck} title="筛选策略">
          <select
            className="input"
            value={filterPolicy}
            onChange={(e) => setFilterPolicy(e.target.value)}
            style={{ width: 150 }}
          >
            <option value="">全部策略</option>
            {policies.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className={styles.formCheck}>
          <input
            type="checkbox"
            checked={showDisabled}
            onChange={(e) => setShowDisabled(e.target.checked)}
          />
          显示停用
        </label>
        {filtersOn ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setFilterAnchor('');
              setFilterPolicy('');
              setFilterType('');
              setQuery('');
              setShowDisabled(true);
            }}
          >
            清空筛选
          </button>
        ) : null}
        <div className="search" style={{ width: 240 }}>
          <input
            className="input"
            placeholder="搜索值 / 备注 / 修饰符…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {error ? (
        <div className={styles.errBar}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error}
          </span>
          <button type="button" className={styles.x} onClick={() => setError(null)} aria-label="关闭">
            ✕
          </button>
        </div>
      ) : null}

      {adding ? (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-body">
            <RuleForm
              mode="create"
              anchors={anchors}
              policies={policies}
              ruleSets={ruleSets}
              onSubmit={onCreate}
              onCancel={() => setAdding(false)}
            />
          </div>
        </div>
      ) : null}

      <div className={styles.tblWrap}>
        <table className="tbl" style={{ minWidth: 720 }}>
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: 150 }} />
            <col />
            <col style={{ width: 150 }} />
            <col style={{ width: 78 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 70 }} />
          </colgroup>
          <thead>
            <tr>
              <th>序</th>
              <th>类型</th>
              <th>值 / 修饰符</th>
              <th>策略</th>
              <th>状态</th>
              <th>备注</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!loaded
              ? [0, 1, 2, 3, 4].map((i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={7}>
                      <div
                        className="pm-pulse"
                        style={{
                          height: 14,
                          maxWidth: 560,
                          borderRadius: 4,
                          background: 'var(--surface-3)',
                        }}
                      />
                    </td>
                  </tr>
                ))
              : null}

            {loaded
              ? groups.map(({ anchor, rules: groupRules }) => {
                  const allInAnchor = rules.filter((r) => r.anchor === anchor);
                  const activeN = allInAnchor.filter(isActive).length;
                  return (
                    <GroupBody
                      key={anchor}
                      anchor={anchor}
                      activeN={activeN}
                      totalN={allInAnchor.length}
                      groupRules={groupRules}
                      siblings={allInAnchor.sort((a, b) => a.rank - b.rank)}
                      policies={policies}
                      anchors={anchors}
                      ruleSets={ruleSets}
                      busy={busy}
                      editingId={editingId}
                      onSetEditing={(id) => {
                        setEditingId(id);
                        setAdding(false);
                      }}
                      onMove={onMove}
                      onToggle={onToggle}
                      onPatch={onPatch}
                      onDelete={onDelete}
                      onNormalize={onNormalize}
                      onEdit={onEdit}
                    />
                  );
                })
              : null}

            {loaded && groups.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  {/* P2-16: distinguish "no rules at all" from "filter matched none". */}
                  <div className={styles.empty}>
                    {rules.length === 0
                      ? '还没有任何规则。用上方「新增规则」开始添加。'
                      : '没有匹配当前筛选条件的规则。'}
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className={styles.foot}>
        {/* P3-26: show the true server total; flag when only the first 500 loaded. */}
        {serverTotal !== null && serverTotal > rules.length
          ? `已加载 ${rules.length} / 共 ${serverTotal} 条`
          : `共 ${serverTotal ?? counts.total} 条`}{' '}
        · {groups.length} 个锚点 · 点「编辑」修改规则，↑↓ 在同锚点内调整顺序
      </div>
    </>
  );
}

/* ── group body (header row + rule rows + inline editor) ─────────── */

function GroupBody({
  anchor,
  activeN,
  totalN,
  groupRules,
  siblings,
  policies,
  anchors,
  ruleSets,
  busy,
  editingId,
  onSetEditing,
  onMove,
  onToggle,
  onPatch,
  onDelete,
  onNormalize,
  onEdit,
}: {
  anchor: string;
  activeN: number;
  totalN: number;
  groupRules: Rule[];
  siblings: Rule[];
  policies: string[];
  anchors: string[];
  ruleSets: string[];
  busy: boolean;
  editingId: string | null;
  onSetEditing: (id: string | null) => void;
  onMove: (rule: Rule, dir: 'up' | 'down') => void;
  onToggle: (rule: Rule) => void;
  onPatch: (id: string, patch: Partial<Rule>) => Promise<boolean>;
  onDelete: (id: string) => void;
  onNormalize: (anchor: string) => void;
  onEdit: (id: string, f: RuleFields) => Promise<void>;
}) {
  return (
    <>
      <tr className={styles.groupHead}>
        <td colSpan={7}>
          <div className={styles.inner}>
            <span className={styles.anchorChip}>{anchor}</span>
            <span className={styles.gmeta}>
              {activeN} 生效{totalN > activeN ? ` · ${totalN - activeN} 停用` : ''}
            </span>
            <button
              type="button"
              className={styles.normalizeBtn}
              onClick={() => onNormalize(anchor)}
              disabled={busy}
              title="把本锚点内的排序号重排为 10,20,30…"
            >
              整理排序
            </button>
          </div>
        </td>
      </tr>

      {groupRules.map((r) => {
        const i = siblings.findIndex((s) => s.id === r.id);
        const active = isActive(r);
        const editing = editingId === r.id;
        return (
          <FragmentRow key={r.id}>
            <tr className={`${styles.ruleRow}${active ? '' : ` ${styles.disabled}`}`}>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button
                  type="button"
                  className={styles.move}
                  onClick={() => onMove(r, 'up')}
                  disabled={busy || i <= 0}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.move}
                  onClick={() => onMove(r, 'down')}
                  disabled={busy || i < 0 || i >= siblings.length - 1}
                  title="下移"
                >
                  ↓
                </button>
              </td>
              <td className={styles.typeCell} title={r.type}>
                {r.type}
              </td>
              <td className={styles.val}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.value}
                  >
                    {r.value || <span style={{ color: 'var(--faint)' }}>—</span>}
                  </span>
                  {(r.options ?? []).map((o) => (
                    <span key={o} className={styles.opt}>
                      {o}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <select
                  className="input mono"
                  value={r.policy}
                  onChange={(e) => onPatch(r.id, { policy: e.target.value })}
                  // P3-29: while the inline editor is open, its form owns these
                  // fields — disable the row's live controls so the two can't
                  // diverge (row patch vs unsaved form draft).
                  disabled={editing}
                  style={{ height: 26, fontSize: 11.5 }}
                >
                  {policies.includes(r.policy) ? null : <option>{r.policy}</option>}
                  {policies.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </td>
              <td>
                <button
                  type="button"
                  className={`${styles.stateBtn} ${active ? styles.on : styles.off}`}
                  onClick={() => onToggle(r)}
                  disabled={editing}
                  title={editing ? '编辑中,请用下方表单' : active ? '点击停用' : '点击启用'}
                >
                  {active ? '生效' : '停用'}
                </button>
              </td>
              <td style={{ color: 'var(--muted)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.note}>
                {r.note || ''}
              </td>
              <td>
                <div className={styles.rowAct}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onSetEditing(editing ? null : r.id)}
                  >
                    {editing ? '收起' : '编辑'}
                  </button>
                  <button
                    type="button"
                    className={`btn ghost sm danger ${styles.rowDel}`}
                    onClick={() => onDelete(r.id)}
                    disabled={busy}
                    title="删除"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
            {editing ? (
              <tr className={styles.editRow}>
                <td colSpan={7}>
                  <RuleForm
                    mode="edit"
                    anchors={anchors}
                    policies={policies}
                    ruleSets={ruleSets}
                    initial={r}
                    onSubmit={(f) => onEdit(r.id, f)}
                    onCancel={() => onSetEditing(null)}
                  />
                </td>
              </tr>
            ) : null}
          </FragmentRow>
        );
      })}
    </>
  );
}

// React fragment that can hold multiple <tr> with a key.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/* ── shared add/edit form ────────────────────────────────────────── */

function RuleForm({
  mode,
  anchors,
  policies,
  ruleSets,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  anchors: string[];
  policies: string[];
  ruleSets: string[];
  initial?: Rule;
  onSubmit: (fields: RuleFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [anchor, setAnchor] = useState(initial?.anchor ?? anchors[0] ?? '');
  const [type, setType] = useState(initial?.type ?? 'DOMAIN-SUFFIX');
  const [value, setValue] = useState(initial?.value ?? '');
  const [policy, setPolicy] = useState(initial?.policy ?? policies[0] ?? '');
  const [optionsStr, setOptionsStr] = useState((initial?.options ?? []).join(', '));
  const [note, setNote] = useState(initial?.note ?? '');
  const [enabled, setEnabled] = useState(initial ? initial.enabled !== false : true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initial && anchors.length && !anchor) setAnchor(anchors[0]);
    if (!initial && policies.length && !policy) setPolicy(policies[0]);
  }, [anchors, policies, anchor, policy, initial]);

  const noValue = NO_VALUE_TYPES.has(type);
  const isRuleSet = type === 'RULE-SET';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!noValue && !value.trim()) {
      setError('该类型需要填写值');
      return;
    }
    setPending(true);
    try {
      await onSubmit({
        anchor,
        type,
        value: value.trim(),
        policy,
        options: optionsStr
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        note: note.trim(),
        enabled,
      });
      if (mode === 'create') {
        setValue('');
        setOptionsStr('');
        setNote('');
      }
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className={styles.formBar}>
      <select className="input mono" value={anchor} onChange={(e) => setAnchor(e.target.value)} style={{ width: 110 }}>
        {anchors.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </select>
      <select className="input mono" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 150 }}>
        {TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      {isRuleSet ? (
        <select
          className="input mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
          title="引用规则集库中的条目（被引用的会注入到 rule-providers）"
        >
          <option value="">
            {ruleSets.length ? '选择规则集…' : '（暂无规则集，请先到「规则集」页创建）'}
          </option>
          {value && !ruleSets.includes(value) ? <option value={value}>{value}（库中不存在）</option> : null}
          {ruleSets.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input mono"
          placeholder={noValue ? '（此类型无需值）' : '值（如 emby.media）'}
          value={noValue ? '' : value}
          onChange={(e) => setValue(e.target.value)}
          disabled={noValue}
          style={{ flex: 1, minWidth: 160 }}
          autoFocus={mode === 'create'}
        />
      )}
      <select className="input mono" value={policy} onChange={(e) => setPolicy(e.target.value)} style={{ width: 130 }}>
        {policy && !policies.includes(policy) ? <option>{policy}</option> : null}
        {policies.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <input
        className="input mono"
        placeholder="修饰符 no-resolve"
        value={optionsStr}
        onChange={(e) => setOptionsStr(e.target.value)}
        style={{ width: 130 }}
        title="逗号/空格分隔，如 no-resolve"
      />
      <input
        className="input"
        placeholder="备注"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ width: 120 }}
      />
      <label className={styles.formCheck}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用
      </label>
      <button type="submit" className="btn primary sm" disabled={pending}>
        {pending ? '…' : mode === 'create' ? '添加' : '保存'}
      </button>
      <button type="button" className="btn ghost sm" onClick={onCancel}>
        取消
      </button>
      {error ? <p className={styles.formErr}>{error}</p> : null}
    </form>
  );
}
