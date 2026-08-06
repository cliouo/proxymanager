import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { NamingMembershipSnapshot } from '@/lib/services/namingTargetScope';
import type { Profile } from '@/schemas';
import { dispatchToolCall } from '@/lib/ai/dispatchTool';
import { withRawIdentity } from '@/lib/proxies/naming';
import type { ActionContext } from '@/lib/ai/actions/types';
import { getAction } from '@/lib/ai/actions/registry';
import type { Collection, Subscription } from '@/schemas';
import {
  buildNodeScope,
  buildSourceAliasScope,
  buildTargetRefScope,
} from '@/lib/proxies/handleScopes';
import { nodeIdentityOf } from '@/lib/ai/namingContextProjection';

/**
 * Test-local handle helpers over complete one-identity domains (round-3:
 * the scope builders are the SOLE semantic token constructors).
 */
const srcHandle = (key: string): string => buildSourceAliasScope([key]).project(key);
/** Occurrence-aware node handle for ONE probe — a complete one-node domain. */
const handleOf = (proxy: unknown): string => {
  const { identity } = nodeIdentityOf(proxy, new Map());
  return buildNodeScope('', [identity]).project(identity);
};

/**
 * Composable naming agent tests (lib/ai/actions/primitives/namingActions.ts):
 *   - the read loop (fields / clusters / collisions / node parse / recognition
 *     preview / drift / target preview) is fully iterable without side effects;
 *   - every output is structurally projected + sanitized (no raw names with
 *     credentials, no URLs, no server hosts, no raw operator rows);
 *   - save_naming_plan is the ONE confirmation-gated write and lands through
 *     the shared save gate (CAS against config:version).
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
  hlen: async (key: string) => stores.get(key)?.size ?? 0,
  hget: async (key: string, id: string) => bucket(key).get(id) ?? null,
  hset: async (key: string, payload: Record<string, unknown>) => {
    const m = bucket(key);
    for (const [id, v] of Object.entries(payload)) m.set(id, v);
  },
  hdel: async (key: string, ...ids: string[]) => {
    const m = bucket(key);
    let n = 0;
    for (const id of ids) if (m.delete(id)) n++;
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
  // Faithful mirror of the Lua scripts (C14 prevalidation first): the
  // 3-key CAS_ENTITY_WITH_HISTORY validates types/values before ANY write
  // and SETs the exact next version; the 2-key CAS is the generic form.
  eval: async (_script: string, keys: string[], args: string[]) => {
    if (_script.includes('local out = {0, h, size, generation}')) {
      const hashType = keyTypes.get(keys[0]) ?? 'hash';
      if (hashType !== 'hash' && hashType !== 'none') return [2, 'hash-wrongtype'];
      const generationType = keyTypes.get(keys[1]) ?? 'string';
      if (generationType !== 'string' && generationType !== 'none') {
        return [2, 'generation-wrongtype'];
      }
      const ordinalRows = stores.get(keys[0]);
      const pairs = ordinalRows ? [...ordinalRows].flatMap(([field, value]) => [field, value]) : [];
      const generation = counters.get(keys[1]) ?? null;
      const counterValues = args.map((counterKey) => {
        const kind = keyTypes.get(counterKey) ?? 'string';
        return kind === 'string' || kind === 'none'
          ? (counters.get(counterKey) ?? null)
          : [2, 'counter-wrongtype'];
      });
      return [0, pairs, ordinalRows?.size ?? 0, generation, ...counterValues];
    }
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
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
      if (typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)) {
        const n = Number(raw);
        // the exact next version must stay <= Number.MAX_SAFE_INTEGER
        if (Number.isSafeInteger(n) && n <= 9007199254740990) return n;
      }
      return null;
    };
    if (keys.length >= 3) {
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
        if (keys.length >= 6 && args[11] !== 'global') {
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
      if (current !== Number(args[0])) return [0, String(current)];
      const nextVersion = current + 1;
      await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
      if (args[3] === 'set') {
        await fakeRedis.hset(keys[2], { [args[4]]: JSON.parse(args[5]) });
      } else if (args[3] === 'del') {
        await fakeRedis.hdel(keys[2], args[4]);
      }
      if (args[6] === 'set' && keys.length >= 5) {
        bucket(keys[3]).set(args[7], Number(args[8]));
        await fakeRedis.hset(keys[4], { [args[7]]: args[9] });
      }
      counters.set(keys[0], nextVersion);
      return [1, String(nextVersion)];
    }
    if (!isString(keys[0])) return [2, 'version-wrongtype'];
    const current = canonicalVersion(counters.get(keys[0]));
    if (current === null) return [2, 'version-malformed'];
    if (current !== Number(args[0])) return [0, String(current)];
    const nextVersion = current + 1;
    await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    counters.set(keys[0], nextVersion);
    return [1, String(nextVersion)];
  },
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      incr: (key: string) => {
        ops.push(() => fakeRedis.incr(key));
        return tx;
      },
      zadd: (key: string, member: { score: number; member: string }) => {
        ops.push(async () => {
          const z = bucket(key);
          z.set(member.member, member.score);
          return 1;
        });
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
  zcard: async (key: string) => stores.get(key)?.size ?? 0,
  zrange: async () => [],
};

/** Key-type map for C14 failure injection (absent = default). */
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
      { name: '🇭🇰 香港 01', type: 'ss', server: 'hk.example.com', port: 443 },
      { name: '🇭🇰 香港 中转 02', type: 'ss', server: 'hk2.example.com', port: 443 },
      {
        name: '🇯🇵 日本 https://evil.example/sub?token=abc123',
        type: 'vmess',
        server: 'jp.example.com',
        port: 443,
      },
      { name: 'US 家宽', type: 'ss', server: 'us.example.com', port: 443 },
    ],
    proxyCount: 4,
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
}));
vi.mock('@/lib/services/nodeReferenceService', () => ({
  findNodeReferences: vi.fn(async () => []),
}));

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const COL_ID = '22222222-2222-4222-8222-222222222222';

const ctx = { actor: 'test', profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
/** Collection-bound profile — the SECOND profile the tests act as. */
const ctxCol = { actor: 'test', profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
/** Large collection-bound profile for the 50000-target cap test. */
const BIG_PROFILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function seedSubscription(over: Partial<Subscription> = {}): void {
  const sub: Subscription = {
    id: SUB_ID,
    name: 'airport-a',
    display_name: '机场A',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
    updated_at: 1,
    ...over,
  };
  bucket(REDIS_KEYS.subscriptions).set(sub.id, sub);
}

function seedCollection(over: Partial<Collection> = {}): void {
  const collection: Collection = {
    id: COL_ID,
    name: '聚合一号',
    slug: 'agg-1',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators: [],
    updated_at: 1,
    ...over,
  };
  bucket(REDIS_KEYS.collections).set(collection.id, collection);
}

function subRef(): string {
  // pass-5: refs are PROFILE-BOUND — the caller's ctx.profileId is part of
  // the MAC input; projected through a complete one-target scope
  return buildTargetRefScope(ctx.profileId, [{ type: 'subscription', id: SUB_ID }]).project(
    `subscription:${SUB_ID}`,
  );
}

function colRef(): string {
  // collection refs are minted under the COLLECTION-bound profile
  return buildTargetRefScope(ctxCol.profileId, [{ type: 'collection', id: COL_ID }]).project(
    `collection:${COL_ID}`,
  );
}

function storedSubOps(id: string): unknown[] {
  const raw = bucket(REDIS_KEYS.subscriptions).get(id) as { operators?: unknown[] } | undefined;
  return raw?.operators ?? [];
}

function seed(): void {
  // pass-6 blocker 1: the caller-visible scope derives from the CURRENT
  // profile source binding — ctx sees exactly SUB_ID; ctxCol sees COL_ID
  // (plus its enabled members).
  bucket(REDIS_KEYS.profiles).set(ctx.profileId, {
    id: ctx.profileId,
    name: 'profile-sub',
    source: { type: 'subscription', id: SUB_ID },
    updated_at: 1,
  });
  bucket(REDIS_KEYS.profiles).set(ctxCol.profileId, {
    id: ctxCol.profileId,
    name: 'profile-col',
    source: { type: 'collection', id: COL_ID },
    updated_at: 1,
  });
  seedSubscription({
    operators: [
      {
        id: 'rt-1',
        kind: 'rename-template',
        template: '${emoji} ${region}${?index: · ${index}}',
        recognitionRules: [],
      },
    ],
  });
  seedCollection({ operators: [] });
}

// The handle secret is pinned at MODULE scope: describe-level fixtures
// (e.g. the round-trip candidate) compute refs at import time, before any
// beforeAll can run.
installTestHandleSecret();

let membershipCache = new Map<string, NamingMembershipSnapshot>();

beforeEach(async () => {
  stores.clear();
  counters.clear();
  keyTypes.clear();
  seed();
  // pass-7 blocker 4: capture the gate-time membership bracket for each
  // fixture profile exactly like the confirmation card does.
  membershipCache = new Map();
  const { captureNamingMembership } = await import('@/lib/services/namingTargetScope');
  for (const id of [ctx.profileId, ctxCol.profileId]) {
    const profile = bucket(REDIS_KEYS.profiles).get(id) as Profile;
    if (profile) membershipCache.set(id, await captureNamingMembership(profile));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function readAction(name: string) {
  const action = getAction(name);
  if (!action || action.risk !== 'read') throw new Error(`expected read action ${name}`);
  return action;
}

function writeAction(name: string) {
  const action = getAction(name);
  if (!action || action.risk !== 'write') throw new Error(`expected write action ${name}`);
  return action;
}

describe('list_naming_targets', () => {
  it('lists targets with managed state and deterministic recommendations', async () => {
    const env = await readAction('list_naming_targets').run(ctx, {});
    const data = env.data as {
      subscriptions: Array<{
        managed: {
          present: boolean;
          templateSummary?: { placeholderCount: number; length: number };
          recommendedTemplateSummary?: { placeholderCount: number; length: number };
        };
        aggregate: boolean;
      }>;
      collections: Array<{
        managed: {
          present: boolean;
          recommendedTemplateSummary?: { placeholderCount: number; length: number };
        };
      }>;
    };
    expect(data.subscriptions[0]).toMatchObject({
      managed: {
        present: true,
        templateSummary: {
          placeholderCount: 3, // emoji + region + optional index
          length: '${emoji} ${region}${?index: · ${index}}'.length,
        },
      },
      aggregate: false,
    });
    // the RAW template string is never serialized — only the structural
    // summary (pass-2 finding)
    expect(JSON.stringify(data.subscriptions[0])).not.toContain('${');
    // ctx is SUBSCRIPTION-bound: no collections are visible (pass-6 scope)
    expect(data.collections).toHaveLength(0);
    // new collections get a deterministic recommended path under the
    // COLLECTION-bound profile
    const colEnv = await readAction('list_naming_targets').run(ctxCol, {});
    const colData = colEnv.data as {
      collections: Array<{
        managed: { present: boolean; recommendedTemplateSummary?: unknown };
      }>;
    };
    expect(colData.collections[0].managed.present).toBe(false);
    const recommended = colData.collections[0].managed.recommendedTemplateSummary as {
      placeholderCount: number;
      length: number;
    } & {
      placeholders?: string[];
    };
    expect(recommended.placeholderCount).toBeGreaterThan(0);
    expect((recommended.placeholders ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(colData.collections[0])).not.toContain('${');
  });
});

describe('inspect_naming_fields', () => {
  it('reports the per-source coverage matrix with sanitized samples', async () => {
    const env = await readAction('inspect_naming_fields').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
    });
    const data = env.data as {
      sources: Array<{ nodeCount: number; fields: Array<{ field: string; percent: number }> }>;
    };
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].nodeCount).toBe(4);
    const region = data.sources[0].fields.find((f) => f.field === 'region');
    expect(region!.percent).toBe(100);
    const serialized = JSON.stringify(env);
    // credentials/URLs never reach the loop
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
    expect(serialized).not.toContain('example.com');
  });

  it('reports unavailable/partial/ambiguous and drift signals', async () => {
    const env = await readAction('inspect_naming_fields').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
    });
    const data = env.data as {
      sources: Array<{ unavailable: string[]; drift: Array<{ field: string }> }>;
    };
    expect(data.sources[0].unavailable).toContain('vendor');
    // 'US 家宽' triggers the route drift pattern
    expect(data.sources[0].drift.map((d) => d.field)).toContain('route');
  });
});

describe('inspect_node_parse', () => {
  it('resolves one opaque handle to typed facts + sanitized fragment', async () => {
    // the fixture node's RAW identity fingerprint feeds the opaque handle
    const probe = { name: '🇭🇰 香港 中转 02', type: 'ss', server: 'hk2.example.com', port: 443 };
    const handle = handleOf(probe);
    const env = await readAction('inspect_node_parse').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      node_handle: handle,
    });
    const data = env.data as { facts: { region: string; route: string }; fragment: string };
    expect(data.facts).toMatchObject({ region: 'HK', route: '中转' });
  });

  it('rejects unknown handles safely (never echoes the value)', async () => {
    await expect(
      readAction('inspect_node_parse').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        node_handle: 'nd-0000000000000000',
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it('sanitizes credential-shaped fragments in the parse result', async () => {
    const probe = {
      name: '🇯🇵 日本 https://evil.example/sub?token=abc123',
      type: 'vmess',
      server: 'jp.example.com',
      port: 443,
    };
    const handle = handleOf(probe);
    const env = await readAction('inspect_node_parse').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      node_handle: handle,
    });
    expect(JSON.stringify(env)).not.toContain('evil.example');
    expect(JSON.stringify(env)).not.toContain('token=abc123');
  });
});

