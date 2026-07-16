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
  assertMergedRuleRenderable,
  mergeWithTemplate,
  ProxyGroupExcludeTypeSchema,
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
import { compileGoRegex } from '@/lib/proxies/filterMatch';
import { ipLiteralFamily } from '@/lib/net/ipLiteral';
import { MAX_PROXY_NODES, validateMihomoProxyList } from '@/lib/proxies/mihomoProxyValidator';
import type { Operator } from '@/schemas';
import { parseBaseDocument } from './parser';
import {
  referencedProviderNames,
  referencedProviderNamesInColonList,
  referencedProviderNamesInText,
  renderBase,
  type RenderOptions,
  type RenderResult,
} from './renderer';
import { collectRuleSetReferencesFromRuleLine } from './ruleSetReferences';

const LEGACY_INLINE_FIELD = 'pm-inline-collections';
/** Marker line replaced by the rendered `proxy-groups:` block. */
const PROXY_GROUPS_MARKER = /^[ \t]*#\s*===\s*PROXY-GROUPS\s*===[ \t]*$/m;
/** Marker line replaced by the rendered `rule-providers:` block. */
const RULE_PROVIDERS_MARKER = /^[ \t]*#\s*===\s*RULE-PROVIDERS\s*===[ \t]*$/m;
const FIXED_BUILTIN_PROXY_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'COMPATIBLE',
  'PASS',
  'PASS-RULE',
]);
const FIXED_PROXY_GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance']);
const FIXED_PROXY_GROUP_FIELDS = new Set([
  'name',
  'type',
  'proxies',
  'use',
  'url',
  'interval',
  'timeout',
  'max-failed-times',
  'empty-fallback',
  'lazy',
  'disable-udp',
  'filter',
  'exclude-filter',
  'exclude-type',
  'expected-status',
  'include-all',
  'include-all-proxies',
  'include-all-providers',
  'hidden',
  'icon',
  'tolerance',
  'default-selected',
  'strategy',
]);
const FIXED_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'GEOIP',
  'SRC-GEOIP',
  'IP-ASN',
  'SRC-IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'DSCP',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'NETWORK',
  'UID',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'REMATCH-NAME',
  'SUB-RULE',
  'AND',
  'OR',
  'NOT',
  'RULE-SET',
  'MATCH',
]);
const RULE_TYPES_WITH_COMMA_PAYLOAD = new Set([
  'NOT',
  'OR',
  'AND',
  'SUB-RULE',
  'DOMAIN-REGEX',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
]);
const FINAL_RULE_PARAM_TYPES = new Set([
  'GEOIP',
  'IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'RULE-SET',
]);
const FINAL_RULE_REGEX_TYPES = new Set([
  'DOMAIN-REGEX',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
]);
const FINAL_RULE_IP_PREFIX_TYPES = new Set([
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
]);
const FINAL_RULE_PORT_TYPES = new Set(['SRC-PORT', 'DST-PORT', 'IN-PORT']);
const FINAL_RULE_LOGIC_TYPES = new Set(['NOT', 'OR', 'AND']);
const FINAL_RULE_IN_TYPES = new Set([
  'HTTP',
  'HTTPS',
  'SOCKS4',
  'SOCKS5',
  'SOCKS',
  'SHADOWSOCKS',
  'SNELL',
  'VMESS',
  'VLESS',
  'REDIR',
  'TPROXY',
  'TROJAN',
  'TUNNEL',
  'TUN',
  'TUIC',
  'HYSTERIA2',
  'ANYTLS',
  'MIERU',
  'SUDOKU',
  'TRUSTTUNNEL',
  'INNER',
]);
const MAX_FINAL_RULE_LENGTH = 8_192;
const MAX_FINAL_LOGIC_DEPTH = 16;

export interface ResolveOptions extends RenderOptions {
  /** Force-refresh upstream subscriptions (bypass the fetch cache). */
  noCache?: boolean;
  /** When true (default), sub fetch failures are tolerated. */
  ignoreFailedSubs?: boolean;
  /** When false, the resolved-snapshot is not persisted. Default true. */
  persistSnapshot?: boolean;
  /**
   * Profile id this render belongs to. The resolved-snapshot is keyed by it so
   * concurrent renders of different profiles (incl. public /api/sub polling)
   * don't clobber each other's node lists. When absent, no snapshot is written
   * (direct engine callers / tests that don't care). See P2-5.
   */
  snapshotProfileId?: string;
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
export async function* settleWithConcurrencyInOrder<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<PromiseSettledResult<R>> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Concurrency limit is invalid');
  const pending = new Map<number, Promise<PromiseSettledResult<R>>>();
  let nextToLaunch = 0;
  const launch = (): void => {
    if (nextToLaunch >= items.length) return;
    const index = nextToLaunch++;
    pending.set(
      index,
      Promise.resolve()
        .then(() => fn(items[index]))
        .then<PromiseSettledResult<R>, PromiseSettledResult<R>>(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        ),
    );
  };
  while (pending.size < Math.min(limit, items.length)) launch();
  for (let index = 0; index < items.length; index++) {
    const result = await pending.get(index)!;
    pending.delete(index);
    launch();
    yield result;
  }
}

