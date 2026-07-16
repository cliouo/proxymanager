import { parse, stringify } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { readCapped } from '@/lib/net/safeFetch';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { validateMihomoProxyList } from '@/lib/proxies/mihomoProxyValidator';
import {
  listSupportedProxyUriSchemes,
  looksLikeProxyUriList,
  parseProxyUriList,
  tryBase64Decode,
} from '@/lib/proxies/uriToClash';
import {
  buildCacheKey,
  getFetchCache,
  setFetchCache,
  type FetchCacheEntry,
} from '@/lib/repos/fetchCacheRepo';
import {
  SubscriptionTrafficSchema,
  type Subscription,
  type SubscriptionTraffic,
} from '@/schemas/subscription';

const DEFAULT_UA = 'clash.meta/1.18.0';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SUBSCRIPTION_REDIRECTS = 5;
/** P2-6: hard cap on an upstream subscription body (a slow/huge source can't OOM or hang the render). */
const MAX_SUBSCRIPTION_BODY_BYTES = 10 * 1024 * 1024;
/**
 * Upper bound on how long we keep a stale cache entry around as a fallback
 * for stale-on-error. The Redis EX is set to `max(ttl_ms, STALE_TTL_MS)` so
 * the key survives past the freshness window; freshness is judged separately
 * via `fetched_at`.
 */
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FetchSubscriptionResult {
  /** Normalised Clash provider YAML: `proxies:` block only. */
  yaml: string;
  traffic?: SubscriptionTraffic;
  proxyCount: number;
  /**
   * True when this result came from a stale cache entry because the upstream
   * fetch failed. Callers surface this in summaries so users know the data
   * may be out of date.
   */
  stale?: boolean;
  /** When `stale`, the error message that caused the fallback. */
  staleReason?: string;
}

/** Object-level twin of {@link FetchSubscriptionResult} — proxies as parsed objects, no YAML string. */
export interface FetchSubscriptionProxiesResult {
  /**
   * Parsed Clash proxy objects. For {@link resolveSubscriptionProxies} the
   * sub's operators are already applied; for
   * {@link resolveSubscriptionProxiesRaw} they are the raw pre-operator list.
   */
  proxies: Record<string, unknown>[];
  traffic?: SubscriptionTraffic;
  proxyCount: number;
  stale?: boolean;
  staleReason?: string;
}

/**
 * Internal dual-view of a raw (pre-operator) subscription resolution.
 *
 * 为什么不直接返回字符串:渲染主链路(resolve.ts)只需要对象数组,而
 * sub-provider 输出端点只需要 YAML 字符串。让两侧各自惰性求值,谁都不为
 * 对方多付一次 parse / stringify(800 节点一轮 parse ≈35ms,曾经三轮全浪费)。
 *
 *   - 来源是对象(local 内容 / 新鲜 fetch 刚 normalise 完)→ yaml 惰性 stringify
 *   - 来源是缓存字符串(命中 / stale 回退)→ 先严格 parse + validate；yaml 原样复用
 *
 * Both getters memoise, so repeated access costs nothing extra.
 */
interface RawResolved {
  getYaml(): string;
  getProxies(): Record<string, unknown>[];
  traffic?: SubscriptionTraffic;
  proxyCount: number;
  stale?: boolean;
  staleReason?: string;
}

interface RawMeta {
  traffic?: SubscriptionTraffic;
  proxyCount: number;
  stale?: boolean;
  staleReason?: string;
}

/** Build a {@link RawResolved} whose source of truth is a parsed proxy list. */
function rawFromProxies(list: unknown[], meta: RawMeta): RawResolved {
  let yaml: string | undefined;
  const objects = validateProviderProxyList(list);
  return {
    // lineWidth: 0 keeps long vmess/ssr lines unwrapped — same bytes the old
    // normaliseToClashProviderYaml produced, so the cache entry format 不变。
    getYaml: () => (yaml ??= stringify({ proxies: objects }, { lineWidth: 0 })),
    getProxies: () => objects,
    ...meta,
  };
}

/** Build a {@link RawResolved} whose source of truth is a provider-YAML string (cache entries). */
function rawFromYaml(yamlText: string, meta: RawMeta): RawResolved {
  // Cache bytes are an optimisation, not a trust boundary. Validate eagerly so
  // the string endpoint cannot serve a corrupt entry that the object endpoint
  // would reject only later.
  const objects = extractProxyObjects(yamlText);
  return {
    getYaml: () => yamlText,
    getProxies: () => objects,
    ...meta,
    // Cache metadata is an optimisation and may be stale or corrupt. The
    // validated payload is authoritative for every downstream count.
    proxyCount: objects.length,
  };
}