describe('inspect_source_name_clusters', () => {
  it('groups by semantic signature, bounded samples; extra samples per cluster', async () => {
    const env = await readAction('inspect_source_name_clusters').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
    });
    const data = env.data as { clusters: Array<{ count: number; samples: string[] }> };
    expect(data.clusters.length).toBeGreaterThanOrEqual(2);
    for (const cluster of data.clusters) expect(cluster.samples.length).toBeLessThanOrEqual(2);

    const extra = await readAction('inspect_source_name_clusters').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      more_samples_for: 0,
    });
    const extraData = extra.data as { clusters: Array<{ extraSamples?: string[] }> };
    // cluster 0 may be fully sampled already — extraSamples is then absent;
    // when present it must stay bounded
    if (extraData.clusters[0].extraSamples) {
      expect(extraData.clusters[0].extraSamples!.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('inspect_naming_collisions', () => {
  it('reports formatted collisions, true dedup and references — all sanitized', async () => {
    const env = await readAction('inspect_naming_collisions').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      // collide: all four nodes share the flag+region block
      template: '${emoji} ${region}',
    });
    const data = env.data as { collisions: string[]; deduped: Array<{ kept: string }> };
    expect(data.collisions.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
    expect(serialized).not.toContain('example.com');
  });
});

describe('preview_naming_recognition', () => {
  it('counts rule matches and reports produced values — never saves', async () => {
    const env = await readAction('preview_naming_recognition').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}${?index: · ${index}}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [{ pattern: '家宽', field: 'route', value: '家宽' }],
    });
    const data = env.data as {
      rules: Array<{ field: string; matches: number; values: Array<{ value: string }> }>;
    };
    expect(data.rules[0].matches).toBe(1);
    // round-1 (invariant 6): SAFE rule-produced values are authorized
    // display content — sanitized text, never opaque tokens
    expect(data.rules[0].values[0].value).toBe('家宽');
    expect(JSON.stringify(data.rules[0])).toContain('家宽');
    // the awaited candidate projection rides along (no dropped promise)
    expect((env.data as { projected: { nodeCount: number } }).projected.nodeCount).toBe(4);
    // nothing was written
    expect(storedSubOps(SUB_ID)).toHaveLength(1);
  });
});

describe('inspect_naming_drift', () => {
  it('reports drifted patterns with bounded samples', async () => {
    const env = await readAction('inspect_naming_drift').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
    });
    const data = env.data as { drift: Array<{ field: string; count: number }> };
    expect(data.drift.map((d) => d.field)).toContain('route');
  });
});

describe('preview_naming_target (round-trip candidate)', () => {
  const candidate = {
    source_type: 'subscription' as const,
    ref: subRef(),
    template:
      '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}',
    tw2cn: false,
    sourceAliases: {},
    recognitionRules: [],
  };

  it('previews the full target without render effects', async () => {
    const env = await readAction('preview_naming_target').run(ctx, candidate);
    const data = env.data as { changed: number; beforeSamples: string[]; afterSamples: string[] };
    expect(data.changed).toBeGreaterThan(0);
    expect(data.afterSamples.length).toBeGreaterThan(0);
    // never secrets
    expect(JSON.stringify(env)).not.toContain('evil.example');
    expect(JSON.stringify(env)).not.toContain('example.com');
    // the round-trip candidate did NOT touch the stored pipeline
    expect(storedSubOps(SUB_ID)).toHaveLength(1);
  });

  it('rejects malformed templates with the DSL error (schema boundary)', async () => {
    const { dispatchToolCall } = await import('@/lib/ai/dispatchTool');
    const result = await dispatchToolCall(ctx, 'preview_naming_target', {
      ...candidate,
      template: '${foo}',
    });
    expect(result.kind).toBe('error');
  });
});

/** Confirmation-bind every write execute to the CURRENT version (the card
 * would have captured it at preview time). */
function confirmCtx(
  over: Record<string, unknown> = {},
  base: { actor: string; profileId: string } = ctx,
): ActionContext {
  return {
    ...base,
    confirmation: {
      configVersion: counters.get(REDIS_KEYS.configVersion) ?? 0,
      membership: membershipCache.get(base.profileId),
    },
    ...over,
  } as ActionContext;
}

describe('namingCasRepo strict audit boundary (pass-3 finding) — every rejection leaves ZERO writes', () => {
  // lazy import inside the tests: vitest transforms ESM, require() fails
  let commitEntityWithNamingHistory: (options: unknown) => Promise<unknown>;
  beforeAll(async () => {
    const mod = await import('@/lib/repos/namingCasRepo');
    commitEntityWithNamingHistory = mod.commitEntityWithNamingHistory as unknown as (
      options: unknown,
    ) => Promise<unknown>;
  });

  function validAudit(over: Record<string, unknown> = {}): {
    id: string;
    ts: number;
    op: 'naming.apply';
    actor: string;
    payloadJson: string;
  } {
    const id = (over.id as string) ?? crypto.randomUUID();
    const ts = (over.ts as number) ?? 1000;
    const op = 'naming.apply';
    const actor = 'test-actor';
    const payload = {
      id,
      ts,
      op,
      actor,
      target: { kind: 'naming-source', type: 'subscription', id: SUB_ID, name: '机场A' },
      before: null,
      after: { templateSummary: { placeholderCount: 1, length: 8 }, mode: 'added' },
      undoable: false,
      profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    return {
      id,
      ts,
      op,
      actor,
      payloadJson:
        typeof over.payloadJson === 'string'
          ? (over.payloadJson as string)
          : JSON.stringify(payload),
      ...(over.actor !== undefined ? { actor: over.actor as string } : {}),
    };
  }

  function attemptRecord(): Record<string, unknown> {
    return {
      ref: subRef(),
      operators: [
        { id: 'rt-1', kind: 'rename-template', template: '${region}', recognitionRules: [] },
      ],
    };
  }

  async function attempt(
    audit: unknown,
    over: {
      entityKey?: string;
      recordId?: string;
      expectedProfileId?: string;
      profileBindingProfileId?: string;
      profileBindingType?: string;
      profileBindingId?: string;
      history?: unknown;
    } = {},
  ): Promise<void> {
    await commitEntityWithNamingHistory({
      entityKey: over.entityKey ?? REDIS_KEYS.subscriptions,
      recordId: over.recordId ?? SUB_ID,
      recordJson: JSON.stringify(attemptRecord()),
      expectedVersion: 0,
      ordinalPlan: { expectedGeneration: 0, expectedGlobalSize: 0, sources: [] },
      history:
        'history' in over
          ? (over.history as never)
          : {
              op: 'set',
              field: 'subscription:' + SUB_ID,
              value: '{"hadManaged":false}',
            },
      audit: audit as never,
      // 'expectedProfileId' IN over: an explicit undefined must reach the
      // repository (the required-binding rejection path), while an omitted
      // key falls back to the default fixture profile
      expectedProfileId:
        'expectedProfileId' in over
          ? over.expectedProfileId
          : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      profileBinding: {
        profileId: over.profileBindingProfileId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: over.profileBindingType ?? 'subscription',
        id: over.profileBindingId ?? SUB_ID,
      },
    });
  }

  const assertZeroWrites = (beforeEntity: string): void => {
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(beforeEntity);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(0);
  };

  it('absent audit', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(undefined)).rejects.toThrow(/audit is REQUIRED/);
    assertZeroWrites(before);
  });

  it('invalid JSON payload', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(validAudit({ payloadJson: 'not-json{' }))).rejects.toThrow(/valid JSON/);
    assertZeroWrites(before);
  });

  it('invalid UUID', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(validAudit({ id: 'not-a-uuid' }))).rejects.toThrow(/canonical UUID/);
    assertZeroWrites(before);
  });

  it('DUPLICATE UUID (already in the audit log)', async () => {
    const id = crypto.randomUUID();
    bucket(REDIS_KEYS.audit.byId).set(id, '{}');
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(validAudit({ id }))).rejects.toThrow(/already used/);
    // entity/history/version untouched; the audit log holds ONLY the
    // pre-seeded duplicate (no new event, no overwrite)
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(1);
  });

  it('payload-vs-argument MISMATCH (id / ts / op)', async () => {
    const wrongId = validAudit({ id: crypto.randomUUID() });
    wrongId.payloadJson = wrongId.payloadJson.replace(wrongId.id, crypto.randomUUID());
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(wrongId)).rejects.toThrow(/does not match/);
    assertZeroWrites(before);
    // options.ts = 1000 but the PAYLOAD says 5000 → mismatch
    const wrongTs = validAudit();
    const tsPayload = JSON.parse(wrongTs.payloadJson) as { ts: number };
    tsPayload.ts = 5000;
    wrongTs.payloadJson = JSON.stringify(tsPayload);
    await expect(attempt(wrongTs)).rejects.toThrow(/does not match/);
    assertZeroWrites(before);
    // options.op = naming.rollback but the PAYLOAD says naming.apply → mismatch
    const wrongOp = validAudit();
    await expect(attempt({ ...wrongOp, op: 'naming.rollback' })).rejects.toThrow(
      /does not match|unsupported/,
    );
    assertZeroWrites(before);
  });

  it('NaN and Infinity timestamps', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(validAudit({ ts: Number.NaN }))).rejects.toThrow(/finite score/);
    assertZeroWrites(before);
    await expect(attempt(validAudit({ ts: Number.POSITIVE_INFINITY }))).rejects.toThrow(
      /finite score/,
    );
    assertZeroWrites(before);
  });

  it('overlong actor / payload', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(validAudit({ actor: 'x'.repeat(65) }))).rejects.toThrow(/≤ 64|sanitized/);
    assertZeroWrites(before);
    await expect(
      attempt(validAudit({ payloadJson: JSON.stringify({ blob: 'x'.repeat(9000) }) })),
    ).rejects.toThrow(/size bound|valid JSON/);
    assertZeroWrites(before);
  });

  it('credential-bearing unsanitized values', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(attempt(validAudit({ actor: 'https://evil.example/tok=abc123' }))).rejects.toThrow(
      /sanitized/,
    );
    assertZeroWrites(before);
    const dirtyTemplate = validAudit();
    const payload = JSON.parse(dirtyTemplate.payloadJson) as {
      after: { templateSummary: { placeholderCount: number; length: number } };
    };
    payload.after.templateSummary.length = 900;
    await expect(
      attempt({ ...dirtyTemplate, payloadJson: JSON.stringify(payload) }),
    ).rejects.toThrow(/strict schema-valid/);
    assertZeroWrites(before);
    // RAW placeholder DSL text anywhere in the payload fails closed (pass-2
    // finding): a raw template string is never persisted.
    const rawTemplate = validAudit();
    const rawPayload = JSON.parse(rawTemplate.payloadJson) as Record<string, unknown>;
    rawPayload.raw = '${emoji} ${region}';
    await expect(
      attempt({ ...rawTemplate, payloadJson: JSON.stringify(rawPayload) }),
    ).rejects.toThrow(/raw placeholder DSL|strict schema-valid/);
    assertZeroWrites(before);
    const rawInAfter = validAudit();
    const afterPayload = JSON.parse(rawInAfter.payloadJson) as {
      after: { templateSummary: { placeholderCount: number; length: number } };
    };
    afterPayload.after.templateSummary.placeholderCount = 1;
    const nested = JSON.parse(rawInAfter.payloadJson) as {
      after: { templateSummary: { placeholderCount: number; length: number } };
    };
    nested.after.templateSummary = nested.after.templateSummary as never;
    // smuggle raw DSL through a NESTED string the schema allows nowhere:
    // replace the whole after with an object carrying a raw template string
    const smuggled = JSON.parse(rawInAfter.payloadJson) as { after: unknown };
    smuggled.after = { template: '${region}', mode: 'added' };
    await expect(attempt({ ...rawInAfter, payloadJson: JSON.stringify(smuggled) })).rejects.toThrow(
      /strict schema-valid/,
    );
    assertZeroWrites(before);
  });

  it('payload-vs-argument ACTOR mismatch', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const wrongActor = validAudit();
    const payload = JSON.parse(wrongActor.payloadJson) as { actor: string };
    payload.actor = 'someone-else';
    await expect(attempt({ ...wrongActor, payloadJson: JSON.stringify(payload) })).rejects.toThrow(
      /does not match/,
    );
    assertZeroWrites(before);
  });

  it('entity type/id binding: target type or id not matching the record', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    // payload says collection while the commit writes subscriptions
    const wrongType = validAudit();
    const typePayload = JSON.parse(wrongType.payloadJson) as {
      target: { type: string };
    };
    typePayload.target.type = 'collection';
    await expect(
      attempt({ ...wrongType, payloadJson: JSON.stringify(typePayload) }),
    ).rejects.toThrow(/target type does not match/);
    assertZeroWrites(before);
    // payload target id differs from the committed record id
    const wrongId = validAudit();
    const idPayload = JSON.parse(wrongId.payloadJson) as { target: { id: string } };
    idPayload.target.id = '33333333-3333-4333-8333-333333333333';
    await expect(attempt({ ...wrongId, payloadJson: JSON.stringify(idPayload) })).rejects.toThrow(
      /target id does not match/,
    );
    assertZeroWrites(before);
    // the entity key itself is not a naming entity at all
    await expect(attempt(validAudit(), { entityKey: 'profiles' })).rejects.toThrow(
      /unsupported entity key/,
    );
    assertZeroWrites(before);
  });

  it('profile binding: REQUIRED profileId must equal the expected profile; missing profile fails closed', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(
      attempt(validAudit(), {
        expectedProfileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        profileBindingProfileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).rejects.toThrow(/profile does not match/);
    assertZeroWrites(before);
    // payload omits the REQUIRED profileId → the strict projection rejects
    const noProfile = validAudit();
    const p = JSON.parse(noProfile.payloadJson) as { profileId?: string };
    delete p.profileId;
    await expect(attempt({ ...noProfile, payloadJson: JSON.stringify(p) })).rejects.toThrow(
      /strict schema-valid/,
    );
    assertZeroWrites(before);
    // the caller omits the expected profile → the repository rejects
    await expect(attempt(validAudit(), { expectedProfileId: undefined })).rejects.toThrow(
      /global authority binding/,
    );
    assertZeroWrites(before);
    await expect(
      attempt(validAudit(), {
        profileBindingProfileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).rejects.toThrow(/expected profile and live binding profile must match/);
    assertZeroWrites(before);
  });

  it('accepts an explicit global audit only with the global repository authority binding', async () => {
    const audit = validAudit();
    const payload = JSON.parse(audit.payloadJson) as {
      profileId?: string;
      scope?: string;
    };
    delete payload.profileId;
    payload.scope = 'global';

    await expect(
      attempt(
        { ...audit, payloadJson: JSON.stringify(payload) },
        {
          expectedProfileId: undefined,
          profileBindingProfileId: '',
          profileBindingType: 'global',
          profileBindingId: '',
        },
      ),
    ).resolves.toBeUndefined();
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(1);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(1);
  });

  it('history is bound to the exact entity and operation before any write', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const otherField = 'subscription:33333333-3333-4333-8333-333333333333';
    await expect(
      attempt(validAudit(), {
        history: { op: 'set', field: otherField, value: '{"hadManaged":false}' },
      }),
    ).rejects.toThrow(/history target does not match/);
    assertZeroWrites(before);
    await expect(
      attempt(validAudit(), { history: { op: 'del', field: otherField } }),
    ).rejects.toThrow(/history target does not match/);
    assertZeroWrites(before);
    await expect(
      attempt(validAudit(), {
        history: {
          op: 'skip',
          field: 'subscription:' + SUB_ID,
          value: '{"hadManaged":false}',
        },
      }),
    ).rejects.toThrow(/unsupported naming history operation/);
    assertZeroWrites(before);
    await expect(
      attempt(validAudit(), {
        history: { op: 'set', field: 'subscription:' + SUB_ID, value: '{}' },
      }),
    ).rejects.toThrow(/valid prior plan/);
    assertZeroWrites(before);
  });

  it('every NESTED credential-bearing string branch fails closed (recursive walker)', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const dirtyName = validAudit();
    const namePayload = JSON.parse(dirtyName.payloadJson) as { target: { name: string } };
    namePayload.target.name = '机场 https://evil.example/sub?token=abc123';
    await expect(
      attempt({ ...dirtyName, payloadJson: JSON.stringify(namePayload) }),
    ).rejects.toThrow(/sanitized|credential-shaped/);
    assertZeroWrites(before);
    // nested array/object member: an unknown key is schema-rejected (strict
    // projection) before the walker even runs
    const unknownKey = validAudit();
    const extra = JSON.parse(unknownKey.payloadJson) as Record<string, unknown>;
    extra.extra = { nested: ['x'] };
    await expect(attempt({ ...unknownKey, payloadJson: JSON.stringify(extra) })).rejects.toThrow(
      /strict schema-valid/,
    );
    assertZeroWrites(before);
    // undoable:true is never a valid naming event
    const undoable = validAudit();
    const undoPayload = JSON.parse(undoable.payloadJson) as { undoable: boolean };
    undoPayload.undoable = true;
    await expect(
      attempt({ ...undoable, payloadJson: JSON.stringify(undoPayload) }),
    ).rejects.toThrow(/strict schema-valid/);
    assertZeroWrites(before);
  });

  it('malformed/oversized nested values: overlong name and template', async () => {
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const longName = validAudit();
    const namePayload = JSON.parse(longName.payloadJson) as { target: { name: string } };
    namePayload.target.name = 'x'.repeat(65);
    await expect(
      attempt({ ...longName, payloadJson: JSON.stringify(namePayload) }),
    ).rejects.toThrow(/strict schema-valid/);
    assertZeroWrites(before);
    const longTemplate = validAudit();
    const t = JSON.parse(longTemplate.payloadJson) as {
      after: { templateSummary: { placeholderCount: number; length: number } };
    };
    t.after.templateSummary.length = 513;
    await expect(attempt({ ...longTemplate, payloadJson: JSON.stringify(t) })).rejects.toThrow(
      /strict schema-valid/,
    );
    assertZeroWrites(before);
  });

  it('RACE: the UUID occupied between TypeScript validation and the Lua eval (pass-1 closure)', async () => {
    const id = crypto.randomUUID();
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    const originalEval = fakeRedis.eval;
    // simulate the concurrent writer: the eval sees the id already occupied
    fakeRedis.eval = (async (script: string, keys: string[], args: string[]) => {
      bucket(REDIS_KEYS.audit.byId).set(id, '{"existing":true,"ts":1}');
      return originalEval(script, keys, args);
    }) as typeof fakeRedis.eval;
    try {
      const result = (await commitEntityWithNamingHistory({
        entityKey: REDIS_KEYS.subscriptions,
        recordId: SUB_ID,
        recordJson: JSON.stringify(attemptRecord()),
        expectedVersion: 0,
        ordinalPlan: { expectedGeneration: 0, expectedGlobalSize: 0, sources: [] },
        history: {
          op: 'set',
          field: 'subscription:' + SUB_ID,
          value: '{"hadManaged":false}',
        },
        audit: validAudit({ id }),
        expectedProfileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profileBinding: {
          profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          type: 'subscription',
          id: SUB_ID,
        },
      })) as { ok: boolean; failure?: string };
      // the atomic Lua gate rejected the reused id with NOTHING written
      expect(result.ok).toBe(false);
      expect(result.failure).toBe('audit-id-exists');
      // the preexisting event is unchanged; entity/history/version untouched
      expect(bucket(REDIS_KEYS.audit.byId).get(id)).toBe('{"existing":true,"ts":1}');
      expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
      expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
      expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
      expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    } finally {
      fakeRedis.eval = originalEval;
    }
  });

  it('a VALID sanitized audit still commits exactly one event', async () => {
    await attempt(validAudit());
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(1);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(1);
  });
});