export async function resolveConfig(
  baseContent: string,
  rules: Rule[],
  subscriptions: Subscription[],
  proxyGroups: ProxyGroup[],
  templates: ProxyGroupTemplate[],
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  // Stored/imported rules can predate the current write schema. Validate the
  // structured fields before rendering them into an ambiguous comma-delimited
  // line; once rendered, a regex payload and a policy/option reorder can be
  // byte-identical and no final-text parser can recover the user's intent.
  for (const rule of rules) {
    if (rule.enabled !== false) assertMergedRuleRenderable(rule);
  }
  const doc = parseBaseDocument(baseContent);

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
    const boundSub = subscriptions.find((sub) => sub.id === boundSource.id && sub.enabled);
    if (!boundSub) {
      throw new Error(
        'Full config render rejected: the profile-bound subscription is missing or disabled.',
      );
    }
    subFilter = new Set([boundSource.id]);
  } else if (boundSource && boundSource.type === 'collection') {
    const col = (opts.collections ?? []).find((c) => c.id === boundSource.id);
    if (!col) {
      throw new Error('Full config render rejected: the profile-bound collection is missing.');
    } else {
      const memberIds = resolveCollectionMemberSubs(col, subscriptions)
        .filter((sub) => sub.enabled)
        .map((sub) => sub.id);
      if (memberIds.length === 0) {
        throw new Error(
          'Full config render rejected: the profile-bound collection has no enabled members.',
        );
      }
      subFilter = new Set(memberIds);
    }
  }

  // 先按原数组顺序筛出待注入的订阅,再并行 fetch(限并发 8)。每次上游
  // HTTP 最长 15s 超时,串行 N 个订阅最坏要 N×15s — 并行后整体耗时只由
  // 最慢的一条决定。fetch 完全 settle 后再按原序消费,确定性不受影响。
  const eligibleSubs = subscriptions.filter(
    (sub) => sub.enabled && (!subFilter || subFilter.has(sub.id)),
  );
  // 严格按原订阅顺序处理结果:candidates 累积顺序、subStatuses 顺序、去重的
  // first-writer-wins 都依赖这份顺序契约——必须与旧串行版逐项一致(有测试盯着)。
  let i = 0;
  for await (const outcome of settleWithConcurrencyInOrder(
    eligibleSubs,
    SUB_FETCH_CONCURRENCY,
    (sub) => resolveSubscriptionProxies(sub, { noCache: opts.noCache }),
  )) {
    const sub = eligibleSubs[i];
    i += 1;
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
    if (candidates.length + result.proxies.length > MAX_PROXY_NODES) {
      throw new Error(
        `Full config render rejected: aggregate subscription candidates exceed ${MAX_PROXY_NODES}.`,
      );
    }
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
      try {
        candidates = applyOperatorsToCandidates(candidates, col.operators);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Never substitute the unprocessed candidates. That would turn a
        // configured filter/rename failure into a successful-looking full
        // config with a materially different node set, then cache it.
        throw new Error(`Collection operator pipeline failed: ${msg}`);
      }
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

  // Cross-source duplicate names are resolved by the documented
  // first-writer-wins contract above. Validate the actual emitted set only;
  // validating the merged pre-dedup candidates would reject legitimate
  // collisions before that deterministic policy can run.
  validateMihomoProxyList(
    survivors.map((candidate) => candidate.node),
    {
      // A final node may deliberately chain to a base node. References among
      // emitted nodes are still cycle-checked; only absent targets are deferred
      // to the complete base+subscription Mihomo document.
      allowExternalDialerProxy: true,
    },
  );

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
  const chainWrapNames = realizeChainWraps(doc, proxyGroups);

  // The base, every subscription and each chain clone were produced through
  // different stages. Revalidate the one list Mihomo will actually receive so
  // split inputs cannot bypass the global node/port budgets, duplicate-name
  // check, or dialer-proxy cycle detection.
  validateFinalProxyDocument(doc);

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
  );

  // Inject managed proxy-groups at the marker. Hash entries are rendered in
  // `rank` order, each merged underneath its optional template (group wins,
  // template fills gaps). Missing templates and duplicate names fail closed.
  const groupsToRender = transformedGroups.filter((g) => !chainWrapNames.has(g.name));
  const proxyGroupRender = renderProxyGroupsBlock(groupsToRender, templates, chainWrapNames);
  if (PROXY_GROUPS_MARKER.test(expandedContent)) {
    expandedContent = expandedContent.replace(PROXY_GROUPS_MARKER, proxyGroupRender.block);
  } else if (proxyGroupRender.count > 0) {
    throw new Error(
      'Full config render rejected: base.yaml is missing the PROXY-GROUPS marker required by managed proxy groups.',
    );
  }

  const referencedRuleSets = referencedProviderNames(
    rules.filter((rule) => rule.enabled !== false),
  );
  for (const name of readBaseRuleSetReferences(doc)) {
    referencedRuleSets.add(name);
  }
  const availableRuleSets = new Set((opts.providers ?? []).map((provider) => provider.name));
  if ([...referencedRuleSets].some((name) => !availableRuleSets.has(name))) {
    throw new Error(
      'Full config render rejected: a final rule-set reference is absent from the rule-set library.',
    );
  }
  if (referencedRuleSets.size > 0 && !RULE_PROVIDERS_MARKER.test(expandedContent)) {
    throw new Error(
      'Full config render rejected: base.yaml is missing the RULE-PROVIDERS marker required by a final rule-set reference.',
    );
  }

  const rendered = renderBase(expandedContent, rules, opts);
  validateFinalRenderedConfig(rendered.content);

  const nodeNames: string[] = [];
  for (const name of baseProxyNames) nodeNames.push(name);
  for (const s of survivors) nodeNames.push(s.name);
  for (const name of chainWrapNames) nodeNames.push(name);

  const collisions = Array.from(collisionMap.values());

  if (opts.persistSnapshot !== false && opts.snapshotProfileId) {
    const snapshot: ResolvedSnapshot = {
      profileId: opts.snapshotProfileId,
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
    await setResolvedSnapshot(opts.snapshotProfileId, snapshot).catch(() => undefined);
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
 * Bindings that resolve to nothing fail the render. Substituting DIRECT or a
 * stale member list would silently change the configured routing policy.
 */
function applyKindBindings(
  groups: ProxyGroup[],
  subscriptions: Subscription[],
  collections: Collection[],
  nodesBySub: Map<string, string[]>,
): ProxyGroup[] {
  if (groups.length === 0) return groups;
  const subById = new Map(subscriptions.map((s) => [s.id, s]));
  const colById = new Map(collections.map((c) => [c.id, c]));

  return groups.map((g) => {
    if (g.kind === 'single-sub' && g.bound_subscription_id) {
      const sub = subById.get(g.bound_subscription_id);
      if (!sub) {
        throw new Error(
          'Full config render rejected: a single-sub proxy-group binding is missing.',
        );
      }
      // Directly use the surviving names computed in this render. An empty
      // result is rejected below rather than changed to another route.
      const nodes = nodesBySub.get(sub.name) ?? [];
      if (nodes.length === 0) {
        throw new Error(
          'Full config render rejected: a single-sub proxy-group has no surviving nodes.',
        );
      }
      return { ...g, proxies: nodes };
    }

    // collection-scope binding deprecated: any pre-migration `bound_collection_id`
    // is still tolerated as data, but the kind enum no longer carries
    // 'collection-scope' (schema preprocess maps it to 'manual'). Groups that
    // still have a stale bound_collection_id render as-is — no auto-injection.
    if (g.bound_collection_id) {
      const col = colById.get(g.bound_collection_id);
      if (!col) {
        throw new Error(
          'Full config render rejected: a legacy collection proxy-group binding is missing.',
        );
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
        throw new Error(
          'Full config render rejected: a legacy collection proxy-group has no surviving nodes.',
        );
      }
      return { ...g, proxies: nodes };
    }

    return g;
  });
}

/**
 * Run a 聚合订阅's operator pipeline over its merged member candidates. The
 * pipeline may rename / drop / reorder nodes, so per-sub provenance (`fromSub`,
 * which feeds single-sub group bindings + the picker) is carried on an
 * enumerable Symbol. Object spread preserves enumerable symbols across every
 * name/attribute transform, while YAML/Object.entries never serialise it.
 */
const COLLECTION_PROVENANCE = Symbol('collection-provenance');

function applyOperatorsToCandidates(
  candidates: InjectionCandidate[],
  operators: Operator[],
): InjectionCandidate[] {
  const { proxies } = applyOperators(
    candidates.map((candidate) => ({
      ...(candidate.node as ClashProxy),
      [COLLECTION_PROVENANCE]: candidate.fromSub,
    })),
    operators,
  );
  const out: InjectionCandidate[] = [];
  for (const node of proxies) {
    const name = (node as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('Invalid collection operator output: field "name" must be non-empty');
    }
    const fromSub = (node as ClashProxy & { [COLLECTION_PROVENANCE]?: unknown })[
      COLLECTION_PROVENANCE
    ];
    if (typeof fromSub !== 'string' || fromSub === '') {
      throw new Error('Invalid collection operator output: node provenance was lost');
    }
    delete (node as ClashProxy & { [COLLECTION_PROVENANCE]?: unknown })[COLLECTION_PROVENANCE];
    out.push({ node, name, fromSub });
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

function proxyEntryHasDialerProxy(item: unknown): boolean {
  if (isMap(item)) return item.has('dialer-proxy');
  return Boolean(
    item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, 'dialer-proxy'),
  );
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
 * groups carrying dialer-proxy cannot be represented and therefore fail
 * closed instead of rendering a successful-looking no-op.
 */
function realizeChainWraps(
  doc: ReturnType<typeof parseDocument>,
  groups: ProxyGroup[],
): Set<string> {
  const realized = new Set<string>();
  const wraps: ProxyGroup[] = [];
  for (const g of groups) {
    if (!g['dialer-proxy']) continue;
    if ((g.proxies?.length ?? 0) === 1) {
      wraps.push(g);
    } else {
      throw new Error(
        'Full config render rejected: a chained proxy must have exactly one backend member.',
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
      throw new Error(
        'Full config render rejected: a chained proxy backend is missing or is not a concrete proxy.',
      );
    }
    if (proxyEntryHasDialerProxy(backendNode)) {
      throw new Error(
        'Full config render rejected: a chained proxy backend already has dialer-proxy; implicit multi-hop overwrite is forbidden.',
      );
    }
    if (existingNames.has(wrap.name)) {
      throw new Error(
        'Full config render rejected: a chained proxy name collides with an existing proxy.',
      );
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
 * Empty hash → empty string (the marker just disappears). Unresolved template
 * ids and duplicate names fail closed instead of changing routing semantics.
 */
function renderProxyGroupsBlock(
  groups: ProxyGroup[],
  templates: ProxyGroupTemplate[],
  chainCloneNames: Set<string>,
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
      throw new Error('Full config render rejected: managed proxy-group names are duplicated.');
    }
    seenName.add(g.name);

    let template: ProxyGroupTemplate | null = null;
    if (g.template_id) {
      const tpl = tplById.get(g.template_id);
      if (!tpl) {
        throw new Error('Full config render rejected: a managed proxy-group template is missing.');
      } else {
        template = tpl;
      }
    }
    const map = mergeWithTemplate(g, template);
    excludeChainClonesFromIncludeAll(map, chainCloneNames);
    ensureFailClosedEmptyFallback(map);
    // A configured member source disappearing is a semantic failure, not an
    // availability hint. Substituting DIRECT would bypass the user's routing
    // policy while producing a successful-looking downloadable config.
    if (!groupHasMemberSource(map)) {
      throw new Error(
        'Full config render rejected: a managed proxy-group has no final member source.',
      );
    }
    emitted.push(map);
  }

  const block = stringifyYaml({ 'proxy-groups': emitted }).trimEnd();
  return { block, count: emitted.length };
}

/**
 * Chain wraps are emitted as concrete top-level proxies, so Mihomo's
 * include-all-proxies/include-all groups would otherwise pull them back into
 * every dynamic pool. That can create a real loop when a clone dials through
 * the same pool. Mihomo treats a backtick as a separator between independent
 * exclude patterns, so preserve every existing pattern verbatim and append
 * the generated anchored alternation as one additional pattern.
 */
function excludeChainClonesFromIncludeAll(
  group: Record<string, unknown>,
  cloneNames: Set<string>,
): void {
  if (cloneNames.size === 0) return;
  if (group['include-all-proxies'] !== true && group['include-all'] !== true) return;
  const ours = [...cloneNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `^${escapeRegExp(name)}$`)
    .join('|');
  const existing = typeof group['exclude-filter'] === 'string' ? group['exclude-filter'] : '';
  group['exclude-filter'] = existing ? `${existing}\`${ours}` : ours;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureFailClosedEmptyFallback(group: Record<string, unknown>): void {
  const explicitMembers = Array.isArray(group.proxies) && group.proxies.length > 0;
  const dynamicSource =
    (Array.isArray(group.use) && group.use.length > 0) ||
    group['include-all'] === true ||
    group['include-all-proxies'] === true ||
    group['include-all-providers'] === true;
  if (dynamicSource && !explicitMembers && !Object.hasOwn(group, 'empty-fallback')) {
    // Fixed Mihomo otherwise defaults an empty dynamic group to COMPATIBLE,
    // silently changing routing. REJECT is an explicit fail-closed outcome.
    group['empty-fallback'] = 'REJECT';
  }
}

/**
 * Whether an emitted proxy-group map has at least one way to source members:
 * an explicit non-empty `proxies` list, a non-empty `use` provider list, or
 * any include-all* flag. A group with none renders as `proxies: []`, which
 * mihomo refuses to load. See the render final defense in renderProxyGroupsBlock.
 */
function groupHasMemberSource(map: Record<string, unknown>): boolean {
  const proxies = map.proxies;
  if (Array.isArray(proxies) && proxies.length > 0) return true;
  const use = map.use;
  if (Array.isArray(use) && use.length > 0) return true;
  return (
    map['include-all'] === true ||
    map['include-all-proxies'] === true ||
    map['include-all-providers'] === true
  );
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

/** Actual base-YAML rule-set references (comments and proxy credentials excluded). */
function readBaseRuleSetReferences(doc: ReturnType<typeof parseDocument>): Set<string> {
  const refs = new Set<string>();

  const dns = doc.get('dns', true);
  if (isMap(dns)) {
    for (const field of ['nameserver-policy', 'proxy-server-nameserver-policy']) {
      const policies = dns.get(field, true);
      if (isMap(policies)) {
        for (const pair of policies.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
          for (const name of referencedProviderNamesInText(pair.key.value)) refs.add(name);
        }
      }
    }
    const enhancedMode = dns.get('enhanced-mode', true);
    const fakeIpEnabled =
      isScalar(enhancedMode) &&
      typeof enhancedMode.value === 'string' &&
      enhancedMode.value.toLowerCase() === 'fake-ip';
    if (fakeIpEnabled) {
      const fakeIpMode = dns.get('fake-ip-filter-mode', true);
      const fakeIpRules =
        isScalar(fakeIpMode) &&
        typeof fakeIpMode.value === 'string' &&
        fakeIpMode.value.toLowerCase() === 'rule';
      collectRuleSetReferencesFromYamlSequence(dns.get('fake-ip-filter', true), refs, !fakeIpRules);
    }
  }

  const sniffer = doc.get('sniffer', true);
  if (isMap(sniffer)) {
    for (const field of ['force-domain', 'skip-domain', 'skip-src-address', 'skip-dst-address']) {
      collectRuleSetReferencesFromYamlSequence(sniffer.get(field, true), refs, true);
    }
  }

  collectTunRuleSetReferences(doc.get('tun', true), refs, true);
  const listeners = doc.get('listeners', true);
  if (isSeq(listeners)) {
    for (const listener of listeners.items) {
      if (!isMap(listener)) continue;
      const type = listener.get('type', true);
      if (isScalar(type) && type.value === 'tun') {
        collectTunRuleSetReferences(listener, refs, false);
      }
    }
  }

  collectRuleSetReferencesFromYamlSequence(doc.get('rules', true), refs);

  const subRules = doc.get('sub-rules', true);
  if (isMap(subRules)) {
    for (const pair of subRules.items) {
      collectRuleSetReferencesFromYamlSequence(pair.value, refs);
    }
  }

  return refs;
}

function collectTunRuleSetReferences(
  node: unknown,
  refs: Set<string>,
  requireEnabled: boolean,
): void {
  if (
    !isMap(node) ||
    !yamlBooleanFieldIsTrue(node, 'auto-redirect') ||
    !yamlBooleanFieldIsTrue(node, 'auto-route', requireEnabled)
  ) {
    return;
  }
  if (requireEnabled && !yamlBooleanFieldIsTrue(node, 'enable')) return;
  for (const field of ['route-address-set', 'route-exclude-address-set']) {
    const value = node.get(field, true);
    if (!isSeq(value)) continue;
    for (const item of value.items) {
      if (isScalar(item) && typeof item.value === 'string') {
        refs.add(item.value);
      }
    }
  }
}

function yamlBooleanFieldIsTrue(node: YAMLMap, field: string, defaultValue = false): boolean {
  const value = node.get(field, true);
  if (value === undefined) return defaultValue;
  return isScalar(value) && value.value === true;
}

function collectRuleSetReferencesFromYamlSequence(
  node: unknown,
  refs: Set<string>,
  colonSyntax = false,
): void {
  if (!isSeq(node)) return;
  for (const item of node.items) {
    if (!isScalar(item) || typeof item.value !== 'string') continue;
    if (colonSyntax) {
      for (const name of referencedProviderNamesInColonList(item.value)) refs.add(name);
    } else {
      collectRuleSetReferencesFromRule(item.value, refs);
    }
  }
}

/** Collect direct and logical-expression RULE-SET payloads from one fixed-Mihomo rule line. */
function collectRuleSetReferencesFromRule(raw: string, refs: Set<string>): void {
  collectRuleSetReferencesFromRuleLine(raw, refs);
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

function validateFinalProxyDocument(doc: ReturnType<typeof parseDocument>): void {
  const node = doc.get('proxies', true);
  if (!isSeq(node)) return;
  validateMihomoProxyList(node.toJSON() as unknown[], {
    // A dialer-proxy may legitimately name a managed proxy-group. All targets
    // that are concrete proxies are still indexed and cycle-checked.
    allowExternalDialerProxy: true,
    // Base skeletons may intentionally use local certificate/key paths. URI
    // and remote-provider boundaries already forbid introducing such paths.
    allowLocalFileReferences: true,
  });
}

/**
 * Validate cross-section references only after every managed section has been
 * materialised. Mihomo resolves proxy/group/provider/rule names from the final
 * document; validating the split inputs earlier cannot detect dangling names
 * created by pruning, template merge, or a typo in a base literal.
 */
function validateFinalRenderedConfig(content: string): void {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseBaseDocument(content);
  } catch {
    throw new Error('Full config render rejected: the final YAML document is invalid.');
  }
  const root = doc.toJSON() as Record<string, unknown>;

  const proxies = readObjectSequence(root.proxies, 'proxies');
  const proxyNames = new Set<string>();
  for (const proxy of proxies) {
    const name = readFinalName(proxy, 'proxy');
    if (FIXED_BUILTIN_PROXY_NAMES.has(name) || name === 'GLOBAL') {
      throw new Error('Full config render rejected: a proxy uses a reserved Mihomo name.');
    }
    if (proxyNames.has(name)) {
      throw new Error('Full config render rejected: duplicate final proxy names.');
    }
    proxyNames.add(name);
  }

  const providerMap = readOptionalObjectMap(root['proxy-providers'], 'proxy-providers');
  const providerNames = new Set(Object.keys(providerMap));
  if (providerNames.has('default')) {
    throw new Error('Full config render rejected: a proxy-provider uses Mihomo reserved name.');
  }

  const ruleProviderMap = readOptionalObjectMap(root['rule-providers'], 'rule-providers');
  const ruleProviderNames = new Set(Object.keys(ruleProviderMap));
  const ruleProviderBehaviors = new Map<string, string>();
  for (const [name, rawProvider] of Object.entries(ruleProviderMap)) {
    if (!isPlainObject(rawProvider)) {
      throw new Error('Full config render rejected: a rule-provider entry must be a mapping.');
    }
    const behavior = rawProvider.behavior;
    if (behavior !== 'domain' && behavior !== 'ipcidr' && behavior !== 'classical') {
      throw new Error('Full config render rejected: a rule-provider behavior is invalid.');
    }
    ruleProviderBehaviors.set(name, behavior);
  }
  validateContextualRuleSetReferences(root, ruleProviderBehaviors);

  const groups = readObjectSequence(root['proxy-groups'], 'proxy-groups');
  const groupNames = new Set<string>();
  for (const group of groups) {
    const name = readFinalName(group, 'proxy-group');
    const type = group.type;
    if (typeof type !== 'string' || !FIXED_PROXY_GROUP_TYPES.has(type)) {
      throw new Error('Full config render rejected: a proxy-group type is unsupported.');
    }
    if (FIXED_BUILTIN_PROXY_NAMES.has(name) || proxyNames.has(name) || groupNames.has(name)) {
      throw new Error('Full config render rejected: a proxy-group name collides.');
    }
    if (
      Object.hasOwn(group, 'dialer-proxy') ||
      Object.hasOwn(group, 'interface-name') ||
      Object.hasOwn(group, 'routing-mark')
    ) {
      throw new Error('Full config render rejected: a proxy-group contains an ignored field.');
    }
    validateFinalProxyGroupShape(group, type);
    groupNames.add(name);
  }

  const groupMemberTargets = new Set([...FIXED_BUILTIN_PROXY_NAMES, ...proxyNames, ...groupNames]);
  const dialerTargets = new Set([...groupMemberTargets, 'GLOBAL']);
  const concreteFallbackTargets = new Set([...FIXED_BUILTIN_PROXY_NAMES, ...proxyNames]);
  const dependencyEdges = new Map<string, string[]>();
  for (const name of proxyNames) dependencyEdges.set(name, []);

  for (const group of groups) {
    const name = group.name as string;
    const members = readOptionalStringArray(group.proxies, 'proxy-group proxies');
    const providers = readOptionalStringArray(group.use, 'proxy-group use');
    if (members.length > 0 && providerNames.has(name)) {
      throw new Error(
        'Full config render rejected: a proxy-group name collides with a proxy-provider.',
      );
    }
    for (const member of members) {
      if (!groupMemberTargets.has(member)) {
        throw new Error('Full config render rejected: a proxy-group member is missing.');
      }
    }
    for (const provider of providers) {
      if (!providerNames.has(provider)) {
        throw new Error('Full config render rejected: a proxy-group provider is missing.');
      }
    }
    const dependencies = members.filter(
      (member) => proxyNames.has(member) || groupNames.has(member),
    );

    if (Object.hasOwn(group, 'empty-fallback')) {
      const fallback = group['empty-fallback'];
      if (typeof fallback !== 'string' || !concreteFallbackTargets.has(fallback)) {
        throw new Error('Full config render rejected: a proxy-group empty-fallback is invalid.');
      }
    }
    for (const field of ['include-all', 'include-all-proxies', 'include-all-providers'] as const) {
      if (Object.hasOwn(group, field) && typeof group[field] !== 'boolean') {
        throw new Error('Full config render rejected: a proxy-group include flag is mistyped.');
      }
    }
    const includeAllProxies =
      group['include-all'] === true || group['include-all-proxies'] === true;
    const includeAllProviders =
      group['include-all'] === true || group['include-all-providers'] === true;
    if (
      members.length === 0 &&
      providers.length === 0 &&
      !includeAllProxies &&
      !(includeAllProviders && providerNames.size > 0)
    ) {
      throw new Error('Full config render rejected: a proxy-group has no final member source.');
    }
    if (includeAllProxies) {
      compileFinalGroupRegexList(group.filter, 'filter');
      for (const proxyName of proxyNames) {
        // A JS negative match is not generally proof that regexp2 also rejects
        // the name (notably \w/\d/\b and Unicode case folding). Only shrink the
        // dependency graph for the trivial literal subset; otherwise add the
        // conservative edge so a real fixed-Mihomo cycle cannot hide behind an
        // engine-semantic difference.
        if (
          !canProveLiteralGroupFilterMiss(group.filter, proxyName) &&
          !canProveAnchoredLiteralExcludeMatch(group['exclude-filter'], proxyName)
        ) {
          dependencies.push(proxyName);
        }
      }
    }
    const hasDynamicSource =
      providers.length > 0 || includeAllProxies || (includeAllProviders && providerNames.size > 0);
    if (members.length === 0 && hasDynamicSource && !Object.hasOwn(group, 'empty-fallback')) {
      throw new Error(
        'Full config render rejected: a dynamic proxy-group requires explicit empty-fallback.',
      );
    }
    dependencyEdges.set(name, [...new Set(dependencies)]);
  }

  for (const proxy of proxies) {
    if (!Object.hasOwn(proxy, 'dialer-proxy')) continue;
    const target = proxy['dialer-proxy'];
    if (typeof target !== 'string' || !dialerTargets.has(target)) {
      throw new Error('Full config render rejected: a dialer-proxy target is missing.');
    }
    if (proxyNames.has(target) || groupNames.has(target)) {
      dependencyEdges.get(proxy.name as string)?.push(target);
    }
  }
  validateFinalProxyAndGroupDag(dependencyEdges);

  const rulePolicyTargets = new Set([...dialerTargets]);
  const subRules = readFinalSubRules(root['sub-rules']);
  const subRuleNames = new Set(Object.keys(subRules));
  const subRuleEdges = new Map<string, string[]>();
  for (const [name, rules] of Object.entries(subRules)) {
    subRuleEdges.set(name, []);
    validateFinalRulePolicies(
      rules,
      rulePolicyTargets,
      ruleProviderNames,
      subRuleNames,
      subRuleEdges.get(name),
    );
  }
  validateFinalSubRuleDag(subRuleEdges);
  validateFinalRulePolicies(root.rules, rulePolicyTargets, ruleProviderNames, subRuleNames);
}

function canProveLiteralGroupFilterMiss(value: unknown, proxyName: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  const patterns = value.split('`');
  for (let pattern of patterns) {
    let caseInsensitive = false;
    const inline = /^\(\?([a-zA-Z]+)\)/u.exec(pattern);
    if (inline) {
      if (inline[1] !== 'i') return false;
      caseInsensitive = true;
      pattern = pattern.slice(inline[0].length);
    }
    // Any metacharacter makes this a real regex whose negative result is not
    // used to remove a security-relevant graph edge.
    if (pattern === '' || /[\\^$.*+?()[\]{}|]/u.test(pattern)) return false;
    if (caseInsensitive) {
      if (!/^[\x00-\x7F]+$/u.test(pattern) || !/^[\x00-\x7F]+$/u.test(proxyName)) {
        return false;
      }
      if (proxyName.toLowerCase().includes(pattern.toLowerCase())) return false;
    } else if (proxyName.includes(pattern)) {
      return false;
    }
  }
  return true;
}

/**
 * Positive proof for the exact anchored literal patterns generated by
 * excludeChainClonesFromIncludeAll. Do not use a JS regex match as proof:
 * regexp2 and ECMAScript can disagree on character classes/case folding. This
 * parser accepts only `^literal$` alternatives with escaped metacharacters.
 */
function canProveAnchoredLiteralExcludeMatch(value: unknown, proxyName: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  for (const pattern of value.split('`')) {
    const alternatives = splitUnescapedAlternatives(pattern);
    if (alternatives === null) continue;
    for (const alternative of alternatives) {
      const literal = decodeAnchoredRegexLiteral(alternative);
      if (literal === proxyName) return true;
    }
  }
  return false;
}

function splitUnescapedAlternatives(pattern: string): string[] | null {
  const out: string[] = [];
  let current = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      if (index + 1 >= pattern.length) return null;
      current += character + pattern[index + 1];
      index += 1;
    } else if (character === '|') {
      out.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  out.push(current);
  return out;
}

function decodeAnchoredRegexLiteral(pattern: string): string | null {
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.length < 2) return null;
  const body = pattern.slice(1, -1);
  let literal = '';
  const escapable = new Set('.*+?^${}()|[]\\');
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\') {
      const next = body[index + 1];
      if (next === undefined || !escapable.has(next)) return null;
      literal += next;
      index += 1;
    } else {
      if (escapable.has(character)) return null;
      literal += character;
    }
  }
  return literal;
}

function validateContextualRuleSetReferences(
  root: Record<string, unknown>,
  behaviors: ReadonlyMap<string, string>,
): void {
  const domainRefs = new Set<string>();
  const ipRefs = new Set<string>();
  const tunIpRefs = new Set<string>();
  const dns = isPlainObject(root.dns) ? root.dns : undefined;
  if (dns) {
    for (const field of ['nameserver-policy', 'proxy-server-nameserver-policy']) {
      const policies = dns[field];
      if (isPlainObject(policies)) {
        for (const key of Object.keys(policies)) {
          for (const name of referencedProviderNamesInText(key)) domainRefs.add(name);
        }
      }
    }
    if (equalsFinalAsciiCaseInsensitive(dns['enhanced-mode'], 'fake-ip')) {
      if (equalsFinalAsciiCaseInsensitive(dns['fake-ip-filter-mode'], 'rule')) {
        collectRuleLineRuleSetReferences(dns['fake-ip-filter'], domainRefs);
      } else {
        collectColonRuleSetReferences(dns['fake-ip-filter'], domainRefs);
      }
    }
  }
  const sniffer = isPlainObject(root.sniffer) ? root.sniffer : undefined;
  if (sniffer) {
    collectColonRuleSetReferences(sniffer['force-domain'], domainRefs);
    collectColonRuleSetReferences(sniffer['skip-domain'], domainRefs);
    collectColonRuleSetReferences(sniffer['skip-src-address'], ipRefs);
    collectColonRuleSetReferences(sniffer['skip-dst-address'], ipRefs);
  }
  collectFinalTunRuleSetReferences(root.tun, tunIpRefs, true);
  if (Array.isArray(root.listeners)) {
    for (const listener of root.listeners) {
      if (isPlainObject(listener) && listener.type === 'tun') {
        collectFinalTunRuleSetReferences(listener, tunIpRefs, false);
      }
    }
  }
  for (const name of domainRefs) {
    const behavior = behaviors.get(name);
    if (!behavior) {
      throw new Error('Full config render rejected: a contextual rule-set is missing.');
    }
    if (behavior === 'ipcidr') {
      throw new Error('Full config render rejected: a domain context uses an IP rule-set.');
    }
  }
  for (const name of ipRefs) {
    const behavior = behaviors.get(name);
    if (!behavior) {
      throw new Error('Full config render rejected: a contextual rule-set is missing.');
    }
    if (behavior === 'domain') {
      throw new Error('Full config render rejected: an IP context uses a domain rule-set.');
    }
  }
  for (const name of tunIpRefs) {
    const behavior = behaviors.get(name);
    if (!behavior) {
      throw new Error('Full config render rejected: a TUN route rule-set is missing.');
    }
    if (behavior !== 'ipcidr') {
      throw new Error('Full config render rejected: a TUN route requires an IP-CIDR rule-set.');
    }
  }
}

function collectRuleLineRuleSetReferences(value: unknown, refs: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string') collectRuleSetReferencesFromRule(item, refs);
  }
}

function collectFinalTunRuleSetReferences(
  value: unknown,
  refs: Set<string>,
  requireEnabled: boolean,
): void {
  if (!isPlainObject(value)) return;
  const contextualFields = new Set([
    'auto-route',
    'auto-redirect',
    'route-address-set',
    'route-exclude-address-set',
  ]);
  for (const key of Object.keys(value)) {
    const normalized = key.replaceAll('_', '-').toLowerCase();
    if (contextualFields.has(normalized) && key !== normalized) {
      throw new Error(
        'Full config render rejected: a TUN contextual field uses a noncanonical alias.',
      );
    }
  }
  for (const field of ['auto-route', 'auto-redirect']) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'boolean') {
      throw new Error('Full config render rejected: a TUN boolean field is mistyped.');
    }
  }
  if (requireEnabled && Object.hasOwn(value, 'enable') && typeof value.enable !== 'boolean') {
    throw new Error('Full config render rejected: the root TUN enable field is mistyped.');
  }
  for (const field of ['route-address-set', 'route-exclude-address-set']) {
    const names = value[field];
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    ) {
      throw new Error('Full config render rejected: a TUN route-set list is mistyped.');
    }
  }
  if (requireEnabled && value.enable !== true) return;
  if (value['auto-redirect'] !== true) return;
  const autoRouteEnabled =
    value['auto-route'] === true || (requireEnabled && value['auto-route'] === undefined);
  if (!autoRouteEnabled) {
    throw new Error('Full config render rejected: TUN auto-redirect requires auto-route.');
  }
  for (const field of ['route-address-set', 'route-exclude-address-set']) {
    const names = value[field];
    if (!Array.isArray(names)) continue;
    for (const name of names) refs.add(name as string);
  }
}

function equalsFinalAsciiCaseInsensitive(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected;
}

function collectColonRuleSetReferences(value: unknown, refs: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    for (const name of referencedProviderNamesInColonList(item)) refs.add(name);
  }
}

