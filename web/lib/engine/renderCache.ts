/**
 * renderProfileConfig — cached front door for the full resolve pipeline.
 *
 * The three read routes (/api/v1/preview/[profile], /api/sub/[token]/[profile],
 * /api/v1/base/parsed) used to each run: 7-8 Redis HGETALLs → subscription
 * fetches → full YAML render. This module short-circuits that to a single
 * Redis MGET when nothing changed:
 *
 *   - validity   — entry.version must equal the global config:version counter
 *                  (bumped by every repo write that affects render output);
 *   - identity   — entry.providerUrlBase must equal the request's (the
 *                  rendered rule-providers URLs bake it in);
 *   - freshness  — entry must be younger than the min ttl_ms of the
 *                  subscriptions that actually participated in the render
 *                  (upstream sub content can change without any repo write).
 *
 * Anything else falls through to the real pipeline and rewrites the entry.
 */

import { resolveConfig, type ResolveResult } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';

/**
 * Ceiling for the freshness window. With no participating subscriptions the
 * render only changes via repo writes (covered by the version check), so
 * 24h is purely a safety net.
 */
const MAX_FRESH_MS = 24 * 60 * 60 * 1000;
/** Slack added to the Redis EX over the freshness window (GC, not validity). */
const EX_SLACK_SECONDS = 60;

/**
 * Code-level cache epoch. `config:version` only bumps on data writes, so a pure
 * change to render *logic* (e.g. which rule-providers get emitted) would keep
 * serving stale entries until a freshness lapse or unrelated edit. Bump this on
 * any deploy that changes render output so existing entries (which carry an old
 * or absent epoch) miss and re-render immediately.
 *   1 → +base `rule-set:` refs now emit their rule-providers declaration.
 *   2 → dropped node_prefix (names no longer prefixed) + single-sub groups now
 *       emit `proxies` from member nodes instead of a `^prefix` filter.
 *   3 → chained-proxy wraps render as cloned `proxies:` entries (dialer-proxy
 *       isn't honored on a proxy-group); include-all groups now exclude clones.
 *   4 → chain clone now also covers subscription-injected backends (plain
 *       objects), not just base.yaml literals.
 *   5 → a chain wrap whose backend node is missing (renamed/dropped) is now
 *       pruned instead of emitted as a group referencing a non-existent node;
 *       references to it (group members / rules) are scrubbed so the config
 *       still loads.
 */
const RENDER_CACHE_EPOCH = 5;

export type RenderCacheStatus = 'hit' | 'miss' | 'bypass';

/** The ResolveResult fields the routes consume — serialised as-is into Redis. */
export type CachedResolveOutput = Pick<
  ResolveResult,
  | 'content'
  | 'buildId'
  | 'anchorsApplied'
  | 'unmatchedAnchors'
  | 'ruleProvidersApplied'
  | 'subscriptions'
  | 'collisions'
  | 'nodeNames'
  | 'nodesBySub'
  | 'warnings'
  | 'inlinedProxyCount'
  | 'proxyGroupCount'
>;

export interface RenderCacheEntry extends CachedResolveOutput {
  /** {@link RENDER_CACHE_EPOCH} the entry was produced under; mismatch ⇒ miss. */
  epoch: number;
  /** config:version observed BEFORE loading data (see race note below). */
  version: number;
  /** Raw providerUrlBase string the render was produced with (null = none). */
  providerUrlBase: string | null;
  /** ms epoch when the render completed. */
  renderedAt: number;
  /** Freshness window — min ttl_ms across participating subs, capped at 24h. */
  freshForMs: number;
  /** base.yaml meta carried along so /api/v1/base/parsed can answer from cache. */
  baseEtag: string;
  baseUpdatedAt: number;
}

export interface RenderProfileOptions {
  /** Absolute base for rendered rule-provider URLs; part of the cache identity. */
  providerUrlBase?: string;
  /** Skip reading the cache and force-refresh upstream subs; still writes the cache. */
  noCache?: boolean;
  /**
   * Error to throw when base.yaml is uninitialised. Routes differ (preview/sub
   * use 404, base/parsed uses 422) and their response shapes must not change.
   */
  missingBaseError?: () => ProblemDetailsError;
}

export interface RenderProfileResult {
  resolved: CachedResolveOutput;
  baseEtag: string;
  baseUpdatedAt: number;
  cache: RenderCacheStatus;
}

function defaultMissingBaseError(): ProblemDetailsError {
  return ProblemDetailsError.notFound('Base config has not been initialized yet.');
}

