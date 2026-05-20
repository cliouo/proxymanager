'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
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
    if (!confirm('Delete this rule?')) return;
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Rules</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Showing {filtered.length} of {rules.length}
          </p>
        </div>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <Select value={filterAnchor} onChange={(e) => setFilterAnchor(e.target.value)}>
              <option value="">All anchors</option>
              {anchors.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
            <Select value={filterPolicy} onChange={(e) => setFilterPolicy(e.target.value)}>
              <option value="">All policies</option>
              {policies.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
            <Select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <Input
              placeholder="search value or note…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      <AddRuleForm anchors={anchors} policies={policies} onAdded={reload} />

      <Card>
        <CardBody className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="text-left px-3 py-2">Anchor</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Value</th>
                <th className="text-left px-3 py-2">Policy</th>
                <th className="text-left px-3 py-2">Rank</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)]/60 hover:bg-[var(--color-surface-2)]/40">
                  <td className="px-3 py-2">
                    <Badge tone="accent">{r.anchor}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.value || <span className="text-[var(--color-muted)]">—</span>}</td>
                  <td className="px-3 py-2">
                    <Select
                      value={r.policy}
                      onChange={(e) => onPatch(r.id, { policy: e.target.value })}
                      className="h-7 text-xs"
                    >
                      {policies.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.rank}</td>
                  <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{r.source}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onDelete(r.id)}
                      disabled={busy}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-[var(--color-muted)]">
                    No rules match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

function AddRuleForm({
  anchors,
  policies,
  onAdded,
}: {
  anchors: string[];
  policies: string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState('');
  const [type, setType] = useState('DOMAIN-SUFFIX');
  const [value, setValue] = useState('');
  const [policy, setPolicy] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (anchors.length && !anchor) setAnchor(anchors[0]);
    if (policies.length && !policy) setPolicy(policies[0]);
  }, [anchors, policies, anchor, policy]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/api/v1/rules', {
        method: 'POST',
        body: {
          anchor,
          type,
          value,
          policy,
          source: 'manual' as const,
          note: note || undefined,
        },
      });
      setValue('');
      setNote('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add rule</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </CardHeader>
      {open && (
        <CardBody>
          <form className="grid grid-cols-1 md:grid-cols-6 gap-2 items-start" onSubmit={onSubmit}>
            <Select value={anchor} onChange={(e) => setAnchor(e.target.value)}>
              {anchors.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <Input
              className="md:col-span-2"
              placeholder="value (e.g. emby.media)"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Select value={policy} onChange={(e) => setPolicy(e.target.value)}>
              {policies.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add'}
            </Button>
            <Input
              className="md:col-span-6"
              placeholder="note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {error && (
              <p className="md:col-span-6 text-xs text-[var(--color-danger)]">{error}</p>
            )}
          </form>
        </CardBody>
      )}
    </Card>
  );
}