function validateFinalProxyGroupShape(group: Record<string, unknown>, type: string): void {
  if (Object.keys(group).some((field) => !FIXED_PROXY_GROUP_FIELDS.has(field))) {
    throw new Error('Full config render rejected: a proxy-group contains an unknown field.');
  }
  for (const field of [
    'url',
    'empty-fallback',
    'filter',
    'exclude-filter',
    'exclude-type',
    'expected-status',
    'icon',
  ]) {
    if (Object.hasOwn(group, field) && typeof group[field] !== 'string') {
      throw new Error('Full config render rejected: a proxy-group string field is mistyped.');
    }
  }
  for (const field of [
    'lazy',
    'disable-udp',
    'include-all',
    'include-all-proxies',
    'include-all-providers',
    'hidden',
  ]) {
    if (Object.hasOwn(group, field) && typeof group[field] !== 'boolean') {
      throw new Error('Full config render rejected: a proxy-group boolean field is mistyped.');
    }
  }
  for (const field of ['interval', 'timeout', 'max-failed-times']) {
    if (
      Object.hasOwn(group, field) &&
      (!Number.isSafeInteger(group[field]) || (group[field] as number) <= 0)
    ) {
      throw new Error('Full config render rejected: a proxy-group integer field is invalid.');
    }
  }
  if (
    Object.hasOwn(group, 'tolerance') &&
    (!Number.isSafeInteger(group.tolerance) ||
      (group.tolerance as number) < 0 ||
      (group.tolerance as number) > 65_535)
  ) {
    throw new Error('Full config render rejected: proxy-group tolerance is invalid.');
  }
  if (Object.hasOwn(group, 'expected-status')) {
    validateExpectedStatus(group['expected-status'] as string);
  }
  compileFinalGroupRegexList(group.filter, 'filter');
  compileFinalGroupRegexList(group['exclude-filter'], 'exclude-filter');
  if (
    Object.hasOwn(group, 'exclude-type') &&
    !ProxyGroupExcludeTypeSchema.safeParse(group['exclude-type']).success
  ) {
    throw new Error('Full config render rejected: proxy-group exclude-type is invalid.');
  }
  if (Object.hasOwn(group, 'strategy')) {
    if (
      type !== 'load-balance' ||
      typeof group.strategy !== 'string' ||
      !['consistent-hashing', 'round-robin', 'sticky-sessions'].includes(group.strategy)
    ) {
      throw new Error('Full config render rejected: proxy-group strategy is invalid.');
    }
  }
  if (Object.hasOwn(group, 'default-selected')) {
    if (type !== 'select' || typeof group['default-selected'] !== 'string') {
      throw new Error('Full config render rejected: proxy-group default selection is invalid.');
    }
  }
  if (Object.hasOwn(group, 'tolerance') && type !== 'url-test') {
    throw new Error('Full config render rejected: proxy-group tolerance is type-incompatible.');
  }
}

