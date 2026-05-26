'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Placeholder } from '@/components/ui/Reveal';
import { ApiError, api } from '@/lib/client/api';

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
  const [anchors, setAnchors] = useState<string[]>([]);
  const [policies, setPolicies] = useState<string[]>([]);
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
      const [r, a, p] = await Promise.all([
        api<{ data: Rule[] }>('/api/v1/rules?limit=500&sort=rank:asc'),
        api<{ data: string[] }>('/api/v1/anchors').catch(() => ({ data: [] as string[] })),
        api<{ data: string[] }>('/api/v1/policies').catch(() => ({ data: [] as string[] })),
      ]);
      setRules(r.data);
      setAnchors(a.data);
      setPolicies(p.data);
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
    const siblings = rules.filter((r) => r.anchor === rule.anchor).sort((a, b) => a.rank - b.rank);
    const i = siblings.findIndex((r) => r.id === rule.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return;
    const other = siblings[j];
    setBusy(true);
    try {
      await api('/api/v1/rules/batch', {
        method: 'POST',
        body: {
          ops: [
            { op: 'update', id: rule.id, patch: { rank: other.rank } },
            { op: 'update', id: other.id, patch: { rank: rule.rank } },
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
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-[calc(100vh-0px)]">
      <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-6 pt-3 pb-2 flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1
              className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
            >
              规则
            </h1>
            <span className="text-[12px] tabular-nums text-[var(--color-muted)] font-mono">
              {counts.active} 生效
              {counts.disabled > 0 && ` · ${counts.disabled} 停用`}
            </span>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setAdding((v) => !v);
              setEditingId(null);
            }}
          >
            {adding ? '取消' : '+ 新增规则'}
          </Button>
        </div>
        <div className="px-6 pb-3 flex items-center gap-2 flex-wrap">
          <FilterChip>
            <Select
              value={filterAnchor}
              onChange={(e) => setFilterAnchor(e.target.value)}
              className="h-8 text-[12px] !pr-7 border-0 bg-transparent shadow-none focus:ring-0 focus:!border-0 !pl-0"
            >
              <option value="">全部锚点</option>
              {anchors.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </FilterChip>
          <FilterChip>
            <Select
              value={filterPolicy}
              onChange={(e) => setFilterPolicy(e.target.value)}
              className="h-8 text-[12px] !pr-7 border-0 bg-transparent shadow-none focus:ring-0 focus:!border-0 !pl-0"
            >
              <option value="">全部策略</option>
              {policies.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          </FilterChip>
          <FilterChip>
            <Select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="h-8 text-[12px] !pr-7 border-0 bg-transparent shadow-none focus:ring-0 focus:!border-0 !pl-0"
            >
              <option value="">全部类型</option>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </FilterChip>
          <div className="flex-1 min-w-[160px] max-w-[260px]">
            <Input
              placeholder="搜索 value / 备注 / 修饰符…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 text-[12px]"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg-soft)] cursor-pointer select-none px-1">
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
              className="accent-[var(--color-primary)]"
            />
            显示停用
          </label>
          {filtersOn && (
            <button
              type="button"
              onClick={() => {
                setFilterAnchor('');
                setFilterPolicy('');
                setFilterType('');
                setQuery('');
                setShowDisabled(true);
              }}
              className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors px-2 active:scale-[0.96]"
            >
              清空筛选
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="shrink-0 px-6 py-2 text-[12px] bg-[#F4D8D2]/40 text-[var(--color-danger)] border-b border-[var(--color-border)] flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {adding && (
        <div className="shrink-0 px-6 py-3 bg-[var(--color-primary-tint)] border-b border-[var(--color-border)]">
          <RuleForm
            mode="create"
            anchors={anchors}
            policies={policies}
            onSubmit={onCreate}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto bg-[var(--color-surface)]">
        <table className="w-full text-[13px] border-collapse table-fixed">
          <colgroup>
            <col className="w-[64px]" />
            <col className="w-[128px]" />
            <col />
            <col className="w-[150px]" />
            <col className="w-[78px]" />
            <col className="w-[150px]" />
            <col className="w-[64px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[var(--color-bg-sunk)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-muted)] font-semibold">
            <tr>
              <Th className="text-center">序</Th>
              <Th>类型</Th>
              <Th>值 / 修饰符</Th>
              <Th>策略</Th>
              <Th className="text-center">状态</Th>
              <Th>备注</Th>
              <Th className="text-right" />
            </tr>
          </thead>
          <tbody>
            {!loaded &&
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={`sk-${i}`} className="border-b border-[var(--color-border)]">
                  <td colSpan={7} className="px-6 py-2">
                    <Placeholder rows={1} className="max-w-[600px]" />
                  </td>
                </tr>
              ))}

            {loaded &&
              groups.map(({ anchor, rules: groupRules }) => {
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
              })}

            {loaded && groups.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-16 text-center text-[13px] text-[var(--color-muted)]">
                  没有匹配当前筛选条件的规则。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
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
      <tr className="sticky top-[33px] z-[5]">
        <td
          colSpan={7}
          className="px-4 py-1.5 bg-[var(--color-bg-strong)] border-y border-[var(--color-border)]"
        >
          <div className="flex items-center gap-2">
            <Badge tone="accent">{anchor}</Badge>
            <span className="text-[11px] tabular-nums text-[var(--color-muted)] font-mono">
              {activeN} 生效{totalN > activeN ? ` · ${totalN - activeN} 停用` : ''}
            </span>
            <button
              type="button"
              onClick={() => onNormalize(anchor)}
              disabled={busy}
              className="ml-auto text-[11px] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors active:scale-[0.96]"
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
            <tr
              className={`border-b border-[var(--color-border)] hover:bg-[var(--color-bg-sunk)] transition-colors group ${
                active ? '' : 'opacity-55'
              }`}
            >
              <td className="px-1 py-1.5 text-center whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onMove(r, 'up')}
                  disabled={busy || i <= 0}
                  className="text-[var(--color-muted)] hover:text-[var(--color-primary)] disabled:opacity-25 px-0.5 align-middle"
                  title="上移"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => onMove(r, 'down')}
                  disabled={busy || i < 0 || i >= siblings.length - 1}
                  className="text-[var(--color-muted)] hover:text-[var(--color-primary)] disabled:opacity-25 px-0.5 align-middle"
                  title="下移"
                >
                  ↓
                </button>
              </td>
              <td className="px-3 py-1.5 font-mono text-[12px] text-[var(--color-fg-soft)] truncate" title={r.type}>
                {r.type}
              </td>
              <td className="px-3 py-1.5 font-mono text-[12px] text-[var(--color-fg)]">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate" title={r.value}>
                    {r.value || <span className="text-[var(--color-muted)]">—</span>}
                  </span>
                  {(r.options ?? []).map((o) => (
                    <span
                      key={o}
                      className="shrink-0 inline-flex items-center h-4 px-1 rounded bg-[var(--color-bg-strong)] text-[10px] text-[var(--color-plum)] font-mono"
                    >
                      {o}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-3 py-1.5">
                <Select
                  value={r.policy}
                  onChange={(e) => onPatch(r.id, { policy: e.target.value })}
                  className="h-6 text-[11px] !pr-6 min-w-0"
                >
                  {policies.includes(r.policy) ? null : <option>{r.policy}</option>}
                  {policies.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              </td>
              <td className="px-1 py-1.5 text-center">
                <button
                  type="button"
                  onClick={() => onToggle(r)}
                  className={`inline-flex items-center justify-center h-5 px-2 rounded-full text-[10px] font-medium transition-colors active:scale-[0.95] ${
                    active
                      ? 'bg-[#E6EEDD] text-[var(--color-success)]'
                      : 'bg-[var(--color-bg-strong)] text-[var(--color-muted)]'
                  }`}
                  title={active ? '点击停用' : '点击启用'}
                >
                  {active ? '生效' : '停用'}
                </button>
              </td>
              <td className="px-3 py-1.5 text-[11px] text-[var(--color-muted)] truncate" title={r.note}>
                {r.note || ''}
              </td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onSetEditing(editing ? null : r.id)}
                  className="text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors text-[12px] px-1 active:scale-[0.94]"
                  title="编辑"
                >
                  {editing ? '收起' : '编辑'}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(r.id)}
                  disabled={busy}
                  className="text-[var(--color-muted)] hover:text-[var(--color-danger)] transition-colors text-[14px] px-1 active:scale-[0.94] opacity-0 group-hover:opacity-100 focus:opacity-100"
                  title="删除"
                >
                  ✕
                </button>
              </td>
            </tr>
            {editing && (
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-primary-tint)]">
                <td colSpan={7} className="px-6 py-3">
                  <RuleForm
                    mode="edit"
                    anchors={anchors}
                    policies={policies}
                    initial={r}
                    onSubmit={(f) => onEdit(r.id, f)}
                    onCancel={() => onSetEditing(null)}
                  />
                </td>
              </tr>
            )}
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

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 font-semibold border-b border-[var(--color-border)] text-left ${className}`}>
      {children}
    </th>
  );
}

function FilterChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center pl-3 rounded-lg bg-[var(--color-bg-sunk)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-colors">
      {children}
    </div>
  );
}

/* ── shared add/edit form ────────────────────────────────────────── */

function RuleForm({
  mode,
  anchors,
  policies,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  anchors: string[];
  policies: string[];
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
    <form onSubmit={submit} className="flex items-center gap-2 flex-wrap">
      <Select value={anchor} onChange={(e) => setAnchor(e.target.value)} className="h-8 text-[12px] !pr-7 w-[110px]">
        {anchors.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </Select>
      <Select value={type} onChange={(e) => setType(e.target.value)} className="h-8 text-[12px] !pr-7 w-[150px]">
        {TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </Select>
      <Input
        placeholder={noValue ? '（此类型无需值）' : '值（如 emby.media）'}
        value={noValue ? '' : value}
        onChange={(e) => setValue(e.target.value)}
        disabled={noValue}
        className="h-8 text-[12px] flex-1 min-w-[160px]"
        autoFocus={mode === 'create'}
      />
      <Select value={policy} onChange={(e) => setPolicy(e.target.value)} className="h-8 text-[12px] !pr-7 w-[130px]">
        {policy && !policies.includes(policy) ? <option>{policy}</option> : null}
        {policies.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </Select>
      <Input
        placeholder="修饰符 no-resolve"
        value={optionsStr}
        onChange={(e) => setOptionsStr(e.target.value)}
        className="h-8 text-[12px] w-[130px]"
        title="逗号/空格分隔，如 no-resolve"
      />
      <Input
        placeholder="备注"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="h-8 text-[12px] w-[120px]"
      />
      <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg-soft)] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="accent-[var(--color-primary)]"
        />
        启用
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? '…' : mode === 'create' ? '添加' : '保存'}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
      {error && <p className="text-[11px] text-[var(--color-danger)] w-full">{error}</p>}
    </form>
  );
}
