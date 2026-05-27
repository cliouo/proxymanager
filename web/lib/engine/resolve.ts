/**
 * resolveConfig — the unified pipeline from base skeleton + managed resources
 * to a final Mihomo config string.
 *
 * Stages, in order:
 *   1. Parse base.yaml as a YAML Document (comments + key order preserved).
 *   2. Strip the deprecated `pm-inline-collections` field if present and
 *      emit a warning — subscriptions now inject directly when enabled.
 *   3. For each enabled subscription: fetch (cache-aware, tolerate failures
 *      via stale-on-error), parse the `proxies:` list, optionally apply the
 *      sub's `node_prefix`, accumulate candidates with provenance.
 *   4. Dedup candidates by `name` across subs and against base's literal
 *      proxies (first writer wins). Collisions are recorded — never silent.
 *   5. Append survivors to the `proxies:` sequence (creating it if missing).
 *   6. Run renderBase on the expanded content to inject rules at anchors and
 *      referenced rule-sets at `# === RULE-PROVIDERS ===`.
 *   7. Persist a resolved-snapshot (best-effort) so cheap readers (UI
 *      pickers, AI tools) don't need to re-run the pipeline.
 *
 * Used by: /api/sub/{token}/{profile} (production output), /api/v1/preview
 * (final config view), /api/v1/base/parsed (structured projection for
 * scenario UIs incl. chained-proxy). All three see the same nodes — which
 * was the whole point of unifying the pipeline.
 */