function compileFinalGroupRegexList(value: unknown, field: string): RegExp[] {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 4_096) {
    throw new Error(`Full config render rejected: proxy-group ${field} is invalid.`);
  }
  const patterns = value.split('`');
  if (patterns.length > 32 || patterns.some((pattern) => pattern.length === 0)) {
    throw new Error(`Full config render rejected: proxy-group ${field} is invalid.`);
  }
  try {
    return patterns.map((pattern) => compileGoRegex(pattern));
  } catch {
    throw new Error(`Full config render rejected: proxy-group ${field} is unsafe or invalid.`);
  }
}

function validateExpectedStatus(value: string): void {
  const normalized = value.trim();
  if (normalized === '' || normalized === '*') return;
  const parts = normalized.replaceAll(',', '/').split('/').filter(Boolean);
  if (parts.length > 28 || parts.length === 0) {
    throw new Error('Full config render rejected: proxy-group expected-status is invalid.');
  }
  for (const part of parts) {
    const match = /^\s*\[?(\d+)\]?\s*(?:-\s*\[?(\d+)\]?\s*)?$/u.exec(part);
    if (!match) {
      throw new Error('Full config render rejected: proxy-group expected-status is invalid.');
    }
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start > 65_535 || end > 65_535) {
      throw new Error('Full config render rejected: proxy-group expected-status is invalid.');
    }
  }
}