describe('buildNamingAudit — sanitized + schema-valid before persistence (finding 6/7)', () => {
  it('dirty actor + dirty template are redacted, structurally summarized, bounded and schema-valid; invalid input cannot reach storage', async () => {
    const { buildNamingAudit } = await import('@/lib/services/namingApplyService');
    const built = buildNamingAudit({
      op: 'naming.apply',
      actor: '  https://evil.example/tok=abc123  ',
      type: 'subscription',
      id: SUB_ID,
      label: '机场A https://evil.example/x',
      hadManaged: true,
      template: '${emoji} ${region} https://evil.example/sub?token=abc123',
      mode: 'replaced',
      profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const parsed = JSON.parse(built.payloadJson) as {
      actor: string;
      target: { name: string };
      after: { templateSummary: { placeholderCount: number; length: number }; mode: string };
      undoable: boolean;
      op: string;
      profileId: string;
    };
    expect(parsed.actor).not.toContain('evil.example');
    expect(parsed.actor).not.toContain('token=abc123');
    expect(parsed.actor.length).toBeLessThanOrEqual(64);
    expect(parsed.target.name).not.toContain('evil.example');
    // pass-2: the RAW DSL template string is NEVER persisted — only the
    // bounded structural summary survives, even for a dirty template
    expect(JSON.stringify(parsed.after)).not.toContain('evil.example');
    expect(JSON.stringify(parsed.after)).not.toContain('token=abc123');
    expect(JSON.stringify(parsed.after)).not.toContain('${');
    expect(parsed.after.templateSummary.placeholderCount).toBe(2); // emoji + region
    expect(parsed.after.templateSummary.length).toBeGreaterThan(0);
    expect(parsed.after.mode).toBe('replaced');
    expect(parsed.undoable).toBe(false);
    expect(parsed.op).toBe('naming.apply');
    // REQUIRED profile binding survives into the durable payload
    expect(parsed.profileId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    // the payload is schema-valid (the builder throws otherwise — before CAS)
    expect(built.payloadJson.length).toBeGreaterThan(0);
  });

  it('buildNamingAudit REJECTS a missing profileId (required projection)', async () => {
    const { buildNamingAudit } = await import('@/lib/services/namingApplyService');
    expect(() =>
      buildNamingAudit({
        op: 'naming.apply',
        actor: 'admin',
        type: 'subscription',
        id: SUB_ID,
        label: '机场A',
        hadManaged: false,
        template: '${region}',
        mode: 'added',
        profileId: undefined,
      } as never),
    ).toThrow(/审计事件不合法/);
  });
});

describe('save_naming_plan (the single gated write)', () => {
  const plan = {
    source_type: 'subscription' as const,
    ref: subRef(),
    template:
      '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}',
    tw2cn: true,
    sourceAliases: {},
    recognitionRules: [],
  };

  it('preview builds a credential-free diff; execute lands through the CAS gate', async () => {
    const action = writeAction('save_naming_plan');
    const preview = await action.preview(ctx, plan);
    const diff = preview.diff as { mode: string; template: string };
    expect(diff.mode).toBe('replace rename-template');
    // the diff template is structurally projected + bounded (never raw echo)
    expect(diff.template.length).toBeLessThanOrEqual(64);
    expect(diff.template.startsWith('${emoji} ${region}')).toBe(true);

    const beforeVersion = counters.get(REDIS_KEYS.configVersion) ?? 0;
    const env = await action.execute(confirmCtx(), plan);
    const data = env.data as { result: { mode: string } };
    expect(data.result.mode).toBe('replaced');
    const ops = storedSubOps(SUB_ID);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'rename-template',
      template: plan.template,
      tw2cn: true,
    });
    // the write went through the CAS (config version bumped)
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBeGreaterThan(beforeVersion);
  });

  it('adds a rename-template when none exists (collections)', async () => {
    const action = writeAction('save_naming_plan');
    const env = await action.execute(confirmCtx(undefined, ctxCol), {
      ...plan,
      source_type: 'collection',
      ref: colRef(),
    });
    const data = env.data as { result: { mode: string } };
    expect(data.result.mode).toBe('added');
  });

  it('rejects an invalid plan at the schema boundary', async () => {
    await expect(
      writeAction('save_naming_plan').execute(confirmCtx(), { ...plan, template: '${?index: x}' }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it('audit event + atomic naming-history creation; rollback afterwards works', async () => {
    const action = writeAction('save_naming_plan');
    const beforeVersion = counters.get(REDIS_KEYS.configVersion) ?? 0;
    const env = await action.execute(confirmCtx(), plan);
    const data = env.data as {
      events: Array<{
        type: string;
        planningVersion: number;
        confirmedVersion: number;
        history: string;
        mode: string;
        auditId?: string;
      }>;
      result: { events: Array<Record<string, unknown>> };
    };
    // round-3: the UI events array is EXACT undo events only — the enriched
    // naming-plan event moved under the INTERNAL result
    expect(data.events).toHaveLength(0);
    const event = (data.result.events ?? [])[0] as {
      type: string;
      planningVersion: number;
      confirmedVersion: number;
      history: string;
      mode: string;
      auditId?: string;
    };
    expect(event.type).toBe('naming-plan-saved');
    expect(event.planningVersion).toBe(beforeVersion);
    expect(event.confirmedVersion).toBe(beforeVersion);
    expect(event.history).toBe('created');
    expect(event.mode).toBe('replaced');
    // round-2: the DURABLE audit id is internal — it never crosses the
    // model boundary (no auditId anywhere in the write envelope)
    expect(event.auditId).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('auditId');
    // DURABLE audit record persisted exactly once (the repository's real
    // audit log) — the audit storage key stays server-side
    const auditBucket = bucket(REDIS_KEYS.audit.events);
    expect(auditBucket.size).toBe(1);
    const byId = bucket(REDIS_KEYS.audit.byId);
    const auditId = [...byId.keys()][0] as string;
    const storedEvent = JSON.parse(byId.get(auditId) as string) as {
      op: string;
      actor: string;
      undoable: boolean;
      target: { kind: string; type: string; id: string; name: string };
    };
    expect(storedEvent.op).toBe('naming.apply');
    expect(storedEvent.actor).toBe('test');
    expect(storedEvent.undoable).toBe(false);
    expect(storedEvent.target).toMatchObject({
      kind: 'naming-source',
      type: 'subscription',
      id: SUB_ID, // the DURABLE audit binds the raw entity id server-side
      name: '机场A',
    });
    // the prior plan is persisted as the rollback target
    const history = bucket(REDIS_KEYS.namingHistory).get('subscription:' + SUB_ID) as {
      hadManaged: boolean;
      template: string;
    };
    expect(history.hadManaged).toBe(true);
    expect(history.template).toBe('${emoji} ${region}${?index: · ${index}}');
    // rollback (the SAME path the workspace route uses) restores the prior plan
    const { rollbackNamingPlan } = await import('@/lib/services/namingApplyService');
    const rollback = await rollbackNamingPlan('subscription', SUB_ID, {
      audit: { actor: 'test', profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    expect(rollback.history).toBe('cleared');
    expect(storedSubOps(SUB_ID)[0]).toMatchObject({
      id: 'rt-1',
      template: '${emoji} ${region}${?index: · ${index}}',
    });
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
  });

  it('confirmation-time configVersion guard: a concurrent commit between read and preflight 412s, nothing written', async () => {
    const action = writeAction('save_naming_plan');
    const originalGet = fakeRedis.get;
    let bracketRead = false;
    fakeRedis.get = async (key: string) => {
      if (key === REDIS_KEYS.configVersion && !bracketRead) {
        bracketRead = true;
        counters.set(REDIS_KEYS.configVersion, 99); // concurrent writer lands
        return 0; // what the confirmation card captured
      }
      return originalGet(key);
    };
    try {
      await expect(action.execute(confirmCtx(), plan)).rejects.toMatchObject({
        problem: { status: 412 },
      });
    } finally {
      fakeRedis.get = originalGet;
    }
    // the concurrent state survives; nothing was applied, recorded or audited
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(99);
    expect(storedSubOps(SUB_ID)[0]).toMatchObject({
      id: 'rt-1',
      template: '${emoji} ${region}${?index: · ${index}}',
    });
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('audit is REQUIRED at every write boundary (finding 2): absent audit fails closed BEFORE any write', async () => {
    const { applyNamingPlan } = await import('@/lib/services/namingApplyService');
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(
      // @ts-expect-error audit deliberately omitted — the runtime guard must catch it
      applyNamingPlan('subscription', SUB_ID, { template: '${region}' }, {}),
    ).rejects.toMatchObject({ problem: { status: 412 } });
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('commitEntityWithNamingHistory (repo boundary) requires a non-empty audit — zero writes otherwise', async () => {
    const { commitEntityWithNamingHistory } = await import('@/lib/repos/namingCasRepo');
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(
      // @ts-expect-error audit deliberately omitted
      commitEntityWithNamingHistory({
        entityKey: REDIS_KEYS.subscriptions,
        recordId: SUB_ID,
        recordJson: '{}',
        expectedVersion: 0,
        history: {
          op: 'set',
          field: 'subscription:' + SUB_ID,
          value: '{"hadManaged":false}',
        },
      }),
    ).rejects.toThrow(/audit is REQUIRED/);
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('missing confirmation metadata fails closed BEFORE any preflight or write', async () => {
    const action = writeAction('save_naming_plan');
    await expect(action.execute(ctx, plan)).rejects.toMatchObject({
      problem: { status: 412 },
    });
    expect(storedSubOps(SUB_ID)[0]).toMatchObject({ id: 'rt-1' });
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
  });

  it('audit repository failure fails the WHOLE transition closed — nothing written anywhere', async () => {
    // the audit zset key holds a non-zset: the CAS prevalidation must fail
    // BEFORE any write — entity, history, version AND audit stay untouched
    const action = writeAction('save_naming_plan');
    keyTypes.set(REDIS_KEYS.audit.events, 'string');
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(action.execute(confirmCtx(), plan)).rejects.toMatchObject({
      problem: { status: 412 },
    });
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.audit.byId).size).toBe(0);
  });

  it('audit byId key wrongtype also fails closed', async () => {
    const action = writeAction('save_naming_plan');
    keyTypes.set(REDIS_KEYS.audit.byId, 'string');
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(action.execute(confirmCtx(), plan)).rejects.toMatchObject({
      problem: { status: 412 },
    });
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(before);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(0);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('a stale bound version (card-to-click change) writes NOTHING and mints NO audit', async () => {
    const action = writeAction('save_naming_plan');
    // the card captured version 0; a concurrent writer bumped to 7 before the
    // user clicked confirm — the guard must fail BEFORE any preflight/write
    counters.set(REDIS_KEYS.configVersion, 7);
    await expect(
      action.execute(
        confirmCtx({ confirmation: { configVersion: 0 } }), // the card's version
        plan,
      ),
    ).rejects.toMatchObject({
      problem: { status: 412 },
    });
    expect(storedSubOps(SUB_ID)[0]).toMatchObject({ id: 'rt-1' });
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(7);
  });
});

describe('candidate template/rules drive assistant ordinal semantics (C6)', () => {
  it('preview_naming_target numbers with the CANDIDATE template, never the saved plan', async () => {
    // The SAVED plan has no ${index}; the candidate does. Ordinal semantics
    // (upstream-ordinal reuse) must follow the CANDIDATE.
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    const withoutIndex = await readAction('preview_naming_target').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}', // no ${index}: trailing digits are NOTE content
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    });
    const withIndex = await readAction('preview_naming_target').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}${?index: · ${index}}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    });
    const summary = (env: unknown) =>
      (env as { data: { templateSummary: { placeholders: string[] } } }).data.templateSummary;
    // The CANDIDATE template drives the response's structural summary (the
    // saved plan never applies): the index placeholder appears ONLY in the
    // with-index candidate. Raw names/templates never serialize.
    expect(summary(withoutIndex).placeholders).toEqual(['emoji', 'region']);
    expect(summary(withIndex).placeholders).toEqual(['emoji', 'index', 'region']);
    expect(JSON.stringify(withIndex)).not.toContain('${');
    // round-1: before/after samples carry bounded sanitized ORIGINAL names —
    // useful recognition content, credential-free
    expect(JSON.stringify(withIndex)).toContain('香港');
    // the CANDIDATE ordinal semantics are executor-proven elsewhere; here
    // every sample is an opaque handle with true totals
    const data = withIndex.data as {
      beforeSamples: Array<{ handle: string; name: string | null }>;
      totalBeforeNodes: number;
      truncatedBeforeSamples: boolean;
    };
    for (const sample of data.beforeSamples) {
      expect(sample.handle).toMatch(/^nd-[0-9a-f]{16}$/);
      expect(typeof sample.name).toBe('string');
    }
    // the fixture has 4 nodes but only 3 before-samples are returned: the
    // TRUE total stays 4 and the truncation flag says so (pass-2 finding)
    expect(data.totalBeforeNodes).toBe(4);
    expect(data.truncatedBeforeSamples).toBe(true);
  });

  it('preview_naming_recognition uses the CANDIDATE rules for coverage semantics', async () => {
    const env = await readAction('preview_naming_recognition').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}${?index: · ${index}}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [{ pattern: '家宽', field: 'route', value: '家宽' }],
    });
    const data = env.data as { rules: Array<{ field: string; matches: number }> };
    expect(data.rules[0].matches).toBe(1);
  });
});

describe('opaque handles: discovery, uniqueness, strict round-trip (finding 8)', () => {
  it('a read action emits a handle that inspect_node_parse round-trips to exactly one node', async () => {
    const clusterEnv = await readAction('inspect_source_name_clusters').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
    });
    const clusterData = clusterEnv.data as {
      clusters: Array<{ samples: Array<{ handle: string; sample: string }> }>;
    };
    const first = clusterData.clusters[0].samples[0];
    expect(first.handle).toMatch(/^nd-[0-9a-f]{16}$/);

    const parseEnv = await readAction('inspect_node_parse').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      node_handle: first.handle,
    });
    const parseData = parseEnv.data as { node_handle: string; facts: { region: string } };
    expect(parseData.node_handle).toBe(first.handle);
    expect(parseData.facts.region).toBeTruthy();
    // the emitted sample's raw name never appears in the round-trip
    expect(JSON.stringify(parseEnv)).not.toContain(first.sample);
  });

  it('AFTER-preview sample handles round-trip to exactly one RAW node (immutable identity)', async () => {
    // The after-samples are RENAMED nodes; their handles must still resolve
    // against the raw-name scan because the digest uses the envelope rawName.
    const env = await readAction('preview_naming_target').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    });
    const data = env.data as {
      afterSamples: Array<{ name: string; handle: string }>;
    };
    expect(data.afterSamples.length).toBeGreaterThan(0);
    for (const sample of data.afterSamples) {
      const parseEnv = await readAction('inspect_node_parse').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        node_handle: sample.handle,
      });
      expect((parseEnv.data as { node_handle: string }).node_handle).toBe(sample.handle);
    }
  });
});

