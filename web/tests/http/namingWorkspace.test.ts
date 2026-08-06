import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { buildProfileScope, buildSourceAliasScope } from '@/lib/proxies/handleScopes';

/** Test-local handle helpers over complete one-identity domains. */
const profileHandle = (profileId: string): string =>
  buildProfileScope(profileId, [profileId]).project(`profile:${profileId}`);
const srcHandle = (key: string): string => buildSourceAliasScope([key]).project(key);
import { REDIS_KEYS } from '@/lib/redis/keys';

/**
 * /api/v1/naming/[type]/[id] workspace contract:
 *   GET  — managed state + persisted prior plan + per-source health (with
 *          per-node confidence/provenance facts) + diagnostics + impact;
 *          fully read-only (no stores written, no ordinals published).
 *   POST { apply }   — applies a new plan: preserves the existing op id and
 *          every policy field (tw2cn / sourceAliases / recognitionRules),
 *          persists the previous plan as the rollback target, and PATCHes
 *          through the shared save gate (CAS + all-consumer preflight).
 *   POST { rollback } — restores the persisted prior plan and clears it.
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
  get: async (key: string) => (counters.has(key) ? counters.get(key)! : null),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  // Faithful in-memory mirror of the production Lua scripts, INCLUDING the
  // C14 prevalidation order: every TYPE and VALUE precondition is proven
  // BEFORE the first mutation, and the version is SET to the exact computed
  // string (never INCR — a mid-script INCR failure after an HSET would leave
  // a partial commit). Failure injection: keyTypes[key] !== the expected
  // type makes the script return {2, reason} with NOTHING written — exactly
  // what the real script does.
  eval: async (_script: string, keys: string[], args: string[]) => {
    const typeOf = (key: string): string =>
      keyTypes.get(key) ??
      (key === REDIS_KEYS.audit.events
        ? 'zset'
        : key === REDIS_KEYS.configVersion
          ? 'string'
          : 'hash');
    const isHash = (key: string): boolean => {
      const t = typeOf(key);
      return t === 'hash' || t === 'none';
    };
    const isString = (key: string): boolean => {
      const t = typeOf(key);
      return t === 'string' || t === 'none';
    };
    const canonicalVersion = (raw: unknown): number | null => {
      if (raw === null || raw === undefined) return 0;
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
        if (raw <= 9007199254740990) return raw;
        return null;
      }
      if (typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)) {
        const n = Number(raw);
        // the exact next version must stay <= Number.MAX_SAFE_INTEGER
        if (Number.isSafeInteger(n) && n <= 9007199254740990) return n;
      }
      return null;
    };
    if (keys.length >= 3) {
      // CAS_ENTITY_WITH_HISTORY: [version, entity, history, auditEvents?, auditById?]
      if (!isHash(keys[1])) return [2, 'entity-wrongtype'];
      if (!isHash(keys[2])) return [2, 'history-wrongtype'];
      if (!isString(keys[0])) return [2, 'version-wrongtype'];
      if (keys.length >= 5) {
        const isZset = (key: string): boolean => {
          const t = typeOf(key);
          return t === 'zset' || t === 'none';
        };
        if (!isZset(keys[3])) return [2, 'audit-events-wrongtype'];
        if (!isHash(keys[4])) return [2, 'audit-byid-wrongtype'];
        // pass-1 finding: the production script proves EVERY precondition —
        // including the audit-id reuse gate — BEFORE the first mutation; the
        // mirror reproduces that order so a reused id writes NOTHING.
        if (args[6] === 'set' && bucket(keys[4]).has(args[7])) return [2, 'audit-id-exists'];
        // pass-7 blocker 4 / pass-8 blocker 6: the Lua re-validates the
        // caller profile's CURRENT source binding inside the same atomic
        // eval, and collection bindings re-validate the member-id list.
        if (keys.length >= 6) {
          const raw = bucket(keys[5]).get(args[10]);
          if (raw === undefined) return [2, 'profile-missing'];
          const profile = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as {
            source?: { type?: string; id?: string };
          };
          const st = profile.source;
          const bindingOk =
            args[11] === 'none' ? st?.type === 'none' : st?.type === args[11] && st.id === args[12];
          if (!bindingOk) return [2, 'profile-binding-mismatch'];
          if (keys.length === 7 && args[11] === 'collection') {
            const colRaw = bucket(keys[6]).get(args[12]);
            if (colRaw === undefined) return [2, 'profile-binding-mismatch'];
            const col = JSON.parse(
              typeof colRaw === 'string' ? colRaw : JSON.stringify(colRaw),
            ) as { subscription_ids?: string[] };
            const ids = col.subscription_ids ?? [];
            const expectedCount = Number(args[13]);
            if (ids.length !== expectedCount) return [2, 'profile-binding-mismatch'];
            for (let i = 0; i < expectedCount; i++) {
              if (ids[i] !== args[14 + i]) return [2, 'profile-binding-mismatch'];
            }
          }
        }
      }
      const current = canonicalVersion(counters.get(keys[0]));
      if (current === null) return [2, 'version-malformed'];
      const expected = Number(args[0]);
      if (current !== expected) return [0, String(current)];
      const nextVersion = current + 1;
      await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
      if (args[3] === 'set') {
        await fakeRedis.hset(keys[2], { [args[4]]: JSON.parse(args[5]) });
      } else if (args[3] === 'del') {
        await fakeRedis.hdel(keys[2], args[4]);
      }
      if (args[6] === 'set' && keys.length >= 5) {
        // ZADD audit-events score=ts member=id + HSET audit-by-id id=payload
        bucket(keys[3]).set(args[7], Number(args[8]));
        await fakeRedis.hset(keys[4], { [args[7]]: args[9] });
      }
      counters.set(keys[0], nextVersion);
      return [1, String(nextVersion)];
    }
    // Generic 2-key CAS (commitSubscriptionChange / commitCollectionChange).
    if (!isString(keys[0])) return [2, 'version-wrongtype'];
    const current = canonicalVersion(counters.get(keys[0]));
    if (current === null) return [2, 'version-malformed'];
    if (current !== Number(args[0])) return [0, String(current)];
    const nextVersion = current + 1;
    await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    counters.set(keys[0], nextVersion);
    return [1, String(nextVersion)];
  },
};

/** Key-type map for C14 failure injection (absent = 'hash'). */
const keyTypes = new Map<string, string>();

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: vi.fn(async () => ({
    configVersion: counters.get(REDIS_KEYS.configVersion) ?? 0,
  })),
}));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxiesRaw: vi.fn(async () => ({
    proxies: [
      { name: '🇭🇰 香港 01', type: 'ss', server: 'a.example.com', port: 443 },
      { name: '🇭🇰 香港 中转 02', type: 'ss', server: 'b.example.com', port: 443 },
      { name: '🇯🇵 日本 01', type: 'vmess', server: 'c.example.com', port: 443 },
    ],
    proxyCount: 3,
  })),
}));
vi.mock('@/lib/services/nodeExportService', () => ({
  mergeCollectionMemberProxies: vi.fn(async () => ({
    merged: [
      { name: '香港 01', type: 'ss', server: 'a.example.com', port: 443 },
      { name: '日本 01', type: 'ss', server: 'b.example.com', port: 443 },
    ],
    memberErrors: [],
  })),
  dedupExportProxies: vi.fn((proxies: unknown[]) => ({
    proxies,
    deduped: [],
    resolved: [],
  })),
}));
vi.mock('@/lib/services/nodeReferenceService', () => ({
  findNodeReferences: vi.fn(async () => []),
}));
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  resolveOrdinalsFor: vi.fn(async () => () => undefined),
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

import { GET, POST } from '@/app/api/v1/naming/[type]/[id]/route';
import { resolveOrdinalsFor as mockedResolveOrdinalsFor } from '@/lib/services/nodeOrdinalService';

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '99999999-9999-4999-8999-999999999999';

function seedSub(over: Record<string, unknown> = {}): void {
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
    id: SUB_ID,
    name: 'airport-a',
    display_name: '机场A',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
    ...over,
  });
}

function seed(): void {
  seedSub();
  // the route resolves the authorized editing profile via
  // resolveScopeProfile (fallback name 'default') — every apply/rollback
  // audit now binds its canonical profileId to this record
  bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
    id: PROFILE_ID,
    name: 'default',
    source: { type: 'subscription', id: SUB_ID },
    updated_at: 1,
  });
  // pre-create every bucket the route may touch (bucket() has a side effect)
  bucket(REDIS_KEYS.collections);
}

beforeAll(() => {
  installTestHandleSecret();
});

beforeEach(() => {
  stores.clear();
  counters.clear();
  keyTypes.clear();
  seed();
});

type Ctx = { params: Promise<{ type: 'subscription' | 'collection'; id: string }> };

