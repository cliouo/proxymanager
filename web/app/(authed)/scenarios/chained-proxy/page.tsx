'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ChainArrow, ChainNode, ChainPool, ChainRow } from '@/components/ui/ChainDiagram';
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
  const [addingFixed, setAddingFixed] = useState(false);
  const [addingPool, setAddingPool] = useState(false);
  const [editingPool, setEditingPool] = useState<string | null>(null);

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
    return <p className="text-sm text-[var(--color-muted)]">正在加载 base.yaml…</p>;
  }
  if (!parsed) {
    return (
      <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[#F4D8D2]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">
        {error ?? '无数据'}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1
          className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
        >
          链式代理
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--color-muted)] leading-[1.6] max-w-2xl">
          把后端节点包装到带 <code className="font-mono text-[12px] text-[var(--color-primary)]">dialer-proxy</code>{' '}
          的 <code className="font-mono text-[12px] text-[var(--color-primary)]">select</code> 组。链路组名直接写到规则里。
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[#F4D8D2]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {/* Fixed chains section */}
      <section>
        <header className="flex items-baseline justify-between mb-3 pb-2 border-b border-[var(--color-border)]">
          <div className="flex items-baseline gap-2">
            <h2
              className="font-serif text-[20px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
            >
              固定链路
            </h2>
            <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
              {view.fixedChains.length}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAddingFixed((v) => !v)}
          >
            {addingFixed ? '取消' : '+ 新建固定链路'}
          </Button>
        </header>

        {addingFixed && (
          <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-sunk)] p-4">
            <FixedChainForm
              proxies={parsed.proxies}
              groups={parsed.proxyGroups}
              onSubmit={async (front, backend, chainName) => {
                try {
                  await runOp('set-fixed-chain', { backend, front, chainName });
                  setAddingFixed(false);
                  await reload();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : String(err));
                }
              }}
              onCancel={() => setAddingFixed(false)}
            />
          </div>
        )}

        {view.fixedChains.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)] italic px-1">
            暂无固定链路 — 一条固定链路只将一个前置节点 → 一个后端节点封装到一个 group。
          </p>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            {view.fixedChains.map((c) => (
              <FixedRow
                key={c.chainName}
                chain={c}
                onChanged={reload}
                onError={setError}
              />
            ))}
          </div>
        )}
      </section>

      {/* Pool chains section */}
      <section>
        <header className="flex items-baseline justify-between mb-3 pb-2 border-b border-[var(--color-border)]">
          <div className="flex items-baseline gap-2">
            <h2
              className="font-serif text-[20px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
            >
              链路池
            </h2>
            <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
              {view.poolChains.length}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAddingPool((v) => !v)}
          >
            {addingPool ? '取消' : '+ 新建链路池'}
          </Button>
        </header>

        {addingPool && (
          <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-sunk)] p-4">
            <PoolChainForm
              proxies={parsed.proxies}
              groups={parsed.proxyGroups}
              onSubmit={async (backend, fronts, poolName, chainName) => {
                try {
                  await runOp('create-pool-chain', { backend, fronts, poolName, chainName });
                  setAddingPool(false);
                  await reload();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : String(err));
                }
              }}
              onCancel={() => setAddingPool(false)}
            />
          </div>
        )}

        {view.poolChains.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)] italic px-1">
            暂无链路池 — 链路池 = 候选前置节点组 + 把流量落到后端的包装 group。
          </p>
        ) : (
          <div className="space-y-3">
            {view.poolChains.map((p) => (
              <PoolBox
                key={p.chainName}
                pool={p}
                proxies={parsed.proxies}
                groups={parsed.proxyGroups}
                editing={editingPool === p.chainName}
                onEdit={(v) => setEditingPool(v ? p.chainName : null)}
                onChanged={reload}
                onError={setError}
              />
            ))}
          </div>
        )}
      </section>
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
    if (g.proxies.length !== 1) continue;
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

function FixedRow({
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
    if (!confirm(`确定删除链路 group「${chain.chainName}」？`)) return;
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
    <ChainRow
      actions={
        <Button size="sm" variant="ghost" onClick={clear} disabled={pending} className="text-[var(--color-danger)] hover:bg-[var(--color-danger)]/8">
          {pending ? '…' : '删除'}
        </Button>
      }
    >
      <ChainNode label={chain.front} tone="front" />
      <ChainArrow />
      <ChainNode label={chain.chainName} tone="chain" />
      <ChainArrow />
      <ChainNode label={chain.backend} tone="backend" />
    </ChainRow>
  );
}

