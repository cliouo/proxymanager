import { beforeEach, describe, expect, it } from 'vitest';
import { compileLua51, luaRuntimeError, runLua51 } from '../helpers/lua51';
import { CAS_ENTITY_WITH_HISTORY } from '@/lib/repos/namingCasRepo';
import {
  CAS_SUBSCRIPTION_CHANGE,
  CAS_SUBSCRIPTION_DELETE,
  CAS_SUBSCRIPTION_RUNTIME_PATCH,
} from '@/lib/repos/subscriptionsRepo';
import { CAS_COLLECTION_CHANGE, CAS_COLLECTION_DELETE } from '@/lib/repos/collectionsRepo';
import {
  ASSIGN_ORDINALS_LUA,
  CLEAR_ORDINALS_LUA,
  ORDINAL_SNAPSHOT_LUA,
} from '@/lib/repos/nodeOrdinalRepo';
import {
  CAS_PIPELINE_ENTITY_WITH_ORDINALS,
  encodeOrdinalReservationPlan,
} from '@/lib/repos/ordinalReservationCas';
import type { OrdinalReservationPlan } from '@/lib/services/nodeOrdinalService';

const values = new Map<string, string>();
const hashes = new Map<string, Map<string, string>>();
const zsets = new Map<string, Map<string, number>>();
const types = new Map<string, string>();

function hash(key: string): Map<string, string> {
  let value = hashes.get(key);
  if (!value) {
    value = new Map();
    hashes.set(key, value);
  }
  return value;
}

function typeOf(key: string): string {
  return (
    types.get(key) ??
    (values.has(key) ? 'string' : hashes.has(key) ? 'hash' : zsets.has(key) ? 'zset' : 'none')
  );
}

