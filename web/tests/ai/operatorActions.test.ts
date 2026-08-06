import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { buildOperatorScope, buildTargetRefScope } from '@/lib/proxies/handleScopes';

/** Test-local helpers over complete one-identity domains (round-3: the
 * scope builders are the SOLE semantic token constructors). */
const operatorHandle = (id: string): string => buildOperatorScope([id]).project(id);
import { installTestHandleSecret } from '@/tests/helpers/handleSecret';
// namingTargetRefOf removed in round-3 — refOf below projects from a scope
import type { Collection, Profile, Subscription } from '@/schemas';

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
  hlen: async (key: string) => stores.get(key)?.size ?? 0,
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
  get: async (key: string) => (counters.has(key) ? counters.get(key)! : null),
  mget: async (...keys: string[]) => keys.map((k) => bucket(k).get('base') ?? null),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  // Mirrors the two identical CAS scripts (commitSubscriptionChange /
  // commitCollectionChange): compare config:version, HSET the record, INCR.
  eval: async (script: string, keys: string[], args: string[]) => {
    // Lua ARGV is 1-indexed: [1]=expected version, [2]=record id, [3]=JSON body.
    const current = counters.get(keys[0]) ?? 0;
    const expected = Number(args[0]);
    if (current !== expected) return [0, String(current)];
    await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    const next = await fakeRedis.incr(keys[0]);
    return [1, String(next)];
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
    proxies: [
      {
        name: '🇭🇰HK-1',
        type: 'ss',
        server: 'hk.invalid',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'x',
      },
      {
        name: '🇯🇵JP-1',
        type: 'ss',
        server: 'jp.invalid',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'x',
      },
    ],
  })),
  resolveSubscriptionProxies: vi.fn(async () => ({
    proxies: [
      {
        name: '🇭🇰HK-1',
        type: 'ss',
        server: 'hk.invalid',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'x',
      },
      {
        name: '🇯🇵JP-1',
        type: 'ss',
        server: 'jp.invalid',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'x',
      },
    ],
  })),
}));
vi.mock('@/lib/services/nodeExportService', () => ({
  mergeCollectionMemberProxies: vi.fn(async () => ({
    merged: [
      { name: '🇭🇰HK-1', type: 'ss' },
      { name: '🇺🇸US-1', type: 'ss' },
    ],
    memberErrors: [],
  })),
}));

let registry: typeof import('@/lib/ai/actions/registry');

const PID = '33333333-3333-4333-8333-333333333333';
const ctx = { actor: 'test', profileId: PID };

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';

/** Seed the caller profile bound to the collection whose members include the
 * sub — the authoritative visible set is [collection, sub] (pass-7: every
 * generic source action resolves through this profile-scoped set). */
function seedProfile(): void {
  const profile: Profile = {
    id: PID,
    name: 'default',
    display_name: '默认配置',
    source: { type: 'collection', id: COL_ID },
    kind: 'normal',
    updated_at: 0,
  };
  bucket(REDIS_KEYS.profiles).set(PID, profile);
  // the pipeline-save preflight renders the profile's config — a valid base
  // skeleton must exist for writes to commit
  bucket(REDIS_KEYS.base.content(PID)).set('base', 'proxies: []\nproxy-groups: []\nrules: []\n');
  bucket(REDIS_KEYS.base.meta(PID)).set('base', {
    etag: 'e',
    anchors: [],
    policies: [],
    updated_at: 0,
  });
}

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
  // the profile binds the COLLECTION — it must exist for the visible set
  // to resolve (the sub is visible as its enabled member)
  bucket(REDIS_KEYS.collections).set(COL_ID, {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [SUB_ID],
    subscription_tags: [],
    operators: [],
  });
  seedProfile();
}

function seedCollection(operators: Collection['operators'] = []): void {
  const col: Collection = {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [SUB_ID],
    subscription_tags: [],
    operators,
  };
  bucket(REDIS_KEYS.collections).set(COL_ID, col);
  seedProfile();
}

const refOf = (type: 'subscription' | 'collection', id: string): string =>
  buildTargetRefScope(PID, [{ type, id }]).project(`${type}:${id}`);

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
  installTestHandleSecret();
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
      subscriptions: Array<{ ref: string; name: string; operatorCount: number }>;
      collections: Array<{ ref: string; name: string; enabled: boolean }>;
    };
    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0]).toMatchObject({
      ref: refOf('subscription', SUB_ID),
      name: '我的订阅',
      operatorCount: 1,
    });
    // pass-7: raw UUIDs and slugs never cross the model boundary
    expect(data.collections[0]).toMatchObject({ ref: refOf('collection', COL_ID) });
    expect(JSON.stringify(env)).not.toContain(SUB_ID);
    expect(JSON.stringify(env)).not.toContain('pool');
  });
});

