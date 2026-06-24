import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { BaseConfig } from '@/schemas';

export type BaseMeta = Omit<BaseConfig, 'content'>;

export interface BaseRecord extends BaseMeta {
  content: string;
}

export interface SetBaseResult {
  ok: boolean;
  currentEtag?: string | null;
}

export async function getBase(profileId: string): Promise<BaseRecord | null> {
  const redis = getRedis();
  const [content, meta] = await Promise.all([
    redis.get<string>(REDIS_KEYS.base.content(profileId)),
    redis.get<BaseMeta>(REDIS_KEYS.base.meta(profileId)),
  ]);
  if (content === null || meta === null) return null;
  return { content, ...meta };
}

export async function getBaseEtag(profileId: string): Promise<string | null> {
  const meta = await getRedis().get<BaseMeta>(REDIS_KEYS.base.meta(profileId));
  return meta?.etag ?? null;
}

export async function setBase(
  profileId: string,
  content: string,
  meta: BaseMeta,
  expectedEtag: string | null,
): Promise<SetBaseResult> {
  const redis = getRedis();

  if (expectedEtag !== null) {
    const current = await redis.get<BaseMeta>(REDIS_KEYS.base.meta(profileId));
    const currentEtag = current?.etag ?? null;
    if (currentEtag !== expectedEtag) {
      return { ok: false, currentEtag };
    }
  }

  // INCR rides the same multi() as the write — the render cache must never
  // see new content under the old version (漏 bump = 保存后仍读到旧渲染).
  await redis
    .multi()
    .set(REDIS_KEYS.base.content(profileId), content)
    .set(REDIS_KEYS.base.meta(profileId), meta)
    .incr(REDIS_KEYS.configVersion)
    .exec();

  return { ok: true };
}
