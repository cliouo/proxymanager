import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Collection, Subscription } from '@/schemas';

/**
 * Tests for the assistant's node-processing operator actions
 * (lib/ai/actions/primitives/operatorWrites.ts). They mutate a subscription's
 * / collection's `operators` array through the same services the 订阅源 page
 * uses, fronted by the write-action preview/execute split. We stub Redis and
 * the network-touching node resolvers so the array mechanics + dry-run are
 * exercised in isolation.
 */

const stores = new Map<string, Map<string, unknown>>();
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
    for (const id of ids) if (m.delete(id)) n++;
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
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      hdel: (key: string, ...ids: string[]) => {
        ops.push(() => fakeRedis.hdel(key, ...ids));
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
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxiesRaw: vi.fn(async () => ({
    proxies: [{ name: '🇭🇰HK-1', type: 'ss' }, { name: '🇯🇵JP-1', type: 'ss' }],
  })),
}));
vi.mock('@/lib/services/nodeExportService', () => ({
  mergeCollectionMemberProxies: vi.fn(async () => ({
    merged: [{ name: '🇭🇰HK-1', type: 'ss' }, { name: '🇺🇸US-1', type: 'ss' }],
    memberErrors: [],
  })),
}));

let registry: typeof import('@/lib/ai/actions/registry');

const ctx = { actor: 'test' };

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';

function seedSub(operators: Subscription['operators'] = []): void {
  const sub: Subscription = {
    id: SUB_ID,
    name: 'my-sub',
    display_name: '我的订阅',
    enabled: true,
    kind: 'remote',
    url: 'https://example.com/sub',
    ttl_ms: 600000,
    tags: [],
    operators,
  };
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, sub);
}

function seedCollection(operators: Collection['operators'] = []): void {
  const col: Collection = {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators,
  };
  bucket(REDIS_KEYS.collections).set(COL_ID, col);
}

function getAction(name: string) {
  const a = registry.getAction(name);
  if (!a) throw new Error(`action ${name} not registered`);
  return a;
}

function storedSubOps(): Array<{ id: string; kind: string }> {
  const sub = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as Subscription;
  return sub.operators as Array<{ id: string; kind: string }>;
}

beforeEach(async () => {
  stores.clear();
  counters.clear();
  registry = await import('@/lib/ai/actions/registry');
});

afterEach(() => vi.restoreAllMocks());

describe('operator actions — registration', () => {
  it('registers the read + write operator tools', () => {
    for (const name of [
      'list_node_sources',
      'preview_node_operators',
      'add_operator',
      'update_operator',
      'delete_operator',
      'reorder_operators',
    ]) {
      expect(registry.getAction(name), name).toBeTruthy();
    }
  });
});

describe('list_node_sources', () => {
  it('lists subscriptions and collections with their operator pipelines', async () => {
    seedSub([{ id: 'op-1', kind: 'rename-regex', pattern: 'HK', replacement: '香港' }]);
    seedCollection([]);
    const action = getAction('list_node_sources');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {});
    const data = env.data as {
      subscriptions: Array<{ id: string; name: string; operatorCount: number }>;
      collections: Array<{ id: string; slug: string | null }>;
    };
    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0]).toMatchObject({ id: SUB_ID, name: '我的订阅', operatorCount: 1 });
    expect(data.collections[0]).toMatchObject({ id: COL_ID, slug: 'pool' });
  });
});