async function call(
  handler: typeof GET,
  type: 'subscription' | 'collection',
  id: string,
  body?: unknown,
): Promise<Response> {
  const ctx = { params: Promise.resolve({ type, id }) } as Ctx;
  const currentVersion = counters.get(REDIS_KEYS.configVersion);
  const expectedVersion =
    typeof currentVersion === 'number' &&
    Number.isSafeInteger(currentVersion) &&
    currentVersion >= 0
      ? currentVersion
      : 0;
  const requestBody =
    body !== null &&
    typeof body === 'object' &&
    (Object.hasOwn(body, 'apply') || Object.hasOwn(body, 'rollback')) &&
    !Object.hasOwn(body, 'expectedVersion')
      ? {
          ...(body as Record<string, unknown>),
          expectedVersion,
        }
      : body;
  const request = new Request(`http://localhost/api/v1/naming/${type}/${id}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }),
  });
  return handler(request, ctx);
}

describe('GET /api/v1/naming/[type]/[id]', () => {
  it('returns managed state, recommended template, health (per-node facts) and diagnostics', async () => {
    const res = await call(GET, 'subscription', SUB_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entity: { label: string; ref: string };
        aggregate: boolean;
        managed: { present: boolean };
        priorPlan: { present: boolean };
        recommended: string;
        health: Array<{
          nodeCount: number;
          fields: Array<{
            field: string;
            percent: number;
            confidence: { high: number; medium: number; low: number };
          }>;
          nodeFacts: Array<{
            node: string;
            field: string;
            value: string | null;
            confidence: string | null;
          }>;
        }>;
        diagnostics: { nodeCount: number; collisions: string[]; deduped: unknown[] };
        references: { consumingProfiles: Array<{ id: string; name: string }>; orphaned: unknown[] };
      };
    };
    expect(body.data.entity.label).toBe('机场A');
    expect(body.data.aggregate).toBe(false);
    expect(body.data.managed.present).toBe(false);
    expect(body.data.priorPlan.present).toBe(false);
    expect(body.data.recommended).toContain('${emoji} ${region}');
    expect(body.data.health[0].nodeCount).toBe(3);
    const region = body.data.health[0].fields.find((f) => f.field === 'region')!;
    expect(region.percent).toBe(100);
    expect(region.confidence.high + region.confidence.medium).toBe(3);
    // per-node facts carry opaque handles + explicit confidence/provenance
    expect(body.data.health[0].nodeFacts.length).toBeGreaterThan(0);
    const protocolFact = body.data.health[0].nodeFacts.find((f) => f.field === 'protocol')!;
    expect(protocolFact.node).toMatch(/^nd-[0-9a-f]{16}$/);
    expect(protocolFact.confidence).toBe('high');
    expect(body.data.diagnostics.nodeCount).toBe(3);
    // pass-7: consuming-profile ids are keyed handles — raw UUIDs never leave storage
    expect(body.data.references.consumingProfiles).toEqual([
      {
        id: profileHandle(PROFILE_ID),
        name: 'default',
      },
    ]);
    // pass-7 blocker 1: health source keys and dedup provenance project as
    // keyed src handles — the stable source key never crosses the surface
    expect(body.data.entity.ref).toMatch(/^ref-[0-9a-f]{16}$/);
    expect(JSON.stringify(body.data.entity)).not.toContain(SUB_ID);
    const serialized = JSON.stringify(body.data);
    for (const src of body.data.health as Array<{ sourceKey?: string }>) {
      if (src.sourceKey !== undefined) {
        expect(src.sourceKey).toMatch(/^src-[0-9a-f]{16}$/);
        expect(serialized).not.toContain('airport-a');
      }
    }
    for (const d of body.data.diagnostics.deduped as Array<{ sourceKey?: string }>) {
      if (d.sourceKey !== undefined) {
        expect(d.sourceKey).toMatch(/^src-[0-9a-f]{16}$/);
      }
    }
  });

  it('runs diagnostics with the CURRENT managed template when one exists', async () => {
    seedSub({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    const res = await call(GET, 'subscription', SUB_ID);
    const body = (await res.json()) as {
      data: { managed: { template: string }; diagnostics: { changed: number } };
    };
    expect(body.data.managed.template).toBe('${emoji} ${region}');
    // three nodes → three distinct names → changed 3, no collisions
    expect(body.data.diagnostics.changed).toBe(3);
  });

  it('uses the recommended template for both ordinal planning and rendering when no managed row exists', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    vi.mocked(fetcher.resolveSubscriptionProxiesRaw).mockResolvedValueOnce({
      proxies: [{ name: '🇭🇰 动漫角色', type: 'ss', server: 'a.example.com', port: 443 }],
      proxyCount: 1,
    });
    vi.mocked(mockedResolveOrdinalsFor).mockResolvedValueOnce(() => 41);

    const res = await call(GET, 'subscription', SUB_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { recommended: string; diagnostics: { afterNames: string[] } };
    };
    expect(vi.mocked(mockedResolveOrdinalsFor).mock.lastCall?.[2]?.template).toBe(
      body.data.recommended,
    );
    expect(body.data.diagnostics.afterNames[0]).toContain('41');
  });

  it('uses a disabled managed draft for both ordinal planning and diagnostics', async () => {
    seedSub({
      operators: [
        {
          id: 'rt-disabled',
          kind: 'rename-template',
          template: '${region} ${index:3}',
          recognitionRules: [],
          disabled: true,
        },
      ],
    });
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    vi.mocked(fetcher.resolveSubscriptionProxiesRaw).mockResolvedValueOnce({
      proxies: [{ name: '🇭🇰 动漫角色', type: 'ss', server: 'a.example.com', port: 443 }],
      proxyCount: 1,
    });
    vi.mocked(mockedResolveOrdinalsFor).mockResolvedValueOnce(() => 9);

    const res = await call(GET, 'subscription', SUB_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { managed: { disabled: boolean }; diagnostics: { afterNames: string[] } };
    };
    expect(body.data.managed.disabled).toBe(true);
    expect(vi.mocked(mockedResolveOrdinalsFor).mock.lastCall?.[2]?.template).toBe(
      '${region} ${index:3}',
    );
    expect(body.data.diagnostics.afterNames).toEqual(['香港 009']);
  });

  it('is fully read-only: no stores written, no counters bumped', async () => {
    const before = new Map(stores);
    const countersBefore = new Map(counters);
    await call(GET, 'subscription', SUB_ID);
    expect(stores).toEqual(before);
    expect(counters).toEqual(countersBefore);
  });

  it('404 for unknown sources and 422 for bad params (schema boundary)', async () => {
    const missing = await call(GET, 'subscription', '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    const badType = await call(GET, 'collection' as 'subscription', 'not-a-uuid');
    expect(badType.status).toBe(422);
  });

  it('diagnostics names are structurally redacted — credential-shaped nodes never echo', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    (
      fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      proxies: [
        {
          // a raw name carrying credential-shaped text; its duplicate below
          // is a TRUE duplicate, so deduped diagnostics echo raw names
          name: '香港 https://sensitive.example/sub?token=abc123',
          type: 'ss',
          server: 'h.example',
          port: 443,
        },
        {
          name: '香港 https://sensitive.example/sub?token=abc123',
          type: 'ss',
          server: 'h.example',
          port: 443,
        },
        { name: '日本 01', type: 'ss', server: 'j.example', port: 443 },
      ],
      proxyCount: 3,
    });
    const res = await call(GET, 'subscription', SUB_ID);
    const body = (await res.json()) as {
      data: {
        diagnostics: {
          beforeNames: string[];
          afterNames: string[];
          collisions: string[];
          deduped: Array<{ kept: string; dropped: string }>;
        };
      };
    };
    // collisions + deduped ride the same structural redaction
    expect(body.data.diagnostics.deduped).toHaveLength(1);
    expect(body.data.diagnostics.deduped[0].kept).not.toContain('sensitive.example');
    expect(body.data.diagnostics.deduped[0].dropped).not.toContain('sensitive.example');
    const serialized = JSON.stringify(body.data.diagnostics);
    expect(serialized).not.toContain('sensitive.example');
    expect(serialized).not.toContain('token=abc123');
    // useful bounded semantics survive
    expect(serialized).toContain('香港');
    expect(serialized).toContain('日本');
  });
});

describe('POST apply — policy preservation + persisted prior plan', () => {
  it('applying ONLY a template preserves the op id, tw2cn, sourceAliases and recognitionRules', async () => {
    const currentOp = {
      id: 'rt-original',
      kind: 'rename-template',
      template: '${emoji} ${region}${?index: · ${index}}',
      tw2cn: true,
      sourceAliases: { 'airport-a': '改名机场' },
      recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
    };
    seedSub({ operators: [currentOp] });
    counters.set(REDIS_KEYS.configVersion, 7);

    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}${?rate: · ${rate}}' },
    });
    expect(res.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    const [op] = stored.operators;
    expect(op).toMatchObject({
      id: 'rt-original', // id preserved
      template: '${emoji} ${region}${?rate: · ${rate}}',
      tw2cn: true, // policy fields preserved
      sourceAliases: { 'airport-a': '改名机场' },
      recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
    });
    // the PREVIOUS plan was persisted as the rollback target
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as Record<
      string,
      unknown
    >;
    expect(history.template).toBe('${emoji} ${region}${?index: · ${index}}');
    expect(history.tw2cn).toBe(true);
  });

  it('the GET afterwards reports the persisted prior plan; rollback restores it exactly', async () => {
    seedSub({
      operators: [
        {
          id: 'rt-original',
          kind: 'rename-template',
          template: '${emoji} ${region}${?index: · ${index}}',
          tw2cn: true,
          sourceAliases: { 'airport-a': '改名机场' },
          recognitionRules: [],
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });

    // prior plan is visible in GET (real persisted rollback, not draft reset)
    const afterApply = (await (await call(GET, 'subscription', SUB_ID)).json()) as {
      data: { managed: { template: string }; priorPlan: { present: boolean; template: string } };
    };
    expect(afterApply.data.managed.template).toBe('${region}');
    expect(afterApply.data.priorPlan.present).toBe(true);
    expect(afterApply.data.priorPlan.template).toBe('${emoji} ${region}${?index: · ${index}}');

    // rollback restores the prior plan (id kept, policy fields back)
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators[0]).toMatchObject({
      template: '${emoji} ${region}${?index: · ${index}}',
      tw2cn: true,
      sourceAliases: { 'airport-a': '改名机场' },
    });
    // history entry consumed
    const afterRollback = (await (await call(GET, 'subscription', SUB_ID)).json()) as {
      data: { priorPlan: { present: boolean } };
    };
    expect(afterRollback.data.priorPlan.present).toBe(false);
  });

  it('rollback without a prior plan is a clean 422', async () => {
    const res = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(res.status).toBe(422);
  });

  it('pass-6: missing-secret failures are REDACTED IN LOGS — no raw error object, env name or stack', async () => {
    const { resetHandleSecret, injectHandleSecret } = await import('@/lib/proxies/handles');
    resetHandleSecret();
    const previous = process.env.NODE_HANDLE_SECRET;
    delete process.env.NODE_HANDLE_SECRET;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await call(GET, 'subscription', SUB_ID);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('NODE_HANDLE_SECRET');
      expect(text).not.toContain('test-only-handle-secret');
      // the LOG carries at most the stable safe code — never the raw error
      const logged = errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('[handle-secret-config]');
      expect(logged).toContain('HANDLE_SECRET_MISSING');
      expect(logged).not.toContain('NODE_HANDLE_SECRET');
      expect(logged).not.toContain('test-only-handle-secret');
      expect(logged).not.toContain('at handleSigner');
    } finally {
      errorSpy.mockRestore();
      if (previous !== undefined) process.env.NODE_HANDLE_SECRET = previous;
      injectHandleSecret('test-only-handle-secret-0000000000000000');
    }
  });

  it('pass-4 deployment entrypoint: configured secret → naming workspace GET succeeds; missing secret → bounded fail-closed 500', async () => {
    // configured path (the injected test key acts as the fixed configured
    // secret) — the workspace GET derives handles and returns health
    const ok = await call(GET, 'subscription', SUB_ID);
    expect(ok.status).toBe(200);

    // missing secret: the SAME entrypoint must fail closed with a bounded,
    // non-sensitive error — no env name, no stack, no key material
    const { resetHandleSecret } = await import('@/lib/proxies/handles');
    resetHandleSecret();
    try {
      const res = await call(GET, 'subscription', SUB_ID);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('NODE_HANDLE_SECRET');
      expect(text).not.toContain('test-only-handle-secret');
      expect(text).not.toContain('0000000000000000');
    } finally {
      const { injectHandleSecret } = await import('@/lib/proxies/handles');
      injectHandleSecret('test-only-handle-secret-0000000000000000');
    }
    // the entrypoint recovers once the secret is configured again
    const after = await call(GET, 'subscription', SUB_ID);
    expect(after.status).toBe(200);
  });

  it('pass-6: an UNBOUND target cannot be applied — same bounded error, ZERO writes and no audit', async () => {
    // the profile is bound to the SUBSCRIPTION — a COLLECTION apply must
    // fail before any read/preflight/write
    counters.set(REDIS_KEYS.configVersion, 7);
    const subBefore = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const res = await call(POST, 'collection', COL_ID, {
      apply: { template: '${region}' },
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(subBefore);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(0);
    // the GET is gated the same way
    const getRes = await call(GET, 'collection', COL_ID);
    expect(getRes.status).toBe(404);
  });

  it('pass-6: strict src-only aliases — plain stable keys and invented handles fail closed with ZERO writes', async () => {
    const stableHandle = srcHandle('airport-a');
    // a PLAIN stable key is rejected on the external route (no compatibility
    // pass-through)
    counters.set(REDIS_KEYS.configVersion, 7);
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const plain = await call(POST, 'subscription', SUB_ID, {
      apply: {
        template: '${region}',
        sourceAliases: { 'airport-a': '别名' },
      },
    });
    // pass-8 blocker 1: the EXTERNAL schema rejects plain stable keys at
    // PARSE (the zod boundary maps to 422) — before any profile/target/
    // config/membership read, with the SAME bounded order-independent error
    expect(plain.status).toBe(422);
    expect(await plain.text()).toContain('来源别名');
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(0);
    // an invented (format-valid, unmapped) handle is rejected the same way
    const invented = await call(POST, 'subscription', SUB_ID, {
      apply: {
        template: '${region}',
        sourceAliases: { 'src-0000000000000000': '别名' },
      },
    });
    expect(invented.status).toBe(400);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    // an AUTHORIZED src-only alias applies and persists under the STABLE key
    const ok = await call(POST, 'subscription', SUB_ID, {
      apply: {
        template: '${region}',
        sourceAliases: { [stableHandle]: '别名' },
      },
    });
    expect(ok.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as {
      operators: Array<{ sourceAliases?: Record<string, string> }>;
    };
    const op = stored.operators.find(
      (o) => (o as { kind?: string }).kind === 'rename-template',
    ) as { sourceAliases?: Record<string, string> };
    expect(op.sourceAliases).toEqual({ 'airport-a': '别名' });
  });

  it('pass-2: an unresolvable scope profile fails BEFORE any write (zero writes, no audit)', async () => {
    // the route resolves the authorized profile via resolveScopeProfile;
    // with no 'default' profile present the apply must fail 404 with
    // NOTHING written — entity/history/version/audit untouched
    const subBefore = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    bucket(REDIS_KEYS.profiles).delete(PROFILE_ID);
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(subBefore);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(0);
  });

  it('rejects malformed templates and invalid bodies at the schema boundary', async () => {
    // the plan body now validates the DSL at parse time (shared by preview
    // and apply) — an invalid template is a 422 schema-boundary rejection,
    // identical for preview and apply
    const bad = await call(POST, 'subscription', SUB_ID, { apply: { template: '${foo}' } });
    expect(bad.status).toBe(422);
    const badPreview = await call(POST, 'subscription', SUB_ID, {
      preview: { template: '${foo}' },
    });
    expect(badPreview.status).toBe(422);
    const badBody = await call(POST, 'subscription', SUB_ID, { nope: true });
    expect(badBody.status).toBe(422);
    const missingExpectedVersion = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
      expectedVersion: undefined,
    });
    expect(missingExpectedVersion.status).toBe(422);

    const entityBefore = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const historyBefore = JSON.stringify(
      bucket(REDIS_KEYS.namingHistory).get(`subscription:${SUB_ID}`),
    );
    const versionBefore = counters.get(REDIS_KEYS.configVersion);
    const auditEventsBefore = bucket(REDIS_KEYS.audit.events).size;
    const auditPayloadsBefore = bucket(REDIS_KEYS.audit.byId).size;
    const mixedApplyPreview = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
      preview: { template: '${region}' },
    });
    const mixedRollbackApply = await call(POST, 'subscription', SUB_ID, {
      rollback: true,
      apply: { template: '${region}' },
    });
    const nestedExtra = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}', unexpected: true },
    });
    expect(mixedApplyPreview.status).toBe(422);
    expect(mixedRollbackApply.status).toBe(422);
    expect(nestedExtra.status).toBe(422);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(entityBefore);
    expect(JSON.stringify(bucket(REDIS_KEYS.namingHistory).get(`subscription:${SUB_ID}`))).toBe(
      historyBefore,
    );
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(versionBefore);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(auditEventsBefore);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(auditPayloadsBefore);
  });

  it('rejects a replayed apply version without overwriting the exact rollback target', async () => {
    counters.set(REDIS_KEYS.configVersion, 7);
    const first = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
      expectedVersion: 7,
    });
    expect(first.status).toBe(200);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    const historyAfterFirst = JSON.stringify(
      bucket(REDIS_KEYS.namingHistory).get(`subscription:${SUB_ID}`),
    );
    const entityAfterFirst = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const auditsAfterFirst = bucket(REDIS_KEYS.audit.byId).size;

    const replay = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
      expectedVersion: 7,
    });

    expect(replay.status).toBe(412);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(entityAfterFirst);
    expect(JSON.stringify(bucket(REDIS_KEYS.namingHistory).get(`subscription:${SUB_ID}`))).toBe(
      historyAfterFirst,
    );
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(auditsAfterFirst);
  });

  it('applies to collections the same way', async () => {
    // pass-6 scope: the caller profile must be bound to the collection
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'collection', id: COL_ID },
      updated_at: 1,
    });
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合一号',
      slug: 'agg-1',
      enabled: true,
      type: 'select',
      subscription_ids: [],
      subscription_tags: [],
      operators: [
        {
          id: 'rt-col',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'collection', COL_ID, {
      apply: { template: '${emoji} ${region}${?index: · ${index}}' },
    });
    expect(res.status).toBe(200);
    const stored = bucket(REDIS_KEYS.collections).get(COL_ID) as { operators: unknown[] };
    expect(stored.operators[0]).toMatchObject({
      id: 'rt-col',
      template: '${emoji} ${region}${?index: · ${index}}',
    });
  });

  it('FIRST apply (absent managed) persists hadManaged:false and rollback REMOVES the operator', async () => {
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(200);
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as {
      hadManaged: boolean;
    };
    expect(history.hadManaged).toBe(false);
    // rollback restores ABSENT state: the rename op is removed entirely
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toEqual([]);
    const after = (await (await call(GET, 'subscription', SUB_ID)).json()) as {
      data: { managed: { present: boolean }; priorPlan: { present: boolean } };
    };
    expect(after.data.managed.present).toBe(false);
    expect(after.data.priorPlan.present).toBe(false);
  });

  it('apply/rollback over a legacy-incompatible row preserve its raw bytes byte-for-byte', async () => {
    // a pre-DSL row that the CURRENT write schema rejects (filter-regex
    // `mode` field is historical): the apply must NOT discard it — it stays
    // verbatim in storage and rollback restores the exact pipeline.
    const parkedRow = { id: 'old', kind: 'filter-regex', pattern: '(a+)+$', mode: 'keep' };
    const sub = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as Record<string, unknown>;
    bucket(REDIS_KEYS.subscriptions).set(SUB_ID, { ...sub, operators: [parkedRow] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(200);
    // the legacy row survived the apply byte-exact (rename op appended after)
    const applied = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(applied.operators[0]).toEqual(parkedRow);
    expect(applied.operators[1]).toMatchObject({ kind: 'rename-template', template: '${region}' });
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([parkedRow]);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('round-2: apply/rollback over the FULL parked-raw seed preserves every raw row and never throws', async () => {
    // Storage oracle seed: [valid, unknown-kind object, malformed object,
    // null, string, number, boolean, runtime-invalid known, M, later
    // duplicate rename]. Decoded output must be safe, nothing parked may
    // execute, apply changes ONLY M, every other raw value/position stays
    // structurally unchanged, rollback restores the exact prior M/position,
    // and no TypeError occurs.
    const M = { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] };
    const laterDup = {
      id: 'rt-legacy-dup',
      kind: 'rename-template',
      disabled: true,
      preset: 'balanced',
    };
    const RAW = [
      { id: 'ok', kind: 'filter-useless', extra: [] },
      { id: 'fut', kind: 'quantum-router', mode: 'warp', keep: 1 },
      { id: 'm', kind: 'filter-regex' },
      null,
      'a-string',
      42,
      true,
      { id: 'unsafe', kind: 'rename-regex', pattern: '(a+)+$', replacement: '', flags: 'g' },
      M,
      laterDup,
    ];
    seedSub({ operators: RAW });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(200);
    const applied = (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] })
      .operators;
    expect(applied).toHaveLength(10);
    // only M changed (index 8); every other raw row is structurally identical
    // at the same position (null/string/number/boolean included)
    for (let i = 0; i < applied.length; i += 1) {
      if (i === 8) {
        expect(applied[i]).toMatchObject({ kind: 'rename-template', template: '${region}' });
        expect((applied[i] as { id?: string }).id).toBe('rt-1');
      } else {
        expect(applied[i]).toEqual(RAW[i]);
      }
    }
    // the rollback restores the exact prior managed row at its exact position
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual(RAW);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('round-3: a malformed rename-shaped row BEFORE a valid M never gets touched — only the aligned M changes and rolls back exactly', async () => {
    // Delivery round-2 finding 1: a malformed raw row whose kind merely
    // resembles rename-template must NOT be treated as the logical managed
    // row. Apply must replace the VALID M (index 1) in place and leave the
    // malformed row byte-identical; rollback restores the exact prior M.
    const M = {
      id: 'rt-1',
      kind: 'rename-template',
      template: '${region}',
      disabled: true,
      futureField: { keep: 1 },
      recognitionRules: [],
    };
    const malformed = { id: 'bad', kind: 'rename-template', template: 123 };
    const RAW = [malformed, M];
    seedSub({ operators: RAW });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(200);
    const applied = (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] })
      .operators;
    expect(applied).toHaveLength(2);
    expect(applied[0]).toEqual(malformed); // untouched byte-exact
    expect(applied[1]).toMatchObject({ kind: 'rename-template', template: '${region}' });
    expect((applied[1] as { id?: string }).id).toBe('rt-1'); // id preserved
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual(RAW);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('round-3: runtime-invalid rename-shaped row with NO valid M stays parked; apply inserts a fresh M; rollback removes it exactly', async () => {
    const runtimeInvalid = {
      id: 'ri',
      kind: 'rename-template',
      template: '${region}',
      sourceAliases: { a: 'x'.repeat(100) }, // oversized → runtime-invalid
    };
    const RAW = [runtimeInvalid, null, 42];
    seedSub({ operators: RAW });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}' },
    });
    expect(res.status).toBe(200);
    const applied = (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] })
      .operators;
    expect(applied).toHaveLength(4);
    expect(applied[0]).toEqual(runtimeInvalid); // untouched
    expect(applied[1]).toBeNull();
    expect(applied[2]).toBe(42);
    expect(applied[3]).toMatchObject({ kind: 'rename-template', template: '${emoji} ${region}' });
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual(RAW);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('round-3: missing M among null/string/number/boolean/unknown objects — insert/rollback preserves every original row exactly and in order', async () => {
    const RAW = [null, 'str', 42, true, { id: 'fut', kind: 'quantum-router', mode: 'warp' }];
    seedSub({ operators: RAW });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(200);
    const applied = (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] })
      .operators;
    expect(applied).toHaveLength(6);
    for (let i = 0; i < RAW.length; i += 1) expect(applied[i]).toEqual(RAW[i]);
    expect(applied[5]).toMatchObject({ kind: 'rename-template', template: '${region}' });
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual(RAW);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('a CAS failure during apply persists NO history (config-first ordering)', async () => {
    // Preflight observes version 99 while the stored generation is 7 — the
    // commit CAS then fails, and NOTHING (config or history) is written.
    const preflightMock = (await import('@/lib/services/configPreflight'))
      .preflightProfileConfig as unknown as ReturnType<typeof vi.fn>;
    preflightMock.mockResolvedValueOnce({ configVersion: 99 });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(412);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
  });

  it('a preflight failure during rollback keeps the history entry (retryable)', async () => {
    // first apply succeeds
    counters.set(REDIS_KEYS.configVersion, 7);
    await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    // force the rollback preflight to fail by bumping the version under it
    const preflightMock = (await import('@/lib/services/configPreflight'))
      .preflightProfileConfig as unknown as ReturnType<typeof vi.fn>;
    preflightMock.mockResolvedValueOnce({ configVersion: 999 });
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(412);
    // history retained → rollback is retryable, no partial state
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
  });

  it('a mid-transaction failure mutates NOTHING — config, version and history stay mutually consistent', async () => {
    // Real Redis Lua scripts are atomic: any runtime error aborts the whole
    // eval without partial effects. The fake models the same all-or-nothing
    // by rejecting the eval outright — config, configVersion and history
    // must remain untouched and consistent.
    counters.set(REDIS_KEYS.configVersion, 7);
    const originalEval = fakeRedis.eval;
    fakeRedis.eval = async () => {
      throw new Error('simulated redis script failure');
    };
    try {
      const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
      expect(res.status).toBe(500);
    } finally {
      fakeRedis.eval = originalEval;
    }
    // NOTHING persisted: no operators, no version bump, no history
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('history HSET failure: the CAS prevalidates TYPES before any write — nothing partial', async () => {
    // The naming-history key holds a non-hash: the Lua's prevalidation must
    // fail the script BEFORE the entity HSET (a naive sequential script would
    // have written the entity first, then raised on HSET — the discriminating
    // assertion is that the entity bytes are EXACTLY unchanged).
    keyTypes.set(REDIS_KEYS.namingHistory, 'string');
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(412);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('rollback HDEL failure: history type is prevalidated — config stays on the new plan', async () => {
    counters.set(REDIS_KEYS.configVersion, 7);
    await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    keyTypes.set(REDIS_KEYS.namingHistory, 'string');
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(412);
    // the new plan is still applied, version untouched, history entry intact
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toMatchObject([{ template: '${region}' }]);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
  });

  it('version INCR-type failure: a non-string config:version fails BEFORE the entity write', async () => {
    // The old script INCRed the version AFTER the entity HSET — an INCR type
    // error then left the entity written. The new script prevalidates the
    // version key type first: the entity must remain untouched.
    keyTypes.set(REDIS_KEYS.configVersion, 'hash');
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(412);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('version overflow / malformed: fails closed with NOTHING written', async () => {
    // Beyond the JS-safe integer range the exact next-version string cannot
    // be computed canonically → the script must refuse before any mutation.
    counters.set(REDIS_KEYS.configVersion, '9007199254740992' as unknown as number);
    const overflowRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(overflowRes.status).toBe(412);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
    // malformed (non-canonical) raw version: same fail-closed behavior
    counters.set(REDIS_KEYS.configVersion, '7abc' as unknown as number);
    const malformedRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(malformedRes.status).toBe(412);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('success set + clear: exact entity, version and history state after each transition', async () => {
    const currentOp = {
      id: 'rt-original',
      kind: 'rename-template',
      template: '${emoji} ${region}',
      tw2cn: true,
      sourceAliases: { 'airport-a': '机场A' },
      recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
    };
    seedSub({ operators: [currentOp] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const applyRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(applyRes.status).toBe(200);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8); // exact computed next version
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as Record<
      string,
      unknown
    >;
    expect(history).toEqual({
      hadManaged: true,
      template: '${emoji} ${region}',
      tw2cn: true,
      sourceAliases: { 'airport-a': '机场A' },
      recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
      opId: 'rt-original',
      position: 0,
      disabled: false,
      rawOp: {
        id: 'rt-original',
        kind: 'rename-template',
        template: '${emoji} ${region}',
        tw2cn: true,
        sourceAliases: { 'airport-a': '机场A' },
        recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
      },
    });
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(9);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators[0],
    ).toMatchObject({ id: 'rt-original', template: '${emoji} ${region}' });
  });

  it('a mutation between the initial read and preflight can NEVER be overwritten', async () => {
    // The planning bracket is captured BEFORE the entity/history reads. A
    // concurrent commit landing right after that capture bumps the version
    // and changes the entity — the gate's generation check must 412 and the
    // concurrent entity bytes must survive untouched (no stale overwrite).
    counters.set(REDIS_KEYS.configVersion, 7);
    const concurrentEntity = {
      id: SUB_ID,
      name: 'airport-a',
      display_name: '机场A',
      enabled: true,
      kind: 'remote',
      url: 'https://upstream.example/sub',
      ttl_ms: 600_000,
      tags: [],
      operators: [{ id: 'concurrent', kind: 'flag-emoji', regions: { HK: '🇭🇰' } }],
    };
    const originalGet = fakeRedis.get;
    let bracketRead = false;
    fakeRedis.get = async (key: string) => {
      if (key === REDIS_KEYS.configVersion && !bracketRead) {
        bracketRead = true;
        // the concurrent writer lands AFTER the bracket capture, BEFORE the
        // preflight reads the version again
        counters.set(REDIS_KEYS.configVersion, 8);
        bucket(REDIS_KEYS.subscriptions).set(SUB_ID, concurrentEntity);
        return 7; // what the bracket captured
      }
      return originalGet(key);
    };
    try {
      const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
      expect(res.status).toBe(412);
    } finally {
      fakeRedis.get = originalGet;
    }
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    expect(bucket(REDIS_KEYS.subscriptions).get(SUB_ID)).toEqual(concurrentEntity);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('CAS version boundary: 2^53−2 commits to 2^53−1; 2^53−1 / 2^53 / int64-max / leading-zero / malformed fail BEFORE any write', async () => {
    const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53−1
    const sub = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as Record<string, unknown>;

    // current 2^53−2 → next = 2^53−1 (the largest canonical version) — byte-exact
    counters.set(REDIS_KEYS.configVersion, MAX_SAFE - 1);
    const okRes = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(okRes.status).toBe(200);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(MAX_SAFE);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators[0],
    ).toMatchObject({ kind: 'rename-template', template: '${region}' });
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);

    // current 2^53−1 → next would be 2^53 (unsafe, Lua scientific notation) → fail
    for (const [label, raw] of [
      ['at max-safe', MAX_SAFE],
      ['2^53', '9007199254740992'],
      ['int64 max', '9223372036854775807'],
      ['leading zero', '007'],
      ['malformed', '12x'],
    ] as const) {
      bucket(REDIS_KEYS.subscriptions).set(SUB_ID, { ...sub });
      bucket(REDIS_KEYS.namingHistory).delete('subscription:' + SUB_ID);
      counters.set(REDIS_KEYS.configVersion, raw as number);
      const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
      expect(res.status).toBe(412);
      // NOTHING written: entity bytes unchanged, version unchanged, no history
      expect(bucket(REDIS_KEYS.subscriptions).get(SUB_ID)).toEqual(sub);
      expect(counters.get(REDIS_KEYS.configVersion)).toBe(raw);
      expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
      void label;
    }
  });

  it('a pre-existing DISABLED rename-template is preserved as history and restored EXACTLY on rollback', async () => {
    const disabledOp = {
      id: 'rt-disabled',
      kind: 'rename-template',
      template: '${region}',
      tw2cn: false,
      sourceAliases: { 'airport-a': '旧别名' },
      recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
      disabled: true,
    };
    const filler = { id: 'f-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } };
    // the disabled rename-template is the FINAL stage (rename must be last)
    seedSub({ operators: [filler, disabledOp] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}' },
    });
    expect(res.status).toBe(200);
    // history: hadManaged TRUE (the disabled row is managed history), with
    // exact id / position / disabled flag
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as {
      hadManaged: boolean;
      opId?: string;
      position?: number;
      disabled?: boolean;
      template?: string;
    };
    expect(history.hadManaged).toBe(true);
    expect(history.opId).toBe('rt-disabled');
    expect(history.position).toBe(1);
    expect(history.disabled).toBe(true);
    expect(history.template).toBe('${region}');
    // rollback restores the disabled row at the EXACT position with id +
    // disabled + policy fields; the new plan is gone
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toHaveLength(2);
    expect(stored.operators[1]).toEqual(disabledOp);
    expect((stored.operators[0] as { id: string }).id).toBe('f-1');
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('legacy disabled rename-template (preset/components + passthrough + opaque fields) round-trips BYTE-EXACT through apply and rollback', async () => {
    // a pre-DSL legacy row: NO template field, preset/components config,
    // passthrough future fields and opaque payloads — the raw stored bytes
    // must survive apply → history → rollback verbatim
    const legacyRow = {
      id: 'legacy-rt',
      kind: 'rename-template',
      preset: 'custom',
      components: { flag: true, region: true, route: true, index: true },
      regionLabel: 'zh',
      rateDisplay: 'omit-1x',
      separator: ' · ',
      disabled: true,
      'future-field': { nested: ['a', 'b'] },
      opaque: 'base64-payload',
    };
    const defaultedRow = { id: 'd-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } };
    const unknownRow = {
      id: 'u-1',
      kind: 'rename-regex',
      regex: '(^| )HK( |$)',
      replacement: '🇭🇰',
      mode: 'keep',
      'x-extra': 42,
    };
    seedSub({ operators: [defaultedRow, legacyRow, unknownRow] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}' },
    });
    expect(res.status).toBe(200);
    // round-3: this legacy row has an INCOMPLETE components table (4 of 8
    // required fields) — it is UNDECODABLE and therefore parked, NOT the
    // logical managed row. The aligned classifier inserts a fresh M instead
    // of touching the parked row; history records hadManaged:false.
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as {
      rawOp: unknown;
      hadManaged: boolean;
      opId?: string;
      position?: number;
      disabled?: boolean;
    };
    expect(history.hadManaged).toBe(false);
    expect(history.rawOp).toBeUndefined();
    // all three original rows survive apply byte-exact in order; fresh M appended
    const applied = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(applied.operators[0]).toEqual(defaultedRow);
    expect(applied.operators[1]).toEqual(legacyRow);
    expect(applied.operators[2]).toEqual(unknownRow);
    expect(applied.operators[3]).toMatchObject({
      kind: 'rename-template',
      template: '${emoji} ${region}',
    });
    // rollback removes ONLY the inserted M and restores the pipeline byte-exact
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toEqual([defaultedRow, legacyRow, unknownRow]);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('DUPLICATE rename-template rows: rollback touches ONLY the exact managed row — the duplicate survives byte-exact', async () => {
    // a legacy pipeline with TWO rename-template rows (the second is a
    // historical duplicate); apply replaces the FIRST (the managed row at
    // its recorded position); rollback must restore exactly that row and
    // leave the duplicate untouched.
    const managedRow = {
      id: 'rt-managed',
      kind: 'rename-template',
      template: '${emoji} ${region}',
      recognitionRules: [],
    };
    const dupRow = {
      id: 'rt-dup',
      kind: 'rename-template',
      template: '${region}',
      recognitionRules: [],
      disabled: true,
      'opaque-field': 'keep-me',
    };
    const filler = { id: 'f-1', kind: 'flag-emoji', regions: { JP: '🇯🇵' } };
    seedSub({ operators: [filler, managedRow, dupRow] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}${?index: · ${index}}' },
    });
    expect(res.status).toBe(200);
    const applied = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    // the duplicate row was untouched by the apply
    expect(applied.operators[2]).toEqual(dupRow);
    expect(applied.operators[1]).toMatchObject({
      kind: 'rename-template',
      template: '${emoji} ${region}${?index: · ${index}}',
    });
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toEqual([filler, managedRow, dupRow]);
  });

  it('workspace priorPlan is PROJECTED — rawOp/opId/position/rules never leave storage', async () => {
    seedSub({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [{ pattern: '中转', field: 'route', value: '中转' }],
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    const res = await call(GET, 'subscription', SUB_ID);
    const body = (await res.json()) as {
      data: {
        priorPlan: Record<string, unknown>;
        managed: Record<string, unknown>;
      };
    };
    const serialized = JSON.stringify(body.data);
    // internal storage data must never leave ANYWHERE: rawOp, opId, position
    expect(serialized).not.toContain('rawOp');
    expect(serialized).not.toContain('opId');
    expect(serialized).not.toContain('"position"');
    // the PRIOR PLAN (history) is projected explicitly — no recognition-rule
    // patterns, no internal fields
    const priorPlan = JSON.stringify(body.data.priorPlan);
    expect(priorPlan).not.toContain('"pattern"');
    expect(priorPlan).not.toContain('recognitionRules');
    expect(priorPlan).not.toContain('rawOp');
    expect(priorPlan).not.toContain('opId');
    // the projected prior plan keeps the rollback-relevant surface
    expect(body.data.priorPlan.present).toBe(true);
    expect(body.data.priorPlan.template).toBe('${emoji} ${region}');
  });

  it('UI apply and UI rollback EACH create exactly one sanitized durable naming-source audit event', async () => {
    seedSub({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const applyRes = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(applyRes.status).toBe(200);
    const events = bucket(REDIS_KEYS.audit.events);
    expect(events.size).toBe(1);
    const byId = bucket(REDIS_KEYS.audit.byId);
    const applyEvent = JSON.parse([...byId.values()][0] as string) as {
      op: string;
      undoable: boolean;
      target: { kind: string; name: string };
      actor: string;
      profileId: string;
      after: { templateSummary: { placeholderCount: number; length: number } };
    };
    expect(applyEvent.op).toBe('naming.apply');
    expect(applyEvent.undoable).toBe(false);
    expect(applyEvent.target).toMatchObject({ kind: 'naming-source', name: '机场A' });
    expect(applyEvent.actor).toBe('admin'); // no X-Source header → resolveActor default
    // pass-2: the UI route resolves and binds the authorized profile, and the
    // audit carries the structural summary, never the raw template
    expect(applyEvent.profileId).toBe(PROFILE_ID);
    expect(applyEvent.after.templateSummary.placeholderCount).toBe(1);
    expect(JSON.stringify(applyEvent.after)).not.toContain('${');
    const rollbackRes = await call(POST, 'subscription', SUB_ID, { rollback: true });
    expect(rollbackRes.status).toBe(200);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(2);
    const rollbackOp = [...bucket(REDIS_KEYS.audit.byId).values()]
      .map((v) => JSON.parse(v as string) as { op: string })
      .find((e) => e.op === 'naming.rollback');
    expect(rollbackOp).toBeTruthy();
  });

  it('CURRENT-WRITE projection validation (finding 3): duplicate ids / two enabled templates / enabled post-template rename ops rejected with zero writes', async () => {
    // duplicate ids across the candidate
    const dupId = { id: 'x-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } };
    seedSub({ operators: [dupId, { ...dupId, kind: 'flag-emoji', regions: { JP: '🇯🇵' } }] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const dupRes = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(dupRes.status).toBe(400);
    // the REJECTED candidate wrote nothing
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    // TWO rename-templates: the storage decoder auto-parks the duplicate
    // (it can never execute) — the executable projection has exactly ONE
    // managed template, the raw duplicate row survives byte-exact, and the
    // new candidate is validated against that projection
    const rt2Raw = {
      id: 'rt-2',
      kind: 'rename-template',
      template: '${emoji} ${region}',
      recognitionRules: [],
      disabled: false,
    };
    seedSub({
      operators: [
        { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] },
        rt2Raw,
      ],
    });
    const twoRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}' },
    });
    expect(twoRes.status).toBe(200);
    const twoStored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(twoStored.operators[1]).toEqual(rt2Raw); // raw duplicate untouched
    const { StoredOperatorListSchema } = await import('@/schemas/operator');
    const twoDecoded = StoredOperatorListSchema.parse(twoStored.operators) as Array<{
      kind?: string;
      disabled?: boolean;
      compatibility_issue?: string;
    }>;
    const enabledTemplates = twoDecoded.filter(
      (o) => o.kind === 'rename-template' && o.disabled !== true,
    );
    expect(enabledTemplates).toHaveLength(1); // exactly one MANAGED template
    // an ENABLED rename-regex AFTER the managed template
    seedSub({
      operators: [
        { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] },
        {
          id: 'rr-1',
          kind: 'rename-regex',
          pattern: '(^| )HK( |$)',
          replacement: '🇭🇰',
          flags: 'g',
        },
      ],
    });
    const postRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}' },
    });
    expect(postRes.status).toBe(400);
    // the REJECTED candidate wrote nothing (version/history/audit unchanged
    // from the successful two-template case above)
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(1);
  });

  it('position=999 apply normalizes to the ACTUAL insertion index + collision-free opId; rollback is exact (finding 4)', async () => {
    seedSub({ operators: [{ id: 'f-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } }] });
    counters.set(REDIS_KEYS.configVersion, 7);
    // position 999 on a 1-row pipeline clamps to index 1 (end) — the SERVICE
    // path (the assistant carries position; the route's ApplyBody strips it)
    const { applyNamingPlan, rollbackNamingPlan } =
      await import('@/lib/services/namingApplyService');
    const applied = await applyNamingPlan(
      'subscription',
      SUB_ID,
      { template: '${region}' },
      {
        position: 999,
        audit: { actor: 'test', profileId: PROFILE_ID },
      },
    );
    expect(applied.mode).toBe('added');
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as {
      hadManaged: boolean;
      position?: number;
      opId?: string;
    };
    // NORMALIZED actual index (1, the clamped end), NOT 999
    expect(history.position).toBe(1);
    expect(history.opId).toBeTruthy();
    // round-2: the apply RESULT no longer exposes the durable audit id — the
    // audit still exists exactly once in the durable audit log
    expect((applied as unknown as { auditId?: unknown }).auditId).toBeUndefined();
    const auditEvents = bucket(REDIS_KEYS.audit.events);
    const auditById = bucket(REDIS_KEYS.audit.byId);
    const namingAudits = [...(auditEvents?.keys() ?? [])].filter(
      (k) => auditById?.get(k) && JSON.stringify(auditById.get(k)).includes('naming.apply'),
    );
    expect(namingAudits).toHaveLength(1);
    const rollback = await rollbackNamingPlan('subscription', SUB_ID, {
      audit: { actor: 'test', profileId: PROFILE_ID },
    });
    expect(rollback.mode).toBe('removed');
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toEqual([{ id: 'f-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } }]);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('apply/history/rollback stay byte-exact and observe zero inherited Array.toJSON hooks', async () => {
    const rawOperators = [
      { id: 'f-1', kind: 'filter-useless', extra: ['keep'] },
      {
        id: 'rt-1',
        kind: 'rename-template',
        template: '${region}',
        recognitionRules: [],
        futureField: { keep: true },
      },
    ];
    seedSub({ operators: rawOperators as never });
    counters.set(REDIS_KEYS.configVersion, 7);
    const { applyNamingPlan, rollbackNamingPlan } =
      await import('@/lib/services/namingApplyService');
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let fired = 0;
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        get() {
          fired += 1;
          throw new Error('inherited Array.toJSON getter should stay unobserved');
        },
      });
      await applyNamingPlan(
        'subscription',
        SUB_ID,
        { template: '${emoji} ${region}' },
        { audit: { actor: 'test', profileId: PROFILE_ID } },
      );
      await rollbackNamingPlan('subscription', SUB_ID, {
        audit: { actor: 'test', profileId: PROFILE_ID },
      });
    } finally {
      if (prior === undefined) Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', prior);
    }

    expect(fired).toBe(0);
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual(rawOperators);
    expect(bucket(REDIS_KEYS.namingHistory).has(`subscription:${SUB_ID}`)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(2);
  });

  it('same-position DIFFERENT-id rollback fails closed and preserves every row (finding 4)', async () => {
    seedSub({ operators: [] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const { applyNamingPlan, rollbackNamingPlan } =
      await import('@/lib/services/namingApplyService');
    await applyNamingPlan(
      'subscription',
      SUB_ID,
      { template: '${region}' },
      {
        audit: { actor: 'test', profileId: PROFILE_ID },
      },
    );
    // the user edits the pipeline: the applied row's id changes (same position)
    const sub = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
      ...sub,
      operators: [{ ...(sub.operators[0] as object), id: 'someone-else' }],
    });
    await expect(
      rollbackNamingPlan('subscription', SUB_ID, {
        audit: { actor: 'test', profileId: PROFILE_ID },
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
    // every row preserved
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators[0],
    ).toMatchObject({ id: 'someone-else' });
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
    // the failed rollback added NO audit event (the apply's single one remains)
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(1);
  });

  it('generated managed-row id NEVER collides with an existing "naming-plan" row (finding 4)', async () => {
    seedSub({ operators: [{ id: 'naming-plan', kind: 'flag-emoji', regions: { HK: '🇭🇰' } }] });
    counters.set(REDIS_KEYS.configVersion, 7);
    const { applyNamingPlan, rollbackNamingPlan } =
      await import('@/lib/services/namingApplyService');
    await applyNamingPlan(
      'subscription',
      SUB_ID,
      { template: '${region}' },
      {
        audit: { actor: 'test', profileId: PROFILE_ID },
      },
    );
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as {
      operators: Array<{ id: string; kind: string }>;
    };
    const ids = stored.operators.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    expect(ids.filter((id) => id.startsWith('naming-plan-')).length).toBe(1);
    // the collision-free id makes rollback exact
    const rollback = await rollbackNamingPlan('subscription', SUB_ID, {
      audit: { actor: 'test', profileId: PROFILE_ID },
    });
    expect(rollback.mode).toBe('removed');
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([{ id: 'naming-plan', kind: 'flag-emoji', regions: { HK: '🇭🇰' } }]);
  });

  it('dirty template + dirty actor never appear in audit or priorPlan JSON; managed (editable) template stays intact', async () => {
    const dirtyTemplate = '${emoji} ${region} https://evil.example/sub?token=abc123';
    seedSub({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: dirtyTemplate,
          recognitionRules: [],
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, { apply: { template: '${region}' } });
    expect(res.status).toBe(200);
    // the AUDIT payload never carries the dirty template
    const auditSerialized = JSON.stringify([...bucket(REDIS_KEYS.audit.byId).values()]);
    expect(auditSerialized).not.toContain('evil.example');
    expect(auditSerialized).not.toContain('token=abc123');
    // the workspace priorPlan (display-only history) never carries it either
    const getRes = await call(GET, 'subscription', SUB_ID);
    const body = (await getRes.json()) as {
      data: { priorPlan: { template?: string }; managed: { template: string } };
    };
    expect(body.data.priorPlan.template).not.toContain('evil.example');
    expect(body.data.priorPlan.template).not.toContain('token=abc123');
    // bounded semantics survive
    expect(body.data.priorPlan.template).toContain('${emoji} ${region}');
    // the EDITABLE managed template round-trips intact (the editor needs it)
    expect(body.data.managed.template).toBe('${region}');
  });

  it('ApplyBody enforces the current write limits — oversized aliases/rules rejected without writes', async () => {
    counters.set(REDIS_KEYS.configVersion, 7);
    const bigAliases: Record<string, string> = {};
    for (let i = 0; i < 65; i += 1) bigAliases[`s-${i}`] = `别名${i}`;
    const aliasRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}', sourceAliases: bigAliases },
    });
    expect(aliasRes.status).toBe(422);
    const bigRules = Array.from({ length: 33 }, (_, i) => ({
      pattern: `p${i}`,
      field: 'route' as const,
      value: `v${i}`,
    }));
    const rulesRes = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}', recognitionRules: bigRules },
    });
    expect(rulesRes.status).toBe(422);
    // nothing was written by either rejection
    expect(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    ).toEqual([]);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });
});

describe('pass-8 blocker 6: workspace POST rides the gate-captured version (ABA closure)', () => {
  it('any config-version movement between gate and commit fails closed with zero writes/audit — incl. an A→B→A rebind', async () => {
    seedSub();
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'subscription', id: SUB_ID },
      updated_at: 1,
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    // A→B→A rebind BETWEEN the gate capture and the commit: the version
    // hook fires on the GATE's config read (captures 7), then performs the
    // ABA rebind + two bumps — the POST must fail closed on the version,
    // never commit under the ABA state
    const originalGet = fakeRedis.get;
    let gateRead = false;
    fakeRedis.get = async (key: string) => {
      if (key === REDIS_KEYS.configVersion && !gateRead) {
        gateRead = true;
        bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
          id: PROFILE_ID,
          name: 'default',
          source: { type: 'none' },
          updated_at: 2,
        });
        bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
          id: PROFILE_ID,
          name: 'default',
          source: { type: 'subscription', id: SUB_ID },
          updated_at: 3,
        });
        counters.set(REDIS_KEYS.configVersion, 9);
        return 7;
      }
      return originalGet(key);
    };
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    let res: Response;
    try {
      res = await call(POST, 'subscription', SUB_ID, {
        apply: { template: '${region}' },
      });
    } finally {
      fakeRedis.get = originalGet;
    }
    expect(res.status).toBe(412);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(9);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('an authorized POST with an unchanged version applies exactly once with exactly one audit', async () => {
    seedSub();
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'subscription', id: SUB_ID },
      updated_at: 1,
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(res.status).toBe(200);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(8);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(1);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
  });
});

describe('pass-9 blocker 1: hostile disabled-member aliases across workspace consumers', () => {
  const DISABLED_SUB = '33333333-3333-4333-8333-333333333333';

  function seedCollectionBoundProfileWithDisabledMember(): void {
    seedSub();
    bucket(REDIS_KEYS.subscriptions).set(DISABLED_SUB, {
      id: DISABLED_SUB,
      name: 'airport-b',
      display_name: '停用机场',
      enabled: false,
      kind: 'remote',
      url: 'https://b.example/sub',
      ttl_ms: 600_000,
      tags: [],
      operators: [],
    });
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'collection', id: COL_ID },
      updated_at: 1,
    });
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合一号',
      slug: 'agg-1',
      enabled: true,
      type: 'select',
      subscription_ids: [SUB_ID, DISABLED_SUB],
      subscription_tags: [],
      operators: [
        {
          id: 'rt-col',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          sourceAliases: { 'airport-a': '在线别名', 'airport-b': '停用别名' },
          recognitionRules: [],
        },
      ],
    });
  }

  it('a disabled member is NOT in the authoritative alias set — its stored alias and src- handle never project', async () => {
    seedCollectionBoundProfileWithDisabledMember();
    const res = await call(GET, 'collection', COL_ID);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());
    // the disabled member's stable key NEVER appears (managed/prior/health/
    // diagnostics all project through the ENABLED authoritative set)
    expect(serialized).not.toContain('airport-b');
    expect(serialized).not.toContain(srcHandle('airport-b'));
    // the enabled member's handle projects normally
    expect(serialized).toContain(srcHandle('airport-a'));
  });

  it('a disabled member src- handle cannot be applied — bounded error, zero writes/audit', async () => {
    seedCollectionBoundProfileWithDisabledMember();
    counters.set(REDIS_KEYS.configVersion, 7);
    const before = JSON.stringify(bucket(REDIS_KEYS.collections).get(COL_ID));
    const res = await call(POST, 'collection', COL_ID, {
      apply: {
        template: '${region}',
        sourceAliases: { [srcHandle('airport-b')]: '别名' },
      },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('来源别名');
    expect(JSON.stringify(bucket(REDIS_KEYS.collections).get(COL_ID))).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    // the ENABLED member handle applies and persists under the STABLE key
    const ok = await call(POST, 'collection', COL_ID, {
      apply: {
        template: '${region}',
        sourceAliases: { [srcHandle('airport-a')]: '在线别名' },
      },
    });
    expect(ok.status).toBe(200);
    const stored = bucket(REDIS_KEYS.collections).get(COL_ID) as {
      operators: Array<{ sourceAliases?: Record<string, string> }>;
    };
    const op = stored.operators.find(
      (o) => (o as { kind?: string }).kind === 'rename-template',
    ) as { sourceAliases?: Record<string, string> };
    expect(op.sourceAliases).toEqual({ 'airport-a': '在线别名' });
  });

  it('pass-9 blocker 5: a target deleted between authorization and the read fails the bounded NAMING_SCOPE_ERROR — no raw UUID', async () => {
    seedSub();
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'subscription', id: SUB_ID },
      updated_at: 1,
    });
    // delete the target AFTER the visible-set authorization — the route's
    // second read must collapse to the bounded error, never echo the UUID
    bucket(REDIS_KEYS.subscriptions).delete(SUB_ID);
    const res = await call(GET, 'subscription', SUB_ID);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain('来源范围');
    expect(text).not.toContain(SUB_ID);
    const post = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(post.status).toBe(404);
    expect(await post.text()).not.toContain(SUB_ID);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('pass-9 blocker 5: delete BETWEEN the authorization read and the SECOND read fails the same bounded error', async () => {
    seedSub();
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'subscription', id: SUB_ID },
      updated_at: 1,
    });
    const originalHget = fakeRedis.hget;
    let subReads = 0;
    fakeRedis.hget = async (key: string, field: string) => {
      if (key === REDIS_KEYS.subscriptions && field === SUB_ID) {
        subReads++;
        if (subReads === 2) bucket(key).delete(field);
      }
      return originalHget(key, field);
    };
    try {
      const res = await call(GET, 'subscription', SUB_ID);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('来源范围');
      expect(text).not.toContain(SUB_ID);
      expect(subReads).toBeGreaterThanOrEqual(2);
    } finally {
      fakeRedis.hget = originalHget;
    }
  });

  it('GET re-validates the current profile after diagnostics and rejects an auth-to-snapshot rebind', async () => {
    const originalHget = fakeRedis.hget;
    let profileReads = 0;
    fakeRedis.hget = async (key: string, field: string) => {
      if (key === REDIS_KEYS.profiles && field === PROFILE_ID) {
        profileReads += 1;
        if (profileReads === 1) {
          bucket(key).set(field, {
            id: PROFILE_ID,
            name: 'default',
            source: { type: 'none' },
            updated_at: 2,
          });
          counters.set(REDIS_KEYS.configVersion, 1);
        }
      }
      return originalHget(key, field);
    };
    try {
      const res = await call(GET, 'subscription', SUB_ID);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('来源范围');
      expect(text).not.toContain(SUB_ID);
      expect(profileReads).toBeGreaterThanOrEqual(1);
    } finally {
      fakeRedis.hget = originalHget;
    }
  });

  it('read-only POST preview rejects the same auth-to-snapshot profile rebind', async () => {
    const originalHget = fakeRedis.hget;
    let profileReads = 0;
    fakeRedis.hget = async (key: string, field: string) => {
      if (key === REDIS_KEYS.profiles && field === PROFILE_ID) {
        profileReads += 1;
        if (profileReads === 1) {
          bucket(key).set(field, {
            id: PROFILE_ID,
            name: 'default',
            source: { type: 'none' },
            updated_at: 2,
          });
          counters.set(REDIS_KEYS.configVersion, 1);
        }
      }
      return originalHget(key, field);
    };
    try {
      const res = await call(POST, 'subscription', SUB_ID, {
        preview: {
          template: '${region} ${index}',
          sourceAliases: {},
          recognitionRules: [],
        },
      });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('来源范围');
      expect(text).not.toContain(SUB_ID);
      expect(profileReads).toBeGreaterThanOrEqual(1);
    } finally {
      fakeRedis.hget = originalHget;
    }
  });
});

describe('pass-11: workspace preview mode + first-use / re-enable apply-through', () => {
  const PREVIEW_PLAN = {
    preview: {
      template: '${emoji} ${region}${?index: · ${index}}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    },
  };

  it('preview with absent managed returns the deterministic naming-plan candidate (index 0, added) + zero-write preview', async () => {
    const before = JSON.stringify([...stores.entries()]);
    const res = await call(POST, 'subscription', SUB_ID, PREVIEW_PLAN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        after: { count: number; names: string[]; truncated: boolean };
        issues: unknown[];
        candidate: { id: string; index: number; mode: string };
      };
    };
    expect(body.data.candidate).toEqual({ id: 'naming-plan', index: 0, mode: 'added' });
    expect(body.data.after.count).toBe(3);
    // preview names are credential-free (no server/port seeds)
    expect(JSON.stringify(body.data)).not.toContain('a.example.com');
    expect(JSON.stringify(body.data)).not.toContain(':443');
    // strictly read-only: NO store write, NO counter bump
    expect(JSON.stringify([...stores.entries()])).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
  });

  it('preview with an ordinary row already named naming-plan allocates naming-plan-2 (same builder as apply)', async () => {
    seedSub({ operators: [{ id: 'naming-plan', kind: 'flag-emoji', regions: { HK: '🇭🇰' } }] });
    const res = await call(POST, 'subscription', SUB_ID, PREVIEW_PLAN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { candidate: { id: string; index: number; mode: string } };
    };
    expect(body.data.candidate).toEqual({ id: 'naming-plan-2', index: 1, mode: 'added' });
  });

  it('preview preserves an existing disabled managed row id/index and reports replaced', async () => {
    seedSub({
      operators: [
        {
          id: 'legacy-plan',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [],
          disabled: true,
        },
      ],
    });
    const res = await call(POST, 'subscription', SUB_ID, PREVIEW_PLAN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { candidate: { id: string; index: number; mode: string } };
    };
    expect(body.data.candidate).toEqual({ id: 'legacy-plan', index: 0, mode: 'replaced' });
  });

  it('SOURCE ABSENT apply-through: the unchanged recommended policy applies → one managed row, one history, one audit', async () => {
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}' },
    });
    expect(res.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    const managedRows = stored.operators.filter(
      (op) => (op as { kind?: string }).kind === 'rename-template',
    );
    expect(managedRows).toHaveLength(1);
    expect(managedRows[0]).toMatchObject({
      id: 'naming-plan',
      kind: 'rename-template',
      template: '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}',
    });
    expect((managedRows[0] as { disabled?: boolean }).disabled).toBeUndefined();
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
    const auditEvents = bucket(REDIS_KEYS.audit.events);
    const auditById = bucket(REDIS_KEYS.audit.byId);
    const namingAudits = [...(auditEvents?.keys() ?? [])].filter(
      (k) => auditById?.get(k) && JSON.stringify(auditById.get(k)).includes('naming.apply'),
    );
    expect(namingAudits).toHaveLength(1);
  });

  it('SOURCE DISABLED apply-through: the unchanged stored policy applies → enabled row keeps its id, one history, one audit', async () => {
    seedSub({
      operators: [
        {
          id: 'legacy-plan',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [],
          disabled: true,
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'subscription', SUB_ID, {
      apply: { template: '${region}' },
    });
    expect(res.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toHaveLength(1);
    expect(stored.operators[0]).toMatchObject({ id: 'legacy-plan', template: '${region}' });
    expect((stored.operators[0] as { disabled?: boolean }).disabled).toBeUndefined();
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(true);
    const auditEvents = bucket(REDIS_KEYS.audit.events);
    const auditById = bucket(REDIS_KEYS.audit.byId);
    const namingAudits = [...(auditEvents?.keys() ?? [])].filter(
      (k) => auditById?.get(k) && JSON.stringify(auditById.get(k)).includes('naming.apply'),
    );
    expect(namingAudits).toHaveLength(1);
  });

  it('COLLECTION ABSENT apply-through: one managed row, one history, one audit', async () => {
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'collection', id: COL_ID },
      updated_at: 1,
    });
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合一号',
      slug: 'agg-1',
      enabled: true,
      type: 'select',
      subscription_ids: [],
      subscription_tags: [],
      operators: [],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'collection', COL_ID, {
      apply: { template: '${emoji} ${region}${?index: · ${index}}' },
    });
    expect(res.status).toBe(200);
    const stored = bucket(REDIS_KEYS.collections).get(COL_ID) as { operators: unknown[] };
    expect(stored.operators).toHaveLength(1);
    expect(stored.operators[0]).toMatchObject({ id: 'naming-plan' });
    expect(bucket(REDIS_KEYS.namingHistory).has('collection:' + COL_ID)).toBe(true);
    const auditEvents = bucket(REDIS_KEYS.audit.events);
    const auditById = bucket(REDIS_KEYS.audit.byId);
    const namingAudits = [...(auditEvents?.keys() ?? [])].filter(
      (k) => auditById?.get(k) && JSON.stringify(auditById.get(k)).includes('naming.apply'),
    );
    expect(namingAudits).toHaveLength(1);
  });

  it('COLLECTION DISABLED apply-through: enabled in place, one history, one audit', async () => {
    bucket(REDIS_KEYS.profiles).set(PROFILE_ID, {
      id: PROFILE_ID,
      name: 'default',
      source: { type: 'collection', id: COL_ID },
      updated_at: 1,
    });
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合一号',
      slug: 'agg-1',
      enabled: true,
      type: 'select',
      subscription_ids: [],
      subscription_tags: [],
      operators: [
        {
          id: 'col-plan',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [],
          disabled: true,
        },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const res = await call(POST, 'collection', COL_ID, {
      apply: { template: '${region}' },
    });
    expect(res.status).toBe(200);
    const stored = bucket(REDIS_KEYS.collections).get(COL_ID) as { operators: unknown[] };
    expect(stored.operators).toHaveLength(1);
    expect(stored.operators[0]).toMatchObject({ id: 'col-plan', template: '${region}' });
    expect((stored.operators[0] as { disabled?: boolean }).disabled).toBeUndefined();
    expect(bucket(REDIS_KEYS.namingHistory).has('collection:' + COL_ID)).toBe(true);
    const auditEvents = bucket(REDIS_KEYS.audit.events);
    const auditById = bucket(REDIS_KEYS.audit.byId);
    const namingAudits = [...(auditEvents?.keys() ?? [])].filter(
      (k) => auditById?.get(k) && JSON.stringify(auditById.get(k)).includes('naming.apply'),
    );
    expect(namingAudits).toHaveLength(1);
  });
});

describe('round-9: naming apply under Object.prototype.compatibility_issue pollution', () => {
  /** Temporarily define an Object.prototype property, restoring the exact
   * prior descriptor even if an assertion throws. */
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

  it('inherited non-enumerable compatibility_issue DATA: apply replaces managed row in place, no second row inserted', async () => {
    seedSub({
      operators: [
        { id: 'legacy-plan', kind: 'rename-template', template: '${region}', recognitionRules: [] },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 9);

    const result = await withProto(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      async () => {
        const res = await call(POST, 'subscription', SUB_ID, {
          apply: { template: '${emoji} ${region}' },
        });
        expect(res.status).toBe(200);
        const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
        // Exactly one rename-template row — replaced in place, not duplicated
        const managedRows = stored.operators.filter(
          (op) => (op as { kind?: string }).kind === 'rename-template',
        );
        expect(managedRows).toHaveLength(1);
        // Id preserved (replace in place)
        expect((managedRows[0] as { id?: string }).id).toBe('legacy-plan');
        expect((managedRows[0] as { template?: string }).template).toBe('${emoji} ${region}');
        return stored;
      },
    );
    expect(result.operators).toHaveLength(1);
  });

  it('inherited compatibility_issue GETTER: zero fires during apply', async () => {
    seedSub({
      operators: [
        { id: 'legacy-plan', kind: 'rename-template', template: '${region}', recognitionRules: [] },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 10);

    let fired = 0;
    await withProto(
      'compatibility_issue',
      {
        get() {
          fired++;
          return 'polluted';
        },
        enumerable: false,
        configurable: true,
      },
      async () => {
        const res = await call(POST, 'subscription', SUB_ID, {
          apply: { template: '${emoji}' },
        });
        expect(res.status).toBe(200);
      },
    );
    expect(fired).toBe(0);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] };
    expect(stored.operators).toHaveLength(1);
  });

  it('failure path under pollution performs zero writes', async () => {
    seedSub({
      operators: [
        { id: 'legacy-plan', kind: 'rename-template', template: '${region}', recognitionRules: [] },
        { id: 'dup', kind: 'rename-template', template: '${emoji}', recognitionRules: [] },
      ],
    });
    counters.set(REDIS_KEYS.configVersion, 11);

    const operatorsBefore = JSON.stringify(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    );

    await withProto(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      async () => {
        // Apply with an invalid template should fail
        const res = await call(POST, 'subscription', SUB_ID, {
          apply: { template: '' },
        });
        // Should not succeed
        expect(res.status).toBeGreaterThanOrEqual(400);
      },
    );

    // Operators unchanged after failed apply
    const operatorsAfter = JSON.stringify(
      (bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as { operators: unknown[] }).operators,
    );
    expect(operatorsAfter).toBe(operatorsBefore);
  });
});
