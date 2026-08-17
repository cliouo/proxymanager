/**
 * POST /api/v1/subscriptions/{id}/refresh — v2 I14 exact snapshot sequence:
 *   getConfigVersion, getSubscription, validate, force resolve (noCache,
 *   recordHealth), getConfigVersion, getSubscription, project the SECOND
 *   captured row directly.
 * There is NO getSubscriptionAdminView helper, NO third definition read, and
 * NO old-row fallback: a missing second row is 404. A captured remote row
 * performs at most ONE health read (fingerprint-joined); a captured local row
 * performs ZERO health reads and omits policy/health. Refresh never writes a
 * definition.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@/schemas';
import { RemoteFetchAttemptError } from '@/lib/services/subscriptionResolutionErrors';

const fetchHealthRepo = vi.hoisted(() => ({
  // Loosely typed so both null and matching-health payloads are assignable.
  getSubscriptionFetchHealth: vi.fn<(id: string) => Promise<unknown>>(async () => null),
}));

const repos = vi.hoisted(() => ({
  getConfigVersion: vi.fn(async () => 7),
  getSubscription: vi.fn(),
  listSubscriptions: vi.fn(async () => []),
  listProfiles: vi.fn(async () => []),
  listCollections: vi.fn(async () => []),
  getOrdinalGeneration: vi.fn(async () => 0),
  commitSubscriptionChange: vi.fn(async () => ({ ok: true, currentVersion: 1 })),
}));

const resolveContent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: repos.getConfigVersion }));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionContent: resolveContent,
}));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  getSubscription: repos.getSubscription,
  getSubscriptionByName: vi.fn(async () => null),
  listSubscriptions: repos.listSubscriptions,
  commitSubscriptionChange: repos.commitSubscriptionChange,
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ listProfiles: repos.listProfiles }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: repos.listCollections }));
vi.mock('@/lib/repos/nodeOrdinalRepo', () => ({
  getOrdinalGeneration: repos.getOrdinalGeneration,
}));
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  createOrdinalPlanningSession: vi.fn(async () => ({
    registerSourceDomain: vi.fn(),
    fingerprintsForSource: vi.fn(() => undefined),
    resolverFor: vi.fn(() => () => undefined),
    seal: vi.fn(() => ({ expectedGeneration: 0, expectedGlobalSize: 0, sources: [] })),
  })),
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: vi.fn(async () => ({ configVersion: 7 })),
}));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/repos/subscriptionFetchHealthRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/subscriptionFetchHealthRepo')>();
  return {
    getSubscriptionFetchHealth: fetchHealthRepo.getSubscriptionFetchHealth,
    getSubscriptionFetchHealthMany: vi.fn(async () => []),
    recordSubscriptionFetchHealth: vi.fn(async () => undefined),
    computeSubscriptionDefinitionFingerprint: actual.computeSubscriptionDefinitionFingerprint,
    // Pure fingerprint-join used by the view projection — must be real.
    healthMatchesDefinition: actual.healthMatchesDefinition,
  };
});

import { POST } from '@/app/api/v1/subscriptions/[id]/refresh/route';
import { computeSubscriptionDefinitionFingerprint } from '@/lib/repos/subscriptionFetchHealthRepo';
import type { SubscriptionAdminView } from '@/schemas';

const SUB_ID = '11111111-1111-4111-8111-111111111111';

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: SUB_ID,
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

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.getConfigVersion.mockResolvedValue(7);
  repos.getSubscription.mockResolvedValue(sub());
  resolveContent.mockResolvedValue({
    yaml: 'proxies: []\n',
    traffic: undefined,
    proxyCount: 3,
  });
  fetchHealthRepo.getSubscriptionFetchHealth.mockResolvedValue(null);
});

describe('POST /api/v1/subscriptions/{id}/refresh (v2 I14)', () => {
  it('performs exactly the I14 interleaving: version1, sub1, resolve, version2, sub2, one optional health read', async () => {
    // Record the exact ordered call sequence, not just counts.
    const order: string[] = [];
    repos.getConfigVersion.mockImplementation(async () => {
      order.push('version');
      return 7;
    });
    repos.getSubscription.mockImplementation(async () => {
      order.push('sub');
      return sub();
    });
    resolveContent.mockImplementation(async () => {
      order.push('resolve');
      return { yaml: 'proxies: []\n', traffic: undefined, proxyCount: 3 };
    });
    fetchHealthRepo.getSubscriptionFetchHealth.mockImplementation(async () => {
      order.push('health');
      return null;
    });

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(res.status).toBe(200);

    // Exact I14 snapshot sequence — the force resolve sits BETWEEN the two
    // version/subscription pairs, and the projection reads health at most
    // once, AFTER the second row.
    expect(order).toEqual(['version', 'sub', 'resolve', 'version', 'sub', 'health']);

    expect(repos.getConfigVersion).toHaveBeenCalledTimes(2);
    expect(repos.getSubscription).toHaveBeenCalledTimes(2);
    // No helper reread: the route never calls listSubscriptions or any commit.
    expect(repos.listSubscriptions).not.toHaveBeenCalled();
    expect(repos.commitSubscriptionChange).not.toHaveBeenCalled();

    expect(resolveContent).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUB_ID }),
      expect.objectContaining({ noCache: true, recordHealth: true }),
    );
  });

  it('projects the SECOND captured row directly — moved definition identity, no old-row fallback', async () => {
    repos.getSubscription
      .mockResolvedValueOnce(sub())
      .mockResolvedValueOnce(
        sub({ display_name: '机场A·新', fetch_failure_policy: 'fail-closed' }),
      );

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    const body = (await json(res)) as { data: SubscriptionAdminView };
    expect(body.data.display_name).toBe('机场A·新');
    expect(body.data.fetch_failure_policy).toBe('fail-closed');
    expect(repos.getSubscription).toHaveBeenCalledTimes(2);
  });

  it('a missing SECOND row returns 404 instead of falling back to the old row', async () => {
    repos.getSubscription.mockResolvedValueOnce(sub()).mockResolvedValueOnce(null);

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(res.status).toBe(404);
    expect(repos.getSubscription).toHaveBeenCalledTimes(2);
  });

  it('joins matching health at most once for a remote row; mismatched fingerprint joins null', async () => {
    const matching = {
      definition_fingerprint: computeSubscriptionDefinitionFingerprint(sub()),
      state: 'fresh' as const,
      attempted_at: 1_700_000_000_000,
      observed_at: 1_700_000_000_001,
      fresh_at: 1_700_000_000_001,
      proxy_count: 3,
    };
    fetchHealthRepo.getSubscriptionFetchHealth.mockResolvedValue(matching);

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    const body = (await json(res)) as { data: SubscriptionAdminView };
    expect(body.data.fetch_health).toMatchObject({ state: 'fresh', proxy_count: 3 });
    expect(fetchHealthRepo.getSubscriptionFetchHealth).toHaveBeenCalledTimes(1);

    fetchHealthRepo.getSubscriptionFetchHealth.mockResolvedValue({
      ...matching,
      definition_fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const mismatched = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    const body2 = (await mismatched.json()) as { data: SubscriptionAdminView };
    expect(body2.data.fetch_health).toBeNull();
    expect(fetchHealthRepo.getSubscriptionFetchHealth).toHaveBeenCalledTimes(2);
  });

  it('returns fresh health after a successful refresh even when Redis still holds stale-served', async () => {
    fetchHealthRepo.getSubscriptionFetchHealth.mockResolvedValue({
      definition_fingerprint: computeSubscriptionDefinitionFingerprint(sub()),
      state: 'stale-served',
      attempted_at: 1_700_000_000_000,
      observed_at: 1_700_000_000_001,
      fresh_at: 1_600_000_000_000,
      failure_category: 'proxy-node',
      cache_disposition: 'served',
      proxy_count: 300,
    });

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    const body = (await json(res)) as { data: SubscriptionAdminView };
    expect(body.data.fetch_health).toMatchObject({ state: 'fresh', proxy_count: 3 });
    expect(fetchHealthRepo.getSubscriptionFetchHealth).toHaveBeenCalledTimes(1);
    expect(fetchHealthRepo.getSubscriptionFetchHealth).toHaveBeenCalledWith(SUB_ID);
  });

  it('a captured LOCAL row performs ZERO health reads and omits policy and health', async () => {
    repos.getSubscription.mockResolvedValue(
      sub({
        kind: 'local',
        url: undefined,
        content: 'proxies: []\n',
        fetch_failure_policy: 'fail-closed',
      }),
    );

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { data: SubscriptionAdminView };
    expect(body.data.kind).toBe('local');
    expect(body.data.fetch_failure_policy).toBeUndefined();
    expect(body.data.fetch_health).toBeUndefined();
    expect(fetchHealthRepo.getSubscriptionFetchHealth).not.toHaveBeenCalled();
    expect(repos.getSubscription).toHaveBeenCalledTimes(2);
  });

  it('a typed transport failure surfaces as a fixed 503 with no row write', async () => {
    resolveContent.mockRejectedValue(new RemoteFetchAttemptError('network'));

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        type: 'https://proxymanager.dev/errors/service-unavailable',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Upstream fetch failed',
      }),
    );
    expect(repos.commitSubscriptionChange).not.toHaveBeenCalled();
  });

  it('a typed response-content failure surfaces as a fixed 422', async () => {
    resolveContent.mockRejectedValue(new RemoteFetchAttemptError('response-content-format'));

    const res = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body).toMatchObject({
      type: 'https://proxymanager.dev/errors/invalid-upstream-response',
      title: 'Invalid upstream response',
      status: 422,
      detail: 'Upstream response content is not a valid subscription',
    });
  });

  it('404s an unknown subscription and 422s a disabled one before any resolve', async () => {
    repos.getSubscription.mockResolvedValue(null);
    const missing = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(missing.status).toBe(404);
    expect(resolveContent).not.toHaveBeenCalled();
    expect(repos.getSubscription).toHaveBeenCalledTimes(1);

    repos.getSubscription.mockResolvedValue(sub({ enabled: false }));
    const disabled = await POST(new Request('https://pm.test/x'), {
      params: Promise.resolve({ id: SUB_ID }),
    } as never);
    expect(disabled.status).toBe(422);
    expect(resolveContent).not.toHaveBeenCalled();
  });
});
