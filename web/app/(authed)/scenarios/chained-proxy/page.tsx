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
  updated_at: number;
}

interface FixedChainView {
  backend: string;
  front: string;
}
interface PoolChainView {
  poolName: string;
  type: string;
  members: string[];
  backends: string[];
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
          Routes traffic through a front node before the backend exits.
          Backed by Mihomo&apos;s <code className="font-mono">dialer-proxy</code> field.
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
  const fixedChains: FixedChainView[] = [];
  const poolChainsByName = new Map<string, PoolChainView>();
  for (const p of parsed.proxies) {
    if (!p.dialerProxy) continue;
    const group = groupByName.get(p.dialerProxy);
    if (group) {
      const existing = poolChainsByName.get(group.name);
      if (existing) {
        existing.backends.push(p.name);
      } else {
        poolChainsByName.set(group.name, {
          poolName: group.name,
          type: group.type,
          members: group.proxies,
          backends: [p.name],
        });
      }
    } else {
      fixedChains.push({ backend: p.name, front: p.dialerProxy });
    }
  }
  return {
    fixedChains: fixedChains.sort((a, b) => a.backend.localeCompare(b.backend)),
    poolChains: [...poolChainsByName.values()].sort((a, b) =>
      a.poolName.localeCompare(b.poolName),
    ),
  };
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
  onChanged,
  onError,
}: {
  chains: FixedChainView[];
  proxies: ProxySummary[];
  onChanged: () => void;
  onError: (message: string | null) => void;
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
              onSubmit={async (backend, front) => {
                try {
                  await runOp('set-fixed-chain', { backend, front });
                  setAdding(false);
                  onChanged();
                  onError(null);
                } catch (err) {
                  onError(err instanceof ApiError ? err.message : String(err));
                }
              }}
            />
          </div>
        )}
        {chains.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--color-muted)]">
            No fixed chains. A fixed chain ties one backend to exactly one front.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {chains.map((c) => (
              <FixedChainRow
                key={c.backend}
                chain={c}
                proxies={proxies}
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
  initial,
  onSubmit,
  onCancel,
}: {
  proxies: ProxySummary[];
  initial?: { backend: string; front: string };
  onSubmit: (backend: string, front: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [backend, setBackend] = useState(initial?.backend ?? '');
  const [front, setFront] = useState(initial?.front ?? '');
  const [pending, setPending] = useState(false);
  const sortedNames = useMemo(
    () => proxies.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    [proxies],
  );

  return (
    <form
      className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!backend || !front || backend === front) return;
        setPending(true);
        try {
          await onSubmit(backend, front);
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">Front (entry)</label>
        <Select value={front} onChange={(e) => setFront(e.target.value)} required>
          <option value="">— pick a front —</option>
          {sortedNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">Backend (exit)</label>
        <Select value={backend} onChange={(e) => setBackend(e.target.value)} required disabled={!!initial}>
          <option value="">— pick a backend —</option>
          {sortedNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending || !backend || !front || backend === front}
          className="flex-1"
        >
          {pending ? '…' : initial ? 'Update' : 'Create'}
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
  proxies,
  onChanged,
  onError,
}: {
  chain: FixedChainView;
  proxies: ProxySummary[];
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  async function clear() {
    setPending(true);
    try {
      await runOp('clear-chain', { backend: chain.backend });
      onChanged();
      onError(null);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="px-4 py-2.5 text-sm">
      {editing ? (
        <FixedChainForm
          proxies={proxies}
          initial={chain}
          onSubmit={async (_b, front) => {
            try {
              await runOp('set-fixed-chain', { backend: chain.backend, front });
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
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs flex-1 min-w-0 truncate">
            <span className="text-[var(--color-accent)]">{chain.front}</span>
            <span className="text-[var(--color-muted)] mx-2">→</span>
            <span>{chain.backend}</span>
          </code>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={clear} disabled={pending}>
            {pending ? '…' : 'Clear'}
          </Button>
        </div>
      )}
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
  onError: (message: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  // Names already claimed in YAML — we forbid them as pool names.
  const claimedNames = useMemo(() => {
    const out = new Set<string>();
    for (const p of proxies) out.add(p.name);
    for (const g of groups) out.add(g.name);
    return out;
  }, [proxies, groups]);

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
              claimedNames={claimedNames}
              onSubmit={async (poolName, backend, fronts) => {
                try {
                  await runOp('create-pool-chain', { poolName, backend, fronts });
                  setAdding(false);
                  onChanged();
                  onError(null);
                } catch (err) {
                  onError(err instanceof ApiError ? err.message : String(err));
                }
              }}
            />
          </div>
        )}
        {pools.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--color-muted)]">
            No pool chains. A pool chain creates a select-group of candidate fronts;
            switching the selection in Clash UI swaps the front without YAML edits.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {pools.map((p) => (
              <PoolChainRow
                key={p.poolName}
                pool={p}
                proxies={proxies}
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
  claimedNames,
  onSubmit,
  initial,
  onCancel,
}: {
  proxies: ProxySummary[];
  claimedNames: Set<string>;
  initial?: { poolName: string; backend?: string; members: string[]; locked?: boolean };
  onSubmit: (poolName: string, backend: string, fronts: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const [poolName, setPoolName] = useState(initial?.poolName ?? '');
  const [backend, setBackend] = useState(initial?.backend ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(initial?.members ?? []));
  const [pending, setPending] = useState(false);

  const sortedNames = useMemo(
    () => proxies.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    [proxies],
  );

  const nameInvalid = !initial && !!poolName && claimedNames.has(poolName);

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
        if (!poolName || (!initial && !backend) || selected.size === 0) return;
        if (nameInvalid) return;
        setPending(true);
        try {
          await onSubmit(poolName, backend, [...selected]);
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-[var(--color-muted)] mb-1 block">Pool name</label>
          <Input
            value={poolName}
            onChange={(e) => setPoolName(e.target.value)}
            placeholder="e.g. via-jp-pool"
            disabled={!!initial?.locked}
            className={nameInvalid ? 'border-[var(--color-danger)]' : ''}
          />
          {nameInvalid && (
            <p className="text-[10px] text-[var(--color-danger)] mt-1">
              Name already used by an existing proxy or group.
            </p>
          )}
        </div>
        {!initial && (
          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">
              Backend (exit)
            </label>
            <Select value={backend} onChange={(e) => setBackend(e.target.value)} required>
              <option value="">— pick a backend —</option>
              {sortedNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      <div>
        <label className="text-xs text-[var(--color-muted)] mb-1 block">
          Fronts (entries) — pick one or more
        </label>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 max-h-48 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1 text-xs">
          {sortedNames.map((n) => {
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
          disabled={
            pending ||
            !poolName ||
            (!initial && !backend) ||
            selected.size === 0 ||
            nameInvalid
          }
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
  onChanged,
  onError,
}: {
  pool: PoolChainView;
  proxies: ProxySummary[];
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  async function del() {
    if (!confirm(`Delete pool "${pool.poolName}" and clear dialer-proxy on ${pool.backends.length} backend(s)?`)) {
      return;
    }
    setPending(true);
    try {
      await runOp('delete-pool-chain', { poolName: pool.poolName });
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
          {pool.poolName}
        </code>
        <Badge tone="neutral">{pool.type}</Badge>
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
          claimedNames={new Set()}
          initial={{ poolName: pool.poolName, members: pool.members, locked: true }}
          onSubmit={async (_name, _b, fronts) => {
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
        <>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-[var(--color-muted)] mr-1">fronts:</span>
            {pool.members.length === 0 && (
              <span className="text-[var(--color-muted)] italic">(empty)</span>
            )}
            {pool.members.map((m) => (
              <Badge key={m} tone="accent">
                {m}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-[var(--color-muted)] mr-1">→ backends:</span>
            {pool.backends.map((b) => (
              <code key={b} className="font-mono">
                {b}
              </code>
            ))}
          </div>
        </>
      )}
    </li>
  );
}
