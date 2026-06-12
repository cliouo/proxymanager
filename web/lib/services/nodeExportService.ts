import { stringify } from 'yaml';
import { resolveCollectionMemberSubs, settleWithConcurrency } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import type { Collection, Subscription, SubscriptionTraffic } from '@/schemas';

/**
 * 节点导出服务 —— 「分发」公开链接的产物:只含 `proxies:` 的 Clash provider
 * YAML,可直接填进任何 mihomo / Clash 客户端的 proxy-provider `url:`,或当普
 * 通订阅导入。与渲染管线(resolveConfig)共享同一套语义:operators 流水线、
 * `node_prefix` 前缀、同名 first-writer-wins 去重 —— 同一个节点在这里和在
 * 最终配置里叫同一个名字。
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

/** 渲染管线同款前缀语义:加前缀、原对象不动,无前缀时零拷贝。 */
function applyPrefix(
  proxies: Record<string, unknown>[],
  prefix: string | undefined,
): { node: Record<string, unknown>; name: string }[] {
  const out: { node: Record<string, unknown>; name: string }[] = [];
  for (const item of proxies) {
    const origName = item.name;
    if (typeof origName !== 'string') continue;
    const finalName = prefix ? `${prefix}${origName}` : origName;
    out.push({
      node: prefix && finalName !== origName ? { ...item, name: finalName } : item,
      name: finalName,
    });
  }
  return out;
}

/** First-writer-wins 同名去重 —— 与 resolveConfig 注入链路同序同语义。 */
function dedupByName(
  candidates: { node: Record<string, unknown>; name: string }[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const survivors: Record<string, unknown>[] = [];
  for (const c of candidates) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    survivors.push(c.node);
  }
  return survivors;
}

/** 单订阅源的节点导出。停用的源由路由层拦下(404),这里不重复判断。 */
export async function exportSubscriptionNodes(
  sub: Subscription,
  options: ExportOptions = {},
): Promise<NodeExportResult> {
  const result = await resolveSubscriptionProxies(sub, { noCache: options.noCache });
  const proxies = dedupByName(applyPrefix(result.proxies, sub.node_prefix));
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    proxyCount: proxies.length,
    stale: result.stale === true,
    traffic: result.traffic,
    memberErrors: [],
  };
}

/**
 * 聚合订阅的节点导出:成员展开(直接指定 + 标签匹配,只取启用的)→ 并行
 * fetch → 按成员原序应用前缀、合并、去重。个别成员拉取失败跳过并记入
 * `memberErrors`(对外仍可用 —— 和渲染管线容忍失败订阅一致);全员失败才抛。
 */
export async function exportCollectionNodes(
  collection: Collection,
  allSubscriptions: Subscription[],
  options: ExportOptions = {},
): Promise<NodeExportResult> {
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

  const candidates: { node: Record<string, unknown>; name: string }[] = [];
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
    candidates.push(...applyPrefix(outcome.value.proxies, members[i].node_prefix));
  }

  if (memberErrors.length === members.length) {
    throw ProblemDetailsError.badRequest(
      `聚合订阅 "${collection.name}" 的全部 ${members.length} 个成员拉取失败:${memberErrors
        .map((e) => `${e.name} → ${e.error}`)
        .join('; ')}`,
    );
  }

  const proxies = dedupByName(candidates);
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    proxyCount: proxies.length,
    stale,
    memberErrors,
  };
}
