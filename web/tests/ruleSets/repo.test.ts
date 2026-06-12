import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleSet } from '@/schemas';

/**
 * Repo-level coverage of the content split:
 *   - hash field stores meta only (content '')
 *   - rule-set-content:{id} stores the body
 *   - writes bundle everything + config:version INCR into ONE multi()
 *   - reads fall back to legacy embedded content (and never write back)
 */

const contentKey = (id: string) => `rule-set-content:${id}`;

// ── in-memory redis ──────────────────────────────────────────────────
const hash = new Map<string, RuleSet>();
const kv = new Map<string, string>();
const counters = new Map<string, number>();
/** Command-name sequences of every exec'd multi(), to assert atomic bundling. */
const multiLog: string[][] = [];
/** Total standalone (non-multi) write commands — reads must never write. */
let standaloneWrites = 0;

const base = {
  hgetall: async () => (hash.size === 0 ? null : Object.fromEntries(hash)),
  hget: async (_k: string, id: string) => hash.get(id) ?? null,
  get: async (key: string) => (kv.has(key) ? kv.get(key) : null),
  hset: async (_k: string, payload: Record<string, RuleSet>) => {
    for (const [id, v] of Object.entries(payload)) hash.set(id, v);
    return Object.keys(payload).length;
  },
  hdel: async (_k: string, id: string) => (hash.delete(id) ? 1 : 0),
  set: async (key: string, value: string) => {
    kv.set(key, value);
    return 'OK';
  },
  del: async (key: string) => (kv.delete(key) ? 1 : 0),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
};

const fakeRedis = {
  hgetall: base.hgetall,
  hget: base.hget,
  get: base.get,
  hset: async (...args: Parameters<typeof base.hset>) => {
    standaloneWrites += 1;
    return base.hset(...args);
  },
  hdel: async (...args: Parameters<typeof base.hdel>) => {
    standaloneWrites += 1;
    return base.hdel(...args);
  },
  set: async (...args: Parameters<typeof base.set>) => {
    standaloneWrites += 1;
    return base.set(...args);
  },
  del: async (...args: Parameters<typeof base.del>) => {
    standaloneWrites += 1;
    return base.del(...args);
  },
  incr: async (...args: Parameters<typeof base.incr>) => {
    standaloneWrites += 1;
    return base.incr(...args);
  },
  multi: () => {
    const names: string[] = [];
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (k: string, p: Record<string, RuleSet>) => {
        names.push('hset');
        ops.push(() => base.hset(k, p));
        return tx;
      },
      hdel: (k: string, id: string) => {
        names.push('hdel');
        ops.push(() => base.hdel(k, id));
        return tx;
      },
      set: (k: string, v: string) => {
        names.push('set');
        ops.push(() => base.set(k, v));
        return tx;
      },
      del: (k: string) => {
        names.push('del');
        ops.push(() => base.del(k));
        return tx;
      },
      incr: (k: string) => {
        names.push('incr');
        ops.push(() => base.incr(k));
        return tx;
      },
      exec: async () => {
        multiLog.push([...names]);
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    };
    return tx;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

const repo = await import('@/lib/repos/ruleSetsRepo');

function makeSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    id: crypto.randomUUID(),
    name: 'cn_domain',
    format: 'yaml',
    content: 'payload:\n  - DOMAIN,example.com\n',
    updated_at: 1700000000,
    ...overrides,
  } as RuleSet;
}

/** Seed a legacy (pre-split) hash field: content embedded, no standalone key. */
function seedLegacy(set: RuleSet): void {
  hash.set(set.id, set);
}

beforeEach(() => {
  hash.clear();
  kv.clear();
  counters.clear();
  multiLog.length = 0;
  standaloneWrites = 0;
});

