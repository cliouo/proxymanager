import type { Settings } from './settings';

export class ClashError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ClashError';
  }
}

function ensureClash(settings: Settings): { url: string; secret: string } {
  if (!settings.clashUrl) {
    throw new ClashError('Clash controller URL is not configured. Open the options page.');
  }
  return { url: settings.clashUrl.replace(/\/+$/, ''), secret: settings.clashSecret };
}

async function call<T>(
  settings: Settings,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { url, secret } = ensureClash(settings);
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (init?.body && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${url}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail =
      typeof body === 'object' && body && 'message' in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).message)
        : typeof body === 'string'
          ? body
          : `HTTP ${res.status}`;
    throw new ClashError(detail, res.status);
  }
  return body as T;
}

export async function clashPing(settings: Settings): Promise<unknown> {
  return call(settings, '/');
}

export interface ClashProxy {
  name: string;
  type: string;
  now?: string;
  all?: string[];
}

export async function clashProxies(
  settings: Settings,
): Promise<Record<string, ClashProxy>> {
  const res = await call<{ proxies: Record<string, ClashProxy> }>(settings, '/proxies');
  return res.proxies;
}

/**
 * Tests the latency of a Clash proxy or proxy-group against the given URL.
 * For selectors / url-tests, Clash returns the latency of the currently
 * selected (or fastest) member. Returns null if Clash reports the proxy as
 * unreachable (4xx) — the caller treats null as "infinity" for sorting.
 */
export async function clashDelay(
  settings: Settings,
  proxyName: string,
  testUrl: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const encoded = encodeURIComponent(proxyName);
    const params = new URLSearchParams({
      url: testUrl,
      timeout: String(timeoutMs),
    });
    const res = await call<{ delay: number }>(settings, `/proxies/${encoded}/delay?${params}`);
    return res.delay;
  } catch (err) {
    if (err instanceof ClashError && err.status === 408) return null;
    if (err instanceof ClashError && err.status && err.status >= 400 && err.status < 500) {
      return null;
    }
    throw err;
  }
}

/** Force-reload the current Clash config (re-pulls subscription URL). */
export async function clashReload(settings: Settings): Promise<void> {
  await call(settings, '/configs?force=true', {
    method: 'PUT',
    body: JSON.stringify({ path: '' }),
  });
}
