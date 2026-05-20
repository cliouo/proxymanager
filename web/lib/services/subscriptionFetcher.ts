import { parse, stringify } from 'yaml';
import type { SubscriptionTraffic } from '@/schemas';
import { ProblemDetailsError } from '@/lib/http/problem';

const DEFAULT_UA = 'clash.meta/1.18.0';
const FETCH_TIMEOUT_MS = 15_000;

export interface FetchSubscriptionResult {
  /** Normalised Clash provider YAML: `proxies:` block only. */
  yaml: string;
  traffic?: SubscriptionTraffic;
  proxyCount: number;
}

/** Fetch + normalise an upstream subscription URL into a Clash provider YAML. */
export async function fetchSubscription(
  url: string,
  options: { userAgent?: string; timeoutMs?: number } = {},
): Promise<FetchSubscriptionResult> {
  const userAgent = options.userAgent ?? DEFAULT_UA;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
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
 * Accepts either a Clash subscription YAML (full config or just `proxies:`) and
 * returns a minimal provider YAML containing only the `proxies:` array. Other
 * formats (base64 v2ray subscription, raw SS/VLESS URIs) are not yet supported.
 */
export function normaliseToClashProviderYaml(text: string): { yaml: string; proxyCount: number } {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    throw ProblemDetailsError.badRequest(
      `Upstream is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!data || typeof data !== 'object') {
    throw ProblemDetailsError.badRequest('Upstream YAML is empty or not an object');
  }

  const proxies = (data as { proxies?: unknown }).proxies;
  if (!Array.isArray(proxies)) {
    throw ProblemDetailsError.badRequest(
      'Upstream does not contain a `proxies:` array. Only Clash-format subscriptions are supported.',
    );
  }

  const yaml = stringify({ proxies }, { lineWidth: 0 });
  return { yaml, proxyCount: proxies.length };
}
