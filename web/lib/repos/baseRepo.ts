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

export async function getBase(): Promise<BaseRecord | null> {
  const redis = getRedis();
  const [content, meta] = await Promise.all([
    redis.get<string>(REDIS_KEYS.base.content),
    redis.get<BaseMeta>(REDIS_KEYS.base.meta),
  ]);
  if (content === null || meta === null) return null;
  return { content, ...meta };
}

export async function getBaseEtag(): Promise<string | null> {
  const meta = await getRedis().get<BaseMeta>(REDIS_KEYS.base.meta);
  return meta?.etag ?? null;
}

export async function setBase(
  content: string,
  meta: BaseMeta,
  expectedEtag: string | null,
): Promise<SetBaseResult> {
  const redis = getRedis();

  if (expectedEtag !== null) {
    const current = await redis.get<BaseMeta>(REDIS_KEYS.base.meta);
    const currentEtag = current?.etag ?? null;
    if (currentEtag !== expectedEtag) {
      return { ok: false, currentEtag };
    }
  }

  await redis.multi().set(REDIS_KEYS.base.content, content).set(REDIS_KEYS.base.meta, meta).exec();

  return { ok: true };
}
