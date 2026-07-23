import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CollectionCreateSchema,
  RuleSetCreateSchema,
  SubscriptionCreateSchema,
} from '@/schemas';

/**
 * P2-2: optimistic-concurrency (If-Match) protection on the rule-set,
 * subscription, and collection PATCH services. The route reads the `if-match`
 * header (the client's last-known `updated_at`) and threads it down as
 * `expectedUpdatedAt`; each service refuses a stale write with 412 BEFORE
 * persisting. With no expected version the behaviour is unchanged
 * (last-write-wins), so the existing UI that doesn't send If-Match keeps working.
 *
 * These are service-level tests — the version check lives in the service, which
 * is where two concurrent editors (two tabs / human + AI) actually collide.
 */

/* ─── Generic in-memory Redis ───────────────────────────────────────────
 * Covers exactly the ops the sub / collection / rule-set repos use. Values are
 * JSON round-tripped on write so records de/serialise like Upstash does. */
const hashes = new Map<string, Map<string, unknown>>();
const kv = new Map<string, string>();
const counters = new Map<string, number>();

function hashOf(key: string): Map<string, unknown> {
  let h = hashes.get(key);
  if (!h) {
    h = new Map();
    hashes.set(key, h);
  }
  return h;
}
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const fakeRedis = {
  hget: async (key: string, field: string) => {
    const v = hashOf(key).get(field);
    return v === undefined ? null : clone(v);
  },
  hgetall: async (key: string) => {
    const h = hashOf(key);
    if (h.size === 0) return null;
    return Object.fromEntries([...h].map(([f, v]) => [f, clone(v)]));
  },
  // config:version 由 incr 维护在 counters 里 —— get 也要能读到它，
  // 否则闸口读出的版本与 CAS 比对的版本永远对不上。
  get: async (key: string) =>
    counters.has(key) ? counters.get(key)! : kv.has(key) ? kv.get(key)! : null,
  set: async (key: string, value: string) => {
    kv.set(key, value);
  },
  del: async (key: string) => (kv.delete(key) ? 1 : 0),
  incr: async (key: string) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return n;
  },
  hset: async (key: string, payload: Record<string, unknown>) => {
    const h = hashOf(key);
    for (const [f, v] of Object.entries(payload)) h.set(f, clone(v));
  },
  /** CAS_RULE_SET_CHANGE 的行为等价实现（规则集写入现在走闸口 + CAS）。 */
  eval: async (_script: string, keys: string[], args: (string | number)[]) => {
    const [versionKey, setsKey, contentKey, ...ruleKeys] = keys;
    const a = args.map(String);
    const current = counters.get(versionKey) ?? 0;
    if (current !== Number(a[0])) return [0, String(current)];
    if (a[1] === 'write') {
      hashOf(setsKey).set(a[2], JSON.parse(a[3]));
      kv.set(contentKey, a[4]);
    } else if (a[1] === 'delete') {
      hashOf(setsKey).delete(a[2]);
      kv.delete(contentKey);
    }
    let i = 6;
    for (let g = 0; g < Number(a[5]); g += 1) {
      const count = Number(a[i]);
      i += 1;
      for (let r = 0; r < count; r += 1) {
        hashOf(ruleKeys[g]).set(a[i], JSON.parse(a[i + 1]));
        i += 2;
      }
    }
    const next = current + 1;
    counters.set(versionKey, next);
    return [1, String(next)];
  },
  hdel: async (key: string, field: string) => (hashOf(key).delete(field) ? 1 : 0),
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (k: string, p: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(k, p));
        return tx;
      },
      hdel: (k: string, f: string) => {
        ops.push(() => fakeRedis.hdel(k, f));
        return tx;
      },
      set: (k: string, v: string) => {
        ops.push(() => fakeRedis.set(k, v));
        return tx;
      },
      del: (k: string) => {
        ops.push(() => fakeRedis.del(k));
        return tx;
      },
      incr: (k: string) => {
        ops.push(() => fakeRedis.incr(k));
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
  invalidateResolvedSnapshot: async () => undefined,
}));

let ruleSetSvc: typeof import('@/lib/services/ruleSetService');
let subSvc: typeof import('@/lib/services/subscriptionService');
let colSvc: typeof import('@/lib/services/collectionService');

