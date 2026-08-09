/**
 * subscriptionFetchHealthRepo — a separate advisory Redis value:
 *   - definition fingerprint is deterministic and sensitive to every
 *     render-affecting fetch identity input (id/kind/url/effective UA/
 *     headers/ttl_ms/policy), with blank UA equivalent to absent;
 *   - the Lua timestamp CAS accepts only lexicographically newer
 *     (attempted_at, observed_at); a slower older attempt never overwrites;
 *   - malformed stored values read absent and are replaceable;
 *   - every write goes through the Lua CAS with EX 604800 (the EX argument is
 *     recorded at eval time, exactly as the production script passes it) and
 *     touches ONLY the per-source health key (never config:version or the
 *     subscription hash).
 *
 * The fake models real Redis + Upstash semantics: `eval` SET stores RAW
 * bytes (the CAS compares against those exact bytes); `get`/`mget` return
 * JSON-DECODED values (Upstash auto-decodes valid JSON), so the repo's
 * schema validation sees objects — never strings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { SubscriptionFetchHealthSchema } from '@/schemas';
import type { Subscription, SubscriptionFetchHealth } from '@/schemas';

/** Raw bytes exactly as a real Redis string value would hold them. */
const raw = new Map<string, string>();
const evals: Array<{ script: string; keys: string[]; args: string[] }> = [];

function decode(key: string): unknown {
  const bytes = raw.get(key);
  if (bytes === undefined) return null;
  try {
    return JSON.parse(bytes);
  } catch {
    // Malformed bytes: Upstash returns the raw string; the repo's schema
    // validation then reads it absent.
    return bytes;
  }
}

const FETCH_CATEGORIES = [
  'network',
  'timeout',
  'http',
  'response-encoding',
  'response-content-format',
  'proxy-node',
];
const FAILED_DISPOSITIONS = ['unavailable', 'invalid', 'policy-blocked', 'bypassed'];
/** Canonical 43-char last characters (zero padding bits, v2 I12). */
const CANONICAL_LAST = 'AEIMQUYcgkosw048';

function isCanonicalFingerprint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  return CANONICAL_LAST.includes(value[42]);
}

/** Zod 4 z.number().int() is SAFE-INTEGER-bounded (within +/-9007199254740991). */
const MAX_SAFE_INT = 9_007_199_254_740_991;

function isSafeInt(value: unknown, lower = 0): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= lower && value <= MAX_SAFE_INT
  );
}

/** Exact strict-union traffic shape (SubscriptionTrafficSchema). */
function isValidTraffic(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.upload === 'number' &&
    Number.isFinite(t.upload) &&
    t.upload >= 0 &&
    typeof t.download === 'number' &&
    Number.isFinite(t.download) &&
    t.download >= 0 &&
    typeof t.total === 'number' &&
    Number.isFinite(t.total) &&
    t.total >= 0 &&
    // expire is a SIGNED safe integer (z.number().int()).
    isSafeInt(t.expire, -MAX_SAFE_INT)
  );
}

/** Per-state exact known-key sets (mirrors the .strict() union variants). */
const KNOWN_KEYS: Record<string, ReadonlySet<string>> = {
  fresh: new Set([
    'definition_fingerprint',
    'state',
    'attempted_at',
    'observed_at',
    'fresh_at',
    'proxy_count',
    'traffic',
  ]),
  'stale-served': new Set([
    'definition_fingerprint',
    'state',
    'attempted_at',
    'observed_at',
    'fresh_at',
    'proxy_count',
    'traffic',
    'failure_category',
    'cache_disposition',
  ]),
  'failed-no-cache': new Set([
    'definition_fingerprint',
    'state',
    'attempted_at',
    'observed_at',
    'failure_category',
    'cache_disposition',
  ]),
};

/** Mirror of the v2 CAS validation — EXACT equivalence to the strict
 * SubscriptionFetchHealthSchema union, including safe integers, traffic
 * shape, state-required and forbidden fields, and exact known-key
 * rejection. */