function extractProxyObjects(yamlText: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = parse(yamlText);
  } catch {
    throw ProblemDetailsError.badRequest('Cached proxy provider YAML is invalid');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw ProblemDetailsError.badRequest('Cached proxy provider YAML has no proxies array');
  }
  const proxies = (parsed as { proxies?: unknown }).proxies;
  if (!Array.isArray(proxies)) {
    throw ProblemDetailsError.badRequest('Cached proxy provider YAML has no proxies array');
  }
  return validateProviderProxyList(proxies);
}

/**
 * Resolve a subscription's current content — the single entry point used by
 * every other caller. Returns proxies with the sub's node-processing
 * pipeline (`operators`) already applied, so the sub-provider endpoint,
 * collection expansion, and refresh all see the same processed list.
 *
 * The fetch cache stores the *raw* (pre-operator) provider YAML, so editing
 * operators never forces a re-fetch — only the cheap pipeline re-runs.
 */
export async function resolveSubscriptionContent(
  sub: Subscription,
  options: { noCache?: boolean; timeoutMs?: number } = {},
): Promise<FetchSubscriptionResult> {
  const raw = await resolveSubscriptionRaw(sub, options);
  if (!sub.operators || sub.operators.length === 0) {
    return {
      yaml: raw.getYaml(),
      traffic: raw.traffic,
      proxyCount: raw.proxyCount,
      stale: raw.stale,
      staleReason: raw.staleReason,
    };
  }
  // Object-level pipeline, then one stringify at the boundary — the old
  // applyOperatorsToProviderYaml round-trip (parse→ops→stringify) parsed a
  // string we had just produced ourselves.
  const { proxies: operated } = applyOperators(raw.getProxies() as ClashProxy[], sub.operators);
  const proxies = validateProviderProxyList(operated);
  return {
    yaml: stringify({ proxies }, { lineWidth: 0 }),
    traffic: raw.traffic,
    proxyCount: proxies.length,
    stale: raw.stale,
    staleReason: raw.staleReason,
  };
}

/**
 * Object-level entry point: same fetch/cache/operator semantics as
 * {@link resolveSubscriptionContent}, but returns parsed proxy objects and
 * never serialises to YAML. The render pipeline (engine/resolve.ts) consumes
 * objects directly, so going through the string version would just be a
 * stringify+parse round-trip per subscription per render.
 */
export async function resolveSubscriptionProxies(
  sub: Subscription,
  options: { noCache?: boolean; timeoutMs?: number } = {},
): Promise<FetchSubscriptionProxiesResult> {
  const raw = await resolveSubscriptionRaw(sub, options);
  const base = raw.getProxies();
  if (!sub.operators || sub.operators.length === 0) {
    return {
      proxies: base,
      traffic: raw.traffic,
      proxyCount: base.length,
      stale: raw.stale,
      staleReason: raw.staleReason,
    };
  }
  const { proxies: operated } = applyOperators(base as ClashProxy[], sub.operators);
  const proxies = validateProviderProxyList(operated);
  return {
    proxies: proxies as Record<string, unknown>[],
    traffic: raw.traffic,
    proxyCount: proxies.length,
    stale: raw.stale,
    staleReason: raw.staleReason,
  };
}

/**
 * Resolve a subscription's *raw* content — fetch/normalise only, no
 * operator pipeline. Used by {@link resolveSubscriptionContent} and by the
 * preview endpoint (which applies an unsaved pipeline to these raw proxies).
 * String-shaped wrapper over {@link resolveSubscriptionRaw}.
 */
export async function resolveSubscriptionContentRaw(
  sub: Subscription,
  options: { noCache?: boolean; timeoutMs?: number } = {},
): Promise<FetchSubscriptionResult> {
  const raw = await resolveSubscriptionRaw(sub, options);
  return {
    yaml: raw.getYaml(),
    traffic: raw.traffic,
    proxyCount: raw.proxyCount,
    stale: raw.stale,
    staleReason: raw.staleReason,
  };
}

/**
 * Object-level twin of {@link resolveSubscriptionContentRaw}: same raw
 * (pre-operator, `sub.operators` NOT applied) resolution, but returns parsed
 * proxy objects. The preview endpoint applies its *unsaved* pipeline to these
 * raw proxies — going through the string version meant re-parsing a YAML
 * string we had just produced (or had cached) ourselves.
 *
 * Note: unlike {@link resolveSubscriptionProxies}, `proxies` here is the raw
 * pre-operator list. Every entry is already strictly validated, and
 * `proxyCount` is derived from that same list on every source/cache path.
 */
