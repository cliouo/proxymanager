import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Rule, Subscription } from '@/schemas';

/**
 * Repo writes that affect the rendered config must bump config:version in
 * the same multi() as the write — the render cache keys validity on it.
 * Representative sample: rulesRepo (hash CRUD incl. batch/clear), baseRepo
 * (plain SETs), subscriptionsRepo (the sub-injection source of truth).
 */

const stores = new Map<string, Map<string, unknown>>();
const kv = new Map<string, unknown>();
const counters = new Map<string, number>();

function bucket(key: string): Map<string, unknown> {
  let m = stores.get(key);
  if (!m) {
    m = new Map();
    stores.set(key, m);
  }
  return m;
}

const fakeRedis = {
  get: async (key: string) => counters.get(key) ?? kv.get(key) ?? null,
  set: async (key: string, value: unknown) => {
    kv.set(key, value);
  },
  hgetall: async (key: string) => {
    const m = bucket(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hget: async (key: string, id: string) => bucket(key).get(id) ?? null,
  hset: async (key: string, payload: Record<string, unknown>) => {
    const m = bucket(key);
    for (const [id, v] of Object.entries(payload)) m.set(id, v);
  },
  hdel: async (key: string, ...ids: string[]) => {
    const m = bucket(key);
    let n = 0;
    for (const id of ids) if (m.delete(id)) n++;
    return n;
  },
  del: async (key: string) => {
    stores.delete(key);
    kv.delete(key);
  },
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      set: (key: string, value: unknown) => {
        ops.push(() => fakeRedis.set(key, value));
        return tx;
      },
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      hdel: (key: string, ...ids: string[]) => {
        ops.push(() => fakeRedis.hdel(key, ...ids));
        return tx;
      },
      del: (key: string) => {
        ops.push(() => fakeRedis.del(key));
        return tx;
      },
      incr: (key: string) => {
        ops.push(() => fakeRedis.incr(key));
        return tx;
      },
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    };
    return tx;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

let rulesRepo: typeof import('@/lib/repos/rulesRepo');
let baseRepo: typeof import('@/lib/repos/baseRepo');
let subsRepo: typeof import('@/lib/repos/subscriptionsRepo');

beforeEach(async () => {
  stores.clear();
  kv.clear();
  counters.clear();
  rulesRepo = await import('@/lib/repos/rulesRepo');
  baseRepo = await import('@/lib/repos/baseRepo');
  subsRepo = await import('@/lib/repos/subscriptionsRepo');
});
afterEach(() => vi.restoreAllMocks());

function version(): number {
  return counters.get(REDIS_KEYS.configVersion) ?? 0;
}

function makeRule(id: string): Rule {
  return {
    id,
    anchor: 'manual',
    type: 'DOMAIN-SUFFIX',
    value: 'example.com',
    policy: '香港',
    rank: 100,
    source: 'manual',
    added_at: 1716000000,
    updated_at: 1716000000,
  };
}

const SUB: Subscription = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'airport-a',
  enabled: true,
  kind: 'remote',
  url: 'https://example.com/sub',
  ttl_ms: 600_000,
  tags: [],
  operators: [],
};

describe('rulesRepo bumps config:version', () => {
  it('upsertRule / upsertRules / deleteRule / deleteRules / clearRules / batch', async () => {
    await rulesRepo.upsertRule(makeRule('a'));
    expect(version()).toBe(1);

    await rulesRepo.upsertRules([makeRule('b'), makeRule('c')]);
    expect(version()).toBe(2);

    expect(await rulesRepo.deleteRule('a')).toBe(true);
    expect(version()).toBe(3);

    expect(await rulesRepo.deleteRules(['b', 'c'])).toBe(2);
    expect(version()).toBe(4);

    await rulesRepo.batchUpsertAndDelete([makeRule('d')], []);
    expect(version()).toBe(5);

    await rulesRepo.clearRules();
    expect(version()).toBe(6);
  });

  it('no-op early returns do not bump', async () => {
    await rulesRepo.upsertRules([]);
    await rulesRepo.deleteRules([]);
    await rulesRepo.batchUpsertAndDelete([], []);
    expect(version()).toBe(0);
  });
});

describe('baseRepo bumps config:version', () => {
  it('setBase bumps on success, not on etag conflict', async () => {
    const meta = { anchors: [], policies: [], etag: 'v1', updated_at: 1 };
    expect((await baseRepo.setBase('proxies: []', meta, null)).ok).toBe(true);
    expect(version()).toBe(1);

    // Optimistic-concurrency failure must not invalidate anything.
    const conflict = await baseRepo.setBase('proxies: []', { ...meta, etag: 'v2' }, 'wrong-etag');
    expect(conflict.ok).toBe(false);
    expect(version()).toBe(1);
  });
});

describe('subscriptionsRepo bumps config:version', () => {
  it('upsertSubscription and deleteSubscription bump', async () => {
    await subsRepo.upsertSubscription(SUB);
    expect(version()).toBe(1);
    expect(await subsRepo.deleteSubscription(SUB.id)).toBe(true);
    expect(version()).toBe(2);
  });
});
