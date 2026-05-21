'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

interface ProxySummary {
  name: string;
  type: string;
  dialerProxy?: string;
}
interface ProxyGroupSummary {
  name: string;
  type: string;
  proxies: string[];
  dialerProxy?: string;
}
interface ParsedBase {
  proxies: ProxySummary[];
  proxyGroups: ProxyGroupSummary[];
  etag: string;
}

interface FixedChainView {
  chainName: string;
  front: string;
  backend: string;
}
interface PoolChainView {
  chainName: string;
  poolName: string;
  poolMembers: string[];
  backend: string;
}

export default function ChainedProxyPage() {
  const [parsed, setParsed] = useState<ParsedBase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ data: ParsedBase }>('/api/v1/base/parsed');
      setParsed(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const view = useMemo(() => classify(parsed), [parsed]);

  if (loading && !parsed) {
    return <p className="text-sm text-[var(--color-muted)]">Loading base.yaml…</p>;
  }
  if (!parsed) {
    return (
      <Card className="border-[var(--color-danger)]/40">
        <CardBody className="text-sm text-[var(--color-danger)]">{error ?? 'No data.'}</CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Chained proxies</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Wraps backend nodes in <code className="font-mono">select</code> groups with{' '}
          <code className="font-mono">dialer-proxy</code> so chains work over both base
          and collection-supplied nodes. Reference the chain group&apos;s name in your
          rules to route traffic through it.
        </p>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <FixedChainsCard
        chains={view.fixedChains}
        proxies={parsed.proxies}
        groups={parsed.proxyGroups}
        onChanged={reload}
        onError={setError}
      />

      <PoolChainsCard
        pools={view.poolChains}
        proxies={parsed.proxies}
        groups={parsed.proxyGroups}
        onChanged={reload}
        onError={setError}
      />
    </div>
  );
}

function classify(parsed: ParsedBase | null): {
  fixedChains: FixedChainView[];
  poolChains: PoolChainView[];
} {
  if (!parsed) return { fixedChains: [], poolChains: [] };
  const groupByName = new Map(parsed.proxyGroups.map((g) => [g.name, g]));
  const proxyNames = new Set(parsed.proxies.map((p) => p.name));

  const fixedChains: FixedChainView[] = [];
  const poolChains: PoolChainView[] = [];
  for (const g of parsed.proxyGroups) {
    if (!g.dialerProxy) continue;
    if (g.proxies.length !== 1) continue; // not a wrap shape
    const backend = g.proxies[0];
    if (proxyNames.has(g.dialerProxy)) {
      fixedChains.push({ chainName: g.name, front: g.dialerProxy, backend });
    } else {
      const pool = groupByName.get(g.dialerProxy);
      if (pool) {
        poolChains.push({
          chainName: g.name,
          poolName: pool.name,
          poolMembers: pool.proxies,
          backend,
        });
      }
    }
  }
  fixedChains.sort((a, b) => a.chainName.localeCompare(b.chainName));
  poolChains.sort((a, b) => a.chainName.localeCompare(b.chainName));
  return { fixedChains, poolChains };
}

async function runOp(op: string, payload: unknown): Promise<void> {
  await api('/api/v1/ops', {
    method: 'POST',
    body: { scenario: 'chained-proxy', op, payload },
  });
}

/* ─── Fixed chains ──────────────────────────────────────────────────── */

function FixedChainsCard({
  chains,
  proxies,
  groups,
  onChanged,
  onError,
}: {
  chains: FixedChainView[];
  proxies: ProxySummary[];
  groups: ProxyGroupSummary[];
  onChanged: () => void;
  onError: (s: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Fixed chains{' '}
          <span className="text-[var(--color-muted)] font-normal">({chains.length})</span>
        </CardTitle>
        <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add'}
        </Button>
      </CardHeader>
      <CardBody className="p-0">
        {adding && (
          <div className="p-4 border-b border-[var(--color-border)]/60">
            <FixedChainForm
              proxies={proxies}
              groups={groups}
              onSubmit={async (front, backend, chainName) => {
                try {
                  await runOp('set-fixed-chain', { backend, front, chainName });
                  setAdding(false);
                  onChanged();
                  onError(null);
                } catch (err) {
                  onError(err instanceof ApiError ? err.message : String(err));
                }
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}
        {chains.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--color-muted)]">
            No fixed chains. Each fixed chain pins one front → one backend in a
            single wrapper group.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {chains.map((c) => (
              <FixedChainRow
                key={c.chainName}
                chain={c}
                onChanged={onChanged}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function FixedChainForm({
  proxies,
  groups,
  onSubmit,
  onCancel,
}: {
  proxies: ProxySummary[];
  groups: ProxyGroupSummary[];
  onSubmit: (front: string, backend: string, chainName?: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [front, setFront] = useState('');
  const [backend, setBackend] = useState('');
  const [chainName, setChainName] = useState('');
  const [pending, setPending] = useState(false);

  const proxyNames = useMemo(() => proxies.map((p) => p.name).sort((a, b) => a.localeCompare(b)), [proxies]);
  const allTargets = useMemo(
    () => [...proxyNames, ...groups.map((g) => g.name)].sort((a, b) => a.localeCompare(b)),
    [proxyNames, groups],
  );

  return (
    <form
      className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!front || !backend || backend === front) return;
        setPending(true);
        try {
          await onSubmit(front, backend, chainName.trim() || undefined);
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">Front (entry)</label>
        <Select value={front} onChange={(e) => setFront(e.target.value)} required>
          <option value="">— pick a front —</option>
          {allTargets.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">Backend (exit)</label>
        <Select value={backend} onChange={(e) => setBackend(e.target.value)} required>
          <option value="">— pick a backend —</option>
          {proxyNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">
          Group name (optional)
        </label>
        <Input
          value={chainName}
          onChange={(e) => setChainName(e.target.value)}
          placeholder={front && backend ? `chain:${front}-to-${backend}` : 'auto-named'}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending || !front || !backend || backend === front}
          className="flex-1"
        >
          {pending ? '…' : 'Create'}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} type="button">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function FixedChainRow({
  chain,
  onChanged,
  onError,
}: {
  chain: FixedChainView;
  onChanged: () => void;
  onError: (s: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  async function clear() {
    if (!confirm(`Delete chain group "${chain.chainName}"?`)) return;
    setPending(true);
    try {
      await runOp('clear-chain', { chainName: chain.chainName });
      onChanged();
      onError(null);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <li className="px-4 py-2.5 text-sm flex items-center gap-2">
      <code className="font-mono text-xs flex-1 min-w-0 truncate">
        <span className="font-semibold">{chain.chainName}</span>{' '}
        <span className="text-[var(--color-muted)]">{'='}</span>{' '}
        <span className="text-[var(--color-accent)]">{chain.front}</span>
        <span className="text-[var(--color-muted)] mx-1">→</span>
        <span>{chain.backend}</span>
      </code>
      <Button size="sm" variant="danger" onClick={clear} disabled={pending}>
        {pending ? '…' : 'Delete'}
      </Button>
    </li>
  );
}

/* ─── Pool chains ───────────────────────────────────────────────────── */

function PoolChainsCard({
  pools,
  proxies,
  groups,
  onChanged,
  onError,
}: {
  pools: PoolChainView[];
  proxies: ProxySummary[];
  groups: ProxyGroupSummary[];
  onChanged: () => void;
  onError: (s: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Pool chains{' '}
          <span className="text-[var(--color-muted)] font-normal">({pools.length})</span>
        </CardTitle>
        <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add'}
        </Button>
      </CardHeader>
      <CardBody className="p-0">
        {adding && (
          <div className="p-4 border-b border-[var(--color-border)]/60">
            <PoolChainForm
              proxies={proxies}
              groups={groups}
              onSubmit={async (backend, fronts, poolName, chainName) => {
                try {
                  await runOp('create-pool-chain', { backend, fronts, poolName, chainName });
                  setAdding(false);
                  onChanged();
                  onError(null);
                } catch (err) {
                  onError(err instanceof ApiError ? err.message : String(err));
                }
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}
        {pools.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--color-muted)]">
            No pool chains. Pool chain = a select-group of candidate fronts +
            one wrapper group that lands the traffic at the backend.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {pools.map((p) => (
              <PoolChainRow
                key={p.chainName}
                pool={p}
                proxies={proxies}
                groups={groups}
                onChanged={onChanged}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function PoolChainForm({
  proxies,
  groups,
  initial,
  onSubmit,
  onCancel,
}: {
  proxies: ProxySummary[];
  groups: ProxyGroupSummary[];
  initial?: { poolName: string; members: string[] };
  onSubmit: (
    backend: string,
    fronts: string[],
    poolName?: string,
    chainName?: string,
  ) => Promise<void>;
  onCancel?: () => void;
}) {
  const [backend, setBackend] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(initial?.members ?? []));
  const [poolName, setPoolName] = useState(initial?.poolName ?? '');
  const [chainName, setChainName] = useState('');
  const [pending, setPending] = useState(false);

  const proxyNames = useMemo(() => proxies.map((p) => p.name).sort((a, b) => a.localeCompare(b)), [proxies]);
  const allTargets = useMemo(
    () => [...proxyNames, ...groups.map((g) => g.name)].sort((a, b) => a.localeCompare(b)),
    [proxyNames, groups],
  );

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!initial && (!backend || selected.size === 0)) return;
        setPending(true);
        try {
          await onSubmit(
            backend,
            [...selected],
            poolName.trim() || undefined,
            chainName.trim() || undefined,
          );
        } finally {
          setPending(false);
        }
      }}
    >
      {!initial && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">
              Backend (exit)
            </label>
            <Select value={backend} onChange={(e) => setBackend(e.target.value)} required>
              <option value="">— pick a backend —</option>
              {proxyNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">
              Pool name (optional)
            </label>
            <Input
              value={poolName}
              onChange={(e) => setPoolName(e.target.value)}
              placeholder={backend ? `pool:${backend}` : 'auto-named'}
            />
          </div>
          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">
              Chain group name (optional)
            </label>
            <Input
              value={chainName}
              onChange={(e) => setChainName(e.target.value)}
              placeholder={backend ? `chain:pool-to-${backend}` : 'auto-named'}
            />
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">
          Fronts (entries) — pick one or more
        </label>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 max-h-48 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1 text-xs">
          {allTargets.map((n) => {
            const checked = selected.has(n);
            return (
              <label
                key={n}
                className={`flex items-center gap-2 rounded px-2 py-1 cursor-pointer ${
                  checked
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'hover:bg-[var(--color-surface)]'
                }`}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(n)} />
                <span className="font-mono truncate">{n}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending || selected.size === 0 || (!initial && !backend)}
        >
          {pending ? '…' : initial ? 'Update members' : 'Create pool'}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} type="button">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function PoolChainRow({
  pool,
  proxies,
  groups,
  onChanged,
  onError,
}: {
  pool: PoolChainView;
  proxies: ProxySummary[];
  groups: ProxyGroupSummary[];
  onChanged: () => void;
  onError: (s: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  async function del() {
    if (!confirm(`Delete chain "${pool.chainName}" and its pool "${pool.poolName}"?`)) return;
    setPending(true);
    try {
      await runOp('delete-pool-chain', { chainName: pool.chainName });
      onChanged();
      onError(null);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="px-4 py-3 text-sm space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <code className="font-mono text-xs font-semibold truncate flex-1 min-w-0">
          {pool.chainName}
        </code>
        <Badge tone="neutral">→ {pool.backend}</Badge>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setEditing((v) => !v)}
          disabled={pending}
        >
          {editing ? 'Cancel' : 'Edit'}
        </Button>
        <Button size="sm" variant="danger" onClick={del} disabled={pending}>
          {pending ? '…' : 'Delete'}
        </Button>
      </div>

      {editing ? (
        <PoolChainForm
          proxies={proxies}
          groups={groups}
          initial={{ poolName: pool.poolName, members: pool.poolMembers }}
          onSubmit={async (_b, fronts) => {
            try {
              await runOp('update-pool-members', { poolName: pool.poolName, fronts });
              setEditing(false);
              onChanged();
              onError(null);
            } catch (err) {
              onError(err instanceof ApiError ? err.message : String(err));
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-[var(--color-muted)] mr-1">pool {pool.poolName}:</span>
          {pool.poolMembers.length === 0 && (
            <span className="text-[var(--color-muted)] italic">(empty)</span>
          )}
          {pool.poolMembers.map((m) => (
            <Badge key={m} tone="accent">
              {m}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}