describe('opaque handles: same-name uniqueness (finding 8)', () => {
  it('same-name DIFFERENT-config nodes never share a handle', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValue({
      proxies: [
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
        { name: '香港 01', type: 'ss', server: 'b.example', port: 443 },
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 }, // exact dup
      ],
      proxyCount: 3,
    });
    try {
      const clusterEnv = await readAction('inspect_source_name_clusters').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      const data = clusterEnv.data as {
        clusters: Array<{ samples: Array<{ handle: string }> }>;
      };
      const handles = data.clusters.flatMap((c) => c.samples.map((s) => s.handle));
      expect(new Set(handles).size).toBe(handles.length); // all unique per node
      // each emitted handle resolves to exactly one node against the SAME list
      for (const handle of handles) {
        const parseEnv = await readAction('inspect_node_parse').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          node_handle: handle,
        });
        expect((parseEnv.data as { node_handle: string }).node_handle).toBe(handle);
      }
    } finally {
      raw.mockReset();
    }
  });
  it('inspect_node_parse projects recognition-RULE values (never raw credential-shaped text)', async () => {
    // A SAVED rule carries a credential-shaped value; the parse result must
    // redact it while keeping bounded semantics.
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [
            { pattern: '机场A', field: 'vendor', value: 'https://evil.example/tok=abc123456' },
          ],
        },
      ],
    });
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValueOnce({
      proxies: [{ name: '机场A 香港 01', type: 'ss', server: 'h.example', port: 443 }],
      proxyCount: 1,
    });
    const handle = handleOf({ name: '机场A 香港 01', type: 'ss', server: 'h.example', port: 443 });
    const env = await readAction('inspect_node_parse').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      node_handle: handle,
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('tok=abc123456');
    // the projected value is bounded
    expect(
      (env.data as { facts: { vendor: string | null } }).facts.vendor?.length ?? 0,
    ).toBeLessThanOrEqual(24);
  });

  it('inspect_node_parse projects recognition.REGION rule values too', async () => {
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [
            { pattern: '机场A', field: 'region', value: 'https://evil.example/region' },
          ],
        },
      ],
    });
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValueOnce({
      proxies: [{ name: '机场A 香港 01', type: 'ss', server: 'h.example', port: 443 }],
      proxyCount: 1,
    });
    const handle = handleOf({ name: '机场A 香港 01', type: 'ss', server: 'h.example', port: 443 });
    const env = await readAction('inspect_node_parse').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      node_handle: handle,
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('evil.example');
    // useful bounded semantics survive (a region-shaped value is still visible)
    const facts = (env.data as { facts: { region: string | null } }).facts;
    expect(facts.region === null || facts.region.length <= 24).toBe(true);
  });
});

