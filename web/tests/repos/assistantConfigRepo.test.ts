import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantConfig } from '@/schemas';

/** assistantConfigRepo is a single-blob get/set over a fixed KV key. */

const kv = new Map<string, unknown>();
const fakeRedis = {
  get: async (key: string) => kv.get(key) ?? null,
  set: async (key: string, value: unknown) => {
    kv.set(key, value);
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

let repo: typeof import('@/lib/repos/assistantConfigRepo');

beforeEach(async () => {
  kv.clear();
  repo = await import('@/lib/repos/assistantConfigRepo');
});
afterEach(() => vi.restoreAllMocks());

const CONFIG: AssistantConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  apiKey: 'sk-test',
  thinking: 'enabled',
  reasoningEffort: 'high',
  maxTokens: 8192,
};

describe('assistantConfigRepo', () => {
  it('returns null when unset', async () => {
    expect(await repo.getAssistantConfig()).toBeNull();
  });

  it('round-trips a valid config', async () => {
    await repo.setAssistantConfig(CONFIG);
    expect(await repo.getAssistantConfig()).toMatchObject({ apiKey: 'sk-test', model: 'deepseek-v4-pro' });
  });

  it('returns null for a corrupt stored blob', async () => {
    kv.set('assistant:config', { garbage: true });
    expect(await repo.getAssistantConfig()).toBeNull();
  });
});
