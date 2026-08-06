import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAR_ORDINALS_LUA,
  assignOrdinals,
  canonicalGeneration,
  clearOrdinalAssignments,
  loadOrdinalAssignments,
  MAX_ORDINAL,
  MAX_TOTAL_ASSIGNMENTS,
  parseOrdinalCounter,
} from '@/lib/repos/nodeOrdinalRepo';
import { REDIS_KEYS } from '@/lib/redis/keys';

/**
 * In-memory fake of the exact Lua script semantics (get-or-assign, dense
 * results, counters per source key). New allocations return Lua numbers,
 * existing HGET values return strings — mirroring Redis/Upstash types.
 */
const redisState = vi.hoisted(() => ({
  hash: new Map<string, string>(),
  counters: new Map<string, number>(),
  configVersion: 7,
  generation: 0,
}));

function fakeEval(script: string, keys: string[], args: string[]): unknown[] {
  if (script === CLEAR_ORDINALS_LUA) {
    redisState.hash.clear();
    redisState.generation += 1;
    return [1, String(redisState.generation)];
  }
  const counterKey = keys[1];
  const hashCap = Number(args[0]);
  const maxOrd = Number(args[1]);
  if (Number(args[2]) !== redisState.configVersion) return ['__error__', 'stale-config'];
  const sourcePrefix = args[3];
  let sourceSize = [...redisState.hash.keys()].filter((field) =>
    field.startsWith(sourcePrefix),
  ).length;
  let maxExisting = 0;
  for (const [field, value] of redisState.hash) {
    if (field.startsWith(sourcePrefix) && /^(0|[1-9][0-9]*)$/.test(value)) {
      maxExisting = Math.max(maxExisting, Number(value));
    }
  }
  let base = Math.max(redisState.counters.get(counterKey) ?? 0, maxExisting);
  const out: unknown[] = [];
  let wrote = false;
  for (let i = 4; i < args.length; i += 1) {
    const field = args[i];
    const existing = redisState.hash.get(field);
    if (existing !== undefined) {
      out.push(existing);
      continue;
    }
    if (sourceSize + 1 > hashCap) {
      out.push('');
      continue;
    }
    const ordinal = base + 1;
    if (ordinal > maxOrd) {
      out.push('');
      continue;
    }
    redisState.hash.set(field, String(ordinal));
    sourceSize += 1;
    base = ordinal;
    wrote = true;
    out.push(ordinal);
  }
  if (wrote) {
    redisState.counters.set(counterKey, base);
    redisState.generation += 1;
  }
  return out;
}

vi.mock('@/lib/redis/client', () => ({
  getRedis: () => ({
    hgetall: async () => Object.fromEntries(redisState.hash),
    eval: fakeEval,
    del: async () => {
      redisState.hash.clear();
      redisState.counters.clear();
      redisState.generation = 0;
      return 1;
    },
  }),
}));