export async function resolveSubscriptionProxiesRaw(
  sub: Subscription,
  options: { noCache?: boolean; timeoutMs?: number } = {},
): Promise<FetchSubscriptionProxiesResult> {
  const raw = await resolveSubscriptionRaw(sub, options);
  return {
    proxies: raw.getProxies(),
    traffic: raw.traffic,
    proxyCount: raw.proxyCount,
    stale: raw.stale,
    staleReason: raw.staleReason,
  };
}

/**
 * Core raw resolver (dual-view result, see {@link RawResolved}).
 *
 *   - kind=local → returns the inline content verbatim, normalised
 *   - kind=remote + !noCache + cache fresh (within ttl_ms) → returns cache
 *   - kind=remote + (noCache OR stale) → HTTP fetch; on failure with a
 *     cached entry still present, falls back to that entry tagged
 *     `stale: true` (unless `noCache` — the caller explicitly asked for
 *     fresh, so we surface the error).
 *
 * Cache key is keyed by url + ua + custom_headers (Sub-Store convention) so
 * two subs hitting the same airport with the same UA share cache; flipping
 * UA invalidates. Entries persist in Redis for `max(ttl_ms, STALE_TTL_MS)`
 * so the stale-on-error fallback has something to serve past expiry.
 */
async function resolveSubscriptionRaw(
  sub: Subscription,
  options: { noCache?: boolean; timeoutMs?: number } = {},
): Promise<RawResolved> {
  if (sub.kind === 'local') {
    if (!sub.content) {
      throw ProblemDetailsError.unprocessable(
        `Subscription "${sub.name}" is kind=local but has no content.`,
      );
    }
    const { proxies, proxyCount } = normaliseToClashProxies(sub.content);
    return rawFromProxies(proxies, { proxyCount, traffic: undefined });
  }

  if (!sub.url) {
    throw ProblemDetailsError.unprocessable(
      `Subscription "${sub.name}" is kind=remote but has no url.`,
    );
  }

  const cacheKey = buildCacheKey({
    url: sub.url,
    userAgent: sub.ua_override ?? DEFAULT_UA,
    headers: sub.custom_headers,
  });

  // Read once up front — we may use it as fresh, or as the stale fallback.
  // Validate the payload before either decision: cache age/envelope validity
  // alone does not make the embedded provider YAML trustworthy.
  const cached = options.noCache ? null : await getFetchCache(cacheKey);
  let cachedRaw: RawResolved | null = null;
  if (cached) {
    try {
      cachedRaw = rawFromYaml(cached.content, {
        traffic: cached.traffic,
        proxyCount: cached.proxy_count,
      });
    } catch (error) {
      if (!(error instanceof ProblemDetailsError)) throw error;
      // A corrupt payload is a cache miss. Continue to the network path and
      // never let these bytes qualify for stale-on-error fallback.
      cachedRaw = null;
    }
  }
  if (cachedRaw && cached && Date.now() - cached.fetched_at < sub.ttl_ms) {
    return cachedRaw;
  }

  try {
    const fresh = await fetchSubscriptionInternal(sub.url, {
      userAgent: sub.ua_override ?? DEFAULT_UA,
      timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
      customHeaders: sub.custom_headers,
    });

    const entry: FetchCacheEntry = {
      // The cache stores the provider-YAML string (entry format unchanged);
      // getYaml() memoises, so a later string-shaped caller pays nothing.
      content: fresh.getYaml(),
      traffic: fresh.traffic,
      proxy_count: fresh.proxyCount,
      fetched_at: Date.now(),
    };
    // Keep the entry around long enough to back stale-on-error reads.
    await setFetchCache(cacheKey, entry, Math.max(sub.ttl_ms, STALE_TTL_MS)).catch(() => undefined);

    return fresh;
  } catch (err) {
    if (cachedRaw) {
      // Stale-on-error: upstream is unreachable but we have a prior fetch.
      // Only a payload validated above qualifies as last-known-good.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ...cachedRaw,
        stale: true,
        staleReason: reason,
      };
    }
    throw err;
  }
}

/** Fetch + normalise an upstream subscription URL into a Clash provider YAML. */
export async function fetchSubscription(
  url: string,
  options: { userAgent?: string; timeoutMs?: number } = {},
): Promise<FetchSubscriptionResult> {
  const raw = await fetchSubscriptionInternal(url, options);
  return { yaml: raw.getYaml(), traffic: raw.traffic, proxyCount: raw.proxyCount };
}