const redis = {
  call(command: string, ...args: unknown[]): unknown {
    const key = String(args[0] ?? '');
    switch (command) {
      case 'TYPE':
        return { ok: typeOf(key) };
      case 'GET':
        if (!['string', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE string');
        return values.get(key) ?? null;
      case 'SET':
        if (!['string', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE string');
        values.set(key, String(args[1]));
        return 'OK';
      case 'HGET':
        if (!['hash', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE hash');
        return hashes.get(key)?.get(String(args[1])) ?? null;
      case 'HEXISTS':
        if (!['hash', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE hash');
        return hashes.get(key)?.has(String(args[1])) ? 1 : 0;
      case 'HGETALL':
        if (!['hash', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE hash');
        return [...(hashes.get(key) ?? new Map())].flatMap(([field, value]) => [field, value]);
      case 'HLEN':
        if (!['hash', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE hash');
        return hashes.get(key)?.size ?? 0;
      case 'HSET':
        if (!['hash', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE hash');
        hash(key).set(String(args[1]), String(args[2]));
        return 1;
      case 'HDEL':
        if (!['hash', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE hash');
        return hashes.get(key)?.delete(String(args[1])) ? 1 : 0;
      case 'DEL':
        hashes.delete(key);
        values.delete(key);
        zsets.delete(key);
        return 1;
      case 'ZADD': {
        if (!['zset', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE zset');
        let entries = zsets.get(key);
        if (!entries) {
          entries = new Map();
          zsets.set(key, entries);
        }
        entries.set(String(args[2]), Number(args[1]));
        return 1;
      }
      case 'ZCARD':
        if (!['zset', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE zset');
        return zsets.get(key)?.size ?? 0;
      case 'ZSCORE':
        if (!['zset', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE zset');
        return zsets.get(key)?.get(String(args[1])) ?? null;
      case 'ZRANGE': {
        if (!['zset', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE zset');
        const ordered = [...(zsets.get(key) ?? new Map())].sort(
          ([memberA, scoreA], [memberB, scoreB]) =>
            scoreA - scoreB || memberA.localeCompare(memberB),
        );
        const start = Number(args[1]);
        const end = Number(args[2]);
        return ordered.slice(start, end + 1).map(([member]) => member);
      }
      case 'ZREMRANGEBYRANK': {
        if (!['zset', 'none'].includes(typeOf(key))) throw luaRuntimeError('WRONGTYPE zset');
        const entries = zsets.get(key);
        if (!entries) return 0;
        const ordered = [...entries].sort(
          ([memberA, scoreA], [memberB, scoreB]) =>
            scoreA - scoreB || memberA.localeCompare(memberB),
        );
        const doomed = ordered.slice(Number(args[1]), Number(args[2]) + 1);
        doomed.forEach(([member]) => entries.delete(member));
        return doomed.length;
      }
      default:
        throw luaRuntimeError(`unsupported redis command ${command}`);
    }
  },
};

const KEYS = ['version', 'entities', 'history', 'ordinals', 'ordinal-generation'];
const PROFILE_ID = '99999999-9999-4999-8999-999999999999';
const RECORD_ID = '11111111-1111-4111-8111-111111111111';
const AUDIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const LUA_GLOBALS = {
  cjson: {
    decode: (raw: unknown): unknown => {
      if (typeof raw !== 'string') throw new Error('cjson.decode expects a string');
      return JSON.parse(raw);
    },
  },
  pcall: ((fn: (raw: unknown) => unknown, raw: unknown): unknown => {
    try {
      return [true, fn(raw)];
    } catch {
      return [false, 'decode error'];
    }
  }) as unknown as (raw: unknown) => unknown,
};

function plan(overrides: Partial<OrdinalReservationPlan> = {}): OrdinalReservationPlan {
  return {
    expectedGeneration: 0,
    expectedGlobalSize: 0,
    sources: [
      {
        sourceKey: 'airport-a',
        expectedCounterRaw: null,
        expectedSourceSize: 0,
        nextCounter: 2,
        fields: [
          { fingerprint: 'fp-a', ordinal: 1 },
          { fingerprint: 'fp-b', ordinal: 2 },
        ],
      },
    ],
    ...overrides,
  };
}

function runGeneric(
  ordinalPlan: OrdinalReservationPlan,
  action: 'set' | 'delete' = 'set',
  mutateArgs?: (args: string[]) => void,
): unknown[] {
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const keys = [...KEYS, ...encoded.counterKeys];
  const args = [
    '7',
    'entity-1',
    action === 'set' ? '{"id":"entity-1"}' : '',
    action,
    action === 'delete' ? 'subscription:entity-1' : '',
    ...encoded.args,
  ];
  mutateArgs?.(args);
  return runLua51(
    CAS_PIPELINE_ENTITY_WITH_ORDINALS,
    { KEYS: keys, ARGV: args },
    redis,
  ) as unknown[];
}

function auditPayload(): string {
  return JSON.stringify({
    id: AUDIT_ID,
    ts: 1000,
    op: 'naming.apply',
    actor: 'user',
    target: {
      kind: 'naming-source',
      type: 'subscription',
      id: RECORD_ID,
      name: '机场A',
    },
    before: null,
    after: { templateSummary: { placeholderCount: 2, length: 18 }, mode: 'added' },
    undoable: false,
    profileId: PROFILE_ID,
  });
}

function runNaming(
  ordinalPlan: OrdinalReservationPlan,
  mutate?: (keys: string[], args: string[]) => void,
): unknown[] {
  const encoded = encodeOrdinalReservationPlan(ordinalPlan);
  const keys = [
    'version',
    'entities',
    'history',
    'audit-events',
    'audit-by-id',
    'profiles',
    'collections',
    'ordinal-generation',
    'ordinals',
    ...encoded.counterKeys,
  ];
  const args = [
    '7',
    RECORD_ID,
    JSON.stringify({ id: RECORD_ID, operators: [] }),
    'set',
    `subscription:${RECORD_ID}`,
    '{"prior":true}',
    'set',
    AUDIT_ID,
    '1000',
    auditPayload(),
    PROFILE_ID,
    'subscription',
    RECORD_ID,
    '0',
    String(ordinalPlan.expectedGeneration),
    '1000',
    ...encoded.args,
  ];
  mutate?.(keys, args);
  return runLua51(CAS_ENTITY_WITH_HISTORY, { KEYS: keys, ARGV: args }, redis, {
    globals: LUA_GLOBALS as never,
  }) as unknown[];
}

function snapshot(): string {
  return JSON.stringify({
    values: [...values].sort(),
    hashes: [...hashes].map(([key, entries]) => [key, [...entries].sort()]).sort(),
    zsets: [...zsets].map(([key, entries]) => [key, [...entries].sort()]).sort(),
    types: [...types].sort(),
  });
}

beforeEach(() => {
  values.clear();
  hashes.clear();
  zsets.clear();
  types.clear();
  values.set('version', '7');
});

describe('production Lua 5.1 compile gate', () => {
  it('compiles every production CAS/ordinal script', () => {
    for (const script of new Set([
      CAS_ENTITY_WITH_HISTORY,
      CAS_SUBSCRIPTION_CHANGE,
      CAS_SUBSCRIPTION_DELETE,
      CAS_SUBSCRIPTION_RUNTIME_PATCH,
      CAS_COLLECTION_CHANGE,
      CAS_COLLECTION_DELETE,
      CAS_PIPELINE_ENTITY_WITH_ORDINALS,
      ASSIGN_ORDINALS_LUA,
      ORDINAL_SNAPSHOT_LUA,
      CLEAR_ORDINALS_LUA,
    ])) {
      expect(() => compileLua51(script)).not.toThrow();
    }
  });

  it('still rejects Lua 5.2 goto syntax', () => {
    expect(() => compileLua51('goto done\n::done::\nreturn 1')).toThrow();
  });
});

describe('subscription runtime status CAS', () => {
  function runRuntime(expectedVersion = '7'): unknown[] {
    return runLua51(
      CAS_SUBSCRIPTION_RUNTIME_PATCH,
      {
        KEYS: ['version', 'entities'],
        ARGV: [expectedVersion, 'entity-1', '{"id":"entity-1","last_synced_at":1234}'],
      },
      redis,
    ) as unknown[];
  }

  it('writes the complete runtime row and version in one transition', () => {
    expect(runRuntime()).toEqual([1, '8']);
    expect(values.get('version')).toBe('8');
    expect(hash('entities').get('entity-1')).toBe('{"id":"entity-1","last_synced_at":1234}');
  });

  it('a concurrent naming/config version wins with byte-exact zero writes', () => {
    values.set('version', '8');
    hash('entities').set('entity-1', '{"id":"entity-1","operators":["new-naming"]}');
    const before = snapshot();
    expect(runRuntime()).toEqual([0, '8']);
    expect(snapshot()).toBe(before);
  });

  it('wrongtype and version overflow fail before any entity write', () => {
    types.set('entities', 'string');
    let before = snapshot();
    expect(runRuntime()).toEqual([2, 'entity-wrongtype']);
    expect(snapshot()).toBe(before);

    types.delete('entities');
    values.set('version', String(Number.MAX_SAFE_INTEGER));
    before = snapshot();
    expect(runRuntime(String(Number.MAX_SAFE_INTEGER))).toEqual([2, 'version-overflow']);
    expect(snapshot()).toBe(before);
  });
});

describe('atomic entity + ordinal reservation script', () => {
  it('commits entity, assignments, counter, generations and version together', () => {
    expect(runGeneric(plan())).toEqual([1, '8']);
    expect(values.get('version')).toBe('8');
    expect(values.get('node-ordinal-counter:airport-a')).toBe('2');
    expect(values.get('ordinal-generation')).toBe('1');
    expect(hash('entities').get('entity-1')).toBe('{"id":"entity-1"}');
    expect([...hash('ordinals')]).toEqual([
      ['airport-a:fp-a', '1'],
      ['airport-a:fp-b', '2'],
    ]);
  });

  it('self-heals a leading-zero counter with the same ordinal 1 planned by JS', () => {
    values.set('node-ordinal-counter:airport-a', '01');
    const leadingZeroPlan = plan({
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '01',
          expectedSourceSize: 0,
          nextCounter: 1,
          fields: [{ fingerprint: 'fp-a', ordinal: 1 }],
        },
      ],
    });
    expect(runGeneric(leadingZeroPlan)).toEqual([1, '8']);
    expect(hash('ordinals').get('airport-a:fp-a')).toBe('1');
    expect(values.get('node-ordinal-counter:airport-a')).toBe('1');
  });

  it('self-heals an above-safe counter with the same ordinal 1 planned by JS', () => {
    values.set('node-ordinal-counter:airport-a', '9007199254740992');
    const aboveSafePlan = plan({
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '9007199254740992',
          expectedSourceSize: 0,
          nextCounter: 1,
          fields: [{ fingerprint: 'fp-a', ordinal: 1 }],
        },
      ],
    });
    expect(runGeneric(aboveSafePlan)).toEqual([1, '8']);
    expect(hash('ordinals').get('airport-a:fp-a')).toBe('1');
    expect(values.get('node-ordinal-counter:airport-a')).toBe('1');
  });

  it('rejects a generation at MAX_SAFE_INTEGER with byte-exact zero writes', () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    values.set('ordinal-generation', max);
    const before = snapshot();
    expect(runGeneric(plan({ expectedGeneration: Number.MAX_SAFE_INTEGER, sources: [] }))).toEqual([
      2,
      'ordinal-generation-overflow',
    ]);
    expect(snapshot()).toBe(before);
  });

  it('delete consumes history in the same successful transition', () => {
    hash('entities').set('entity-1', '{}');
    hash('history').set('subscription:entity-1', '{"prior":true}');
    expect(runGeneric(plan({ sources: [] }), 'delete')).toEqual([1, '8']);
    expect(hash('entities').has('entity-1')).toBe(false);
    expect(hash('history').has('subscription:entity-1')).toBe(false);
  });

  it.each([
    ['generation drift', () => values.set('ordinal-generation', '1')],
    ['global-size drift', () => hash('ordinals').set('other:fp', '1')],
    ['counter drift', () => values.set('node-ordinal-counter:airport-a', '9')],
    ['ordinal hash wrongtype', () => types.set('ordinals', 'string')],
    ['counter wrongtype', () => types.set('node-ordinal-counter:airport-a', 'hash')],
  ])('%s fails with byte-exact zero writes', (_label, arrange) => {
    arrange();
    const before = snapshot();
    expect(runGeneric(plan())[0]).not.toBe(1);
    expect(snapshot()).toBe(before);
  });

  it.each([
    ['skipped ordinal', (args: string[]) => (args[16] = '2')],
    ['counter rollback', (args: string[]) => (args[13] = '1')],
    ['duplicate field', (args: string[]) => (args[18] = args[15])],
  ])('%s is rejected before any write', (_label, mutate) => {
    const before = snapshot();
    expect(runGeneric(plan(), 'set', mutate)[0]).not.toBe(1);
    expect(snapshot()).toBe(before);
  });

  it('rejects duplicate canonical existing ordinals before any write', () => {
    hash('ordinals').set('airport-a:old-a', '1');
    hash('ordinals').set('airport-a:old-b', '1');
    values.set('node-ordinal-counter:airport-a', '1');
    const hostile = plan({
      expectedGlobalSize: 2,
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '1',
          expectedSourceSize: 2,
          nextCounter: 2,
          fields: [{ fingerprint: 'fp-c', ordinal: 2 }],
        },
      ],
    });
    const before = snapshot();
    expect(runGeneric(hostile)[0]).toBe(2);
    expect(snapshot()).toBe(before);
  });

  it('rejects a fully assigned duplicate source even when the plan has no new field', () => {
    hash('ordinals').set('airport-a:old-a', '1');
    hash('ordinals').set('airport-a:old-b', '1');
    values.set('node-ordinal-counter:airport-a', '1');
    const hostile = plan({
      expectedGlobalSize: 2,
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '1',
          expectedSourceSize: 2,
          nextCounter: 1,
          fields: [],
        },
      ],
    });
    const before = snapshot();
    expect(runGeneric(hostile)).toEqual([2, 'ordinal-existing-duplicate']);
    expect(snapshot()).toBe(before);
  });
});

describe('naming CAS executes entity + history + audit + ordinal reservation atomically', () => {
  beforeEach(() => {
    hash('profiles').set(
      PROFILE_ID,
      JSON.stringify({ id: PROFILE_ID, source: { type: 'subscription', id: RECORD_ID } }),
    );
  });

  it('commits every durable surface in one successful transition', () => {
    expect(runNaming(plan())).toEqual([1, '8']);
    expect(values.get('version')).toBe('8');
    expect(values.get('ordinal-generation')).toBe('1');
    expect(values.get('node-ordinal-counter:airport-a')).toBe('2');
    expect(hash('entities').get(RECORD_ID)).toBe(JSON.stringify({ id: RECORD_ID, operators: [] }));
    expect(hash('history').get(`subscription:${RECORD_ID}`)).toBe('{"prior":true}');
    expect(hash('audit-by-id').get(AUDIT_ID)).toBe(auditPayload());
    expect(zsets.get('audit-events')?.get(AUDIT_ID)).toBe(1000);
    expect([...hash('ordinals')]).toEqual([
      ['airport-a:fp-a', '1'],
      ['airport-a:fp-b', '2'],
    ]);
  });

  it('global workspace authority commits without a profile row while keeping the version CAS', () => {
    hash('profiles').delete(PROFILE_ID);
    expect(
      runNaming(plan(), (_keys, args) => {
        args[10] = '';
        args[11] = 'global';
        args[12] = '';
        args[13] = '0';
      }),
    ).toEqual([1, '8']);
    expect(values.get('version')).toBe('8');
    expect(hash('entities').get(RECORD_ID)).toBe(JSON.stringify({ id: RECORD_ID, operators: [] }));
  });

  it('self-heals a leading-zero counter with the same ordinal 1 planned by JS', () => {
    values.set('node-ordinal-counter:airport-a', '01');
    const leadingZeroPlan = plan({
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '01',
          expectedSourceSize: 0,
          nextCounter: 1,
          fields: [{ fingerprint: 'fp-a', ordinal: 1 }],
        },
      ],
    });
    expect(runNaming(leadingZeroPlan)).toEqual([1, '8']);
    expect(hash('ordinals').get('airport-a:fp-a')).toBe('1');
    expect(values.get('node-ordinal-counter:airport-a')).toBe('1');
  });

  it('self-heals an above-safe counter with the same ordinal 1 planned by JS', () => {
    values.set('node-ordinal-counter:airport-a', '9007199254740992');
    const aboveSafePlan = plan({
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '9007199254740992',
          expectedSourceSize: 0,
          nextCounter: 1,
          fields: [{ fingerprint: 'fp-a', ordinal: 1 }],
        },
      ],
    });
    expect(runNaming(aboveSafePlan)).toEqual([1, '8']);
    expect(hash('ordinals').get('airport-a:fp-a')).toBe('1');
    expect(values.get('node-ordinal-counter:airport-a')).toBe('1');
  });

  it('rejects a generation at MAX_SAFE_INTEGER with byte-exact zero writes', () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    values.set('ordinal-generation', max);
    const before = snapshot();
    expect(runNaming(plan({ expectedGeneration: Number.MAX_SAFE_INTEGER, sources: [] }))).toEqual([
      2,
      'ordinal-generation-overflow',
    ]);
    expect(snapshot()).toBe(before);
  });

  it.each([
    ['generation drift', () => values.set('ordinal-generation', '1'), plan()],
    ['global-size drift', () => hash('ordinals').set('other:fp', '1'), plan()],
    ['counter drift', () => values.set('node-ordinal-counter:airport-a', '9'), plan()],
    [
      'source-size drift',
      () => hash('ordinals').set('airport-a:old', '1'),
      plan({
        expectedGlobalSize: 1,
        sources: [{ ...plan().sources[0], expectedSourceSize: 0 }],
      }),
    ],
    [
      'field race',
      () => hash('ordinals').set('airport-a:fp-a', 'junk'),
      plan({
        expectedGlobalSize: 1,
        sources: [{ ...plan().sources[0], expectedSourceSize: 1 }],
      }),
    ],
  ])('%s rejects with byte-exact zero writes', (_label, arrange, ordinalPlan) => {
    arrange();
    const before = snapshot();
    expect(runNaming(ordinalPlan)[0]).not.toBe(1);
    expect(snapshot()).toBe(before);
  });

  it('rejects a fully assigned duplicate source even when the plan has no new field', () => {
    hash('ordinals').set('airport-a:old-a', '1');
    hash('ordinals').set('airport-a:old-b', '1');
    values.set('node-ordinal-counter:airport-a', '1');
    const hostile = plan({
      expectedGlobalSize: 2,
      sources: [
        {
          sourceKey: 'airport-a',
          expectedCounterRaw: '1',
          expectedSourceSize: 2,
          nextCounter: 1,
          fields: [],
        },
      ],
    });
    const before = snapshot();
    expect(runNaming(hostile)).toEqual([2, 'ordinal-existing-duplicate']);
    expect(snapshot()).toBe(before);
  });

  it.each([
    ['version', 'version', 'hash'],
    ['entity', 'entities', 'string'],
    ['history', 'history', 'string'],
    ['audit events', 'audit-events', 'hash'],
    ['audit payload', 'audit-by-id', 'string'],
    ['ordinal generation', 'ordinal-generation', 'hash'],
    ['ordinal hash', 'ordinals', 'string'],
    ['ordinal counter', 'node-ordinal-counter:airport-a', 'hash'],
  ])('%s WRONGTYPE rejects with byte-exact zero writes', (_label, key, kind) => {
    types.set(key, kind);
    const before = snapshot();
    expect(runNaming(plan())[0]).toBe(2);
    expect(snapshot()).toBe(before);
  });

  it('audit-id reuse, profile rebind and version overflow are all pre-write failures', () => {
    hash('audit-by-id').set(AUDIT_ID, '{"existing":true}');
    let before = snapshot();
    expect(runNaming(plan())).toEqual([2, 'audit-id-exists']);
    expect(snapshot()).toBe(before);

    hash('audit-by-id').delete(AUDIT_ID);
    hash('profiles').set(PROFILE_ID, JSON.stringify({ source: { type: 'none' } }));
    before = snapshot();
    expect(runNaming(plan())).toEqual([2, 'profile-binding-mismatch']);
    expect(snapshot()).toBe(before);

    hash('profiles').set(
      PROFILE_ID,
      JSON.stringify({ source: { type: 'subscription', id: RECORD_ID } }),
    );
    values.set('version', '9007199254740991');
    before = snapshot();
    expect(runNaming(plan(), (_keys, args) => (args[0] = '9007199254740991'))[0]).toBe(2);
    expect(snapshot()).toBe(before);
  });

  it('rejects an audit id that exists only in the sorted index with zero writes', () => {
    zsets.set('audit-events', new Map([[AUDIT_ID, 999]]));
    const before = snapshot();
    expect(runNaming(plan())).toEqual([2, 'audit-id-exists']);
    expect(snapshot()).toBe(before);
  });

  it('trims audit zset and payload hash together at the 1000-event cap', () => {
    const events = new Map<string, number>();
    const payloads = hash('audit-by-id');
    for (let i = 0; i < 1000; i += 1) {
      const id = `old-${String(i).padStart(4, '0')}`;
      events.set(id, i);
      payloads.set(id, `{"n":${i}}`);
    }
    zsets.set('audit-events', events);

    expect(runNaming(plan({ sources: [] }))).toEqual([1, '8']);
    expect(zsets.get('audit-events')?.size).toBe(1000);
    expect(hash('audit-by-id').size).toBe(1000);
    expect(zsets.get('audit-events')?.has('old-0000')).toBe(false);
    expect(hash('audit-by-id').has('old-0000')).toBe(false);
    expect(zsets.get('audit-events')?.has(AUDIT_ID)).toBe(true);
    expect(hash('audit-by-id').get(AUDIT_ID)).toBe(auditPayload());
  });

  it('retains the new audit even when its score is older than every capped event', () => {
    const events = new Map<string, number>();
    const payloads = hash('audit-by-id');
    for (let i = 0; i < 1000; i += 1) {
      const id = `old-${String(i).padStart(4, '0')}`;
      events.set(id, 10_000 + i);
      payloads.set(id, `{"n":${i}}`);
    }
    zsets.set('audit-events', events);

    expect(runNaming(plan({ sources: [] }), (_keys, args) => (args[8] = '0'))).toEqual([1, '8']);
    expect(zsets.get('audit-events')?.size).toBe(1000);
    expect(hash('audit-by-id').size).toBe(1000);
    expect(zsets.get('audit-events')?.get(AUDIT_ID)).toBe(0);
    expect(hash('audit-by-id').get(AUDIT_ID)).toBe(auditPayload());
    expect(zsets.get('audit-events')?.has('old-0000')).toBe(false);
    expect(hash('audit-by-id').has('old-0000')).toBe(false);
  });
});

describe('ordinal serving scripts execute the current KEYS/ARGV contract', () => {
  function runAssign(fields: string[], expectedVersion = '7'): unknown[] {
    return runLua51(
      ASSIGN_ORDINALS_LUA,
      {
        KEYS: ['ordinals', 'node-ordinal-counter:airport-a', 'version', 'ordinal-generation'],
        ARGV: ['20000', '99999', expectedVersion, 'airport-a:', ...fields],
      },
      redis,
    ) as unknown[];
  }

  function runSnapshot(counterKeys: string[] = []): unknown[] {
    return runLua51(
      ORDINAL_SNAPSHOT_LUA,
      { KEYS: ['ordinals', 'ordinal-generation'], ARGV: counterKeys },
      redis,
    ) as unknown[];
  }

  it('assign repairs a stale counter, writes generation, and rejects corrupt existing slots', () => {
    hash('ordinals').set('airport-a:old', '5');
    hash('ordinals').set('airport-a:corrupt', '007');
    expect(runAssign(['airport-a:old', 'airport-a:corrupt', 'airport-a:new'])).toEqual([
      '5',
      '',
      6,
    ]);
    expect(values.get('node-ordinal-counter:airport-a')).toBe('6');
    expect(values.get('ordinal-generation')).toBe('1');
    expect(hash('ordinals').get('airport-a:new')).toBe('6');
    expect(hash('ordinals').get('airport-a:corrupt')).toBe('007');
  });

  it('assign rejects duplicate existing ordinals before returning a fully assigned domain', () => {
    hash('ordinals').set('airport-a:a', '1');
    hash('ordinals').set('airport-a:b', '1');
    values.set('node-ordinal-counter:airport-a', '1');
    const before = snapshot();
    expect(runAssign(['airport-a:a', 'airport-a:b'])).toEqual([
      '__error__',
      'ordinal-existing-duplicate',
    ]);
    expect(snapshot()).toBe(before);
  });

  it('assign stale config and wrongtype state return errors with zero writes', () => {
    let before = snapshot();
    expect(runAssign(['airport-a:new'], '6')).toEqual(['__error__', 'stale-config']);
    expect(snapshot()).toBe(before);

    types.set('ordinals', 'string');
    before = snapshot();
    expect(runAssign(['airport-a:new'])).toEqual(['__error__', 'hash-wrongtype']);
    expect(snapshot()).toBe(before);
  });

  it('assign rejects a generation at MAX_SAFE_INTEGER before any write', () => {
    values.set('ordinal-generation', String(Number.MAX_SAFE_INTEGER));
    const before = snapshot();
    expect(runAssign(['airport-a:new'])).toEqual(['__error__', 'generation-overflow']);
    expect(snapshot()).toBe(before);
  });

  it('snapshot includes generation even with zero sources and classifies each wrongtype', () => {
    values.set('ordinal-generation', '4');
    expect(runSnapshot()).toEqual([0, [], 0, '4']);
    values.set('node-ordinal-counter:airport-a', '7');
    expect(runSnapshot(['node-ordinal-counter:airport-a'])).toEqual([0, [], 0, '4', '7']);
    types.set('node-ordinal-counter:airport-a', 'hash');
    expect(runSnapshot(['node-ordinal-counter:airport-a'])).toEqual([
      0,
      [],
      0,
      '4',
      [2, 'counter-wrongtype'],
    ]);
    types.clear();
    types.set('ordinal-generation', 'hash');
    expect(runSnapshot()).toEqual([2, 'generation-wrongtype']);
  });

  it('clear removes assignments and advances generation monotonically', () => {
    hash('ordinals').set('airport-a:fp', '1');
    values.set('ordinal-generation', '9');
    expect(
      runLua51(CLEAR_ORDINALS_LUA, { KEYS: ['ordinals', 'ordinal-generation'], ARGV: [] }, redis),
    ).toEqual([1, '10']);
    expect(hashes.has('ordinals')).toBe(false);
    expect(values.get('ordinal-generation')).toBe('10');
  });

  it('clear rejects a generation at MAX_SAFE_INTEGER before any write', () => {
    hash('ordinals').set('airport-a:a', '1');
    values.set('ordinal-generation', String(Number.MAX_SAFE_INTEGER));
    const before = snapshot();
    expect(
      runLua51(CLEAR_ORDINALS_LUA, { KEYS: ['ordinals', 'ordinal-generation'], ARGV: [] }, redis),
    ).toEqual([2, 'generation-overflow']);
    expect(snapshot()).toBe(before);
  });
});
