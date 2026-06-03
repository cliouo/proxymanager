import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { AssistantConfigSchema, type AssistantConfig } from '@/schemas';

/**
 * Single-blob store for the assistant's DeepSeek config. One user, so no
 * concurrency/etag dance — just get/set the JSON under a fixed key. Mirrors
 * the scalar half of `baseRepo`.
 */

export async function getAssistantConfig(): Promise<AssistantConfig | null> {
  const raw = await getRedis().get<unknown>(REDIS_KEYS.assistantConfig);
  if (raw === null || raw === undefined) return null;
  const parsed = AssistantConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function setAssistantConfig(config: AssistantConfig): Promise<void> {
  await getRedis().set(REDIS_KEYS.assistantConfig, config);
}
