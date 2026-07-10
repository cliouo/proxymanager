import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0-2: deleting a subscription is delete-but-warn — it must surface which
 * profiles bound it as their source and which aggregate subscriptions listed
 * it as a member, so the user knows what just lost its node source (the render
 * pipeline separately falls back to DIRECT, so nothing becomes unloadable).
 */

const SUB = { id: 's1', name: 'air-hk', display_name: '香港机场' };

let profiles: Array<{ id: string; name: string; source: { type: string; id?: string } }>;
let collections: Array<{ id: string; name: string; subscription_ids: string[] }>;
const repoDeleteMock = vi.fn(async () => true);

vi.mock('@/lib/repos/subscriptionsRepo', () => ({
  getSubscription: async (id: string) => (id === SUB.id ? SUB : null),
  getSubscriptionByName: async () => null,
  listSubscriptions: async () => [SUB],
  upsertSubscription: async () => undefined,
  deleteSubscription: () => repoDeleteMock(),
}));
vi.mock('@/lib/repos/profilesRepo', () => ({ listProfiles: async () => profiles }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: async () => collections }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: async () => undefined,
}));

let svc: typeof import('@/lib/services/subscriptionService');

beforeEach(async () => {
  vi.clearAllMocks();
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

  it('still deletes (delete-but-warn, never blocks)', async () => {
    profiles = [{ id: 'p1', name: 'work', source: { type: 'subscription', id: 's1' } }];
    await svc.deleteSubscription('s1');
    expect(repoDeleteMock).toHaveBeenCalledTimes(1);
  });
});
