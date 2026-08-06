import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Collection, Profile, Subscription } from '@/schemas';

/**
 * 共享来源保存闸口：订阅源 / 聚合订阅的任何「会改变渲染产物」的改动
 * （operators、url/content、display_name（rename-template 来源别名）、
 * enabled、tags、聚合成员……）都会改变每一份消费它的配置文件的渲染产物 ——
 * 保存前必须把每一个消费者对着同一份候选 + 同一个配置版本预检过，再 CAS 提交
 * （AGENTS.md「Shared subscription mutation invariant」+ ruleSetGate 先例）。
 * 这里 mock 掉完整渲染（configPreflight），盯住闸口的判定 / 候选构造 /
 * 版本一致性 / CAS 失败语义。
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
    for (const [id, v] of Object.entries(payload)) bucket(key).set(id, v);
  },
  get: async (key: string) => (counters.has(key) ? counters.get(key)! : null),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  eval: async (_script: string, keys: string[], args: string[]) => {
    // Lua ARGV is 1-indexed: [1] version, [2] id, [3] JSON body,
    // [4] action, [5] history field.
    const current = counters.get(keys[0]) ?? 0;
    const expected = Number(args[0]);
    if (current !== expected) return [0, String(current)];
    if (args[3] === 'set') {
      await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    } else {
      bucket(keys[1]).delete(args[1]);
      if (keys[2] && args[4]) bucket(keys[2]).delete(args[4]);
    }
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
        ops.push(async () => {
          let n = 0;
          for (const id of ids) if (bucket(key).delete(id)) n++;
          return n;
        });
        return tx;
      },
      del: (key: string) => {
        ops.push(async () => {
          stores.delete(key);
        });
        return tx;
      },
      incr: (key: string) => {
        ops.push(async () => fakeRedis.incr(key));
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
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  createOrdinalPlanningSession: vi.fn(async () => ({
    registerSourceDomain: vi.fn(),
    resolverFor: vi.fn(() => () => undefined),
    seal: () => ({
      expectedGeneration: counters.get(REDIS_KEYS.nodeOrdinalGeneration) ?? 0,
      expectedGlobalSize: 0,
      sources: [],
    }),
  })),
}));

interface PreflightResult {
  configVersion: number;
  candidate: { profileId: string; builder: unknown; options?: unknown };
}

const preflightMock = vi.fn(
  async (profileId: string, builder: unknown, options?: unknown): Promise<PreflightResult> => ({
    configVersion: 7,
    candidate: { profileId, builder, options },
  }),
);
let preflightFailure: { profileId: string; error: Error } | null = null;
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: (profileId: string, buildCandidate: unknown, options?: unknown) => {
    if (preflightFailure && preflightFailure.profileId === profileId) {
      return Promise.reject(preflightFailure.error);
    }
    return preflightMock(profileId, buildCandidate, options);
  },
}));

import {
  createCollection,
  deleteCollection,
  patchCollection,
} from '@/lib/services/collectionService';
import {
  createSubscription,
  deleteSubscription,
  patchSubscription,
  replaceSubscription,
} from '@/lib/services/subscriptionService';
import { preflightPipelineSave } from '@/lib/services/nodePipelineSaveGate';

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';
const PROF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function seedSub(over: Partial<Subscription> = {}): void {
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
    id: SUB_ID,
    name: 'my-sub',
    enabled: true,
    kind: 'remote',
    url: 'https://example.test/sub',
    ttl_ms: 600000,
    tags: [],
    operators: [],
    ...over,
  });
}

function seedCollection(over: Partial<Collection> = {}): void {
  bucket(REDIS_KEYS.collections).set(COL_ID, {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators: [],
    ...over,
  });
}

function seedProfile(id: string, name: string, source: Profile['source']): void {
  bucket(REDIS_KEYS.profiles).set(id, {
    id,
    name,
    source,
    updated_at: 1,
  });
}

// Generic gate fixtures use a NON-rename op: rename-template can only be
// mutated through the naming apply service (pass-7 blocker 3) — dedicated
// rejection tests below prove that gate.
const OP = { id: 'op-1', kind: 'filter-useless', extra: [] };
const RT_OP = {
  id: 'rt-1',
  kind: 'rename-template',
  template: '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?index: · ${index}}',
  recognitionRules: [],
};

beforeEach(() => {
  stores.clear();
  counters.clear();
  // The preflight mock validates against config version 7 — the fake store
  // must agree, or the CAS commit would (correctly) refuse.
  counters.set(REDIS_KEYS.configVersion, 7);
  preflightMock.mockClear();
  preflightFailure = null;
  preflightMock.mockResolvedValue({
    configVersion: 7,
    candidate: { profileId: 'x', builder: null },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('subscription operators save gate', () => {
  it('preflights every consuming profile (direct bind + collection member)', async () => {
    seedSub();
    seedCollection({ subscription_ids: [SUB_ID] });
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    seedProfile(PROF_B, 'via-collection', { type: 'collection', id: COL_ID });
    // non-consumer: bound to a different sub
    seedProfile('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'other', {
      type: 'subscription',
      id: '99999999-9999-4999-8999-999999999999',
    });

    await patchSubscription(SUB_ID, { operators: [OP as never] });

    expect(preflightMock).toHaveBeenCalledTimes(2);
    const profiles = preflightMock.mock.calls.map((c) => c[0]);
    expect(profiles).toEqual(expect.arrayContaining([PROF_A, PROF_B]));
    expect(profiles).not.toContain('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const preflightOptions = preflightMock.mock.calls.map(
      (call) => call[2] as { ordinalPlanningSession: unknown; subscriptionSnapshot: unknown },
    );
    expect(preflightOptions[0].ordinalPlanningSession).toBe(
      preflightOptions[1].ordinalPlanningSession,
    );
    expect(preflightOptions[0].subscriptionSnapshot).toBe(preflightOptions[1].subscriptionSnapshot);
    expect(preflightOptions[0].subscriptionSnapshot).toBeInstanceOf(Map);
    // candidate replaces the edited sub inside the bracketed snapshot
    const builder = preflightMock.mock.calls[0][1] as (state: {
      subscriptions: unknown[];
    }) => unknown;
    const candidate = builder({
      subscriptions: [
        {
          id: SUB_ID,
          name: 'my-sub',
          operators: [{ id: 'old', kind: 'filter-useless', extra: [] }],
        },
      ],
    }) as { subscriptions: Subscription[] };
    expect(candidate.subscriptions[0].operators).toHaveLength(1);
    expect(candidate.subscriptions[0].operators[0]).toMatchObject({ kind: 'filter-useless' });
    // committed under the preflighted version (7 → 8)
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('pass-7 blocker 3: generic saves REJECT rename-template operators at the schema boundary', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    await expect(patchSubscription(SUB_ID, { operators: [RT_OP as never] })).rejects.toMatchObject({
      problem: { status: 400 },
    });
    await expect(patchSubscription(SUB_ID, { operators: [RT_OP as never] })).rejects.toThrow(
      /名称统一/,
    );
    // nothing was written, nothing preflighted
    expect(preflightMock).not.toHaveBeenCalled();
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators?: unknown[] };
    expect(stored.operators).toHaveLength(0);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
  });

  it('pass-8 blocker 2: generic saves on a NAMED pipeline — non-name edits succeed, naming-row touch/delete/move/create all fail the dedicated gate with zero writes', async () => {
    seedSub({ operators: [OP as never, RT_OP as never] });
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));

    // non-name row edit: succeeds, naming row byte-identical and unmoved
    await patchSubscription(SUB_ID, {
      operators: [OP as never, RT_OP as never, { id: 'op-2', kind: 'filter-useless', extra: [] }],
    });
    const afterNonName = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as {
      operators: unknown[];
    };
    expect(afterNonName.operators[1]).toEqual(RT_OP);

    // naming-row TOUCH (bytes changed) → dedicated gate error, zero writes
    const touched = [
      { id: 'op-1', kind: 'filter-useless', extra: [] },
      { ...RT_OP, tw2cn: true },
    ];
    await expect(patchSubscription(SUB_ID, { operators: touched as never })).rejects.toThrow(
      /名称统一/,
    );
    // naming-row DELETE → gate error
    await expect(patchSubscription(SUB_ID, { operators: [OP as never] })).rejects.toThrow(
      /名称统一/,
    );
    // naming-row MOVE (position changed) → gate error
    await expect(
      patchSubscription(SUB_ID, { operators: [RT_OP as never, OP as never] }),
    ).rejects.toThrow(/名称统一/);
    // naming-row CREATE (not in current) → gate error
    await expect(
      patchSubscription(SUB_ID, { operators: [OP as never, RT_OP as never, RT_OP as never] }),
    ).rejects.toThrow(/名称统一/);

    // every rejected candidate left the entity byte-identical
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(
      JSON.stringify(afterNonName),
    );
    // (the successful edit committed once — version moved exactly once)
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    expect(before).not.toBe(JSON.stringify(afterNonName));
  });

  it('pass-7 blocker 3: generic collection saves reject rename-template too', async () => {
    seedCollection();
    await expect(patchCollection(COL_ID, { operators: [RT_OP as never] })).rejects.toMatchObject({
      problem: { status: 400 },
    });
    const stored = bucket(REDIS_KEYS.collections).get(COL_ID) as { operators?: unknown[] };
    expect(stored.operators).toHaveLength(0);
  });

  it('no consumers → no preflight, still CAS-commits', async () => {
    seedSub();
    await patchSubscription(SUB_ID, { operators: [OP as never] });
    expect(preflightMock).not.toHaveBeenCalled();
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('a broken consumer blocks the save and names the profile; nothing written', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    preflightFailure = {
      profileId: PROF_A,
      error: new Error('Full config render rejected: something exploded'),
    };
    await expect(patchSubscription(SUB_ID, { operators: [OP as never] })).rejects.toThrow(
      /配置文件「direct」/,
    );
    await expect(patchSubscription(SUB_ID, { operators: [OP as never] })).rejects.toThrow(
      /something exploded/,
    );
    // nothing was written (version not bumped)
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators?: unknown[] };
    expect(stored.operators).toHaveLength(0);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
  });

  it('mismatched preflight versions → 412, nothing written', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    seedProfile(PROF_B, 'also-direct', { type: 'subscription', id: SUB_ID });
    preflightMock.mockResolvedValueOnce({
      configVersion: 7,
      candidate: { profileId: PROF_A, builder: null },
    });
    preflightMock.mockResolvedValueOnce({
      configVersion: 8,
      candidate: { profileId: PROF_B, builder: null },
    });
    await expect(patchSubscription(SUB_ID, { operators: [OP as never] })).rejects.toMatchObject({
      problem: { status: 412 },
    });
  });

  it('display_name changes (rename-template source alias) preflight consumers', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    await patchSubscription(SUB_ID, { display_name: '新机场名' });
    expect(preflightMock).toHaveBeenCalledTimes(1);
    const builder = preflightMock.mock.calls[0][1] as (state: {
      subscriptions: Subscription[];
    }) => { subscriptions: Subscription[] };
    const candidate = builder({
      subscriptions: [
        {
          id: SUB_ID,
          name: 'my-sub',
          display_name: '旧机场名',
          operators: [],
          enabled: true,
          kind: 'remote',
          url: 'https://example.test/sub',
          ttl_ms: 600000,
          tags: [],
        },
      ],
    });
    expect(candidate.subscriptions[0].display_name).toBe('新机场名');
  });

  it('enabled / url / tags changes preflight consumers too', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    for (const patch of [
      { enabled: false },
      { url: 'https://new-upstream.example/sub' },
      { tags: ['cn'] },
    ]) {
      // each save commits under the preflight version (7 → 8); reset so the
      // next iteration preflights against 7 again
      counters.set(REDIS_KEYS.configVersion, 7);
      await patchSubscription(SUB_ID, patch as never);
    }
    expect(preflightMock).toHaveBeenCalledTimes(3);
  });

  it('cosmetic/unknown patches keep the plain upsert path', async () => {
    seedSub();
    await patchSubscription(SUB_ID, { notes: 'hello' } as never);
    expect(preflightMock).not.toHaveBeenCalled();
  });

  it('a tags patch that NEWLY matches a tag-based collection preflights that profile', async () => {
    seedSub(); // no tags yet
    // profile bound to a collection that auto-includes tag 'cn'
    seedCollection({ subscription_ids: [], subscription_tags: ['cn'] });
    seedProfile(PROF_A, 'via-tag-collection', { type: 'collection', id: COL_ID });

    await patchSubscription(SUB_ID, { tags: ['cn'] });

    // the newly-matching profile must be preflighted even though it consumed
    // nothing before the patch
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(PROF_A);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });
});

describe('collection operators save gate', () => {
  it('preflights profiles bound to the collection and commits under the same version', async () => {
    seedCollection();
    seedProfile(PROF_A, 'bound', { type: 'collection', id: COL_ID });
    await patchCollection(COL_ID, { operators: [OP as never] });
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(PROF_A);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('membership / enabled / type changes preflight consumers', async () => {
    seedCollection();
    seedProfile(PROF_A, 'bound', { type: 'collection', id: COL_ID });
    for (const patch of [
      { subscription_ids: [SUB_ID] },
      { subscription_tags: ['cn'] },
      { enabled: false },
      { type: 'select' },
    ]) {
      counters.set(REDIS_KEYS.configVersion, 7);
      await patchCollection(COL_ID, patch as never);
    }
    expect(preflightMock).toHaveBeenCalledTimes(4);
  });

  it('cosmetic collection patches (notes) stay ungated', async () => {
    seedCollection();
    seedProfile(PROF_A, 'bound', { type: 'collection', id: COL_ID });
    await patchCollection(COL_ID, { notes: '随便写写' });
    expect(preflightMock).not.toHaveBeenCalled();
  });
});

describe('create / replace / delete gates (Delivery finding 6)', () => {
  it('create with tags that newly match a tag-based collection preflights that profile', async () => {
    seedCollection({ subscription_ids: [], subscription_tags: ['cn'] });
    seedProfile(PROF_A, 'via-tag-collection', { type: 'collection', id: COL_ID });
    await createSubscription({
      name: 'new-sub',
      kind: 'remote',
      url: 'https://example.test/sub',
      enabled: true,
      tags: ['cn'],
    } as never);
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(PROF_A);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    // the candidate universe contains the new sub (its tags must resolve)
    const builder = preflightMock.mock.calls[0][1] as (state: {
      subscriptions: unknown[];
    }) => unknown;
    const candidate = builder({ subscriptions: [] }) as { subscriptions: Subscription[] };
    expect(candidate.subscriptions).toHaveLength(1);
    expect(candidate.subscriptions[0]).toMatchObject({ name: 'new-sub', tags: ['cn'] });
  });

  it('create without matching consumers still CAS-commits at the planning version', async () => {
    await createSubscription({
      name: 'plain-sub',
      kind: 'remote',
      url: 'https://example.test/sub',
    } as never);
    expect(preflightMock).not.toHaveBeenCalled();
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('replace preflights the union of current + candidate consumers', async () => {
    seedSub({ tags: [] });
    seedCollection({ subscription_ids: [SUB_ID], subscription_tags: ['cn'] });
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    seedProfile(PROF_B, 'via-tag', { type: 'collection', id: COL_ID });
    // current consumers: PROF_A; candidate (tags added) consumers: PROF_A + PROF_B
    await replaceSubscription(SUB_ID, {
      name: 'my-sub',
      kind: 'remote',
      url: 'https://example.test/sub',
      tags: ['cn'],
    } as never);
    const profiles = preflightMock.mock.calls.map((c) => c[0]);
    expect(profiles).toEqual(expect.arrayContaining([PROF_A, PROF_B]));
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('delete preflights consumers and commits via the CAS delete', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    const { removed } = await deleteSubscription(SUB_ID);
    expect(removed).toBe(true);
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(PROF_A);
    expect(bucket(REDIS_KEYS.subscriptions).has(SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('collection delete preflights bound profiles and commits via CAS delete', async () => {
    seedCollection();
    seedProfile(PROF_A, 'bound', { type: 'collection', id: COL_ID });
    const { removed } = await deleteCollection(COL_ID);
    expect(removed).toBe(true);
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(bucket(REDIS_KEYS.collections).has(COL_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('collection create commits under the planning version (no consumers possible)', async () => {
    await createCollection({ name: '新池', slug: 'new-pool' } as never);
    expect(preflightMock).not.toHaveBeenCalled();
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
  });

  it('a preflight observing a DIFFERENT generation than planning → 412, nothing written', async () => {
    seedSub();
    seedProfile(PROF_A, 'direct', { type: 'subscription', id: SUB_ID });
    // planning captured 7, but the preflight observes 8 (concurrent write)
    preflightMock.mockResolvedValueOnce({
      configVersion: 8,
      candidate: { profileId: PROF_A, builder: null },
    });
    await expect(patchSubscription(SUB_ID, { operators: [OP as never] })).rejects.toMatchObject({
      problem: { status: 412 },
    });
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators?: unknown[] };
    expect(stored.operators).toHaveLength(0);
  });

  it('empty-to-nonempty race: no-consumer discovery at a moved generation → 412', async () => {
    // planning captured 7; by discovery/preflight time the generation moved to
    // 8 — the empty discovery is only valid at the captured generation, so the
    // save must 412 instead of committing a consumer nobody preflighted.
    counters.set(REDIS_KEYS.configVersion, 8);
    await expect(preflightPipelineSave({ expectedVersion: 7, affected: [] })).rejects.toMatchObject(
      { problem: { status: 412 } },
    );
    // and at the matching generation it commits
    counters.set(REDIS_KEYS.configVersion, 7);
    await expect(preflightPipelineSave({ expectedVersion: 7, affected: [] })).resolves.toEqual({
      configVersion: 7,
      ordinalGeneration: 0,
      ordinalPlan: { expectedGeneration: 0, expectedGlobalSize: 0, sources: [] },
    });
  });
});