function isValidHealthRecord(decoded: Record<string, unknown>): boolean {
  if (!isCanonicalFingerprint(decoded.definition_fingerprint)) return false;
  if (!isSafeInt(decoded.attempted_at) || !isSafeInt(decoded.observed_at)) return false;
  const state = decoded.state;
  const category = decoded.failure_category;
  const disposition = decoded.cache_disposition;
  const validCategory = typeof category === 'string' && FETCH_CATEGORIES.includes(category);
  let stateOk = false;
  if (state === 'fresh') {
    stateOk =
      isSafeInt(decoded.fresh_at) &&
      isSafeInt(decoded.proxy_count) &&
      decoded.failure_category === undefined &&
      decoded.cache_disposition === undefined;
  } else if (state === 'stale-served') {
    stateOk =
      isSafeInt(decoded.fresh_at) &&
      isSafeInt(decoded.proxy_count) &&
      validCategory &&
      disposition === 'served';
  } else if (state === 'failed-no-cache') {
    // failed-no-cache FORBIDS fresh_at, proxy_count and traffic.
    stateOk =
      validCategory &&
      typeof disposition === 'string' &&
      FAILED_DISPOSITIONS.includes(disposition) &&
      decoded.fresh_at === undefined &&
      decoded.proxy_count === undefined &&
      decoded.traffic === undefined;
  }
  if (!stateOk) return false;
  if (!isValidTraffic(decoded.traffic)) return false;
  // Exact known-key rejection: every key must belong to the state's set.
  const allowed = KNOWN_KEYS[state as string];
  for (const key of Object.keys(decoded)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

const fakeRedis = {
  get: async (key: string) => decode(key),
  mget: async (...keys: string[]) => keys.map((key) => decode(key)),
  set: async (key: string, value: unknown) => {
    raw.set(key, JSON.stringify(value));
  },
  del: async (key: string) => Number(raw.delete(key)),
  eval: async (script: string, keys: string[], args: string[]) => {
    evals.push({ script, keys, args });
    const key = keys[0];
    const existing = raw.get(key);
    const newAttempted = Number(args[1]);
    const newObserved = Number(args[2]);
    if (existing !== undefined) {
      let decoded: unknown = null;
      try {
        decoded = JSON.parse(existing);
      } catch {
        decoded = null;
      }
      if (
        decoded !== null &&
        typeof decoded === 'object' &&
        isValidHealthRecord(decoded as Record<string, unknown>)
      ) {
        const oldAttempted = (decoded as Record<string, number>).attempted_at;
        const oldObserved = (decoded as Record<string, number>).observed_at;
        if (newAttempted < oldAttempted) return 0;
        if (newAttempted === oldAttempted && newObserved <= oldObserved) return 0;
      }
      // Schema-invalid existing values (incl. non-canonical fingerprints) are
      // replaceable regardless of their timestamps (v2 I13).
    }
    // The production script passes the TTL as ARGV[4] ('EX', ARGV[4]) — the
    // fake records it verbatim so the EX 604800 contract is observable.
    raw.set(key, args[0]);
    return 1;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

import {
  CAS_SUBSCRIPTION_FETCH_HEALTH,
  computeSubscriptionDefinitionFingerprint,
  deleteSubscriptionFetchHealth,
  getSubscriptionFetchHealth,
  getSubscriptionFetchHealthMany,
  recordSubscriptionFetchHealth,
} from '@/lib/repos/subscriptionFetchHealthRepo';

const SUB_ID = '11111111-1111-4111-8111-111111111111';

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: SUB_ID,
    name: 'airport-a',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    ...over,
  } as Subscription;
}

function health(over: Partial<SubscriptionFetchHealth> = {}): SubscriptionFetchHealth {
  return {
    definition_fingerprint: computeSubscriptionDefinitionFingerprint(sub()),
    state: 'fresh',
    attempted_at: 1_700_000_000_000,
    observed_at: 1_700_000_000_100,
    fresh_at: 1_700_000_000_100,
    proxy_count: 3,
    ...over,
  } as SubscriptionFetchHealth;
}

beforeEach(() => {
  raw.clear();
  evals.length = 0;
});

describe('definition fingerprint', () => {
  it('is deterministic for the same definition', () => {
    expect(computeSubscriptionDefinitionFingerprint(sub())).toBe(
      computeSubscriptionDefinitionFingerprint(sub()),
    );
  });

  it('changes when any fetch identity input changes — blank UA equals absent', () => {
    const base = computeSubscriptionDefinitionFingerprint(sub());
    const changed = new Map<string, string>();
    const cases: Array<[string, Partial<Subscription>]> = [
      ['id', { id: '22222222-2222-4222-8222-222222222222' }],
      ['kind', { kind: 'local', url: undefined, content: 'proxies: []\n' }],
      ['url', { url: 'https://other.example/sub' }],
      ['ua', { ua_override: 'custom-ua/1.0' }],
      ['headers', { custom_headers: { 'X-Token': 'a' } }],
      ['header order', { custom_headers: { b: '1', a: '2' } }],
      ['ttl', { ttl_ms: 120_000 }],
      ['policy', { fetch_failure_policy: 'fail-closed' }],
    ];
    for (const [label, patch] of cases) {
      changed.set(label, computeSubscriptionDefinitionFingerprint(sub(patch)));
    }
    // Every distinct input above changes the fingerprint; the blank-UA
    // equivalence is asserted separately (it must NOT be in the unique set).
    expect(new Set([base, ...changed.values()]).size).toBe(cases.length + 1);
    // blank ua_override is identical to absent (effective UA is what fetches)
    expect(computeSubscriptionDefinitionFingerprint(sub({ ua_override: '' }))).toBe(
      computeSubscriptionDefinitionFingerprint(sub({ ua_override: undefined })),
    );
    // header object key order is canonicalised
    expect(
      computeSubscriptionDefinitionFingerprint(sub({ custom_headers: { a: '2', b: '1' } })),
    ).toBe(computeSubscriptionDefinitionFingerprint(sub({ custom_headers: { b: '1', a: '2' } })));
  });

  it('never embeds the URL, headers or policy in cleartext (hash only)', () => {
    const fp = computeSubscriptionDefinitionFingerprint(
      sub({ url: 'https://token:secret@upstream.example/sub?k=v', custom_headers: { A: 'x' } }),
    );
    expect(fp).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(fp).not.toContain('secret');
    expect(fp).not.toContain('upstream.example');
    expect(fp).not.toContain('fail-closed');
  });
});

describe('record + read round trip', () => {
  it('stores via the Lua CAS with EX 604800 and reads back the decoded object', async () => {
    await recordSubscriptionFetchHealth(sub(), health());
    const key = REDIS_KEYS.subscriptionFetchHealth(SUB_ID);
    // Raw bytes are stored exactly as the script wrote them (ARGV[1]).
    expect(raw.get(key)).toBeTruthy();
    // The EX TTL is the script's ARGV[4], recorded at eval time.
    expect(evals[0].args[3]).toBe(String(7 * 24 * 60 * 60));
    expect(evals[0].keys).toEqual([key]);

    // get() returns the JSON-DECODED object (Upstash semantics) so the repo's
    // schema validation sees an object, not a string.
    const read = await getSubscriptionFetchHealth(SUB_ID);
    expect(read).toMatchObject({ state: 'fresh', proxy_count: 3 });
  });

  it('reads several keys with one MGET', async () => {
    await recordSubscriptionFetchHealth(sub(), health());
    const other = '22222222-2222-4222-8222-222222222222';
    const read = await getSubscriptionFetchHealthMany([SUB_ID, other]);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({ state: 'fresh' });
    expect(read[1]).toBeNull();
  });

  it('malformed stored health reads absent and is replaceable', async () => {
    raw.set(
      REDIS_KEYS.subscriptionFetchHealth(SUB_ID),
      JSON.stringify({ definition_fingerprint: 42, state: 'fresh' }),
    );
    expect(await getSubscriptionFetchHealth(SUB_ID)).toBeNull();

    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 1 }));
    expect(await getSubscriptionFetchHealth(SUB_ID)).toMatchObject({ state: 'fresh' });
  });

  it('delete removes the key best-effort', async () => {
    await recordSubscriptionFetchHealth(sub(), health());
    await deleteSubscriptionFetchHealth(SUB_ID);
    expect(raw.has(REDIS_KEYS.subscriptionFetchHealth(SUB_ID))).toBe(false);
  });
});

