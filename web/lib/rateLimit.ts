/**
 * Minimal per-IP failed-auth rate limiter (P1-2).
 *
 * The panel has no brute-force protection: an attacker can hammer the admin
 * Bearer or a `/api/sub/{token}` guess endlessly, and CORS `*` + an allowed
 * `Authorization` header even lets any web page drive a distributed guess
 * through visitors' browsers. We don't touch the hot path — only a FAILED auth
 * increments a fixed-window counter keyed by IP; once it crosses the threshold
 * the caller returns 429 instead of another 401, so a valid credential is never
 * slowed down and only guessers get throttled.
 *
 * Deliberately built on the existing `@upstash/redis` client (INCR + EXPIRE)
 * rather than pulling in `@upstash/ratelimit` — one key, one counter, no new
 * dependency. Fail-open on any Redis error: a limiter outage must never lock
 * out legitimate traffic.
 */

import { getRedis } from '@/lib/redis/client';

/** Sliding-ish fixed window. */
const WINDOW_SECONDS = 300;
/** Failed attempts per IP per window before the caller should return 429. */
const MAX_FAILURES = 30;

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Record one auth failure for `${scope}:${ip}` and report whether the caller is
 * now over the limit. First increment in a window sets the EX. Never throws.
 */
export async function registerAuthFailure(scope: string, ip: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = `ratelimit:authfail:${scope}:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count > MAX_FAILURES;
  } catch {
    // Fail-open: a limiter hiccup must not block real users.
    return false;
  }
}