import {
  parse as parseYaml,
  parseDocument,
  isMap,
  isScalar,
  isSeq,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { Collection, Rule, Subscription } from '@/schemas';
import {
  invalidateResolvedSnapshot,
  setResolvedSnapshot,
  type ResolvedSnapshot,
  type SnapshotCollision,
  type SnapshotPoolStatus,
  type SnapshotSubStatus,
} from '@/lib/repos/resolvedRepo';
import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import { renderBase, type RenderOptions, type RenderResult } from './renderer';

const LEGACY_INLINE_FIELD = 'pm-inline-collections';

export interface ResolveOptions extends RenderOptions {
  /** Force-refresh upstream subscriptions (bypass the fetch cache). */
  noCache?: boolean;
  /** When true (default), sub fetch failures are tolerated. */
  ignoreFailedSubs?: boolean;
  /** When false, the resolved-snapshot is not persisted. Default true. */
  persistSnapshot?: boolean;
}

export interface ResolveResult extends RenderResult {
  /** Per-sub injection status. */
  subscriptions: SnapshotSubStatus[];
  /** Cross-source name collisions. */
  collisions: SnapshotCollision[];
  /** Final node names in `proxies:` in resolution order (base first, then sub-injected survivors). */
  nodeNames: string[];
  /** Per-collection pool-group injection status. */
  pools: SnapshotPoolStatus[];
  /** Warnings, e.g. `pm-inline-collections` legacy field detected. */
  warnings: string[];
  /** Count of subscription nodes appended to `proxies:` (post-dedup). */
  inlinedProxyCount: number;
}

interface InjectionCandidate {
  node: unknown;
  name: string;
  fromSub: string;
}

export async function resolveConfig(
  baseContent: string,
  rules: Rule[],
  subscriptions: Subscription[],
  collections: Collection[],
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const doc = parseDocument(baseContent);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid base YAML: ${doc.errors[0].message}`);
  }

  const warnings: string[] = [];
  const legacyNames = readLegacyCollectionNames(doc);
  if (legacyNames.length > 0) {
    warnings.push(
      `pm-inline-collections is deprecated (${legacyNames.join(', ')}); subscriptions now inject directly when enabled. Remove this field from base.yaml.`,
    );
    doc.delete(LEGACY_INLINE_FIELD);
  }

  const baseProxyNames = new Set(readProxyNames(doc));
  const ignoreFailures = opts.ignoreFailedSubs !== false;

  const candidates: InjectionCandidate[] = [];
  const subStatuses: SnapshotSubStatus[] = [];

  for (const sub of subscriptions) {
    if (!sub.enabled) continue;
    try {
      const result = await resolveSubscriptionContent(sub, { noCache: opts.noCache });
      const proxies = extractProxies(result.yaml);
      for (const item of proxies) {
        const origName = (item as { name?: unknown }).name;
        if (typeof origName !== 'string') continue;
        const finalName = sub.node_prefix ? `${sub.node_prefix}${origName}` : origName;
        const finalNode =
          sub.node_prefix && finalName !== origName
            ? { ...(item as object), name: finalName }
            : item;
        candidates.push({ node: finalNode, name: finalName, fromSub: sub.name });
      }
      subStatuses.push({
        name: sub.name,
        // injectedCount is adjusted to post-dedup below.
        injectedCount: 0,
        stale: result.stale,
        staleReason: result.staleReason,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      subStatuses.push({ name: sub.name, injectedCount: 0, error: msg });
      if (!ignoreFailures) throw err;
    }
  }

  // Dedup across subs + base. First writer wins. Collisions never silent.
  const injectorByName = new Map<string, string>();
  const collisionMap = new Map<string, SnapshotCollision>();
  const survivors: InjectionCandidate[] = [];
  const keptPerSub = new Map<string, number>();
  /** Per-sub list of node names that survived dedup — used to build pool-groups. */
  const nodesBySub = new Map<string, string[]>();

  const recordCollision = (name: string, keptFrom: string | null, droppedFrom: string): void => {
    let entry = collisionMap.get(name);
    if (!entry) {
      entry = { name, keptFrom, droppedFrom: [] };
      collisionMap.set(name, entry);
    }
    if (!entry.droppedFrom.includes(droppedFrom)) entry.droppedFrom.push(droppedFrom);
  };

  for (const cand of candidates) {
    if (baseProxyNames.has(cand.name)) {
      recordCollision(cand.name, null, cand.fromSub);
      continue;
    }
    const firstSub = injectorByName.get(cand.name);
    if (firstSub) {
      recordCollision(cand.name, firstSub, cand.fromSub);
      continue;
    }
    injectorByName.set(cand.name, cand.fromSub);
    survivors.push(cand);
    keptPerSub.set(cand.fromSub, (keptPerSub.get(cand.fromSub) ?? 0) + 1);
    const list = nodesBySub.get(cand.fromSub) ?? [];
    list.push(cand.name);
    nodesBySub.set(cand.fromSub, list);
  }

  for (const status of subStatuses) {
    if (status.error) continue;
    status.injectedCount = keptPerSub.get(status.name) ?? 0;
  }

  if (survivors.length > 0) {
    appendProxies(doc, survivors.map((s) => s.node));
  }

  // Pool-group emission — one proxy-group per enabled Collection. Each group's
  // `proxies:` field lists the survivor node names from the collection's
  // member subs. Name collisions with existing groups (manual or chained-proxy
  // wrappers) or earlier pools are skipped + reported, never silently overwrite.
  const pools = injectCollectionPools(doc, collections, subscriptions, nodesBySub);

  const expandedContent = doc.toString();
  const rendered = renderBase(expandedContent, rules, opts);

  const nodeNames: string[] = [];
  for (const name of baseProxyNames) nodeNames.push(name);
  for (const s of survivors) nodeNames.push(s.name);

  const collisions = Array.from(collisionMap.values());

  if (opts.persistSnapshot !== false) {
    const snapshot: ResolvedSnapshot = {
      nodeNames,
      collisions,
      subscriptions: subStatuses,
      pools,
      warnings,
      computedAt: Date.now(),
      buildId: rendered.buildId,
    };
    await setResolvedSnapshot(snapshot).catch(() => undefined);
  }

  return {
    ...rendered,
    subscriptions: subStatuses,
    collisions,
    nodeNames,
    pools,
    warnings,
    inlinedProxyCount: survivors.length,
  };
}

/**
 * Resolve a Collection's member subs the same way the legacy expander did —
 * explicit `subscription_ids` (in order, dedup) + any sub matching at least
 * one tag in `subscription_tags`.
 */
function resolveCollectionMemberSubs(
  collection: Collection,
  subscriptions: Subscription[],
): Subscription[] {
  const subsById = new Map(subscriptions.map((s) => [s.id, s]));
  const out: Subscription[] = [];
  const seen = new Set<string>();
  for (const id of collection.subscription_ids) {
    const s = subsById.get(id);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  if (collection.subscription_tags.length > 0) {
    for (const s of subscriptions) {
      if (!seen.has(s.id) && s.tags.some((t) => collection.subscription_tags.includes(t))) {
        seen.add(s.id);
        out.push(s);
      }
    }
  }
  return out;
}

function injectCollectionPools(
  doc: ReturnType<typeof parseDocument>,
  collections: Collection[],
  subscriptions: Subscription[],
  nodesBySub: Map<string, string[]>,
): SnapshotPoolStatus[] {
  if (collections.length === 0) return [];
  const existingGroupNames = new Set(readGroupNames(doc));
  const out: SnapshotPoolStatus[] = [];

  for (const col of collections) {
    if (!col.enabled) {
      out.push({
        name: col.name,
        type: col.type,
        memberCount: 0,
        skipped: true,
        reason: 'collection 已停用',
      });
      continue;
    }
    if (existingGroupNames.has(col.name)) {
      out.push({
        name: col.name,
        type: col.type,
        memberCount: 0,
        skipped: true,
        reason: `proxy-group 名称 "${col.name}" 已存在(base 手写或前面 collection 注入),跳过`,
      });
      continue;
    }

    const members = resolveCollectionMemberSubs(col, subscriptions);
    const nodeNames: string[] = [];
    const seen = new Set<string>();
    for (const sub of members) {
      const subNodes = nodesBySub.get(sub.name) ?? [];
      for (const n of subNodes) {
        if (!seen.has(n)) {
          seen.add(n);
          nodeNames.push(n);
        }
      }
    }

    if (nodeNames.length === 0) {
      out.push({
        name: col.name,
        type: col.type,
        memberCount: 0,
        skipped: true,
        reason: '无可用节点(成员订阅源全部停用、为空或拉取失败)',
      });
      continue;
    }

    appendProxyGroup(doc, { name: col.name, type: col.type, proxies: nodeNames });
    existingGroupNames.add(col.name);
    out.push({ name: col.name, type: col.type, memberCount: nodeNames.length });
  }

  return out;
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

function readLegacyCollectionNames(doc: ReturnType<typeof parseDocument>): string[] {
  const node = doc.get(LEGACY_INLINE_FIELD, true);
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === 'string') out.push(item.value);
  }
  return out;
}

function readProxyNames(doc: ReturnType<typeof parseDocument>): string[] {
  const node = doc.get('proxies', true);
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (!isMap(item)) continue;
    const nameNode = (item as YAMLMap).get('name', true);
    if (isScalar(nameNode) && typeof nameNode.value === 'string') {
      out.push(nameNode.value);
    }
  }
  return out;
}

function appendProxies(doc: ReturnType<typeof parseDocument>, items: unknown[]): void {
  let node = doc.get('proxies', true);
  if (!isSeq(node)) {
    doc.set('proxies', []);
    node = doc.get('proxies', true);
  }
  const seq = node as YAMLSeq;
  for (const item of items) seq.add(item);
}

function readGroupNames(doc: ReturnType<typeof parseDocument>): string[] {
  const node = doc.get('proxy-groups', true);
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (!isMap(item)) continue;
    const nameNode = (item as YAMLMap).get('name', true);
    if (isScalar(nameNode) && typeof nameNode.value === 'string') out.push(nameNode.value);
  }
  return out;
}

function appendProxyGroup(
  doc: ReturnType<typeof parseDocument>,
  group: { name: string; type: string; proxies: string[] },
): void {
  let node = doc.get('proxy-groups', true);
  if (!isSeq(node)) {
    doc.set('proxy-groups', []);
    node = doc.get('proxy-groups', true);
  }
  (node as YAMLSeq).add(group);
}

function extractProxies(yaml: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const proxies = (parsed as { proxies?: unknown }).proxies;
  if (!Array.isArray(proxies)) return [];
  return proxies.filter(
    (p): p is Record<string, unknown> => p !== null && typeof p === 'object' && !Array.isArray(p),
  );
}

/** Convenience re-export so callers can invalidate without importing the repo directly. */
export { invalidateResolvedSnapshot };
