'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import styles from './chainedProxy.module.css';

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
    return <p className={styles.empty}>正在加载 base.yaml…</p>;
  }
  if (!parsed) {
    return <div className={styles.errBox}>{error ?? '无数据'}</div>;
  }

  return (
    <>
      {/* —— 页头注入共享 topbar(对齐 v2/chained-proxy.html;原型的「＋ 新建链路」
          因本页有固定链路 / 链路池两条独立创建流程,保留在各自分区头,不上提) —— */}
      <PageTopbar>
        <h1>链式代理</h1>
        <ScopePill />
        <span className="crumb">
          {view.fixedChains.length} 条固定链路 · {view.poolChains.length} 个链路池
        </span>
        <div className="grow" />
      </PageTopbar>

      <p className={styles.intro}>
        链式代理把出口节点的流量先<b>套进前置节点</b>发出（底层写{' '}
        <code className="mono">dialer-proxy</code> 字段）。目标站点看到的始终是<b>落地出口</b>的 IP，
        常用于解锁、防风控等需要落地 IP 固定的场景。下图从左到右就是一条数据包的真实路径。
      </p>

      <div className={styles.legend}>
        <span>
          <i className={`${styles.lg} ${styles.lgAccent}`} />
          前置 · 入口
        </span>
        <span>
          <i className={styles.lg} />
          中继 · 链路组
        </span>
        <span>
          <i className={`${styles.lg} ${styles.lgOk}`} />
          落地 · 出口
        </span>
        <span>
          <i className={`${styles.lg} ${styles.lgGhost}`} />
          客户端 / 目标（示意）
        </span>
        <span>
          <i className={styles.lgDot} />
          流量方向
        </span>
      </div>

      {error && <div className={styles.errBox}>{error}</div>}

      {/* Fixed chains section */}
      <section>
        <div className={styles.sectionHead}>
          <span className="eyebrow">固定链路</span>
          <span className={styles.count}>{view.fixedChains.length}</span>
          <div className="grow" style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setAddingFixed((v) => !v)}>
            {addingFixed ? '取消' : '＋ 新建固定链路'}
          </button>
        </div>

        {addingFixed && (
          <div className={styles.formPanel}>
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
          <p className={styles.empty}>
            暂无固定链路 — 一条固定链路只将一个前置节点 → 一个后端节点封装到一个 group。
          </p>
        ) : (
          view.fixedChains.map((c) => (
            <FixedFlow key={c.chainName} chain={c} onChanged={reload} onError={setError} />
          ))
        )}
      </section>

      {/* Pool chains section */}
      <section style={{ marginTop: 30 }}>
        <div className={styles.sectionHead}>
          <span className="eyebrow">链路池</span>
          <span className={styles.eyebrowSub}>· 前置可在池内弹性切换</span>
          <span className={styles.count}>{view.poolChains.length}</span>
          <div className="grow" style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setAddingPool((v) => !v)}>
            {addingPool ? '取消' : '＋ 新建链路池'}
          </button>
        </div>

        {addingPool && (
          <div className={styles.formPanel}>
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
          <p className={styles.empty}>
            暂无链路池 — 链路池 = 候选前置节点组 + 把流量落到后端的包装 group。
          </p>
        ) : (
          view.poolChains.map((p) => (
            <PoolFlow
              key={p.chainName}
              pool={p}
              proxies={parsed.proxies}
              groups={parsed.proxyGroups}
              editing={editingPool === p.chainName}
              onEdit={(v) => setEditingPool(v ? p.chainName : null)}
              onChanged={reload}
              onError={setError}
            />
          ))
        )}
      </section>
    </>
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

/* ---------- flow-lane station primitives ---------- */

function Pipe({ delay, tag }: { delay: number; tag?: string }) {
  return (
    <div className={styles.pipe}>
      {tag && <span className={styles.pipeTag}>{tag}</span>}
      <i className={styles.packet} style={{ '--d': `${delay}s` } as React.CSSProperties} />
    </div>
  );
}

function GhostStation({ glyph, name, role }: { glyph: string; name: string; role: string }) {
  return (
    <div className={`${styles.station} ${styles.ghost}`}>
      <div className={styles.stTop}>
        <div className={styles.stGlyph}>{glyph}</div>
      </div>
      <div className={styles.stName}>{name}</div>
      <div className={styles.stRole}>{role}</div>
    </div>
  );
}

function Station({
  variant,
  glyph,
  name,
  role,
  className,
}: {
  variant?: 'entry' | 'exit';
  glyph: string;
  name: string;
  role: string;
  className?: string;
}) {
  const cls = [styles.station, variant ? styles[variant] : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      <div className={styles.stTop}>
        <div className={styles.stGlyph}>{glyph}</div>
      </div>
      <div className={styles.stName}>{name}</div>
      <div className={styles.stRole}>{role}</div>
    </div>
  );
}

