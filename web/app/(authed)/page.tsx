'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import styles from './page.module.css';

/* ---------- API shapes (kept local; only the fields the dashboard reads) ---------- */

interface Meta {
  subscriptionUrl: string;
  buildId: string | null;
  hasBase: boolean;
}

interface ProxyGroup {
  id: string;
  name: string;
  type?: string;
}

interface RuleSet {
  id: string;
  name?: string;
}

interface SubStatus {
  name: string;
  injectedCount: number;
  stale?: boolean;
  staleReason?: string;
  error?: string;
}

interface Preview {
  anchors_applied?: string[];
  unmatched_anchors?: string[];
  subscriptions?: SubStatus[];
  inlined_proxy_count?: number;
  warnings?: string[];
}

interface AuditEvent {
  id: string;
  ts: number;
  op: string;
  actor: string;
  undoes?: string;
}

interface Counts {
  anchors: number;
  subscriptions: number;
  ruleSets: number;
  proxyGroups: number;
  rules: number;
}

/* ---------- audit op → glyph/label (mirrors /history) ---------- */

type Glyph = 'create' | 'update' | 'delete' | 'undo' | 'ai';

const GLYPH_SYM: Record<Glyph, string> = {
  create: '●',
  update: '◐',
  delete: '●',
  undo: '○',
  ai: '✦',
};

const VERBS: Record<string, { label: string; glyph: Glyph }> = {
  create: { label: '新增', glyph: 'create' },
  'batch-create': { label: '批量新增', glyph: 'create' },
  'create-pool-chain': { label: '建链', glyph: 'create' },
  update: { label: '修改', glyph: 'update' },
  patch: { label: '修改', glyph: 'update' },
  'set-section': { label: '设置', glyph: 'update' },
  'set-fixed-chain': { label: '设固定链', glyph: 'update' },
  'update-pool-members': { label: '改链成员', glyph: 'update' },
  mark: { label: '标记', glyph: 'update' },
  delete: { label: '删除', glyph: 'delete' },
  'delete-section': { label: '删除', glyph: 'delete' },
  'delete-pool-chain': { label: '删链', glyph: 'delete' },
  'clear-chain': { label: '清链', glyph: 'delete' },
};