describe('preview_node_operators', () => {
  it('dry-runs a rename pipeline over a subscription without saving', async () => {
    seedSub([]);
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
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
    bucket(REDIS_KEYS.proxyGroups(PID)).set('w', {
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
      ref: refOf('subscription', SUB_ID),
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
      ref: refOf('collection', COL_ID),
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
      ref: refOf('subscription', SUB_ID),
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
      ref: refOf('subscription', SUB_ID),
      operator: { kind: 'filter-useless', extra: [] },
      position: 0,
    });
    expect(storedSubOps().map((o) => o.kind)).toEqual(['filter-useless', 'sort']);
  });

  it('preserves refined regex validation while omitting the caller-facing id', async () => {
    seedSub([]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator: { kind: 'filter-regex', mode: 'keep', pattern: '^(a+)+$' },
      }),
    ).rejects.toThrow(/过量回溯/);
    expect(storedSubOps()).toHaveLength(0);
  });
});

describe('update_operator / delete_operator', () => {
  it('update replaces the op in place, preserving its id', async () => {
    seedSub([{ id: 'op-1', kind: 'rename-regex', pattern: 'HK', replacement: '香港' }]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator_handle: operatorHandle('op-1'),
      operator: { kind: 'filter-regex', mode: 'drop', pattern: '过期' },
    });
    const ops = storedSubOps();
    expect(ops).toEqual([{ id: 'op-1', kind: 'filter-regex', mode: 'drop', pattern: '过期' }]);
  });

  it('update rejects an unknown/stale operator handle', async () => {
    seedSub([]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handle: 'op-deadbeefdeadbeef',
        operator: { kind: 'flag-emoji', action: 'add' },
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it('delete removes the op by handle', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const action = getAction('delete_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator_handle: operatorHandle('a'),
    });
    expect(storedSubOps().map((o) => o.id)).toEqual(['b']);
  });
});

describe('reorder_operators', () => {
  it('reorders by a full permutation of handles', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
      { id: 'c', kind: 'filter-useless', extra: [] },
    ]);
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator_handles: ['c', 'a', 'b'].map(operatorHandle),
    });
    expect(storedSubOps().map((o) => o.id)).toEqual(['c', 'a', 'b']);
  });

  it('rejects a partial / non-permutation handle list', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handles: [operatorHandle('a')],
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it('rejects unknown handles in a reorder permutation', async () => {
    seedSub([{ id: 'a', kind: 'flag-emoji', action: 'add' }]);
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handles: ['op-deadbeefdeadbeef'],
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });
});

describe('shared operator-list contract in AI actions (Delivery finding 7)', () => {
  it('preview rejects a pipeline with two rename-template steps', async () => {
    seedSub([]);
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const rt = {
      kind: 'rename-template',
      template:
        '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
      recognitionRules: [],
    };
    await expect(
      action.run(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operators: [
          { ...rt, id: 'a' },
          { ...rt, id: 'b' },
        ],
      }),
    ).rejects.toThrow(/名称统一/);
  });

  it('add_operator rejects a second rename-template with an actionable error', async () => {
    seedSub([
      {
        id: 'rt-1',
        kind: 'rename-template',
        template:
          '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
        recognitionRules: [],
      } as never,
    ]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    const rt = {
      kind: 'rename-template',
      template:
        '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
      recognitionRules: [],
    };
    await expect(
      action.preview(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator: { ...rt, id: 'x' },
      }),
    ).rejects.toThrow(/名称统一/);
    // nothing was saved
    expect(storedSubOps()).toHaveLength(1);
  });

  it('preview names are REDACTED before re-entering the assistant loop', async () => {
    seedSub([]);
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    (
      fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      proxies: [
        { name: '🇭🇰 香港 https://evil.example/sub?token=abc123 ::1', type: 'ss' },
        { name: '🇯🇵 JP-1', type: 'ss' },
      ],
      proxyCount: 2,
    });
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operators: [],
    });
    const data = env.data as { before: { names: string[] }; source: string };
    const serialized = JSON.stringify(data);
    // credential-like content never re-enters the assistant loop
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
    expect(serialized).not.toContain('::1');
    // benign content stays readable
    expect(JSON.stringify(data)).toContain('JP-1');
    expect(data.source.length).toBeLessThanOrEqual(48);
  });
});