function FixedFlow({
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
    <div className={styles.flowWrap}>
      <div className={styles.flowHead}>
        <b>{chain.chainName}</b>
        <div style={{ flex: 1 }} />
        <button className="btn sm danger" onClick={clear} disabled={pending}>
          {pending ? '…' : '删除'}
        </button>
      </div>

      <div className={styles.flow}>
        <GhostStation glyph="⌂" name="本机 / 客户端" role="起点" />
        <Pipe delay={0} />
        <Station variant="entry" glyph="⇡" name={chain.front} role="前置 · 入口" />
        <Pipe delay={0.35} tag="dialer 套娃" />
        <Station glyph="⇄" name={chain.chainName} role="中继 · 链路组" />
        <Pipe delay={0.7} />
        <Station variant="exit" glyph="⚑" name={chain.backend} role="落地 · 出口" />
        <Pipe delay={1.05} />
        <GhostStation glyph="◎" name="目标站点" role="看到落地出口 IP" />
      </div>

      <div className={styles.flowMeta}>
        生成策略组 <code className="mono">{chain.chainName}</code> · 出口{' '}
        <code className="mono">{chain.backend}</code> 写入{' '}
        <code className="mono">dialer-proxy: {chain.front}</code>。
      </div>
    </div>
  );
}

function PoolFlow({
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
    <div className={styles.flowWrap}>
      <div className={styles.flowHead}>
        <b>{pool.chainName}</b>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => onEdit(!editing)} disabled={pending}>
          {editing ? '取消' : '编辑'}
        </button>
        <button className="btn sm danger" onClick={del} disabled={pending}>
          {pending ? '…' : '删除'}
        </button>
      </div>

      <div className={styles.flow}>
        <GhostStation glyph="⌂" name="本机 / 客户端" role="起点" />
        <Pipe delay={0} />
        <Station
          variant="entry"
          className={styles.pool}
          glyph="⚖"
          name={pool.poolName}
          role="策略组 · 运行时择优"
        />
        <Pipe delay={0.4} tag="dialer 套娃" />
        <Station glyph="⇄" name={pool.chainName} role="中继 · 链路组" />
        <Pipe delay={0.8} />
        <Station variant="exit" glyph="⚑" name={pool.backend} role="落地 · 出口" />
        <Pipe delay={1.2} />
        <GhostStation glyph="◎" name="目标站点" role="看到落地出口 IP" />
      </div>

      <div className={styles.candsLabel}>前置池成员 · 由 {pool.poolName} 组运行时择优</div>
      <div className={styles.cands}>
        {pool.poolMembers.length === 0 ? (
          <span className={styles.cand}>
            <i className={styles.dot} />
            （空池）
          </span>
        ) : (
          pool.poolMembers.map((m) => (
            <span key={m} className={`${styles.cand} ${styles.candActive}`}>
              <i className={styles.dot} />
              {m}
            </span>
          ))
        )}
      </div>

      <div className={styles.flowMeta}>
        生成策略组 <code className="mono">{pool.chainName}</code> · 前置由{' '}
        <code className="mono">{pool.poolName}</code> 组按其组规则在池内切换，落地出口固定为{' '}
        <code className="mono">{pool.backend}</code>。
      </div>

      {editing && (
        <div className={styles.editZone}>
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

function Field({
  label,
  children,
  tight,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  tight?: boolean;
}) {
  return (
    <div className={`field ${tight ? styles.fieldTight : ''}`}>
      <label>{label}</label>
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
      <div className={styles.formGrid}>
        <Field label="前置（入口）" tight>
          <select
            className="input mono"
            value={front}
            onChange={(e) => setFront(e.target.value)}
            required
          >
            <option value="">— 选择前置 —</option>
            {allTargets.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="后端（出口）" tight>
          <select
            className="input mono"
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            required
          >
            <option value="">— 选择后端 —</option>
            {proxyNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="链路名（可选）" tight>
          <input
            className="input mono"
            value={chainName}
            onChange={(e) => setChainName(e.target.value)}
            placeholder={front && backend ? `chain:${front}-to-${backend}` : '自动命名'}
          />
        </Field>
        <div className={styles.formActions}>
          <button
            className="btn primary"
            type="submit"
            disabled={pending || !front || !backend || backend === front}
          >
            {pending ? '…' : '创建'}
          </button>
          {onCancel && (
            <button className="btn ghost" type="button" onClick={onCancel}>
              取消
            </button>
          )}
        </div>
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
        <div className={styles.formGrid3} style={{ marginBottom: 16 }}>
          <Field label="后端（出口）" tight>
            <select
              className="input mono"
              value={backend}
              onChange={(e) => setBackend(e.target.value)}
              required
            >
              <option value="">— 选择后端 —</option>
              {proxyNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="池名（可选）" tight>
            <input
              className="input mono"
              value={poolName}
              onChange={(e) => setPoolName(e.target.value)}
              placeholder={backend ? `pool:${backend}` : '自动命名'}
            />
          </Field>
          <Field label="链路名（可选）" tight>
            <input
              className="input mono"
              value={chainName}
              onChange={(e) => setChainName(e.target.value)}
              placeholder={backend ? `chain:pool-to-${backend}` : '自动命名'}
            />
          </Field>
        </div>
      )}

      <Field label="前置候选 — 至少选一个">
        <div className={styles.picker}>
          {allTargets.map((n) => {
            const checked = selected.has(n);
            return (
              <label
                key={n}
                className={`${styles.pickItem} ${checked ? styles.pickItemOn : ''}`}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(n)} />
                <span className={styles.nm}>{n}</span>
              </label>
            );
          })}
        </div>
      </Field>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn primary"
          type="submit"
          disabled={pending || selected.size === 0 || (!initial && !backend)}
        >
          {pending ? '…' : initial ? '保存成员' : '创建池'}
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
