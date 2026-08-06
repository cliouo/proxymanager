import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import {
  attachRawOperators,
  buildOperatorSnapshot,
  deepEqualKeyOrderInsensitive,
  type WithRawOperators,
} from '@/lib/repos/rawOperators';
import {
  applyOperatorMutation,
  AMBIGUOUS_OPERATOR_ID_ERROR,
  NAMING_ROW_GATE_ERROR,
} from '@/lib/services/operatorMutationPolicy';
import type { Subscription } from '@/schemas';

/**
 * Round-1 hostile tests for the corrected operator mutation semantics:
 *   - JSON object-key order is NOT product state — a key-order-only
 *     candidate is semantically equal and allowed, and the stored naming row
 *     retains its CURRENT RAW value (unknown fields + original key order);
 *   - array order IS product state: inserting/deleting a non-name row before
 *     the managed row may shift its numeric index (allowed), while
 *     create/delete/logical-touch/move-across-a-surviving-operator of the
 *     naming row fails the one bounded gate error with zero writes;
 *   - unknown raw fields survive generic PATCH/PUT, sync/error refresh and
 *     legacy atomic recovery; an explicitly edited same-kind non-name row
 *     merges validated known fields while retaining unknown fields; a
 *     deliberate kind change replaces the row;
 *   - the naming authority (apply/rollback) alone may replace the naming row
 *     and must preserve every other raw row.
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
  hdel: async (key: string, ...ids: string[]) => {
    const m = bucket(key);
    let n = 0;
    for (const id of ids) if (m.delete(id)) n += 1;
    return n;
  },
  del: async (key: string) => {
    stores.delete(key);
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

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';

/** Stored RT row with an UNKNOWN future field and a specific key order. */
const RT_RAW = {
  template: '${emoji} ${region}${?route: · ${route}}',
  kind: 'rename-template',
  id: 'rt-1',
  futureField: { nested: ['keep-me', 1] },
  recognitionRules: [],
};
/** Semantically identical candidate: keys reordered, unknown field omitted. */
const RT_REORDERED = {
  id: 'rt-1',
  kind: 'rename-template',
  recognitionRules: [],
  template: '${emoji} ${region}${?route: · ${route}}',
};

function seedSubscription(operators: unknown[]): void {
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
    id: SUB_ID,
    name: 'my-sub',
    display_name: '我的订阅',
    enabled: true,
    kind: 'remote',
    url: 'https://example.test/sub',
    ttl_ms: 600000,
    tags: [],
    operators,
  });
}

function seedCollection(operators: unknown[]): void {
  bucket(REDIS_KEYS.collections).set(COL_ID, {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators,
  });
}

