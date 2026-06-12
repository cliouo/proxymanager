import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, Profile, Subscription } from '@/schemas';

const stores = new Map<string, Map<string, unknown>>();
/** Plain-key counters (config:version INCRs land here). */
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
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  // Chainable multi — repos now bundle the config:version INCR into the
  // same multi() as their writes.
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      hdel: (key: string, ...ids: string[]) => {
        ops.push(() => fakeRedis.hdel(key, ...ids));
        return tx;
      },
      incr: (key: string) => {
        ops.push(() => fakeRedis.incr(key));
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

function seedCollection(over: Partial<Collection>): Collection {
  const c: Collection = {
    id: crypto.randomUUID(),
    name: 'pool-a',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    ...over,
  } as Collection;
  bucket('collections').set(c.id, c);
  return c;
}

function seedProfile(over: Partial<Profile>): Profile {
  const p: Profile = {
    id: crypto.randomUUID(),
    name: 'seeded',
    source: { type: 'none' },
    updated_at: 1_700_000_000,
    ...over,
  } as Profile;
  bucket('profiles').set(p.id, p);
  return p;
}

describe('profileService — create', () => {
  it('creates with auto id and defaults source to none (unbound)', async () => {
    const p = await svc.createProfile({ name: 'default' });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.name).toBe('default');
    expect(p.source).toEqual({ type: 'none' });
  });

  it('binds to a single subscription', async () => {
    const a = seedSub({ name: 'a' });
    const p = await svc.createProfile({
      name: 'work',
      source: { type: 'subscription', id: a.id },
    });
    expect(p.source).toEqual({ type: 'subscription', id: a.id });
  });

  it('binds to a collection', async () => {
    const c = seedCollection({ name: 'pool' });
    const p = await svc.createProfile({
      name: 'agg',
      source: { type: 'collection', id: c.id },
    });
    expect(p.source).toEqual({ type: 'collection', id: c.id });
  });

  it('refuses an unknown subscription source', async () => {
    await expect(
      svc.createProfile({
        name: 'broken',
        source: { type: 'subscription', id: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toThrow(/绑定的订阅源不存在/);
  });

  it('refuses an unknown collection source', async () => {
    await expect(
      svc.createProfile({
        name: 'broken',
        source: { type: 'collection', id: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toThrow(/绑定的聚合订阅不存在/);
  });

  it('refuses duplicate profile name', async () => {
    seedProfile({ name: 'default' });
    await expect(svc.createProfile({ name: 'default' })).rejects.toThrow(/已存在/);
  });
});

describe('profileService — patch', () => {
  it('switches source to a single subscription', async () => {
    const a = seedSub({ name: 'a' });
    const p = seedProfile({ name: 'default', source: { type: 'none' } });
    const next = await svc.patchProfile(p.id, { source: { type: 'subscription', id: a.id } });
    expect(next.source).toEqual({ type: 'subscription', id: a.id });
  });

  it('switches source to a collection', async () => {
    const c = seedCollection({ name: 'pool' });
    const p = seedProfile({ name: 'default', source: { type: 'none' } });
    const next = await svc.patchProfile(p.id, { source: { type: 'collection', id: c.id } });
    expect(next.source).toEqual({ type: 'collection', id: c.id });
  });

  it('resetting source to none (unbound) is legal', async () => {
    const a = seedSub({ name: 'a' });
    const p = seedProfile({ name: 'default', source: { type: 'subscription', id: a.id } });
    const next = await svc.patchProfile(p.id, { source: { type: 'none' } });
    expect(next.source).toEqual({ type: 'none' });
  });

  it('rejects rename to an existing name', async () => {
    seedProfile({ name: 'default' });
    const other = seedProfile({ name: 'work' });
    await expect(svc.patchProfile(other.id, { name: 'default' })).rejects.toThrow(/已存在/);
  });

  it('rejects binding to an unknown subscription', async () => {
    const p = seedProfile({ name: 'default' });
    await expect(
      svc.patchProfile(p.id, {
        source: { type: 'subscription', id: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toThrow(/绑定的订阅源不存在/);
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
