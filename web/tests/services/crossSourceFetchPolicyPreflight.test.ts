/**
 * Cross-source fetch-failure policy at the REAL save gate (Behavior 5).
 *
 * Reproduction: a profile is bound to a collection whose members are the
 * edited LOCAL source and an unrelated tolerant remote member (`mitce`).
 * Saving the local source must commit when mitce's fresh response is an
 * eligible fetch failure and either a validated last-known-good cache or a
 * final-valid partial collection remains; the strict counterpart must block
 * with fixed 422/503 and leave the row + config version untouched; an invalid
 * edited local candidate always blocks.
 *
 * The pipeline is real end-to-end (replaceSubscription → save gate →
 * preflightProfileConfig → resolveConfig → fetcher). Only storage repos, the
 * fetch cache and the network are injected: typed bad bytes arrive through
 * globalThis.fetch with no live upstream.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Collection, Profile, Subscription } from '@/schemas';
import { ConfigPreflightUnavailableError, ConfigValidationError } from '@/lib/config/errors';

const mocks = vi.hoisted(() => ({
  getBase: vi.fn(),
  getConfigVersion: vi.fn(),
  getOrdinalGeneration: vi.fn(),
  getProfile: vi.fn(),
  getSubscription: vi.fn(),
  getSubscriptionByName: vi.fn(),
  listCollections: vi.fn(),
  listDevices: vi.fn(),
  listProfiles: vi.fn(),
  listProxyGroups: vi.fn(),
  listProxyGroupTemplates: vi.fn(),
  listRules: vi.fn(),
  listRuleSets: vi.fn(),
  listSubscriptions: vi.fn(),
  getFetchCache: vi.fn(),
  setFetchCache: vi.fn(),
  commitSubscriptionChange: vi.fn(),
  commitSubscriptionDelete: vi.fn(),
  recordSubscriptionFetchHealth: vi.fn(),
  getSubscriptionFetchHealth: vi.fn(),
  getSubscriptionFetchHealthMany: vi.fn(),
  readOrdinalStore: vi.fn(),
  setResolvedSnapshot: vi.fn(async () => undefined),
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));

/** Real in-memory Redis state for the serving render-cache no-write oracle. */
const renderRedis = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const client = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => values.get(key) ?? null)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (values.delete(key)) deleted += 1;
      }
      return deleted;
    }),
  };
  return { values, client };
});

/** Mutable ordinal-store state the readOrdinalStore mock serves (F5). */
const ordinalAssignments = new Map<string, Map<string, string>>();
const ordinalCounters = new Map<string, number | null>();

function ordinalStoreState(): {
  assignments: Map<string, Map<string, string>>;
  counters: Map<string, number | null>;
} {
  return {
    assignments: new Map([...ordinalAssignments].map(([k, v]) => [k, new Map(v)])),
    counters: new Map(ordinalCounters),
  };
}

function seedOrdinalStore(): void {
  ordinalAssignments.clear();
  ordinalCounters.clear();
  ordinalAssignments.set('local-edit', new Map([['fp-existing', '7']]));
  ordinalCounters.set('node-ordinal-counter:local-edit', 7);
  mocks.readOrdinalStore.mockImplementation(async (sourceKeys: string[]) => ({
    assignments: new Map(sourceKeys.map((key) => [key, ordinalAssignments.get(key) ?? new Map()])),
    invalidFields: new Map(sourceKeys.map((key) => [key, new Set()])),
    duplicateSources: new Set(),
    counters: new Map(sourceKeys.map((key) => [key, ordinalCounters.get(key) ?? null])),
    hashBroken: false,
    counterBroken: new Set(),
    hlenBySource: new Map(sourceKeys.map((key) => [key, 0])),
    globalSize: 0,
    generation: 0,
  }));
}