async function fetchSubscriptionInternal(
  url: string,
  options: { userAgent?: string; timeoutMs?: number; customHeaders?: Record<string, string> } = {},
): Promise<RawResolved> {
  const upstreamUrl = parseSubscriptionUrl(url);
  const userAgent = options.userAgent ?? DEFAULT_UA;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let text: string;
  let traffic: SubscriptionTraffic | undefined;
  try {
    let currentUrl = upstreamUrl;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_SUBSCRIPTION_REDIRECTS; hop++) {
      response = await fetch(currentUrl, {
        headers: { 'User-Agent': userAgent, ...(options.customHeaders ?? {}) },
        // Undici strips standard credential headers on a cross-origin redirect,
        // but forwards arbitrary custom token headers. Handle redirects here so
        // admin-supplied subscription credentials can never cross an origin.
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) break;

      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw ProblemDetailsError.badRequest('Upstream redirect is missing Location');
      }
      if (hop === MAX_SUBSCRIPTION_REDIRECTS) {
        throw ProblemDetailsError.badRequest('Upstream returned too many redirects');
      }

      let nextUrl: URL;
      try {
        nextUrl = parseSubscriptionUrl(new URL(location, currentUrl).toString());
      } catch (error) {
        if (error instanceof ProblemDetailsError) throw error;
        throw ProblemDetailsError.badRequest('Upstream redirect URL is invalid');
      }
      if (nextUrl.origin !== currentUrl.origin) {
        throw ProblemDetailsError.badRequest('Cross-origin upstream redirect is not allowed');
      }
      currentUrl = nextUrl;
    }
    if (!response) {
      throw ProblemDetailsError.badRequest('Upstream fetch failed');
    }
    if (!response.ok) {
      throw ProblemDetailsError.badRequest(`Upstream returned HTTP ${response.status}`);
    }
    traffic = parseTrafficHeader(response.headers.get('subscription-userinfo'));
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SUBSCRIPTION_BODY_BYTES) {
      throw ProblemDetailsError.badRequest(
        `Upstream subscription body exceeds ${MAX_SUBSCRIPTION_BODY_BYTES} bytes`,
      );
    }
    // P2-6: the body read must stay INSIDE the same timeout window (don't clear
    // the timer until it's consumed — a slow-drip upstream could otherwise hang
    // the render past the platform function limit) and is size-capped so a huge
    // upstream can't OOM the worker. Reuse safeFetch's capped reader.
    const { buf, truncated } = await readCapped(response, MAX_SUBSCRIPTION_BODY_BYTES);
    if (truncated) {
      throw ProblemDetailsError.badRequest(
        `Upstream subscription body exceeds ${MAX_SUBSCRIPTION_BODY_BYTES} bytes`,
      );
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw ProblemDetailsError.badRequest('Upstream subscription body is not valid UTF-8');
    }
  } catch (err) {
    if (err instanceof ProblemDetailsError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw ProblemDetailsError.badRequest(`Upstream fetch timed out after ${timeoutMs}ms`);
    }
    // Fetch implementations routinely include the complete URL (userinfo,
    // path and query) in their error text. Subscription URLs and custom
    // headers commonly carry tokens, and this message also feeds staleReason
    // and persisted last_error, so never forward the underlying diagnostic.
    throw ProblemDetailsError.badRequest('Upstream fetch failed');
  } finally {
    clearTimeout(timer);
  }

  const { proxies, proxyCount } = normaliseToClashProxies(text);
  return rawFromProxies(proxies, { traffic, proxyCount });
}

function parseSubscriptionUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw ProblemDetailsError.badRequest('Invalid upstream subscription URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ProblemDetailsError.badRequest('Upstream subscription URL must use http(s)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw ProblemDetailsError.badRequest('Upstream subscription URL must not contain userinfo');
  }
  return parsed;
}

