/**
 * Find where a node name is referenced across the managed config. Used to warn
 * before a rename (operator / local-node) orphans something: a node pinned by
 * name into a chained-proxy backend, a proxy-group's manual members, or a
 * rule's policy will dangle the moment that node is renamed or dropped, and a
 * dangling reference crashes mihomo on load (the chained-proxy backend case is
 * the sharpest — see resolve's broken-wrap pruning for the render-side net).
 */

import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listRules } from '@/lib/repos/rulesRepo';

export type NodeReferenceKind = 'chain-backend' | 'proxy-group-member' | 'rule-policy';

export interface NodeReference {
  /** The referenced node name. */
  node: string;
  kind: NodeReferenceKind;
  /** Human handle for the referrer: group name, or `type,value` for a rule. */
  via: string;
}

/**
 * Scan proxy-groups (manual members + chain-wrap backends) and rules (policy)
 * for any of `names`. Returns one entry per reference. Empty input → no reads.
 */
export async function findNodeReferences(names: string[]): Promise<NodeReference[]> {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  const [groups, rules] = await Promise.all([listProxyGroups(), listRules()]);
  const refs: NodeReference[] = [];

  for (const g of groups) {
    // A chain wrap = dialer-proxy set + exactly one member (the backend node).
    const isChainWrap = !!g['dialer-proxy'] && (g.proxies?.length ?? 0) === 1;
    for (const p of g.proxies ?? []) {
      if (wanted.has(p)) {
        refs.push({
          node: p,
          kind: isChainWrap ? 'chain-backend' : 'proxy-group-member',
          via: g.name,
        });
      }
    }
  }

  for (const r of rules) {
    if (wanted.has(r.policy)) {
      refs.push({ node: r.policy, kind: 'rule-policy', via: `${r.type}${r.value ? `,${r.value}` : ''}` });
    }
  }

  return refs;
}
