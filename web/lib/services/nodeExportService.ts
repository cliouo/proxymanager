import { stringify } from 'yaml';
import { resolveCollectionMemberSubs, settleWithConcurrency } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
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
  /** 去重后的节点数。 */
  proxyCount: number;
  /** 任一来源命中 stale-on-error 缓存回退时为 true。 */
  stale: boolean;
  /** 单订阅导出时透传上游 Subscription-Userinfo(聚合无意义,恒为空)。 */
  traffic?: SubscriptionTraffic;
  /** 聚合导出时,拉取失败被跳过的成员(全员失败则直接抛错,不会走到这)。 */
  memberErrors: { name: string; error: string }[];
}

interface ExportOptions {
  noCache?: boolean;
}

/** 同时在途的成员订阅 fetch 上限,与渲染管线保持一致。 */
const MEMBER_FETCH_CONCURRENCY = 8;

/** 取节点名(非字符串名的项跳过)。 */
function nameOf(item: Record<string, unknown>): string | null {
  return typeof item.name === 'string' ? item.name : null;
}

/** First-writer-wins 同名去重 —— 与 resolveConfig 注入链路同序同语义。 */
function dedupByName(proxies: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const survivors: Record<string, unknown>[] = [];
  for (const item of proxies) {
    const name = nameOf(item);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    survivors.push(item);
  }
  return survivors;
}

/** 单订阅源的节点导出。停用的源由路由层拦下(404),这里不重复判断。 */
export async function exportSubscriptionNodes(
  sub: Subscription,
  options: ExportOptions = {},
): Promise<NodeExportResult> {
  const result = await resolveSubscriptionProxies(sub, { noCache: options.noCache });
  const proxies = dedupByName(result.proxies);
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    proxyCount: proxies.length,
    stale: result.stale === true,
    traffic: result.traffic,
    memberErrors: [],
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
  const members = resolveCollectionMemberSubs(collection, allSubscriptions).filter(
    (s) => s.enabled,
  );
  if (members.length === 0) {
    throw ProblemDetailsError.unprocessable(
      `聚合订阅 "${collection.name}" 没有启用中的成员订阅,无节点可下发。`,
    );
  }

  const settled = await settleWithConcurrency(members, MEMBER_FETCH_CONCURRENCY, (sub) =>
    resolveSubscriptionProxies(sub, { noCache: options.noCache }),
  );

  const merged: Record<string, unknown>[] = [];
  const memberErrors: { name: string; error: string }[] = [];
  let stale = false;
  for (let i = 0; i < members.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      memberErrors.push({
        name: members[i].name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (outcome.value.stale) stale = true;
    merged.push(...outcome.value.proxies);
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

  const processed =
    collection.operators.length > 0
      ? applyOperators(merged as ClashProxy[], collection.operators).proxies
      : merged;
  const proxies = dedupByName(processed as Record<string, unknown>[]);
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    proxyCount: proxies.length,
    stale,
    memberErrors,
  };
}
