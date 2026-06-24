import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { RuleSchema, type Collection, type Profile, type ProxyGroup, type Rule, type Subscription } from '@/schemas';

const stores = new Map<string, Map<string, unknown>>();
/** Plain string keys (base:content/meta, config:version, backups). */
const kv = new Map<string, unknown>();
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
  get: async (key: string) => kv.get(key) ?? null,
  set: async (key: string, value: unknown) => {
    kv.set(key, value);
  },
  del: async (key: string) => {
    kv.delete(key);
    stores.delete(key);
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
      set: (key: string, value: unknown) => {
        ops.push(() => fakeRedis.set(key, value));
        return tx;
      },
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      hdel: (key: string, ...ids: string[]) => {
        ops.push(() => fakeRedis.hdel(key, ...ids));
        return tx;
      },
      del: (key: string) => {
        ops.push(() => fakeRedis.del(key));
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
  kv.clear();
  counters.clear();
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

  it('cleans up the deleted profile’s owned config keys', async () => {
    seedProfile({ name: 'default' });
    const other = seedProfile({ name: 'work' });
    // Seed the profile's owned config.
    kv.set(REDIS_KEYS.base.content(other.id), 'proxies: []\n');
    kv.set(REDIS_KEYS.base.meta(other.id), { etag: 'e', anchors: [], policies: [], updated_at: 0 });
    bucket(REDIS_KEYS.rules(other.id)).set('r1', { id: 'r1' });
    bucket(REDIS_KEYS.proxyGroups(other.id)).set('g1', { id: 'g1' });

    expect(await svc.deleteProfile(other.id)).toBe(true);
    expect(kv.get(REDIS_KEYS.base.content(other.id))).toBeUndefined();
    expect(kv.get(REDIS_KEYS.base.meta(other.id))).toBeUndefined();
    expect(stores.get(REDIS_KEYS.rules(other.id))).toBeUndefined();
    expect(stores.get(REDIS_KEYS.proxyGroups(other.id))).toBeUndefined();
  });
});

describe('profileService — clone-on-create (Phase 2)', () => {
  /**
   * Seed a source profile that owns a base + one group + one rule + taxonomy.
   * Records are built schema-valid (real uuids) so listProxyGroups/listRules,
   * which normalise on read, don't drop them. Returns the source ids.
   */
  function seedOwnedConfig(p: Profile): { groupId: string; ruleId: string } {
    kv.set(REDIS_KEYS.base.content(p.id), 'proxies: []\n# === PROXY-GROUPS ===\n');
    kv.set(REDIS_KEYS.base.meta(p.id), {
      etag: 'etag-src',
      anchors: ['manual'],
      policies: ['PROXY'],
      updated_at: 100,
    });
    const groupId = crypto.randomUUID();
    const group = {
      id: groupId,
      name: 'MyGroup',
      type: 'select',
      kind: 'manual',
      rank: 10,
      proxies: ['DIRECT'],
      updated_at: 0,
    } as unknown as ProxyGroup;
    bucket(REDIS_KEYS.proxyGroups(p.id)).set(groupId, group);
    const rule = RuleSchema.parse({
      id: crypto.randomUUID(),
      anchor: 'manual',
      type: 'DOMAIN',
      value: 'a.com',
      policy: 'MyGroup',
      rank: 10,
      source: 'manual',
      added_at: 0,
      updated_at: 0,
    }) as Rule;
    bucket(REDIS_KEYS.rules(p.id)).set(rule.id, rule);
    bucket(REDIS_KEYS.taxonomy.groups(p.id)).set('MyGroup', { kind: 'custom' });
    return { groupId, ruleId: rule.id };
  }

  it('copy_from deep-copies base + groups + rules + taxonomy with new ids, names preserved', async () => {
    const src = seedProfile({ name: 'default' });
    const seeded = seedOwnedConfig(src);

    const dest = await svc.createProfile({ name: 'cloned', copy_from: src.id });

    // base copied
    expect(kv.get(REDIS_KEYS.base.content(dest.id))).toBe('proxies: []\n# === PROXY-GROUPS ===\n');
    // groups copied with NEW id, SAME name
    const groups = Object.values(
      Object.fromEntries(bucket(REDIS_KEYS.proxyGroups(dest.id))),
    ) as ProxyGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('MyGroup');
    expect(groups[0].id).not.toBe(seeded.groupId);
    // rules copied with NEW id, references preserved (policy by name)
    const rules = Object.values(Object.fromEntries(bucket(REDIS_KEYS.rules(dest.id)))) as Rule[];
    expect(rules).toHaveLength(1);
    expect(rules[0].policy).toBe('MyGroup');
    expect(rules[0].id).not.toBe(seeded.ruleId);
    // taxonomy copied (keyed by group name)
    expect(bucket(REDIS_KEYS.taxonomy.groups(dest.id)).get('MyGroup')).toEqual({ kind: 'custom' });
  });

  it('editing the clone’s groups does not touch the source (isolation)', async () => {
    const src = seedProfile({ name: 'default' });
    seedOwnedConfig(src);
    const dest = await svc.createProfile({ name: 'cloned', copy_from: src.id });

    // Mutate the clone's proxy-groups hash directly.
    bucket(REDIS_KEYS.proxyGroups(dest.id)).clear();

    // Source is untouched.
    expect(bucket(REDIS_KEYS.proxyGroups(src.id)).size).toBe(1);
  });

  it('blank create (no copy_from) seeds base only from default, no groups/rules', async () => {
    const def = seedProfile({ name: 'default' });
    seedOwnedConfig(def);

    const dest = await svc.createProfile({ name: 'fresh' }); // no copy_from

    expect(kv.get(REDIS_KEYS.base.content(dest.id))).toBe(
      'proxies: []\n# === PROXY-GROUPS ===\n',
    );
    expect(stores.get(REDIS_KEYS.proxyGroups(dest.id))).toBeUndefined();
    expect(stores.get(REDIS_KEYS.rules(dest.id))).toBeUndefined();
  });

  it('rejects copy_from pointing at a non-existent profile', async () => {
    seedProfile({ name: 'default' });
    await expect(
      svc.createProfile({ name: 'x', copy_from: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/复制来源/);
  });
});