function PoolBox({
  pool,
  proxies,
  groups,
  editing,
  onEdit,
  onChanged,
  onError,
}: {
  pool: PoolChainView;
  proxies: ProxySummary[];
  groups: ProxyGroupSummary[];
  editing: boolean;
  onEdit: (v: boolean) => void;
  onChanged: () => void;
  onError: (s: string | null) => void;
}) {
  const [pending, setPending] = useState(false);

  async function del() {
    if (!confirm(`确定删除链路「${pool.chainName}」及其池「${pool.poolName}」？`)) return;
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
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="flex items-start gap-3 py-3 px-4 border-b border-[var(--color-border)]">
        <div className="flex-1 min-w-0 flex flex-wrap items-start gap-2">
          <ChainPool name={pool.poolName} members={pool.poolMembers} />
          <div className="flex items-center gap-2 self-center">
            <ChainArrow />
            <ChainNode label={pool.chainName} tone="chain" />
            <ChainArrow />
            <ChainNode label={pool.backend} tone="backend" />
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => onEdit(!editing)} disabled={pending}>
            {editing ? '取消' : '编辑'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={del}
            disabled={pending}
            className="text-[var(--color-danger)] hover:bg-[var(--color-danger)]/8"
          >
            {pending ? '…' : '删除'}
          </Button>
        </div>
      </div>

      {editing && (
        <div className="px-4 py-4 bg-[var(--color-bg-sunk)]">
          <PoolChainForm
            proxies={proxies}
            groups={groups}
            initial={{ poolName: pool.poolName, members: pool.poolMembers }}
            onSubmit={async (_b, fronts) => {
              try {
                await runOp('update-pool-members', { poolName: pool.poolName, fronts });
                onEdit(false);
                onChanged();
                onError(null);
              } catch (err) {
                onError(err instanceof ApiError ? err.message : String(err));
              }
            }}
            onCancel={() => onEdit(false)}
          />
        </div>
      )}
    </div>
  );
}

function FormField({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-1.5">
        {label}
      </label>
      {children}
    </div>
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

  const proxyNames = useMemo(
    () => proxies.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    [proxies],
  );
  const allTargets = useMemo(
    () => [...proxyNames, ...groups.map((g) => g.name)].sort((a, b) => a.localeCompare(b)),
    [proxyNames, groups],
  );

  return (
    <form
      className="grid grid-cols-1 md:grid-cols-4 gap-3"
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
      <FormField label="前置（入口）">
        <Select value={front} onChange={(e) => setFront(e.target.value)} required>
          <option value="">— 选择前置 —</option>
          {allTargets.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="后端（出口）">
        <Select value={backend} onChange={(e) => setBackend(e.target.value)} required>
          <option value="">— 选择后端 —</option>
          {proxyNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="链路名（可选）">
        <Input
          value={chainName}
          onChange={(e) => setChainName(e.target.value)}
          placeholder={front && backend ? `chain:${front}-to-${backend}` : '自动命名'}
        />
      </FormField>
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={pending || !front || !backend || backend === front}>
          {pending ? '…' : '创建'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </form>
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

  const proxyNames = useMemo(
    () => proxies.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    [proxies],
  );
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
      className="space-y-4"
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <FormField label="后端（出口）">
            <Select value={backend} onChange={(e) => setBackend(e.target.value)} required>
              <option value="">— 选择后端 —</option>
              {proxyNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="池名（可选）">
            <Input
              value={poolName}
              onChange={(e) => setPoolName(e.target.value)}
              placeholder={backend ? `pool:${backend}` : '自动命名'}
            />
          </FormField>
          <FormField label="链路名（可选）">
            <Input
              value={chainName}
              onChange={(e) => setChainName(e.target.value)}
              placeholder={backend ? `chain:pool-to-${backend}` : '自动命名'}
            />
          </FormField>
        </div>
      )}

      <FormField label="前置候选 — 至少选一个">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 max-h-56 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1">
          {allTargets.map((n) => {
            const checked = selected.has(n);
            return (
              <label
                key={n}
                className={`flex items-center gap-2 rounded-md px-2 py-1 cursor-pointer text-[12px] transition-colors ${
                  checked
                    ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]'
                    : 'hover:bg-[var(--color-bg-sunk)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(n)}
                  className="accent-[var(--color-primary)] w-3.5 h-3.5"
                />
                <span className="font-mono truncate">{n}</span>
              </label>
            );
          })}
        </div>
      </FormField>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || selected.size === 0 || (!initial && !backend)}>
          {pending ? '…' : initial ? '保存成员' : '创建池'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </form>
  );
}
