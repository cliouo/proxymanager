import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RuleSet {
  id: string;
  name: string;
  format: 'yaml' | 'text';
  content: string;
  updated_at: number;
}

// In-memory mock of the redis client used by the repo. Mirrors the split
// storage: hash field = meta (content ''), standalone key = the body.
const store = new Map<string, RuleSet>();
/** Standalone keys (rule-set-content:{id} bodies land here). */
const kv = new Map<string, string>();
/** Plain-key counters (config:version INCRs land here). */
const counters = new Map<string, number>();
const fakeRedis = {
  hgetall: async () => (store.size === 0 ? null : Object.fromEntries(store)),
  hget: async (_k: string, id: string) => store.get(id) ?? null,
  get: async (key: string) => (kv.has(key) ? kv.get(key) : null),
  set: async (key: string, value: string) => {
    kv.set(key, value);
  },
  del: async (key: string) => (kv.delete(key) ? 1 : 0),
  hset: async (_k: string, payload: Record<string, RuleSet>) => {
    for (const [id, value] of Object.entries(payload)) store.set(id, value);
  },
  hdel: async (_k: string, id: string) => {
    return store.delete(id) ? 1 : 0;
  },
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  // Chainable multi — the repo bundles meta hset + content set + the
  // config:version INCR into one multi() (and hdel + del + incr on delete).
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, RuleSet>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      hdel: (key: string, id: string) => {
        ops.push(() => fakeRedis.hdel(key, id));
        return tx;
      },
      set: (key: string, value: string) => {
        ops.push(() => fakeRedis.set(key, value));
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

vi.mock('@/lib/redis/client', () => ({
  getRedis: () => fakeRedis,
}));

let svc: typeof import('@/lib/services/ruleSetService');

beforeEach(async () => {
  store.clear();
  kv.clear();
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

  it('patch without content keeps the stored body (read from the content key)', async () => {
    const a = await svc.createRuleSet({ name: 'emby', format: 'yaml', content: 'v1' });
    const b = await svc.patchRuleSet(a.id, { note: 'hello' });
    expect(b.content).toBe('v1');
    expect((await svc.getRuleSet(a.id))?.content).toBe('v1');
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