function storedOperators(key: string, id: string): unknown {
  return ((bucket(key).get(id) as { operators?: unknown }) ?? {}).operators;
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

describe('deepEqualKeyOrderInsensitive', () => {
  it('treats key-order-only object differences as equal and array order as significant', () => {
    expect(
      deepEqualKeyOrderInsensitive({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }),
    ).toBe(true);
    expect(deepEqualKeyOrderInsensitive([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }])).toBe(false);
    expect(deepEqualKeyOrderInsensitive({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqualKeyOrderInsensitive({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
});

describe('operator mutation policy — pure semantics', () => {
  it('key-order-only candidate passes the generic invariant and reuses the RAW naming row', () => {
    const snapshot = buildOperatorSnapshot({ operators: [RT_RAW] });
    const result = applyOperatorMutation(snapshot, [RT_REORDERED], 'generic');
    // storage reuses the current raw row — unknown fields and key order intact
    expect(result.storage).toEqual([RT_RAW]);
    expect(result.namingMutated).toBe(false);
  });

  it('a logical touch of the naming row (template/rule/alias/disabled/unknown field) fails the gate', () => {
    const snapshot = buildOperatorSnapshot({ operators: [RT_RAW] });
    const touched = [{ ...RT_REORDERED, template: '${emoji} ${region}' }];
    expect(() => applyOperatorMutation(snapshot, touched, 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    const unknownTouch = [{ ...RT_REORDERED, futureField: 'narrowed' }];
    expect(() => applyOperatorMutation(snapshot, unknownTouch, 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    const disabledTouch = [{ ...RT_REORDERED, disabled: true }];
    expect(() => applyOperatorMutation(snapshot, disabledTouch, 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
  });

  it('creating or deleting the naming row fails the gate', () => {
    const snapshot = buildOperatorSnapshot({ operators: [] });
    expect(() => applyOperatorMutation(snapshot, [RT_REORDERED], 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    const withRow = buildOperatorSnapshot({ operators: [RT_RAW] });
    expect(() => applyOperatorMutation(withRow, [], 'generic')).toThrow(NAMING_ROW_GATE_ERROR);
    // id-replacement (delete + create) also fails
    expect(() =>
      applyOperatorMutation(withRow, [{ ...RT_REORDERED, id: 'rt-2' }], 'generic'),
    ).toThrow(NAMING_ROW_GATE_ERROR);
  });

  it('round-2 anchor: the exact SET of surviving identities before the managed row must be equal — one-way and two-way crossing fail', () => {
    const current = [
      { id: 'a', kind: 'sort', by: 'name', order: 'asc' },
      RT_RAW,
      { id: 'c', kind: 'sort', by: 'name', order: 'asc' },
    ];
    const snapshot = buildOperatorSnapshot({ operators: current });
    const same = { id: 'a', kind: 'sort', by: 'name', order: 'asc' };
    const sameC = { id: 'c', kind: 'sort', by: 'name', order: 'asc' };
    // one-way crossing: rt crosses 'a' → fail
    expect(() => applyOperatorMutation(snapshot, [RT_REORDERED, same, sameC], 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    // rt crosses 'c' → fail
    expect(() => applyOperatorMutation(snapshot, [same, sameC, RT_REORDERED], 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    // SIMULTANEOUS two-way crossing: [a, rt, c] → [c, rt, a] swaps BOTH
    // survivors across the anchor — the managed row crossed every surviving
    // operator; survivor-before sets {a} vs {c} differ → fail (round-1
    // count-only rule wrongly accepted this)
    expect(() => applyOperatorMutation(snapshot, [sameC, RT_REORDERED, same], 'generic')).toThrow(
      NAMING_ROW_GATE_ERROR,
    );
  });

  it('round-2 anchor: same-side reorder, insertion/deletion shifts and survivor-set-preserving swaps pass', () => {
    const current = [
      { id: 'a', kind: 'sort', by: 'name', order: 'asc' },
      { id: 'b', kind: 'sort', by: 'name', order: 'asc' },
      RT_RAW,
      { id: 'c', kind: 'sort', by: 'name', order: 'asc' },
      { id: 'd', kind: 'sort', by: 'name', order: 'asc' },
    ];
    const snapshot = buildOperatorSnapshot({ operators: current });
    const row = (id: string) => ({ id, kind: 'sort', by: 'name', order: 'asc' });
    // same-side reorder (a,b) → (b,a) and (c,d) → (d,c): survivor sets
    // before rt are {a,b} in both → pass
    const reordered = applyOperatorMutation(
      snapshot,
      [row('b'), row('a'), RT_REORDERED, row('d'), row('c')],
      'generic',
    );
    expect(reordered.storage[2]).toEqual(RT_RAW);
    // inserting a NEW row before the anchor shifts its numeric index: the
    // survivor set before rt is still {a,b} (x is new, not a survivor) → pass
    const inserted = applyOperatorMutation(
      snapshot,
      [
        row('a'),
        row('b'),
        { id: 'x', kind: 'dedup', by: 'name', action: 'drop' },
        RT_REORDERED,
        row('c'),
        row('d'),
      ],
      'generic',
    );
    expect(inserted.storage[3]).toEqual(RT_RAW);
    // deleting the row before the anchor ('a' deleted → not a survivor):
    // survivor set before rt is {b} in both → pass
    const deleted = applyOperatorMutation(
      snapshot,
      [row('b'), RT_REORDERED, row('c'), row('d')],
      'generic',
    );
    expect(deleted.storage[1]).toEqual(RT_RAW);
  });

  it('round-2: retained ambiguous duplicate current IDs are rejected with one bounded error; omitting them deletes all such rows', () => {
    const dup = { id: 'dup', kind: 'sort', by: 'name', order: 'asc' };
    const current = [dup, { ...dup }, RT_RAW];
    const snapshot = buildOperatorSnapshot({ operators: current });
    // candidate RETAINS the duplicated id → bounded ambiguity error, zero writes
    expect(() => applyOperatorMutation(snapshot, [dup, RT_REORDERED], 'generic')).toThrow(
      AMBIGUOUS_OPERATOR_ID_ERROR,
    );
    // candidate omits the duplicated id → deliberate deletion of all such
    // non-managed rows passes
    const omitted = applyOperatorMutation(snapshot, [RT_REORDERED], 'generic');
    expect(omitted.storage).toEqual([RT_RAW]);
    expect(omitted.namingMutated).toBe(false);
  });

  it('generic storage: untouched rows keep raw bytes; same-kind edits merge unknown fields; kind changes replace', () => {
    const current = [
      { id: 'f1', kind: 'filter-useless', extra: ['old'], legacyKey: 'keep' },
      RT_RAW,
    ];
    const snapshot = buildOperatorSnapshot({ operators: current });
    // explicit same-kind edit: known fields win, unknown raw fields retained
    const edited = applyOperatorMutation(
      snapshot,
      [{ id: 'f1', kind: 'filter-useless', extra: ['new'] }, RT_REORDERED],
      'generic',
    );
    expect(edited.storage[0]).toEqual({
      id: 'f1',
      kind: 'filter-useless',
      extra: ['new'],
      legacyKey: 'keep',
    });
    // deliberate kind change: row replaced (old-kind fields dropped)
    const replaced = applyOperatorMutation(
      snapshot,
      [{ id: 'f1', kind: 'sort', by: 'name', order: 'asc' }, RT_REORDERED],
      'generic',
    );
    expect(replaced.storage[0]).toEqual({ id: 'f1', kind: 'sort', by: 'name', order: 'asc' });
    // untouched rows are the raw objects
    expect(replaced.storage[1]).toBe(current[1]);
  });

  it('naming authority may replace the naming row but must preserve every other raw row', () => {
    const current = [{ id: 'f1', kind: 'filter-useless', extra: ['x'], unknownField: 'u' }, RT_RAW];
    const snapshot = buildOperatorSnapshot({ operators: current });
    const candidate = [
      current[0],
      { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] },
    ];
    const result = applyOperatorMutation(snapshot, candidate, 'naming');
    expect(result.storage[0]).toBe(current[0]);
    expect(result.storage).toHaveLength(2);
    expect(result.namingMutated).toBe(true);
    // a naming candidate that also edits a non-name row is rejected
    expect(() =>
      applyOperatorMutation(
        snapshot,
        [{ id: 'f1', kind: 'filter-useless', extra: ['y'] }, candidate[1]],
        'naming',
      ),
    ).toThrow(/preserve every non-naming row/);
    // removing the naming row (rollback to absent) is a naming mutation
    const removed = applyOperatorMutation(snapshot, [current[0]], 'naming');
    expect(removed.namingMutated).toBe(true);
    // identical list reports no naming mutation
    const unchanged = applyOperatorMutation(snapshot, current, 'naming');
    expect(unchanged.namingMutated).toBe(false);
  });
});

describe('generic PATCH/PUT with a raw naming row (service boundary)', () => {
  it('key-order-only PATCH passes; the stored naming row retains the CURRENT raw value and unknown fields; no naming audit', async () => {
    seedSubscription([{ id: 'f1', kind: 'filter-useless', extra: [] }, RT_RAW]);
    counters.set(REDIS_KEYS.configVersion, 7);
    await subSvc.patchSubscription(SUB_ID, {
      operators: [{ id: 'f1', kind: 'filter-useless', extra: [] }, RT_REORDERED as never],
    });
    const stored = storedOperators(REDIS_KEYS.subscriptions, SUB_ID) as unknown[];
    expect(stored[1]).toEqual(RT_RAW); // raw bytes, unknown field + key order intact
    // arrays remain ordered
    expect((stored as Array<{ id: string }>).map((o) => o.id)).toEqual(['f1', 'rt-1']);
  });

  it('subscription PUT with a key-order-only RT passes and preserves the raw row; no naming audit is created', async () => {
    seedSubscription([{ id: 'f1', kind: 'filter-useless', extra: [] }, RT_RAW]);
    const versionBefore = counters.get(REDIS_KEYS.configVersion) ?? 0;
    await subSvc.replaceSubscription(SUB_ID, {
      name: 'my-sub',
      display_name: '新名字',
      enabled: true,
      kind: 'remote',
      url: 'https://example.test/sub',
      ttl_ms: 600000,
      tags: [],
      operators: [{ id: 'f1', kind: 'filter-useless', extra: [] }, RT_REORDERED as never],
    });
    const stored = storedOperators(REDIS_KEYS.subscriptions, SUB_ID) as unknown[];
    expect(stored[1]).toEqual(RT_RAW);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(versionBefore + 1); // one bump, no audit write
    expect(bucket(REDIS_KEYS.audit.byId)?.size ?? 0).toBe(0);
  });

  it('PUT touching/deleting/moving/creating the naming row fails the gate with entity + version unchanged', async () => {
    seedSubscription([{ id: 'f1', kind: 'filter-useless', extra: [] }, RT_RAW]);
    const versionBefore = counters.get(REDIS_KEYS.configVersion) ?? 0;
    const put = (operators: unknown[]) =>
      subSvc.replaceSubscription(SUB_ID, {
        name: 'my-sub',
        enabled: true,
        kind: 'remote',
        url: 'https://example.test/sub',
        ttl_ms: 600000,
        tags: [],
        operators: operators as never,
      });
    await expect(
      put([
        { id: 'f1', kind: 'filter-useless', extra: [] },
        { ...RT_REORDERED, template: '${region}' },
      ]),
    ).rejects.toThrow(NAMING_ROW_GATE_ERROR);
    await expect(put([{ id: 'f1', kind: 'filter-useless', extra: [] }])).rejects.toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    await expect(
      put([RT_REORDERED, { id: 'f1', kind: 'filter-useless', extra: [] }]),
    ).rejects.toThrow(NAMING_ROW_GATE_ERROR);
    await expect(
      put([
        { id: 'f1', kind: 'filter-useless', extra: [] },
        { ...RT_REORDERED, id: 'rt-2' },
      ]),
    ).rejects.toThrow(NAMING_ROW_GATE_ERROR);
    // zero writes: version + stored entity unchanged, no naming audit
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(versionBefore);
    expect(storedOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual([
      { id: 'f1', kind: 'filter-useless', extra: [] },
      RT_RAW,
    ]);
    expect(bucket(REDIS_KEYS.audit.byId)?.size ?? 0).toBe(0);
  });

  it('generic PATCH can edit a non-name row without narrowing the raw naming row or other raw rows', async () => {
    seedSubscription([
      { id: 'f1', kind: 'filter-useless', extra: ['old'], passthrough: 'keep-me' },
      RT_RAW,
      { id: 'f2', kind: 'flag-emoji', action: 'add' },
    ]);
    await subSvc.patchSubscription(SUB_ID, {
      operators: [
        { id: 'f1', kind: 'filter-useless', extra: ['new'] },
        RT_REORDERED as never,
        { id: 'f2', kind: 'flag-emoji', action: 'add' },
      ],
    });
    const stored = storedOperators(REDIS_KEYS.subscriptions, SUB_ID) as unknown[];
    // same-kind edit merged: known fields updated, unknown raw field retained
    expect(stored[0]).toEqual({
      id: 'f1',
      kind: 'filter-useless',
      extra: ['new'],
      passthrough: 'keep-me',
    });
    // naming row + other untouched rows keep raw bytes
    expect(stored[1]).toEqual(RT_RAW);
    expect(stored[2]).toEqual({ id: 'f2', kind: 'flag-emoji', action: 'add' });
  });

  it('collection PATCH shares the same policy semantics', async () => {
    seedCollection([RT_RAW]);
    await colSvc.patchCollection(COL_ID, {
      operators: [RT_REORDERED as never],
    });
    expect(storedOperators(REDIS_KEYS.collections, COL_ID)).toEqual([RT_RAW]);
    await expect(colSvc.patchCollection(COL_ID, { operators: [] })).rejects.toThrow(
      NAMING_ROW_GATE_ERROR,
    );
    expect(storedOperators(REDIS_KEYS.collections, COL_ID)).toEqual([RT_RAW]);
  });

  it('sync/error refresh writes still preserve the raw naming row', async () => {
    seedSubscription([RT_RAW]);
    await subSvc.recordSubscriptionSync(SUB_ID, 1234);
    await subSvc.recordSubscriptionError(SUB_ID, 'upstream unavailable');
    expect(storedOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual([RT_RAW]);
  });

  it('an explicit same-kind edit of the naming row through a generic write is impossible (gate)', async () => {
    // the candidate that "looks" like a full RT edit — even with all known
    // fields equal but an added field — is a logical touch and fails
    seedSubscription([RT_RAW]);
    await expect(
      subSvc.patchSubscription(SUB_ID, {
        operators: [{ ...RT_REORDERED, tw2cn: true } as never],
      }),
    ).rejects.toThrow(NAMING_ROW_GATE_ERROR);
    expect(storedOperators(REDIS_KEYS.subscriptions, SUB_ID)).toEqual([RT_RAW]);
  });
});

describe('legacy atomic recovery preserves raw operators', () => {
  it('commitAtomicProfileRecovery serializes repaired-source rows through the raw materializer', async () => {
    seedSubscription([{ id: 'f1', kind: 'filter-useless', extra: [] }, RT_RAW]);
    // read the record the way a recovery plan does — the raw envelope rides along
    const source = (await subRepo.getSubscription(SUB_ID)) as Subscription;
    expect(source).not.toBeNull();
    const quarantined: Subscription = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'spx-quarantine',
      enabled: true,
      kind: 'local',
      content: 'proxies: []\n',
      ttl_ms: 600000,
      tags: [],
      operators: [],
      updated_at: 1,
    };
    const { commitAtomicProfileRecovery } =
      await import('@/lib/services/profileRecoveryAtomicCommitService');
    const serialized: string[] = [];
    const captureEval = async (_script: string, _keys: string[], args: string[]) => {
      // collect every JSON-serialized entity body (subscriptions carry id)
      for (const arg of args) {
        try {
          const parsed = JSON.parse(arg) as { id?: unknown };
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
            serialized.push(arg);
          }
        } catch {
          // not a JSON body — skip
        }
      }
      counters.set(REDIS_KEYS.configVersion, 9);
      return [1, 9, 'audit-id'];
    };
    const originalEval = fakeRedis.eval;
    fakeRedis.eval = captureEval as unknown as typeof fakeRedis.eval;
    try {
      const result = await commitAtomicProfileRecovery(
        '44444444-4444-4444-8444-444444444444',
        'test',
        {
          baseContent: 'proxies: []\n',
          baseMeta: { etag: 'e', anchors: [], policies: [], updated_at: 0 } as never,
          groups: [],
          groupDeletes: [],
          rules: [],
          subscriptions: [source, quarantined],
          expectedVersion: 7,
          expectedBaseEtag: 'e',
        },
        {
          op: 'legacy-chain-profile-repair.apply',
          target: { kind: 'profile' },
          undoable: false,
        },
      );
      expect(result.newVersion).toBe(9);
      // the repaired source's raw operators (unknown field included) survive;
      // only the NEW quarantine gets its empty list
      const bodies = serialized.map((s) => JSON.parse(s) as { id: string; operators?: unknown });
      const repaired = bodies.find((b) => b.id === SUB_ID);
      const quarantineBody = bodies.find((b) => b.id === quarantined.id);
      expect(repaired?.operators).toEqual([
        { id: 'f1', kind: 'filter-useless', extra: [] },
        RT_RAW,
      ]);
      expect(quarantineBody?.operators).toEqual([]);
    } finally {
      fakeRedis.eval = originalEval;
    }
  });
});

describe('raw envelope survives service-level merges', () => {
  it('the RAW_OPERATORS symbol is preserved through spread merges', () => {
    const record = attachRawOperators({ operators: [RT_RAW] }, [RT_RAW]) as WithRawOperators<{
      operators: unknown[];
    }>;
    const merged = { ...record, display_name: 'x' };
    expect(buildOperatorSnapshot(merged).raw).toEqual([RT_RAW]);
  });
});

describe('round-3 aligned managed-row anchoring', () => {
  it('generic mutation anchors ONLY on the aligned valid M — a malformed rename-shaped row before it is a parked non-anchor', () => {
    const malformed = { id: 'bad', kind: 'rename-template', template: 123 };
    const M = {
      id: 'rt-1',
      kind: 'rename-template',
      template: '${region}',
      disabled: true,
      futureField: { keep: 1 },
      recognitionRules: [],
    };
    const current = [malformed, M, { id: 'c', kind: 'sort', by: 'name', order: 'asc' }];
    const snapshot = buildOperatorSnapshot({ operators: current });
    expect(snapshot.managed?.index).toBe(1);
    // same-side edit before the anchored M (inserting a new row) passes and
    // materializes M from raw bytes
    const inserted = applyOperatorMutation(
      snapshot,
      [
        malformed,
        { id: 'x', kind: 'dedup', by: 'name', action: 'drop' },
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${region}',
          disabled: true,
          recognitionRules: [],
        },
        { id: 'c', kind: 'sort', by: 'name', order: 'asc' },
      ],
      'generic',
    );
    expect(inserted.storage[2]).toBe(M);
    // a survivor crossing M (malformed swaps past M) rejects with zero writes
    expect(() =>
      applyOperatorMutation(
        snapshot,
        [M, malformed, { id: 'c', kind: 'sort', by: 'name', order: 'asc' }],
        'generic',
      ),
    ).toThrow(NAMING_ROW_GATE_ERROR);
    // touching the malformed row (editing its kind) is a non-managed edit → passes
    const edited = applyOperatorMutation(
      snapshot,
      [
        { id: 'bad', kind: 'sort', by: 'name', order: 'asc' },
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${region}',
          disabled: true,
          recognitionRules: [],
        },
        { id: 'c', kind: 'sort', by: 'name', order: 'asc' },
      ],
      'generic',
    );
    expect(edited.storage[0]).toEqual({ id: 'bad', kind: 'sort', by: 'name', order: 'asc' });
    expect(edited.storage[1]).toBe(M);
  });

  it('the naming authority replaces only the aligned M and rejects touching a parked rename-shaped row', () => {
    const malformed = { id: 'bad', kind: 'rename-template', template: 123 };
    const M = { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] };
    const snapshot = buildOperatorSnapshot({ operators: [malformed, M] });
    const result = applyOperatorMutation(
      snapshot,
      [
        malformed,
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
      'naming',
    );
    expect(result.storage[0]).toBe(malformed);
    expect(result.namingMutated).toBe(true);
    // a naming candidate that edits the parked malformed row is rejected
    expect(() =>
      applyOperatorMutation(
        snapshot,
        [{ id: 'bad', kind: 'rename-template', template: '${x}' }, M],
        'naming',
      ),
    ).toThrow(/preserve every non-naming row/);
  });
});

describe('round-9: operatorMutationPolicy under prototype pollution', () => {
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

  it('inherited compatibility_issue does not demote managed row: generic edit still rejected', () => {
    const rawOps = [
      { id: 'rt-1', kind: 'rename-template', template: 'x' },
      { id: 'f-1', kind: 'filter-useless', extra: [] },
    ];
    seedSubscription(rawOps);
    const sub = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators?: unknown[] };
    withProto(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      () => {
        const snapshot = buildOperatorSnapshot(sub);
        expect(snapshot.managed).toBeDefined();
        // Generic write that deletes the managed row must throw
        expect(() =>
          applyOperatorMutation(
            snapshot,
            [{ id: 'f-1', kind: 'filter-useless', extra: [] }],
            'generic',
          ),
        ).toThrow(NAMING_ROW_GATE_ERROR);
      },
    );
  });
});