vi.mock('@/lib/repos/baseRepo', () => ({ getBase: mocks.getBase }));
vi.mock('@/lib/redis/client', () => ({ getRedis: () => renderRedis.client }));
vi.mock('@/lib/repos/configVersionRepo', () => ({
  getConfigVersion: mocks.getConfigVersion,
}));
vi.mock('@/lib/repos/nodeOrdinalRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/nodeOrdinalRepo')>();
  return {
    ...actual,
    getOrdinalGeneration: mocks.getOrdinalGeneration,
    readOrdinalStore: mocks.readOrdinalStore,
  };
});
vi.mock('@/lib/repos/profilesRepo', () => ({
  getProfile: mocks.getProfile,
  listProfiles: mocks.listProfiles,
}));
vi.mock('@/lib/repos/collectionsRepo', () => ({
  listCollections: mocks.listCollections,
}));
vi.mock('@/lib/repos/devicesRepo', () => ({ listDevices: mocks.listDevices }));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({
  listProxyGroups: mocks.listProxyGroups,
}));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({
  listProxyGroupTemplates: mocks.listProxyGroupTemplates,
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: mocks.listRuleSets }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  getSubscription: mocks.getSubscription,
  getSubscriptionByName: mocks.getSubscriptionByName,
  listSubscriptions: mocks.listSubscriptions,
  commitSubscriptionChange: mocks.commitSubscriptionChange,
  commitSubscriptionDelete: mocks.commitSubscriptionDelete,
}));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  setResolvedSnapshot: mocks.setResolvedSnapshot,
  invalidateResolvedSnapshot: mocks.invalidateResolvedSnapshot,
}));
vi.mock('@/lib/repos/fetchCacheRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/fetchCacheRepo')>();
  return {
    ...actual,
    getFetchCache: mocks.getFetchCache,
    setFetchCache: mocks.setFetchCache,
  };
});
vi.mock('@/lib/repos/subscriptionFetchHealthRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/subscriptionFetchHealthRepo')>();
  return {
    ...actual,
    recordSubscriptionFetchHealth: mocks.recordSubscriptionFetchHealth,
    getSubscriptionFetchHealth: mocks.getSubscriptionFetchHealth,
    getSubscriptionFetchHealthMany: mocks.getSubscriptionFetchHealthMany,
  };
});

import { replaceSubscription } from '@/lib/services/subscriptionService';

/**
 * Mutable in-memory storage: the subscription hash + config:version counter.
 * The commit mock applies real CAS semantics (write + bump under the expected
 * version), so success/failure evidence is measured against actual stored
 * before/after state — never fixed mock returns.
 */
const subscriptionRows = new Map<string, Subscription>();
let versionCounter = 7;

function storageState(): { rows: Subscription[]; version: number } {
  return { rows: [...subscriptionRows.values()], version: versionCounter };
}

const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const MITCE_ID = '22222222-2222-4222-8222-222222222222';
const COLLECTION_ID = '33333333-3333-4333-8333-333333333333';

const BASE = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct
proxy-groups:
  - name: 默认
    type: select
    proxies: [直连]
rules:
  - MATCH,默认