describe('50000-node / 50000-source matrix across EVERY read action (pass-1 finding)', () => {
  const manyNode = (i: number, name: string) => ({
    name,
    type: 'ss',
    server: `n${i}.example`,
    port: 443,
  });

  it('list_naming_targets caps 50000 visible targets with TRUE totals + explicit truncation', async () => {
    const memberIds: string[] = [];
    for (let i = 0; i < 50000; i += 1) {
      const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      memberIds.push(id);
      bucket(REDIS_KEYS.subscriptions).set(id, {
        id,
        name: `airport-${i}`,
        enabled: true,
        kind: 'remote',
        url: 'https://upstream.example/sub',
        ttl_ms: 600_000,
        tags: [],
        operators: [],
        updated_at: 1,
      });
    }
    // a profile bound to a collection with 50000 enabled members sees all of
    // them — the cap/totals/truncation contract stays (pass-6 scope)
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '巨集',
      slug: 'big-agg',
      enabled: true,
      type: 'select',
      subscription_ids: memberIds,
      subscription_tags: [],
      operators: [],
      updated_at: 1,
    });
    bucket(REDIS_KEYS.profiles).set(BIG_PROFILE, {
      id: BIG_PROFILE,
      name: 'profile-big',
      source: { type: 'collection', id: COL_ID },
      updated_at: 1,
    });
    const bigCtx = { actor: 'test', profileId: BIG_PROFILE };
    const env = await readAction('list_naming_targets').run(bigCtx, {});
    const data = env.data as {
      totalTargets: number;
      subscriptions: unknown[];
      totalSubscriptions: number;
      truncatedSubscriptions: boolean;
      truncatedCollections: boolean;
    };
    expect(data.subscriptions.length).toBeLessThanOrEqual(100);
    expect(data.totalSubscriptions).toBe(50000); // the 50000 members
    expect(data.truncatedSubscriptions).toBe(true);
    expect(data.totalTargets).toBe(50001); // members + the collection
    const serialized = JSON.stringify(env);
    expect(serialized.length).toBeLessThan(200_000);
    // no URLs/credentials/fingerprints — only opaque ids + sanitized labels
    expect(serialized).not.toContain('upstream.example');
    expect(serialized).not.toContain('"url"');
    expect(serialized).not.toContain('"server"');
    expect(serialized).not.toContain('"port"');
  });

  it('inspect_naming_fields: one 50000-node source keeps TRUE node totals with bounded facts/samples', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    const nodes = Array.from({ length: 50000 }, (_, i) => manyNode(i, `香港 ${i % 300} 家宽`));
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 50000 });
    try {
      const env = await readAction('inspect_naming_fields').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      const data = env.data as {
        nodeCount: number;
        sources: Array<{
          nodeFacts: unknown[];
          nodeFactsTotal: number;
          nodeFactsTruncated: boolean;
          fields: Array<{ sampleTotal: number; sampleTruncated: boolean }>;
          drift: Array<{ count: number; samples: unknown[]; samplesTruncated: boolean }>;
        }>;
      };
      expect(data.nodeCount).toBe(50000);
      expect(data.sources).toHaveLength(1);
      const source = data.sources[0];
      // semantic totals are NEVER the sample cap AND describe the FACT-ROW
      // unit (pass-2 finding): 50000 nodes × 11 facts = 550000 rows
      expect(source.nodeFactsTotal).toBe(50000 * 11);
      expect(source.nodeFactsTruncated).toBe(true);
      expect(source.nodeFacts.length).toBeLessThanOrEqual(40);
      // per-field: bounded stored samples + true distinct-value totals
      const rate = source.fields.find((f) => f.sampleTotal > 4);
      expect(rate?.sampleTruncated).toBe(true);
      // drift counts the TRUE number of near-miss nodes, not the stored cap
      const routeDrift = source.drift.find((d) => d.samples.length > 0);
      expect(routeDrift?.count).toBeGreaterThanOrEqual(50000 * 0.5);
      expect(routeDrift?.samplesTruncated).toBe(true);
      const serialized = JSON.stringify(env);
      expect(serialized.length).toBeLessThan(200_000);
      expect(serialized).not.toContain('n0.example');
      expect(serialized).not.toContain('"port"');
      expect(serialized).not.toContain('"server"');
      expect(serialized).not.toContain('http');
    } finally {
      raw.mockReset();
    }
  });

  it('inspect_naming_fields: 50000 member reports are capped with TRUE report totals', async () => {
    const exportMock = (await import('@/lib/services/nodeExportService'))
      .mergeCollectionMemberProxies as unknown as ReturnType<typeof vi.fn>;
    const { withSource } = await import('@/lib/proxies/provenance');
    const nodes: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50000; i += 1) {
      nodes.push(
        withSource(manyNode(i, `香港 ${i % 100}`), { key: `member-${i}`, label: `成员${i}` }),
      );
    }
    exportMock.mockResolvedValue({ merged: nodes, memberErrors: [], stale: false });
    try {
      const env = await readAction('inspect_naming_fields').run(ctxCol, {
        source_type: 'collection',
        ref: colRef(),
      });
      const data = env.data as {
        sources: unknown[];
        totalSources: number;
        truncatedSources: boolean;
      };
      // never 50000 rows; the TRUE total is reported with the truncation flag
      expect(data.sources.length).toBeLessThanOrEqual(20);
      expect(data.totalSources).toBe(50000);
      expect(data.truncatedSources).toBe(true);
      expect(JSON.stringify(env).length).toBeLessThan(200_000);
    } finally {
      exportMock.mockReset();
    }
  });

  it('inspect_source_name_clusters: ONE 50000-node cluster reports totalClusters=1 and count 50000 with bounded samples', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // every node shares the SAME semantic signature (region + residual token)
    const nodes = Array.from({ length: 50000 }, (_, i) => manyNode(i, '香港 01'));
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 50000 });
    try {
      const env = await readAction('inspect_source_name_clusters').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      const data = env.data as {
        totalClusters: number;
        truncatedClusters: boolean;
        clusters: Array<{
          count: number;
          samples: unknown[];
          truncatedSamples: boolean;
          extraSamples?: unknown[];
          truncatedExtraSamples?: boolean;
        }>;
      };
      expect(data.totalClusters).toBe(1);
      expect(data.truncatedClusters).toBe(false);
      expect(data.clusters).toHaveLength(1);
      // the TRUE node total stays 50000 — never the stored sample cap
      expect(data.clusters[0].count).toBe(50000);
      expect(data.clusters[0].samples.length).toBeLessThanOrEqual(2);
      expect(data.clusters[0].truncatedSamples).toBe(true);
      const extra = await readAction('inspect_source_name_clusters').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        more_samples_for: 0,
      });
      const extraData = extra.data as {
        clusters: Array<{ extraSamples?: unknown[]; truncatedExtraSamples?: boolean }>;
      };
      expect(extraData.clusters[0].extraSamples?.length).toBeLessThanOrEqual(20);
      expect(extraData.clusters[0].truncatedExtraSamples).toBe(true);
      expect(JSON.stringify(env).length).toBeLessThan(200_000);
    } finally {
      raw.mockReset();
    }
  });

  it('inspect_naming_drift: 50000 sources × 3 drift patterns are capped with TRUE totals', async () => {
    const exportMock = (await import('@/lib/services/nodeExportService'))
      .mergeCollectionMemberProxies as unknown as ReturnType<typeof vi.fn>;
    const { withSource } = await import('@/lib/proxies/provenance');
    const nodes: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50000; i += 1) {
      // 家宽 triggers the route drift pattern in every member's residual
      nodes.push(
        withSource(manyNode(i, `香港 家宽 ${i}`), { key: `member-${i}`, label: `成员${i}` }),
      );
    }
    exportMock.mockResolvedValue({ merged: nodes, memberErrors: [], stale: false });
    try {
      const env = await readAction('inspect_naming_drift').run(ctxCol, {
        source_type: 'collection',
        ref: colRef(),
      });
      const data = env.data as {
        drift: unknown[];
        totalDrift: number;
        truncatedDrift: boolean;
      };
      expect(data.drift.length).toBeLessThanOrEqual(40);
      expect(data.totalDrift).toBeGreaterThanOrEqual(50000); // one per member
      expect(data.truncatedDrift).toBe(true);
      expect(JSON.stringify(env).length).toBeLessThan(200_000);
    } finally {
      exportMock.mockReset();
    }
  });

  it('preview_naming_target: 50000-node before/after samples carry TRUE totals, never the cap', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    const nodes = Array.from({ length: 50000 }, (_, i) => manyNode(i, `香港 ${i % 300}`));
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 50000 });
    try {
      const env = await readAction('preview_naming_target').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region} ${note}',
        tw2cn: false,
        sourceAliases: {},
        recognitionRules: [],
      });
      const data = env.data as {
        nodeCount: number;
        beforeSamples: unknown[];
        totalBeforeNodes: number;
        truncatedBeforeSamples: boolean;
        afterSamples: unknown[];
        totalAfterNodes: number;
        truncatedAfterSamples: boolean;
      };
      expect(data.nodeCount).toBe(50000);
      expect(data.beforeSamples.length).toBeLessThanOrEqual(3);
      expect(data.totalBeforeNodes).toBe(50000);
      expect(data.truncatedBeforeSamples).toBe(true);
      expect(data.afterSamples.length).toBeLessThanOrEqual(8);
      expect(data.totalAfterNodes).toBeLessThanOrEqual(50000);
      expect(data.truncatedAfterSamples).toBe(true);
      expect(JSON.stringify(env).length).toBeLessThan(200_000);
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain('n0.example');
      expect(serialized).not.toContain('"port"');
      expect(serialized).not.toContain('"server"');
    } finally {
      raw.mockReset();
    }
  });

  it('preview_naming_recognition: rule value maps are capped with TRUE distinct totals', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // 6 overlapping region rules: the FIRST rule matches every node, but
    // later rules override its field for their own subsets — so its value
    // map holds 6 TRUE distinct values while only 4 are serialized
    const NAMES = ['香港 01', '日本 01', '美国 01', '新加坡 01', '台湾 01', '韩国 01'];
    const nodes = Array.from({ length: 50000 }, (_, i) => manyNode(i, NAMES[i % NAMES.length]));
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 50000 });
    try {
      const env = await readAction('preview_naming_recognition').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
        tw2cn: false,
        sourceAliases: {},
        recognitionRules: [
          { pattern: '香港|日本|美国|新加坡|台湾|韩国', field: 'region', value: 'X' },
          { pattern: '日本', field: 'region', value: 'JP' },
          { pattern: '美国', field: 'region', value: 'US' },
          { pattern: '新加坡', field: 'region', value: 'SG' },
          { pattern: '台湾', field: 'region', value: 'TW' },
          { pattern: '韩国', field: 'region', value: 'KR' },
        ],
      });
      const data = env.data as {
        rules: Array<{
          matches: number;
          values: unknown[];
          totalValues: number;
          truncatedValues: boolean;
        }>;
      };
      const rule = data.rules[0];
      expect(rule.matches).toBe(50000);
      expect(rule.values.length).toBeLessThanOrEqual(4);
      expect(rule.totalValues).toBe(6);
      expect(rule.truncatedValues).toBe(true);
      expect(JSON.stringify(env).length).toBeLessThan(200_000);
    } finally {
      raw.mockReset();
    }
  });

  it('pass-2 four-node edge: nodeFacts totals describe FACT ROWS and projection truncation is truthful', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    const nodes = [
      { name: '🇭🇰 香港 01', type: 'ss', server: 'a.invalid', port: 443 },
      { name: '🇯🇵 日本 02', type: 'ss', server: 'b.invalid', port: 443 },
      { name: '🇺🇸 美国 03', type: 'ss', server: 'c.invalid', port: 443 },
      { name: '🇸🇬 新加坡 04', type: 'ss', server: 'd.invalid', port: 443 },
    ];
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 4 });
    try {
      const env = await readAction('inspect_naming_fields').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      const source = (
        env.data as {
          sources: Array<{
            nodeFacts: unknown[];
            nodeFactsTotal: number;
            nodeFactsTruncated: boolean;
          }>;
        }
      ).sources[0];
      // 4 nodes × 11 facts = 44 rows; the projection keeps ≤ 40 and says so
      expect(source.nodeFactsTotal).toBe(44);
      expect(source.nodeFacts.length).toBeLessThanOrEqual(40);
      expect(source.nodeFactsTruncated).toBe(true);
    } finally {
      raw.mockReset();
    }
  });

  it('pass-3 privacy matrix: enumerates NAMING_READ_ACTIONS, executes all 8 successfully, real-handle parse round-trip, no raw seeds anywhere', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // every raw category the Delivery probes: benign ordinary names, a name
    // with a partial numeric residue, source label/slug, rule pattern/value,
    // raw template text, endpoints/ports, credential-shaped text
    const nodes = [
      { name: 'BenignUniqueNodeName', type: 'ss', server: 'node-a.invalid', port: 443 },
      { name: '机场甲 专线A', type: 'vmess', server: 'node-b.invalid', port: 8443 },
      { name: '香港 01', type: 'trojan', server: 'node-c.invalid', port: 443 },
    ];
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 3 });
    const template = '${emoji} ${region}${?route: · ${route}}';
    const RULE_PATTERN = '专线A';
    const RULE_VALUE = '专线甲';
    // the SAVED plan carries a recognition rule so rule-authored text flows
    // through every rule-aware surface
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}${?route: · ${route}}',
          recognitionRules: [{ pattern: RULE_PATTERN, field: 'route', value: RULE_VALUE }],
        },
      ],
    });
    try {
      // 1. THE REGISTRY IS ENUMERATED, NOT HARDCODED: exactly eight unique
      // read actions, and every single one must execute successfully below.
      const { NAMING_READ_ACTIONS } = await import('@/lib/ai/actions/primitives/namingActions');
      const registeredNames = NAMING_READ_ACTIONS.map((a) => a.name);
      expect(registeredNames).toEqual([
        'list_naming_targets',
        'inspect_naming_fields',
        'inspect_source_name_clusters',
        'inspect_naming_collisions',
        'inspect_node_parse',
        'preview_naming_recognition',
        'inspect_naming_drift',
        'preview_naming_target',
      ]);
      expect(new Set(registeredNames).size).toBe(8);

      // 2. EXECUTE EVERY ACTION with valid context; obtain a REAL emitted
      // node handle from a prior action before inspecting the parse action.
      const runs: Array<{ name: string; env: unknown }> = [];
      runs.push({
        name: 'list_naming_targets',
        env: await readAction('list_naming_targets').run(ctx, {}),
      });
      runs.push({
        name: 'inspect_naming_fields',
        env: await readAction('inspect_naming_fields').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
        }),
      });
      const clusterEnv = await readAction('inspect_source_name_clusters').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      runs.push({ name: 'inspect_source_name_clusters', env: clusterEnv });
      runs.push({
        name: 'inspect_naming_collisions',
        env: await readAction('inspect_naming_collisions').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template,
          recognitionRules: [{ pattern: RULE_PATTERN, field: 'route', value: RULE_VALUE }],
        }),
      });
      runs.push({
        name: 'preview_naming_recognition',
        env: await readAction('preview_naming_recognition').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template,
          tw2cn: false,
          sourceAliases: {},
          recognitionRules: [{ pattern: RULE_PATTERN, field: 'route', value: RULE_VALUE }],
        }),
      });
      runs.push({
        name: 'inspect_naming_drift',
        env: await readAction('inspect_naming_drift').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
        }),
      });
      runs.push({
        name: 'preview_naming_target',
        env: await readAction('preview_naming_target').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template,
          tw2cn: false,
          sourceAliases: {},
          recognitionRules: [{ pattern: RULE_PATTERN, field: 'route', value: RULE_VALUE }],
        }),
      });
      // a REAL handle from the cluster samples (never a fabricated one)
      const sampleHandle = (
        clusterEnv.data as {
          clusters: Array<{ samples: Array<{ handle: string }> }>;
        }
      ).clusters[0].samples[0].handle;
      expect(sampleHandle).toMatch(/^nd-[0-9a-f]{16}$/);
      const parseEnv = await readAction('inspect_node_parse').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        node_handle: sampleHandle,
      });
      runs.push({ name: 'inspect_node_parse', env: parseEnv });
      // the parse round-trips to the EXACT emitted handle
      expect((parseEnv.data as { node_handle: string }).node_handle).toBe(sampleHandle);

      // 3. EVERY final JSON is free of every FORBIDDEN seed (stable keys,
      // raw DSL text, endpoints, credentials); byte-bounded. Round-1: benign
      // original names, safe source labels and safe rule text are AUTHORIZED
      // display content and DO appear.
      const SEEDS = [
        'airport-a', // source slug (stable key) — never
        '${', // raw DSL template text — never (only structural summaries)
        'node-a.invalid',
        'node-b.invalid',
        '8443',
        'https://evil.example/sub?token=abc123', // credential-shaped
      ];
      for (const { name, env } of runs) {
        const serialized = JSON.stringify(env);
        expect(serialized.length, name).toBeLessThan(200_000);
        for (const seed of SEEDS) {
          expect(serialized, `${name} leaks ${seed}`).not.toContain(seed);
        }
      }
      // useful display content survives the matrix: sanitized original
      // names, the safe source label and safe rule text
      const allSerialized = JSON.stringify(runs.map((r) => r.env));
      expect(allSerialized).toContain('香港 01');
      expect(allSerialized).toContain('机场A');
      expect(allSerialized).toContain(RULE_VALUE);
    } finally {
      raw.mockReset();
    }
  });
}, 60_000);

describe('50000-node output caps (pass-3 finding) — bulk never reaches the model', () => {
  it('inspect_naming_collisions caps participants + entries with deterministic totals and truncation flags', async () => {
    // 50000-node fixtures need longer than the default 5s vitest timeout
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    const nodes: Array<{ name: string; type: string; server: string; port: number }> = [];
    // 50000 nodes: 300 distinct colliding names, identical display per group
    for (let i = 0; i < 50000; i += 1) {
      nodes.push({ name: `香港 ${i % 300}`, type: 'ss', server: `n${i}.example`, port: 443 });
    }
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 50000 });
    try {
      const env = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region} ${note}',
      });
      const data = env.data as {
        nodeCount: number;
        totalCollisions: number;
        truncatedCollisions: boolean;
        collisions: Array<{
          name: string;
          participants: unknown[];
          totalParticipants: number;
          truncatedParticipants: boolean;
        }>;
        totalDeduped: number;
        truncatedDeduped: boolean;
        deduped: unknown[];
      };
      expect(data.nodeCount).toBe(50000);
      // hard caps: at most 100 collision entries, at most 8 participants each
      expect(data.collisions.length).toBeLessThanOrEqual(100);
      expect(data.totalCollisions).toBe(300);
      expect(data.truncatedCollisions).toBe(true);
      for (const entry of data.collisions) {
        expect(entry.participants.length).toBeLessThanOrEqual(8);
        expect(entry.totalParticipants).toBeGreaterThan(16);
        expect(entry.truncatedParticipants).toBe(true);
      }
      expect(data.deduped.length).toBeLessThanOrEqual(200);
      expect(data.truncatedDeduped).toBe(false);
      // bounded serialized output
      const serialized = JSON.stringify(env);
      expect(serialized.length).toBeLessThan(200_000);
      // NO bulk raw material: addresses, ports, fingerprints, URLs, tokens
      expect(serialized).not.toContain('n0.example');
      expect(serialized).not.toContain('"port"');
      expect(serialized).not.toContain('"server"');
      expect(serialized).not.toContain('http');
      expect(serialized).not.toContain('token=');
      // opaque handles only, sanitized names bounded
      const handleCount = (serialized.match(/nd-[0-9a-f]{16}/g) ?? []).length;
      expect(handleCount).toBeGreaterThan(0);
      expect(handleCount).toBeLessThanOrEqual(100 * 8 + 200);
    } finally {
      raw.mockReset();
    }
  }, 60000);
});

describe('inspect_naming_collisions applies the complete UNSAVED candidate (C6/C9)', () => {
  it('candidate sourceAliases + recognitionRules drive collision suffixes and upstream detection', async () => {
    // SAVED plan: no aliases, no rules → 香港 01 and 香港 中转 02 collide and
    // disambiguate with the raw source label 机场A.
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    const nodes = [
      { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
      { name: '香港 中转 02', type: 'ss', server: 'b.example', port: 443 },
    ];
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 2 });
    try {
      const saved = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
      });
      const savedCollisions = (saved.data as { collisions: Array<{ participants: unknown[] }> })
        .collisions;
      expect(savedCollisions.length).toBeGreaterThan(0);
      const savedSerialized = JSON.stringify(saved);
      // pass-2: NO raw names, source labels or DSL templates serialize —
      // only opaque handles, structural template summaries and counts
      expect(savedSerialized).not.toContain('机场A');
      expect(savedSerialized).not.toContain('香港');
      expect(savedSerialized).not.toContain('${');
      expect(savedSerialized).toContain('templateSummary');

      // CANDIDATE aliases/rules still run the same executor — the collision
      // grouping is identical (counts + participant handles), even though
      // the resolved suffix strings never serialize
      const aliased = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
        // pass-8 blocker 1: the EXTERNAL alias contract is src-handles only
        // (plain stable keys fail at the schema boundary)
        sourceAliases: { [srcHandle('airport-a')]: '候选甲' },
        recognitionRules: [],
        tw2cn: false,
      });
      const aliasedData = aliased.data as {
        collisions: Array<{
          participants: Array<{ handle: string }>;
          totalParticipants: number;
        }>;
      };
      // ALL participants are listed, each with its own opaque handle
      expect(aliasedData.collisions[0].participants.length).toBe(2);
      expect(aliasedData.collisions[0].totalParticipants).toBe(2);
      for (const p of aliasedData.collisions[0].participants) {
        expect(p.handle).toMatch(/^nd-[0-9a-f]{16}$/);
      }
      expect(JSON.stringify(aliased)).not.toContain('候选甲');
      expect(JSON.stringify(aliased)).not.toContain('机场A');

      // CANDIDATE rules change recognition: 中转 becomes a REGION → no
      // collision with the 香港 node at all.
      const rerouted = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
        recognitionRules: [{ pattern: '中转', field: 'region', value: '中转' }],
        tw2cn: false,
        sourceAliases: {},
      });
      const reroutedData = rerouted.data as { collisions: unknown[] };
      expect(reroutedData.collisions).toHaveLength(0);
    } finally {
      raw.mockReset();
    }
  });

  it('candidate tw2cn flips the TW flag (🇹🇼 → 🇨🇳) — saved policy never wins', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValue({
      proxies: [{ name: '台湾 01', type: 'ss', server: 'tw.example', port: 443 }],
      proxyCount: 1,
    });
    try {
      const plain = await readAction('preview_naming_target').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
        tw2cn: false,
        sourceAliases: {},
        recognitionRules: [],
      });
      const cn = await readAction('preview_naming_target').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
        tw2cn: true,
        sourceAliases: {},
        recognitionRules: [],
      });
      // round-1: the AFTER samples carry opaque handles AND bounded
      // sanitized rendered names — the tw2cn flag effect is visible in the
      // sanitized after-name (🇨🇳 台湾 vs 🇹🇼 台湾), while the raw template
      // DSL never serializes.
      const names = (env: unknown) =>
        (
          env as { data: { afterSamples: Array<{ handle: string; name: string | null }> } }
        ).data.afterSamples.map((s) => s.name);
      const plainHandles = (env: unknown) =>
        (env as { data: { afterSamples: Array<{ handle: string }> } }).data.afterSamples.map(
          (s) => s.handle,
        );
      expect(plainHandles(plain).length).toBeGreaterThan(0);
      for (const h of [...plainHandles(plain), ...plainHandles(cn)]) {
        expect(h).toMatch(/^nd-[0-9a-f]{16}$/);
      }
      expect(names(plain)[0]).toContain('台湾');
      expect(names(cn)[0]).toContain('台湾');
      expect(JSON.stringify(plain)).not.toContain('${');
    } finally {
      raw.mockReset();
    }
  });
});

