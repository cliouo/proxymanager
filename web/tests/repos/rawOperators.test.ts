import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { StoredOperatorListSchema } from '@/schemas/operator';
import {
  OPERATOR_SNAPSHOT_INVALID_ERROR,
  buildOperatorSnapshot,
  classifyOperatorRow,
} from '@/lib/repos/rawOperators';

/**
 * Lossless raw stored-operator preservation (final repair pass group 1):
 * unknown/malformed future operator bytes must survive every write that is
 * NOT an explicit current operator save — recordSubscriptionSync,
 * recordSubscriptionError, ordinary non-operator subscription patches and
 * cosmetic collection patches — byte-for-byte and order-identical in Redis,
 * while clients still receive synthetic parked diagnostics.
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
    const current = counters.get(keys[0]) ?? 0;
    if (current !== Number(args[0])) return [0, String(current)];
    if (args.length >= 3) {
      await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    } else {
      bucket(keys[1]).delete(args[1]);
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

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';

/** Mixed raw row: one valid, one unknown future kind, one malformed blob. */
const RAW_OPERATORS = [
  { id: 'op-valid', kind: 'filter-useless', extra: ['测试'] },
  { id: 'op-future', kind: 'quantum-router', mode: 'warp', secretField: 'keep-me' },
  'not-an-operator-object',
];

function seedSubscription(): void {
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
    id: SUB_ID,
    name: 'my-sub',
    display_name: '我的订阅',
    enabled: true,
    kind: 'remote',
    url: 'https://example.test/sub',
    ttl_ms: 600000,
    tags: [],
    operators: RAW_OPERATORS,
  });
}

function seedCollection(): void {
  bucket(REDIS_KEYS.collections).set(COL_ID, {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators: RAW_OPERATORS,
  });
}

function storedRawOperators(key: string, id: string): unknown {
  const record = bucket(key).get(id) as { operators?: unknown };
  return record?.operators;
}

let subSvc: typeof import('@/lib/services/subscriptionService');
let colSvc: typeof import('@/lib/services/collectionService');
let subRepo: typeof import('@/lib/repos/subscriptionsRepo');

beforeEach(async () => {
  stores.clear();
  counters.clear();
  counters.set(REDIS_KEYS.configVersion, 7);
  subSvc = await import('@/lib/services/subscriptionService');
  colSvc = await import('@/lib/services/collectionService');
  subRepo = await import('@/lib/repos/subscriptionsRepo');
});

afterEach(() => vi.restoreAllMocks());

