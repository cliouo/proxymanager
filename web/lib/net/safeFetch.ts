/**
 * SSRF-hardened HTTP GET for AI-driven fetches (the assistant's `fetch_url` /
 * rule-set localisation). Unlike the subscription fetcher — which trusts
 * admin-entered URLs — the URL here can be influenced by the model, so we:
 *
 *   - allow only http/https,
 *   - resolve the host and refuse private / loopback / link-local / CGNAT /
 *     multicast / cloud-metadata addresses,
 *   - re-validate the host on every redirect hop (manual redirects),
 *   - cap body size and wall-clock time.
 *
 * `reader` routes through https://r.jina.ai/<url>, a public reader proxy that
 * returns readable text for HTML pages. Because the proxy runs the actual
 * fetch on its own infrastructure, it cannot reach the caller's private
 * network — so it's a safe fallback, not an SSRF bypass.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProblemDetailsError } from '@/lib/http/problem';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const UA = 'proxymanager/0.1 (+rule-set fetch)';
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

export interface SafeFetchResult {
  text: string;
  contentType: string | null;
  finalUrl: string;
  bytes: number;
  truncated: boolean;
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Route through r.jina.ai to get readable text for HTML pages. */
  reader?: boolean;
}

function ipv4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

function ipv6Blocked(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); // IPv4-mapped
  if (mapped) return ipv4Blocked(mapped[1]);
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
  if (ip.startsWith('ff')) return true; // multicast
  return false;
}

function ipBlocked(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true; // unparseable → refuse
}

/** Throws if `hostname` is, or resolves to, a non-public address. */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (BLOCKED_HOST.test(host)) {
    throw ProblemDetailsError.badRequest(`禁止访问内网/本机地址：${hostname}`);
  }
  if (isIP(host)) {
    if (ipBlocked(host)) throw ProblemDetailsError.badRequest(`禁止访问内网/保留地址：${hostname}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw ProblemDetailsError.badRequest(`无法解析主机：${hostname}`);
  }
  for (const a of addrs) {
    if (ipBlocked(a.address)) {
      throw ProblemDetailsError.badRequest(`主机解析到内网/保留地址，已拒绝：${hostname}`);
    }
  }
}

/** Read a response body, stopping at `maxBytes` (so an unbounded stream can't OOM us). */
async function readCapped(res: Response, maxBytes: number): Promise<{ buf: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.byteLength > maxBytes
      ? { buf: all.subarray(0, maxBytes), truncated: true }
      : { buf: all, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let written = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - written;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      written += room;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    written += value.byteLength;
  }
  const buf = new Uint8Array(written);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { buf, truncated };
}

export async function safeFetchText(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate the user-facing URL up front (even in reader mode).
  let initial: URL;
  try {
    initial = new URL(rawUrl);
  } catch {
    throw ProblemDetailsError.badRequest(`无效 URL：${rawUrl}`);
  }
  if (initial.protocol !== 'http:' && initial.protocol !== 'https:') {
    throw ProblemDetailsError.badRequest(`只支持 http/https：${initial.protocol}`);
  }

  let url = opts.reader ? new URL(`https://r.jina.ai/${rawUrl}`) : initial;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw ProblemDetailsError.badRequest(`只支持 http/https：${url.protocol}`);
      }
      await assertPublicHost(url.hostname);

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'User-Agent': UA, Accept: '*/*' },
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw ProblemDetailsError.badRequest(`抓取超时（${timeoutMs}ms）`);
        }
        throw ProblemDetailsError.badRequest(
          `抓取失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw ProblemDetailsError.badRequest('重定向缺少 Location 头。');
        url = new URL(loc, url); // re-validated at the top of the next hop
        continue;
      }
      if (!res.ok) throw ProblemDetailsError.badRequest(`上游返回 HTTP ${res.status}`);

      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw ProblemDetailsError.badRequest(`内容过大：${declared} 字节 > 上限 ${maxBytes}`);
      }
      const { buf, truncated } = await readCapped(res, maxBytes);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return {
        text,
        contentType: res.headers.get('content-type'),
        finalUrl: url.toString(),
        bytes: buf.byteLength,
        truncated,
      };
    }
    throw ProblemDetailsError.badRequest(`重定向过多（>${MAX_REDIRECTS}）。`);
  } finally {
    clearTimeout(timer);
  }
}
