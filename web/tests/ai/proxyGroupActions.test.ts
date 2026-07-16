import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyGroup } from '@/schemas';

/**
 * Exercises the assistant's proxy-group actions end to end against an in-memory
 * Redis + a stubbed resolved snapshot (the node pool). The headline case is the
 * AUS/RUS-in-US regex bug: `preview_proxy_group_members` must reveal the leak,
 * and `update_proxy_group` must persist the corrected filter through the same
 * service the UI uses.
 */

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

const NODES = [
  '🇺🇸 IMM_USA 01',
  '🇺🇸 S_US01 0.2x',
  '🇺🇸 r_USA xTom 0.8X',
  '🇦🇺 IMM_AUS 01',
  '🇦🇺 r_AUS 1R 2.0X - xTom',
  '🇷🇺 IMM_RUS 01',
  '🇷🇺 IMM_RUS 02',
  '🇨🇦 IMM_CAN 01',
];

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  getResolvedSnapshot: vi.fn(async () => ({
    nodeNames: NODES,
    collisions: [],
    computedAt: 1_700_000_000,
    buildId: 'test',
  })),
}));

let registry: typeof import('@/lib/ai/actions/registry');

beforeEach(async () => {
  stores.clear();
  registry = await import('@/lib/ai/actions/registry');
});

afterEach(() => vi.restoreAllMocks());

const PID = 'prof-test';
const CTX = { actor: 'test', profileId: PID };

function seedGroup(over: Partial<ProxyGroup>): ProxyGroup {
  const now = 1_700_000_000;
  const g = {
    id: crypto.randomUUID(),
    kind: 'filter',
    name: '美国',
    type: 'select',
    rank: 10,
    created_at: now,
    updated_at: now,
    'include-all-proxies': true,
    ...over,
  } as ProxyGroup;
  bucket(`proxy-groups:${PID}`).set(g.id, g);
  return g;
}

describe('proxy-group actions registered', () => {
  it('exposes the read + write actions at the right risk', () => {
    expect(registry.getAction('preview_proxy_group_members')?.risk).toBe('read');
    expect(registry.getAction('create_proxy_group')?.risk).toBe('write');
    expect(registry.getAction('update_proxy_group')?.risk).toBe('write');
    expect(registry.getAction('delete_proxy_group')?.risk).toBe('write');
  });
});

describe('preview_proxy_group_members', () => {
  it('reveals the AUS/RUS leak in the buggy US filter', async () => {
    const action = registry.getAction('preview_proxy_group_members')!;
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(CTX, { filter: '(?i)美|us|unitedstates|united states' });
    const data = env.data as { matched: string[]; matchedCount: number };
    expect(data.matchedCount).toBe(7); // 3 US + 2 AUS + 2 RUS
    expect(data.matched).toContain('🇦🇺 IMM_AUS 01');
    expect(data.matched).toContain('🇷🇺 IMM_RUS 01');
  });

  it('confirms the corrected filter keeps only US nodes', async () => {
    const action = registry.getAction('preview_proxy_group_members')!;
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(CTX, {
      filter: '(?i)🇺🇸|美|(?<![A-Za-z])(?:USA?|United ?States)(?![A-Za-z])',
    });
    const data = env.data as { matched: string[]; matchedCount: number };
    expect(data.matchedCount).toBe(3);
    expect(data.matched.every((n) => n.includes('🇺🇸'))).toBe(true);
  });

  it("falls back to a seeded group's own filter when only id is given", async () => {
    const g = seedGroup({ filter: '(?i)美|us|unitedstates|united states' });
    const action = registry.getAction('preview_proxy_group_members')!;
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(CTX, { id: g.id });
    const data = env.data as { group: string; matchedCount: number };
    expect(data.group).toBe('美国');
    expect(data.matchedCount).toBe(7);
  });

  it('reports an invalid regex instead of throwing', async () => {
    const action = registry.getAction('preview_proxy_group_members')!;
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(CTX, { filter: '(' });
    const data = env.data as { regexError: string | null; matchedCount: number };
    expect(data.regexError).toBeTruthy();
    expect(data.matchedCount).toBe(0);
  });
});

describe('update_proxy_group', () => {
  it('previews a before/after diff and persists the corrected filter on execute', async () => {
    const g = seedGroup({ filter: '(?i)美|us|unitedstates|united states' });
    const action = registry.getAction('update_proxy_group')!;
    if (action.risk !== 'write') throw new Error('expected write');

    const fixed = '(?i)🇺🇸|美|(?<![A-Za-z])(?:USA?|United ?States)(?![A-Za-z])';
    const preview = await action.preview(CTX, { id: g.id, filter: fixed });
    const diff = preview.diff as { op: string; beforeYaml: string; afterYaml: string };
    expect(diff.op).toBe('update');
    expect(diff.beforeYaml).toContain('|us|');
    expect(diff.afterYaml).toContain('🇺🇸');

    await action.execute(CTX, { id: g.id, filter: fixed });
    const stored = bucket(`proxy-groups:${PID}`).get(g.id) as ProxyGroup;
    expect(stored.filter).toBe(fixed);
  });

  it('clears exclude-filter when passed null', async () => {
    const g = seedGroup({ filter: '(?i)🇺🇸', 'exclude-filter': '(?i)test' });
    const action = registry.getAction('update_proxy_group')!;
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(CTX, { id: g.id, exclude_filter: null });
    const stored = bucket(`proxy-groups:${PID}`).get(g.id) as ProxyGroup;
    expect(stored['exclude-filter']).toBeUndefined();
  });

  it('maps empty_fallback to the native field and can clear it', async () => {
    const g = seedGroup({ 'empty-fallback': 'REJECT' });
    const action = registry.getAction('update_proxy_group')!;
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(CTX, { id: g.id, empty_fallback: 'DIRECT' });
    expect((bucket(`proxy-groups:${PID}`).get(g.id) as ProxyGroup)['empty-fallback']).toBe(
      'DIRECT',
    );
    await action.execute(CTX, { id: g.id, empty_fallback: null });
    expect(
      (bucket(`proxy-groups:${PID}`).get(g.id) as ProxyGroup)['empty-fallback'],
    ).toBeUndefined();
  });
});
