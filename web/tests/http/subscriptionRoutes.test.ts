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
import type { Subscription } from '@/schemas';

const healthRepo = vi.hoisted(() => {
  const original = {
    computeSubscriptionDefinitionFingerprint: null as null | ((s: Subscription) => string),
  };
  return {
    recordSubscriptionFetchHealth: vi.fn(async () => undefined),
    getSubscriptionFetchHealth: vi.fn(async () => null),
    getSubscriptionFetchHealthMany: vi.fn(async () => [] as unknown[]),
    deleteSubscriptionFetchHealth: vi.fn(async () => undefined),
    computeSubscriptionDefinitionFingerprint: vi.fn(),
    _original: original,
  };
});

const repo = vi.hoisted(() => ({
  getSubscription: vi.fn<(id: string) => Promise<Subscription | null>>(async () => null),
  getSubscriptionByName: vi.fn<(name: string) => Promise<Subscription | null>>(async () => null),
  listSubscriptions: vi.fn(async () => [] as Subscription[]),
  commitSubscriptionChange: vi.fn<
    (next: Subscription, expectedVersion: number) => Promise<{ ok: true; currentVersion: number }>
  >(async () => ({ ok: true, currentVersion: 1 })),
  commitSubscriptionDelete: vi.fn<
    (id: string, expectedVersion: number) => Promise<{ ok: true; currentVersion: number }>
  >(async () => ({ ok: true, currentVersion: 1 })),
  deleteSubscription: vi.fn(async () => true),
}));

const gate = vi.hoisted(() => ({
  preflightProfileConfig: vi.fn(async () => ({
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
vi.mock('@/lib/repos/profilesRepo', () => ({ listProfiles: vi.fn(async () => []) }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: vi.fn(async () => []) }));
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
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/repos/subscriptionFetchHealthRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/subscriptionFetchHealthRepo')>();
  healthRepo._original.computeSubscriptionDefinitionFingerprint =
    actual.computeSubscriptionDefinitionFingerprint;
  healthRepo.computeSubscriptionDefinitionFingerprint.mockImplementation((sub: Subscription) =>
    actual.computeSubscriptionDefinitionFingerprint(sub),
  );
  return {
    recordSubscriptionFetchHealth: healthRepo.recordSubscriptionFetchHealth,
    getSubscriptionFetchHealth: healthRepo.getSubscriptionFetchHealth,
    getSubscriptionFetchHealthMany: healthRepo.getSubscriptionFetchHealthMany,
    deleteSubscriptionFetchHealth: healthRepo.deleteSubscriptionFetchHealth,
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
import type { SubscriptionAdminView } from '@/schemas';

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

beforeEach(() => {
  vi.clearAllMocks();
  repo.getSubscription.mockImplementation(async (id: string) => {
    if (id === REMOTE_ID) return remoteSub();
    if (id === LOCAL_ID) return localSub();
    return null;
  });
  repo.listSubscriptions.mockResolvedValue([localSub(), remoteSub()]);
  healthRepo.getSubscriptionFetchHealthMany.mockResolvedValue([null, null]);
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
  it('deletes the definition under the gate CAS, then best-effort deletes health', async () => {
    const res = await itemDELETE(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: REMOTE_ID }),
    } as never);
    expect(res.status).toBe(204);
    expect(repo.commitSubscriptionDelete).toHaveBeenCalledTimes(1);
    expect(healthRepo.deleteSubscriptionFetchHealth).toHaveBeenCalledWith(REMOTE_ID);
  });

  it('still cleans health when the row is already gone (idempotent delete)', async () => {
    repo.getSubscription.mockResolvedValue(null);
    const res = await itemDELETE(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: REMOTE_ID }),
    } as never);
    // The service runs the delete CAS + best-effort health cleanup, then the
    // route 404s an already-gone row (removed:false) — health cleanup still
    // happened underneath.
    expect(res.status).toBe(404);
    expect(repo.commitSubscriptionDelete).toHaveBeenCalledTimes(1);
    expect(healthRepo.deleteSubscriptionFetchHealth).toHaveBeenCalledWith(REMOTE_ID);
  });
});
