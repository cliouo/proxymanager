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
/** Any other hash the service touches (profiles / per-profile rules). */
const hashes = new Map<string, Map<string, unknown>>();

function hash(key: string): Map<string, unknown> {
  if (key === 'rule-sets') return store as unknown as Map<string, unknown>;
  let m = hashes.get(key);
  if (!m) {
    m = new Map();
    hashes.set(key, m);
  }
  return m;
}

const fakeRedis = {
  hgetall: async (key: string) => {
    const m = hash(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hget: async (key: string, id: string) => hash(key).get(id) ?? null,
  get: async (key: string) => {
    if (counters.has(key)) return counters.get(key)!;
    return kv.has(key) ? kv.get(key) : null;
  },
  set: async (key: string, value: string) => {
    kv.set(key, value);
  },
  del: async (key: string) => (kv.delete(key) ? 1 : 0),
  hset: async (key: string, payload: Record<string, unknown>) => {
    const m = hash(key);
    for (const [id, value] of Object.entries(payload)) m.set(id, value);
  },
  hdel: async (key: string, id: string) => (hash(key).delete(id) ? 1 : 0),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  /**
   * CAS_RULE_SET_CHANGE 的行为等价实现:比对 config:version → 写/删规则集
   * (meta + 正文) → 级联写规则 → INCR。参数布局与 repo 里的脚本一一对应。
   */
  eval: async (_script: string, keys: string[], args: (string | number)[]) => {
    const [versionKey, setsKey, contentKey, ...ruleKeys] = keys;
    const a = args.map(String);
    const expected = Number(a[0]);
    const current = counters.get(versionKey) ?? 0;
    if (current !== expected) return [0, String(current)];

    const mode = a[1];
    const setId = a[2];
    if (mode === 'write') {
      hash(setsKey).set(setId, JSON.parse(a[3]));
      kv.set(contentKey, a[4]);
    } else if (mode === 'delete') {
      hash(setsKey).delete(setId);
      kv.delete(contentKey);
    }

    const groupCount = Number(a[5]);
    let i = 6;
    for (let g = 0; g < groupCount; g += 1) {
      const ruleKey = ruleKeys[g];
      const count = Number(a[i]);
      i += 1;
      for (let r = 0; r < count; r += 1) {
        hash(ruleKey).set(a[i], JSON.parse(a[i + 1]));
        i += 2;
      }
    }
    const next = current + 1;
    counters.set(versionKey, next);
    return [1, String(next)];
  },
  // Chainable multi — the repo bundles meta hset + content set + the
  // config:version INCR into one multi() (and hdel + del + incr on delete).
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, unknown>) => {
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
  counters.clear();
  hashes.clear();
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

  it('P1-5: patch with note:null clears the note (undefined would keep it)', async () => {
    const a = await svc.createRuleSet({ name: 'emby', format: 'yaml', content: 'v1', note: 'first' });
    // undefined = unchanged
    const keep = await svc.patchRuleSet(a.id, { content: 'v2' });
    expect(keep.note).toBe('first');
    // null = clear
    const cleared = await svc.patchRuleSet(a.id, { note: null });
    expect(cleared.note).toBeUndefined();
    expect((await svc.getRuleSet(a.id))?.note).toBeUndefined();
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
    expect(await svc.deleteRuleSetChecked(a.id)).toBe(true);
    expect(await svc.deleteRuleSetChecked(a.id)).toBe(false);
  });

  it('list sorts by name', async () => {
    await svc.createRuleSet({ name: 'zeta', format: 'yaml', content: '' });
    await svc.createRuleSet({ name: 'alpha', format: 'yaml', content: '' });
    await svc.createRuleSet({ name: 'mu', format: 'yaml', content: '' });
    const all = await svc.listRuleSets();
    expect(all.map((s) => s.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});
