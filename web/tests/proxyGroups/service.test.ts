import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyGroup, Rule } from '@/schemas';

/**
 * One in-memory hash store per Redis key, so the proxy-group service can
 * operate on proxy-groups + templates + rules side-by-side just like prod.
 */
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
    for (const id of ids) {
      if (m.delete(id)) n++;
    }
    return n;
  },
  del: async (key: string) => {
    stores.delete(key);
  },
  multi: () => ({
    set: () => undefined,
    hset: () => undefined,
    hdel: () => undefined,
    exec: async () => undefined,
  }),
  get: async () => null,
  set: async () => undefined,
};

vi.mock('@/lib/redis/client', () => ({
  getRedis: () => fakeRedis,
}));

vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));

let svc: typeof import('@/lib/services/proxyGroupService');
let tplSvc: typeof import('@/lib/services/proxyGroupTemplateService');

beforeEach(async () => {
  stores.clear();
  svc = await import('@/lib/services/proxyGroupService');
  tplSvc = await import('@/lib/services/proxyGroupTemplateService');
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Seed a group directly into the hash, bypassing service validation. */
function seedGroup(over: Partial<ProxyGroup>): ProxyGroup {
  const now = 1_700_000_000;
  const g: ProxyGroup = {
    id: crypto.randomUUID(),
    kind: 'raw',
    name: 'seeded',
    type: 'select',
    rank: 10,
    created_at: now,
    updated_at: now,
    ...over,
  } as ProxyGroup;
  bucket('proxy-groups').set(g.id, g);
  return g;
}

function seedRule(over: Partial<Rule>): Rule {
  const r: Rule = {
    id: crypto.randomUUID(),
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'x.example',
    policy: 'default',
    rank: 10,
    source: 'manual',
    added_at: 0,
    updated_at: 0,
    ...over,
  } as Rule;
  bucket('rules').set(r.id, r);
  return r;
}

describe('proxyGroupService — create', () => {
  it('creates with auto id, default kind=raw, rank assigned', async () => {
    const g = await svc.createProxyGroup({ name: 'us', type: 'select', proxies: ['DIRECT'] });
    expect(g.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(g.kind).toBe('raw');
    expect(g.rank).toBe(10);
    expect(g.name).toBe('us');
  });

  it('rejects duplicate name', async () => {
    await svc.createProxyGroup({ name: 'us', type: 'select' });
    await expect(
      svc.createProxyGroup({ name: 'us', type: 'select' }),
    ).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('rejects unknown template_id', async () => {
    await expect(
      svc.createProxyGroup({
        name: 'x',
        type: 'select',
        template_id: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });

  it('accepts known template_id', async () => {
    const tpl = await tplSvc.createProxyGroupTemplate({ name: 'pr', type: 'url-test', interval: 600 });
    const g = await svc.createProxyGroup({
      name: 'x',
      type: 'url-test',
      template_id: tpl.id,
    });
    expect(g.template_id).toBe(tpl.id);
  });

  it('refuses a self-loop dialer-proxy cycle on create', async () => {
    await expect(
      svc.createProxyGroup({
        name: 'self',
        type: 'select',
        proxies: ['DIRECT'],
        'dialer-proxy': 'self',
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });

  it('refuses a 2-hop dialer-proxy cycle on create', async () => {
    seedGroup({ name: 'a', 'dialer-proxy': 'b' });
    await expect(
      svc.createProxyGroup({
        name: 'b',
        type: 'select',
        proxies: ['DIRECT'],
        'dialer-proxy': 'a',
      }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });

  it('assigns rank = max(existing) + 10', async () => {
    seedGroup({ name: 'a', rank: 50 });
    seedGroup({ name: 'b', rank: 100 });
    const g = await svc.createProxyGroup({ name: 'c', type: 'select' });
    expect(g.rank).toBe(110);
  });
});

describe('proxyGroupService — patch + rename cascade', () => {
  it('renames a group and updates referencing groups + rules', async () => {
    const target = seedGroup({ name: 'old', proxies: ['DIRECT'] });
    seedGroup({ name: 'parent', proxies: ['old', 'DIRECT'] });
    seedGroup({ name: 'chain', proxies: ['DIRECT'], 'dialer-proxy': 'old' });
    seedRule({ policy: 'old' });
    seedRule({ policy: 'unrelated' });

    await svc.patchProxyGroup(target.id, { name: 'fresh' });

    const all = await svc.listProxyGroups();
    const renamed = all.find((g) => g.id === target.id);
    expect(renamed?.name).toBe('fresh');
    const parent = all.find((g) => g.name === 'parent');
    expect(parent?.proxies).toEqual(['fresh', 'DIRECT']);
    const chain = all.find((g) => g.name === 'chain');
    expect(chain?.['dialer-proxy']).toBe('fresh');

    const rules = Array.from(bucket('rules').values()) as Rule[];
    expect(rules.find((r) => r.policy === 'fresh')).toBeTruthy();
    expect(rules.find((r) => r.policy === 'old')).toBeFalsy();
    expect(rules.find((r) => r.policy === 'unrelated')).toBeTruthy();
  });

  it('rename to existing name conflicts', async () => {
    const a = seedGroup({ name: 'a' });
    seedGroup({ name: 'b' });
    await expect(svc.patchProxyGroup(a.id, { name: 'b' })).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('null clears nullable optional (notes/section)', async () => {
    const g = seedGroup({ name: 'x', notes: 'before' });
    const patched = await svc.patchProxyGroup(g.id, { notes: null });
    expect(patched.notes).toBeUndefined();
  });

  it('refuses a patch that would introduce a dialer-proxy cycle', async () => {
    const a = seedGroup({ name: 'a' });
    seedGroup({ name: 'b', 'dialer-proxy': 'a' });
    await expect(
      svc.patchProxyGroup(a.id, { 'dialer-proxy': 'b' }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });
});

describe('proxyGroupService — delete', () => {
  it('refuses delete when another group references it via proxies', async () => {
    const target = seedGroup({ name: 'busy' });
    seedGroup({ name: 'parent', proxies: ['busy'] });
    await expect(svc.deleteProxyGroup(target.id)).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('refuses delete when another group references it via dialer-proxy', async () => {
    const target = seedGroup({ name: 'pool' });
    seedGroup({ name: 'wrap', 'dialer-proxy': 'pool' });
    await expect(svc.deleteProxyGroup(target.id)).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('refuses delete when a rule policies into it', async () => {
    const target = seedGroup({ name: 'used' });
    seedRule({ policy: 'used' });
    await expect(svc.deleteProxyGroup(target.id)).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('succeeds when nothing references it', async () => {
    const target = seedGroup({ name: 'lone' });
    expect(await svc.deleteProxyGroup(target.id)).toBe(true);
    expect(await svc.getProxyGroup(target.id)).toBeNull();
  });
});

describe('proxyGroupService — batch create + delete', () => {
  it('batch-creates a pool + wrap pair in one shot', async () => {
    const [pool, wrap] = await svc.createProxyGroups([
      { name: 'pool', type: 'select', proxies: ['f1', 'f2'] },
      { name: 'wrap', type: 'select', proxies: ['b'], 'dialer-proxy': 'pool' },
    ]);
    expect(pool.name).toBe('pool');
    expect(wrap['dialer-proxy']).toBe('pool');
    const all = await svc.listProxyGroups();
    expect(all.map((g) => g.name).sort()).toEqual(['pool', 'wrap']);
  });

  it('refuses batch-create with internal duplicate', async () => {
    await expect(
      svc.createProxyGroups([
        { name: 'dup', type: 'select' },
        { name: 'dup', type: 'select' },
      ]),
    ).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('refuses batch-create that would cycle (wrap.dialer-proxy → pool whose dialer-proxy → wrap)', async () => {
    await expect(
      svc.createProxyGroups([
        { name: 'a', type: 'select', 'dialer-proxy': 'b' },
        { name: 'b', type: 'select', 'dialer-proxy': 'a' },
      ]),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });

  it('bulk-deletes by name, allowing intra-batch refs but rejecting external refs', async () => {
    seedGroup({ name: 'pool', proxies: ['f1'] });
    seedGroup({ name: 'wrap', proxies: ['b'], 'dialer-proxy': 'pool' });
    // intra-batch (wrap→pool) is fine when both are deleted.
    expect(await svc.deleteProxyGroupsByName(['wrap', 'pool'])).toBe(2);
    expect((await svc.listProxyGroups()).length).toBe(0);
  });

  it('refuses bulk-delete when an external group still references the batch', async () => {
    seedGroup({ name: 'pool' });
    seedGroup({ name: 'wrap', 'dialer-proxy': 'pool' });
    seedGroup({ name: 'outsider', proxies: ['pool'] }); // external ref
    await expect(svc.deleteProxyGroupsByName(['wrap', 'pool'])).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });
});

describe('proxyGroupTemplateService', () => {
  it('creates + deletes when unreferenced', async () => {
    const tpl = await tplSvc.createProxyGroupTemplate({ name: 'pr', interval: 600 });
    expect(await tplSvc.deleteProxyGroupTemplate(tpl.id)).toBe(true);
  });

  it('refuses delete when a group still references the template', async () => {
    const tpl = await tplSvc.createProxyGroupTemplate({ name: 'pr', interval: 600 });
    await svc.createProxyGroup({
      name: 'g',
      type: 'url-test',
      template_id: tpl.id,
    });
    await expect(tplSvc.deleteProxyGroupTemplate(tpl.id)).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });
});