describe('AI-facing privacy injections (finding 5)', () => {
  it('preview cannot return injected host/IP/token via steps, collisions, samples, or references', async () => {
    seedSub([]);
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    (
      fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      proxies: [
        { name: '🇭🇰 香港 https://evil.example/sub?token=abc123 ::1', type: 'ss' },
        { name: '日本 2001:db8:: 01', type: 'ss' },
      ],
      proxyCount: 2,
    });
    // a chain-pinned raw name with credential-like content
    bucket(REDIS_KEYS.proxyGroups(PID)).set('w', {
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'raw',
      name: 'chain:edge.airport.moe',
      type: 'select',
      proxies: ['🇭🇰 香港 https://evil.example/sub?token=abc123 ::1'],
      'dialer-proxy': 'F',
      rank: 10,
      updated_at: 0,
    });
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operators: [
        {
          kind: 'rename-template',
          template:
            '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
          recognitionRules: [],
        },
      ],
    });
    const serialized = JSON.stringify(env);
    for (const needle of ['evil.example', 'token=abc123', '::1', '2001:db8', 'airport.moe']) {
      expect(serialized, needle).not.toContain(needle);
    }
    // benign structure still present
    expect(serialized).toContain('orphanedReferences');
    expect(serialized).toContain('samples');
  });

  it('member errors are sanitized (name AND error strings)', async () => {
    seedCollection([]);
    const exportSvc = await import('@/lib/services/nodeExportService');
    (
      exportSvc.mergeCollectionMemberProxies as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      merged: [{ name: '🇭🇰HK-1', type: 'ss' }],
      memberErrors: [
        {
          name: '机场 https://evil.example/sub',
          error: 'upstream edge.airport.moe:443 unreachable token=zzz',
        },
      ],
    });
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'collection',
      ref: refOf('collection', COL_ID),
      operators: [],
    });
    const serialized = JSON.stringify(env);
    for (const needle of ['evil.example', 'airport.moe', 'token=zzz']) {
      expect(serialized, needle).not.toContain(needle);
    }
    expect(serialized).toContain('memberErrors');
  });

  it('write previews expose only id/kind/disabled — no regex/alias content', async () => {
    seedSub([]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    const { diff } = await action.preview(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator: {
        kind: 'rename-regex',
        pattern: 'sk-TEST-TOKEN-123456',
        replacement: '香港',
      },
    });
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain('sk-TEST-TOKEN');
    expect(serialized).not.toContain('香港');
    expect(serialized).toContain('afterCount');
    expect(serialized).toContain('rename-regex');
  });
});

describe('opaque handles + no raw material in AI flows (final repair pass group 3)', () => {
  it('list_node_sources returns only opaque handles/kind/state — never raw operator fields', async () => {
    seedSub([
      {
        id: 'sk-TEST-TOKEN-123456',
        kind: 'rename-regex',
        pattern: 'https://evil.example/sub?token=abc123',
        replacement: '香港',
        flags: 'gi',
      },
      {
        id: 'rt-1',
        kind: 'rename-template',
        template:
          '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
        recognitionRules: [],
        sourceAliases: { 'airport-a': 'https://evil.example' },
      },
    ]);
    const action = getAction('list_node_sources');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {});
    const serialized = JSON.stringify(env);
    // the sanitized source LABEL may appear; raw operator fields never do
    for (const needle of [
      'evil.example',
      'token=abc123',
      'sk-TEST-TOKEN',
      'sourceAliases',
      'pattern',
      'replacement',
      'airport-a',
    ]) {
      expect(serialized, needle).not.toContain(needle);
    }
    expect(serialized).toContain('我的订阅');
    const subs = (
      env.data as { subscriptions: Array<{ operators: Array<{ handle: string; kind: string }> }> }
    ).subscriptions;
    expect(subs[0].operators[0]).toMatchObject({
      handle: operatorHandle('sk-TEST-TOKEN-123456'),
      kind: 'rename-regex',
    });
  });

  it('handle round-trip: list handles drive update/delete/reorder; unknown handles reject', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const update = getAction('update_operator');
    if (update.risk !== 'write') throw new Error('expected write');
    await update.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator_handle: operatorHandle('b'),
      operator: { kind: 'sort', by: 'region', order: 'desc' },
    });
    expect(storedSubOps()[1]).toMatchObject({ id: 'b', by: 'region', order: 'desc' });
    // stale handle (from a previous list) rejects safely
    await expect(
      update.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handle: operatorHandle('gone'),
        operator: { kind: 'flag-emoji', action: 'add' },
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it('assistant preview uses single-subscription provenance (display_name) like workbench preview', async () => {
    seedSub([]);
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    (
      fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      proxies: [
        { name: '香港 01', type: 'ss' },
        { name: '香港 02', type: 'ss' },
      ],
      proxyCount: 2,
    });
    const action = getAction('preview_node_operators');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operators: [
        {
          kind: 'rename-template',
          template:
            '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?source: · ${source}}${?index: · ${index}}',
          recognitionRules: [],
        },
      ],
    });
    const data = env.data as { after: { names: string[] } };
    // display_name 我的订阅, not the slug my-sub; per-source numbering 01/02
    expect(data.after.names).toEqual(['🇭🇰 香港 · 我的订阅 · 01', '🇭🇰 香港 · 我的订阅 · 02']);
    expect(JSON.stringify(env)).not.toContain('my-sub');
    expect(JSON.stringify(env)).not.toContain('proxy-source-alias');
  });
});