`;

const SS_NODE = {
  name: 'HK-01',
  type: 'ss',
  server: 'hk.example',
  port: 8388,
  cipher: 'aes-128-gcm',
  password: 'pw',
};

const LOCAL_CONTENT = stringify({ proxies: [SS_NODE] }, { lineWidth: 0 });

function localSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: LOCAL_ID,
    name: 'local-edit',
    display_name: '本地源',
    enabled: true,
    kind: 'local',
    content: LOCAL_CONTENT,
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    updated_at: 1,
    ...over,
  } as Subscription;
}

function mitceSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: MITCE_ID,
    name: 'mitce',
    display_name: 'Mitce',
    enabled: true,
    kind: 'remote',
    url: 'https://mitce.example/sub',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    updated_at: 1,
    ...over,
  } as Subscription;
}

function collection(): Collection {
  return {
    id: COLLECTION_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [LOCAL_ID, MITCE_ID],
    subscription_tags: [],
    operators: [],
  } as Collection;
}

function profile(): Profile {
  return {
    id: PROFILE_ID,
    name: 'default',
    source: { type: 'collection', id: COLLECTION_ID },
    updated_at: 1,
  } as Profile;
}

/** Typed bad bytes WITHOUT a network: a body that is not a valid subscription. */
function injectUnrecognisedFreshBytes(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('this is not a subscription payload', { status: 200 })),
  );
}

/** Typed transport failure: the upstream is unreachable. */
function injectTransportFailure(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))),
  );
}

/** Current subscription universe (may carry per-test policy overrides). */
function seedStorage(local: Subscription, mitce: Subscription): void {
  subscriptionRows.clear();
  subscriptionRows.set(local.id, local);
  subscriptionRows.set(mitce.id, mitce);
  versionCounter = 7;
  mocks.getSubscription.mockImplementation(async (id: string) => subscriptionRows.get(id) ?? null);
  mocks.listSubscriptions.mockImplementation(async () => [...subscriptionRows.values()]);
  mocks.getConfigVersion.mockImplementation(async () => versionCounter);
  mocks.getSubscriptionByName.mockImplementation(
    async (name: string) => [...subscriptionRows.values()].find((s) => s.name === name) ?? null,
  );
  mocks.commitSubscriptionChange.mockImplementation(
    async (next: Subscription, expectedVersion: number) => {
      if (expectedVersion !== versionCounter) return { ok: false, currentVersion: versionCounter };
      subscriptionRows.set(next.id, next);
      versionCounter += 1;
      return { ok: true, currentVersion: versionCounter };
    },
  );
  mocks.commitSubscriptionDelete.mockImplementation(async (id: string, expectedVersion: number) => {
    if (expectedVersion !== versionCounter) return { ok: false, currentVersion: versionCounter };
    subscriptionRows.delete(id);
    versionCounter += 1;
    return { ok: true, currentVersion: versionCounter };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  renderRedis.values.clear();
  seedStorage(localSub(), mitceSub());
  seedOrdinalStore();
  mocks.getOrdinalGeneration.mockResolvedValue(0);
  mocks.getProfile.mockResolvedValue(profile());
  mocks.listProfiles.mockResolvedValue([profile()]);
  mocks.getBase.mockResolvedValue({
    content: BASE,
    etag: 'base-etag',
    anchors: [],
    policies: ['默认'],
    updated_at: 1,
  });
  mocks.listCollections.mockResolvedValue([collection()]);
  mocks.listDevices.mockResolvedValue([]);
  mocks.listProxyGroups.mockResolvedValue([]);
  mocks.listProxyGroupTemplates.mockResolvedValue([]);
  mocks.listRules.mockResolvedValue([]);
  mocks.listRuleSets.mockResolvedValue([]);
  mocks.getFetchCache.mockResolvedValue(null);
  mocks.setFetchCache.mockResolvedValue(undefined);
  mocks.recordSubscriptionFetchHealth.mockResolvedValue(undefined);
  mocks.getSubscriptionFetchHealth.mockResolvedValue(null);
  mocks.getSubscriptionFetchHealthMany.mockResolvedValue([]);
});

/** Capture the error of a single rejected call and assert instance + shape. */
async function expectRejected(
  promise: Promise<unknown>,
  predicate: (error: unknown) => void,
): Promise<void> {
  try {
    await promise;
    throw new Error('expected the call to reject');
  } catch (error) {
    predicate(error);
  }
}

describe('cross-source fetch failure policy at the save gate', () => {
  it('commits a valid local edit when the unrelated tolerant mitce member has eligible bad fresh bytes', async () => {
    injectUnrecognisedFreshBytes();
    const before = storageState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-EDITED'),
    };

    await expect(replaceSubscription(LOCAL_ID, edited)).resolves.toMatchObject({
      id: LOCAL_ID,
      kind: 'local',
    });

    // Storage evidence: the local row landed with the edited definition, the
    // config version bumped exactly once, and the mitce row is untouched.
    const after = storageState();
    expect(after.rows.find((s) => s.id === LOCAL_ID)?.content).toContain('HK-EDITED');
    expect(after.version).toBe(before.version + 1);
    expect(after.rows.find((s) => s.id === MITCE_ID)?.url).toBe('https://mitce.example/sub');
    // Preflight never touches the fetch cache or health for ANY source.
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
    expect(mocks.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('commits via a validated last-known-good stale cache when mitce cannot refresh', async () => {
    injectTransportFailure();
    mocks.getFetchCache.mockResolvedValue({
      content: stringify({ proxies: [SS_NODE] }, { lineWidth: 0 }),
      proxy_count: 1,
      fetched_at: 0, // expired — only a retained, validated LKG
    });
    const before = storageState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-STALE-OK'),
    };

    await expect(replaceSubscription(LOCAL_ID, edited)).resolves.toMatchObject({ id: LOCAL_ID });

    const after = storageState();
    expect(after.rows.find((s) => s.id === LOCAL_ID)?.content).toContain('HK-STALE-OK');
    expect(after.version).toBe(before.version + 1);
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
    expect(mocks.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('strict mitce blocks a response-content failure with fixed 422 and leaves row/version untouched', async () => {
    injectUnrecognisedFreshBytes();
    seedStorage(localSub(), mitceSub({ fetch_failure_policy: 'fail-closed' }));
    const before = storageState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-NOCOMMIT'),
    };

    await expectRejected(replaceSubscription(LOCAL_ID, edited), (error) => {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({
        issue: { code: 'subscription_upstream_response_invalid', section: 'subscriptions' },
      });
    });

    expect(storageState()).toEqual(before);
  });

  it('strict mitce blocks a transport failure with fixed 503 and leaves row/version untouched', async () => {
    injectTransportFailure();
    seedStorage(localSub(), mitceSub({ fetch_failure_policy: 'fail-closed' }));
    const before = storageState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-NOCOMMIT'),
    };

    await expectRejected(replaceSubscription(LOCAL_ID, edited), (error) => {
      expect(error).toBeInstanceOf(ConfigPreflightUnavailableError);
    });

    expect(storageState()).toEqual(before);
  });

  it('an invalid edited local candidate always blocks with 422 and leaves storage untouched', async () => {
    const before = storageState();
    const invalid = {
      ...localSub(),
      operators: [],
      content: 'proxies:\n  - name: broken\n    type: ss\n', // missing server/port/cipher
    };

    await expectRejected(replaceSubscription(LOCAL_ID, invalid), (error) => {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ issue: { code: 'subscription_content_invalid' } });
    });

    expect(storageState()).toEqual(before);
  });

  it('an eligible failure with NO usable cache and tolerant policy skips the member; the local edit still commits', async () => {
    injectTransportFailure();
    mocks.getFetchCache.mockResolvedValue(null);
    const before = storageState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-SKIP-OK'),
    };

    await expect(replaceSubscription(LOCAL_ID, edited)).resolves.toMatchObject({ id: LOCAL_ID });

    const after = storageState();
    expect(after.rows.find((s) => s.id === LOCAL_ID)?.content).toContain('HK-SKIP-OK');
    expect(after.version).toBe(before.version + 1);
  });

  it('an ACTUAL programming fault is never skipped: generic failure, zero commit, zero health', async () => {
    // The mitce fetch itself SUCCEEDS, but the body reader throws synchronously
    // at read invocation — a programming fault outside the transport seam.
    const syncFault = new Error('sync read invocation fault');
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', {
      value: {
        getReader: () => ({
          read: () => {
            throw syncFault;
          },
          cancel: () => Promise.resolve(),
        }),
      },
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );
    const before = storageState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-NOFAULT'),
    };

    await expectRejected(replaceSubscription(LOCAL_ID, edited), (error) => {
      // The identical programming fault propagates — not a typed skip.
      expect(error).toBe(syncFault);
    });

    expect(storageState()).toEqual(before);
    expect(mocks.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
  });

  it('a skipped remote member leaving a real group reference dangling blocks the commit with no state change', async () => {
    // The base renders managed groups at the marker; the managed group
    // explicitly references mitce-node, which ONLY the skipped mitce member
    // would supply. No LKG exists and mitce fails at the ACTUAL body-transport
    // boundary (fetch promise rejection → network).
    const BASE_DANGLING = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct
# === PROXY-GROUPS ===
rules:
  - MATCH,默认
`;
    mocks.getBase.mockResolvedValue({
      content: BASE_DANGLING,
      etag: 'base-etag',
      anchors: [],
      policies: ['默认'],
      updated_at: 1,
    });
    mocks.listProxyGroups.mockResolvedValue([
      {
        id: 'gggggggg-gggg-4ggg-8ggg-gggggggggggg',
        name: '默认',
        type: 'select',
        kind: 'raw',
        rank: 0,
        proxies: ['直连', 'mitce-node'],
      } as never,
    ]);
    injectTransportFailure();
    mocks.getFetchCache.mockResolvedValue(null);
    const renderCacheKey = REDIS_KEYS.renderCache(profile().name);
    renderRedis.values.set(renderCacheKey, {
      marker: 'existing-render-cache-entry',
      version: versionCounter,
    });
    const renderCacheBefore = structuredClone([...renderRedis.values.entries()]);
    const before = storageState();
    const ordinalBefore = ordinalStoreState();
    const edited = {
      ...localSub(),
      operators: [],
      content: LOCAL_CONTENT.replace('HK-01', 'HK-DANGLE'),
    };

    await expectRejected(replaceSubscription(LOCAL_ID, edited), (error) => {
      // The real final validator rejects the dangling group member.
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({
        issue: { code: 'final_proxy_group_invalid' },
      });
    });

    // Row, config version, ORDINAL state, resolved snapshot, render cache,
    // fetch cache and health are ALL unchanged: no definition commit happened
    // and preflight wrote no serving state.
    expect(storageState()).toEqual(before);
    expect(mocks.commitSubscriptionChange).not.toHaveBeenCalled();
    expect(ordinalStoreState()).toEqual(ordinalBefore);
    expect(mocks.setResolvedSnapshot).not.toHaveBeenCalled();
    expect(mocks.invalidateResolvedSnapshot).not.toHaveBeenCalled();
    expect(structuredClone([...renderRedis.values.entries()])).toEqual(renderCacheBefore);
    expect(renderRedis.client.set).not.toHaveBeenCalled();
    expect(renderRedis.client.del).not.toHaveBeenCalled();
    expect(mocks.setFetchCache).not.toHaveBeenCalled();
    expect(mocks.recordSubscriptionFetchHealth).not.toHaveBeenCalled();
    expect(mocks.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });
});
