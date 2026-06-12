'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import type { ProxyGroup, ProxyGroupKind } from '@/schemas';
import { KIND_LABELS } from './_lib/model';
import { useProxyGroupsData } from './_lib/useProxyGroupsData';
import styles from './proxyGroups.module.css';

/**
 * 策略组 — LIST page (v2「Signal Console」/proxy-groups.html).
 *
 * Full-width list that links to a separate detail route (`/proxy-groups/[id]`).
 *   - 流量结构总览: a four-stage pipeline built from REAL data only.
 *   - pg-toolbar: name search + kind filter chips + a template-count button.
 *   - pg-section blocks grouped by `section` (kind-bucketed when absent),
 *     sorted by each section's min rank.
 *   - pg-row links to the detail route; drag-to-reorder within a section
 *     recomputes ranks (step 10) and PATCHes each changed group.
 *
 * No fake numbers/nodes — every count comes from an API response (DESIGN §7).
 */

/* —— 区域线路判定:section / 名称 关键词启发式 —— */
const REGION_SECTION_RE = /地区|区域|国家|region|线路/i;
const REGION_NAME_RE = /香港|日本|美国|新加坡|台湾|韩国|德国|英国|HK|JP|US|SG|TW|KR|DE|UK/i;

function isRegionGroup(g: ProxyGroup): boolean {
  if (g.section && REGION_SECTION_RE.test(g.section)) return true;
  return REGION_NAME_RE.test(g.name);
}

/** 兜底:section 含 MATCH/兜底 或 名称为「其他」时,标记为 fallback 出口。 */
function isFallback(g: ProxyGroup): boolean {
  const s = g.section ?? '';
  return /MATCH|兜底/i.test(s) || /MATCH|兜底/i.test(g.notes ?? '') || g.name === '其他';
}

interface RowFlag {
  text: string;
  title?: string;
}

/** Derive the kind-tag flags shown on a row (from real fields). */
function rowFlags(g: ProxyGroup): RowFlag[] {
  const flags: RowFlag[] = [];
  if (isFallback(g)) flags.push({ text: '兜底' });
  if (g.kind === 'filter' && g.proxies && g.proxies.length > 0) {
    flags.push({ text: '＋附加节点', title: '组引用之外,额外并入名称匹配的节点' });
  }
  if (g.kind === 'single-sub') flags.push({ text: '单订阅' });
  return flags;
}