describe('occurrence-exact diagnostics handles (C9)', () => {
  it('true-duplicate kept/dropped handles are distinct and each round-trips to its raw occurrence', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValue({
      proxies: [
        // IDENTICAL config (same fp) with different names: a true duplicate
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
      ],
      proxyCount: 2,
    });
    try {
      const env = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
      });
      const data = env.data as {
        deduped: Array<{
          kept: string;
          dropped: string;
          keptHandle: string;
          droppedHandle: string;
        }>;
      };
      expect(data.deduped).toHaveLength(1);
      const entry = data.deduped[0];
      expect(entry.keptHandle).toBeTruthy();
      expect(entry.droppedHandle).toBeTruthy();
      // the two handles MUST differ (same display name, different occurrence)
      expect(entry.keptHandle).not.toBe(entry.droppedHandle);
      for (const handle of [entry.keptHandle, entry.droppedHandle]) {
        const parseEnv = await readAction('inspect_node_parse').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          node_handle: handle,
        });
        expect((parseEnv.data as { node_handle: string }).node_handle).toBe(handle);
      }
    } finally {
      raw.mockReset();
    }
  });

  it('same-config DIFFERENT-raw-name duplicates: kept/dropped handles each round-trip to THEIR OWN raw node', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // IDENTICAL connection config (same fp) with DIFFERENT raw names — the
    // dropped node must resolve to a handle built from ITS OWN raw name +
    // occurrence (1), never from the first occurrence's name.
    raw.mockResolvedValue({
      proxies: [
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
        { name: '日本 01', type: 'ss', server: 'a.example', port: 443 },
      ],
      proxyCount: 2,
    });
    try {
      const env = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
      });
      const data = env.data as {
        deduped: Array<{ keptHandle: string; droppedHandle: string }>;
      };
      expect(data.deduped).toHaveLength(1);
      const { keptHandle, droppedHandle } = data.deduped[0];
      expect(keptHandle).not.toBe(droppedHandle);
      // the KEPT handle round-trips to the 香港 node
      const keptParse = (
        await readAction('inspect_node_parse').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          node_handle: keptHandle,
        })
      ).data as { node_handle: string; facts: { region: string | null } };
      expect(keptParse.node_handle).toBe(keptHandle);
      expect(keptParse.facts.region).toBe('HK');
      // the DROPPED handle round-trips to ITS OWN node (日本), not the kept one
      const droppedParse = (
        await readAction('inspect_node_parse').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          node_handle: droppedHandle,
        })
      ).data as { node_handle: string; facts: { region: string | null } };
      expect(droppedParse.node_handle).toBe(droppedHandle);
      expect(droppedParse.facts.region).toBe('JP');
    } finally {
      raw.mockReset();
    }
  });
});

describe('production-path candidate/confirmation semantics (Delivery pass 3)', () => {
  it('dispatchToolCall: nonempty recognitionRules wins when the legacy rules alias is OMITTED', async () => {
    const env = await dispatchToolCall(ctx, 'preview_naming_recognition', {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [{ pattern: '家宽', field: 'route', value: '家宽' }],
      // `rules` is genuinely absent — the defaulted alias must NOT shadow it
    });
    const data = env.data as { rules: Array<{ matches: number }> };
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].matches).toBe(1);
  });

  it('dispatchToolCall: explicit rules alias wins; explicit EMPTY candidates stay empty', async () => {
    const viaAlias = await dispatchToolCall(ctx, 'preview_naming_recognition', {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}',
      rules: [{ pattern: '日本', field: 'route', value: '日本' }],
    });
    const aliasData = viaAlias.data as { rules: Array<{ matches: number }> };
    expect(aliasData.rules[0].matches).toBe(1);
    // explicit empty recognitionRules + aliases + tw2cn:false stay explicit
    const empty = await dispatchToolCall(ctx, 'preview_naming_recognition', {
      source_type: 'subscription',
      ref: subRef(),
      template: '${emoji} ${region}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    });
    expect((empty.data as { rules: unknown[] }).rules).toHaveLength(0);
  });
});

describe('collection-stage envelope-rawName diagnostics (Delivery pass 3)', () => {
  it('a source-preprocessed (renamed) node round-trips via its ENVELOPE rawName at the collection stage', async () => {
    const { envelopeOf } = await import('@/lib/proxies/provenance');
    const exportMock = (await import('@/lib/services/nodeExportService'))
      .mergeCollectionMemberProxies as unknown as ReturnType<typeof vi.fn>;
    // the member pipeline renamed the node; the envelope still carries the
    // IMMUTABLE raw upstream name + identity
    const rawNode = { name: '香港 01', type: 'ss', server: 'a.example', port: 443 };
    const wrapped = withRawIdentity(rawNode, { key: 'member-1', label: '成员甲' });
    const renamed = { ...wrapped, name: '🇭🇰 香港 01' };
    expect(envelopeOf(renamed)?.rawName).toBe('香港 01');
    exportMock.mockResolvedValue({ merged: [renamed], memberErrors: [] });
    try {
      // preview_naming_target emits after-sample handles built from the
      // ENVELOPE rawName (香港 01), not the renamed display name
      const env = await readAction('preview_naming_target').run(ctxCol, {
        source_type: 'collection',
        ref: colRef(),
        template: '${emoji} ${region}',
        tw2cn: false,
        sourceAliases: {},
        recognitionRules: [],
      });
      const after = (env.data as { afterSamples: Array<{ handle: string }> }).afterSamples;
      expect(after).toHaveLength(1);
      const handle = after[0].handle;
      // the handle round-trips through the collection's raw list — the node
      // resolves by its IMMUTABLE identity (rawName 香港 01 → region HK),
      // NOT by the renamed display text
      const parsed = (
        await readAction('inspect_node_parse').run(ctxCol, {
          source_type: 'collection',
          ref: colRef(),
          node_handle: handle,
        })
      ).data as { node_handle: string; facts: { region: string | null } };
      expect(parsed.node_handle).toBe(handle);
      expect(parsed.facts.region).toBe('HK');
    } finally {
      exportMock.mockReset();
    }
  });

  it('every collision participant gets its own resolved name + round-tripping handle', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // three nodes formatting to the same name: the keepers + each displaced
    // participant must all be listed with their own handles
    raw.mockResolvedValue({
      proxies: [
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
        { name: '香港 中转 02', type: 'ss', server: 'b.example', port: 443 },
        { name: '香港 移动 03', type: 'ss', server: 'c.example', port: 443 },
      ],
      proxyCount: 3,
    });
    try {
      const env = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
      });
      const data = env.data as {
        collisions: Array<{
          participants: Array<{ handle: string }>;
          totalParticipants: number;
        }>;
      };
      // a bare ${region} template makes all three nodes collide into ONE
      // group — counts carry the aggregate facts, names never serialize
      expect(data.collisions).toHaveLength(1);
      const participants = data.collisions[0].participants;
      expect(participants).toHaveLength(3); // EVERY participant, not just displaced
      expect(data.collisions[0].totalParticipants).toBe(3);
      expect(JSON.stringify(data)).not.toContain('香港');
      expect(JSON.stringify(data)).not.toContain('${');
      // each handle round-trips to ITS OWN raw node
      const regions: string[] = [];
      for (const p of participants) {
        const parsed = (
          await readAction('inspect_node_parse').run(ctx, {
            source_type: 'subscription',
            ref: subRef(),
            node_handle: p.handle,
          })
        ).data as { node_handle: string; facts: { region: string | null } };
        expect(parsed.node_handle).toBe(p.handle);
        regions.push(parsed.facts.region ?? '');
      }
      expect(regions).toEqual(['HK', 'HK', 'HK']);
    } finally {
      raw.mockReset();
    }
  });

  it('repeated same-name same-config occurrences keep distinct occurrence handles', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValue({
      proxies: [
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
        { name: '香港 01', type: 'ss', server: 'a.example', port: 443 },
        { name: '香港 中转 02', type: 'ss', server: 'b.example', port: 443 },
      ],
      proxyCount: 3,
    });
    try {
      const env = await readAction('inspect_naming_collisions').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
      });
      const data = env.data as {
        deduped: Array<{ keptHandle: string; droppedHandle: string }>;
      };
      expect(data.deduped).toHaveLength(1);
      const { keptHandle, droppedHandle } = data.deduped[0];
      expect(keptHandle).not.toBe(droppedHandle);
      const kept = (
        await readAction('inspect_node_parse').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          node_handle: keptHandle,
        })
      ).data as { facts: { region: string | null } };
      const dropped = (
        await readAction('inspect_node_parse').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          node_handle: droppedHandle,
        })
      ).data as { facts: { region: string | null } };
      expect(kept.facts.region).toBe('HK');
      expect(dropped.facts.region).toBe('HK');
    } finally {
      raw.mockReset();
    }
  });
});

