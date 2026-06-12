import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * configVersionRepo — the global render-invalidation counter. GET with a
 * missing key must read as 0 (fresh deployment), INCR must be awaited.
 */

const counters = new Map<string, number>();
const fakeRedis = {
  get: async (key: string) => counters.get(key) ?? null,
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

let repo: typeof import('@/lib/repos/configVersionRepo');

beforeEach(async () => {
  counters.clear();
  repo = await import('@/lib/repos/configVersionRepo');
});
afterEach(() => vi.restoreAllMocks());

describe('configVersionRepo', () => {
  it('reads 0 when the key has never been written', async () => {
    expect(await repo.getConfigVersion()).toBe(0);
  });

  it('bump increments monotonically and get observes it', async () => {
    await repo.bumpConfigVersion();
    expect(await repo.getConfigVersion()).toBe(1);
    await repo.bumpConfigVersion();
    await repo.bumpConfigVersion();
    expect(await repo.getConfigVersion()).toBe(3);
  });
});