export default function ProxyGroupsPage() {
  const data = useProxyGroupsData();
  const {
    groups,
    templates,
    rules,
    ruleSets,
    anchors,
    subs,
    nodeNames,
    previewError,
    error,
    loaded,
    reload,
    stat,
    refCount,
    refSummaryFor,
  } = data;

  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<ProxyGroupKind | null>(null);

  // Local ordering overlay so a drag-reorder reflects immediately before the
  // PATCH round-trip lands (then `reload()` reconciles).
  const [rankOverride, setRankOverride] = useState<Record<string, number>>({});
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  }, []);

  const rankOf = useCallback(
    (g: ProxyGroup) => (g.id in rankOverride ? rankOverride[g.id] : g.rank),
    [rankOverride],
  );

  const q = query.trim().toLowerCase();

  // —— section-grouped, rank-sorted rows (mirrors the old LeftRail logic) ——
  const sections = useMemo(() => {
    const map = new Map<string, ProxyGroup[]>();
    for (const g of groups) {
      if (q && !g.name.toLowerCase().includes(q)) continue;
      if (kindFilter && g.kind !== kindFilter) continue;
      const key = g.section?.trim() || KIND_LABELS[g.kind];
      const list = map.get(key) ?? [];
      list.push(g);
      map.set(key, list);
    }
    return Array.from(map.entries())
      .map(([section, items]) => {
        const sorted = items.slice().sort((a, b) => rankOf(a) - rankOf(b));
        const ranks = sorted.map(rankOf);
        return {
          section,
          items: sorted,
          minRank: Math.min(...ranks),
          maxRank: Math.max(...ranks),
        };
      })
      .sort((a, b) => a.minRank - b.minRank);
  }, [groups, q, kindFilter, rankOf]);

  const sectionCount = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) set.add(g.section?.trim() || KIND_LABELS[g.kind]);
    return set.size;
  }, [groups]);

  // —— flow overview buckets (real data only) ——
  const { exitChips, regionChips } = useMemo(() => {
    const visible = groups.filter((g) => !g.hidden);
    const exit: ProxyGroup[] = [];
    const region: ProxyGroup[] = [];
    for (const g of visible) (isRegionGroup(g) ? region : exit).push(g);
    exit.sort((a, b) => a.rank - b.rank);
    region.sort((a, b) => a.rank - b.rank);
    return { exitChips: exit, regionChips: region };
  }, [groups]);

  // —— drag-to-reorder within a section ——
  const dragId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Per-section working order during a drag (id arrays keyed by section).
  const [dragOrder, setDragOrder] = useState<Record<string, string[]>>({});

  const onDragStart = (section: string, id: string) => {
    dragId.current = id;
    setDraggingId(id);
    setDragOrder((prev) => ({
      ...prev,
      [section]: sections.find((s) => s.section === section)!.items.map((g) => g.id),
    }));
  };

  const onDragOver = (section: string, overId: string, after: boolean) => {
    const id = dragId.current;
    if (!id || id === overId) return;
    setDragOrder((prev) => {
      const order = (prev[section] ?? sections.find((s) => s.section === section)?.items.map((g) => g.id) ?? []).slice();
      const from = order.indexOf(id);
      if (from === -1) return prev;
      order.splice(from, 1);
      let to = order.indexOf(overId);
      if (to === -1) return prev;
      if (after) to += 1;
      order.splice(to, 0, id);
      return { ...prev, [section]: order };
    });
  };

  const onDragEnd = async (section: string) => {
    const id = dragId.current;
    dragId.current = null;
    setDraggingId(null);
    const order = dragOrder[section];
    setDragOrder((prev) => {
      const { [section]: _drop, ...rest } = prev;
      return rest;
    });
    if (!id || !order) return;

    const sec = sections.find((s) => s.section === section);
    if (!sec) return;
    const base = sec.minRank;
    // Recompute ranks for this section: step 10 from the section's min rank.
    const byId = new Map(sec.items.map((g) => [g.id, g] as const));
    const changes: { id: string; rank: number }[] = [];
    order.forEach((gid, i) => {
      const g = byId.get(gid);
      if (!g) return;
      const nextRank = base + i * 10;
      if (nextRank !== g.rank) changes.push({ id: gid, rank: nextRank });
    });
    if (changes.length === 0) return;

    // Optimistic overlay so the order sticks while the PATCHes resolve.
    setRankOverride((prev) => {
      const next = { ...prev };
      for (const c of changes) next[c.id] = c.rank;
      return next;
    });

    try {
      await Promise.all(
        changes.map((c) =>
          api(`/api/v1/proxy-groups/${c.id}`, { method: 'PATCH', body: { rank: c.rank } }),
        ),
      );
      showToast(`渲染顺序已更新 · 已写入 ${changes.length} 个组的 rank`);
      await reload();
      setRankOverride({});
    } catch (err) {
      showToast(err instanceof ApiError ? `保存失败:${err.message}` : '保存失败,已回滚');
      setRankOverride({});
      await reload();
    }
  };

  if (!loaded) {
    return <p className={styles.empty}>载入策略组…</p>;
  }

  return (
    <>
      <PageTopbar contentMaxWidth={1080}>
        <h1>策略组</h1>
        <ScopePill />
        <span className="crumb">
          {groups.length} 个 · {sectionCount} 个分区
        </span>
        <div className="grow" />
        <Link className="btn primary" href="/proxy-groups/new">
          ＋ 新建策略组
        </Link>
      </PageTopbar>

      {previewError && (
        <div
          className="pill warn"
          style={{ height: 'auto', padding: '8px 12px', marginBottom: 16, display: 'flex' }}
        >
          节点列表暂不可用(预览失败),计数省略,仍可编辑
        </div>
      )}

      {error && (
        <div
          className="pill err"
          style={{ height: 'auto', padding: '8px 12px', marginBottom: 16, display: 'flex' }}
        >
          {error}
        </div>
      )}

      {/* ──────── 流量结构总览 ──────── */}
      <section className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-head">
          <h2>流量结构</h2>
          <span className="sub">规则怎么流到节点 · 点击任意组直达编辑</span>
        </div>
        <div className={styles.flow}>
          <FlowCol header="规则入口">
            <Link className={styles.flItem} href="/rules">
              <b>{rules.length} 条规则</b>
              <span className="ct">{anchors.length} 锚点</span>
            </Link>
            <Link className={`${styles.flItem} ${styles.pool}`} href="/rule-sets">
              {ruleSets.length} 个规则集 · 共享库
            </Link>
          </FlowCol>
          <FlowArrow />
          <FlowCol header="出口 / 分流">
            {exitChips.slice(0, 4).map((g, i) => (
              <Link
                key={g.id}
                className={`${styles.flItem}${i === 0 ? ' ' + styles.hub : ''}`}
                href={`/proxy-groups/${g.id}`}
              >
                <b>{g.name}</b>
                <span className="ct">{flowNote(g, refCount(g.name))}</span>
              </Link>
            ))}
            {exitChips.length > 4 && (
              <span className={`${styles.flItem} ${styles.pool}`}>
                {exitChips.slice(4, 8).map((g) => g.name).join(' · ')}
                {exitChips.length > 8 ? ' · 其他 ↓' : ' ↓'}
              </span>
            )}
          </FlowCol>
          <FlowArrow />
          <FlowCol header="地区线路">
            {regionChips.slice(0, 4).map((g) => (
              <Link key={g.id} className={styles.flItem} href={`/proxy-groups/${g.id}`}>
                <b>{g.name}</b>
                <span className="ct">{stat(g).count} 节点</span>
              </Link>
            ))}
            {regionChips.length > 4 && (
              <span className={`${styles.flItem} ${styles.pool}`}>
                {regionChips.slice(4, 8).map((g) => g.name).join(' · ')}
                {regionChips.length > 8 ? ' · 其他 ↓' : ' ↓'}
              </span>
            )}
          </FlowCol>
          <FlowArrow />
          <FlowCol header="节点池">
            <Link className={`${styles.flItem} ${styles.pool}`} href="/subscriptions">
              {nodeNames.length} 节点 · {subs.length} 订阅源
            </Link>
            <span className={`${styles.flItem} ${styles.pool}`}>DIRECT / REJECT 内建</span>
          </FlowCol>
        </div>
      </section>

      {/* ──────── 工具条 ──────── */}
      <div className={styles.pgToolbar}>
        <div className="search">
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索策略组…"
          />
        </div>
        {(['manual', 'filter', 'all', 'single-sub'] as ProxyGroupKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`chip${kindFilter === k ? ' on' : ''}`}
            onClick={() => setKindFilter((cur) => (cur === k ? null : k))}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
        <div className={styles.grow} style={{ flex: 1 }} />
        <button
          className="btn sm"
          onClick={() =>
            showToast(
              templates.length > 0
                ? `${templates.length} 个组模板:${templates.map((t) => t.name).join(' · ')} — 字段缺省时由模板补全`
                : '尚无组模板',
            )
          }
        >
          {templates.length} 个组模板
        </button>
      </div>

      {/* ──────── 分区行 ──────── */}
      {sections.length === 0 ? (
        <p className={styles.empty}>
          {groups.length === 0 ? '还没有策略组,点右上「＋ 新建策略组」。' : '无匹配。'}
        </p>
      ) : (
        sections.map(({ section, items, minRank, maxRank }) => {
          const order = dragOrder[section];
          const rendered = order
            ? order.map((id) => items.find((g) => g.id === id)!).filter(Boolean)
            : items;
          return (
            <div key={section} className={styles.pgSection}>
              <div className={styles.pgSectionHead}>
                <b>{section}</b>
                <span className="ct">
                  {items.length} 个 · rank {minRank}–{maxRank}
                </span>
              </div>
              {rendered.map((g) => {
                const s = stat(g);
                const summary = refSummaryFor(g);
                const flags = rowFlags(g);
                return (
                  <Link
                    key={g.id}
                    href={`/proxy-groups/${g.id}`}
                    className={`${styles.row}${draggingId === g.id ? ' ' + styles.dragging : ''}`}
                    draggable
                    onDragStart={() => onDragStart(section, g.id)}
                    onDragEnd={() => onDragEnd(section)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const after = e.clientY > rect.top + rect.height / 2;
                      onDragOver(section, g.id, after);
                    }}
                    onClick={(e) => {
                      if (draggingId) e.preventDefault();
                    }}
                  >
                    <span
                      className={styles.grip}
                      title="拖动调整渲染顺序"
                      onClick={(e) => e.preventDefault()}
                    >
                      ⠿
                    </span>
                    <span className={styles.rank}>r {rankOf(g)}</span>
                    <span className={styles.ident}>
                      <span className={styles.nm}>
                        <b>{g.name}</b>
                        <span className="pill acc plain">{g.type}</span>
                      </span>
                      <span className={styles.desc}>{g.notes || deriveDesc(g, s.summary)}</span>
                    </span>
                    <span className={styles.members}>{s.summary}</span>
                    <span className={styles.refs}>{refLabel(summary)}</span>
                    <span className={styles.flags}>
                      {flags.map((f) => (
                        <span key={f.text} className={styles.kindTag} title={f.title}>
                          {f.text}
                        </span>
                      ))}
                    </span>
                    <span className={styles.arrow}>→</span>
                  </Link>
                );
              })}
            </div>
          );
        })
      )}

      <div className={styles.rankNote}>
        ⠿ 拖动行可调整组在 proxy-groups 块中的渲染顺序(rank,步长 10)· 分区 section 仅用于本页组织,不写入配置
      </div>

      {toastMsg && (
        <div className="toast-wrap">
          <div className="toast">{toastMsg}</div>
        </div>
      )}
    </>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────────── */

function FlowCol({ header, children }: { header: string; children: React.ReactNode }) {
  return (
    <div className={styles.flowCol}>
      <div className={styles.fcH}>{header}</div>
      <div className={styles.fcList}>{children}</div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className={styles.flowArr}>
      <span>→</span>
    </div>
  );
}

/** One-liner for a flow chip's count column (real refs / member kind). */
function flowNote(g: ProxyGroup, rules: number): string {
  if (rules > 0) return `${rules} 规则`;
  if (g.kind === 'filter') return '正则筛选';
  if (g.kind === 'all') return '全量节点';
  if (g.kind === 'single-sub') return '单订阅';
  return KIND_LABELS[g.kind];
}

/** A derived one-line description when the group carries no notes. */
function deriveDesc(g: ProxyGroup, summary: string): string {
  return `${KIND_LABELS[g.kind]} · ${summary}`;
}

/** Refs column: rule refs + reverse group-ref count (real). */
function refLabel(s: { rules: number; refIn: string[] }): string {
  const parts: string[] = [];
  if (s.rules > 0) parts.push(`${s.rules} 规则引用`);
  if (s.refIn.length > 0) parts.push(`被 ${s.refIn.length} 组引用`);
  return parts.length > 0 ? parts.join(' · ') : '无引用';
}