describe('canonical fingerprint + malformed replacement (v2 I12-I13)', () => {
  const hostileFingerprints: Array<[string, string]> = [
    ['short', 'A'.repeat(42)],
    ['long', 'A'.repeat(44)],
    ['padded', 'A'.repeat(42) + '='],
    ['plus alphabet', 'A'.repeat(42) + '+'],
    ['slash alphabet', 'A'.repeat(42) + '/'],
    ['non-canonical trailing', 'A'.repeat(42) + 'B'],
    ['empty', ''],
  ];

  it('hostile fingerprints read null and are replaceable even with newer-looking timestamps', async () => {
    for (const [label, fingerprint] of hostileFingerprints) {
      raw.set(
        REDIS_KEYS.subscriptionFetchHealth(SUB_ID),
        JSON.stringify({
          definition_fingerprint: fingerprint,
          // Newer-looking timestamps must NOT protect a schema-invalid value.
          attempted_at: 9_999_999,
          observed_at: 9_999_999,
          state: 'fresh',
          fresh_at: 9_999_999,
          proxy_count: 1,
        }),
      );
      expect(await getSubscriptionFetchHealth(SUB_ID), label).toBeNull();

      // The next VALID record replaces it even though its timestamps are older.
      await recordSubscriptionFetchHealth(
        sub(),
        health({ attempted_at: 1, observed_at: 1, fresh_at: 1 }),
      );
      const read = await getSubscriptionFetchHealth(SUB_ID);
      expect(read, label).toMatchObject({ attempted_at: 1, observed_at: 1 });
    }
  });

  it('a schema-invalid state combination with newer timestamps is replaceable', async () => {
    raw.set(
      REDIS_KEYS.subscriptionFetchHealth(SUB_ID),
      JSON.stringify({
        definition_fingerprint: computeSubscriptionDefinitionFingerprint(sub()),
        attempted_at: 9_999_999,
        observed_at: 9_999_999,
        state: 'fresh',
        // fresh with a failure field is schema-invalid (strict union).
        failure_category: 'network',
      }),
    );
    expect(await getSubscriptionFetchHealth(SUB_ID)).toBeNull();

    await recordSubscriptionFetchHealth(
      sub(),
      health({ attempted_at: 1, observed_at: 1, fresh_at: 1 }),
    );
    expect(await getSubscriptionFetchHealth(SUB_ID)).toMatchObject({ attempted_at: 1 });
  });

  it('every missed malformed class with NEWER-looking timestamps is replaceable', async () => {
    const fp = computeSubscriptionDefinitionFingerprint(sub());
    const malformedClasses: Array<[string, Record<string, unknown>]> = [
      [
        'fractional attempted_at',
        {
          definition_fingerprint: fp,
          state: 'fresh',
          attempted_at: 1.5,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
        },
      ],
      [
        'unsafe attempted_at beyond safe-int bound',
        {
          definition_fingerprint: fp,
          state: 'fresh',
          attempted_at: 9_007_199_254_740_992,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
        },
      ],
      [
        'bad traffic shape',
        {
          definition_fingerprint: fp,
          state: 'fresh',
          attempted_at: 9,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
          traffic: { upload: 'x' },
        },
      ],
      [
        'traffic expire outside signed safe-int bound',
        {
          definition_fingerprint: fp,
          state: 'fresh',
          attempted_at: 9,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
          traffic: { upload: 1, download: 2, total: 3, expire: 9_007_199_254_740_992 },
        },
      ],
      [
        'traffic upload wrong type',
        {
          definition_fingerprint: fp,
          state: 'fresh',
          attempted_at: 9,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
          traffic: { upload: 'x', download: 2, total: 3, expire: 4 },
        },
      ],
      [
        'failed-no-cache with forbidden fresh_at',
        {
          definition_fingerprint: fp,
          state: 'failed-no-cache',
          attempted_at: 9,
          observed_at: 9,
          failure_category: 'network',
          cache_disposition: 'unavailable',
          fresh_at: 9,
        },
      ],
      [
        'failed-no-cache with forbidden proxy_count',
        {
          definition_fingerprint: fp,
          state: 'failed-no-cache',
          attempted_at: 9,
          observed_at: 9,
          failure_category: 'network',
          cache_disposition: 'unavailable',
          proxy_count: 1,
        },
      ],
      [
        'unknown key',
        {
          definition_fingerprint: fp,
          state: 'fresh',
          attempted_at: 9,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
          bogus: true,
        },
      ],
      [
        'stale-served with unknown key',
        {
          definition_fingerprint: fp,
          state: 'stale-served',
          attempted_at: 9,
          observed_at: 9,
          fresh_at: 9,
          proxy_count: 1,
          failure_category: 'network',
          cache_disposition: 'served',
          bogus: 1,
        },
      ],
    ];
    for (const [label, record] of malformedClasses) {
      // Preserve a case-specific malformed timestamp (fractional / unsafe
      // attempted_at); only default newer-looking timestamps when the case
      // does not supply them.
      const seeded =
        record.attempted_at === undefined
          ? { ...record, attempted_at: 9_999_999, observed_at: 9_999_999 }
          : record;
      raw.set(REDIS_KEYS.subscriptionFetchHealth(SUB_ID), JSON.stringify(seeded));
      expect(await getSubscriptionFetchHealth(SUB_ID), label).toBeNull();

      // The next VALID record replaces it even though its timestamps are older.
      await recordSubscriptionFetchHealth(
        sub(),
        health({ attempted_at: 1, observed_at: 1, fresh_at: 1 }),
      );
      expect(await getSubscriptionFetchHealth(SUB_ID), label).toMatchObject({
        attempted_at: 1,
      });
    }
  });

  it('a raw record with an Infinity traffic counter is replaceable (cjson decodes Infinity; Zod rejects non-finite)', async () => {
    // JSON.stringify would coerce Infinity to null, so the RAW non-JSON
    // token is seeded verbatim — exactly what real Redis bytes + cjson would
    // decode. The mirror treats the undecodable bytes as malformed; real
    // cjson decodes it and the math.huge bound rejects it — both replace.
    raw.set(
      REDIS_KEYS.subscriptionFetchHealth(SUB_ID),
      '{"definition_fingerprint":"' +
        computeSubscriptionDefinitionFingerprint(sub()) +
        '","state":"fresh","attempted_at":9999999,"observed_at":9999999,' +
        '"fresh_at":9999999,"proxy_count":1,' +
        '"traffic":{"upload":Infinity,"download":2,"total":3,"expire":4}}',
    );
    expect(await getSubscriptionFetchHealth(SUB_ID)).toBeNull();

    await recordSubscriptionFetchHealth(
      sub(),
      health({ attempted_at: 1, observed_at: 1, fresh_at: 1 }),
    );
    expect(await getSubscriptionFetchHealth(SUB_ID)).toMatchObject({ attempted_at: 1 });
  });

  it('a FINITE 1.5e308 traffic counter stays orderable (exact double bound)', async () => {
    raw.set(
      REDIS_KEYS.subscriptionFetchHealth(SUB_ID),
      JSON.stringify({
        definition_fingerprint: computeSubscriptionDefinitionFingerprint(sub()),
        state: 'fresh',
        attempted_at: 200,
        observed_at: 200,
        fresh_at: 200,
        proxy_count: 1,
        traffic: { upload: 1.5e308, download: 2, total: 3, expire: 4 },
      }),
    );
    // The existing record is fully valid → an OLDER attempt is rejected.
    await recordSubscriptionFetchHealth(
      sub(),
      health({ attempted_at: 199, observed_at: 199, fresh_at: 199 }),
    );
    const read = await getSubscriptionFetchHealth(SUB_ID);
    expect(read).toMatchObject({ attempted_at: 200 });
  });

  it('outgoing writes are schema-validated: an invalid record is a best-effort NO-OP (no eval)', async () => {
    await recordSubscriptionFetchHealth(
      sub(),
      // Fractional attempted_at is schema-invalid.
      health({ attempted_at: 1.5, observed_at: 2, fresh_at: 2 }),
    );
    expect(evals).toHaveLength(0);
    expect(raw.has(REDIS_KEYS.subscriptionFetchHealth(SUB_ID))).toBe(false);

    await recordSubscriptionFetchHealth(
      sub(),
      // Non-canonical fingerprint is schema-invalid.
      {
        ...health(),
        definition_fingerprint: 'A'.repeat(42) + 'B',
      },
    );
    expect(evals).toHaveLength(0);

    // A valid record still writes exactly one eval.
    await recordSubscriptionFetchHealth(sub(), health());
    expect(evals).toHaveLength(1);
  });

  it('production fingerprints are canonical 43-char unpadded base64url', () => {
    const fp = computeSubscriptionDefinitionFingerprint(sub());
    expect(fp).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fp).not.toContain('=');
    // The health record written by the repo passes its own schema (canonical).
    expect(SubscriptionFetchHealthSchema.safeParse(health()).success).toBe(true);
  });
});

