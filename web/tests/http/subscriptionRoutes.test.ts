/**
 * Subscription API surface: the admin view projection (remote rows carry the
 * effective fetch_failure_policy + fingerprint-joined fetch_health, local rows
 * omit both), declarative policy storage rules (create/PUT/PATCH), the empty
 * PATCH no-op, and delete-time health cleanup after the definition CAS.
 *
 * The routes and the service are real; repos, preflight and the health store
 * are mocked so no network or Redis side effect can occur.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigValidationError } from '@/lib/config/errors';
import { checkNativeFetchCompatibility } from '@/lib/client/subscriptionLocalRefresh';
import type { Collection, Profile, Subscription, SubscriptionFetchHealth } from '@/schemas';

const healthRepo = vi.hoisted(() => {
  const original = {
    computeSubscriptionDefinitionFingerprint: null as null | ((s: Subscription) => string),
  };
  return {
    recordSubscriptionFetchHealth: vi.fn(async () => undefined),
    getSubscriptionFetchHealth: vi.fn<(id: string) => Promise<SubscriptionFetchHealth | null>>(
      async () => null,
    ),
    getSubscriptionFetchHealthMany: vi.fn(async () => [] as unknown[]),
    computeSubscriptionDefinitionFingerprint: vi.fn(),
    _original: original,
  };
});

const consumerRepos = vi.hoisted(() => ({
  listProfiles: vi.fn(async () => [] as Profile[]),
  listCollections: vi.fn(async () => [] as Collection[]),
}));

const subscriptionFetcher = vi.hoisted(() => ({
  resolveSubscriptionContentRaw: vi.fn(),
}));

const repo = vi.hoisted(() => ({
  getSubscription: vi.fn<(id: string) => Promise<Subscription | null>>(async () => null),
  getSubscriptionByName: vi.fn<(name: string) => Promise<Subscription | null>>(async () => null),
  listSubscriptions: vi.fn(async () => [] as Subscription[]),
  commitSubscriptionChange: vi.fn<
    (
      next: Subscription,
      expectedVersion: number,
      ordinalPlan?: unknown,
      options?: unknown,
    ) => Promise<{ ok: boolean; currentVersion: number | null }>
  >(async () => ({ ok: true, currentVersion: 1 })),
  commitSubscriptionDelete: vi.fn<
    (id: string, expectedVersion: number) => Promise<{ ok: true; currentVersion: number }>
  >(async () => ({ ok: true, currentVersion: 1 })),
}));

const gate = vi.hoisted(() => ({
  preflightProfileConfig: vi.fn<
    (
      profileId: string,
      buildCandidate: (state: { subscriptions: Subscription[] }) => {
        subscriptions: Subscription[];
      },
      options: { contentOverrides?: ReadonlyMap<string, string> },
    ) => Promise<{
      configVersion: number;
      ordinalGeneration: number;
      ordinalPlan: { expectedGeneration: number; expectedGlobalSize: number; sources: never[] };
      candidate: Record<string, never>;
      buildId: string;
      profileExisted: boolean;
      baseExisted: boolean;
    }>
  >(async () => ({
    configVersion: 7,
    ordinalGeneration: 0,
    ordinalPlan: { expectedGeneration: 0, expectedGlobalSize: 0, sources: [] },
    candidate: {},
    buildId: 'deadbeef',
    profileExisted: true,
    baseExisted: true,
  })),
}));

vi.mock('@/lib/repos/subscriptionsRepo', () => repo);
vi.mock('@/lib/repos/profilesRepo', () => ({ listProfiles: consumerRepos.listProfiles }));
vi.mock('@/lib/repos/collectionsRepo', () => ({
  listCollections: consumerRepos.listCollections,
}));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: vi.fn(async () => 7) }));
vi.mock('@/lib/repos/nodeOrdinalRepo', () => ({ getOrdinalGeneration: vi.fn(async () => 0) }));
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  createOrdinalPlanningSession: vi.fn(async () => ({
    registerSourceDomain: vi.fn(),
    fingerprintsForSource: vi.fn(() => undefined),
    resolverFor: vi.fn(() => () => undefined),
    seal: vi.fn(() => ({ expectedGeneration: 0, expectedGlobalSize: 0, sources: [] })),
  })),
}));
vi.mock('@/lib/services/configPreflight', () => gate);
vi.mock('@/lib/services/subscriptionFetcher', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveSubscriptionContentRaw: subscriptionFetcher.resolveSubscriptionContentRaw,
  };
});
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/repos/subscriptionFetchHealthRepo', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    computeSubscriptionDefinitionFingerprint: (sub: Subscription) => string;
    healthMatchesDefinition: (sub: Subscription, health: unknown) => boolean;
  };
  healthRepo._original.computeSubscriptionDefinitionFingerprint =
    actual.computeSubscriptionDefinitionFingerprint;
  healthRepo.computeSubscriptionDefinitionFingerprint.mockImplementation((sub: Subscription) =>
    actual.computeSubscriptionDefinitionFingerprint(sub),
  );
  return {
    recordSubscriptionFetchHealth: healthRepo.recordSubscriptionFetchHealth,
    getSubscriptionFetchHealth: healthRepo.getSubscriptionFetchHealth,
    getSubscriptionFetchHealthMany: healthRepo.getSubscriptionFetchHealthMany,
    computeSubscriptionDefinitionFingerprint: healthRepo.computeSubscriptionDefinitionFingerprint,
    // Pure fingerprint-join used by the service view projection — must be real.
    healthMatchesDefinition: actual.healthMatchesDefinition,
  };
});

import { GET as listGET, POST as createPOST } from '@/app/api/v1/subscriptions/route';
import {
  DELETE as itemDELETE,
  GET as itemGET,
  PATCH as itemPATCH,
  PUT as itemPUT,
} from '@/app/api/v1/subscriptions/[id]/route';
import { POST as manualRefreshPOST } from '@/app/api/v1/subscriptions/[id]/manual-refresh/route';
import { GET as localFetchSpecGET } from '@/app/api/v1/subscriptions/[id]/local-fetch-spec/route';
import type { SubscriptionAdminView, SubscriptionLocalFetchSpec } from '@/schemas';

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_ID = '22222222-2222-4222-8222-222222222222';

function remoteSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: REMOTE_ID,
    name: 'airport-a',
    display_name: '机场A',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    updated_at: 1,
    ...over,
  } as Subscription;
}

function localSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: LOCAL_ID,
    name: 'local-a',
    display_name: '本地A',
    enabled: true,
    kind: 'local',
    content:
      'proxies:\n  - { name: HK, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    updated_at: 1,
    ...over,
  } as Subscription;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
function manualHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'text/plain',
    'If-Match': '1',
    'X-Fetch-Identity-Revision': '0',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getSubscription.mockImplementation(async (id: string) => {
    if (id === REMOTE_ID) return remoteSub();
    if (id === LOCAL_ID) return localSub();
    return null;
  });
  repo.listSubscriptions.mockResolvedValue([localSub(), remoteSub()]);
  healthRepo.getSubscriptionFetchHealthMany.mockResolvedValue([null, null]);
  repo.commitSubscriptionChange.mockResolvedValue({ ok: true, currentVersion: 1 });
  consumerRepos.listProfiles.mockResolvedValue([]);
  consumerRepos.listCollections.mockResolvedValue([]);
  subscriptionFetcher.resolveSubscriptionContentRaw.mockResolvedValue({
    yaml: 'proxies:\n  - { name: fresh, type: direct }\n',
    proxyCount: 1,
  });
});

describe('GET /api/v1/subscriptions — admin view projection', () => {
  it('remote rows return the effective policy and a matching health; local rows omit both', async () => {
    const health = {
      definition_fingerprint: healthRepo.computeSubscriptionDefinitionFingerprint(remoteSub()),
      state: 'stale-served' as const,
      attempted_at: 1_700_000_000_000,
      observed_at: 1_700_000_000_001,
      fresh_at: 1_600_000_000_000,
      failure_category: 'network' as const,
      cache_disposition: 'served' as const,
      proxy_count: 4,
    };
    // MGET order follows the remote id list (single remote source here).
    healthRepo.getSubscriptionFetchHealthMany.mockResolvedValue([health]);

    const res = await listGET();
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView[] };

    const local = data.find((s) => s.id === LOCAL_ID)!;
    expect(local.fetch_failure_policy).toBeUndefined();
    expect(local.fetch_health).toBeUndefined();

    const remote = data.find((s) => s.id === REMOTE_ID)!;
    expect(remote.fetch_failure_policy).toBe('use-stale-cache');
    expect(remote.fetch_health).toMatchObject({ state: 'stale-served', proxy_count: 4 });
  });

  it('a health whose fingerprint does not match the current definition joins as null', async () => {
    const staleHealth = {
      definition_fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      state: 'failed-no-cache' as const,
      attempted_at: 1_700_000_000_000,
      observed_at: 1_700_000_000_001,
      failure_category: 'network' as const,
      cache_disposition: 'unavailable' as const,
    };
    healthRepo.getSubscriptionFetchHealthMany.mockResolvedValue([staleHealth]);

    const res = await listGET();
    const { data } = (await json(res)) as { data: SubscriptionAdminView[] };
    const remote = data.find((s) => s.id === REMOTE_ID)!;
    expect(remote.fetch_health).toBeNull();
  });

  it('an explicit fail-closed policy round-trips through the view', async () => {
    repo.getSubscription.mockResolvedValue(remoteSub({ fetch_failure_policy: 'fail-closed' }));
    repo.listSubscriptions.mockResolvedValue([remoteSub({ fetch_failure_policy: 'fail-closed' })]);

    const res = await itemGET(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: REMOTE_ID }),
    } as never);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('fail-closed');
  });
});

describe('POST /api/v1/subscriptions — declarative policy storage', () => {
  it('stores and returns an explicit remote policy', async () => {
    repo.getSubscription.mockResolvedValue(null);
    repo.listSubscriptions.mockResolvedValue([]);
    healthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);

    const res = await createPOST(
      new Request('https://pm.test/api/v1/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'air-new',
          kind: 'remote',
          url: 'https://upstream.example/new',
          fetch_failure_policy: 'fail-closed',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('fail-closed');
  });

  it('rejects an explicit policy on a local create with 422 before any write', async () => {
    const res = await createPOST(
      new Request('https://pm.test/api/v1/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'local-new',
          kind: 'local',
          content:
            'proxies:\n  - { name: N, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
          fetch_failure_policy: 'use-stale-cache',
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
  });
});

describe('PUT/PATCH /api/v1/subscriptions/{id}', () => {
  it('PATCH remote→local removes an inherited policy and omits policy/health from the view', async () => {
    repo.getSubscription.mockResolvedValue(
      remoteSub({ fetch_failure_policy: 'fail-closed', content: undefined }),
    );
    repo.listSubscriptions.mockResolvedValue([remoteSub({ fetch_failure_policy: 'fail-closed' })]);
    healthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({
          kind: 'local',
          content:
            'proxies:\n  - { name: N, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.kind).toBe('local');
    expect(data.fetch_failure_policy).toBeUndefined();
    expect(data.fetch_health).toBeUndefined();

    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBeUndefined();
  });

  it('an explicit policy on a resulting local source is 422 before preflight/write', async () => {
    repo.getSubscription.mockResolvedValue(
      remoteSub({ fetch_failure_policy: 'fail-closed', content: undefined }),
    );
    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({
          kind: 'local',
          content: 'proxies: []\n',
          fetch_failure_policy: 'use-stale-cache',
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
    expect(gate.preflightProfileConfig).not.toHaveBeenCalled();
  });

  it('an empty PATCH is a no-op: no commit, no version bump, current row returned', async () => {
    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
    expect(gate.preflightProfileConfig).not.toHaveBeenCalled();
  });

  it('PUT of a local candidate with an explicit policy is rejected', async () => {
    repo.getSubscription.mockResolvedValue(remoteSub());
    const res = await itemPUT(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'airport-a',
          kind: 'local',
          content: 'proxies: []\n',
          fetch_failure_policy: 'fail-closed',
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
  });
});

describe('v5 committed-candidate admin projection', () => {
  function manualRemote(): Subscription {
    return remoteSub({
      updated_at: 30,
      refresh_mode: 'manual',
      fetch_identity_revision: 5,
      manual_snapshot_meta: {
        updated_at: 29,
        proxy_count: 1,
        origin: 'web',
        fetch_identity_revision: 5,
        content_sha256: '1'.repeat(64),
      },
    });
  }

  it('v5 manual PUT projects the committed snapshot without health or definition re-read', async () => {
    const current = manualRemote();
    repo.getSubscription
      .mockResolvedValueOnce(current)
      .mockRejectedValue(new Error('post-commit definition re-read'));
    repo.listSubscriptions.mockResolvedValue([current]);
    healthRepo.getSubscriptionFetchHealth.mockRejectedValue(
      new Error('manual projection must not read fetch health'),
    );

    const res = await itemPUT(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PUT',
        body: JSON.stringify({
          name: current.name,
          kind: 'remote',
          url: current.url,
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data).toMatchObject({
      kind: 'remote',
      refresh_mode: 'manual',
      fetch_health: null,
      manual_snapshot: {
        updated_at: 29,
        proxy_count: 1,
        origin: 'web',
        source_changed: false,
      },
    });
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.refresh_mode).toBe('manual');
    expect(committed.manual_snapshot_meta).toEqual(current.manual_snapshot_meta);
    expect(repo.getSubscription).toHaveBeenCalledOnce();
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('v5 manual PATCH projects source_changed without health or definition re-read', async () => {
    const current = manualRemote();
    repo.getSubscription
      .mockResolvedValueOnce(current)
      .mockRejectedValue(new Error('post-commit definition re-read'));
    repo.listSubscriptions.mockResolvedValue([current]);
    healthRepo.getSubscriptionFetchHealth.mockRejectedValue(
      new Error('manual projection must not read fetch health'),
    );

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({ url: 'https://upstream.example/identity-edited' }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data).toMatchObject({
      kind: 'remote',
      refresh_mode: 'manual',
      fetch_health: null,
      manual_snapshot: {
        updated_at: 29,
        proxy_count: 1,
        origin: 'web',
        source_changed: true,
      },
    });
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.refresh_mode).toBe('manual');
    expect(committed.fetch_identity_revision).toBe(6);
    expect(committed.manual_snapshot_meta).toEqual(current.manual_snapshot_meta);
    expect(repo.getSubscription).toHaveBeenCalledOnce();
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', 'matching', true],
    ['PUT', 'mismatched', false],
    ['PATCH', 'matching', true],
    ['PATCH', 'mismatched', false],
  ] as const)(
    'v5 server-auto %s keeps the %s fingerprint health join',
    async (method, _fingerprintCase, matches) => {
      const current = remoteSub({
        updated_at: 40,
        fetch_identity_revision: 9,
        ...(method === 'PATCH' ? { refresh_mode: 'server-auto' as const } : {}),
      });
      repo.getSubscription.mockResolvedValue(current);
      repo.listSubscriptions.mockResolvedValue([current]);
      healthRepo.getSubscriptionFetchHealth.mockImplementation(async () => {
        const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as
          | Subscription
          | undefined;
        if (!committed) throw new Error('health lookup happened before commit');
        return {
          definition_fingerprint: matches
            ? healthRepo.computeSubscriptionDefinitionFingerprint(committed)
            : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          state: 'fresh',
          attempted_at: 1_700_000_000_000,
          observed_at: 1_700_000_000_001,
          fresh_at: 1_700_000_000_001,
          proxy_count: 3,
        };
      });

      const request =
        method === 'PUT'
          ? new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
              method,
              body: JSON.stringify({
                name: current.name,
                kind: 'remote',
                url: 'https://upstream.example/server-auto-put',
              }),
            })
          : new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
              method,
              body: JSON.stringify({ url: 'https://upstream.example/server-auto-patch' }),
            });
      const res =
        method === 'PUT'
          ? await itemPUT(request, {
              params: Promise.resolve({ id: REMOTE_ID }),
            } as never)
          : await itemPATCH(request, {
              params: Promise.resolve({ id: REMOTE_ID }),
            } as never);

      expect(res.status).toBe(200);
      const { data } = (await json(res)) as { data: SubscriptionAdminView };
      expect(data.refresh_mode).toBe('server-auto');
      if (matches) {
        expect(data.fetch_health).toMatchObject({ state: 'fresh', proxy_count: 3 });
      } else {
        expect(data.fetch_health).toBeNull();
      }
      expect(healthRepo.getSubscriptionFetchHealth).toHaveBeenCalledTimes(1);
      expect(healthRepo.getSubscriptionFetchHealth).toHaveBeenCalledWith(REMOTE_ID);
    },
  );
});

describe('fetch identity revision and mutation timestamps', () => {
  it('preserves the revision for sorted-header and effective-UA equivalents', async () => {
    const current = remoteSub({
      updated_at: 40,
      fetch_identity_revision: 9,
      ua_override: ' Browser UA ',
      custom_headers: { 'X-Zeta': 'two', 'X-Alpha': 'one' },
    });
    repo.getSubscription.mockResolvedValue(current);
    repo.listSubscriptions.mockResolvedValue([current]);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({
          ua_override: 'Browser UA',
          custom_headers: { 'X-Alpha': 'one', 'X-Zeta': 'two' },
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_identity_revision).toBe(9);
  });

  it.each(['User-Agent', 'user-agent', 'uSeR-aGeNt'])(
    'does not revise fetch identity for ignored custom %s changes',
    async (headerName) => {
      const current = remoteSub({
        updated_at: 40,
        fetch_identity_revision: 9,
        ua_override: 'Browser UA',
        custom_headers: { 'X-Test': 'retained' },
      });
      repo.getSubscription.mockResolvedValue(current);
      repo.listSubscriptions.mockResolvedValue([current]);

      const res = await itemPATCH(
        new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
          method: 'PATCH',
          body: JSON.stringify({
            custom_headers: {
              [headerName]: 'sentinel-ignored-ua',
              'X-Test': 'retained',
            },
          }),
        }),
        { params: Promise.resolve({ id: REMOTE_ID }) } as never,
      );

      expect(res.status).toBe(200);
      const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
      expect(committed.fetch_identity_revision).toBe(9);
    },
  );

  it.each([
    ['URL', { url: 'https://upstream.example/changed' }],
    ['effective User-Agent', { ua_override: 'Different Browser UA' }],
    ['custom header', { custom_headers: { 'X-Alpha': 'changed', 'X-Zeta': 'two' } }],
  ])('increments the revision for an actual %s identity change', async (_label, patch) => {
    const current = remoteSub({
      updated_at: 40,
      fetch_identity_revision: 9,
      ua_override: 'Browser UA',
      custom_headers: { 'X-Alpha': 'one', 'X-Zeta': 'two' },
    });
    repo.getSubscription.mockResolvedValue(current);
    repo.listSubscriptions.mockResolvedValue([current]);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_identity_revision).toBe(10);
  });

  it('advances updated_at when a mutation lands in the same second', async () => {
    const second = 1_700_000_000;
    const current = remoteSub({ updated_at: second, fetch_identity_revision: 4 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(second * 1000);
    repo.getSubscription.mockResolvedValue(current);
    repo.listSubscriptions.mockResolvedValue([current]);

    try {
      const res = await itemPATCH(
        new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
          method: 'PATCH',
          body: JSON.stringify({ display_name: 'same-second edit' }),
        }),
        { params: Promise.resolve({ id: REMOTE_ID }) } as never,
      );

      expect(res.status).toBe(200);
      const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
      expect(committed.updated_at).toBe(second + 1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('manual-to-auto transition safety', () => {
  const manual = remoteSub({
    updated_at: 30,
    refresh_mode: 'manual',
    fetch_identity_revision: 5,
    manual_snapshot_meta: {
      updated_at: 29,
      proxy_count: 1,
      origin: 'web',
      fetch_identity_revision: 5,
      content_sha256: '1'.repeat(64),
    },
  });
  const freshYaml = 'proxies:\n  - name: fresh\n    type: direct\n';

  it('force-fetches and preflights every direct and collection consumer before committing', async () => {
    const directProfile = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'direct-consumer',
      source: { type: 'subscription', id: REMOTE_ID },
      updated_at: 1,
    } as Profile;
    const collectionProfile = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'collection-consumer',
      source: { type: 'collection', id: '55555555-5555-4555-8555-555555555555' },
      updated_at: 1,
    } as Profile;
    const collection = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'includes-manual',
      type: 'select',
      subscription_ids: [REMOTE_ID],
      subscription_tags: [],
      enabled: true,
      operators: [],
      updated_at: 1,
    } as Collection;
    repo.getSubscription.mockResolvedValue(manual);
    repo.listSubscriptions.mockResolvedValue([manual]);
    consumerRepos.listProfiles.mockResolvedValue([directProfile, collectionProfile]);
    consumerRepos.listCollections.mockResolvedValue([collection]);
    subscriptionFetcher.resolveSubscriptionContentRaw.mockResolvedValue({
      yaml: freshYaml,
      proxyCount: 1,
    });

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({ refresh_mode: 'server-auto' }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    expect(subscriptionFetcher.resolveSubscriptionContentRaw).toHaveBeenCalledWith(
      expect.objectContaining({ id: REMOTE_ID, refresh_mode: 'server-auto' }),
      { noCache: true, writeCache: false, recordHealth: false },
    );
    expect(gate.preflightProfileConfig).toHaveBeenCalledTimes(2);
    expect(gate.preflightProfileConfig.mock.calls.map(([profileId]) => profileId).sort()).toEqual(
      [collectionProfile.id, directProfile.id].sort(),
    );
    for (const [, buildCandidate, options] of gate.preflightProfileConfig.mock.calls) {
      const candidate = buildCandidate({ subscriptions: [manual] });
      expect(candidate.subscriptions[0]).toMatchObject({
        id: REMOTE_ID,
        refresh_mode: 'server-auto',
      });
      expect(options.contentOverrides?.get(REMOTE_ID)).toBe(freshYaml);
    }
    expect(repo.commitSubscriptionChange).toHaveBeenCalledOnce();
    expect(repo.commitSubscriptionChange.mock.calls[0]?.[3]).toMatchObject({
      manualSnapshot: { type: 'keep' },
      fetchCache: {
        cacheKey: expect.stringMatching(/^[0-9a-f]{16}$/),
        entry: {
          content: freshYaml,
          proxy_count: 1,
          fetched_at: expect.any(Number),
        },
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    expect(Math.max(...gate.preflightProfileConfig.mock.invocationCallOrder)).toBeLessThan(
      repo.commitSubscriptionChange.mock.invocationCallOrder[0] as number,
    );
  });

  it('blocks the transition before commit when a stored-device preflight fails', async () => {
    repo.getSubscription.mockResolvedValue(manual);
    repo.listSubscriptions.mockResolvedValue([manual]);
    consumerRepos.listProfiles.mockResolvedValue([
      {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'device-consumer',
        source: { type: 'subscription', id: REMOTE_ID },
        updated_at: 1,
      } as Profile,
    ]);
    subscriptionFetcher.resolveSubscriptionContentRaw.mockResolvedValue({
      yaml: freshYaml,
      proxyCount: 1,
    });
    gate.preflightProfileConfig.mockRejectedValueOnce(
      new ConfigValidationError({
        code: 'device_patch_final_invalid',
        message: 'Device candidate is invalid.',
        section: 'devices',
        path: 'devices[home-server].base_patch',
        resource: 'device',
      }),
    );

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({ refresh_mode: 'server-auto' }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(422);
    expect(subscriptionFetcher.resolveSubscriptionContentRaw).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_mode: 'server-auto' }),
      { noCache: true, writeCache: false, recordHealth: false },
    );
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
    expect(await json(res)).toMatchObject({
      errors: [
        {
          code: 'device_patch_final_invalid',
          section: 'devices',
          resource: 'device',
        },
      ],
    });
  });
});
describe('narrow local-refresh route cache policy', () => {
  it('v12 projects authoritative UA headers into a native-compatible local fetch spec', async () => {
    const userAgent = 'Browser UA';
    for (const headerName of ['User-Agent', 'user-agent', 'uSeR-aGeNt']) {
      repo.getSubscription.mockResolvedValueOnce(
        remoteSub({
          ua_override: userAgent,
          custom_headers: {
            [headerName]: 'ignored-custom-user-agent',
            'X-Native-Compatible': 'retained',
          },
        }),
      );

      const response = await localFetchSpecGET(
        new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/local-fetch-spec`),
        { params: Promise.resolve({ id: REMOTE_ID }) } as never,
      );
      const { data } = (await json(response)) as { data: SubscriptionLocalFetchSpec };

      expect(response.status).toBe(200);
      expect(data.customHeaders).toEqual({ 'X-Native-Compatible': 'retained' });
      expect(
        checkNativeFetchCompatibility(data, {
          pageProtocol: 'https:',
          navigatorUserAgent: userAgent,
        }),
      ).toBeNull();
    }
  });

  it('marks successful and rejected local-fetch-spec responses no-store', async () => {
    repo.getSubscription.mockResolvedValueOnce(remoteSub()).mockResolvedValueOnce(localSub());

    const success = await localFetchSpecGET(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/local-fetch-spec`),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    const rejected = await localFetchSpecGET(
      new Request(`https://pm.test/api/v1/subscriptions/${LOCAL_ID}/local-fetch-spec`),
      { params: Promise.resolve({ id: LOCAL_ID }) } as never,
    );

    expect(success.status).toBe(200);
    expect(success.headers.get('cache-control')).toBe('no-store');
    expect(rejected.status).toBe(422);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
  });

  it('marks manual-refresh problem responses no-store', async () => {
    const response = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'proxies: []\n',
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/v1/subscriptions/{id}/manual-refresh', () => {
  const validContent = [
    'proxies:',
    '  - name: HK-manual',
    '    type: ss',
    '    server: hk.example',
    '    port: 443',
    '    cipher: aes-128-gcm',
    '    password: test-password',
  ].join('\n');

  it('validates, preflights and atomically commits extension-fetched raw content', async () => {
    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders({ 'X-Source': 'extension' }),
        body: validContent,
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = (await json(res)) as {
      data: { proxyCount: number; updatedAt: number };
    };
    expect(data).toEqual({ proxyCount: 1, updatedAt: expect.any(Number) });
    expect(JSON.stringify(data)).not.toContain('test-password');

    const commitCall = repo.commitSubscriptionChange.mock.calls[0] as unknown[];
    const committed = commitCall[0] as Subscription;
    expect(committed).toMatchObject({
      refresh_mode: 'manual',
      manual_snapshot_meta: {
        proxy_count: 1,
        origin: 'extension',
        fetch_identity_revision: 0,
      },
    });
    expect('manual_content' in committed).toBe(false);
    expect(commitCall[3]).toMatchObject({
      manualSnapshot: { type: 'set', content: validContent },
      clearFetchHealth: true,
    });
  });

  it('rejects invalid content before the CAS write', async () => {
    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders(),
        body: 'this is not a subscription',
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
  });

  it('defers duplicate raw names when the stored managed naming step makes them unique', async () => {
    const managed = remoteSub({
      operators: [
        {
          id: 'managed-naming',
          kind: 'rename-template',
          template: '${name}${?index: · ${index}}',
          recognitionRules: [],
        },
      ],
    });
    repo.getSubscription.mockResolvedValue(managed);
    repo.listSubscriptions.mockResolvedValue([managed]);
    const duplicateNames = [
      'proxies:',
      '  - { name: DUP, type: ss, server: a.example, port: 443, cipher: aes-128-gcm, password: p }',
      '  - { name: DUP, type: ss, server: b.example, port: 443, cipher: aes-128-gcm, password: p }',
    ].join('\n');

    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders(),
        body: duplicateNames,
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(200);
    expect(repo.commitSubscriptionChange).toHaveBeenCalledOnce();
    expect(repo.commitSubscriptionChange.mock.calls[0]?.[0]).toMatchObject({
      manual_snapshot_meta: { proxy_count: 2 },
    });
  });

  it('stops reading an oversized body even without Content-Length', async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
    oversized.fill(0x61);
    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders(),
        body: oversized,
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(413);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 before parsing or writing', async () => {
    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders(),
        body: new Uint8Array([0xc3, 0x28]),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
  });

  it.each([
    ['updated_at', { 'If-Match': '0' }],
    ['fetch identity revision', { 'X-Fetch-Identity-Revision': '1' }],
  ])(
    'rejects a stale %s precondition with every seeded byte unchanged',
    async (_label, staleHeader) => {
      const state = {
        definition: remoteSub(),
        rawSnapshot: 'dormant-snapshot-before',
        renderCache: '{"configVersion":7,"content":"rendered-before"}',
        configVersion: '7',
      };
      repo.getSubscription.mockImplementation(async (id: string) =>
        id === REMOTE_ID ? structuredClone(state.definition) : null,
      );
      repo.listSubscriptions.mockImplementation(async () => [structuredClone(state.definition)]);
      const before = JSON.stringify(state);

      const res = await manualRefreshPOST(
        new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
          method: 'POST',
          headers: manualHeaders(staleHeader),
          body: validContent,
        }),
        { params: Promise.resolve({ id: REMOTE_ID }) } as never,
      );

      expect(res.status).toBe(412);
      expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it('maps a losing repository import CAS to 412', async () => {
    repo.commitSubscriptionChange.mockResolvedValue({ ok: false, currentVersion: 8 });

    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders(),
        body: validContent,
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );

    expect(res.status).toBe(412);
    expect(repo.commitSubscriptionChange).toHaveBeenCalledOnce();
  });

  it.each(['User-Agent', 'user-agent', 'uSeR-aGeNt'])(
    'keeps source_changed false for ignored custom %s edits',
    async (headerName) => {
      const current = remoteSub({
        updated_at: 20,
        refresh_mode: 'manual',
        fetch_identity_revision: 4,
        custom_headers: { 'X-Test': 'retained' },
        manual_snapshot_meta: {
          updated_at: 20,
          proxy_count: 1,
          origin: 'web',
          fetch_identity_revision: 4,
          content_sha256: '0'.repeat(64),
        },
      });
      repo.getSubscription.mockResolvedValue(current);
      repo.listSubscriptions.mockResolvedValue([current]);

      const res = await itemPATCH(
        new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
          method: 'PATCH',
          body: JSON.stringify({
            custom_headers: {
              [headerName]: 'sentinel-ignored-ua',
              'X-Test': 'retained',
            },
          }),
        }),
        { params: Promise.resolve({ id: REMOTE_ID }) } as never,
      );
      const { data } = (await json(res)) as {
        data: { manual_snapshot?: { source_changed: boolean } };
      };

      expect(res.status).toBe(200);
      expect(data.manual_snapshot?.source_changed).toBe(false);
      const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
      expect(committed.fetch_identity_revision).toBe(4);
    },
  );

  it('retains source_changed through identity edits and clears it only after a current import', async () => {
    const state: { definition: Subscription; rawSnapshot: string | undefined } = {
      definition: remoteSub({
        updated_at: 20,
        refresh_mode: 'manual',
        fetch_identity_revision: 4,
        manual_snapshot_meta: {
          updated_at: 20,
          proxy_count: 1,
          origin: 'web',
          fetch_identity_revision: 4,
          content_sha256: '0'.repeat(64),
        },
      }),
      rawSnapshot: 'snapshot-before-identity-edits',
    };
    repo.getSubscription.mockImplementation(async (id: string) =>
      id === REMOTE_ID ? structuredClone(state.definition) : null,
    );
    repo.listSubscriptions.mockImplementation(async () => [structuredClone(state.definition)]);
    repo.commitSubscriptionChange.mockImplementation(async (...args) => {
      const next = args[0];
      const options = args[3] as {
        manualSnapshot?: { type: 'keep' | 'set' | 'delete'; content?: string };
      };
      const action = options.manualSnapshot;
      if (action?.type === 'set') state.rawSnapshot = action.content;
      if (action?.type === 'delete') state.rawSnapshot = undefined;
      state.definition = next;
      return { ok: true, currentVersion: 8 };
    });

    for (const patch of [
      { url: 'https://upstream.example/changed' },
      { ua_override: 'Changed Browser UA' },
      { custom_headers: { 'X-Subscription-Token': 'changed-test-value' } },
    ]) {
      const res = await itemPATCH(
        new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
        { params: Promise.resolve({ id: REMOTE_ID }) } as never,
      );
      const { data } = (await json(res)) as {
        data: { manual_snapshot?: { source_changed: boolean } };
      };
      expect(res.status).toBe(200);
      expect(data.manual_snapshot?.source_changed).toBe(true);
      expect(state.rawSnapshot).toBe('snapshot-before-identity-edits');
    }

    const importRes = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${REMOTE_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders({
          'If-Match': String(state.definition.updated_at),
          'X-Fetch-Identity-Revision': String(state.definition.fetch_identity_revision),
        }),
        body: validContent,
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(importRes.status).toBe(200);

    const detailRes = await itemGET(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: REMOTE_ID }),
    } as never);
    const { data } = (await json(detailRes)) as {
      data: { manual_snapshot?: { source_changed: boolean } };
    };
    expect(detailRes.status).toBe(200);
    expect(data.manual_snapshot?.source_changed).toBe(false);
    expect(state.rawSnapshot).toBe(validContent);
  });

  it('rejects local sources without changing them', async () => {
    const res = await manualRefreshPOST(
      new Request(`https://pm.test/api/v1/subscriptions/${LOCAL_ID}/manual-refresh`, {
        method: 'POST',
        headers: manualHeaders(),
        body: validContent,
      }),
      { params: Promise.resolve({ id: LOCAL_ID }) } as never,
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
  });
});

describe('v2 I2 POST/PUT omitted-explicit matrix', () => {
  it('POST remote with an OMITTED policy persists none and exposes the effective default', async () => {
    repo.getSubscription.mockResolvedValue(null);
    repo.listSubscriptions.mockResolvedValue([]);
    healthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);

    const res = await createPOST(
      new Request('https://pm.test/api/v1/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'air-omitted',
          kind: 'remote',
          url: 'https://upstream.example/omitted',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('use-stale-cache');
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBeUndefined();
  });

  it('POST remote with an EXPLICIT policy persists and round-trips it', async () => {
    repo.getSubscription.mockResolvedValue(null);
    repo.listSubscriptions.mockResolvedValue([]);
    healthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);

    const res = await createPOST(
      new Request('https://pm.test/api/v1/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'air-explicit',
          kind: 'remote',
          url: 'https://upstream.example/explicit',
          fetch_failure_policy: 'fail-closed',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('fail-closed');
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBe('fail-closed');
  });

  it('PUT remote with an OMITTED policy persists none and exposes the effective default', async () => {
    repo.getSubscription.mockResolvedValue(remoteSub({ fetch_failure_policy: 'fail-closed' }));
    repo.listSubscriptions.mockResolvedValue([remoteSub({ fetch_failure_policy: 'fail-closed' })]);
    healthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);

    const res = await itemPUT(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'airport-a',
          kind: 'remote',
          url: 'https://upstream.example/replaced',
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('use-stale-cache');
    // Full replacement drops the inherited policy — nothing persisted.
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBeUndefined();
  });

  it('PUT remote with an EXPLICIT policy persists and round-trips it', async () => {
    repo.getSubscription.mockResolvedValue(remoteSub());
    repo.listSubscriptions.mockResolvedValue([remoteSub()]);
    healthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);

    const res = await itemPUT(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'airport-a',
          kind: 'remote',
          url: 'https://upstream.example/replaced',
          fetch_failure_policy: 'fail-closed',
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('fail-closed');
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBe('fail-closed');
  });
});

describe('v2 I2 policy transition table', () => {
  it('PATCH remote→remote without an explicit policy PRESERVES the current policy', async () => {
    repo.getSubscription.mockResolvedValue(remoteSub({ fetch_failure_policy: 'fail-closed' }));
    repo.listSubscriptions.mockResolvedValue([remoteSub({ fetch_failure_policy: 'fail-closed' })]);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({ display_name: '改名' }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBe('fail-closed');
  });

  it('PATCH remote→remote with an explicit policy REPLACES it', async () => {
    repo.getSubscription.mockResolvedValue(remoteSub({ fetch_failure_policy: 'fail-closed' }));
    repo.listSubscriptions.mockResolvedValue([remoteSub({ fetch_failure_policy: 'fail-closed' })]);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({ fetch_failure_policy: 'use-stale-cache' }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.fetch_failure_policy).toBe('use-stale-cache');
  });

  it('PATCH local→remote without a policy stores no field and exposes the effective default', async () => {
    // A decoded local row never carries the policy (schema-stripped in
    // memory), so the remote transition naturally stores no field.
    repo.getSubscription.mockResolvedValue(localSub({ url: undefined }));
    repo.listSubscriptions.mockResolvedValue([localSub()]);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + LOCAL_ID, {
        method: 'PATCH',
        body: JSON.stringify({ kind: 'remote', url: 'https://upstream.example/sub' }),
      }),
      { params: Promise.resolve({ id: LOCAL_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const committed = repo.commitSubscriptionChange.mock.calls[0]?.[0] as Subscription;
    expect(committed.kind).toBe('remote');
    expect(committed.fetch_failure_policy).toBeUndefined();
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.fetch_failure_policy).toBe('use-stale-cache');
  });

  it('PATCH local→local with an explicit policy returns 422 before preflight/write', async () => {
    repo.getSubscription.mockResolvedValue(localSub());

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + LOCAL_ID, {
        method: 'PATCH',
        body: JSON.stringify({ fetch_failure_policy: 'fail-closed' }),
      }),
      { params: Promise.resolve({ id: LOCAL_ID }) } as never,
    );
    expect(res.status).toBe(422);
    expect(repo.commitSubscriptionChange).not.toHaveBeenCalled();
    expect(gate.preflightProfileConfig).not.toHaveBeenCalled();
  });

  it('a stored local row carrying a legacy policy projects without it (canonical in-memory decode)', async () => {
    repo.getSubscription.mockResolvedValue(localSub({ fetch_failure_policy: 'fail-closed' }));

    const res = await itemGET(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: LOCAL_ID }),
    } as never);
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.kind).toBe('local');
    expect(data.fetch_failure_policy).toBeUndefined();
    expect(data.fetch_health).toBeUndefined();
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });
});

describe('local sources never consult health storage (invariant 1)', () => {
  beforeEach(() => {
    healthRepo.getSubscriptionFetchHealth.mockClear();
    healthRepo.getSubscriptionFetchHealthMany.mockClear();
  });

  it('GET list with only local rows performs zero health reads', async () => {
    repo.listSubscriptions.mockResolvedValue([localSub()]);

    const res = await listGET();
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView[] };
    expect(data[0].kind).toBe('local');
    expect(data[0].fetch_failure_policy).toBeUndefined();
    expect(data[0].fetch_health).toBeUndefined();
    expect(healthRepo.getSubscriptionFetchHealthMany).not.toHaveBeenCalled();
  });

  it('GET detail of a local source performs zero health reads', async () => {
    const res = await itemGET(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: LOCAL_ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('POST of a local source performs zero health reads', async () => {
    repo.getSubscription.mockResolvedValue(null);
    repo.listSubscriptions.mockResolvedValue([]);

    const res = await createPOST(
      new Request('https://pm.test/api/v1/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'local-new',
          kind: 'local',
          content:
            'proxies:\n  - { name: N, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.kind).toBe('local');
    expect(data.fetch_failure_policy).toBeUndefined();
    expect(data.fetch_health).toBeUndefined();
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('PUT of a local source performs zero health reads', async () => {
    repo.getSubscription.mockResolvedValue(localSub());
    repo.listSubscriptions.mockResolvedValue([localSub()]);

    const res = await itemPUT(
      new Request('https://pm.test/api/v1/subscriptions/' + LOCAL_ID, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'local-a',
          kind: 'local',
          content:
            'proxies:\n  - { name: N2, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
        }),
      }),
      { params: Promise.resolve({ id: LOCAL_ID }) } as never,
    );
    expect(res.status).toBe(200);
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });

  it('PATCH resulting in a local source performs zero health reads', async () => {
    repo.getSubscription.mockResolvedValue(
      remoteSub({ fetch_failure_policy: 'fail-closed', content: undefined }),
    );
    repo.listSubscriptions.mockResolvedValue([remoteSub({ fetch_failure_policy: 'fail-closed' })]);

    const res = await itemPATCH(
      new Request('https://pm.test/api/v1/subscriptions/' + REMOTE_ID, {
        method: 'PATCH',
        body: JSON.stringify({
          kind: 'local',
          content:
            'proxies:\n  - { name: N, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n',
        }),
      }),
      { params: Promise.resolve({ id: REMOTE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    const { data } = (await json(res)) as { data: SubscriptionAdminView };
    expect(data.kind).toBe('local');
    expect(data.fetch_failure_policy).toBeUndefined();
    expect(healthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/subscriptions/{id}', () => {
  it('deletes definition, snapshot and health in the single gate CAS', async () => {
    const res = await itemDELETE(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: REMOTE_ID }),
    } as never);
    expect(res.status).toBe(204);
    expect(repo.commitSubscriptionDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps the already-gone delete idempotent without a standalone health write', async () => {
    repo.getSubscription.mockResolvedValue(null);
    const res = await itemDELETE(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: REMOTE_ID }),
    } as never);
    expect(res.status).toBe(404);
    expect(repo.commitSubscriptionDelete).toHaveBeenCalledTimes(1);
  });
});
