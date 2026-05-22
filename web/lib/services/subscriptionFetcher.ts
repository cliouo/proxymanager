import { parse, stringify } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
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
import type { Subscription, SubscriptionTraffic } from '@/schemas';

const DEFAULT_UA = 'clash.meta/1.18.0';
const FETCH_TIMEOUT_MS = 15_000;

export interface FetchSubscriptionResult {
  /** Normalised Clash provider YAML: `proxies:` block only. */
  yaml: string;
  traffic?: SubscriptionTraffic;
  proxyCount: number;
}

/**
 * Resolve a subscription's current content. The single entry point used by
 * every other caller:
 *
 *   - kind=local → returns the inline content verbatim, normalised
 *   - kind=remote + !noCache + cache hit (within ttl_ms) → returns cache
 *   - kind=remote + (noCache OR cache miss/stale) → HTTP fetch, persist cache
 *
 * Cache key is keyed by url + ua + custom_headers (Sub-Store convention) so
 * two subs hitting the same airport with the same UA share cache; flipping
 * UA invalidates.
 */
export async function resolveSubscriptionContent(
  sub: Subscription,
  options: { noCache?: boolean; timeoutMs?: number } = {},
): Promise<FetchSubscriptionResult> {
  if (sub.kind === 'local') {
    if (!sub.content) {
      throw ProblemDetailsError.unprocessable(
        `Subscription "${sub.name}" is kind=local but has no content.`,
      );
    }
    const { yaml, proxyCount } = normaliseToClashProviderYaml(sub.content);
    return { yaml, proxyCount, traffic: undefined };
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

  if (!options.noCache) {
    const cached = await getFetchCache(cacheKey);
    if (cached) {
      return { yaml: cached.content, traffic: cached.traffic, proxyCount: cached.proxy_count };
    }
  }

  const fresh = await fetchSubscriptionInternal(sub.url, {
    userAgent: sub.ua_override ?? DEFAULT_UA,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    customHeaders: sub.custom_headers,
  });

  const entry: FetchCacheEntry = {
    content: fresh.yaml,
    traffic: fresh.traffic,
    proxy_count: fresh.proxyCount,
    fetched_at: Date.now(),
  };
  await setFetchCache(cacheKey, entry, sub.ttl_ms).catch(() => undefined);

  return fresh;
}

/** Fetch + normalise an upstream subscription URL into a Clash provider YAML. */
export async function fetchSubscription(
  url: string,
  options: { userAgent?: string; timeoutMs?: number } = {},
): Promise<FetchSubscriptionResult> {
  return fetchSubscriptionInternal(url, options);
}

async function fetchSubscriptionInternal(
  url: string,
  options: { userAgent?: string; timeoutMs?: number; customHeaders?: Record<string, string> } = {},
): Promise<FetchSubscriptionResult> {
  const userAgent = options.userAgent ?? DEFAULT_UA;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': userAgent, ...(options.customHeaders ?? {}) },
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw ProblemDetailsError.badRequest(`Upstream fetch timed out after ${timeoutMs}ms`);
    }
    throw ProblemDetailsError.badRequest(
      `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw ProblemDetailsError.badRequest(`Upstream returned HTTP ${response.status}`);
  }

  const text = await response.text();
  const traffic = parseTrafficHeader(response.headers.get('subscription-userinfo'));
  const { yaml, proxyCount } = normaliseToClashProviderYaml(text);
  return { yaml, traffic, proxyCount };
}

export function parseTrafficHeader(value: string | null): SubscriptionTraffic | undefined {
  if (!value) return undefined;
  const fields: Record<string, number> = {};
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const num = Number(trimmed.slice(eq + 1).trim());
    if (Number.isFinite(num)) fields[key] = num;
  }
  if (Object.keys(fields).length === 0) return undefined;
  return {
    upload: fields.upload ?? 0,
    download: fields.download ?? 0,
    total: fields.total ?? 0,
    expire: fields.expire ?? 0,
  };
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
 */
export function normaliseToClashProviderYaml(text: string): { yaml: string; proxyCount: number } {
  const cleaned = stripBom(text).trim();
  if (!cleaned) {
    throw ProblemDetailsError.badRequest('Empty subscription content');
  }

  // 1) Clash YAML with a `proxies:` array
  const fromYaml = tryExtractProxiesFromYaml(cleaned);
  if (fromYaml) {
    const yaml = stringify({ proxies: fromYaml }, { lineWidth: 0 });
    return { yaml, proxyCount: fromYaml.length };
  }

  // 2) Line-delimited proxy URIs — optionally wrapped in base64
  let uriText = cleaned;
  if (!looksLikeProxyUriList(uriText)) {
    const decoded = tryBase64Decode(uriText);
    if (decoded && looksLikeProxyUriList(decoded)) uriText = decoded;
  }
  if (looksLikeProxyUriList(uriText)) {
    const { proxies, errors } = parseProxyUriList(uriText);
    if (proxies.length > 0) {
      const yaml = stringify({ proxies }, { lineWidth: 0 });
      return { yaml, proxyCount: proxies.length };
    }
    if (errors.length > 0) {
      const sample = errors
        .slice(0, 3)
        .map((e) => `"${e.line}" → ${e.error}`)
        .join('; ');
      throw ProblemDetailsError.badRequest(
        `No proxy URIs parsed (${errors.length} failed): ${sample}`,
      );
    }
  }

  throw ProblemDetailsError.badRequest(
    'No recognisable proxies found. Supported: Clash YAML `proxies:` block, line-delimited proxy URIs (ss:// vmess:// vless:// trojan:// hysteria2:// tuic:// ssr:// snell:// socks5:// http://), or base64-encoded variants.',
  );
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