const FP_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('parseOrdinalCounter', () => {
  it('accepts only the canonical unsigned representation used by serving and CAS Lua', () => {
    expect(parseOrdinalCounter('0')).toBe(0);
    expect(parseOrdinalCounter('12')).toBe(12);
    expect(parseOrdinalCounter(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseOrdinalCounter('9007199254740992')).toBeNull();
    expect(parseOrdinalCounter('01')).toBeNull();
    expect(parseOrdinalCounter('-1')).toBeNull();
    expect(parseOrdinalCounter('+1')).toBeNull();
    expect(parseOrdinalCounter('1.0')).toBeNull();
  });
});

describe('canonicalGeneration', () => {
  it('accepts only generations that every atomic writer can still increment', () => {
    expect(canonicalGeneration(String(Number.MAX_SAFE_INTEGER - 1))).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(canonicalGeneration(String(Number.MAX_SAFE_INTEGER))).toBeNull();
    expect(canonicalGeneration('9007199254740992')).toBeNull();
  });
});

beforeEach(() => {
  redisState.hash.clear();
  redisState.counters.clear();
  redisState.configVersion = 7;
  redisState.generation = 0;
});

describe('assignOrdinals (atomic get-or-assign)', () => {
  it('first allocation returns authoritative numeric ordinals immediately', async () => {
    const got = await assignOrdinals('src-a', [FP_A, FP_B], 7);
    expect(got.get(FP_A)).toBe(1);
    expect(got.get(FP_B)).toBe(2);
    expect(redisState.hash.get(`src-a:${FP_A}`)).toBe('1');
  });

  it('reuse: a second caller gets the SAME ordinals (strings from HGET)', async () => {
    const first = await assignOrdinals('src-a', [FP_A, FP_B], 7);
    const second = await assignOrdinals('src-a', [FP_A, FP_B], 7);
    expect(second.get(FP_A)).toBe(first.get(FP_A));
    expect(second.get(FP_B)).toBe(first.get(FP_B));
    // no new ordinals were consumed
    expect(redisState.counters.get(REDIS_KEYS.nodeOrdinalCounter('src-a'))).toBe(2);
  });

  it('concurrent same-fingerprint allocation is race-free (one winner)', async () => {
    const [a, b] = await Promise.all([
      assignOrdinals('src-a', [FP_A], 7),
      assignOrdinals('src-a', [FP_A], 7),
    ]);
    expect(a.get(FP_A)).toBe(1);
    expect(b.get(FP_A)).toBe(1);
  });

  it('counters are per-source: ordinals restart across sources', async () => {
    const a = await assignOrdinals('src-a', [FP_A], 7);
    const b = await assignOrdinals('src-b', [FP_A], 7);
    expect(a.get(FP_A)).toBe(1);
    expect(b.get(FP_A)).toBe(1);
  });

  it('non-reuse: a freed ordinal is never handed to a different node', async () => {
    await assignOrdinals('src-a', [FP_A], 7); // FP_A = 1
    const next = await assignOrdinals('src-a', [FP_B], 7); // must be 2, never 1
    expect(next.get(FP_B)).toBe(2);
  });

  it('repairs a missing/stale counter from the source maximum before allocating', async () => {
    redisState.hash.set(`src-a:${FP_A}`, '5');
    redisState.counters.delete(REDIS_KEYS.nodeOrdinalCounter('src-a'));
    const next = await assignOrdinals('src-a', [FP_B], 7);
    expect(next.get(FP_B)).toBe(6);
    expect(redisState.counters.get(REDIS_KEYS.nodeOrdinalCounter('src-a'))).toBe(6);
  });

  it('a superseded render cannot publish any assignment', async () => {
    redisState.configVersion = 8;
    const got = await assignOrdinals('src-a', [FP_A], 7);
    expect(got.size).toBe(0);
    expect(redisState.hash.size).toBe(0);
    expect(redisState.generation).toBe(0);
  });

  it('reports the total-size cap as an incomplete assignment result', async () => {
    for (let i = 0; i < MAX_TOTAL_ASSIGNMENTS; i += 1) {
      redisState.hash.set(`src-a:fp-${i}`, String(i + 1));
    }
    const got = await assignOrdinals('src-a', [FP_A], 7);
    expect(got.has(FP_A)).toBe(false);
  });

  it('reports the max-ordinal cap as an incomplete assignment result', async () => {
    redisState.counters.set(REDIS_KEYS.nodeOrdinalCounter('src-a'), MAX_ORDINAL);
    const got = await assignOrdinals('src-a', [FP_A], 7);
    expect(got.has(FP_A)).toBe(false);
    expect(redisState.hash.has(`src-a:${FP_A}`)).toBe(false);
  });
});

describe('loadOrdinalAssignments', () => {
  it('loads per-source buckets and skips junk fields', async () => {
    await assignOrdinals('src-a', [FP_A], 7);
    await assignOrdinals('src-b', [FP_A, FP_B], 7);
    redisState.hash.set('no-colon-junk', '7');
    redisState.hash.set('src-a:badvalue', 'not-a-number');
    const loaded = await loadOrdinalAssignments(['src-a', 'src-b', 'src-c']);
    expect(loaded.get('src-a')?.get(FP_A)).toBe(1);
    expect(loaded.get('src-b')?.get(FP_B)).toBe(2);
    expect(loaded.get('src-a')?.has(FP_A)).toBe(true);
    expect(loaded.get('src-a')?.size).toBe(1);
    expect(loaded.get('src-c')?.size).toBe(0);
  });

  it('ignores ordinals above MAX_ORDINAL', async () => {
    redisState.hash.set(`src-a:${FP_A}`, String(MAX_ORDINAL + 1));
    const loaded = await loadOrdinalAssignments(['src-a']);
    expect(loaded.get('src-a')?.has(FP_A)).toBe(false);
  });
});

describe('clearOrdinalAssignments', () => {
  it('wipes the hash (test/admin helper)', async () => {
    await assignOrdinals('src-a', [FP_A], 7);
    await clearOrdinalAssignments();
    const loaded = await loadOrdinalAssignments(['src-a']);
    expect(loaded.get('src-a')?.size).toBe(0);
  });
});
