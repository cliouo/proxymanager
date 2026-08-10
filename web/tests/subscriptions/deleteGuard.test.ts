import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0-2: deleting a subscription is delete-but-warn — it must surface which
 * profiles bound it as their source and which aggregate subscriptions listed
 * it as a member, so the user knows what just lost its node source (the render
 * pipeline separately falls back to DIRECT, so nothing becomes unloadable).
 */

const SUB = { id: 's1', name: 'air-hk', display_name: '香港机场' };
let currentSub: typeof SUB | null = SUB;

let profiles: Array<{ id: string; name: string; source: { type: string; id?: string } }>;
let collections: Array<{ id: string; name: string; subscription_ids: string[] }>;
const commitDeleteMock = vi.fn(async (id: string, version: number, plan?: unknown) => {
  void plan;
  return {
    ok: true,
    currentVersion: id === 's1' ? version : 0,
  };
});
const healthDeleteMock = vi.fn(async () => undefined);
const ordinalPlan = { expectedGeneration: 0, expectedGlobalSize: 0, sources: [] };

vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  getSubscription: async (id: string) => (id === SUB.id ? currentSub : null),
  getSubscriptionByName: async () => null,
  listSubscriptions: async () => [SUB],
  commitSubscriptionDelete: (id: string, version: number, plan: typeof ordinalPlan) =>
    commitDeleteMock(id, version, plan),
}));
// A standalone health deletion would hit this Redis mock. The committed delete
// CAS must own cleanup, so both successful and already-absent deletes leave it
// untouched.
vi.mock('@/lib/redis/client', () => ({
  getRedis: () => ({ del: healthDeleteMock }),
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ listProfiles: async () => profiles }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: async () => collections }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: async () => 7 }));
vi.mock('@/lib/repos/nodeOrdinalRepo', () => ({ getOrdinalGeneration: async () => 0 }));
vi.mock('@/lib/services/nodeOrdinalService', () => ({
  createOrdinalPlanningSession: vi.fn(async () => ({
    registerSourceDomain: vi.fn(),
    fingerprintsForSource: vi.fn(() => undefined),
    resolverFor: vi.fn(() => () => undefined),
    seal: vi.fn(() => ordinalPlan),
  })),
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: async (profileId: string) => ({
    configVersion: 7,
    ordinalGeneration: 0,
    ordinalPlan,
    candidate: { profileId },
  }),
}));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: async () => undefined,
}));

let svc: typeof import('@/lib/services/subscriptionService');

beforeEach(async () => {
  vi.clearAllMocks();
  currentSub = SUB;
  profiles = [];
  collections = [];
  svc = await import('@/lib/services/subscriptionService');
});

describe('deleteSubscription reference warnings (P0-2)', () => {
  it('warns about profiles bound to the subscription as their source', async () => {
    profiles = [
      { id: 'p1', name: 'work', source: { type: 'subscription', id: 's1' } },
      { id: 'p2', name: 'home', source: { type: 'none' } },
    ];
    const { removed, warnings } = await svc.deleteSubscription('s1');
    expect(removed).toBe(true);
    expect(warnings.some((w) => w.includes('work') && w.includes('配置文件'))).toBe(true);
  });

  it('warns about aggregate subscriptions that include it as a member', async () => {
    collections = [{ id: 'c1', name: '全球', subscription_ids: ['s1', 'sX'] }];
    const { warnings } = await svc.deleteSubscription('s1');
    expect(warnings.some((w) => w.includes('全球') && w.includes('聚合'))).toBe(true);
  });

  it('returns no warnings when nothing references it', async () => {
    const { removed, warnings } = await svc.deleteSubscription('s1');
    expect(removed).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('still deletes (delete-but-warn, never blocks) — via the CAS delete gate', async () => {
    profiles = [{ id: 'p1', name: 'work', source: { type: 'subscription', id: 's1' } }];
    await svc.deleteSubscription('s1');
    expect(commitDeleteMock).toHaveBeenCalledTimes(1);
    expect(commitDeleteMock).toHaveBeenCalledWith('s1', 7, ordinalPlan);
  });

  it('uses the delete CAS exactly once without a standalone fetch-health delete', async () => {
    await expect(svc.deleteSubscription('s1')).resolves.toMatchObject({ removed: true });
    expect(commitDeleteMock).toHaveBeenCalledTimes(1);
    expect(healthDeleteMock).not.toHaveBeenCalled();

    currentSub = null;
    await expect(svc.deleteSubscription('s1')).resolves.toMatchObject({ removed: false });
    expect(commitDeleteMock).toHaveBeenCalledTimes(2);
    expect(healthDeleteMock).not.toHaveBeenCalled();
  });
});