describe('timestamp CAS', () => {
  it('accepts a lexicographically newer (attempted_at, observed_at)', async () => {
    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 100, observed_at: 100 }));
    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 101, observed_at: 1 }));
    const read = await getSubscriptionFetchHealth(SUB_ID);
    expect(read?.attempted_at).toBe(101);

    // same attempted_at, newer observed_at wins
    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 101, observed_at: 50 }));
    expect((await getSubscriptionFetchHealth(SUB_ID))?.observed_at).toBe(50);
  });

  it('rejects an older or equal attempt without overwriting', async () => {
    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 200, observed_at: 200 }));
    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 199, observed_at: 999 }));
    await recordSubscriptionFetchHealth(sub(), health({ attempted_at: 200, observed_at: 200 }));
    const read = await getSubscriptionFetchHealth(SUB_ID);
    expect(read).toMatchObject({ attempted_at: 200, observed_at: 200 });
  });

  it('the CAS script is used for every write and never touches other keys', async () => {
    await recordSubscriptionFetchHealth(sub(), health());
    expect(evals.length).toBe(1);
    expect(evals[0].script).toBe(CAS_SUBSCRIPTION_FETCH_HEALTH);
    expect(evals[0].keys).toEqual([REDIS_KEYS.subscriptionFetchHealth(SUB_ID)]);
    expect(raw.has(REDIS_KEYS.configVersion)).toBe(false);
    expect(raw.has(REDIS_KEYS.subscriptions)).toBe(false);
  });
});
