/**
 * FULL-PRODUCTION-SCRIPT Lua 5.1 compile + semantic harness (Delivery pass 1,
 * findings 1–3): compiles and EXECUTES the actual exported script text
 * (CAS_ENTITY_WITH_HISTORY, ASSIGN_ORDINALS_LUA) through a faithful Lua 5.1
 * compiler/interpreter (tests/helpers/lua51.ts) against an in-memory Redis
 * adapter with Lua semantics (Lua truthiness, tonumber, Lua patterns,
 * string.format('%.0f') exact digits, WRONGTYPE raises).
 *
 *   - compile gate: `goto` / `::label::` (Lua 5.2+ — invalid in Redis Lua
 *     5.1) is a PARSE ERROR, so the suite fails the moment invalid syntax is
 *     reintroduced;
 *   - semantic gate: exact committed bytes and zero writes on every
 *     failure path (malformed/out-of-range versions, WRONGTYPE keys, CAS
 *     mismatch, corrupt ordinal slots).
 *
 * No real Lua/Redis exists on this machine (probed and recorded in the
 * evidence packet); this harness executes the production script TEXT — it is
 * not a JS re-implementation of the script logic.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { compileLua51, runLua51, luaRuntimeError } from '../helpers/lua51';
import { CAS_ENTITY_WITH_HISTORY } from '@/lib/repos/namingCasRepo';
import { CAS_SUBSCRIPTION_CHANGE, CAS_SUBSCRIPTION_DELETE } from '@/lib/repos/subscriptionsRepo';
import { CAS_COLLECTION_CHANGE, CAS_COLLECTION_DELETE } from '@/lib/repos/collectionsRepo';
import { ASSIGN_ORDINALS_LUA, ORDINAL_SNAPSHOT_LUA } from '@/lib/repos/nodeOrdinalRepo';

/* ─── in-memory Redis adapter with Redis type semantics ─────────────── */

export interface MemRedis {
  typeOf(key: string): string; // 'string' | 'hash' | 'zset' | 'none'
  get(key: string): string | null;
  set(key: string, value: string): void;
  hget(key: string, field: string): string | null;
  hset(key: string, field: string, value: string): void;
  hdel(key: string, field: string): number;
  hlen(key: string): number;
  incr(key: string): number;
  zadd(key: string, score: number, member: string): void;
  snapshot(): { keys: string[]; version?: string };
}