describe('hostile handles never echo (final repair group 2)', () => {
  it('add returns the opaque handle, never the generated uuid', async () => {
    seedSub([]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    const env = await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator: { kind: 'flag-emoji', action: 'add' },
    });
    const serialized = JSON.stringify(env);
    const op = storedSubOps()[0];
    expect(serialized).not.toContain(op.id);
    expect(serialized).toContain(operatorHandle(op.id));
    expect(serialized).toMatch(/op-[0-9a-f]{16}/);
  });

  it('a syntactically hostile handle is rejected at the schema boundary without echo', async () => {
    seedSub([]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    for (const hostile of [
      'op-https://evil.example',
      'op-9f86d081884c7d65',
      'sk-TEST-TOKEN-123456',
    ]) {
      await expect(
        action.execute(ctx, {
          source_type: 'subscription',
          ref: refOf('subscription', SUB_ID),
          operator_handle: hostile,
          operator: { kind: 'flag-emoji', action: 'add' },
        }),
      ).rejects.toMatchObject({ problem: { status: 400 } });
    }
  });

  it('a well-formed but STALE handle rejects with fixed text — no value echo', async () => {
    seedSub([]);
    const action = getAction('delete_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    const stale = operatorHandle('https://evil.example');
    // operatorHandle digests arbitrary input into op-<hex>: valid FORMAT, stale content
    expect(stale).toMatch(/^op-[0-9a-f]{16}$/);
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handle: stale,
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
    const thrown = await action
      .execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handle: stale,
      })
      .catch((e: unknown) => e);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain('evil.example');
    expect(message).not.toContain(stale);
    expect(message).toContain('不存在或已失效');
  });

  it('write preview projections expose only handles — raw stored ids never appear', async () => {
    seedSub([{ id: 'sk-TEST-TOKEN-123456', kind: 'rename-regex', pattern: 'a', replacement: 'b' }]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    const { diff } = await action.preview(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator_handle: operatorHandle('sk-TEST-TOKEN-123456'),
      operator: { kind: 'flag-emoji', action: 'add' },
    });
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain('sk-TEST-TOKEN');
    expect(serialized).toContain(operatorHandle('sk-TEST-TOKEN-123456'));
  });
});