export async function renderProfileConfig(
  profileName: string,
  opts: RenderProfileOptions = {},
): Promise<RenderProfileResult> {
  const redis = getRedis();
  const cacheKey = REDIS_KEYS.renderCache(profileName);
  const providerUrlBase = opts.providerUrlBase ?? null;

  // 防竞态:版本号必须在读取任何数据**之前**取到,并原样写进缓存条目。若渲染
  // 期间有并发写(bump),写进缓存的是旧版本号,下次读取时版本比对失配 →
  // 重新渲染。先读数据后读版本则可能把「新版本号 + 旧数据」缓存住,永远不失效。
  let version: number;

  if (!opts.noCache) {
    // 命中路径的全部 Redis 开销:这一次 MGET(版本号 + 缓存条目)。
    const [rawVersion, entry] = await redis.mget<[number | null, RenderCacheEntry | null]>(
      REDIS_KEYS.configVersion,
      cacheKey,
    );
    version = rawVersion ?? 0;
    if (
      entry !== null &&
      entry.epoch === RENDER_CACHE_EPOCH &&
      entry.version === version &&
      (entry.providerUrlBase ?? null) === providerUrlBase &&
      Date.now() - entry.renderedAt < entry.freshForMs
    ) {
      return {
        resolved: entry,
        baseEtag: entry.baseEtag,
        baseUpdatedAt: entry.baseUpdatedAt,
        cache: 'hit',
      };
    }
  } else {
    // bypass 也要先取版本号 — 渲染结果仍会写回缓存,同样要防上面的竞态。
    version = (await redis.get<number>(REDIS_KEYS.configVersion)) ?? 0;
  }

  // Miss / bypass — the data loading the three routes used to duplicate.
  const [
    base,
    rules,
    providers,
    subscriptions,
    proxyGroups,
    templates,
    collections,
    profileRecord,
  ] = await Promise.all([
    getBase(),
    listRules(),
    listRuleSets(),
    listSubscriptions(),
    listProxyGroups(),
    listProxyGroupTemplates(),
    listCollections(),
    getProfileByName(profileName),
  ]);
  if (!base) {
    throw (opts.missingBaseError ?? defaultMissingBaseError)();
  }

  const resolved = await resolveConfig(base.content, rules, subscriptions, proxyGroups, templates, {
    providers,
    providerUrlBase: opts.providerUrlBase,
    ignoreFailedSubs: true,
    noCache: opts.noCache,
    collections,
    // Profile binding. When no profile record exists yet (pre-init), falls
    // through to "every enabled sub" — backward-compat.
    boundSource: profileRecord?.source,
  });

  // 新鲜度窗口 = 实际参与注入的订阅(resolveConfig 已做过 enabled + boundSource
  // 过滤,subscriptions 状态列表就是参与名单)的 ttl_ms 最小值。订阅上游内容
  // 变化不经过任何 repo 写,版本号不会动,只能靠 TTL 兜底。
  const participating = new Set(resolved.subscriptions.map((s) => s.name));
  const ttls = subscriptions.filter((s) => participating.has(s.name)).map((s) => s.ttl_ms);
  const freshForMs = Math.min(ttls.length > 0 ? Math.min(...ttls) : MAX_FRESH_MS, MAX_FRESH_MS);

  const entry: RenderCacheEntry = {
    epoch: RENDER_CACHE_EPOCH,
    version,
    providerUrlBase,
    renderedAt: Date.now(),
    freshForMs,
    baseEtag: base.etag,
    baseUpdatedAt: base.updated_at,
    content: resolved.content,
    buildId: resolved.buildId,
    anchorsApplied: resolved.anchorsApplied,
    unmatchedAnchors: resolved.unmatchedAnchors,
    ruleProvidersApplied: resolved.ruleProvidersApplied,
    subscriptions: resolved.subscriptions,
    collisions: resolved.collisions,
    nodeNames: resolved.nodeNames,
    nodesBySub: resolved.nodesBySub,
    warnings: resolved.warnings,
    inlinedProxyCount: resolved.inlinedProxyCount,
    proxyGroupCount: resolved.proxyGroupCount,
  };
  // EX 只是垃圾回收;有效性由 version/renderedAt 判定,所以略宽于窗口即可。
  await redis.set(cacheKey, entry, { ex: Math.ceil(freshForMs / 1000) + EX_SLACK_SECONDS });

  return {
    resolved: entry,
    baseEtag: base.etag,
    baseUpdatedAt: base.updated_at,
    cache: opts.noCache ? 'bypass' : 'miss',
  };
}
