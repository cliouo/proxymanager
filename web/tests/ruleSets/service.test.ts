import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RuleSet {
  id: string;
  name: string;
  format: 'yaml' | 'text';
  content: string;
  updated_at: number;
}

// In-memory mock of the redis client used by the repo.
const store = new Map<string, RuleSet>();
const fakeRedis = {
  hgetall: async () => (store.size === 0 ? null : Object.fromEntries(store)),
  hget: async (_k: string, id: string) => store.get(id) ?? null,
  hset: async (_k: string, payload: Record<string, RuleSet>) => {
    for (const [id, value] of Object.entries(payload)) store.set(id, value);
  },
  hdel: async (_k: string, id: string) => {
    return store.delete(id) ? 1 : 0;
  },
};

vi.mock('@/lib/redis/client', () => ({
  getRedis: () => fakeRedis,
}));

let svc: typeof import('@/lib/services/ruleSetService');

beforeEach(async () => {
  store.clear();
  svc = await import('@/lib/services/ruleSetService');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ruleSetService', () => {
  it('creates with auto id + updated_at', async () => {
    const set = await svc.createRuleSet({
      name: 'emby_classic',
      format: 'yaml',
      behavior: 'classical',
      content: 'payload: []\n',
    });
    expect(set.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(set.updated_at).toBeGreaterThan(0);
    expect(set.name).toBe('emby_classic');
  });

  it('rejects duplicate name on create', async () => {
    await svc.createRuleSet({ name: 'emby', format: 'yaml', content: '' });
    await expect(
      svc.createRuleSet({ name: 'emby', format: 'yaml', content: 'other' }),
    ).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('replace preserves id and bumps updated_at', async () => {
    const a = await svc.createRuleSet({ name: 'emby', format: 'yaml', content: 'v1' });
    await new Promise((r) => setTimeout(r, 1100));
    const b = await svc.replaceRuleSet(a.id, {
      name: 'emby',
      format: 'yaml',
      content: 'v2',
    });
    expect(b.id).toBe(a.id);
    expect(b.content).toBe('v2');
    expect(b.updated_at).toBeGreaterThan(a.updated_at);
  });

  it('patch merges partial fields', async () => {
    const a = await svc.createRuleSet({
      name: 'emby',
      format: 'yaml',
      content: 'v1',
      note: 'first',
    });
    const b = await svc.patchRuleSet(a.id, { content: 'v2' });
    expect(b.name).toBe('emby');
    expect(b.note).toBe('first');
    expect(b.content).toBe('v2');
  });

  it('rejects rename to existing name', async () => {
    await svc.createRuleSet({ name: 'a', format: 'yaml', content: '' });
    const b = await svc.createRuleSet({ name: 'b', format: 'yaml', content: '' });
    await expect(svc.patchRuleSet(b.id, { name: 'a' })).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('delete returns true then false', async () => {
    const a = await svc.createRuleSet({ name: 'a', format: 'yaml', content: '' });
    expect(await svc.deleteRuleSet(a.id)).toBe(true);
    expect(await svc.deleteRuleSet(a.id)).toBe(false);
  });

  it('list sorts by name', async () => {
    await svc.createRuleSet({ name: 'zeta', format: 'yaml', content: '' });
    await svc.createRuleSet({ name: 'alpha', format: 'yaml', content: '' });
    await svc.createRuleSet({ name: 'mu', format: 'yaml', content: '' });
    const all = await svc.listRuleSets();
    expect(all.map((s) => s.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});