function readObjectSequence(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !isPlainObject(item))) {
    throw new Error(`Full config render rejected: final ${field} must be an object sequence.`);
  }
  return value as Record<string, unknown>[];
}

function readOptionalObjectMap(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`Full config render rejected: final ${field} must be a mapping.`);
  }
  return value;
}

function readFinalName(value: Record<string, unknown>, field: string): string {
  const name = value.name;
  if (typeof name !== 'string' || name.trim() === '' || name !== name.trim()) {
    throw new Error(`Full config render rejected: a final ${field} name is invalid.`);
  }
  return name;
}

function readOptionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new Error(`Full config render rejected: ${field} must be a string array.`);
  }
  return value as string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateFinalProxyAndGroupDag(edges: Map<string, string[]>): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(
        'Full config render rejected: proxy and proxy-group dependencies contain a cycle.',
      );
    }
    state.set(name, 'visiting');
    for (const target of edges.get(name) ?? []) visit(target);
    state.set(name, 'done');
  };
  for (const name of edges.keys()) visit(name);
}

function readFinalSubRules(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error('Full config render rejected: final sub-rules must be a mapping.');
  }
  const out: Record<string, string[]> = {};
  for (const [name, rules] of Object.entries(value)) {
    if (name.trim() === '' || name !== name.trim()) {
      throw new Error('Full config render rejected: a sub-rule name is invalid.');
    }
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string')) {
      throw new Error('Full config render rejected: a sub-rule body must be a string array.');
    }
    out[name] = rules as string[];
  }
  return out;
}

