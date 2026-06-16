/**
 * resolveConfig — the unified pipeline from base skeleton + managed resources
 * to a final Mihomo config string.
 *
 * Stages, in order:
 *   1. Parse base.yaml as a YAML Document (comments + key order preserved).
 *   2. Strip the deprecated `pm-inline-collections` field if present and
 *      emit a warning — subscriptions now inject directly when enabled.
 *   3. For each enabled subscription: fetch in parallel (bounded concurrency,
 *      cache-aware, tolerate failures via stale-on-error), then consume the
 *      already-parsed proxy objects strictly in subscription order, accumulate
 *      candidates with provenance (each sub's own operator pipeline already ran
 *      at fetch). When the profile is bound to a 聚合订阅 that has its own
 *      operators, run them over the merged member candidates.
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
  type ProfileSource,
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
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import type { Operator } from '@/schemas';
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
   * Per-profile single-source binding. `undefined` (no profile record) keeps
   * the pre-Profile behaviour of injecting every enabled subscription;
   * `{type:'none'}` is an explicit unbound profile → inject nothing;
   * `subscription` limits to one sub; `collection` expands to that 聚合订阅's
   * members. A dangling collection id injects nothing and emits a warning.
   */
  boundSource?: ProfileSource;
}

export interface ResolveResult extends RenderResult {
  /** Per-sub injection status. */
  subscriptions: SnapshotSubStatus[];
  /** Cross-source name collisions. */
  collisions: SnapshotCollision[];
  /** Final node names in `proxies:` in resolution order (base first, then sub-injected survivors). */
  nodeNames: string[];
  /**
   * Surviving (post-dedup) node names grouped by the subscription that
   * injected them, keyed by `sub.name`. Authoritative per-sub attribution for
   * single-sub group bindings and the member picker (replaces prefix-guessing).
   */
  nodesBySub: Record<string, string[]>;
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

/** 同时在途的上游订阅 fetch 上限。 */
const SUB_FETCH_CONCURRENCY = 8;

/**
 * 简易内联并发池:最多 `limit` 个 worker 抢占式消费 items,结果按输入下标
 * 落位(PromiseSettledResult 形状),调用方可以按原序消费成功/失败——这正是
 * 注入链路的确定性契约所需要的。单一用途,不值得为它引 p-limit 之类的依赖。
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // JS 单线程:check + 自增之间没有 await,不存在两个 worker 抢到同一下标。
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
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

  let candidates: InjectionCandidate[] = [];
  const subStatuses: SnapshotSubStatus[] = [];
  // Profile binding: resolve the single-source into an eligible-sub-id set.
  // `null` means "no filter" → every enabled subscription (only when there's
  // no profile record at all). An explicit `{type:'none'}` injects nothing.
  let subFilter: Set<string> | null = null;
  const boundSource = opts.boundSource;
  if (boundSource && boundSource.type === 'none') {
    subFilter = new Set();
  } else if (boundSource && boundSource.type === 'subscription') {
    subFilter = new Set([boundSource.id]);
  } else if (boundSource && boundSource.type === 'collection') {
    const col = (opts.collections ?? []).find((c) => c.id === boundSource.id);
    if (!col) {
      warnings.push(`profile 绑定的聚合订阅不存在 (${boundSource.id}); 未注入任何订阅节点。`);
      subFilter = new Set();
    } else {
      subFilter = new Set(resolveCollectionMemberSubs(col, subscriptions).map((s) => s.id));
    }
  }

  // 先按原数组顺序筛出待注入的订阅,再并行 fetch(限并发 8)。每次上游
  // HTTP 最长 15s 超时,串行 N 个订阅最坏要 N×15s — 并行后整体耗时只由
  // 最慢的一条决定。fetch 完全 settle 后再按原序消费,确定性不受影响。
  const eligibleSubs = subscriptions.filter(
    (sub) => sub.enabled && (!subFilter || subFilter.has(sub.id)),
  );
  const settled = await settleWithConcurrency(eligibleSubs, SUB_FETCH_CONCURRENCY, (sub) =>
    resolveSubscriptionProxies(sub, { noCache: opts.noCache }),
  );

  // 严格按原订阅顺序处理结果:candidates 累积顺序、subStatuses 顺序、去重的
  // first-writer-wins 都依赖这份顺序契约——必须与旧串行版逐项一致(有测试盯着)。
  for (let i = 0; i < eligibleSubs.length; i++) {
    const sub = eligibleSubs[i];
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      const msg = err instanceof Error ? err.message : String(err);
      subStatuses.push({ name: sub.name, injectedCount: 0, error: msg });
      // 不容忍失败时抛"按原顺序遇到的第一个失败"——并行下其余 fetch 的
      // 结果直接丢弃,错误语义与串行版保持一致。
      if (!ignoreFailures) throw err;
      continue;
    }
    const result = outcome.value;
    for (const item of result.proxies) {
      const name = (item as { name?: unknown }).name;
      if (typeof name !== 'string') continue;
      candidates.push({ node: item, name, fromSub: sub.name });
    }
    subStatuses.push({
      name: sub.name,
      // injectedCount is adjusted to post-dedup below.
      injectedCount: 0,
      stale: result.stale,
      staleReason: result.staleReason,
    });
  }

  // 聚合订阅级 operators:当整份配置绑定到某个 collection 时,合并完成员节点
  // 后,对这批节点整体再跑一遍该聚合自己的处理流水线(与单订阅同一套算子,
  // 只是作用在并集上)。renamed 节点的来源归属按处理前的名字尽力还原。
  if (boundSource?.type === 'collection') {
    const col = (opts.collections ?? []).find((c) => c.id === boundSource.id);
    if (col && col.operators.length > 0 && candidates.length > 0) {
      candidates = applyOperatorsToCandidates(candidates, col.operators);
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
    appendProxies(
      doc,
      survivors.map((s) => s.node),
    );
  }

  // Realize chained-proxy wraps as cloned `proxies:` entries. A proxy-group
  // can't carry `dialer-proxy` — mihomo ignores it (Meta-Docs: "proxy-group
  // 并不直接支持 dialer-proxy"). The *value* may reference a group, but the
  // field must live on a `proxies:` entry. So for each wrap (single member +
  // dialer-proxy) we clone the backend node, rename it to the wrap's name and
  // attach dialer-proxy — yielding a real outbound that dials through the
  // front. The wrap is then dropped from the proxy-groups block.
  const chainWrapNames = realizeChainWraps(doc, proxyGroups, warnings);

  let expandedContent = doc.toString();

  // Apply kind-driven bindings BEFORE rendering. single-sub and
  // collection-scope both build `proxies` from the bound resource's member
  // nodes (computed this render in `nodesBySub`). Bindings transform groups
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
  const groupsToRender = transformedGroups.filter((g) => !chainWrapNames.has(g.name));
  const proxyGroupRender = renderProxyGroupsBlock(
    groupsToRender,
    templates,
    chainWrapNames,
    warnings,
  );
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
  for (const name of chainWrapNames) nodeNames.push(name);

  const collisions = Array.from(collisionMap.values());

  if (opts.persistSnapshot !== false) {
    const snapshot: ResolvedSnapshot = {
      nodeNames,
      collisions,
      subscriptions: subStatuses,
      warnings,
      // 概览等轻读者靠这两个字段免跑渲染管线就能给出告警摘要。
      unmatchedAnchors: rendered.unmatchedAnchors,
      anchorsApplied: rendered.anchorsApplied.length,
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
    nodesBySub: Object.fromEntries(nodesBySub),
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
 *   - `kind: single-sub` + `bound_subscription_id` → set `proxies` to the
 *     bound sub's surviving node names (computed this render in `nodesBySub`).
 *     The user never has to maintain a regex; membership tracks the real set.
 *   - `kind: collection-scope` + `bound_collection_id` → set `proxies` to
 *     the surviving node names of the collection's member subs (in member
 *     sub order, then sub-internal order; deduped).
 *
 * Bindings that resolve to nothing (missing sub/collection, sub with no
 * surviving nodes, collection with no nodes) emit a warning and leave the
 * group's fields untouched so the user can still see the group render —
 * better than a silent omission.
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
          `策略组 "${g.name}" 绑定的订阅源 ${g.bound_subscription_id} 不存在,成员未自动生成`,
        );
        return g;
      }
      // 直接列出该订阅源注入存活的节点名(去前缀后,名字不再带可过滤的统一
      // 前缀,改用渲染时算出的真实成员集)。空集时给告警、保留原字段。
      const nodes = nodesBySub.get(sub.name) ?? [];
      if (nodes.length === 0) {
        warnings.push(`策略组 "${g.name}" 绑定的订阅源 "${sub.name}" 当前无可用节点,成员为空`);
        return g;
      }
      return { ...g, proxies: nodes };
    }

    // collection-scope binding deprecated: any pre-migration `bound_collection_id`
    // is still tolerated as data, but the kind enum no longer carries
    // 'collection-scope' (schema preprocess maps it to 'manual'). Groups that
    // still have a stale bound_collection_id render as-is — no auto-injection.
    if (g.bound_collection_id) {
      const col = colById.get(g.bound_collection_id);
      if (col) {
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
        if (nodes.length > 0) return { ...g, proxies: nodes };
      }
    }

    return g;
  });
}

/**
 * Run a 聚合订阅's operator pipeline over its merged member candidates. The
 * pipeline may rename / drop / reorder nodes, so per-sub provenance (`fromSub`,
 * which feeds single-sub group bindings + the picker) is restored best-effort:
 * by matching each surviving node's name back to its pre-pipeline source, with
 * renamed/new nodes attributed to the first member so counts still add up.
 */
function applyOperatorsToCandidates(
  candidates: InjectionCandidate[],
  operators: Operator[],
): InjectionCandidate[] {
  const nameToSub = new Map<string, string>();
  for (const c of candidates) if (!nameToSub.has(c.name)) nameToSub.set(c.name, c.fromSub);
  const fallbackSub = candidates[0]?.fromSub ?? '';
  const { proxies } = applyOperators(
    candidates.map((c) => c.node as ClashProxy),
    operators,
  );
  const out: InjectionCandidate[] = [];
  for (const node of proxies) {
    const name = (node as { name?: unknown }).name;
    if (typeof name !== 'string') continue;
    out.push({ node, name, fromSub: nameToSub.get(name) ?? fallbackSub });
  }
  return out;
}

export function resolveCollectionMemberSubs(
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

/* ─── chained-proxy realization ─────────────────────────────────────── */

/**
 * Read a proxy entry's `name`, whether it's a parsed `YAMLMap` (base.yaml
 * literals) or a plain JS object (subscription-injected nodes appended via
 * appendProxies — these are NOT yaml Nodes, so `isMap` is false for them).
 */
function proxyEntryName(item: unknown): string | undefined {
  if (isMap(item)) {
    const n = item.get('name', true);
    return isScalar(n) && typeof n.value === 'string' ? n.value : undefined;
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const n = (item as { name?: unknown }).name;
    if (typeof n === 'string') return n;
  }
  return undefined;
}

/**
 * Translate chained-proxy "wrap" groups into cloned `proxies:` entries and
 * return the set of wrap names so the caller can drop them from the
 * proxy-groups block.
 *
 * A wrap is a managed group with `dialer-proxy` set and exactly one member
 * (the backend). We deep-clone the backend's proxy node, rename the clone to
 * the wrap's name and attach `dialer-proxy: <front>`. The front may be a
 * proxy-group (e.g. a smart pool) — that's allowed as a *value*. Multi-member
 * groups carrying dialer-proxy can't be cloned cleanly; they're warned about
 * and left as-is (the field stays a no-op, but at least nothing is dropped).
 */
function realizeChainWraps(
  doc: ReturnType<typeof parseDocument>,
  groups: ProxyGroup[],
  warnings: string[],
): Set<string> {
  const realized = new Set<string>();
  const wraps: ProxyGroup[] = [];
  for (const g of groups) {
    if (!g['dialer-proxy']) continue;
    if ((g.proxies?.length ?? 0) === 1) {
      wraps.push(g);
    } else {
      warnings.push(
        `策略组 "${g.name}" 设了 dialer-proxy 但成员数≠1;mihomo 不支持在策略组上用 dialer-proxy,已忽略。`,
      );
    }
  }
  if (wraps.length === 0) return realized;

  let seqNode = doc.get('proxies', true);
  if (!isSeq(seqNode)) {
    doc.set('proxies', []);
    seqNode = doc.get('proxies', true);
  }
  const proxiesSeq = seqNode as YAMLSeq;

  // name → backing entry for every concrete proxy currently in the doc.
  // Entries are either YAMLMap (base literals) or plain objects (injected).
  const nodeByName = new Map<string, unknown>();
  for (const item of proxiesSeq.items) {
    const nm = proxyEntryName(item);
    if (nm) nodeByName.set(nm, item);
  }
  const existingNames = new Set(nodeByName.keys());

  for (const wrap of wraps) {
    const backend = wrap.proxies![0];
    const front = wrap['dialer-proxy']!;
    const backendNode = nodeByName.get(backend);
    if (backendNode === undefined) {
      warnings.push(
        `链式代理 "${wrap.name}" 的后端 "${backend}" 不是具体节点(可能是策略组或当前不存在),无法克隆为出站,已跳过。`,
      );
      continue;
    }
    if (existingNames.has(wrap.name)) {
      warnings.push(`链式代理 "${wrap.name}" 与已有节点重名,跳过克隆以免冲突。`);
      continue;
    }
    // Clone the backend, override name + attach dialer-proxy. Handle both a
    // parsed YAMLMap and a plain injected object.
    let clone: unknown;
    if (isMap(backendNode)) {
      const m = backendNode.clone() as YAMLMap;
      m.set('name', wrap.name);
      m.set('dialer-proxy', front);
      clone = m;
    } else {
      clone = {
        ...(backendNode as Record<string, unknown>),
        name: wrap.name,
        'dialer-proxy': front,
      };
    }
    proxiesSeq.add(clone);
    existingNames.add(wrap.name);
    realized.add(wrap.name);
  }
  return realized;
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
  chainCloneNames: Set<string>,
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
        warnings.push(`策略组 "${g.name}" 引用模板 ${g.template_id} 不存在,按无模板渲染`);
      } else {
        template = tpl;
      }
    }
    const map = mergeWithTemplate(g, template);
    excludeChainClonesFromIncludeAll(map, chainCloneNames);
    emitted.push(map);
  }

  const block = stringifyYaml({ 'proxy-groups': emitted }).trimEnd();
  return { block, count: emitted.length };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Chain clones live in `proxies:` (see realizeChainWraps), so any group with
 * `include-all-proxies` would otherwise pull them in — polluting "all nodes"
 * pools and, worse, looping a smart front pool back through a chain that dials
 * *through that pool*. Drop them via `exclude-filter` (anchored, regex-escaped;
 * combined with any user filter). No-op for groups that don't include-all.
 */
function excludeChainClonesFromIncludeAll(
  group: Record<string, unknown>,
  cloneNames: Set<string>,
): void {
  if (cloneNames.size === 0) return;
  if (group['include-all-proxies'] !== true && group['include-all'] !== true) return;
  const ours = [...cloneNames].map((n) => `^${escapeRegExp(n)}$`).join('|');
  const existing = typeof group['exclude-filter'] === 'string' ? group['exclude-filter'] : '';
  group['exclude-filter'] = existing ? `(?:${existing})|${ours}` : ours;
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

/** Convenience re-export so callers can invalidate without importing the repo directly. */
export { invalidateResolvedSnapshot };