describe('pass-7 blocker 3: rename-template is NOT a generic operator', () => {
  const RT = {
    id: 'rt-1',
    kind: 'rename-template' as const,
    template: '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}',
    recognitionRules: [],
  };

  it('update_operator rejects touching a rename-template step (bounded)', async () => {
    seedSub([RT as never]);
    const action = getAction('update_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handle: operatorHandle('rt-1'),
        operator: { kind: 'flag-emoji', action: 'add' },
      }),
    ).rejects.toThrow(/名称统一/);
    expect(storedSubOps()).toHaveLength(1);
  });

  it('delete_operator rejects deleting a rename-template step (bounded)', async () => {
    seedSub([RT as never, { id: 'a', kind: 'flag-emoji', action: 'add' }]);
    const action = getAction('delete_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handle: operatorHandle('rt-1'),
      }),
    ).rejects.toThrow(/名称统一/);
    expect(storedSubOps()).toHaveLength(2);
  });

  it('reorder_operators rejects reordering a rename-bearing pipeline (bounded)', async () => {
    seedSub([RT as never, { id: 'a', kind: 'flag-emoji', action: 'add' }]);
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator_handles: [operatorHandle('a'), operatorHandle('rt-1')],
      }),
    ).rejects.toThrow(/名称统一/);
    expect(storedSubOps().map((o) => o.id)).toEqual(['rt-1', 'a']);
  });

  it('generic add on a rename-bearing pipeline: after-RT renaming stages fail; before-RT insert is a harmless index shift', async () => {
    seedSub([RT as never]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    // an RT-only pipeline: appending a RENAME-capable stage AFTER the naming
    // row violates the shared final-rename contract — fails before any write
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operator: { kind: 'flag-emoji', action: 'add' },
      }),
    ).rejects.toThrow(/名称统一/);
    expect(storedSubOps()).toHaveLength(1);
    // round-1 semantics: inserting a NON-name row BEFORE the managed row is
    // a numeric index shift (0 → 1), not a logical move — allowed, and the
    // naming row survives verbatim (flag-emoji before the final rename stage
    // satisfies the final-rename contract)
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator: { kind: 'flag-emoji', action: 'add' },
      position: 0,
    });
    const ops = storedSubOps();
    expect(ops.map((o) => o.id)).toEqual([expect.anything(), 'rt-1']);
    expect(ops[1]).toEqual(RT);
  });

  it('pass-8 blocker 2: non-name add between existing rows succeeds with the naming row byte-identical and unmoved', async () => {
    // [flag, RT] — appending a NON-name op AFTER the naming row keeps the
    // RT at its index and satisfies the final-rename contract (sort is not
    // a renaming stage)
    seedSub([{ id: 'a', kind: 'flag-emoji', action: 'add' }, RT as never]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator: { kind: 'sort', by: 'name', order: 'asc' },
      position: 2,
    });
    const ops = storedSubOps();
    expect(ops.map((o) => o.id)).toEqual(['a', 'rt-1', expect.anything()]);
    // the naming row survived byte-identical at the SAME index
    expect(ops[1]).toEqual(RT);
  });

  it('pass-8 blocker 2 round-1: inserting BEFORE the naming row passes — a numeric index shift, not a logical move', async () => {
    seedSub([{ id: 'a', kind: 'flag-emoji', action: 'add' }, RT as never]);
    const action = getAction('add_operator');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: refOf('subscription', SUB_ID),
      operator: { kind: 'sort', by: 'name', order: 'asc' },
      position: 0,
    });
    const ops = storedSubOps();
    // the naming row's numeric index shifted 1 → 2, but it never crossed a
    // surviving operator — the insert is allowed and the row is preserved
    // VERBATIM from its raw bytes
    expect(ops.map((o) => o.id)).toEqual([expect.anything(), 'a', 'rt-1']);
    expect(ops[2]).toEqual(RT);
  });

  it('round-2: COLLECTION reorder crossing the managed row fails even when its index is unmoved; same-side reorder passes', async () => {
    seedSub([]);
    seedCollection([
      { id: 'a', kind: 'sort', by: 'name', order: 'asc' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
      RT as never,
      { id: 'c', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    // the write preflight renders the profile-bound collection — it needs
    // at least one enabled member
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      ...(bucket(REDIS_KEYS.collections).get(COL_ID) as Collection),
      subscription_ids: [SUB_ID],
    });
    const action = getAction('reorder_operators');
    if (action.risk !== 'write') throw new Error('expected write');
    const colOps = () =>
      (bucket(REDIS_KEYS.collections).get(COL_ID) as Collection).operators as Array<{
        id: string;
      }>;
    // SIMULTANEOUS two-way crossing: [a, b, rt, c] → [c, b, rt, a] keeps rt
    // at index 2 but the managed row crossed BOTH surviving operators — the
    // exact survivor-before sets {a,b} vs {c,b} differ → the dedicated gate
    // error fires with zero writes (round-2 exact-side oracle)
    await expect(
      action.execute(ctx, {
        source_type: 'collection',
        ref: refOf('collection', COL_ID),
        operator_handles: [
          operatorHandle('c'),
          operatorHandle('b'),
          operatorHandle('rt-1'),
          operatorHandle('a'),
        ].map((h) => h),
      }),
    ).rejects.toThrow(/名称统一/);
    expect(colOps().map((o) => o.id)).toEqual(['a', 'b', 'rt-1', 'c']);
    // same-side reorder of the rows BEFORE the anchor: [a, b, rt, c] →
    // [b, a, rt, c] — survivor-before sets {a,b} equal → passes; a one-way
    // crossing of the anchor ([a, b, rt, c] → [rt, c, a, b]) fails
    await action.execute(ctx, {
      source_type: 'collection',
      ref: refOf('collection', COL_ID),
      operator_handles: [
        operatorHandle('b'),
        operatorHandle('a'),
        operatorHandle('rt-1'),
        operatorHandle('c'),
      ].map((h) => h),
    });
    expect(colOps().map((o) => o.id)).toEqual(['b', 'a', 'rt-1', 'c']);
    expect(colOps()[2]).toEqual(RT);
    await expect(
      action.execute(ctx, {
        source_type: 'collection',
        ref: refOf('collection', COL_ID),
        operator_handles: [
          operatorHandle('rt-1'),
          operatorHandle('c'),
          operatorHandle('a'),
          operatorHandle('b'),
        ].map((h) => h),
      }),
    ).rejects.toThrow(/名称统一/);
    expect(colOps().map((o) => o.id)).toEqual(['b', 'a', 'rt-1', 'c']);
  });
});

