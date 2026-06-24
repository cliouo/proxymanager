import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyGroup } from '@/schemas';

/**
 * Tests for the chained-proxy scenario's read side (summariseChains).
 * The mutation ops just delegate to the proxy-group service, which is
 * covered in service.test.ts; here we verify the chain-shape detection
 * walks the hash correctly.
 */

const stores = new Map<string, Map<string, unknown>>();
/** Plain-key counters (config:version INCRs land here). */
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
    for (const id of ids) {
      if (m.delete(id)) n++;
    }
    return n;
  },
  del: async (key: string) => {
    stores.delete(key);
  },
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  // Chainable multi that actually applies ops on exec() — repos now bundle
  // the config:version INCR into the same multi() as their writes.
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
  get: async () => null,
  set: async (_key: string, _value: unknown) => undefined,
};

vi.mock('@/lib/redis/client', () => ({
  getRedis: () => fakeRedis,
}));

vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));

const PID = 'prof-test';

let scenarioMod: typeof import('@/lib/scenarios/chained-proxy/scenario');

beforeEach(async () => {
  stores.clear();
  counters.clear();
  scenarioMod = await import('@/lib/scenarios/chained-proxy/scenario');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(over: Partial<ProxyGroup>): ProxyGroup {
  const g: ProxyGroup = {
    id: crypto.randomUUID(),
    kind: 'raw',
    name: 'g',
    type: 'select',
    rank: 10,
    updated_at: 0,
    ...over,
  } as ProxyGroup;
  bucket(`proxy-groups:${PID}`).set(g.id, g);
  return g;
}

describe('frontPoolGroupNames', () => {
  it('flags a group that is the dialer-proxy target of another group', async () => {
    const { frontPoolGroupNames } = await import('@/schemas');
    const pools = frontPoolGroupNames([
      { name: 'pool:B', 'dialer-proxy': undefined },
      { name: 'chain:pool-to-B', 'dialer-proxy': 'pool:B' },
      { name: '香港', 'dialer-proxy': undefined },
    ]);
    expect([...pools]).toEqual(['pool:B']);
  });

  it('ignores dialer-proxy values that are not group names (raw proxy fronts)', async () => {
    const { frontPoolGroupNames } = await import('@/schemas');
    // Fixed chain front "F" is a raw proxy, not a managed group → not a pool.
    const pools = frontPoolGroupNames([{ name: 'chain:F-to-B', 'dialer-proxy': 'F' }]);
    expect(pools.size).toBe(0);
  });
});

describe('chained-proxy summariseChains', () => {
  it('reports a fixed chain when wrap.dialer-proxy points at a name with no pool body', async () => {
    seed({ name: 'chain:F-to-B', proxies: ['B'], 'dialer-proxy': 'F' });
    const summary = await scenarioMod.summariseChains(PID);
    expect(summary.fixedChains).toEqual([
      { chainName: 'chain:F-to-B', backend: 'B', front: 'F' },
    ]);
    expect(summary.poolChains).toEqual([]);
  });

  it('reports a pool chain when wrap.dialer-proxy points at another managed group', async () => {
    seed({ name: 'pool:B', proxies: ['F1', 'F2'] });
    seed({ name: 'chain:pool-to-B', proxies: ['B'], 'dialer-proxy': 'pool:B' });
    const summary = await scenarioMod.summariseChains(PID);
    expect(summary.poolChains).toEqual([
      {
        poolName: 'pool:B',
        poolMembers: ['F1', 'F2'],
        chainName: 'chain:pool-to-B',
        backend: 'B',
      },
    ]);
    expect(summary.fixedChains).toEqual([]);
  });

  it('reports a smart pool (include-all-proxies + filter) with its spec', async () => {
    seed({
      name: 'pool:B',
      type: 'fallback',
      'include-all-proxies': true,
      filter: '香港|HK',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
    });
    seed({ name: 'chain:pool-to-B', proxies: ['B'], 'dialer-proxy': 'pool:B' });
    const summary = await scenarioMod.summariseChains(PID);
    expect(summary.poolChains).toEqual([
      {
        poolName: 'pool:B',
        poolMembers: [],
        chainName: 'chain:pool-to-B',
        backend: 'B',
        smart: {
          strategy: 'fallback',
          filter: '香港|HK',
          testUrl: 'http://www.gstatic.com/generate_204',
          interval: 300,
        },
      },
    ]);
    expect(summary.fixedChains).toEqual([]);
  });

  it('does not count a group as a chain wrap when it has multiple proxies', async () => {
    seed({ name: 'multi', proxies: ['A', 'B'], 'dialer-proxy': 'X' });
    const summary = await scenarioMod.summariseChains(PID);
    expect(summary.fixedChains).toEqual([]);
    expect(summary.poolChains).toEqual([]);
  });

  it('does not count a group as a chain wrap when it lacks dialer-proxy', async () => {
    seed({ name: 'no-dp', proxies: ['B'] });
    const summary = await scenarioMod.summariseChains(PID);
    expect(summary.fixedChains).toEqual([]);
    expect(summary.poolChains).toEqual([]);
  });

  it('treats a wrap pointing at another wrap as a fixed chain (no nested pool detection)', async () => {
    // wrap1 points at wrap2 which itself has a dialer-proxy — we don't treat
    // wrap2 as a pool because it has its own dialer-proxy. wrap1 falls into
    // fixedChains.
    seed({ name: 'wrap1', proxies: ['B'], 'dialer-proxy': 'wrap2' });
    seed({ name: 'wrap2', proxies: ['B2'], 'dialer-proxy': 'F' });
    const summary = await scenarioMod.summariseChains(PID);
    expect(summary.fixedChains.map((c) => c.chainName).sort()).toEqual(['wrap1', 'wrap2']);
    expect(summary.poolChains).toEqual([]);
  });
});

describe('chained-proxy ops — integration with the proxy-group service', () => {
  it('set-fixed-chain creates the wrap group via the service', async () => {
    const { chainedProxyScenario } = scenarioMod;
    const ctx = {
      actor: 'test',
      profileId: PID,
      taxonomy: {
        all: async () => ({}),
        get: async () => null,
        set: async () => undefined,
        delete: async () => false,
      },
      // base/rules unused for these ops post-migration
      base: {} as never,
      rules: {} as never,
    };
    const result = await chainedProxyScenario.ops['set-fixed-chain'](ctx, {
      backend: 'B',
      front: 'F',
    });
    expect(result.data).toMatchObject({ chainName: 'chain:F-to-B', backend: 'B', front: 'F' });
    expect(result.events[0].action).toBe('set-fixed-chain');
    // The wrap landed in the hash.
    const groups = Array.from(bucket(`proxy-groups:${PID}`).values()) as ProxyGroup[];
    expect(groups.find((g) => g.name === 'chain:F-to-B')).toBeTruthy();
  });

  it('create-pool-chain batch-writes pool + wrap atomically', async () => {
    const { chainedProxyScenario } = scenarioMod;
    const ctx = {
      actor: 'test',
      profileId: PID,
      taxonomy: {
        all: async () => ({}),
        get: async () => null,
        set: async () => undefined,
        delete: async () => false,
      },
      base: {} as never,
      rules: {} as never,
    };
    await chainedProxyScenario.ops['create-pool-chain'](ctx, {
      backend: 'B',
      fronts: ['F1', 'F2'],
    });
    const groups = Array.from(bucket(`proxy-groups:${PID}`).values()) as ProxyGroup[];
    const names = groups.map((g) => g.name).sort();
    expect(names).toEqual(['chain:pool-to-B', 'pool:B']);
    const wrap = groups.find((g) => g.name === 'chain:pool-to-B');
    expect(wrap?.['dialer-proxy']).toBe('pool:B');
  });

  it('create-smart-pool-chain writes a filter pool + wrap, no pinned node names', async () => {
    const { chainedProxyScenario } = scenarioMod;
    const ctx = {
      actor: 'test',
      profileId: PID,
      taxonomy: {
        all: async () => ({}),
        get: async () => null,
        set: async () => undefined,
        delete: async () => false,
      },
      base: {} as never,
      rules: {} as never,
    };
    await chainedProxyScenario.ops['create-smart-pool-chain'](ctx, {
      backend: 'B',
      strategy: 'fallback',
      filter: '香港|HK',
    });
    const groups = Array.from(bucket(`proxy-groups:${PID}`).values()) as ProxyGroup[];
    const pool = groups.find((g) => g.name === 'pool:B');
    const wrap = groups.find((g) => g.name === 'chain:pool-to-B');
    expect(pool?.type).toBe('fallback');
    expect(pool?.['include-all-proxies']).toBe(true);
    expect(pool?.filter).toBe('香港|HK');
    expect(pool?.proxies).toBeUndefined(); // no pinned node names
    expect(pool?.url).toBe('http://www.gstatic.com/generate_204');
    expect(wrap?.['dialer-proxy']).toBe('pool:B');
  });

  it('update-smart-pool swaps strategy + clears the filter when emptied', async () => {
    const { chainedProxyScenario } = scenarioMod;
    const ctx = {
      actor: 'test',
      profileId: PID,
      taxonomy: {
        all: async () => ({}),
        get: async () => null,
        set: async () => undefined,
        delete: async () => false,
      },
      base: {} as never,
      rules: {} as never,
    };
    await chainedProxyScenario.ops['create-smart-pool-chain'](ctx, {
      backend: 'B',
      strategy: 'fallback',
      filter: '香港|HK',
    });
    await chainedProxyScenario.ops['update-smart-pool'](ctx, {
      poolName: 'pool:B',
      strategy: 'url-test',
      // filter omitted → cleared
    });
    const groups = Array.from(bucket(`proxy-groups:${PID}`).values()) as ProxyGroup[];
    const pool = groups.find((g) => g.name === 'pool:B');
    expect(pool?.type).toBe('url-test');
    expect(pool?.filter).toBeUndefined();
    expect(pool?.['include-all-proxies']).toBe(true);
  });

  it('create-pool-chain rejects backend appearing in fronts', async () => {
    const { chainedProxyScenario } = scenarioMod;
    const ctx = {
      actor: 'test',
      profileId: PID,
      taxonomy: {
        all: async () => ({}),
        get: async () => null,
        set: async () => undefined,
        delete: async () => false,
      },
      base: {} as never,
      rules: {} as never,
    };
    await expect(
      chainedProxyScenario.ops['create-pool-chain'](ctx, {
        backend: 'B',
        fronts: ['F1', 'B'],
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });
});