beforeEach(async () => {
  hashes.clear();
  kv.clear();
  counters.clear();
  ruleSetSvc = await import('@/lib/services/ruleSetService');
  subSvc = await import('@/lib/services/subscriptionService');
  colSvc = await import('@/lib/services/collectionService');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('patchRuleSet If-Match (P2-2)', () => {
  it('absent version writes (backward compatible) and matching version writes', async () => {
    const a = await ruleSetSvc.createRuleSet(
      RuleSetCreateSchema.parse({ name: 'ads', format: 'yaml', behavior: 'classical', content: 'v1' }),
    );
    // (a) no expected version → last-write-wins, unchanged.
    const noVer = await ruleSetSvc.patchRuleSet(a.id, { content: 'v2' });
    expect(noVer.content).toBe('v2');
    // (a) matching version → succeeds.
    const cur = await ruleSetSvc.getRuleSet(a.id);
    const ok = await ruleSetSvc.patchRuleSet(a.id, { content: 'v3' }, cur!.updated_at);
    expect(ok.content).toBe('v3');
  });

  it('stale version → 412 and no write', async () => {
    const a = await ruleSetSvc.createRuleSet(
      RuleSetCreateSchema.parse({ name: 'ads', format: 'yaml', behavior: 'classical', content: 'v1' }),
    );
    const live = await ruleSetSvc.getRuleSet(a.id);
    await expect(
      ruleSetSvc.patchRuleSet(a.id, { content: 'boom' }, live!.updated_at - 1),
    ).rejects.toMatchObject({ problem: { status: 412 } });
    expect((await ruleSetSvc.getRuleSet(a.id))!.content).toBe('v1');
  });
});

describe('patchSubscription If-Match (P2-2)', () => {
  it('absent version writes (backward compatible) and matching version writes', async () => {
    const s = await subSvc.createSubscription(
      SubscriptionCreateSchema.parse({ name: 'air-hk', kind: 'local', content: 'proxies: []' }),
    );
    expect(s.updated_at).toBeGreaterThan(0);
    const noVer = await subSvc.patchSubscription(s.id, { display_name: '香港' });
    expect(noVer.display_name).toBe('香港');
    const cur = await subSvc.getSubscription(s.id);
    const ok = await subSvc.patchSubscription(s.id, { display_name: '香港2' }, cur!.updated_at!);
    expect(ok.display_name).toBe('香港2');
  });

  it('stale version → 412 and no write', async () => {
    const s = await subSvc.createSubscription(
      SubscriptionCreateSchema.parse({ name: 'air-hk', kind: 'local', content: 'proxies: []' }),
    );
    const ok = await subSvc.patchSubscription(s.id, { display_name: 'keep' });
    const live = await subSvc.getSubscription(s.id);
    await expect(
      subSvc.patchSubscription(s.id, { display_name: 'boom' }, live!.updated_at! - 1),
    ).rejects.toMatchObject({ problem: { status: 412 } });
    expect((await subSvc.getSubscription(s.id))!.display_name).toBe(ok.display_name);
  });
});

describe('patchCollection If-Match (P2-2)', () => {
  it('absent version writes (backward compatible) and matching version writes', async () => {
    const c = await colSvc.createCollection(
      CollectionCreateSchema.parse({ name: '全球', slug: 'global' }),
    );
    expect(c.updated_at).toBeGreaterThan(0);
    const noVer = await colSvc.patchCollection(c.id, { notes: 'hi' });
    expect(noVer.notes).toBe('hi');
    const cur = await colSvc.getCollection(c.id);
    const ok = await colSvc.patchCollection(c.id, { notes: 'hi2' }, cur!.updated_at!);
    expect(ok.notes).toBe('hi2');
  });

  it('stale version → 412 and no write', async () => {
    const c = await colSvc.createCollection(
      CollectionCreateSchema.parse({ name: '全球', slug: 'global' }),
    );
    const ok = await colSvc.patchCollection(c.id, { notes: 'keep' });
    const live = await colSvc.getCollection(c.id);
    await expect(
      colSvc.patchCollection(c.id, { notes: 'boom' }, live!.updated_at! - 1),
    ).rejects.toMatchObject({ problem: { status: 412 } });
    expect((await colSvc.getCollection(c.id))!.notes).toBe(ok.notes);
  });
});
