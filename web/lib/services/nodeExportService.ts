import { stringify } from 'yaml';
import { enabledCollectionMemberSubs, settleWithConcurrencyInOrder } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { MAX_PROXY_NODES, validateMihomoProxyList } from '@/lib/proxies/mihomoProxyValidator';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { fingerprintOf, sourceOf, stripSource, withSource } from '@/lib/proxies/provenance';
import { dedupByNameAndIdentity } from '@/lib/proxies/nodeDedup';
import { nodeFingerprint } from '@/lib/proxies/naming';
import { resolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';
import { isExecutableOperator, type Operator } from '@/schemas/operator';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import {
  SubscriptionResolutionValidationError,
  SubscriptionUpstreamUnavailableError,
} from '@/lib/services/subscriptionResolutionErrors';
import type { Collection, Subscription, SubscriptionTraffic } from '@/schemas';

/**
 * 节点导出服务 —— 「分发」公开链接的产物:只含 `proxies:` 的 Clash provider
 * YAML,可直接填进任何 mihomo / Clash 客户端的 proxy-provider `url:`,或当普
 * 通订阅导入。与渲染管线(resolveConfig)共享同一套语义:单订阅的 operators
 * 流水线、(聚合还会对合并后的并集再跑一遍聚合自己的 operators)、同名
 * first-writer-wins 去重 —— 同一个节点在这里和在最终配置里叫同一个名字。
 */

export interface NodeExportResult {
  /** Provider YAML(仅 `proxies:` 块),去重后。 */
  yaml: string;
  /** 去重 + 校验后的节点对象(与 yaml 同一份数据)—— base64 分享链接格式用。 */
  proxies: Record<string, unknown>[];
  /** 去重后的节点数。 */
  proxyCount: number;
  /** 任一来源命中 stale-on-error 缓存回退时为 true。 */
  stale: boolean;
  /** 单订阅导出时透传上游 Subscription-Userinfo(聚合无意义,恒为空)。 */
  traffic?: SubscriptionTraffic;
  /** 聚合导出时,拉取失败被跳过的成员(全员失败则直接抛错,不会走到这)。 */
  memberErrors: { name: string; error: string }[];
  /** TRUE duplicates removed by raw identity (source-priority diagnostics). */
  deduped?: Array<{ kept: string; dropped: string }>;
  /** Managed-path same-name distinct identities kept under a meaningful suffix. */
  resolvedNames?: Array<{ from: string; to: string }>;
}

interface ExportOptions {
  noCache?: boolean;
  /**
   * Persist fresh upstream fetches into the fetch cache. Preview / dry-run
   * callers pass false — a keystroke-driven preview must never mutate shared
   * cache state. Export / render keep the default (warm the cache).
   */
  writeCache?: boolean;
}

/** 同时在途的成员订阅 fetch 上限,与渲染管线保持一致。 */
const MEMBER_FETCH_CONCURRENCY = 8;

/** Keep member diagnostics useful without reflecting provider payloads or credentials. */
function safeMemberError(error: unknown): string {
  if (error instanceof SubscriptionResolutionValidationError) {
    if (error.stage === 'definition') return 'Subscription definition is invalid.';
    if (error.stage === 'operators') return 'Subscription operator pipeline is invalid.';
    return 'Subscription content is invalid.';
  }
  if (error instanceof SubscriptionUpstreamUnavailableError) {
    return 'Subscription upstream is unavailable.';
  }
  return 'Subscription member resolution failed.';
}

/** 取节点名；非字符串名保留到后续 trust-boundary validator 明确拒绝。 */
function nameOf(item: Record<string, unknown>): string | null {
  return typeof item.name === 'string' ? item.name : null;
}

/** First-writer-wins 同名去重 —— 与 resolveConfig 注入链路同序同语义。 */
export interface ExportDedupDiagnostics {
  /** TRUE duplicates removed by raw identity (source-priority = input order). */
  deduped: Array<{ kept: string; dropped: string }>;
  /** Managed-path same-name distinct identities kept under a meaningful suffix. */
  resolved: Array<{ from: string; to: string }>;
}

/**
 * Identity-aware export dedup — the export twin of the resolve-level rule:
 * NAME equality never drops distinct nodes on the managed path. True
 * duplicates (same immutable raw fingerprint) dedup by explicit source
 * priority (input order) with diagnostics; distinct identities that share a
 * display name BOTH survive, the later one deterministically suffixed with
 * its source label. Non-managed raw-name collisions keep the documented
 * first-writer-wins contract.
 */
/** Run the SHARED dedup state machine (lib/proxies/nodeDedup) over export
 * proxies. `isManaged` carries PER-NODE managed provenance (the node's own
 * source's active rename-template) — never a collection-wide boolean
 * (pass-3 finding). Every keeper — including a suffix-renamed keeper —
 * registers its fingerprint inside the machine, so true duplicates are
 * deduped globally everywhere. EXPORTED so the public preview routes run the
 * exact same machine after their operator pipelines (pass-1 finding): the
 * preview's final identity/name set must equal render/single-export/
 * collection-export, never the raw pipeline output. */
export function dedupExportProxies(
  proxies: Record<string, unknown>[],
  isManaged: (item: Record<string, unknown>) => boolean,
): {
  proxies: Record<string, unknown>[];
  deduped: ExportDedupDiagnostics['deduped'];
  resolved: ExportDedupDiagnostics['resolved'];
} {
  const nodes = proxies.map((item) => {
    const name = nameOf(item);
    return {
      name: name ?? '',
      fp: fingerprintOf(item) ?? nodeFingerprint(item),
      sourceKey: sourceOf(item)?.key ?? '',
      sourceLabel: sourceOf(item)?.label ?? 'node',
      managed: isManaged(item),
      original: item,
    };
  });
  const result = dedupByNameAndIdentity(nodes);
  const out: Record<string, unknown>[] = [];
  result.kept.forEach(({ node, finalName }) => {
    const original = node.original as Record<string, unknown> | undefined;
    if (original === undefined) return;
    out.push(finalName === node.name ? original : { ...original, name: finalName });
  });
  const deduped: ExportDedupDiagnostics['deduped'] = result.diagnostics.deduped.map((d) => ({
    kept: d.kept,
    dropped: d.dropped,
  }));
  const resolved: ExportDedupDiagnostics['resolved'] = result.diagnostics.resolved.map((r) => ({
    from: r.from,
    to: r.to,
  }));
  return { proxies: out, deduped, resolved };
}

/** 单订阅源的节点导出。停用的源由路由层拦下(404),这里不重复判断。 */
export async function exportSubscriptionNodes(
  sub: Subscription,
  options: ExportOptions = {},
): Promise<NodeExportResult> {
  const result = await resolveSubscriptionProxies(sub, {
    noCache: options.noCache,
    writeCache: options.writeCache,
  });
  const managed = (sub.operators ?? []).some((op) => op.kind === 'rename-template' && !op.disabled);
  const {
    proxies: deduped,
    deduped: dropped,
    resolved: renamed,
  } = dedupExportProxies(result.proxies, () => managed);
  const proxies = validateMihomoProxyList(deduped, { allowExternalDialerProxy: true });
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    proxies,
    proxyCount: proxies.length,
    stale: result.stale === true,
    traffic: result.traffic,
    memberErrors: [],
    ...(dropped.length > 0 ? { deduped: dropped } : {}),
    ...(renamed.length > 0 ? { resolvedNames: renamed } : {}),
  };
}