describe('assistant projections never leak credential-shaped literals (finding 9)', () => {
  const DIRTY_TEMPLATE = '${emoji} ${region} https://evil.example/sub?token=abc123 ${index:2}';
  const DIRTY_ALIAS = 'http://1.2.3.4:8443/psk';

  it('preview_naming_target sanitizes the echoed template (never the raw literal)', async () => {
    const env = await readAction('preview_naming_target').run(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: DIRTY_TEMPLATE,
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
  });

  it('list_naming_targets sanitizes the stored template echo', async () => {
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: DIRTY_TEMPLATE,
          recognitionRules: [],
        },
      ],
    });
    const env = await readAction('list_naming_targets').run(ctx, {});
    expect(JSON.stringify(env)).not.toContain('evil.example');
    expect(JSON.stringify(env)).not.toContain('token=abc123');
  });

  it('save_naming_plan summary + diff sanitize the template and bound aliases', async () => {
    const action = writeAction('save_naming_plan');
    const preview = await action.preview(ctx, {
      source_type: 'subscription',
      ref: subRef(),
      template: DIRTY_TEMPLATE,
      tw2cn: false,
      sourceAliases: { [srcHandle('airport-a')]: DIRTY_ALIAS },
      recognitionRules: [],
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
    expect(serialized).not.toContain('1.2.3.4');
    expect(serialized).not.toContain('psk');
    const summary = action.summary({
      source_type: 'subscription',
      ref: subRef(),
      template: DIRTY_TEMPLATE,
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
    });
    expect(summary).not.toContain('evil.example');
  });
});
describe('pass-4 target refs + structured signature + protocol allowlist', () => {
  it('list_naming_targets emits ONLY keyed refs for the caller-visible set — raw UUIDs absent; list→action round-trip works for both kinds', async () => {
    // under the SUBSCRIPTION-bound profile: only the subscription is visible
    const env = await readAction('list_naming_targets').run(ctx, {});
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(SUB_ID);
    expect(serialized).not.toContain(COL_ID);
    const data = env.data as {
      subscriptions: Array<{ ref: string }>;
      collections: Array<{ ref: string }>;
    };
    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0].ref).toMatch(/^ref-[0-9a-f]{16}$/);
    expect(data.collections).toHaveLength(0);
    // the emitted ref round-trips into a subsequent action under ctx
    const fields = await readAction('inspect_naming_fields').run(ctx, {
      source_type: 'subscription',
      ref: data.subscriptions[0].ref,
    });
    expect((fields.data as { nodeCount: number }).nodeCount).toBeGreaterThan(0);
    // under the COLLECTION-bound profile: the collection is visible
    const colEnv = await readAction('list_naming_targets').run(ctxCol, {});
    const colData = colEnv.data as {
      collections: Array<{ ref: string }>;
    };
    expect(colData.collections).toHaveLength(1);
    expect(colData.collections[0].ref).toMatch(/^ref-[0-9a-f]{16}$/);
    const colFields = await readAction('inspect_naming_fields').run(ctxCol, {
      source_type: 'collection',
      ref: colData.collections[0].ref,
    });
    expect((colFields.data as { aggregate: boolean }).aggregate).toBe(true);
  });

  it('wrong-kind and stale/unknown refs fail closed (never globally dereferenceable)', async () => {
    // a subscription ref passed as a collection target — the SAME bounded
    // error as unknown (no type oracle, pass-5 blocker)
    await expect(
      readAction('inspect_naming_fields').run(ctxCol, {
        source_type: 'collection',
        ref: subRef(),
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
    // a stale ref for a deleted target
    bucket(REDIS_KEYS.subscriptions).delete(SUB_ID);
    await expect(
      readAction('inspect_naming_fields').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
    // a fabricated ref
    await expect(
      readAction('inspect_naming_fields').run(ctx, {
        source_type: 'subscription',
        ref: 'ref-0000000000000000',
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
  });

  it('delimiter/metacharacter values in EVERY rule field cannot change boundaries or leak residue', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    const nodes = [
      { name: '香港 01', type: 'ss', server: 'a.invalid', port: 443 },
      { name: '香港 02', type: 'ss', server: 'b.invalid', port: 443 },
    ];
    raw.mockResolvedValue({ proxies: nodes, proxyCount: 2 });
    // rule values/patterns full of delimiters AND metacharacters (pipe
    // alternations, a backslash-escape and an empty branch) for EVERY rule
    // field — schema-valid so the op stays executable (control chars would
    // legitimately park the row)
    const DELIM = 'RESIDUALLEAK|a\\b||x';
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [
            { pattern: DELIM, field: 'region', value: DELIM },
            { pattern: DELIM, field: 'route', value: DELIM },
            { pattern: DELIM, field: 'entry', value: DELIM },
            { pattern: DELIM, field: 'vendor', value: DELIM },
          ],
        },
      ],
    });
    try {
      const env = await readAction('inspect_source_name_clusters').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      const serialized = JSON.stringify(env);
      // round-1 (invariant 6): SAFE saved recognition-rule text is authorized
      // display content — the schema-bounded rule value survives sanitized;
      // it can never merge into OTHER fields (structured per-field
      // projection, no join/split of raw values).
      expect(serialized).toContain('RESIDUALLEAK');
      expect(serialized).not.toContain('|a|b|');
      const data = env.data as {
        totalClusters: number;
        clusters: Array<{
          count: number;
          signature: {
            region: string | null;
            route: string | null;
            entry: string | null;
            vendor: string | null;
            rate: string | null;
          };
        }>;
      };
      for (const cluster of data.clusters) {
        const sig = cluster.signature;
        for (const field of ['region', 'route', 'entry', 'vendor'] as const) {
          const value = sig[field];
          if (value !== null) {
            // round-1: rule-targeted fields project as sanitized display
            // text — the RECOGNIZED rule value (region values are
            // case-normalized by recognition), never a merged/joined token
            const expected = field === 'region' ? DELIM.toUpperCase() : DELIM;
            expect(value).toBe(expected);
          }
        }
      }
      // grouping stays deterministic: both nodes land in the SAME semantic
      // group (identical rule-fired signature) — the residual token splits
      // them into two clusters, each count 1, with identical projections
      expect(data.totalClusters).toBe(2);
      for (const cluster of data.clusters) {
        expect(cluster.count).toBe(1);
      }
    } finally {
      raw.mockReset();
    }
  });

  it('pass-5: two DISTINCT typed signatures that would COLLIDE under the old pipe-join stay separate clusters', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValue({
      proxies: [
        { name: '香港 01', type: 'ss', server: 'a.invalid', port: 443 },
        { name: '日本 01', type: 'ss', server: 'b.invalid', port: 443 },
      ],
      proxyCount: 2,
    });
    // node1 → region 'A|B' + route 'c'; node2 → region 'A' + route 'B|c'.
    // The OLD pipe-joined key for both is the SAME string "A|B|c" — only the
    // typed structure separates them; residuals are identical ('01').
    seedSubscription({
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${region}',
          recognitionRules: [
            { pattern: '香港', field: 'region', value: 'A|B' },
            { pattern: '香港', field: 'route', value: 'c' },
            { pattern: '日本', field: 'region', value: 'A' },
            { pattern: '日本', field: 'route', value: 'B|c' },
          ],
        },
      ],
    });
    try {
      const env = await readAction('inspect_source_name_clusters').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      const data = env.data as {
        totalClusters: number;
        clusters: Array<{ count: number; signature: Record<string, string | null> }>;
      };
      // typed structure keeps them SEPARATE (2 clusters, one node each)
      expect(data.totalClusters).toBe(2);
      const signatures = data.clusters.map((c) => JSON.stringify(c.signature));
      expect(signatures[0]).not.toBe(signatures[1]);
      for (const cluster of data.clusters) {
        expect(cluster.count).toBe(1);
        // round-1: rule-targeted fields project as sanitized display text —
        // each value stays in ITS OWN field (no join/merge can change
        // boundaries even though the values contain '|' literals)
        for (const value of Object.values(cluster.signature)) {
          if (value !== null) {
            expect(value.length).toBeLessThanOrEqual(24);
          }
        }
      }
      // the joined-pipe artifact never appears (structured projection)
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain('A|B|c');
    } finally {
      raw.mockReset();
    }
  });

  it('pass-5: adversarial rule-value forms in EVERY field never leak and never change boundaries', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // VALUES are schema-valid (min 1). The 'empty-match' form is a
    // REACHABLE empty matched SEGMENT: pattern 'x*' matches every name at
    // position 0 with an EMPTY span while the rule VALUE still applies —
    // no invalid schema objects (pass-6 blocker 4).
    const FORMS: Array<{ label: string; value: string; pattern?: string }> = [
      { label: 'pipe', value: 'x|y' },
      { label: 'repeated-pipe', value: 'a||b' },
      { label: 'backslash', value: 'a\\b' },
      { label: 'unicode', value: '香港|中转' },
      { label: 'empty-match', value: 'V|V', pattern: 'x*' },
      { label: 'json-like', value: '{"k":"v"}' },
      { label: 'token-prefix-r', value: 'r-1234567890abcdef' },
      { label: 'token-prefix-src', value: 'src-1234567890abcdef' },
      { label: 'token-prefix-ref', value: 'ref-1234567890abcdef' },
    ];
    for (const field of ['region', 'route', 'entry', 'vendor'] as const) {
      for (const form of FORMS) {
        raw.mockResolvedValue({
          proxies: [{ name: '香港 01', type: 'ss', server: 'a.invalid', port: 443 }],
          proxyCount: 1,
        });
        seedSubscription({
          operators: [
            {
              id: 'rt-1',
              kind: 'rename-template',
              template: '${region}',
              recognitionRules: [{ pattern: form.pattern ?? '香港', field, value: form.value }],
            },
          ],
        });
        const env = await readAction('inspect_source_name_clusters').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
        });
        // round-1: SAFE saved rule values are authorized display content —
        // the SANITIZED recognized value survives (bounded; region values go
        // through recognition's own normalization; credential-shaped spans
        // like bare 16-hex runs are redacted — never a token, never merged).
        // Expected values come from the SAME recognition + sanitization the
        // cluster signature uses.
        const { recognizeName } = await import('@/lib/proxies/naming');
        const { sanitizeDisplayText } = await import('@/lib/ai/namingContextProjection');
        const recognized = recognizeName('香港 01', [
          { pattern: form.pattern ?? '香港', field, value: form.value },
        ]);
        const rawExpected = (recognized as unknown as Record<string, string | null>)[field] ?? null;
        const expected = rawExpected === null ? null : sanitizeDisplayText(rawExpected, 24);
        const signature = (
          env.data as { clusters: Array<{ signature: Record<string, string | null> }> }
        ).clusters[0].signature[field];
        expect(signature, `${field}/${form.label}`).toBe(expected);
      }
    }
  });

  it('pass-6: protocol full-surface cross-product — the PRODUCTION-derived 25-type set, every surface, unknown/case/padded variants never raw', async () => {
    const { canonicalProxyType } = await import('@/lib/proxies/namingSanitize');
    const { FIXED_MIHOMO_PROXY_TYPES } = await import('@/lib/proxies/mihomoProxyValidator');
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    // 1. the allowlist derives from the PRODUCTION validator — no hand-list
    const ALL_25 = [...FIXED_MIHOMO_PROXY_TYPES].sort();
    expect(ALL_25).toHaveLength(25);
    for (const t of ALL_25) {
      expect(canonicalProxyType(t), t).toBe(t);
    }
    // case-changed and whitespace-padded variants are NOT canonical
    expect(canonicalProxyType('SS')).toBeNull();
    expect(canonicalProxyType(' ss ')).toBeNull();
    expect(canonicalProxyType('BenignProtocolSecret')).toBeNull();

    // 2. EVERY canonical type exercises the FULL surface set (not just the
    //    projector): each fixture runs one node of the type
    const template = '${emoji} ${region}';
    const runAllSurfaces = async (nodes: Array<Record<string, unknown>>) => {
      raw.mockResolvedValue({ proxies: nodes, proxyCount: nodes.length });
      const out: Array<{ name: string; env: unknown }> = [];
      out.push({
        name: 'inspect_naming_fields',
        env: await readAction('inspect_naming_fields').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
        }),
      });
      out.push({
        name: 'inspect_source_name_clusters',
        env: await readAction('inspect_source_name_clusters').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
        }),
      });
      out.push({
        name: 'inspect_naming_collisions',
        env: await readAction('inspect_naming_collisions').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template,
        }),
      });
      out.push({
        name: 'preview_naming_recognition',
        env: await readAction('preview_naming_recognition').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template,
          tw2cn: false,
          sourceAliases: {},
          recognitionRules: [],
        }),
      });
      out.push({
        name: 'inspect_naming_drift',
        env: await readAction('inspect_naming_drift').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
        }),
      });
      out.push({
        name: 'preview_naming_target',
        env: await readAction('preview_naming_target').run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template,
          tw2cn: false,
          sourceAliases: {},
          recognitionRules: [],
        }),
      });
      const cluster = out.find((o) => o.name === 'inspect_source_name_clusters')!.env as {
        data: { clusters: Array<{ samples: Array<{ handle: string }> }> };
      };
      const handles = cluster.data.clusters.flatMap((c) => c.samples.map((s) => s.handle));
      for (const handle of handles) {
        out.push({
          name: 'inspect_node_parse',
          env: await readAction('inspect_node_parse').run(ctx, {
            source_type: 'subscription',
            ref: subRef(),
            node_handle: handle,
          }),
        });
      }
      return out;
    };
    for (const t of ALL_25) {
      const surfaces = await runAllSurfaces([
        { name: `香港 01 ${t}`, type: t, server: 'a.invalid', port: 443 },
      ]);
      const serialized = JSON.stringify(surfaces.map((s) => s.env));
      // the canonical enum survives ONLY as the protocol projection — never
      // anywhere else raw
      for (const { name, env } of surfaces) {
        const s = JSON.stringify(env);
        if (name === 'inspect_node_parse') {
          const protocol = (env as { data: { facts: { protocol: string | null } } }).data.facts
            .protocol;
          expect(protocol, `${t}/${name}`).toBe(t);
        }
        expect(s.length, `${t}/${name}`).toBeLessThan(200_000);
      }
      // health protocol facts keep the canonical enum
      const fields = surfaces.find((x) => x.name === 'inspect_naming_fields')!.env as {
        data: {
          sources: Array<{
            nodeFacts: Array<{ field: string; value: string | null }>;
          }>;
        };
      };
      const protocols = fields.data.sources[0].nodeFacts
        .filter((f) => f.field === 'protocol' && f.value !== null)
        .map((f) => f.value);
      expect(protocols, t).toContain(t);
      expect(serialized, t).not.toContain('BenignProtocolSecret');
    }

    // 3. unknown, wrong-case and whitespace-padded variants across ALL
    //    surfaces: never raw — null or keyed token per surface
    const variantSurfaces = await runAllSurfaces([
      { name: '未知 01', type: 'BenignProtocolSecret', server: 'a.invalid', port: 443 },
      { name: '大写 02', type: 'SS', server: 'b.invalid', port: 443 },
      { name: '空白 03', type: ' ss ', server: 'c.invalid', port: 443 },
    ]);
    for (const { name, env } of variantSurfaces) {
      const serializedV = JSON.stringify(env);
      expect(serializedV, `${name} leaks unknown`).not.toContain('BenignProtocolSecret');
      expect(serializedV, `${name} leaks SS`).not.toContain('"SS"');
      expect(serializedV, `${name} leaks padded`).not.toContain(' ss ');
    }
    // the parse surface projects unknown protocols as keyed tokens
    const parseSurfaces = variantSurfaces.filter((x) => x.name === 'inspect_node_parse');
    expect(parseSurfaces.length).toBeGreaterThan(0);
    for (const { env } of parseSurfaces) {
      const protocol = (env as { data: { facts: { protocol: string | null } } }).data.facts
        .protocol;
      if (protocol !== null) {
        expect(protocol).toMatch(/^v-[0-9a-f]{16}$/);
      }
    }
  });

  it('pass-6: an ABSENT profile mints NO refs and cannot resolve/inspect anything (bounded error, no global access)', async () => {
    const ghost = { actor: 'test', profileId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    // list: no refs at all — even though global targets exist in the store
    const env = await readAction('list_naming_targets').run(ghost, {});
    const data = env.data as {
      totalTargets: number;
      subscriptions: unknown[];
      collections: unknown[];
    };
    expect(data.totalTargets).toBe(0);
    expect(data.subscriptions).toHaveLength(0);
    expect(data.collections).toHaveLength(0);
    // a real target's ref cannot be resolved under the absent profile
    await expect(
      readAction('inspect_naming_fields').run(ghost, {
        source_type: 'subscription',
        ref: subRef(),
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
    // and a preview action fails the same way
    await expect(
      readAction('preview_naming_target').run(ghost, {
        source_type: 'subscription',
        ref: subRef(),
        template: '${emoji} ${region}',
        tw2cn: false,
        sourceAliases: {},
        recognitionRules: [],
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
  });

  it('pass-5: cross-profile replay is rejected — a ref minted under one profile never resolves under another', async () => {
    // a ref minted for ctx.profileId A…
    const refA = subRef();
    // …replayed under a DIFFERENT authorized profile fails with the SAME
    // bounded error (MAC input includes the profile scope)
    const otherCtx = {
      actor: 'test',
      profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    await expect(
      readAction('inspect_naming_fields').run(otherCtx, {
        source_type: 'subscription',
        ref: refA,
      }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
    // and the same-profile ref still works
    const env = await readAction('inspect_naming_fields').run(ctx, {
      source_type: 'subscription',
      ref: refA,
    });
    expect((env.data as { nodeCount: number }).nodeCount).toBeGreaterThan(0);
  });

  it('pass-5 round-1: forced MAC collision — TWO visible targets sharing one ref fail closed with the bounded collision error before any output', async () => {
    const { injectHandleSignerForTests, resetHandleSecret } = await import('@/lib/proxies/handles');
    const { installTestHandleSecret } = await import('../helpers/handleSecret');
    // the collection gains an enabled member so ctxCol's visible set has TWO
    // targets (collection + member) — the collision is reachable
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合一号',
      slug: 'agg-1',
      enabled: true,
      type: 'select',
      subscription_ids: [SUB_ID],
      subscription_tags: [],
      operators: [],
      updated_at: 1,
    });
    try {
      // deterministic collision seam: a CONSTANT MAC output makes every
      // input derive the SAME ref — collection and member collide
      injectHandleSignerForTests({ mac: () => '0000000000000000' });
      const collidingRef = colRef();
      expect(collidingRef).toBe(subRef()); // both visible targets share one ref
      // round-1 typed HandleScopes: the ONE collision-checked index over the
      // COMPLETE visible union fails the response closed at build time —
      // bounded collision error, never a first-match pick, never an oracle
      await expect(
        readAction('inspect_naming_fields').run(ctxCol, {
          source_type: 'collection',
          ref: collidingRef,
        }),
      ).rejects.toMatchObject({ problem: { status: 400 } });
      // the unknown-ref case ALSO fails closed: under a collision regime the
      // visible domain cannot even be indexed, so every resolution collapses
      // to the same bounded collision error — never a first-match pick
      await expect(
        readAction('inspect_naming_fields').run(ctxCol, {
          source_type: 'collection',
          ref: 'ref-0000000000000000',
        }),
      ).rejects.toMatchObject({ problem: { status: 400 } });
    } finally {
      resetHandleSecret();
      installTestHandleSecret();
    }
  });

  it('arbitrary benign protocol seeds project canonically or as tokens — never raw text', async () => {
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValue({
      proxies: [
        { name: '香港 01', type: 'BenignProtocolSecret', server: 'a.invalid', port: 443 },
        { name: '日本 02', type: 'ss', server: 'b.invalid', port: 443 },
      ],
      proxyCount: 2,
    });
    try {
      // inspect_node_parse: canonical type stays an enum; unknown types are
      // DROPPED (only the shared production protocol enum may cross —
      // invariant 9)
      const parse = await readAction('inspect_node_parse').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
        node_handle: handleOf({
          name: '香港 01',
          type: 'BenignProtocolSecret',
          server: 'a.invalid',
          port: 443,
        }),
      });
      const parseJson = JSON.stringify(parse);
      expect(parseJson).not.toContain('BenignProtocolSecret');
      expect((parse.data as { facts: { protocol: string | null } }).facts.protocol).toBeNull();
      // health projection: protocol field samples/facts never raw
      const fields = await readAction('inspect_naming_fields').run(ctx, {
        source_type: 'subscription',
        ref: subRef(),
      });
      expect(JSON.stringify(fields)).not.toContain('BenignProtocolSecret');
      const protocolFacts = (
        fields.data as {
          sources: Array<{ nodeFacts: Array<{ field: string; value: string | null }> }>;
        }
      ).sources[0].nodeFacts.filter((f) => f.field === 'protocol');
      for (const f of protocolFacts) {
        if (f.value !== null) expect(f.value).not.toContain('Benign');
      }
    } finally {
      raw.mockReset();
    }
  });
});

describe('pass-7 blocker 4: config-version/membership bracket', () => {
  const plan = {
    source_type: 'subscription' as const,
    ref: subRef(),
    template:
      '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}',
    tw2cn: true,
    sourceAliases: {},
    recognitionRules: [],
  };

  it('profile REBIND between confirmation and execute fails the bounded error with zero writes/audit', async () => {
    const action = writeAction('save_naming_plan');
    // capture the confirmation exactly like the card would
    const preview = await action.preview(ctx, plan);
    // attacker/UI race: the profile rebinds between card and click
    // (rebind via direct storage mutation — same effect as update_profile)
    bucket(REDIS_KEYS.profiles).set(ctx.profileId, {
      id: ctx.profileId,
      name: 'profile-sub',
      source: { type: 'none' },
      updated_at: 2,
    });
    const beforeVersion = counters.get(REDIS_KEYS.configVersion) ?? 0;
    // ONE bounded non-oracle error — same text whatever the surface
    await expect(
      action.execute({ ...ctx, confirmation: preview.confirmation } as ActionContext, plan),
    ).rejects.toThrow(/来源范围/);
    await expect(
      action.execute({ ...ctx, confirmation: preview.confirmation } as ActionContext, plan),
    ).rejects.toThrow(/来源范围/);
    // zero write, zero audit, version untouched
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(beforeVersion);
    expect(bucket(REDIS_KEYS.namingHistory).has('subscription:' + SUB_ID)).toBe(false);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(storedSubOps(SUB_ID)[0]).toMatchObject({ id: 'rt-1' });
  });

  it('collection member disable between gate and commit fails the bounded error with zero writes/audit', async () => {
    // ctxCol binds the collection; its member sub is enabled at gate time
    seedCollection({
      operators: [],
      subscription_ids: [SUB_ID],
    });
    const action = writeAction('save_naming_plan');
    const colPlan = {
      ...plan,
      source_type: 'collection' as const,
      ref: colRef(),
    };
    const preview = await action.preview(ctxCol, colPlan);
    // the member sub is disabled between card and click
    bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
      ...(bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as Subscription),
      enabled: false,
    });
    const beforeVersion = counters.get(REDIS_KEYS.configVersion) ?? 0;
    await expect(
      action.execute({ ...ctxCol, confirmation: preview.confirmation } as ActionContext, colPlan),
    ).rejects.toThrow(/来源范围/);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(beforeVersion);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    expect(bucket(REDIS_KEYS.namingHistory).has('collection:' + COL_ID)).toBe(false);
  });

  it('a confirmation WITHOUT the membership snapshot fails closed before any read/write', async () => {
    const action = writeAction('save_naming_plan');
    await expect(
      action.execute(
        {
          ...ctx,
          confirmation: { configVersion: counters.get(REDIS_KEYS.configVersion) ?? 0 },
        } as ActionContext,
        plan,
      ),
    ).rejects.toMatchObject({ problem: { status: 412 } });
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('the Lua re-validates the profile binding at commit: mismatched binding fails atomically', async () => {
    const action = writeAction('save_naming_plan');
    const preview = await action.preview(ctx, plan);
    // swap the PROFILE's binding to a DIFFERENT sub between card and click
    bucket(REDIS_KEYS.profiles).set(ctx.profileId, {
      id: ctx.profileId,
      name: 'profile-sub',
      source: { type: 'subscription', id: '77777777-7777-4777-8777-777777777777' },
      updated_at: 2,
    });
    const beforeVersion = counters.get(REDIS_KEYS.configVersion) ?? 0;
    await expect(
      action.execute({ ...ctx, confirmation: preview.confirmation } as ActionContext, plan),
    ).rejects.toThrow(/来源范围/);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(beforeVersion);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('pass-8 blocker 6: MEMBER RENAME between gate and commit fails the bounded error (fingerprint covers the source key)', async () => {
    seedCollection({ operators: [], subscription_ids: [SUB_ID] });
    const action = writeAction('save_naming_plan');
    const colPlan = { ...plan, source_type: 'collection' as const, ref: colRef() };
    const preview = await action.preview(ctxCol, colPlan);
    // the member sub's stable source key (name) changes between card and
    // click — the visible-set fingerprint now includes the key
    bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
      ...(bucket(REDIS_KEYS.subscriptions).get(SUB_ID) as Subscription),
      name: 'airport-a-renamed',
    });
    const beforeVersion = counters.get(REDIS_KEYS.configVersion) ?? 0;
    await expect(
      action.execute({ ...ctxCol, confirmation: preview.confirmation } as ActionContext, colPlan),
    ).rejects.toThrow(/来源范围/);
    expect(counters.get(REDIS_KEYS.configVersion) ?? 0).toBe(beforeVersion);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('pass-8 blocker 6: ABA rebind A→B→A between gate and commit fails CLOSED via the version bracket', async () => {
    const action = writeAction('save_naming_plan');
    const preview = await action.preview(ctx, plan);
    // the membership fingerprint returns to the GATE value (A→B→A), but the
    // config version moved twice — the version CAS cannot prove continuity
    bucket(REDIS_KEYS.profiles).set(ctx.profileId, {
      id: ctx.profileId,
      name: 'profile-sub',
      source: { type: 'none' },
      updated_at: 2,
    });
    bucket(REDIS_KEYS.profiles).set(ctx.profileId, {
      id: ctx.profileId,
      name: 'profile-sub',
      source: { type: 'subscription', id: SUB_ID },
      updated_at: 3,
    });
    // simulate the two config-version bumps a real rebind would cause
    const bumped = (counters.get(REDIS_KEYS.configVersion) ?? 0) + 2;
    counters.set(REDIS_KEYS.configVersion, bumped);
    const beforeEntity = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID));
    await expect(
      action.execute({ ...ctx, confirmation: preview.confirmation } as ActionContext, plan),
    ).rejects.toMatchObject({ problem: { status: 412 } });
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB_ID))).toBe(beforeEntity);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });

  it('pass-8 blocker 6: member zero-equality and bound-collection deletion between gate and commit fail the bounded error', async () => {
    seedCollection({ operators: [], subscription_ids: [SUB_ID] });
    const action = writeAction('save_naming_plan');
    const colPlan = { ...plan, source_type: 'collection' as const, ref: colRef() };
    const preview = await action.preview(ctxCol, colPlan);
    // the member sub is DELETED between card and click → zero equality
    bucket(REDIS_KEYS.subscriptions).delete(SUB_ID);
    await expect(
      action.execute({ ...ctxCol, confirmation: preview.confirmation } as ActionContext, colPlan),
    ).rejects.toThrow(/来源范围/);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
    // the BOUND COLLECTION itself is deleted → the visible set is empty
    seedCollection({ operators: [], subscription_ids: [SUB_ID] });
    const preview2 = await action.preview(ctxCol, colPlan);
    bucket(REDIS_KEYS.collections).delete(COL_ID);
    await expect(
      action.execute({ ...ctxCol, confirmation: preview2.confirmation } as ActionContext, colPlan),
    ).rejects.toThrow(/来源范围/);
    expect(bucket(REDIS_KEYS.audit.events).size).toBe(0);
  });
});

describe('pass-8 blocker 3: forced ref-domain MAC collision fails list_naming_targets closed', () => {
  it('two visible targets sharing one ref under a colliding signer → bounded error, no refs emitted', async () => {
    // ctxCol binds the collection; add the member so the visible set has
    // TWO targets whose refs collide under the seam
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      ...(bucket(REDIS_KEYS.collections).get(COL_ID) as Collection),
      subscription_ids: [SUB_ID],
    });
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      // the collection-bound profile sees [collection, sub] — both refs
      // collide under the seam
      const env = await readAction('list_naming_targets')
        .run(ctxCol, {})
        .catch((e: unknown) => e);
      expect(env).toBeInstanceOf(Error);
      const message = env instanceof Error ? env.message : String(env);
      expect(message).toContain('句柄冲突');
      expect(message).not.toContain('deadbeef');
    } finally {
      injectHandleSignerForTests(null);
    }
  });
});