describe('raw stored operator preservation', () => {
  it('recordSubscriptionSync preserves raw operators byte-for-byte', async () => {
    seedSubscription();
    await subSvc.recordSubscriptionSync(SUB_ID, 1234);
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual(RAW_OPERATORS);
  });

  it('recordSubscriptionError preserves raw operators byte-for-byte', async () => {
    seedSubscription();
    await subSvc.recordSubscriptionError(SUB_ID, 'upstream unavailable');
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual(RAW_OPERATORS);
  });

  it('refresh-equivalent status write (sync with traffic) preserves raw operators', async () => {
    seedSubscription();
    await subSvc.recordSubscriptionSync(SUB_ID, 99, {
      upload: 1,
      download: 2,
      total: 3,
      expire: 4,
    });
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual(RAW_OPERATORS);
  });

  it('ordinary non-operator subscription patch preserves raw operators', async () => {
    seedSubscription();
    await subSvc.patchSubscription(SUB_ID, { display_name: '新名字' });
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual(RAW_OPERATORS);
    // and the stored record still carries the new field
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { display_name?: string };
    expect(stored.display_name).toBe('新名字');
  });

  it('cosmetic collection patch preserves raw operators', async () => {
    seedCollection();
    await colSvc.patchCollection(COL_ID, { notes: '随便写写' });
    expect(storedRawOperators(REDIS_KEYS.collections, COL_ID)).toEqual(RAW_OPERATORS);
  });

  it('clients receive only synthetic parked diagnostics, never raw rows', async () => {
    seedSubscription();
    const sub = await subRepo.getSubscription(SUB_ID);
    expect(sub).not.toBeNull();
    const ops = sub!.operators;
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ id: 'op-valid', kind: 'filter-useless' });
    expect(ops[1]).toMatchObject({
      id: 'parked-1',
      kind: '__incompatible__',
      compatibility_issue: 'unknown-operator-kind',
    });
    expect(ops[2]).toMatchObject({
      id: 'parked-2',
      kind: '__incompatible__',
      compatibility_issue: 'malformed-operator',
    });
    // API/JSON serialization never exposes the raw rows or the symbol
    const serialized = JSON.stringify(sub);
    expect(serialized).not.toContain('quantum-router');
    expect(serialized).not.toContain('keep-me');
    expect(serialized).not.toContain('raw-stored-operators');
  });

  it('an explicit current operator save rejects parked rows and wins with a clean list', async () => {
    seedSubscription();
    const sub = await subRepo.getSubscription(SUB_ID);
    // saving the parked-loaded list must be rejected by the current schema
    const { OperatorListSchema } = await import('@/schemas/operator');
    expect(OperatorListSchema.safeParse(sub!.operators as never).success).toBe(false);
    // an explicit clean save replaces the raw array
    await subSvc.patchSubscription(SUB_ID, {
      operators: [{ id: 'op-new', kind: 'filter-useless', extra: [] }],
    });
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual([
      { id: 'op-new', kind: 'filter-useless', extra: [] },
    ]);
  });

  it('decoded form round-trips the parked transformation deterministically', () => {
    const decoded = StoredOperatorListSchema.parse(RAW_OPERATORS);
    const again = StoredOperatorListSchema.parse(StoredOperatorListSchema.parse(RAW_OPERATORS));
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(again));
  });

  it('a legacy (pre-DSL) rename-template row stays byte-for-byte until an explicit save', async () => {
    // Disabled legacy row: decode must project an equivalent template AND keep
    // it disabled, while unrelated writes preserve the raw legacy bytes.
    const legacyRow = {
      id: 'rt-legacy',
      kind: 'rename-template',
      disabled: true,
      preset: 'balanced',
      components: {
        flag: true,
        region: true,
        route: true,
        vendor: false,
        protocol: false,
        rate: true,
        source: false,
        index: true,
      },
      regionLabel: 'zh',
      rateDisplay: 'omit-1x',
      separator: ' · ',
    };
    bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
      id: SUB_ID,
      name: 'my-sub',
      display_name: '我的订阅',
      enabled: true,
      kind: 'remote',
      url: 'https://example.test/sub',
      ttl_ms: 600000,
      tags: [],
      operators: [legacyRow],
    });

    // clients see the projected template, still disabled
    const sub = await subRepo.getSubscription(SUB_ID);
    const [op] = sub!.operators;
    expect(op).toMatchObject({
      id: 'rt-legacy',
      kind: 'rename-template',
      disabled: true,
    });
    expect((op as { template?: string }).template).toBe(
      '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
    );

    // unrelated writes preserve the raw legacy row byte-for-byte
    await subSvc.recordSubscriptionSync(SUB_ID, 1234);
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual([legacyRow]);
    await subSvc.patchSubscription(SUB_ID, { display_name: '新名字' });
    expect(storedRawOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual([legacyRow]);
  });
});

