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
  const [adding, setAdding] = useState(false);
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
      if (filterAnchor && r.anchor !== filterAnchor) return false;
      if (filterPolicy && r.policy !== filterPolicy) return false;
      if (filterType && r.type !== filterType) return false;
      if (q && !(r.value.toLowerCase().includes(q) || (r.note ?? '').toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [rules, filterAnchor, filterPolicy, filterType, query]);

  async function onDelete(id: string) {
    if (!confirm('确定删除该规则？')) return;
    setBusy(true);
    try {
      await api(`/api/v1/rules/${id}`, { method: 'DELETE' });
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPatch(id: string, patch: Partial<Rule>) {
    try {
      const res = await api<{ data: Rule }>(`/api/v1/rules/${id}`, {
        method: 'PATCH',
        body: patch,
      });
      setRules((prev) => prev.map((r) => (r.id === id ? res.data : r)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-[calc(100vh-0px)]">
      {/* Sticky toolbar — two rows */}
      <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-6 pt-3 pb-2 flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1
              className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
            >
              规则编辑
            </h1>
            <span className="text-[12px] tabular-nums text-[var(--color-muted)] font-mono">
              {filtered.length} / {rules.length}
            </span>
          </div>
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
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
          <div className="flex-1 min-w-[180px] max-w-[280px]">
            <Input
              placeholder="搜索 value / 备注…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 text-[12px]"
            />
          </div>
          {(filterAnchor || filterPolicy || filterType || query) && (
            <button
              type="button"
              onClick={() => {
                setFilterAnchor('');
                setFilterPolicy('');
                setFilterType('');
                setQuery('');
              }}
              className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors px-2 active:scale-[0.96]"
            >
              清空筛选
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="shrink-0 px-6 py-2 text-[12px] bg-[#F4D8D2]/40 text-[var(--color-danger)] border-b border-[var(--color-border)]">
          {error}
        </div>
      )}

      {adding && (
        <AddRuleStrip
          anchors={anchors}
          policies={policies}
          onAdded={async () => {
            await reload();
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* Full-bleed table */}
      <div className="flex-1 min-h-0 overflow-auto bg-[var(--color-surface)]">
        <table className="w-full text-[13px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[var(--color-bg-sunk)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-muted)] font-semibold">
            <tr>
              <th className="text-right px-3 py-2 font-semibold border-b border-[var(--color-border)] w-10 sticky left-0 bg-[var(--color-bg-sunk)]">
                #
              </th>
              <th className="text-left px-3 py-2 font-semibold border-b border-[var(--color-border)] sticky left-10 bg-[var(--color-bg-sunk)]">
                锚点
              </th>
              <th className="text-left px-3 py-2 font-semibold border-b border-[var(--color-border)]">
                类型
              </th>
              <th className="text-left px-3 py-2 font-semibold border-b border-[var(--color-border)]">
                值
              </th>
              <th className="text-left px-3 py-2 font-semibold border-b border-[var(--color-border)]">
                策略
              </th>
              <th className="text-left px-3 py-2 font-semibold border-b border-[var(--color-border)]">
                来源
              </th>
              <th className="text-right px-3 py-2 font-semibold border-b border-[var(--color-border)]"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, idx) => (
              <tr
                key={r.id}
                className="border-b border-[var(--color-border)] hover:bg-[var(--color-bg-sunk)] transition-colors group"
              >
                <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-[var(--color-muted)] sticky left-0 bg-[var(--color-surface)] group-hover:bg-[var(--color-bg-sunk)] transition-colors">
                  {idx + 1}
                </td>
                <td className="px-3 py-1.5 sticky left-10 bg-[var(--color-surface)] group-hover:bg-[var(--color-bg-sunk)] transition-colors">
                  <Badge tone="accent">{r.anchor}</Badge>
                </td>
                <td className="px-3 py-1.5 font-mono text-[12px] text-[var(--color-fg-soft)] whitespace-nowrap">
                  {r.type}
                </td>
                <td className="px-3 py-1.5 font-mono text-[12px] text-[var(--color-fg)] max-w-[280px] truncate" title={r.value}>
                  {r.value || <span className="text-[var(--color-muted)]">—</span>}
                </td>
                <td className="px-3 py-1.5">
                  <Select
                    value={r.policy}
                    onChange={(e) => onPatch(r.id, { policy: e.target.value })}
                    className="h-6 text-[11px] !pr-6 min-w-0"
                  >
                    {policies.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </Select>
                </td>
                <td className="px-3 py-1.5 text-[11px] text-[var(--color-muted)] font-mono">
                  {r.source}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
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
            ))}
            {!loaded &&
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={`sk-${i}`} className="border-b border-[var(--color-border)]">
                  <td colSpan={7} className="px-6 py-2">
                    <Placeholder rows={1} className="max-w-[600px]" />
                  </td>
                </tr>
              ))}
            {loaded && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-16 text-center text-[13px] text-[var(--color-muted)]"
                >
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

function FilterChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center pl-3 rounded-lg bg-[var(--color-bg-sunk)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-colors">
      {children}
    </div>
  );
}

function AddRuleStrip({
  anchors,
  policies,
  onAdded,
  onCancel,
}: {
  anchors: string[];
  policies: string[];
  onAdded: () => Promise<void>;
  onCancel: () => void;
}) {
  const [anchor, setAnchor] = useState(anchors[0] ?? '');
  const [type, setType] = useState('DOMAIN-SUFFIX');
  const [value, setValue] = useState('');
  const [policy, setPolicy] = useState(policies[0] ?? '');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (anchors.length && !anchor) setAnchor(anchors[0]);
    if (policies.length && !policy) setPolicy(policies[0]);
  }, [anchors, policies, anchor, policy]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/api/v1/rules', {
        method: 'POST',
        body: { anchor, type, value, policy, source: 'manual', note: note || undefined },
      });
      setValue('');
      setNote('');
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="shrink-0 px-6 py-3 bg-[var(--color-primary-tint)] border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap"
    >
      <Select
        value={anchor}
        onChange={(e) => setAnchor(e.target.value)}
        className="h-8 text-[12px] !pr-7"
      >
        {anchors.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </Select>
      <Select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="h-8 text-[12px] !pr-7"
      >
        {TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </Select>
      <Input
        placeholder="值（如 emby.media）"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 text-[12px] flex-1 min-w-[180px]"
        autoFocus
      />
      <Select
        value={policy}
        onChange={(e) => setPolicy(e.target.value)}
        className="h-8 text-[12px] !pr-7"
      >
        {policies.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </Select>
      <Input
        placeholder="备注（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="h-8 text-[12px] w-[140px]"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? '…' : '添加'}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
      {error && (
        <p className="text-[11px] text-[var(--color-danger)] w-full">{error}</p>
      )}
    </form>
  );
}
