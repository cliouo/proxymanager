import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, Subscription } from '@/schemas';

const stores = new Map<string, Map<string, unknown>>();
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
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));

let svc: typeof import('@/lib/services/profileService');

beforeEach(async () => {
  stores.clear();
  svc = await import('@/lib/services/profileService');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedSub(over: Partial<Subscription>): Subscription {
  const s: Subscription = {
    id: crypto.randomUUID(),
    name: 'sub-a',
    enabled: true,
    kind: 'remote',
    url: 'https://example.com',
    tags: [],
    operators: [],
    ttl_ms: 600_000,
    ...over,
  } as Subscription;
  bucket('subscriptions').set(s.id, s);
  return s;
}

function seedProfile(over: Partial<Profile>): Profile {
  const p: Profile = {
    id: crypto.randomUUID(),
    name: 'seeded',
    subscription_ids: [],
    updated_at: 1_700_000_000,
    ...over,
  } as Profile;
  bucket('profiles').set(p.id, p);
  return p;
}

describe('profileService — create', () => {
  it('creates with auto id and default empty binding', async () => {
    const p = await svc.createProfile({ name: 'default' });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.name).toBe('default');
    expect(p.subscription_ids).toEqual([]);
  });

  it('binds to existing subscriptions and persists order', async () => {
    const a = seedSub({ name: 'a' });
    const b = seedSub({ name: 'b' });
    const p = await svc.createProfile({
      name: 'work',
      subscription_ids: [b.id, a.id],
    });
    expect(p.subscription_ids).toEqual([b.id, a.id]);
  });

  it('refuses an unknown subscription_id', async () => {
    await expect(
      svc.createProfile({
        name: 'broken',
        subscription_ids: ['00000000-0000-0000-0000-000000000000'],
      }),
    ).rejects.toThrow(/subscription_ids 中包含未知订阅源/);
  });

  it('refuses duplicate profile name', async () => {
    seedProfile({ name: 'default' });
    await expect(svc.createProfile({ name: 'default' })).rejects.toThrow(/已存在/);
  });
});

describe('profileService — patch', () => {
  it('updates subscription_ids', async () => {
    const a = seedSub({ name: 'a' });
    const b = seedSub({ name: 'b' });
    const p = seedProfile({ name: 'default', subscription_ids: [a.id] });
    const next = await svc.patchProfile(p.id, { subscription_ids: [a.id, b.id] });
    expect(next.subscription_ids).toEqual([a.id, b.id]);
  });

  it('rejects rename to an existing name', async () => {
    seedProfile({ name: 'default' });
    const other = seedProfile({ name: 'work' });
    await expect(svc.patchProfile(other.id, { name: 'default' })).rejects.toThrow(/已存在/);
  });

  it('clearing subscription_ids to [] is legal (legacy fallback)', async () => {
    const a = seedSub({ name: 'a' });
    const p = seedProfile({ name: 'default', subscription_ids: [a.id] });
    const next = await svc.patchProfile(p.id, { subscription_ids: [] });
    expect(next.subscription_ids).toEqual([]);
  });

  it('rejects binding to an unknown subscription_id', async () => {
    const p = seedProfile({ name: 'default' });
    await expect(
      svc.patchProfile(p.id, {
        subscription_ids: ['00000000-0000-0000-0000-000000000000'],
      }),
    ).rejects.toThrow(/subscription_ids 中包含未知订阅源/);
  });
});

describe('profileService — delete', () => {
  it('refuses to delete the last remaining profile', async () => {
    const p = seedProfile({ name: 'default' });
    await expect(svc.deleteProfile(p.id)).rejects.toThrow(/至少保留一个/);
  });

  it('deletes a non-last profile', async () => {
    seedProfile({ name: 'default' });
    const other = seedProfile({ name: 'work' });
    const removed = await svc.deleteProfile(other.id);
    expect(removed).toBe(true);
    expect(await svc.getProfile(other.id)).toBeNull();
  });

  it('returns false for an unknown id', async () => {
    expect(await svc.deleteProfile('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});