describe('round-3 snapshot managed-row classifier (aligned raw+decoded)', () => {
  const M = { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] };

  it('malformed/unknown/runtime-invalid rename-shaped rows never consume the managed slot; a later valid M does', () => {
    const raw = [
      { id: 'bad-shape', kind: 'rename-template', template: 123 }, // malformed (non-string template → parked)
      {
        id: 'bad-shape-2',
        kind: 'rename-template',
        template: '${region}',
        sourceAliases: { a: 'x'.repeat(100) }, // oversized alias → runtime-invalid
      },
      M,
    ];
    const snapshot = buildOperatorSnapshot({ operators: raw });
    expect(snapshot.rows.map((r) => r.classification)).toEqual([
      'parked',
      'runtime-invalid',
      'managed-rename',
    ]);
    expect(snapshot.managed?.index).toBe(2);
    expect(snapshot.managed?.id).toBe('rt-1');
  });

  it('a valid DISABLED M with unknown raw fields qualifies; later valid duplicates are parked', () => {
    const raw = [
      {
        id: 'rt-off',
        kind: 'rename-template',
        template: '${region}',
        disabled: true,
        futureField: { x: 1 },
      },
      { id: 'rt-dup', kind: 'rename-template', template: '${emoji}', recognitionRules: [] },
    ];
    const snapshot = buildOperatorSnapshot({ operators: raw });
    expect(snapshot.managed?.index).toBe(0);
    expect(snapshot.managed?.id).toBe('rt-off');
    expect(snapshot.rows[1].classification).toBe('duplicate-rename');
  });

  it('no aligned M → managed undefined; null/primitives/unknown objects stay parked', () => {
    const raw = [null, 'str', 42, true, { id: 'x', kind: 'quantum-router' }];
    const snapshot = buildOperatorSnapshot({ operators: raw });
    expect(snapshot.managed).toBeUndefined();
    expect(snapshot.rows.every((r) => r.classification === 'parked')).toBe(true);
    expect(snapshot.rows.map((r) => r.raw)).toEqual(raw);
  });

  it('invalid persisted raw fails the fixed compatibility error, never an empty pipeline', () => {
    expect(() => buildOperatorSnapshot({ operators: 'not-an-array' })).toThrowError(
      OPERATOR_SNAPSHOT_INVALID_ERROR,
    );
    expect(() => buildOperatorSnapshot({ operators: { a: 1 } })).toThrowError(
      OPERATOR_SNAPSHOT_INVALID_ERROR,
    );
    expect(() => buildOperatorSnapshot({ operators: null })).toThrowError(
      OPERATOR_SNAPSHOT_INVALID_ERROR,
    );
    // absent operators field IS an empty pipeline
    expect(buildOperatorSnapshot({}).managed).toBeUndefined();
  });
});

describe('round-9: classifyOperatorRow under Object.prototype.compatibility_issue pollution', () => {
  function withProto<T>(key: string, descriptor: PropertyDescriptor, fn: () => T): T {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
    Object.defineProperty(Object.prototype, key, { configurable: true, ...descriptor });
    try {
      return fn();
    } finally {
      if (prior === undefined) {
        delete (Object.prototype as Record<string, unknown>)[key];
      } else {
        Object.defineProperty(Object.prototype, key, prior);
      }
    }
  }

  it('inherited compatibility_issue DATA: managed row stays managed, duplicate stays duplicate', () => {
    withProto(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      () => {
        const r = classifyOperatorRow(
          { kind: 'rename-template', id: 'rt-1' },
          { id: 'rt-1', kind: 'rename-template', template: 'x' } as never,
          false,
        );
        expect(r.classification).toBe('managed-rename');
        expect(r.eligibleManaged).toBe(true);
      },
    );
  });

  it('inherited compatibility_issue GETTER: zero fires', () => {
    let fired = 0;
    withProto(
      'compatibility_issue',
      {
        get() {
          fired++;
          return 'polluted';
        },
        enumerable: false,
        configurable: true,
      },
      () => {
        classifyOperatorRow(
          { kind: 'rename-template', id: 'rt-1' },
          { id: 'rt-1', kind: 'rename-template', template: 'x' } as never,
          false,
        );
      },
    );
    expect(fired).toBe(0);
  });
});