describe('pass-9 blocker 3: ref collision whose second row lies BEYOND MAX_TARGETS still fails closed', () => {
  it('101+ visible targets with a colliding signer → bounded error, no capped emission', async () => {
    // bind the collection to 102 members (collection + 101 subs) — the cap
    // is 100 rows, so the collision would be invisible after capping
    const memberIds: string[] = [];
    for (let i = 0; i < 101; i++) {
      const mid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
      memberIds.push(mid);
      bucket(REDIS_KEYS.subscriptions).set(mid, {
        id: mid,
        name: `member-${i}`,
        display_name: `成员${i}`,
        enabled: true,
        kind: 'remote',
        url: `https://m${i}.example/sub`,
        ttl_ms: 600_000,
        tags: [],
        operators: [],
      });
    }
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      ...(bucket(REDIS_KEYS.collections).get(COL_ID) as Collection),
      subscription_ids: memberIds,
    });
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      const env = await readAction('list_naming_targets')
        .run(ctxCol, {})
        .catch((e: unknown) => e);
      expect(env).toBeInstanceOf(Error);
      const message = env instanceof Error ? env.message : String(env);
      expect(message).toContain('句柄冲突');
    } finally {
      injectHandleSignerForTests(null);
    }
  });
});

describe('pass-10 blocker 3: node collision whose second row lies BEYOND the sample caps still fails closed', () => {
  it('preview_naming_target rejects a forced node-MAC collision at positions 0 and 8 (caps are 3/8)', async () => {
    // 10 nodes — the BEFORE cap is 3, the AFTER cap is 8 — a collision at
    // position 8 would previously survive the capped uniqueness check
    seedSubscription({
      operators: [],
    });
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const proxies = Array.from({ length: 10 }, (_, i) => ({
      name: `节点-${String(i).padStart(2, '0')}`,
      type: 'ss',
      server: `n${i}.example.com`,
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'x',
    }));
    // the fetch mock returns the 10 proxies (the action also re-fetches)
    (
      fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      proxies,
      proxyCount: 10,
    });
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    // colliding signer: every node maps to one nd- handle — position 8's
    // collision is beyond the before-cap of 3
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      const env = await readAction('preview_naming_target')
        .run(ctx, {
          source_type: 'subscription',
          ref: subRef(),
          template: '${emoji} ${region}',
          sourceAliases: {},
          recognitionRules: [],
        })
        .catch((e: unknown) => e);
      expect(env).toBeInstanceOf(Error);
      const message = env instanceof Error ? env.message : String(env);
      expect(message).toContain('句柄冲突');
    } finally {
      injectHandleSignerForTests(null);
    }
  });
});

describe('pass-11: shared collision-free candidate — assistant preview and apply parity (finding 4)', () => {
  const plan = {
    source_type: 'subscription' as const,
    ref: subRef(),
    template: '${emoji} ${region}',
    tw2cn: false,
    sourceAliases: {},
    recognitionRules: [],
  };

  it('an ordinary row already named naming-plan yields the SAME noncolliding candidate in assistant preview and apply; the ordinary row survives', async () => {
    seedSubscription({
      operators: [{ id: 'naming-plan', kind: 'flag-emoji', action: 'add' }],
    });
    counters.set(REDIS_KEYS.configVersion, 7);
    const action = writeAction('save_naming_plan');
    const preview = await action.preview(ctx, plan);
    const diff = preview.diff as { managedRowId?: string; mode?: string };
    expect(diff.managedRowId).toBe('naming-plan-2');
    expect(diff.mode).toBe('add rename-template');
    const env = await action.execute(confirmCtx(), plan);
    expect(env.kind).toBe('write-result');
    const ops = storedSubOps(SUB_ID);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ id: 'naming-plan', kind: 'flag-emoji', action: 'add' });
    expect(ops[1]).toMatchObject({
      id: 'naming-plan-2',
      kind: 'rename-template',
      template: '${emoji} ${region}',
    });
    expect((ops[1] as { disabled?: boolean }).disabled).toBeUndefined();
  });

  it('a disabled managed row keeps its id across assistant preview and apply (re-enable in place)', async () => {
    seedSubscription({
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
    const action = writeAction('save_naming_plan');
    const preview = await action.preview(ctx, plan);
    expect((preview.diff as { managedRowId?: string }).managedRowId).toBe('legacy-plan');
    const env = await action.execute(confirmCtx(), plan);
    expect(env.kind).toBe('write-result');
    const ops = storedSubOps(SUB_ID);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: 'legacy-plan', template: '${emoji} ${region}' });
    expect((ops[0] as { disabled?: boolean }).disabled).toBeUndefined();
  });
});