describe('preview_node_operators', () => {
  it('dry-runs a rename pipeline over a subscription without saving', async () => {
    seedSub([]);
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'subscription',
      id: SUB_ID,
      operators: [{ kind: 'rename-regex', pattern: 'HK', replacement: '香港' }],
    });
    const data = env.data as {
      before: { names: string[] };
      after: { names: string[] };
      steps: Array<{ changed: number }>;
    };
    expect(data.before.names).toContain('🇭🇰HK-1');
    expect(data.after.names).toContain('🇭🇰香港-1');
    expect(storedSubOps()).toHaveLength(0); // unchanged — preview never saves
  });

  it('flags orphaned references when a rename drops a name a chain pins', async () => {
    seedSub([]);
    // A chain wrap whose backend is the (pre-rename) node name.
    bucket(REDIS_KEYS.proxyGroups).set('w', {
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'raw',
      name: 'chain:F-to-hk',
      type: 'select',
      proxies: ['🇭🇰HK-1'],
      'dialer-proxy': 'F',
      rank: 10,
      updated_at: 0,
    });
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'subscription',
      id: SUB_ID,
      operators: [{ kind: 'rename-regex', pattern: 'HK', replacement: '香港' }],
    });
    const data = env.data as {
      orphanedReferences: Array<{ node: string; kind: string; via: string }>;
      orphanWarning?: string;
    };
    expect(data.orphanedReferences).toEqual([
      { node: '🇭🇰HK-1', kind: 'chain-backend', via: 'chain:F-to-hk' },
    ]);
    expect(data.orphanWarning).toBeTruthy();
  });

  it('dry-runs against a collection by merging member nodes', async () => {
    seedCollection([]);
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'collection',
      id: COL_ID,
      operators: [{ kind: 'filter-regex', mode: 'keep', pattern: 'US' }],
    });
    const data = env.data as { after: { names: string[]; count: number } };
    expect(data.after.names).toEqual(['🇺🇸US-1']);
  });
});

describe('add_operator', () => {
  it('previews a diff without mutating, then execute appends with a generated id', async () => {
    seedSub([]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    const input = {
      source_type: 'subscription' as const,
      id: SUB_ID,
      operator: { kind: 'flag-emoji' as const, action: 'add' as const },
    };
    const { diff } = await action.preview(ctx, input);
    expect((diff as { op: string }).op).toBe('update');
    expect(storedSubOps()).toHaveLength(0); // preview did not save

    await action.execute(ctx, input);
    const ops = storedSubOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('flag-emoji');
    expect(ops[0].id).toMatch(/[0-9a-f-]{36}/); // server-generated uuid
  });

  it('inserts at a given position', async () => {
    seedSub([{ id: 'a', kind: 'sort', by: 'name', order: 'asc' }]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      id: SUB_ID,
      operator: { kind: 'filter-useless', extra: [] },
      position: 0,
    });
    expect(storedSubOps().map((o) => o.kind)).toEqual(['filter-useless', 'sort']);
  });
});

describe('update_operator / delete_operator', () => {
  it('update replaces the op in place, preserving its id', async () => {
    seedSub([{ id: 'op-1', kind: 'rename-regex', pattern: 'HK', replacement: '香港' }]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      id: SUB_ID,
      operator_id: 'op-1',
      operator: { kind: 'filter-regex', mode: 'drop', pattern: '过期' },
    });
    const ops = storedSubOps();
    expect(ops).toEqual([{ id: 'op-1', kind: 'filter-regex', mode: 'drop', pattern: '过期' }]);
  });

  it('update rejects an unknown operator id', async () => {
    seedSub([]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        id: SUB_ID,
        operator_id: 'nope',
        operator: { kind: 'flag-emoji', action: 'add' },
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
  });

  it('delete removes the op by id', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const action = getAction('delete_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, { source_type: 'subscription', id: SUB_ID, operator_id: 'a' });
    expect(storedSubOps().map((o) => o.id)).toEqual(['b']);
  });
});

describe('reorder_operators', () => {
  it('reorders by a full permutation of ids', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
      { id: 'c', kind: 'filter-useless', extra: [] },
    ]);
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      id: SUB_ID,
      operator_ids: ['c', 'a', 'b'],
    });
    expect(storedSubOps().map((o) => o.id)).toEqual(['c', 'a', 'b']);
  });

  it('rejects a partial / non-permutation id list', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, { source_type: 'subscription', id: SUB_ID, operator_ids: ['a'] }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });
});
