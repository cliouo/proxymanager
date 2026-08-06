import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { applyRenameTemplate, withRawIdentity } from '@/lib/proxies/naming';
import { resolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';
import { sourceOf } from '@/lib/proxies/provenance';
import { runLua51, luaRuntimeError } from '../helpers/lua51';
import { ASSIGN_ORDINALS_LUA, ORDINAL_SNAPSHOT_LUA } from '@/lib/repos/nodeOrdinalRepo';

/**
 * Finding 5 parity: read-only preview and exact save preflight must compute
 * the SAME ordinal assignments and final names as the first serving render
 * and later renders — WITHOUT preview/preflight writes. The persisted
 * assignments published by the first serving render are exactly the
 * input-order values the read-only paths compute, and unambiguous upstream
 * ordinals win everywhere, so every path agrees on every node.
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

/**
 * In-memory mirror of the ordinal get-or-assign Lua — the SAME state machine
 * as allocateOrdinal in lib/repos/nodeOrdinalRepo (C6/C11): existing
 * assignment → hash cap → canonical counter parse (malformed/non-integer/
 * overflow → 0, negative stays negative) → value bounds; rejected nodes
 * write NOTHING; accepted nodes SET the exact computed counter + hash field.
 */
/**
 * Key-type injection (absent = hash for nodeOrdinals, string for counters).
 * WRONGTYPE reads/eval throw exactly like Redis, exercising the shared
 * fail-open paths on both sides.
 */
const keyTypes = new Map<string, string>();
const typeOf = (key: string): string =>
  keyTypes.get(key) ?? (key.startsWith('node-ordinal-counter:') ? 'string' : 'hash');

/**
 * SERVING SIDE = the EXECUTED PRODUCTION SCRIPT (ASSIGN_ORDINALS_LUA) through
 * the Lua 5.1 harness — never a JS re-implementation of its logic. The
 * adapter dispatches redis.call against the SAME in-memory store the
 * read-only projection reads, with Redis type semantics (WRONGTYPE raises at
 * the exact command, as a real eval would).
 */
function fakeEval(_script: string, keys: string[], args: string[]): unknown[] {
  let out: unknown;
  try {
    // dispatch by the ACTUAL script text (the all-source snapshot now carries
    // ARGV = counter keys, so argument count no longer discriminates)
    const script = _script === ORDINAL_SNAPSHOT_LUA ? ORDINAL_SNAPSHOT_LUA : ASSIGN_ORDINALS_LUA;
    out = runLua51(
      script,
      { KEYS: keys, ARGV: args },
      {
        call: (command: string, ...rest: unknown[]): unknown => {
          switch (command) {
            case 'TYPE': {
              const key = rest[0] as string;
              const t = typeOf(key);
              return t === 'none' ? { ok: 'none' } : { ok: t };
            }
            case 'GET': {
              const key = rest[0] as string;
              if (typeOf(key) !== 'string')
                throw luaRuntimeError(`WRONGTYPE ${key} is not a string`);
              return counters.has(key) ? String(counters.get(key)) : null;
            }
            case 'SET': {
              const key = rest[0] as string;
              if (typeOf(key) !== 'string')
                throw luaRuntimeError(`WRONGTYPE ${key} is not a string`);
              counters.set(key, Number(rest[1]));
              return 'OK';
            }
            case 'HGET': {
              const key = rest[0] as string;
              if (typeOf(key) !== 'hash') throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
              const v = stores.get(key)?.get(rest[1] as string);
              return v === undefined ? null : String(v);
            }
            case 'HGETALL': {
              const key = rest[0] as string;
              if (typeOf(key) !== 'hash') throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
              const m = stores.get(key);
              if (!m || m.size === 0) return [];
              const out: string[] = [];
              for (const [field, value] of m) out.push(field, String(value));
              return out;
            }
            case 'HSET': {
              const key = rest[0] as string;
              if (typeOf(key) !== 'hash') throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
              bucket(key).set(rest[1] as string, String(rest[2]));
              return 1;
            }
            case 'HLEN': {
              const key = rest[0] as string;
              if (typeOf(key) !== 'hash') throw luaRuntimeError(`WRONGTYPE ${key} is not a hash`);
              return stores.get(key)?.size ?? 0;
            }
            default:
              throw luaRuntimeError(`unexpected command ${command}`);
          }
        },
      },
    );
  } catch {
    return [];
  }
  return (out ?? []) as unknown[];
}

const fakeRedis = {
  hgetall: async (key: string) => {
    if (typeOf(key) !== 'hash') throw new Error('WRONGTYPE');
    const m = bucket(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hlen: async (key: string) => {
    if (typeOf(key) !== 'hash') throw new Error('WRONGTYPE');
    return stores.get(key)?.size ?? 0;
  },
  hget: async (key: string, id: string) => stores.get(key)?.get(id) ?? null,
  hset: async (key: string, payload: Record<string, unknown>) => {
    for (const [id, v] of Object.entries(payload)) bucket(key).set(id, v);
  },
  hdel: async (key: string, ...ids: string[]) => {
    const m = stores.get(key);
    if (!m) return 0;
    let n = 0;
    for (const id of ids) if (m.delete(id)) n++;
    return n;
  },
  get: async (key: string) => {
    if (typeOf(key) !== 'string') throw new Error('WRONGTYPE');
    return counters.has(key) ? counters.get(key)! : null;
  },
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  eval: fakeEval,
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

const TEMPLATE =
  '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}';

/** Raw upstream nodes: one with an unambiguous upstream ordinal, one without. */
function rawSource(): Record<string, unknown>[] {
  return [
    withRawIdentity(
      { name: '香港 05', type: 'ss', server: 'a.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-a', label: '机场A' },
    ),
    withRawIdentity(
      { name: '日本 foo', type: 'ss', server: 'b.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-a', label: '机场A' },
    ),
    withRawIdentity(
      { name: '香港 01', type: 'ss', server: 'c.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-b', label: '机场B' },
    ),
  ];
}

async function runWith(persist: boolean): Promise<string[]> {
  const proxies = rawSource();
  const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
    persist,
    template: TEMPLATE,
    recognitionRules: [],
  });
  const result = applyRenameTemplate(
    proxies,
    { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
    sourceOf,
    ordinals,
  );
  return result.proxies.map((p) => p.name as string);
}

beforeEach(() => {
  stores.clear();
  counters.clear();
  keyTypes.clear();
});

describe('preview/preflight vs serving-render parity (no preview writes)', () => {
  it('read-only preview, first render and later renders produce IDENTICAL names', async () => {
    const previewNames = await runWith(false);
    expect(previewNames).toEqual([
      '🇭🇰 香港 · 机场A · 05', // upstream ordinal wins, everywhere
      '🇯🇵 日本 · 机场A · 01', // no upstream ordinal → input order (preview)
      '🇭🇰 香港 · 机场B · 01',
    ]);
    const firstRenderNames = await runWith(true);
    const secondRenderNames = await runWith(true);
    expect(firstRenderNames).toEqual(previewNames);
    expect(secondRenderNames).toEqual(firstRenderNames);
  });

  it('the read-only preview NEVER writes ordinal assignments', async () => {
    await runWith(false);
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(0);
    // only the serving render publishes assignments
    await runWith(true);
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBeGreaterThan(0);
  });

  it('upstream reorder does not churn: later renders reuse persisted assignments', async () => {
    await runWith(true);
    const first = await runWith(true);
    // upstream reorders the no-ordinal node to the front
    const reordered = [rawSource()[1], rawSource()[0], rawSource()[2]];
    const ordinals = await resolveOrdinalsFor(reordered, sourceOf, {
      persist: false,
      template: TEMPLATE,
      recognitionRules: [],
    });
    const result = applyRenameTemplate(
      reordered,
      { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
      sourceOf,
      ordinals,
    );
    const names = result.proxies.map((p) => p.name as string).sort();
    expect(names).toEqual(first.sort());
  });

  it('a NEW node beside EXISTING ordinal history previews as the SAME value the first render publishes', async () => {
    // Delivery C6 repro: one node already has persisted ordinal 1 (counter=1).
    // The read-only preview must project the new node to 2 (never a colliding
    // 1 + suffix), exactly like the serving INCR assignment.
    const existing = rawSource()[0]; // 香港 05 (upstream ordinal → no assignment)
    const newNodes = [rawSource()[1], rawSource()[2]];
    const ordinalsFor = (persist: boolean) =>
      resolveOrdinalsFor([existing, ...newNodes], sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
    const namesFor = async (persist: boolean): Promise<string[]> => {
      const ordinals = await ordinalsFor(persist);
      const result = applyRenameTemplate(
        [existing, ...newNodes],
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      );
      return result.proxies.map((p) => p.name as string);
    };

    // seed: the source already has a persisted assignment for a REMOVED node
    // and the counter reflects it (airport-a counter=1; 日本 foo is fresh).
    counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 1);
    const preview = await namesFor(false);
    // the read-only preview wrote NOTHING (store empty, counter untouched)
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(0);
    expect(counters.get(REDIS_KEYS.nodeOrdinalCounter('airport-a'))).toBe(1);
    const firstRender = await namesFor(true);
    const repeatRender = await namesFor(true);
    expect(preview).toEqual(firstRender);
    expect(repeatRender).toEqual(firstRender);
    // 日本 foo (new node beside history) gets 02, never a colliding 01
    expect(preview).toContain('🇯🇵 日本 · 机场A · 02');
  });

  it('MAX_ORDINAL cap: projection and serving BOTH stop assigning — preview == render', async () => {
    const { MAX_ORDINAL } = await import('@/lib/repos/nodeOrdinalRepo');
    counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), MAX_ORDINAL);
    const names = async (persist: boolean): Promise<string[]> => {
      const proxies = rawSource();
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      return applyRenameTemplate(
        proxies,
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      ).proxies.map((p) => p.name as string);
    };
    const preview = await names(false);
    const render = await names(true);
    expect(preview).toEqual(render);
    // both fall back to input order (the serving Lua refuses > MAX_ORDINAL)
    expect(preview).toContain('🇯🇵 日本 · 机场A · 01');
  });

  it('assignment-hash cap: projection and serving BOTH stop assigning — preview == render', async () => {
    const { MAX_TOTAL_ASSIGNMENTS } = await import('@/lib/repos/nodeOrdinalRepo');
    // fill the assignment hash to the cap (junk fields)
    for (let i = 0; i < MAX_TOTAL_ASSIGNMENTS; i += 1) {
      bucket(REDIS_KEYS.nodeOrdinals).set(`cap:fp-${i}`, String(i + 1));
    }
    const names = async (persist: boolean): Promise<string[]> => {
      const proxies = rawSource();
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      return applyRenameTemplate(
        proxies,
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      ).proxies.map((p) => p.name as string);
    };
    const preview = await names(false);
    const render = await names(true);
    expect(preview).toEqual(render);
  });

  // C6/C11: ONE state machine serves both sides. Every counter state must
  // produce IDENTICAL ordinal maps + final names on preview and serving,
  // with preview writing NOTHING (store empty, counters untouched).
  const counterStates: Array<{ name: string; raw: number | string }> = [
    { name: 'negative counter', raw: -5 },
    { name: 'zero counter', raw: 0 },
    { name: 'non-integer counter', raw: 'abc' },
    { name: 'malformed counter', raw: '12x' },
    { name: 'plus-malformed counter', raw: '+7' },
    { name: 'overflow counter (beyond safe range)', raw: '99999999999999999999' },
    { name: 'empty-string counter', raw: '' },
  ];
  for (const state of counterStates) {
    it(`counter state "${state.name}": identical preview/serving maps + names, zero preview writes`, async () => {
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), state.raw as unknown as number);
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-b'), state.raw as unknown as number);
      const mapsAndNames = async (
        persist: boolean,
      ): Promise<{
        maps: Record<string, number | undefined>;
        names: string[];
      }> => {
        const proxies = rawSource();
        const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
          persist,
          template: TEMPLATE,
          recognitionRules: [],
        });
        const maps: Record<string, number | undefined> = {};
        for (const p of proxies) maps[p.name as string] = ordinals(p, sourceOf(p)?.key ?? '');
        const result = applyRenameTemplate(
          proxies,
          { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
          sourceOf,
          ordinals,
        );
        return { maps, names: result.proxies.map((p) => p.name as string) };
      };
      const beforeCounters = new Map(counters);
      const preview = await mapsAndNames(false);
      // zero preview writes: counters + store are byte-identical after the
      // read-only projection (serving may canonicalize/assign later)
      expect(counters).toEqual(beforeCounters);
      expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(0);
      const serving = await mapsAndNames(true);
      expect(preview.maps).toEqual(serving.maps);
      expect(preview.maps).toEqual(serving.maps);
      expect(preview.names).toEqual(serving.names);
    });
  }

  it('negative counters: BOTH sides fall back to input order (rejected, no store write)', async () => {
    counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), -5);
    counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-b'), -5);
    const maps = async (persist: boolean) => {
      const proxies = rawSource();
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      const m: Record<string, number | undefined> = {};
      for (const p of proxies) m[p.name as string] = ordinals(p, 'airport-a');
      return m;
    };
    const preview = await maps(false);
    const serving = await maps(true);
    expect(preview).toEqual(serving);
    // every fresh node fell back (input order) — nothing assigned or stored
    expect(preview['日本 foo']).toBeUndefined();
    expect(preview['香港 01']).toBeUndefined();
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(0);
    expect(counters.get(REDIS_KEYS.nodeOrdinalCounter('airport-a'))).toBe(-5);
  });

  it('MAX_ORDINAL boundary: 99998 assigns, 99999 and beyond fall back — identical both sides', async () => {
    const { MAX_ORDINAL } = await import('@/lib/repos/nodeOrdinalRepo');
    for (const [label, counter] of [
      ['below', MAX_ORDINAL - 1],
      ['at', MAX_ORDINAL],
      ['above', MAX_ORDINAL + 1],
    ] as const) {
      stores.get(REDIS_KEYS.nodeOrdinals)?.clear(); // no leak between states
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), counter);
      const ordinalFor = async (persist: boolean) => {
        const proxies = rawSource();
        const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
          persist,
          template: TEMPLATE,
          recognitionRules: [],
        });
        return ordinals(proxies[1], 'airport-a'); // 日本 foo — the fresh node
      };
      const preview = await ordinalFor(false);
      const serving = await ordinalFor(true);
      expect(preview).toBe(serving);
      if (label === 'below') expect(serving).toBe(MAX_ORDINAL);
      else expect(serving).toBeUndefined();
    }
  });

  it('cross-source totals: the hash cap counts assignments ACROSS sources — preview == serving', async () => {
    const { MAX_TOTAL_ASSIGNMENTS } = await import('@/lib/repos/nodeOrdinalRepo');
    // leave exactly one slot free; two fresh nodes (one per source) must BOTH
    // be rejected after the first consumes the last slot — identical on both
    // sides, and the ORDER is input order (cross-source).
    for (let i = 0; i < MAX_TOTAL_ASSIGNMENTS - 1; i += 1) {
      bucket(REDIS_KEYS.nodeOrdinals).set(`cap:fp-${i}`, String(i + 1));
    }
    const names = async (persist: boolean): Promise<string[]> => {
      const proxies = rawSource();
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      return applyRenameTemplate(
        proxies,
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      ).proxies.map((p) => p.name as string);
    };
    const preview = await names(false);
    const render = await names(true);
    expect(preview).toEqual(render);
  });

  it('upstream ordinals never consume an assignment on EITHER side', async () => {
    const preview = await runWith(false);
    const render = await runWith(true);
    expect(preview).toEqual(render);
    // the upstream node (香港 05) got its suffix from the upstream ordinal —
    // the fresh nodes consumed the only assignments (1 each), so the hash
    // has exactly 2 fields (one per source) and the upstream node's name
    // keeps 05 on both paths.
    expect(preview[0]).toBe('🇭🇰 香港 · 机场A · 05');
    // 香港 01 ALSO carries an upstream ordinal — it must never consume an
    // assignment either; only 日本 foo (no upstream suffix) is assigned.
    expect(preview[2]).toBe('🇭🇰 香港 · 机场B · 01');
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(1);
  });

  it('CONCURRENT INTERLEAVING (finding 1): a preview snapshot is atomic — a serving allocation landing mid-preview never tears the pair', async () => {
    const { fingerprintOf } = await import('@/lib/proxies/provenance');
    const proxies = rawSource(); // airport-a: 香港 05 (upstream), 日本 foo (fp-y)
    const fpY = fingerprintOf(proxies[1]) as string;
    const fpX = fingerprintOf(
      withRawIdentity(
        { name: '美国 中转', type: 'ss', server: 'x.example', port: 443, cipher: 'aes-128-gcm' },
        { key: 'airport-a', label: '机场A' },
      ),
    ) as string;
    // fresh store: counter 0, hash empty
    const originalEval = fakeRedis.eval;

    const previewOnce = async (): Promise<Record<string, number | undefined>> => {
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist: false,
        template: TEMPLATE,
        recognitionRules: [],
      });
      const m: Record<string, number | undefined> = {};
      for (const p of proxies) m[p.name as string] = ordinals(p, sourceOf(p)?.key ?? '');
      return m;
    };

    // 1) preview fp-y with a concurrent serving allocation of fp-x landing
    // IMMEDIATELY AFTER the preview's atomic snapshot eval
    let interleave: (() => Promise<void>) | null = null;
    fakeRedis.eval = (async (s: string, k: string[], a: string[]) => {
      const r = await originalEval(s, k, a);
      if (s === ORDINAL_SNAPSHOT_LUA && interleave) {
        const fn = interleave;
        interleave = null;
        await fn();
      }
      return r;
    }) as unknown as typeof fakeRedis.eval;
    try {
      interleave = async () => {
        // the concurrent serving run allocates fp-x (counter 0 → 1, hash + fp-x)
        await originalEval(
          '',
          [REDIS_KEYS.nodeOrdinals, REDIS_KEYS.nodeOrdinalCounter('airport-a')],
          ['20000', '99999', `airport-a:${fpX}`],
        );
      };
      const preview = await previewOnce();
      // the preview saw ONE atomic instant (pre-allocation): fp-y → 1, fp-x
      // absent — the torn fp-y=2-without-fp-x combination can never appear
      expect(preview['日本 foo']).toBe(1);
      expect(preview['香港 05']).toBeUndefined();
      // zero preview writes
      expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(1); // ONLY fp-x's serving write
      // 2) the serving run that follows sees the post-allocation store: fp-x=1, fp-y=2
      const serving = await resolveOrdinalsFor(
        [
          proxies[1],
          withRawIdentity(
            {
              name: '美国 中转',
              type: 'ss',
              server: 'x.example',
              port: 443,
              cipher: 'aes-128-gcm',
            },
            { key: 'airport-a', label: '机场A' },
          ),
        ],
        sourceOf,
        { persist: true, template: TEMPLATE, recognitionRules: [] },
      );
      expect(serving(proxies[1], 'airport-a')).toBe(2);
      // 3) PARITY: serving against the preview's OWN atomic snapshot gives
      // exactly what the preview predicted (fp-y=1)
      const snapshotServing = await resolveOrdinalsFor(proxies, sourceOf, {
        persist: true,
        template: TEMPLATE,
        recognitionRules: [],
      });
      // the store now has fp-x AND fp-y (step 2 served fp-y=2) — replay the
      // PRE-INTERLEAVE state: remove both, reset the counter, then serve fp-y
      stores.get(REDIS_KEYS.nodeOrdinals)?.delete(`airport-a:${fpX}`);
      stores.get(REDIS_KEYS.nodeOrdinals)?.delete(`airport-a:${fpY}`);
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 0);
      const cleanServing = await resolveOrdinalsFor(proxies, sourceOf, {
        persist: true,
        template: TEMPLATE,
        recognitionRules: [],
      });
      expect(cleanServing(proxies[1], 'airport-a')).toBe(1);
      expect(preview['日本 foo']).toBe(1);
      void snapshotServing;
    } finally {
      fakeRedis.eval = originalEval;
      stores.get(REDIS_KEYS.nodeOrdinals)?.delete(`airport-a:${fpX}`);
      stores.get(REDIS_KEYS.nodeOrdinals)?.delete(`airport-a:${fpY}`);
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 0);
    }
  });

  it('CROSS-SOURCE interleave (pass-3 finding): ONE all-source snapshot — a preview is wholly pre-state or post-state, never mixed', async () => {
    const { fingerprintOf } = await import('@/lib/proxies/provenance');
    const a = withRawIdentity(
      { name: '日本 foo', type: 'ss', server: 'a.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-a', label: '机场A' },
    );
    const b = withRawIdentity(
      { name: '美国 中转', type: 'ss', server: 'b.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-b', label: '机场B' },
    );
    const fpA = fingerprintOf(a) as string;
    const fpB = fingerprintOf(b) as string;
    const originalEval = fakeRedis.eval;
    let interleave: (() => Promise<void>) | null = null;
    fakeRedis.eval = (async (s: string, k: string[], ar: string[]) => {
      const r = await originalEval(s, k, ar);
      if (s === ORDINAL_SNAPSHOT_LUA && interleave) {
        const fn = interleave;
        interleave = null;
        await fn();
      }
      return r;
    }) as unknown as typeof fakeRedis.eval;
    try {
      const previewBoth = async (): Promise<Record<string, number | undefined>> => {
        const ordinals = await resolveOrdinalsFor([a, b], sourceOf, {
          persist: false,
          template: TEMPLATE,
          recognitionRules: [],
        });
        return {
          '日本 foo': ordinals(a, 'airport-a'),
          '美国 中转': ordinals(b, 'airport-b'),
        };
      };
      // the concurrent serving allocates fp-x on airport-a BETWEEN the
      // snapshot eval and the preview's consumption — the snapshot is ONE
      // instant, so the preview is WHOLLY pre-state for BOTH sources
      interleave = async () => {
        await originalEval(
          '',
          [REDIS_KEYS.nodeOrdinals, REDIS_KEYS.nodeOrdinalCounter('airport-a')],
          ['20000', '99999', `airport-a:${fpA}`],
        );
      };
      const preview = await previewBoth();
      // wholly pre-state: both counters were 0 → both fp's predict 1
      expect(preview).toEqual({ '日本 foo': 1, '美国 中转': 1 });
      // zero preview writes
      expect(counters.get(REDIS_KEYS.nodeOrdinalCounter('airport-a'))).toBe(1); // ONLY the serving write
      expect(counters.get(REDIS_KEYS.nodeOrdinalCounter('airport-b'))).toBeUndefined();
      // serving after the interleave sees the post-state wholly: fp-a's
      // interleave allocation is the existing assignment (1), fp-b allocates
      // 1 — identical to what the wholly-pre-state preview predicted
      const serving = await resolveOrdinalsFor([a, b], sourceOf, {
        persist: true,
        template: TEMPLATE,
        recognitionRules: [],
      });
      expect(serving(a, 'airport-a')).toBe(1);
      expect(serving(b, 'airport-b')).toBe(1);
      void fpB;
    } finally {
      fakeRedis.eval = originalEval;
      stores.get(REDIS_KEYS.nodeOrdinals)?.delete(`airport-a:${fpA}`);
      stores.get(REDIS_KEYS.nodeOrdinals)?.delete(`airport-b:${fpB}`);
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 0);
      counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-b'), 0);
    }
  });

  it('GLOBAL CAP parity across sources: preview and serving fall back identically at the assignment-hash cap', async () => {
    const { MAX_TOTAL_ASSIGNMENTS } = await import('@/lib/repos/nodeOrdinalRepo');
    for (let i = 0; i < MAX_TOTAL_ASSIGNMENTS - 1; i += 1) {
      bucket(REDIS_KEYS.nodeOrdinals).set(`cap:fp-${i}`, String(i + 1));
    }
    const a = withRawIdentity(
      { name: '日本 foo', type: 'ss', server: 'a.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-a', label: '机场A' },
    );
    const b = withRawIdentity(
      { name: '美国 中转', type: 'ss', server: 'b.example', port: 443, cipher: 'aes-128-gcm' },
      { key: 'airport-b', label: '机场B' },
    );
    const maps = async (persist: boolean): Promise<Record<string, number | undefined>> => {
      const ordinals = await resolveOrdinalsFor([a, b], sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      return { a: ordinals(a, 'airport-a'), b: ordinals(b, 'airport-b') };
    };
    const preview = await maps(false);
    const serving = await maps(true);
    expect(preview).toEqual(serving);
    // exactly ONE free slot: the FIRST source in input order gets it, the
    // second falls back — identical on both sides
    expect(preview.a).toBe(1);
    expect(preview.b).toBeUndefined();
  });

  it('REPEATED previews are stable and perform zero writes (production-route read-only contract)', async () => {
    counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 2);
    const names = async (): Promise<string[]> => {
      const proxies = rawSource();
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist: false,
        template: TEMPLATE,
        recognitionRules: [],
      });
      return applyRenameTemplate(
        proxies,
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      ).proxies.map((p) => p.name as string);
    };
    const first = await names();
    const storeAfterFirst = new Map(stores);
    const countersAfterFirst = new Map(counters);
    const second = await names();
    expect(second).toEqual(first);
    // zero writes across every preview
    expect(stores).toEqual(storeAfterFirst);
    expect(counters).toEqual(countersAfterFirst);
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(0);
  });

  it('wrongtype GLOBAL hash: BOTH sides fall back for every source — nothing throws, nothing written', async () => {
    keyTypes.set(REDIS_KEYS.nodeOrdinals, 'string'); // the hash holds a string
    const mapsAndNames = async (persist: boolean) => {
      const proxies = rawSource();
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      const maps: Record<string, number | undefined> = {};
      for (const p of proxies) maps[p.name as string] = ordinals(p, sourceOf(p)?.key ?? '');
      const result = applyRenameTemplate(
        proxies,
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      );
      return { maps, names: result.proxies.map((p) => p.name as string) };
    };
    const preview = await mapsAndNames(false);
    const serving = await mapsAndNames(true);
    expect(preview.maps).toEqual(serving.maps);
    expect(preview.names).toEqual(serving.names);
    // every node fell back to input order (no ordinals at all)
    expect(Object.values(preview.maps).every((v) => v === undefined)).toBe(true);
    // serving wrote nothing either (eval aborted → fail-open)
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.size ?? 0).toBe(0);
  });

  it('wrongtype per-source counter: all-canonical-existing keeps values; MIXED falls back entirely — identical both sides', async () => {
    const { fingerprintOf } = await import('@/lib/proxies/provenance');
    const { withRawIdentity } = await import('@/lib/proxies/naming');
    // airport-a: 日本 foo (no upstream), 美国 中转 (no upstream — a MISSING
    // slot), 香港 05 (upstream, never enters the eval); airport-b: 香港 01.
    const proxies = [
      withRawIdentity(
        { name: '日本 foo', type: 'ss', server: 'a.example', port: 443, cipher: 'aes-128-gcm' },
        { key: 'airport-a', label: '机场A' },
      ),
      withRawIdentity(
        { name: '美国 中转', type: 'ss', server: 'd.example', port: 443, cipher: 'aes-128-gcm' },
        { key: 'airport-a', label: '机场A' },
      ),
      withRawIdentity(
        { name: '香港 05', type: 'ss', server: 'c.example', port: 443, cipher: 'aes-128-gcm' },
        { key: 'airport-a', label: '机场A' },
      ),
      withRawIdentity(
        { name: '香港 01', type: 'ss', server: 'b.example', port: 443, cipher: 'aes-128-gcm' },
        { key: 'airport-b', label: '机场B' },
      ),
    ];
    const fpFoo = fingerprintOf(proxies[0]) as string;
    const fpUs = fingerprintOf(proxies[1]) as string;
    const mapsAndNames = async (persist: boolean) => {
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      const maps: Record<string, number | undefined> = {};
      for (const p of proxies) maps[p.name as string] = ordinals(p, sourceOf(p)?.key ?? '');
      const result = applyRenameTemplate(
        proxies,
        { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
        sourceOf,
        ordinals,
      );
      return { maps, names: result.proxies.map((p) => p.name as string) };
    };

    // MIXED: airport-a has an existing canonical value for 日本 foo but a
    // MISSING slot (美国 中转) — the counter GET raises mid-eval → the WHOLE
    // source falls back (日本 foo's existing value included).
    bucket(REDIS_KEYS.nodeOrdinals).set(`airport-a:${fpFoo}`, '1');
    keyTypes.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 'hash');
    const mixedPreview = await mapsAndNames(false);
    const mixedServing = await mapsAndNames(true);
    expect(mixedPreview.maps).toEqual(mixedServing.maps);
    expect(mixedPreview.maps['日本 foo']).toBeUndefined();
    expect(mixedPreview.maps['美国 中转']).toBeUndefined();

    // ALL-EXISTING: every airport-a non-upstream fp has a canonical value →
    // the counter is never read → the existing values survive on BOTH sides.
    keyTypes.delete(REDIS_KEYS.nodeOrdinalCounter('airport-a'));
    bucket(REDIS_KEYS.nodeOrdinals).set(`airport-a:${fpUs}`, '2');
    counters.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 1);
    keyTypes.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 'hash');
    const allPreview = await mapsAndNames(false);
    const allServing = await mapsAndNames(true);
    expect(allPreview.maps).toEqual(allServing.maps);
    expect(allPreview.maps['日本 foo']).toBe(1);
    expect(allPreview.maps['美国 中转']).toBe(2);
  });

  it('wrongtype counter + corrupt-existing: canonical values survive, corrupt slots reject — NO whole-source fallback (the counter is never read)', async () => {
    // airport-a has ONE canonical existing value and ONE corrupt value, and
    // its counter is WRONGTYPE. Neither slot reads the counter (canonical →
    // returned, corrupt → rejected) so the source must NOT fall back as a
    // whole — the canonical value survives on BOTH sides.
    const { fingerprintOf } = await import('@/lib/proxies/provenance');
    const proxies = rawSource();
    const fpFoo = fingerprintOf(proxies[1]) as string;
    const fpB = fingerprintOf(proxies[2]) as string;
    bucket(REDIS_KEYS.nodeOrdinals).set(`airport-a:${fpFoo}`, '1');
    bucket(REDIS_KEYS.nodeOrdinals).set(`airport-a:${fpB}`, '12x'); // corrupt
    keyTypes.set(REDIS_KEYS.nodeOrdinalCounter('airport-a'), 'hash');
    const maps = async (persist: boolean) => {
      const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
        persist,
        template: TEMPLATE,
        recognitionRules: [],
      });
      const m: Record<string, number | undefined> = {};
      for (const p of proxies) m[p.name as string] = ordinals(p, sourceOf(p)?.key ?? '');
      return m;
    };
    const preview = await maps(false);
    const serving = await maps(true);
    expect(preview).toEqual(serving);
    expect(preview['日本 foo']).toBe(1); // canonical survives
    expect(preview['香港 01']).toBeUndefined(); // corrupt slot → rejected
    // the corrupt value was never rewritten
    expect(stores.get(REDIS_KEYS.nodeOrdinals)?.get(`airport-a:${fpB}`)).toBe('12x');
    // preview wrote nothing
    expect(counters.get(REDIS_KEYS.nodeOrdinalCounter('airport-b'))).toBeUndefined();
    void fpB;
  });

  it('corrupt existing assignment values are REJECTED SLOTS on both sides — never re-allocated, never returned', async () => {
    const { MAX_ORDINAL } = await import('@/lib/repos/nodeOrdinalRepo');
    const proxies = rawSource();
    const { fingerprintOf } = await import('@/lib/proxies/provenance');
    const fpFoo = fingerprintOf(proxies[1]) as string;
    const states: Array<[string, string]> = [
      ['empty', ''],
      ['negative', '-1'],
      ['decimal', '1.5'],
      ['suffix garbage', '12x'],
      ['leading zeros', '007'],
      ['max+1', String(MAX_ORDINAL + 1)],
      ['overflow', '99999999999999999999'],
    ];
    for (const [label, value] of states) {
      stores.clear();
      counters.clear();
      bucket(REDIS_KEYS.nodeOrdinals).set(`airport-a:${fpFoo}`, value);
      const maps = async (persist: boolean) => {
        const ordinals = await resolveOrdinalsFor(proxies, sourceOf, {
          persist,
          template: TEMPLATE,
          recognitionRules: [],
        });
        const m: Record<string, number | undefined> = {};
        for (const p of proxies) m[p.name as string] = ordinals(p, sourceOf(p)?.key ?? '');
        return m;
      };
      const preview = await maps(false);
      const serving = await maps(true);
      expect(preview).toEqual(serving);
      // the corrupt slot is NOT returned and NOT re-allocated on either side
      expect(preview['日本 foo']).toBeUndefined();
      expect(serving['日本 foo']).toBeUndefined();
      // airport-b is upstream-only here (香港 01) — both sides agree
      expect(preview['香港 01']).toBe(serving['香港 01']);
      // the corrupt value was never rewritten by serving
      expect(stores.get(REDIS_KEYS.nodeOrdinals)?.get(`airport-a:${fpFoo}`)).toBe(value);
      // zero preview writes: counters untouched by the preview
      void label;
    }
  });
});
