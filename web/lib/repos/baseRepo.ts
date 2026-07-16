import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { BaseConfig } from '@/schemas';

export type BaseMeta = Omit<BaseConfig, 'content'>;

export interface BaseRecord extends BaseMeta {
  content: string;
}

export interface SetBaseResult {
  ok: boolean;
  conflict?: 'etag' | 'config-version';
  currentEtag?: string | null;
  currentConfigVersion?: number | null;
}

export async function getBase(profileId: string): Promise<BaseRecord | null> {
  // P2-1: single MGET, not two independent GETs — two GETs can interleave with
  // a concurrent write and read a torn "old content + new etag" combination.
  const [content, meta] = await getRedis().mget<[string | null, BaseMeta | null]>(
    REDIS_KEYS.base.content(profileId),
    REDIS_KEYS.base.meta(profileId),
  );
  if (content === null || meta === null || content === undefined || meta === undefined) return null;
  return { content, ...meta };
}

/**
 * Atomic compare-and-set for the base skeleton (P2-1). The old code did a GET
 * to check the etag and a separate MULTI to write — two concurrent PUTs with
 * the same expected etag both passed the check, then both wrote (last-write
 * wins), which is exactly the lost update If-Match is supposed to prevent. This
 * Lua script reads the stored etag, compares it, and only then writes content +
 * meta + bumps config:version — all in one atomic server-side step.
 *
 * Returns `{1, ''}` on success or `{0, currentEtag}` when the etag didn't match.
 * Storage stays identical to the client's own .set: meta is written as the same
 * JSON string, and content as the raw string (get()'s parse-with-fallback reads
 * either form back identically).
 */
const CAS_SET_BASE = `
if ARGV[5] == '1' then
  local currentVersion = tonumber(redis.call('GET', KEYS[3]) or '0')
  local expectedVersion = tonumber(ARGV[6])
  if not currentVersion or currentVersion ~= expectedVersion then
    return {2, tostring(currentVersion or '')}
  end
end
if ARGV[1] == '1' then
  local cur = redis.call('GET', KEYS[1])
  local curEtag = ''
  if cur then
    local ok, m = pcall(cjson.decode, cur)
    if ok and type(m) == 'table' and m.etag ~= nil then curEtag = m.etag end
  end
  if curEtag ~= ARGV[2] then
    return {0, curEtag}
  end
end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[1], ARGV[4])
redis.call('HDEL', KEYS[4], ARGV[7])
redis.call('INCR', KEYS[3])
return {1, ''}
`.trim();

export async function getBaseEtag(profileId: string): Promise<string | null> {
  const meta = await getRedis().get<BaseMeta>(REDIS_KEYS.base.meta(profileId));
  return meta?.etag ?? null;
}

export async function setBase(
  profileId: string,
  content: string,
  meta: BaseMeta,
  expectedEtag: string | null,
  expectedConfigVersion?: number,
): Promise<SetBaseResult> {
  const redis = getRedis();

  // Atomic CAS + write + version bump. INCR rides the same script so the render
  // cache can never see new content under the old version (漏 bump = 保存后仍
  // 读到旧渲染).
  const result = (await redis.eval(
    CAS_SET_BASE,
    [
      REDIS_KEYS.base.meta(profileId),
      REDIS_KEYS.base.content(profileId),
      REDIS_KEYS.configVersion,
      REDIS_KEYS.resolvedSnapshot,
    ],
    [
      expectedEtag !== null ? '1' : '0',
      expectedEtag ?? '',
      content,
      JSON.stringify(meta),
      expectedConfigVersion === undefined ? '0' : '1',
      expectedConfigVersion === undefined ? '' : String(expectedConfigVersion),
      profileId,
    ],
  )) as [number, string];

  if (Array.isArray(result) && result[0] === 1) {
    return { ok: true };
  }
  if (Array.isArray(result) && result[0] === 2) {
    const parsed = Number(result[1]);
    return {
      ok: false,
      conflict: 'config-version',
      currentConfigVersion: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null,
    };
  }
  return {
    ok: false,
    conflict: 'etag',
    currentEtag: (Array.isArray(result) ? result[1] : '') || null,
  };
}