export interface MergedMembers {
  /** Member nodes merged in member order, BEFORE collection operators + dedup. */
  merged: Record<string, unknown>[];
  /** Members that failed to fetch (skipped). */
  memberErrors: { name: string; error: string }[];
  /** True if any member served a stale-on-error cache. */
  stale: boolean;
}

/**
 * 聚合订阅成员展开(直接指定 + 标签匹配,只取启用的)→ 并行 fetch → 按成员
 * 原序合并。个别成员拉取失败跳过并记入 `memberErrors`;全员失败才抛。返回的是
 * 聚合 operators 之前、去重之前的并集 —— 导出与预览共用这一步。
 */
export async function mergeCollectionMemberProxies(
  collection: Collection,
  allSubscriptions: Subscription[],
  options: ExportOptions = {},
): Promise<MergedMembers> {
  // pass-10 blocker 1: export promises VISIBLE membership — the single
  // authoritative enabled set, no duplicate inline filter
  const members = enabledCollectionMemberSubs(collection, allSubscriptions);
  if (members.length === 0) {
    throw ProblemDetailsError.unprocessable(
      `聚合订阅 "${collection.name}" 没有启用中的成员订阅,无节点可下发。`,
    );
  }

  const merged: Record<string, unknown>[] = [];
  const memberErrors: { name: string; error: string }[] = [];
  let stale = false;
  let i = 0;
  for await (const outcome of settleWithConcurrencyInOrder(
    members,
    MEMBER_FETCH_CONCURRENCY,
    (sub) =>
      resolveSubscriptionProxies(sub, {
        noCache: options.noCache,
        writeCache: options.writeCache,
      }),
  )) {
    const member = members[i];
    i += 1;
    if (outcome.status === 'rejected') {
      memberErrors.push({
        name: member.name,
        error: safeMemberError(outcome.reason),
      });
      continue;
    }
    if (outcome.value.stale) stale = true;
    if (merged.length + outcome.value.proxies.length > MAX_PROXY_NODES) {
      throw ProblemDetailsError.badRequest(
        `聚合订阅候选节点超过 ${MAX_PROXY_NODES} 个,已拒绝生成。`,
      );
    }
    // Per-member provenance (enumerable Symbol — never serialised): the
    // collection's own rename-template operator reads source alias + index
    // from it, with the same semantics as the render pipeline.
    const identity = { key: member.name, label: member.display_name?.trim() || member.name };
    for (const item of outcome.value.proxies) merged.push(withSource(item, identity));
  }

  if (memberErrors.length === members.length) {
    throw ProblemDetailsError.badRequest(
      `聚合订阅 "${collection.name}" 的全部 ${members.length} 个成员拉取失败:${memberErrors
        .map((e) => `${e.name} → ${e.error}`)
        .join('; ')}`,
    );
  }

  return { merged, memberErrors, stale };
}