describe('pass-7 blocker 3: profile-scoped list_node_sources', () => {
  it('a no-source profile lists NOTHING and every source action fails the bounded error', async () => {
    seedSub([]);
    // rebind the caller profile to 'none' — nothing is visible
    bucket(REDIS_KEYS.profiles).set(PID, {
      id: PID,
      name: 'default',
      display_name: '默认配置',
      source: { type: 'none' },
      kind: 'normal',
      updated_at: 1,
    });
    const list = getAction('list_node_sources');
    if (list.risk !== 'read') throw new Error('expected read');
    const env = await list.run(ctx, {});
    const data = env.data as { subscriptions: unknown[]; collections: unknown[] };
    expect(data.subscriptions).toEqual([]);
    expect(data.collections).toEqual([]);
    const preview = getAction('preview_node_operators');
    if (preview.risk !== 'read') throw new Error('expected read');
    await expect(
      preview.run(ctx, {
        source_type: 'subscription',
        ref: refOf('subscription', SUB_ID),
        operators: [],
      }),
    ).rejects.toThrow(/来源范围/);
  });
});

describe('pass-8 blocker 3: forced operator-handle MAC collisions fail closed', () => {
  it('update_operator with a handle matching TWO operators fails the bounded collision error — never first-match', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      // bind the profile DIRECTLY to the sub so the visible set is ONE
      // target — the ref authorizes, and the OPERATOR-domain collision is
      // what must fail closed
      bucket(REDIS_KEYS.profiles).set(PID, {
        id: PID,
        name: 'default',
        display_name: '默认配置',
        source: { type: 'subscription', id: SUB_ID },
        kind: 'normal',
        updated_at: 2,
      });
      // the ref is minted under the SAME colliding signer so the target
      // authorizes — the OPERATOR-domain collision is what must fail closed
      const collidedRef = refOf('subscription', SUB_ID);
      const action = getAction('update_operator');
      if (action.risk !== 'write') throw new Error('expected write');
      const thrown = await action
        .execute(ctx, {
          source_type: 'subscription',
          ref: collidedRef,
          operator_handle: 'op-deadbeefdeadbeef',
          operator: { kind: 'flag-emoji', action: 'add' },
        })
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain('句柄冲突');
      expect(message).not.toContain('deadbeef');
      // nothing written
      expect(storedSubOps()).toHaveLength(2);
    } finally {
      injectHandleSignerForTests(null);
    }
  });

  it('delete_operator on a colliding-signer pipeline fails closed with zero writes', async () => {
    seedSub([
      { id: 'a', kind: 'flag-emoji', action: 'add' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      bucket(REDIS_KEYS.profiles).set(PID, {
        id: PID,
        name: 'default',
        display_name: '默认配置',
        source: { type: 'subscription', id: SUB_ID },
        kind: 'normal',
        updated_at: 2,
      });
      const collidedRef = refOf('subscription', SUB_ID);
      const action = getAction('delete_operator');
      if (action.risk !== 'write') throw new Error('expected write');
      await expect(
        action.execute(ctx, {
          source_type: 'subscription',
          ref: collidedRef,
          operator_handle: 'op-deadbeefdeadbeef',
        }),
      ).rejects.toThrow(/句柄冲突/);
      expect(storedSubOps()).toHaveLength(2);
    } finally {
      injectHandleSignerForTests(null);
    }
  });
});
