'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { matchFilter, type FilterMatch } from '@/lib/proxies/filterMatch';
import type { ProxyGroup } from '@/schemas';
import { escapeRegex, type SubscriptionLite } from './model';

/**
 * The only authoritative source of real node names is the resolved preview —
 * subscriptions are fetched/parsed at resolve time, so node names don't exist
 * until then. We read `/api/v1/preview/default` once and reuse `node_names`
 * for the member picker and every membership preview.
 *
 * Degrades gracefully: if the preview fails (upstream down, base missing),
 * `nodeNames` is empty and `error` is set — the composer falls back to manual
 * name entry + builtin/group picks, which don't need the node list.
 */
export function usePreviewNodes(): {
  nodeNames: string[];
  loading: boolean;
  error: string | null;
  computedAt: number | null;
  reload: () => Promise<void>;
} {
  const [nodeNames, setNodeNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [computedAt, setComputedAt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ data: { node_names: string[] } }>('/api/v1/preview/default');
      setNodeNames(res.data.node_names ?? []);
      setComputedAt(Date.now());
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

  return { nodeNames, loading, error, computedAt, reload };
}

/* ─── Pure helpers (no React) ────────────────────────────────────────── */

export interface SubBucket {
  sub: SubscriptionLite;
  nodes: string[];
}

/**
 * Group node names under the subscription whose `node_prefix` they start with.
 * Ties (one prefix is a prefix of another) go to the longest match so the
 * attribution is deterministic. Nodes matching no prefix land in `unfiled`.
 *
 * This is best-effort attribution for the picker UI — the renderer's true
 * per-sub set lives in resolve.ts, but for "show me airport A's nodes" this
 * is exactly right whenever node_prefix is set (which we nudge users to do).
 */
export function groupNodesBySub(
  nodeNames: string[],
  subs: SubscriptionLite[],
): { buckets: SubBucket[]; unfiled: string[] } {
  const prefixed = subs
    .filter((s) => s.node_prefix && s.node_prefix.length > 0)
    .map((s) => ({ sub: s, prefix: s.node_prefix as string }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const bucketMap = new Map<string, string[]>();
  for (const s of subs) bucketMap.set(s.id, []);
  const unfiled: string[] = [];

  for (const name of nodeNames) {
    const hit = prefixed.find((p) => name.startsWith(p.prefix));
    if (hit) bucketMap.get(hit.sub.id)!.push(name);
    else unfiled.push(name);
  }

  const buckets: SubBucket[] = subs
    .map((sub) => ({ sub, nodes: bucketMap.get(sub.id) ?? [] }))
    .filter((b) => b.nodes.length > 0);

  return { buckets, unfiled };
}

export type { FilterMatch };
export { matchFilter };

/** Node names a single-sub binding would select: `^<escaped node_prefix>`. */
export function singleSubPreview(nodeNames: string[], nodePrefix: string | undefined): string[] {
  if (!nodePrefix) return [];
  return matchFilter(nodeNames, `^${escapeRegex(nodePrefix)}`).matched;
}

/* ─── member stat (rail count + detail summary) ──────────────────────── */

export interface MemberStat {
  count: number;
  unit: '节点' | '成员';
  summary: string;
}

/**
 * Resolve a group's effective member count + a one-line summary, honouring
 * bindings (single-sub / collection-scope) and auto-include (filter). Used by
 * the rail badge and the detail view so both agree with what renders.
 */
export function memberStat(
  group: ProxyGroup,
  nodeNames: string[],
  subs: SubscriptionLite[],
): MemberStat {
  if (group.kind === 'single-sub' && group.bound_subscription_id) {
    const sub = subs.find((s) => s.id === group.bound_subscription_id);
    const n = singleSubPreview(nodeNames, sub?.node_prefix).length;
    return { count: n, unit: '节点', summary: `单订阅「${sub?.name ?? '?'}」→ ${n} 节点` };
  }
  if (group['include-all-proxies'] || group['include-all'] || group['include-all-providers']) {
    if (group.filter && group.filter.trim()) {
      const n = matchFilter(nodeNames, group.filter, group['exclude-filter']).matched.length;
      return { count: n, unit: '节点', summary: `自动纳入 filter → ${n} 节点` };
    }
    return { count: nodeNames.length, unit: '节点', summary: `全部 ${nodeNames.length} 节点` };
  }
  const n = group.proxies?.length ?? 0;
  return { count: n, unit: '成员', summary: n > 0 ? `手选 ${n} 成员` : '空(无成员)' };
}

/* ─── proxies-graph cycle guard (for the member picker) ──────────────── */

/**
 * Build the group→group adjacency from `proxies[]` entries that name another
 * group. mihomo rejects a config where groups reference each other in a loop,
 * so the picker greys out any candidate that would close one. The service
 * already guards `dialer-proxy` cycles on save; this covers the `proxies` DAG.
 */
export function buildGroupGraph(groups: ProxyGroup[]): Map<string, Set<string>> {
  const names = new Set(groups.map((g) => g.name));
  const graph = new Map<string, Set<string>>();
  for (const g of groups) {
    const targets = new Set<string>();
    for (const p of g.proxies ?? []) if (names.has(p)) targets.add(p);
    graph.set(g.name, targets);
  }
  return graph;
}

/**
 * Would adding `candidate` to `current`'s proxies create a cycle? True when
 * `candidate === current` (self-reference) or `candidate` can already reach
 * `current` through the existing graph. `extraEdges` lets the live form feed
 * its in-progress picks so the guard reflects unsaved state.
 */
export function wouldCycle(
  current: string,
  candidate: string,
  graph: Map<string, Set<string>>,
): boolean {
  if (candidate === current) return true;
  const seen = new Set<string>();
  const stack = [candidate];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === current) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph.get(node) ?? []) stack.push(next);
  }
  return false;
}