/**
 * 聚合订阅的节点导出:合并成员 → 跑聚合自己的「节点处理」(在去重之前,与渲染
 * 管线的聚合绑定路径同语义)→ first-writer-wins 去重 → `proxies:` provider YAML。
 */
export async function exportCollectionNodes(
  collection: Collection,
  allSubscriptions: Subscription[],
  options: ExportOptions = {},
): Promise<NodeExportResult> {
  const { merged, memberErrors, stale } = await mergeCollectionMemberProxies(
    collection,
    allSubscriptions,
    options,
  );

  const executable = collection.operators.filter(isExecutableOperator);
  const managedOp = executable.find(
    (op): op is Extract<Operator, { kind: 'rename-template' }> => op.kind === 'rename-template',
  );
  const ordinals = managedOp
    ? await resolveOrdinalsFor(merged, sourceOf, {
        persist: options.writeCache !== false,
        template: managedOp.template,
        recognitionRules: managedOp.recognitionRules ?? [],
      })
    : undefined;
  const processed =
    executable.length > 0
      ? applyOperators(merged as ClashProxy[], executable, ordinals).proxies
      : merged;
  // PER-NODE managed-status propagation (pass-3 finding): each node's own
  // MEMBER subscription's active rename-template decides its managed
  // provenance — an unrelated managed third member can never promote a
  // plain/plain collision. The collection's own managed op promotes every
  // node (the collection stage ran managed naming over the merged set).
  // only ENABLED members contribute nodes to the export — their managed
  // provenance is the only one that can promote
  const memberManagedByKey = new Map(
    enabledCollectionMemberSubs(collection, allSubscriptions).map((m) => [
      m.name,
      (m.operators ?? []).some((op) => op.kind === 'rename-template' && !op.disabled),
    ]),
  );
  const {
    proxies: deduped,
    deduped: dropped,
    resolved: renamed,
  } = dedupExportProxies(processed, (item) => {
    if (managedOp !== undefined) return true;
    const key = sourceOf(item)?.key;
    return key !== undefined && memberManagedByKey.get(key) === true;
  });
  // Provenance must never reach the serialised provider YAML / public API.
  const stripped = deduped.map((p) => stripSource(p));
  const proxies = validateMihomoProxyList(stripped, {
    allowExternalDialerProxy: true,
  });
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    proxies,
    proxyCount: proxies.length,
    ...(dropped.length > 0 ? { deduped: dropped } : {}),
    ...(renamed.length > 0 ? { resolvedNames: renamed } : {}),
    stale,
    memberErrors,
  };
}