describe('upsertRuleSet (new format writes)', () => {
  it('bundles meta hset + content set + version incr in one multi', async () => {
    const set = makeSet();
    await repo.upsertRuleSet(set);
    expect(multiLog).toEqual([['hset', 'set', 'incr']]);
    expect(standaloneWrites).toBe(0);
  });

  it('stores a slim hash value and the body in the standalone key', async () => {
    const set = makeSet();
    await repo.upsertRuleSet(set);
    expect(hash.get(set.id)?.content).toBe('');
    expect(kv.get(contentKey(set.id))).toBe(set.content);
    expect(counters.get('config:version')).toBe(1);
  });

  it('writes an empty content key for remote sets (no fallback ambiguity)', async () => {
    const set = makeSet({ source: 'remote', url: 'https://x/y.yaml', content: '' });
    await repo.upsertRuleSet(set);
    expect(kv.get(contentKey(set.id))).toBe('');
  });
});

describe('deleteRuleSet', () => {
  it('bundles hdel + content del + version incr in one multi, keeps return semantics', async () => {
    const set = makeSet();
    await repo.upsertRuleSet(set);
    multiLog.length = 0;

    expect(await repo.deleteRuleSet(set.id)).toBe(true);
    expect(multiLog).toEqual([['hdel', 'del', 'incr']]);
    expect(kv.has(contentKey(set.id))).toBe(false);
    expect(await repo.deleteRuleSet(set.id)).toBe(false);
  });
});

describe('listRuleSets (meta only)', () => {
  it('returns content "" for new-format records', async () => {
    await repo.upsertRuleSet(makeSet());
    const all = await repo.listRuleSets();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('');
  });

  it('strips legacy embedded content without writing back', async () => {
    const legacy = makeSet({ name: 'legacy', content: 'payload: [big]\n' });
    seedLegacy(legacy);
    const all = await repo.listRuleSets();
    expect(all[0].content).toBe('');
    // No read-path writes: the stored hash value still embeds the content.
    expect(hash.get(legacy.id)?.content).toBe('payload: [big]\n');
    expect(standaloneWrites).toBe(0);
    expect(multiLog).toEqual([]);
  });

  it('sorts by name', async () => {
    seedLegacy(makeSet({ name: 'zeta' }));
    seedLegacy(makeSet({ name: 'alpha' }));
    const all = await repo.listRuleSets();
    expect(all.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('getRuleSet (assembly + legacy fallback)', () => {
  it('assembles meta + standalone content for new-format records', async () => {
    const set = makeSet();
    await repo.upsertRuleSet(set);
    const got = await repo.getRuleSet(set.id);
    expect(got?.content).toBe(set.content);
    expect(got?.name).toBe(set.name);
  });

  it('falls back to the embedded content for unmigrated records', async () => {
    const legacy = makeSet({ content: 'legacy body\n' });
    seedLegacy(legacy);
    const got = await repo.getRuleSet(legacy.id);
    expect(got?.content).toBe('legacy body\n');
    expect(standaloneWrites).toBe(0);
  });

  it('returns null for a missing id', async () => {
    expect(await repo.getRuleSet(crypto.randomUUID())).toBeNull();
  });
});

describe('getRuleSetContent', () => {
  it('reads the standalone key for new-format records', async () => {
    const set = makeSet();
    await repo.upsertRuleSet(set);
    expect(await repo.getRuleSetContent(set.id)).toBe(set.content);
  });

  it('falls back to the embedded content for unmigrated records', async () => {
    const legacy = makeSet({ content: 'old\n' });
    seedLegacy(legacy);
    expect(await repo.getRuleSetContent(legacy.id)).toBe('old\n');
  });

  it('returns null when the rule-set does not exist', async () => {
    expect(await repo.getRuleSetContent(crypto.randomUUID())).toBeNull();
  });
});

describe('getRuleSetByName (full record)', () => {
  it('returns the assembled content for new-format records', async () => {
    const set = makeSet({ name: 'emby' });
    await repo.upsertRuleSet(set);
    const got = await repo.getRuleSetByName('emby');
    expect(got?.id).toBe(set.id);
    expect(got?.content).toBe(set.content);
  });

  it('falls back to embedded content for unmigrated records', async () => {
    seedLegacy(makeSet({ name: 'legacy', content: 'body\n' }));
    expect((await repo.getRuleSetByName('legacy'))?.content).toBe('body\n');
  });

  it('returns null for an unknown name', async () => {
    expect(await repo.getRuleSetByName('ghost')).toBeNull();
  });
});