function validateFinalRulePolicies(
  value: unknown,
  allowed: ReadonlySet<string>,
  providers: ReadonlySet<string>,
  subRules: ReadonlySet<string>,
  subRuleEdges?: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((rule) => typeof rule !== 'string')) {
    throw new Error('Full config render rejected: final rules must be strings.');
  }
  for (const raw of value as string[]) {
    const ruleSetRefs = new Set<string>();
    const { type, target } = parseAndValidateFinalRule(raw, false, 0, ruleSetRefs);
    if (type === 'SUB-RULE') {
      if (!subRules.has(target)) {
        throw new Error('Full config render rejected: a final sub-rule target is missing.');
      }
      subRuleEdges?.push(target);
    } else if (!allowed.has(target)) {
      throw new Error('Full config render rejected: a final rule policy is missing.');
    }
    if ([...ruleSetRefs].some((name) => !providers.has(name))) {
      throw new Error('Full config render rejected: a final rule-set reference is missing.');
    }
  }
}

interface ParsedFinalRule {
  type: string;
  payload: string;
  target: string;
  params: string[];
}

/** Parse exactly like fixed Mihomo's ParseRulePayload, then reject every
 * silent-ignore/coercion surface with a portable closed grammar. */
function parseAndValidateFinalRule(
  raw: string,
  nested = false,
  depth = 0,
  ruleSetRefs: Set<string> = new Set<string>(),
): ParsedFinalRule {
  if (
    raw.length === 0 ||
    raw.length > MAX_FINAL_RULE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new Error('Full config render rejected: a final rule is malformed.');
  }
  if (depth > MAX_FINAL_LOGIC_DEPTH) {
    throw new Error('Full config render rejected: a final logic rule is too deeply nested.');
  }

  // fixed Mihomo's ParseRulePayload uses strings.Trim(part, " "), not
  // TrimSpace. Preserve NBSP and every other Unicode whitespace byte so a
  // visually spoofed policy cannot be normalized into an allowed target.
  const rawFields = raw.split(',');
  const fields = rawFields.map(trimFinalRuleAsciiSpaces);
  const type = fields[0]?.toUpperCase() ?? '';
  if (!FIXED_RULE_TYPES.has(type)) {
    throw new Error('Full config render rejected: a final rule type is unsupported.');
  }
  if (nested && (type === 'MATCH' || type === 'SUB-RULE')) {
    throw new Error('Full config render rejected: a final logic rule contains a forbidden type.');
  }

  if (type === 'MATCH') {
    if (fields.length !== 2 || fields[1] === '') {
      throw new Error('Full config render rejected: a final MATCH rule is malformed.');
    }
    return { type, payload: '', target: fields[1], params: [] };
  }

  let payload = '';
  let target = '';
  let params: string[] = [];
  if (RULE_TYPES_WITH_COMMA_PAYLOAD.has(type)) {
    if (nested) {
      payload = fields.slice(1).join(',');
    } else {
      if (fields.length < 3) {
        throw new Error('Full config render rejected: a final rule is malformed.');
      }
      target = fields[fields.length - 1];
      payload = fields.slice(1, -1).join(',');
    }
  } else {
    payload = fields[1] ?? '';
    if (nested) {
      params = fields.slice(2);
    } else {
      target = fields[2] ?? '';
      params = fields.slice(3);
    }
  }
  if (payload === '' || (!nested && target === '')) {
    throw new Error('Full config render rejected: a final rule is malformed.');
  }
  if (RULE_TYPES_WITH_COMMA_PAYLOAD.has(type)) {
    const rawPayload = (nested ? rawFields.slice(1) : rawFields.slice(1, -1)).join(',');
    if (rawPayload !== payload) {
      throw new Error(
        'Full config render rejected: a final comma-bearing rule payload would be changed by fixed field trimming.',
      );
    }
  }

  if (type === 'RULE-SET') ruleSetRefs.add(payload);
  validateFinalRuleParams(type, params);
  validateFinalRulePayload(type, payload, depth, ruleSetRefs);
  return { type, payload, target, params };
}

