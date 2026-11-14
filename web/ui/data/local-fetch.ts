/**
 * Manual / local refresh for remote subscriptions whose upstream blocks the
 * server (or that are set to manual mode): the browser obtains the bytes —
 * pasted, read from a UTF-8 file, or fetched natively when the request can be
 * reproduced exactly — and uploads them to `POST /subscriptions/{id}/manual-refresh`
 * with the optimistic identity headers the server requires.
 */
import type { SubscriptionLocalFetchSpec } from '@/schemas';

export type LocalFetchErrorCode =
  | 'unsupported-url'
  | 'mixed-content'
  | 'user-agent-mismatch'
  | 'forbidden-header'
  | 'network'
  | 'http'
  | 'too-large'
  | 'encoding'
  | 'timeout';

export const LOCAL_FETCH_ERROR_COPY: Record<LocalFetchErrorCode, string> = {
  'unsupported-url': '订阅地址不是浏览器可直接访问的 http(s) 地址。',
  'mixed-content': '当前页面是 https，浏览器禁止请求 http 订阅地址（混合内容）。请改用粘贴或文件导入。',
  'user-agent-mismatch': '该订阅要求特定的 User-Agent，浏览器无法伪装。请复制内容后粘贴，或用文件导入。',
  'forbidden-header': '该订阅需要浏览器不允许设置的请求头。请改用粘贴或文件导入。',
  network: '浏览器无法访问订阅地址（可能被跨域策略拦截）。请改用粘贴或文件导入。',
  http: '订阅地址返回了错误状态码。',
  'too-large': '订阅内容超过 4 MiB 上限。',
  encoding: '订阅内容不是有效的 UTF-8 文本。',
  timeout: '请求订阅地址超时。',
};

/** Headers browsers refuse to let scripts set (Fetch standard "forbidden request-header"). */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'user-agent',
]);

function isBrowserSettableHeader(name: string, value: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower || FORBIDDEN_HEADERS.has(lower)) return false;
  if (lower.startsWith('proxy-') || lower.startsWith('sec-')) return false;
  if (['x-http-method', 'x-http-method-override', 'x-method-override'].includes(lower)) {
    const methods = value.split(',').map((m) => m.trim().toUpperCase());
    if (methods.some((m) => m === 'CONNECT' || m === 'TRACE' || m === 'TRACK')) return false;
  }
  return true;
}

/**
 * Can the browser reproduce the server's fetch exactly? Returns null when a
 * native fetch would send the same request, otherwise the blocking reason.
 */
export function checkNativeFetchCompatibility(
  spec: SubscriptionLocalFetchSpec,
  environment: { pageProtocol: string; navigatorUserAgent: string },
): LocalFetchErrorCode | null {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return 'unsupported-url';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    return 'unsupported-url';
  }
  if (environment.pageProtocol === 'https:' && url.protocol === 'http:') return 'mixed-content';
  if (spec.userAgent !== environment.navigatorUserAgent) return 'user-agent-mismatch';
  try {
    for (const [name, value] of Object.entries(spec.customHeaders)) {
      if (!isBrowserSettableHeader(name, value)) return 'forbidden-header';
      new Headers({ [name]: value });
    }
  } catch {
    return 'forbidden-header';
  }
  return null;
}

export const MAX_MANUAL_CONTENT = 4 * 1024 * 1024;

export class LocalFetchError extends Error {
  constructor(readonly code: LocalFetchErrorCode) {
    super(LOCAL_FETCH_ERROR_COPY[code]);
    this.name = 'LocalFetchError';
  }
}

/** Decode bytes strictly as UTF-8 within the size cap. */
export function decodeUtf8(bytes: ArrayBuffer): string {
  if (bytes.byteLength > MAX_MANUAL_CONTENT) throw new LocalFetchError('too-large');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new LocalFetchError('encoding');
  }
}

export async function nativeFetch(spec: SubscriptionLocalFetchSpec, timeoutMs = 20_000): Promise<string> {
  const blocked = checkNativeFetchCompatibility(spec, {
    pageProtocol: window.location.protocol,
    navigatorUserAgent: navigator.userAgent,
  });
  if (blocked) throw new LocalFetchError(blocked);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(spec.url, {
      headers: spec.customHeaders,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    throw new LocalFetchError((error as Error)?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalFetchError('http');
  }
  return decodeUtf8(await response.arrayBuffer());
}