function actionOf(op: string): string {
  const i = op.lastIndexOf('.');
  return i === -1 ? op : op.slice(i + 1);
}
function isAiActor(actor: string): boolean {
  return /ai|assistant|助手/i.test(actor);
}
function describeOp(op: string, actor: string): { label: string; glyph: Glyph } {
  const base = VERBS[actionOf(op)] ?? { label: actionOf(op), glyph: 'update' as Glyph };
  return isAiActor(actor) ? { ...base, glyph: 'ai' } : base;
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- routes (real app paths, not prototype .html) ---------- */
const R = {
  base: '/base',
  proxyGroups: '/proxy-groups',
  rules: '/scenarios/rule-anchor-append',
  chained: '/scenarios/chained-proxy',
  subscriptions: '/subscriptions',
  ruleSets: '/rule-sets',
  config: '/config',
  history: '/history',
};

export default function DashboardPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [metaRes, anchors, subs, sets, pgs, rules, hist, prev] = await Promise.all([
          api<{ data: Meta }>('/api/v1/meta'),
          api<{ data: string[] }>('/api/v1/anchors').catch(() => ({ data: [] as string[] })),
          api<{ data: unknown[]; meta: { total: number } }>('/api/v1/subscriptions'),
          api<{ data: RuleSet[]; meta: { total: number } }>('/api/v1/rule-sets'),
          api<{ data: ProxyGroup[]; meta: { total: number } }>('/api/v1/proxy-groups'),
          api<{ meta: { total: number } }>('/api/v1/rules?limit=1'),
          api<{ data: AuditEvent[] }>('/api/v1/history?limit=5').catch(() => ({
            data: [] as AuditEvent[],
          })),
          // preview powers the "real basis" alerts; may 404 before base init.
          api<{ data: Preview }>('/api/v1/preview/default').catch(() => null),
        ]);
        if (cancelled) return;
        setMeta(metaRes.data);
        setGroups(pgs.data);
        setRuleSets(sets.data);
        setEvents(hist.data);
        setPreview(prev?.data ?? null);
        setCounts({
          anchors: anchors.data.length,
          subscriptions: subs.meta.total,
          ruleSets: sets.meta.total,
          proxyGroups: pgs.meta.total,
          rules: rules.meta.total,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy() {
    if (!meta) return;
    await navigator.clipboard.writeText(meta.subscriptionUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /* ---------- derived stat descriptors (all real) ---------- */
  const groupBreakdown = (() => {
    const by = new Map<string, number>();
    for (const g of groups) by.set(g.type ?? 'select', (by.get(g.type ?? 'select') ?? 0) + 1);
    return [...by.entries()].map(([t, n]) => `${t} ×${n}`).join(' · ');
  })();

  const anchorsApplied = preview?.anchors_applied?.length ?? 0;
  const rulesDesc =
    counts && anchorsApplied > 0 ? `分布于 ${anchorsApplied} 个锚点` : 'base 锚点注入位';
  const subsInjected = preview?.subscriptions?.reduce((s, x) => s + (x.injectedCount ?? 0), 0);

  /* ---------- alerts (computed from real conditions) ---------- */
  const alerts = buildAlerts(meta, preview, ruleSets);

  return (
    <>
      {/* —— 页头注入共享 topbar(对齐 v2/dashboard.html) —— */}
      <PageTopbar>
        <h1>概览</h1>
        <ScopePill />
        {meta?.buildId && (
          <span className="crumb num" title="当前渲染产物 build id">
            build · {meta.buildId.slice(0, 8)}
          </span>
        )}
        <div className="grow" />
      </PageTopbar>

      {error && (
        <div
          className="panel"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)',
            marginBottom: 22,
          }}
        >
          <div className="panel-body" style={{ color: 'var(--danger)', fontSize: 13 }}>
            {error}
          </div>
        </div>
      )}

      {/* —— 订阅 URL 终端卡 —— */}
      <section className={styles.hero}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          订阅地址 · 下发给 Mihomo / Clash
        </div>
        <div className={styles.subPanel}>
          <div className={styles.subStatus}>
            {meta ? (
              meta.hasBase ? (
                <span className="pill ok">渲染正常</span>
              ) : (
                <span className="pill warn">base 未初始化</span>
              )
            ) : (
              <span className="pill idle">加载中</span>
            )}
            {meta?.buildId && (
              <span className="pill plain idle num">build {meta.buildId.slice(0, 8)}</span>
            )}
          </div>

          <div className={styles.url}>
            {meta ? meta.subscriptionUrl : '—'}
            <span className={styles.cursor} />
          </div>

          <div className={styles.quick}>
            <button className="btn primary" onClick={copy} disabled={!meta}>
              {copied ? '已复制 ✓' : '复制 URL'}
            </button>
            <button className="btn" onClick={() => setQrOpen(true)} disabled={!meta}>
              显示二维码
            </button>
            <Link className="btn" href={R.config}>
              查看渲染结果
            </Link>
          </div>

          <div className={styles.hint}>
            把这条 URL 粘贴进客户端作订阅地址即可；内容随 base / 规则 / 策略组实时渲染。
            {!meta?.hasBase && meta && ' 当前 base 尚未初始化，下发的是空骨架。'}
          </div>
        </div>
      </section>

      {/* —— 资源大数 · 本配置文件 —— */}
      <div className={styles.statBand}>
        <div className={styles.bandHead}>
          <span className="eyebrow" style={{ margin: 0 }}>
            配置资源
          </span>
        </div>
        <section className="stat-row">
          <Link className="stat" href={R.base}>
            <div className="k">锚点 anchors</div>
            <div className="v">{counts ? counts.anchors : '—'}</div>
            <div className="d">base 结构中可注入位</div>
          </Link>
          <Link className="stat" href={R.proxyGroups}>
            <div className="k">策略组</div>
            <div className="v">{counts ? counts.proxyGroups : '—'}</div>
            <div className="d">{groups.length > 0 ? groupBreakdown : '尚无策略组'}</div>
          </Link>
          <Link className="stat" href={R.rules}>
            <div className="k">规则</div>
            <div className="v">{counts ? counts.rules : '—'}</div>
            <div className="d">{rulesDesc}</div>
          </Link>
          <Link className="stat" href={R.chained}>
            <div className="k">规则集</div>
            <div className="v">{counts ? counts.ruleSets : '—'}</div>
            <div className="d">规则集库 · 被规则引用</div>
          </Link>
        </section>
      </div>

      {/* —— 共享资源 —— */}
      <div className={styles.statBand}>
        <div className={styles.bandHead}>
          <span className="eyebrow" style={{ margin: 0 }}>
            共享资源
          </span>
          <span className={styles.sh}>· 订阅源直接注入 proxies</span>
        </div>
        <section className="stat-row" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Link className="stat" href={R.subscriptions}>
            <div className="k">订阅源</div>
            <div className="v">{counts ? counts.subscriptions : '—'}</div>
            <div className="d">
              {subsInjected !== undefined
                ? `本次渲染注入 ${subsInjected} 个节点`
                : '机场 / 自建订阅'}
            </div>
          </Link>
          <Link className="stat" href={R.ruleSets}>
            <div className="k">引用规则集</div>
            <div className="v">{counts ? counts.ruleSets : '—'}</div>
            <div className="d">rule-set 库，按需注入 rule-providers</div>
          </Link>
        </section>
      </div>

      {/* —— 最近操作 + 告警 —— */}
      <div className={styles.cols}>
        <section className="panel">
          <div className="panel-head">
            <h2>最近操作</h2>
            <div className="grow" />
            <Link className="btn ghost sm" href={R.history}>
              全部历史 →
            </Link>
          </div>
          <div className="panel-body" style={{ padding: '10px 8px' }}>
            {events.length === 0 ? (
              <div className={styles.empty}>暂无操作记录。</div>
            ) : (
              events.map((e) => {
                const isUndo = !!e.undoes;
                const { label, glyph } = describeOp(e.op, e.actor);
                const g: Glyph = isUndo ? 'undo' : glyph;
                return (
                  <div key={e.id} className="tl-item">
                    <span className="t num">{fmtTime(e.ts)}</span>
                    <span className={`glyph ${g}`}>{GLYPH_SYM[g]}</span>
                    <div className="body">
                      <div className="op">
                        {isUndo ? '撤销 ' : ''}
                        {label}
                      </div>
                      <div className="meta">
                        <span className="mono">{e.op}</span>
                        <span>{e.actor}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>需要注意</h2>
          </div>
          <div className="panel-body">
            {alerts.length === 0 ? (
              <div className={styles.allOk}>
                <span className="pill ok plain">●</span>
                <span>暂无需要处理的问题：base 已初始化、订阅源拉取正常、锚点全部匹配。</span>
              </div>
            ) : (
              <div className={styles.alerts}>
                {alerts.map((a, i) => (
                  <div key={i} className={styles.alert}>
                    <span className={`pill ${a.tone}`}>{a.tag}</span>
                    <div className={styles.txt}>
                      {a.body}
                      {a.href && (
                        <Link href={a.href}>{a.cta ?? '去处理 →'}</Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {qrOpen && meta && <QrModal url={meta.subscriptionUrl} onClose={() => setQrOpen(false)} />}
    </>
  );
}

/* ---------- alert computation (real conditions only) ---------- */

interface Alert {
  tone: 'err' | 'warn' | 'acc';
  tag: string;
  body: React.ReactNode;
  href?: string;
  cta?: string;
}

function buildAlerts(meta: Meta | null, preview: Preview | null, ruleSets: RuleSet[]): Alert[] {
  const out: Alert[] = [];

  // 1) base 未初始化 — highest priority, blocks render.
  if (meta && !meta.hasBase) {
    out.push({
      tone: 'err',
      tag: '未初始化',
      body: (
        <>
          base 结构尚未初始化，下发的订阅是空骨架。先建立 base 才能渲染出可用配置。
        </>
      ),
      href: '/base',
      cta: '去初始化 →',
    });
  }

  // 2) 订阅源拉取失败 / 沿用缓存 — from preview.subscriptions.
  for (const s of preview?.subscriptions ?? []) {
    if (s.error) {
      out.push({
        tone: 'err',
        tag: '拉取失败',
        body: (
          <>
            订阅源 <code className="mono">{s.name}</code> 本次拉取失败
            {s.error ? <>（{s.error}）</> : null}，且没有可用缓存。
          </>
        ),
        href: '/subscriptions',
      });
    } else if (s.stale) {
      out.push({
        tone: 'warn',
        tag: '沿用缓存',
        body: (
          <>
            订阅源 <code className="mono">{s.name}</code> 刷新失败
            {s.staleReason ? <>（{s.staleReason}）</> : null}，已沿用上次缓存。
          </>
        ),
        href: '/subscriptions',
      });
    }
  }

  // 3) 未匹配锚点 — from preview.unmatched_anchors.
  const unmatched = preview?.unmatched_anchors ?? [];
  if (unmatched.length > 0) {
    out.push({
      tone: 'warn',
      tag: '未匹配锚点',
      body: (
        <>
          有 <b>{unmatched.length}</b> 个锚点在 base 中没有对应注入位（
          {unmatched.slice(0, 3).map((a, i) => (
            <span key={a}>
              {i > 0 ? '、' : ''}
              <code className="mono">{a}</code>
            </span>
          ))}
          {unmatched.length > 3 ? ' …' : ''}），这些规则不会进入最终配置。
        </>
      ),
      href: '/base',
    });
  }

  // 4) preview 自带 warnings（如 deprecated 字段）。
  for (const w of preview?.warnings ?? []) {
    out.push({
      tone: 'acc',
      tag: '提示',
      body: <>{w}</>,
      href: '/config',
      cta: '查看配置 →',
    });
  }

  return out;
}

/* ---------- QR modal (uses shared .modal-bg / .modal) ---------- */

function QrModal({ url, onClose }: { url: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    // Theme-neutral QR: pure black on white renders correctly in both themes.
    QRCode.toCanvas(canvasRef.current, url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
      color: { dark: '#101010', light: '#ffffff' },
    }).catch(() => undefined);
  }, [url]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-bg open" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>扫码导入订阅</h3>
        <p className="sub">用客户端扫码即可导入这条订阅地址。</p>
        <div style={{ display: 'grid', placeItems: 'center', padding: '4px 0 14px' }}>
          <canvas ref={canvasRef} style={{ borderRadius: 'var(--r-sm)' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
