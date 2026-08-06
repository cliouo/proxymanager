import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignOrdinals,
  clearOrdinalAssignments,
  loadOrdinalAssignments,
  MAX_ORDINAL,
  MAX_TOTAL_ASSIGNMENTS,
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
}));

function fakeEval(_script: string, keys: string[], args: string[]): unknown[] {
  const counterKey = keys[1];
  const hashCap = Number(args[0]);
  const maxOrd = Number(args[1]);
  const out: unknown[] = [];
  for (let i = 2; i < args.length; i += 1) {
    const field = args[i];
    const existing = redisState.hash.get(field);
    if (existing !== undefined) {
      out.push(existing);
      continue;
    }
    if (redisState.hash.size + 1 > hashCap) {
      out.push('');
      continue;
    }
    const ordinal = (redisState.counters.get(counterKey) ?? 0) + 1;
    redisState.counters.set(counterKey, ordinal);
    if (ordinal > maxOrd) {
      out.push('');
      continue;
    }
    redisState.hash.set(field, String(ordinal));
    out.push(ordinal);
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
      return 1;
    },
  }),
}));

const FP_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  redisState.hash.clear();
  redisState.counters.clear();
});

describe('assignOrdinals (atomic get-or-assign)', () => {
  it('first allocation returns authoritative numeric ordinals immediately', async () => {
    const got = await assignOrdinals('src-a', [FP_A, FP_B]);
    expect(got.get(FP_A)).toBe(1);
    expect(got.get(FP_B)).toBe(2);
    expect(redisState.hash.get(`src-a:${FP_A}`)).toBe('1');
  });

  it('reuse: a second caller gets the SAME ordinals (strings from HGET)', async () => {
    const first = await assignOrdinals('src-a', [FP_A, FP_B]);
    const second = await assignOrdinals('src-a', [FP_A, FP_B]);
    expect(second.get(FP_A)).toBe(first.get(FP_A));
    expect(second.get(FP_B)).toBe(first.get(FP_B));
    // no new ordinals were consumed
    expect(redisState.counters.get(REDIS_KEYS.nodeOrdinalCounter('src-a'))).toBe(2);
  });

  it('concurrent same-fingerprint allocation is race-free (one winner)', async () => {
    const [a, b] = await Promise.all([
      assignOrdinals('src-a', [FP_A]),
      assignOrdinals('src-a', [FP_A]),
    ]);
    expect(a.get(FP_A)).toBe(1);
    expect(b.get(FP_A)).toBe(1);
  });

  it('counters are per-source: ordinals restart across sources', async () => {
    const a = await assignOrdinals('src-a', [FP_A]);
    const b = await assignOrdinals('src-b', [FP_A]);
    expect(a.get(FP_A)).toBe(1);
    expect(b.get(FP_A)).toBe(1);
  });

  it('non-reuse: a freed ordinal is never handed to a different node', async () => {
    await assignOrdinals('src-a', [FP_A]); // FP_A = 1
    const next = await assignOrdinals('src-a', [FP_B]); // must be 2, never 1
    expect(next.get(FP_B)).toBe(2);
  });

  it('respects the total-size cap (fail-open: new nodes fall back)', async () => {
    for (let i = 0; i < MAX_TOTAL_ASSIGNMENTS; i += 1) {
      redisState.hash.set(`src-a:fp-${i}`, String(i + 1));
    }
    const got = await assignOrdinals('src-a', [FP_A]);
    expect(got.has(FP_A)).toBe(false);
  });

  it('respects the max-ordinal cap (fail-open)', async () => {
    redisState.counters.set(REDIS_KEYS.nodeOrdinalCounter('src-a'), MAX_ORDINAL);
    const got = await assignOrdinals('src-a', [FP_A]);
    expect(got.has(FP_A)).toBe(false);
    expect(redisState.hash.has(`src-a:${FP_A}`)).toBe(false);
  });
});

describe('loadOrdinalAssignments', () => {
  it('loads per-source buckets and skips junk fields', async () => {
    await assignOrdinals('src-a', [FP_A]);
    await assignOrdinals('src-b', [FP_A, FP_B]);
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
    await assignOrdinals('src-a', [FP_A]);
    await clearOrdinalAssignments();
    const loaded = await loadOrdinalAssignments(['src-a']);
    expect(loaded.get('src-a')?.size).toBe(0);
  });
});