function trimFinalRuleAsciiSpaces(value: string): string {
  return value.replace(/^ +| +$/gu, '');
}

function validateFinalRuleParams(type: string, params: string[]): void {
  if (!FINAL_RULE_PARAM_TYPES.has(type)) {
    if (params.length > 0) {
      throw new Error('Full config render rejected: a final rule has unsupported parameters.');
    }
    return;
  }
  if (
    params.some((param) => param !== 'src' && param !== 'no-resolve') ||
    new Set(params).size !== params.length
  ) {
    throw new Error('Full config render rejected: a final rule has invalid parameters.');
  }
}

function validateFinalRulePayload(
  type: string,
  payload: string,
  depth: number,
  ruleSetRefs: Set<string>,
): void {
  if (payload.trim() === '' || /[\u0000-\u001f\u007f]/u.test(payload)) {
    throw new Error('Full config render rejected: a final rule payload is invalid.');
  }
  if (FINAL_RULE_REGEX_TYPES.has(type)) {
    if (/\\u\{|\(\?>|\(\?\(/u.test(payload)) {
      throw new Error('Full config render rejected: a final rule regex is not portable.');
    }
    try {
      // Fixed NewDomainRegex/NewProcess always enables regexp2 IgnoreCase.
      // Analyse the same folded branches or an apparently safe case-sensitive
      // pattern can become exponential at runtime (for example `(a|A)+$`).
      compileGoRegex(payload, 'i');
    } catch {
      throw new Error('Full config render rejected: a final rule regex is unsafe or invalid.');
    }
    return;
  }
  if (FINAL_RULE_IP_PREFIX_TYPES.has(type)) {
    validateFinalIpPrefix(payload);
    return;
  }
  if (type === 'IP-ASN' || type === 'SRC-IP-ASN') {
    if (!/^[1-9]\d{0,9}$/u.test(payload) || Number(payload) > 0xffff_ffff) {
      throw new Error('Full config render rejected: a final IP-ASN rule is invalid.');
    }
    return;
  }
  if (FINAL_RULE_PORT_TYPES.has(type)) {
    validateFinalUnsignedRanges(payload, 65_535, false, 'port');
    return;
  }
  if (type === 'DSCP') {
    validateFinalUnsignedRanges(payload, 63, true, 'DSCP');
    return;
  }
  if (type === 'UID') {
    throw new Error('Full config render rejected: UID rules are not portable across fixed builds.');
  }
  if (type === 'NETWORK') {
    if (payload.toUpperCase() !== 'TCP' && payload.toUpperCase() !== 'UDP') {
      throw new Error('Full config render rejected: a final NETWORK rule is invalid.');
    }
    return;
  }
  if (type === 'IN-TYPE') {
    const tokens = payload.split('/').map((token) => token.trim().toUpperCase());
    if (
      tokens.length === 0 ||
      tokens.some((token) => token === '' || !FINAL_RULE_IN_TYPES.has(token)) ||
      new Set(tokens).size !== tokens.length
    ) {
      throw new Error('Full config render rejected: a final IN-TYPE rule is invalid.');
    }
    return;
  }
  if (type === 'IN-USER' || type === 'IN-NAME' || type === 'REMATCH-NAME') {
    const tokens = payload.split('/');
    if (tokens.some((token) => token.trim() === '')) {
      throw new Error('Full config render rejected: a final inbound literal rule is invalid.');
    }
    return;
  }
  if (FINAL_RULE_LOGIC_TYPES.has(type)) {
    validateFinalLogicPayload(payload, type, depth + 1, ruleSetRefs);
    return;
  }
  if (type === 'SUB-RULE') {
    validateFinalSubRulePredicate(payload, depth + 1, ruleSetRefs);
  }
}

function validateFinalIpPrefix(payload: string): void {
  const match = /^([^/]+)\/((?:0|[1-9]\d{0,2}))$/u.exec(payload);
  if (!match || match[1].includes('%')) {
    throw new Error('Full config render rejected: a final IP prefix rule is invalid.');
  }
  const family = ipLiteralFamily(match[1]);
  const bits = Number(match[2]);
  if (family === 0 || bits > (family === 4 ? 32 : 128)) {
    throw new Error('Full config render rejected: a final IP prefix rule is invalid.');
  }
}

function validateFinalUnsignedRanges(
  payload: string,
  maximum: number,
  allowWildcard: boolean,
  label: string,
): void {
  if (allowWildcard && payload === '*') return;
  const segments = payload.split('/');
  if (segments.length === 0 || segments.length > 28 || segments.some((segment) => segment === '')) {
    throw new Error(`Full config render rejected: a final ${label} range is invalid.`);
  }
  for (const segment of segments) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(segment);
    if (!match || Number(match[1]) > maximum || Number(match[2] ?? match[1]) > maximum) {
      throw new Error(`Full config render rejected: a final ${label} range is invalid.`);
    }
  }
}

function validateFinalLogicPayload(
  payload: string,
  type: string,
  depth: number,
  ruleSetRefs: Set<string>,
): void {
  const children = extractFinalLogicChildren(payload);
  if ((type === 'NOT' && children.length !== 1) || (type !== 'NOT' && children.length === 0)) {
    throw new Error('Full config render rejected: a final logic rule has invalid arity.');
  }
  for (const child of children) parseAndValidateFinalRule(child, true, depth, ruleSetRefs);
}

function validateFinalSubRulePredicate(
  payload: string,
  depth: number,
  ruleSetRefs: Set<string>,
): void {
  if (!payload.startsWith('(') || !payload.endsWith(')')) {
    throw new Error('Full config render rejected: a final SUB-RULE predicate is malformed.');
  }
  const children = extractFinalLogicChildren(`(${payload})`);
  if (children.length !== 1 || children[0] !== payload.slice(1, -1)) {
    throw new Error('Full config render rejected: a final SUB-RULE predicate is malformed.');
  }
  parseAndValidateFinalRule(children[0], true, depth, ruleSetRefs);
}

function extractFinalLogicChildren(payload: string): string[] {
  if (!payload.startsWith('(') || !payload.endsWith(')')) {
    throw new Error('Full config render rejected: a final logic rule payload is malformed.');
  }
  const stack: number[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index];
    if (character === '(') {
      stack.push(index);
    } else if (character === ')') {
      const start = stack.pop();
      if (start === undefined) {
        throw new Error('Full config render rejected: a final logic rule is unbalanced.');
      }
      ranges.push({ start, end: index });
    }
  }
  if (stack.length > 0) {
    throw new Error('Full config render rejected: a final logic rule is unbalanced.');
  }

  // Mirror fixed rules/logic.findSubRuleRange: skip a whole-payload wrapper,
  // then keep each outermost remaining range. This accepts both
  // `((A),(B))` and the source-supported sibling form `(A),(B)`.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    if (range.start === 0 && range.end === payload.length - 1) continue;
    if (selected.some((parent) => parent.start < range.start && parent.end > range.end)) continue;
    selected.push(range);
  }

  // fixed currently ignores text between child ranges. Keep the product's
  // conservative closed grammar, but permit both comma-separated layouts.
  const covered = new Uint8Array(payload.length);
  const wholeWrapper = ranges.some(
    (range) => range.start === 0 && range.end === payload.length - 1,
  );
  if (wholeWrapper) {
    covered[0] = 1;
    covered[payload.length - 1] = 1;
  }
  for (const range of selected) covered.fill(1, range.start, range.end + 1);
  let outside = '';
  for (let index = 0; index < payload.length; index += 1) {
    if (covered[index] === 0) outside += payload[index];
  }
  if (!/^[\s,|&!]*$/u.test(outside)) {
    throw new Error('Full config render rejected: a final logic rule payload is malformed.');
  }
  return selected.map((range) => payload.slice(range.start + 1, range.end));
}

function validateFinalSubRuleDag(edges: ReadonlyMap<string, readonly string[]>): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error('Full config render rejected: sub-rule references contain a cycle.');
    }
    state.set(name, 'visiting');
    for (const target of edges.get(name) ?? []) visit(target);
    state.set(name, 'done');
  };
  for (const name of edges.keys()) visit(name);
}

/** Convenience re-export so callers can invalidate without importing the repo directly. */
export { invalidateResolvedSnapshot };
