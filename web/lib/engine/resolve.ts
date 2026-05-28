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
 *   6. Replace the `# === PROXY-GROUPS ===` marker (if present) with the
 *      managed proxy-groups block — every ProxyGroup in the hash, merged
 *      underneath its optional ProxyGroupTemplate, ordered by `rank`.
 *   7. Run renderBase on the expanded content to inject rules at anchors and
 *      referenced rule-sets at `# === RULE-PROVIDERS ===`.
 *   8. Persist a resolved-snapshot (best-effort) so cheap readers (UI
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
  stringify as stringifyYaml,
  isMap,
  isScalar,
  isSeq,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import {
  mergeWithTemplate,
  type Collection,
  type ProxyGroup,
  type ProxyGroupTemplate,
  type Rule,
  type Subscription,
} from '@/schemas';
import {
  invalidateResolvedSnapshot,
  setResolvedSnapshot,
  type ResolvedSnapshot,
  type SnapshotCollision,
  type SnapshotSubStatus,
} from '@/lib/repos/resolvedRepo';
import { resolveSubscriptionContent } from '@/lib/services/subscriptionFetcher';
import { renderBase, type RenderOptions, type RenderResult } from './renderer';

const LEGACY_INLINE_FIELD = 'pm-inline-collections';
/** Marker line replaced by the rendered `proxy-groups:` block. */
const PROXY_GROUPS_MARKER = /^[ \t]*#\s*===\s*PROXY-GROUPS\s*===[ \t]*$/m;

export interface ResolveOptions extends RenderOptions {
  /** Force-refresh upstream subscriptions (bypass the fetch cache). */
  noCache?: boolean;
  /** When true (default), sub fetch failures are tolerated. */
  ignoreFailedSubs?: boolean;
  /** When false, the resolved-snapshot is not persisted. Default true. */
  persistSnapshot?: boolean;
  /**
   * Collections used by `kind: collection-scope` proxy-groups to resolve
   * their `proxies:` list. Defaults to []; groups bound to an unknown
   * collection id emit a warning and render with their existing fields.
   */
  collections?: Collection[];
  /**
   * Per-profile subscription binding: when non-empty, only subscriptions
   * whose id is in this set are injected. Undefined or empty falls back to
   * "every enabled subscription" — i.e. the pre-Profile behaviour.
   */
  subscriptionIds?: string[];
}

export interface ResolveResult extends RenderResult {
  /** Per-sub injection status. */
  subscriptions: SnapshotSubStatus[];
  /** Cross-source name collisions. */
  collisions: SnapshotCollision[];
  /** Final node names in `proxies:` in resolution order (base first, then sub-injected survivors). */
  nodeNames: string[];
  /** Warnings, e.g. `pm-inline-collections` legacy field detected, missing marker, unresolved template id. */
  warnings: string[];
  /** Count of subscription nodes appended to `proxies:` (post-dedup). */
  inlinedProxyCount: number;
  /** Number of proxy-groups emitted into the rendered config (from the hash, post-template-merge). */
  proxyGroupCount: number;
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
  proxyGroups: ProxyGroup[],
  templates: ProxyGroupTemplate[],
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
  // Profile binding: when non-empty, only the listed sub ids are eligible.
  const subFilter =
    opts.subscriptionIds && opts.subscriptionIds.length > 0
      ? new Set(opts.subscriptionIds)
      : null;

  for (const sub of subscriptions) {
    if (!sub.enabled) continue;
    if (subFilter && !subFilter.has(sub.id)) continue;
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
  /** Per-sub list of surviving node names — used by collection-scope kind. */
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

  let expandedContent = doc.toString();

  // Apply kind-driven bindings BEFORE rendering. single-sub builds `filter`
  // from the bound sub's node_prefix; collection-scope builds `proxies`
  // from the bound collection's member nodes. Bindings transform groups
  // in-memory only — the hash is never rewritten by resolveConfig.
  const transformedGroups = applyKindBindings(
    proxyGroups,
    subscriptions,
    opts.collections ?? [],
    nodesBySub,
    warnings,
  );

  // Inject managed proxy-groups at the marker. Hash entries are rendered in
  // `rank` order, each merged underneath its optional template (group wins,
  // template fills gaps). Groups whose `template_id` doesn't resolve still
  // render — their own fields are used as-is and a warning is recorded.
  const proxyGroupRender = renderProxyGroupsBlock(transformedGroups, templates, warnings);
  if (PROXY_GROUPS_MARKER.test(expandedContent)) {
    expandedContent = expandedContent.replace(PROXY_GROUPS_MARKER, proxyGroupRender.block);
  } else if (proxyGroups.length > 0) {
    warnings.push(
      'base.yaml 缺少 `# === PROXY-GROUPS ===` 标记;hash 中已有策略组无法注入。请先运行迁移脚本或手动插入标记。',
    );
  }

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
    warnings,
    inlinedProxyCount: survivors.length,
    proxyGroupCount: proxyGroupRender.count,
  };
}

/* ─── kind-driven bindings ──────────────────────────────────────────── */

/**
 * Transform proxy-groups in-memory based on their `kind` + binding fields.
 * Two presets need render-time resolution; the other six produce ProxyGroup
 * records whose mihomo fields already encode their intent:
 *
 *   - `kind: single-sub` + `bound_subscription_id` → set `filter` to
 *     `^<escaped node_prefix>` and `include-all-proxies: true`. The user
 *     never has to keep the regex in sync with the sub's prefix.
 *   - `kind: collection-scope` + `bound_collection_id` → set `proxies` to
 *     the surviving node names of the collection's member subs (in member
 *     sub order, then sub-internal order; deduped).
 *
 * Bindings that resolve to nothing (missing sub/collection, sub with no
 * prefix, collection with no nodes) emit a warning and leave the group's
 * fields untouched so the user can still see the group render — better
 * than a silent omission.
 */
function applyKindBindings(
  groups: ProxyGroup[],
  subscriptions: Subscription[],
  collections: Collection[],
  nodesBySub: Map<string, string[]>,
  warnings: string[],
): ProxyGroup[] {
  if (groups.length === 0) return groups;
  const subById = new Map(subscriptions.map((s) => [s.id, s]));
  const colById = new Map(collections.map((c) => [c.id, c]));

  return groups.map((g) => {
    if (g.kind === 'single-sub' && g.bound_subscription_id) {
      const sub = subById.get(g.bound_subscription_id);
      if (!sub) {
        warnings.push(
          `策略组 "${g.name}" 绑定的订阅源 ${g.bound_subscription_id} 不存在,filter 未自动生成`,
        );
        return g;
      }
      if (!sub.node_prefix) {
        warnings.push(
          `策略组 "${g.name}" 绑定的订阅源 "${sub.name}" 未设 node_prefix,无法自动生成 filter`,
        );
        return g;
      }
      // Auto filter wins over any user-typed filter — the preset owns this
      // field (the raw form would let them edit it after converting kind).
      return {
        ...g,
        filter: `^${escapeRegex(sub.node_prefix)}`,
        'include-all-proxies': true,
      };
    }

    if (g.kind === 'collection-scope' && g.bound_collection_id) {
      const col = colById.get(g.bound_collection_id);
      if (!col) {
        warnings.push(
          `策略组 "${g.name}" 绑定的聚合订阅 ${g.bound_collection_id} 不存在,proxies 未自动生成`,
        );
        return g;
      }
      const members = resolveCollectionMemberSubs(col, subscriptions);
      const nodes: string[] = [];
      const seen = new Set<string>();
      for (const sub of members) {
        for (const n of nodesBySub.get(sub.name) ?? []) {
          if (!seen.has(n)) {
            seen.add(n);
            nodes.push(n);
          }
        }
      }
      if (nodes.length === 0) {
        warnings.push(
          `策略组 "${g.name}" 绑定的聚合订阅 "${col.name}" 当前无可用节点(成员订阅源全部停用、为空或拉取失败)`,
        );
        return g;
      }
      return { ...g, proxies: nodes };
    }

    return g;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

/* ─── proxy-group rendering ─────────────────────────────────────────── */

interface ProxyGroupBlockRender {
  block: string;
  count: number;
}

/**
 * Build the `proxy-groups:` YAML block from the managed hash. Groups render
 * in `rank` order; ties broken by name for determinism. Each group is
 * merged underneath its optional template at emit time — see
 * `mergeWithTemplate` for the merge contract.
 *
 * Empty hash → empty string (the marker just disappears). Unresolved
 * template id → emit the group as-is and append a warning.
 */
function renderProxyGroupsBlock(
  groups: ProxyGroup[],
  templates: ProxyGroupTemplate[],
  warnings: string[],
): ProxyGroupBlockRender {
  if (groups.length === 0) return { block: '', count: 0 };

  const tplById = new Map(templates.map((t) => [t.id, t]));
  const ordered = [...groups].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });

  const seenName = new Set<string>();
  const emitted: Record<string, unknown>[] = [];
  for (const g of ordered) {
    if (seenName.has(g.name)) {
      // Duplicate names in the hash should already be blocked by the
      // service layer; emit the first occurrence and warn.
      warnings.push(`proxy-group 名称 "${g.name}" 在 hash 中重复,只渲染第一条`);
      continue;
    }
    seenName.add(g.name);

    let template: ProxyGroupTemplate | null = null;
    if (g.template_id) {
      const tpl = tplById.get(g.template_id);
      if (!tpl) {
        warnings.push(
          `策略组 "${g.name}" 引用模板 ${g.template_id} 不存在,按无模板渲染`,
        );
      } else {
        template = tpl;
      }
    }
    emitted.push(mergeWithTemplate(g, template));
  }

  const block = stringifyYaml({ 'proxy-groups': emitted }).trimEnd();
  return { block, count: emitted.length };
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