export function createMemRedis(): {
  redis: MemRedis;
  types: Map<string, string>;
  stores: Map<string, Map<string, string | number>>;
} {
  const stores = new Map<string, Map<string, string | number>>();
  const types = new Map<string, string>();
  const ensure = (key: string): Map<string, string | number> => {
    let m = stores.get(key);
    if (!m) {
      m = new Map();
      stores.set(key, m);
    }
    return m;
  };
  const redis: MemRedis = {
    typeOf(key: string): string {
      if (types.has(key)) return types.get(key)!;
      if (key.startsWith('config:') || key.startsWith('node-ordinal-counter:')) return 'string';
      if (key.startsWith('audit:events')) return 'zset';
      return 'hash';
    },
    get(key) {
      if (this.typeOf(key) !== 'string' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a string`);
      }
      const v = stores.get(key)?.get('__v');
      return v === undefined ? null : String(v);
    },
    set(key, value) {
      if (this.typeOf(key) !== 'string' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a string`);
      }
      ensure(key).set('__v', value);
    },
    hget(key, field) {
      if (this.typeOf(key) !== 'hash' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
      }
      const v = stores.get(key)?.get(field);
      return v === undefined ? null : String(v);
    },
    hset(key, field, value) {
      if (this.typeOf(key) !== 'hash' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
      }
      ensure(key).set(field, value);
    },
    hdel(key, field) {
      if (this.typeOf(key) !== 'hash' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
      }
      return stores.get(key)?.delete(field) ? 1 : 0;
    },
    hlen(key) {
      if (this.typeOf(key) !== 'hash' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
      }
      return stores.get(key)?.size ?? 0;
    },
    incr(key) {
      if (this.typeOf(key) !== 'string' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a string`);
      }
      const next = Number(stores.get(key)?.get('__v') ?? 0) + 1;
      ensure(key).set('__v', next);
      return next;
    },
    zadd(key, score, member) {
      if (this.typeOf(key) !== 'zset' && this.typeOf(key) !== 'none') {
        throw luaRuntimeError(`WRONGTYPE ${key} is not a zset`);
      }
      ensure(key).set(member, score);
    },
    snapshot() {
      return { keys: [...stores.keys()] };
    },
  };
  return { redis, types, stores };
}

const VERSION_KEY = 'config:version';
const ENTITY_KEY = 'subscriptions';
const PROFILES_KEY = 'profiles';
const COLLECTIONS_KEY = 'collections';
const PROFILE_ID = '99999999-9999-4999-8999-999999999999';
const HISTORY_KEY = 'naming-history';
const AUDIT_EVENTS = 'audit:events';
const AUDIT_BY_ID = 'audit:by_id';

function casArgs(
  over: Partial<Record<string, string>> & {
    profileId?: string;
    bindingType?: string;
    bindingId?: string;
    memberIds?: string;
  } = {},
): string[] {
  // A FRESH id per call: the production script's own pre-write HEXISTS
  // (pass-1 finding) rejects a reused id atomically, so every run in this
  // describe must mint its own UUID to test the commit path.
  const auditId = over.auditId ?? crypto.randomUUID();
  return [
    over.expected ?? '0',
    over.recordId ?? 'sub-1',
    over.recordJson ?? '{"id":"sub-1"}',
    over.historyOp ?? 'set',
    over.historyField ?? 'subscription:sub-1',
    over.historyValue ?? '{"hadManaged":false}',
    over.auditOp ?? 'set',
    auditId,
    over.auditTs ?? '1000',
    over.auditPayload ?? JSON.stringify({ id: auditId }),
    over.profileId ?? PROFILE_ID,
    over.bindingType ?? 'subscription',
    over.bindingId ?? 'sub-1',
    String((over.memberIds ?? '').split(',').filter(Boolean).length),
    ...(over.memberIds ?? '').split(',').filter(Boolean),
  ];
}

describe('Lua 5.1 compile gate over the PRODUCTION scripts', () => {
  it('both production scripts compile as valid Lua 5.1', () => {
    expect(() => compileLua51(CAS_ENTITY_WITH_HISTORY)).not.toThrow();
    expect(() => compileLua51(ASSIGN_ORDINALS_LUA)).not.toThrow();
  });

  it('goto / ::label:: (Lua 5.2+ syntax) is a compile error — the finding-1 regression', () => {
    const bad = `
for i = 1, 3 do
  if i == 2 then goto continue end
  ::continue::
end
return {}
`;
    expect(() => compileLua51(bad)).toThrow(/goto|label/i);
  });
});

describe('CAS_ENTITY_WITH_HISTORY — exact bytes + zero writes on failure (executed script text)', () => {
  let mem: ReturnType<typeof createMemRedis>;
  let redis: MemRedis;

  beforeEach(() => {
    mem = createMemRedis();
    redis = mem.redis;
    // pass-7 blocker 4: the script re-validates the caller profile's source
    // binding — the fixture profile binds the sub being committed
    mem.stores.set(
      PROFILES_KEY,
      new Map([[PROFILE_ID, JSON.stringify({ source: { type: 'subscription', id: 'sub-1' } })]]),
    );
  });

  let lastAuditId: string | null = null;

  function buildAdapter(): {
    call: (command: string, ...args: unknown[]) => unknown;
  } {
    return {
      call: (command: string, ...args: unknown[]): unknown => {
        switch (command) {
          case 'TYPE': {
            const key = args[0] as string;
            const t = redis.typeOf(key);
            return t === 'none' ? { ok: 'none' } : { ok: t };
          }
          case 'GET':
            return redis.get(args[0] as string);
          case 'SET':
            redis.set(args[0] as string, args[1] as string);
            return 'OK';
          case 'HGET':
            return redis.hget(args[0] as string, args[1] as string);
          case 'HEXISTS':
            return redis.hget(args[0] as string, args[1] as string) !== null ? 1 : 0;
          case 'HGETALL': {
            const key = args[0] as string;
            const m = mem.stores.get(key);
            if (!m) return [];
            const pairs: string[] = [];
            for (const [field, value] of m) {
              if (field === '__v') continue;
              pairs.push(field, String(value));
            }
            return pairs;
          }
          case 'HSET':
            redis.hset(args[0] as string, args[1] as string, args[2] as string);
            return 1;
          case 'HDEL':
            return redis.hdel(args[0] as string, args[1] as string);
          case 'HLEN':
            return redis.hlen(args[0] as string);
          case 'ZADD':
            redis.zadd(args[0] as string, args[1] as number, args[2] as string);
            return 1;
          default:
            throw luaRuntimeError(`unexpected command ${command}`);
        }
      },
    };
  }

  // real Redis Lua ships cjson + pcall; the harness mirrors them so the
  // production profile-binding/member checks run verbatim
  const GLOBALS = {
    cjson: {
      decode: (raw: unknown): unknown => {
        if (typeof raw !== 'string') throw new Error('cjson.decode: expected string');
        return JSON.parse(raw);
      },
    },
    pcall: ((fn: (a: unknown) => unknown, raw: unknown): unknown => {
      try {
        return [true, fn(raw)];
      } catch {
        return [false, 'decode error'];
      }
    }) as unknown as (a: unknown, b: unknown) => unknown,
  };

  function run(expectedVersion: string, auditId?: string): unknown {
    lastAuditId = auditId ?? crypto.randomUUID();
    return runLua51(
      CAS_ENTITY_WITH_HISTORY,
      {
        KEYS: [
          VERSION_KEY,
          ENTITY_KEY,
          HISTORY_KEY,
          AUDIT_EVENTS,
          AUDIT_BY_ID,
          PROFILES_KEY,
          COLLECTIONS_KEY,
        ],
        ARGV: casArgs({ expected: expectedVersion, auditId: lastAuditId }),
      },
      buildAdapter(),
      { globals: GLOBALS as unknown as Record<string, never> },
    );
  }

  // raw reads WITHOUT type checks (the type-checked accessors throw on the
  // WRONGTYPE keys this helper must snapshot)
  const rawGet = (key: string, field?: string): string | null => {
    const m = mem.stores.get(key);
    if (!m) return null;
    if (field === undefined) return m.has('__v') ? String(m.get('__v')) : null;
    return m.has(field) ? String(m.get(field)) : null;
  };
  const bytes = (): {
    entity: string | null;
    history: string | null;
    version: string | null;
    audit: string | null;
  } => ({
    entity: rawGet(ENTITY_KEY, 'sub-1'),
    history: rawGet(HISTORY_KEY, 'subscription:sub-1'),
    version: rawGet(VERSION_KEY),
    audit: lastAuditId === null ? null : rawGet(AUDIT_BY_ID, lastAuditId),
  });

  it('pass-8 blocker 6: collection-binding member-id revalidation — add/delete/reorder fails with NOTHING written', () => {
    const COL_ID = '33333333-3333-4333-8333-333333333333';
    // a collection-bound profile: binding + member list both validated in-eval
    mem.stores.set(
      PROFILES_KEY,
      new Map([[PROFILE_ID, JSON.stringify({ source: { type: 'collection', id: COL_ID } })]]),
    );
    mem.stores.set(
      COLLECTIONS_KEY,
      new Map([[COL_ID, JSON.stringify({ id: COL_ID, subscription_ids: ['sub-1', 'sub-2'] })]]),
    );
    const runWith = (expected: string, current: string[]) => {
      mem.stores.set(
        COLLECTIONS_KEY,
        new Map([[COL_ID, JSON.stringify({ id: COL_ID, subscription_ids: current })]]),
      );
      return runLua51(
        CAS_ENTITY_WITH_HISTORY,
        {
          KEYS: [
            VERSION_KEY,
            ENTITY_KEY,
            HISTORY_KEY,
            AUDIT_EVENTS,
            AUDIT_BY_ID,
            PROFILES_KEY,
            COLLECTIONS_KEY,
          ],
          ARGV: casArgs({ bindingType: 'collection', bindingId: COL_ID, memberIds: expected }),
        },
        buildAdapter(),
        { globals: GLOBALS as unknown as Record<string, never> },
      );
    };
    // gate captured [sub-1, sub-2]; current record identical → commits
    expect(runWith('sub-1,sub-2', ['sub-1', 'sub-2'])).toEqual([1, '1']);
    // snapshot the state the FIRST commit landed in
    const committedVersion = rawGet(VERSION_KEY);
    const committedEntity = rawGet(ENTITY_KEY, 'sub-1');
    expect(committedVersion).toBe('1');
    // member ADDED after the gate → atomic rejection, nothing written
    expect(runWith('sub-1,sub-2', ['sub-1', 'sub-2', 'sub-3'])).toEqual([
      2,
      'profile-binding-mismatch',
    ]);
    // member DELETED after the gate → atomic rejection
    expect(runWith('sub-1,sub-2', ['sub-1'])).toEqual([2, 'profile-binding-mismatch']);
    // member REORDERED after the gate → atomic rejection (record order matters)
    expect(runWith('sub-1,sub-2', ['sub-2', 'sub-1'])).toEqual([2, 'profile-binding-mismatch']);
    // rejected runs wrote NOTHING — version and entity are byte-identical
    // to the state the FIRST commit produced
    expect(rawGet(VERSION_KEY)).toBe(committedVersion);
    expect(rawGet(ENTITY_KEY, 'sub-1')).toBe(committedEntity);
    expect(rawGet(HISTORY_KEY, 'subscription:sub-1')).toBe('{"hadManaged":false}');
  });

  it('missing version commits "1" byte-exact with entity+history+audit', () => {
    const result = run('0');
    expect(result).toEqual([1, '1']);
    expect(bytes()).toEqual({
      entity: '{"id":"sub-1"}',
      history: '{"hadManaged":false}',
      version: '1',
      audit: JSON.stringify({ id: lastAuditId }),
    });
  });

  it('"1" commits "2"; "9007199254740990" commits the EXACT "9007199254740991"', () => {
    redis.set(VERSION_KEY, '1');
    expect(run('1')).toEqual([1, '2']);
    redis.set(VERSION_KEY, '9007199254740990');
    expect(run('9007199254740990')).toEqual([1, '9007199254740991']);
    expect(redis.get(VERSION_KEY)).toBe('9007199254740991');
  });

  it('9007199254740991 / 2^53 / int64 max / leading-zero / malformed fail BEFORE any write', () => {
    const failing: Array<[string, string]> = [
      ['9007199254740991', '9007199254740991'],
      ['9007199254740992', '9007199254740992'],
      ['9223372036854775807', '9223372036854775807'],
      ['007', '007'],
      ['12x', '12x'],
      ['abc', 'abc'],
    ];
    for (const [stored, expected] of failing) {
      redis.set(VERSION_KEY, stored);
      const before = bytes();
      const result = run(expected) as unknown[];
      expect(result[0]).toBe(2); // version-malformed/overflow
      expect(bytes()).toEqual(before); // ZERO writes
    }
  });

  it('WRONGTYPE keys fail before ANY write (entity/history/version/audit untouched)', () => {
    const wrongTypes: Array<[string, string]> = [
      [ENTITY_KEY, 'string'],
      [HISTORY_KEY, 'string'],
      [AUDIT_EVENTS, 'string'],
      [AUDIT_BY_ID, 'string'],
      [VERSION_KEY, 'hash'],
    ];
    for (const [key, type] of wrongTypes) {
      redis.set(VERSION_KEY, '5'); // write BEFORE typing the key wrong
      mem.types.set(key, type);
      const before = bytes();
      const result = run('5') as unknown[];
      expect(result[0]).toBe(2);
      expect(bytes()).toEqual(before);
      mem.types.clear();
    }
  });

  it('CAS mismatch returns [0, current] with zero writes', () => {
    redis.set(VERSION_KEY, '7');
    const before = bytes();
    expect(run('6') as unknown[]).toEqual([0, '7']);
    expect(bytes()).toEqual(before);
  });

  it('REUSED audit id fails atomically with audit-id-exists BEFORE any write (pass-1 race closure)', () => {
    // The TypeScript side already probed and saw the id free; between that
    // probe and this eval another writer occupied it. The script's own
    // pre-write HEXISTS must reject with NOTHING written and the existing
    // event byte-exact — this is the only gate that can see the race.
    const id = '11111111-1111-4111-8111-111111111111';
    redis.hset(AUDIT_BY_ID, id, '{"existing":true}');
    redis.set(VERSION_KEY, '3');
    lastAuditId = id; // bind the snapshot reader to the seeded id
    const before = bytes();
    const result = run('3', id) as unknown[];
    expect(result).toEqual([2, 'audit-id-exists']);
    expect(bytes()).toEqual(before); // entity/history/version/audit untouched
    expect(rawGet(AUDIT_BY_ID, id)).toBe('{"existing":true}'); // never overwritten
  });
});

describe('ORDINAL_SNAPSHOT_LUA — one atomic read-only snapshot per source (finding 1)', () => {
  let mem: ReturnType<typeof createMemRedis>;
  let redis: MemRedis;

  beforeEach(() => {
    mem = createMemRedis();
    redis = mem.redis;
    // pass-7 blocker 4: the script re-validates the caller profile's source
    // binding — the fixture profile binds the sub being committed
    mem.stores.set(
      PROFILES_KEY,
      new Map([[PROFILE_ID, JSON.stringify({ source: { type: 'subscription', id: 'sub-1' } })]]),
    );
  });

  function run(): unknown {
    return runLua51(
      ORDINAL_SNAPSHOT_LUA,
      {
        KEYS: ['node-ordinals'],
        ARGV: ['node-ordinal-counter:a', 'node-ordinal-counter:b'],
      },
      {
        call: (command: string, ...args: unknown[]): unknown => {
          switch (command) {
            case 'TYPE':
              return { ok: redis.typeOf(args[0] as string) };
            case 'GET':
              return redis.get(args[0] as string);
            case 'HGETALL': {
              const m = mem.stores.get(args[0] as string);
              if (!m) return [];
              const pairs: string[] = [];
              for (const [field, value] of m) pairs.push(field, String(value));
              return pairs;
            }
            case 'HLEN':
              return redis.hlen(args[0] as string);
            default:
              throw luaRuntimeError(`unexpected command ${command}`);
          }
        },
      },
    );
  }

  it('returns the hash pairs + HLEN + ALL counters from ONE atomic instant', () => {
    redis.hset('node-ordinals', 'a:fp-1', '1');
    redis.set('node-ordinal-counter:a', '3');
    redis.set('node-ordinal-counter:b', '7');
    expect(run()).toEqual([0, ['a:fp-1', '1'], 1, '3', '7']);
  });

  it('wrongtype hash / counter classify exactly (hash-wrongtype / per-counter marker)', () => {
    mem.types.set('node-ordinals', 'string');
    expect(run()).toEqual([2, 'hash-wrongtype']);
    mem.types.clear();
    // ONE broken counter yields a per-source marker while the REST of the
    // snapshot is still returned atomically
    mem.types.set('node-ordinal-counter:a', 'hash');
    redis.set('node-ordinal-counter:b', '7');
    expect(run()).toEqual([0, [], 0, [2, 'counter-wrongtype'], '7']);
  });
});

describe('ASSIGN_ORDINALS_LUA — canonical/corrupt slots + exact writes (executed script text)', () => {
  let mem: ReturnType<typeof createMemRedis>;
  let redis: MemRedis;

  beforeEach(() => {
    mem = createMemRedis();
    redis = mem.redis;
    // pass-7 blocker 4: the script re-validates the caller profile's source
    // binding — the fixture profile binds the sub being committed
    mem.stores.set(
      PROFILES_KEY,
      new Map([[PROFILE_ID, JSON.stringify({ source: { type: 'subscription', id: 'sub-1' } })]]),
    );
  });

  function run(fields: string[]): unknown {
    return runLua51(
      ASSIGN_ORDINALS_LUA,
      {
        KEYS: ['node-ordinals', 'node-ordinal-counter:a'],
        ARGV: ['20000', '99999', ...fields],
      },
      {
        call: (command: string, ...args: unknown[]): unknown => {
          switch (command) {
            case 'TYPE':
              return { ok: redis.typeOf(args[0] as string) };
            case 'GET':
              return redis.get(args[0] as string);
            case 'SET':
              redis.set(args[0] as string, args[1] as string);
              return 'OK';
            case 'HGET':
              return redis.hget(args[0] as string, args[1] as string);
            case 'HSET':
              redis.hset(args[0] as string, args[1] as string, args[2] as string);
              return 1;
            case 'HLEN':
              return redis.hlen(args[0] as string);
            default:
              throw luaRuntimeError(`unexpected command ${command}`);
          }
        },
      },
    );
  }

  it('canonical existing values are returned byte-exact; corrupt slots reject WITHOUT counter reads or writes', () => {
    redis.hset('node-ordinals', 'a:fp-1', '1');
    redis.hset('node-ordinals', 'a:fp-2', '99999');
    redis.hset('node-ordinals', 'a:fp-3', '12x');
    const result = run(['a:fp-1', 'a:fp-2', 'a:fp-3', 'a:fp-new']) as unknown[];
    // existing values come back as strings, new allocations as numbers —
    // exactly what assignOrdinals' result mapping consumes
    expect(result).toEqual(['1', '99999', '', 1]);
    // corrupt slot wrote nothing; the counter advanced exactly once
    expect(redis.hget('node-ordinals', 'a:fp-3')).toBe('12x');
    expect(redis.get('node-ordinal-counter:a')).toBe('1');
  });

  it('corrupt matrix: empty, negative, decimal, suffix garbage, leading zeros, MAX+1, overflow all reject', () => {
    const corrupt = ['', '-1', '1.5', '12x', '007', '100000', '99999999999999999999'];
    const fields = corrupt.map((_, i) => `a:fp-${i}`);
    corrupt.forEach((v, i) => redis.hset('node-ordinals', fields[i], v));
    const result = run(fields) as unknown[];
    expect(result.every((v) => v === '')).toBe(true);
    // nothing written, counter untouched
    expect(redis.get('node-ordinal-counter:a')).toBeNull();
    corrupt.forEach((v, i) => expect(redis.hget('node-ordinals', fields[i])).toBe(v));
  });

  it('missing slots allocate exact SET/HSET bytes (never tostring)', () => {
    const result = run(['a:fp-1', 'a:fp-2']) as unknown[];
    expect(result).toEqual([1, 2]);
    expect(redis.get('node-ordinal-counter:a')).toBe('2');
    expect(redis.hget('node-ordinals', 'a:fp-1')).toBe('1');
    expect(redis.hget('node-ordinals', 'a:fp-2')).toBe('2');
  });

  it('WRONGTYPE hash or counter raises (serving fail-open catch mirrors this)', () => {
    mem.types.set('node-ordinals', 'string');
    expect(() => run(['a:fp-1'])).toThrow(/WRONGTYPE/);
    mem.types.clear();
    mem.types.set('node-ordinal-counter:a', 'hash');
    expect(() => run(['a:fp-1'])).toThrow(/WRONGTYPE/);
  });
});
describe('GENERIC CAS scripts (subscriptions/collections change+delete) — pre-write validation on the PRODUCTION script text (pass-4 finding)', () => {
  let mem: ReturnType<typeof createMemRedis>;
  let redis: MemRedis;

  beforeEach(() => {
    mem = createMemRedis();
    redis = mem.redis;
    // pass-7 blocker 4: the script re-validates the caller profile's source
    // binding — the fixture profile binds the sub being committed
    mem.stores.set(
      PROFILES_KEY,
      new Map([[PROFILE_ID, JSON.stringify({ source: { type: 'subscription', id: 'sub-1' } })]]),
    );
  });

  function runScript(script: string, expected: string, mutate: boolean): unknown {
    return runLua51(
      script,
      {
        KEYS: [VERSION_KEY, ENTITY_KEY],
        ARGV: mutate ? [expected, 'sub-1', '{"id":"sub-1"}'] : [expected, 'sub-1'],
      },
      {
        call: (command: string, ...args: unknown[]): unknown => {
          switch (command) {
            case 'TYPE': {
              const key = args[0] as string;
              const t = redis.typeOf(key);
              return t === 'none' ? { ok: 'none' } : { ok: t };
            }
            case 'GET':
              return redis.get(args[0] as string);
            case 'SET':
              redis.set(args[0] as string, args[1] as string);
              return 'OK';
            case 'HGET':
              return redis.hget(args[0] as string, args[1] as string);
            case 'HSET':
              redis.hset(args[0] as string, args[1] as string, args[2] as string);
              return 1;
            case 'HDEL':
              return redis.hdel(args[0] as string, args[1] as string);
            default:
              throw luaRuntimeError(`unexpected command ${command}`);
          }
        },
      },
    );
  }

  const snapshot = (): { entity: string | null; version: string | null } => ({
    entity:
      mem.stores.get(ENTITY_KEY)?.get('sub-1') === undefined
        ? null
        : String(mem.stores.get(ENTITY_KEY)?.get('sub-1')),
    version:
      mem.stores.get(VERSION_KEY)?.get('__v') === undefined
        ? null
        : String(mem.stores.get(VERSION_KEY)?.get('__v')),
  });

  const SCRIPTS: Array<{ name: string; script: string; mutate: boolean }> = [
    { name: 'CAS_SUBSCRIPTION_CHANGE', script: CAS_SUBSCRIPTION_CHANGE, mutate: true },
    { name: 'CAS_SUBSCRIPTION_DELETE', script: CAS_SUBSCRIPTION_DELETE, mutate: false },
    { name: 'CAS_COLLECTION_CHANGE', script: CAS_COLLECTION_CHANGE, mutate: true },
    { name: 'CAS_COLLECTION_DELETE', script: CAS_COLLECTION_DELETE, mutate: false },
  ];

  for (const { name, script, mutate } of SCRIPTS) {
    it(`${name}: valid commit SETs the exact next version atomically`, () => {
      redis.set(VERSION_KEY, '1');
      const result = runScript(script, '1', mutate);
      expect(result).toEqual([1, '2']);
      expect(snapshot().version).toBe('2');
      if (mutate) expect(snapshot().entity).toBe('{"id":"sub-1"}');
      else expect(snapshot().entity).toBeNull(); // HDEL removed it
    });

    it(`${name}: missing version commits "1" byte-exact`, () => {
      const result = runScript(script, '0', mutate);
      expect(result).toEqual([1, '1']);
      expect(snapshot().version).toBe('1');
    });

    it(`${name}: NONCANONICAL stored versions fail with ZERO writes — incl. STORED EMPTY STRING (pass-5 blocker)`, () => {
      // every value Redis GET can return except nil must be validated: a
      // stored empty string is truthy in Lua and must be version-malformed,
      // never silently treated as missing version 0.
      const bad = ['', '1e1', '007', '+1', '-1', '1.0', ' 1 ', '99999999999999999999'];
      for (const raw of bad) {
        redis.set(VERSION_KEY, raw);
        const before = snapshot();
        const expected = raw === '1e1' ? '10' : '1';
        const result = runScript(script, expected, mutate) as unknown[];
        expect(result[0]).toBe(2); // version-malformed
        expect(snapshot()).toEqual(before); // ZERO writes — no partial HSET/HDEL
        mem.stores.delete(VERSION_KEY);
      }
    });

    it(`${name}: only Redis nil means missing — absent key with expected 0 commits "1" (canonical create)`, () => {
      expect(snapshot()).toEqual({ entity: null, version: null });
      const result = runScript(script, '0', mutate) as unknown[];
      expect(result).toEqual([1, '1']);
      expect(snapshot().version).toBe('1');
      mem.stores.delete(VERSION_KEY);
      mem.stores.delete(ENTITY_KEY);
    });

    it(`${name}: canonical 0/1/MAX_SAFE-1 versions behave exactly`, () => {
      redis.set(VERSION_KEY, '0');
      expect(runScript(script, '0', mutate) as unknown[]).toEqual([1, '1']);
      expect(snapshot().version).toBe('1');
      redis.set(VERSION_KEY, '9007199254740990'); // MAX_SAFE - 1
      expect(runScript(script, '9007199254740990', mutate) as unknown[]).toEqual([
        1,
        '9007199254740991',
      ]);
      expect(snapshot().version).toBe('9007199254740991');
      // entity: CHANGE writes the row, DELETE removes it — each exactly once
      if (mutate) expect(snapshot().entity).toBe('{"id":"sub-1"}');
      else expect(snapshot().entity).toBeNull();
    });

    it(`${name}: overflow at MAX_SAFE boundary fails BEFORE any write`, () => {
      redis.set(VERSION_KEY, '9007199254740991'); // next would be 2^53
      const before = snapshot();
      const result = runScript(script, '9007199254740991', mutate) as unknown[];
      expect(result[0]).toBe(2);
      expect(snapshot()).toEqual(before);
    });

    it(`${name}: WRONGTYPE version/entity keys fail with ZERO writes`, () => {
      redis.set(VERSION_KEY, '5');
      mem.types.set(VERSION_KEY, 'hash');
      const before = snapshot();
      const result = runScript(script, '5', mutate) as unknown[];
      expect(result[0]).toBe(2);
      expect(snapshot()).toEqual(before);
      mem.types.clear();
      redis.hset(ENTITY_KEY, 'sub-1', '{}');
      mem.types.set(ENTITY_KEY, 'string');
      const before2 = snapshot();
      const result2 = runScript(script, '5', mutate) as unknown[];
      expect(result2[0]).toBe(2);
      expect(snapshot()).toEqual(before2);
    });

    it(`${name}: expected-version mismatch returns [0, current] with ZERO writes`, () => {
      redis.set(VERSION_KEY, '7');
      const before = snapshot();
      expect(runScript(script, '6', mutate) as unknown[]).toEqual([0, '7']);
      expect(snapshot()).toEqual(before);
    });
  }

  it('the exact Delivery repro: stored "1e1" with expected 10 previously partial-wrote — now version-malformed with zero writes', () => {
    redis.set(VERSION_KEY, '1e1');
    const before = snapshot();
    const result = runScript(CAS_SUBSCRIPTION_CHANGE, '10', true) as unknown[];
    expect(result[0]).toBe(2);
    expect(snapshot()).toEqual(before);
  });
});