export function parseTrafficHeader(value: string | null): SubscriptionTraffic | undefined {
  if (!value) return undefined;
  const fields: SubscriptionTraffic = { upload: 0, download: 0, total: 0, expire: 0 };
  const acceptedKeys = new Set<keyof SubscriptionTraffic>([
    'upload',
    'download',
    'total',
    'expire',
  ]);
  let recognised = false;
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!acceptedKeys.has(key as keyof SubscriptionTraffic)) continue;
    recognised = true;
    const raw = trimmed.slice(eq + 1).trim();
    fields[key as keyof SubscriptionTraffic] = raw === '' ? Number.NaN : Number(raw);
  }
  if (!recognised) return undefined;
  const parsed = SubscriptionTrafficSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Accepts any of:
 *   - Full Clash YAML config (extracts the `proxies:` array)
 *   - Clash provider YAML (a single `proxies:` block)
 *   - Multi-line block of proxy URIs (ss:// vmess:// vless:// trojan:// …)
 *   - Base64-encoded variant of the above (V2RayN airport convention)
 *
 * Returns a minimal provider YAML containing only `proxies:`. Throws
 * ProblemDetailsError when no proxies can be recognised.
 *
 * Thin string wrapper over {@link normaliseToClashProxies} — kept for
 * callers that genuinely need the YAML text.
 */
export function normaliseToClashProviderYaml(text: string): { yaml: string; proxyCount: number } {
  const { proxies, proxyCount } = normaliseToClashProxies(text);
  return { yaml: stringify({ proxies }, { lineWidth: 0 }), proxyCount };
}

/**
 * Parse a local subscription's `content` into its proxy objects, accepting
 * the same shapes as the resolver (Clash `proxies:` YAML / URI list / base64).
 * Invalid or non-object entries reject the entire source. Used by the
 * assistant's local-node tools to list + rename source nodes; the editor
 * re-serialises the result back through {@link serialiseLocalProxies},
 * normalising the stored content to a `proxies:` YAML block (fields preserved,
 * formatting may change).
 */
export function parseLocalProxies(content: string): Record<string, unknown>[] {
  const { proxies } = normaliseToClashProxies(content);
  return proxies;
}

/** Serialise proxy objects back into local-subscription content (provider YAML). */
export function serialiseLocalProxies(proxies: Record<string, unknown>[]): string {
  return stringify({ proxies }, { lineWidth: 0 });
}

/**
 * Object-level normaliser: same recognition rules as
 * {@link normaliseToClashProviderYaml} but stops at the parsed proxy list —
 * no stringify. The returned list is strict and complete: any malformed entry
 * rejects the whole input so string/object consumers cannot diverge.
 */
function normaliseToClashProxies(text: string): {
  proxies: Record<string, unknown>[];
  proxyCount: number;
} {
  const cleaned = stripBom(text).trim();
  if (!cleaned) {
    throw ProblemDetailsError.badRequest('Empty subscription content');
  }

  // 1) Clash YAML with a `proxies:` array
  const fromYaml = tryExtractProxiesFromYaml(cleaned);
  if (fromYaml) {
    const proxies = validateProviderProxyList(fromYaml);
    return { proxies, proxyCount: proxies.length };
  }

  // P3-12: the body may itself be base64 of a FULL Clash YAML (`proxies:`
  // block), not just a URI list — decode once and reuse it for both the YAML
  // and URI-list paths. (A base64 blob parses as a YAML scalar string, so the
  // plain-YAML check above never trips on it.)
  const decoded = tryBase64Decode(cleaned);
  if (decoded) {
    const fromDecodedYaml = tryExtractProxiesFromYaml(decoded);
    if (fromDecodedYaml) {
      const proxies = validateProviderProxyList(fromDecodedYaml);
      return { proxies, proxyCount: proxies.length };
    }
  }

  // 2) Line-delimited proxy URIs — optionally wrapped in base64
  let uriText = cleaned;
  if (!looksLikeProxyUriList(uriText) && decoded && looksLikeProxyUriList(decoded)) {
    uriText = decoded;
  }
  if (looksLikeProxyUriList(uriText)) {
    const { proxies, errors } = parseProxyUriList(uriText);
    if (errors.length > 0) {
      const sample = errors
        .slice(0, 3)
        .map((e) => `"${e.line}" → ${e.error}`)
        .join('; ');
      throw ProblemDetailsError.badRequest(
        `Proxy URI list rejected: ${errors.length} of ${proxies.length + errors.length} recognised URI lines failed; no partial provider was produced. ${sample}`,
      );
    }
    if (proxies.length > 0) {
      const validated = validateProviderProxyList(proxies);
      return { proxies: validated, proxyCount: validated.length };
    }
  }

  throw ProblemDetailsError.badRequest(
    `No recognisable proxies found. Supported: Clash YAML \`proxies:\` block, line-delimited proxy URIs (${listSupportedProxyUriSchemes()
      .map((scheme) => `${scheme}://`)
      .join(' ')}), or base64-encoded variants.`,
  );
}

/**
 * A provider is intentionally context-free: `dialer-proxy` may name a group
 * owned by the consuming full config. Validate all node-local structure and
 * in-provider cycles here, then resolve the external name at final render.
 */
function validateProviderProxyList(list: unknown[]): Record<string, unknown>[] {
  return validateMihomoProxyList(list, { allowExternalDialerProxy: true });
}

function tryExtractProxiesFromYaml(text: string): unknown[] | null {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const proxies = (data as { proxies?: unknown }).proxies;
  if (!Array.isArray(proxies)) return null;
  return proxies;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
