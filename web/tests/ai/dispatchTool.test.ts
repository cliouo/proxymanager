import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyGroup } from '@/schemas';

/**
 * `dispatchToolCall` is the single-tool dispatcher shared by the server loop
 * and the browser orchestrator's /api/v1/assistant/tool endpoint. It must:
 *   - run reads inline and return their envelope + a JSON modelContent;
 *   - NOT execute writes — preview + mint a one-time token, return confirm-write;
 *   - surface unknown tools / bad input as an error result (never throw).
 */

const stores = new Map<string, Map<string, unknown>>();
const kv = new Map<string, unknown>();
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
  getdel: async (key: string) => {
    const v = kv.get(key) ?? null;
    kv.delete(key);
    return v;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  getResolvedSnapshot: vi.fn(async () => ({
    nodeNames: ['🇺🇸 IMM_USA 01', '🇦🇺 IMM_AUS 01', '🇷🇺 IMM_RUS 01'],
    collisions: [],
    computedAt: 1,
    buildId: 't',
  })),
}));

let dispatch: typeof import('@/lib/ai/dispatchTool');

beforeEach(async () => {
  stores.clear();
  kv.clear();
  dispatch = await import('@/lib/ai/dispatchTool');
});
afterEach(() => vi.restoreAllMocks());

const CTX = { actor: 'test' };

function seedGroup(over: Partial<ProxyGroup>): ProxyGroup {
  const g = {
    id: crypto.randomUUID(),
    kind: 'filter',
    name: '美国',
    type: 'select',
    rank: 10,
    updated_at: 1,
    'include-all-proxies': true,
    ...over,
  } as ProxyGroup;
  bucket('proxy-groups').set(g.id, g);
  return g;
}

describe('dispatchToolCall', () => {
  it('runs a read tool inline and returns envelope + JSON modelContent', async () => {
    const res = await dispatch.dispatchToolCall(CTX, 'preview_proxy_group_members', {
      filter: '(?i)美|us|unitedstates',
    });
    expect(res.kind).toBe('proxy-group-members');
    const data = res.data as { matchedCount: number };
    expect(data.matchedCount).toBe(3); // buggy filter swallows AUS + RUS too
    expect(JSON.parse(res.modelContent)).toMatchObject({ matchedCount: 3 });
  });

  it('stages a write as confirm-write WITHOUT executing it', async () => {
    const g = seedGroup({ filter: '(?i)old' });
    const fixed = '(?i)🇺🇸|美';
    const res = await dispatch.dispatchToolCall(CTX, 'update_proxy_group', { id: g.id, filter: fixed });

    expect(res.kind).toBe('confirm-write');
    const data = res.data as { token: string; action: string };
    expect(data.action).toBe('update_proxy_group');
    expect(data.token).toMatch(/^[a-f0-9]{36}$/);
    // The mutation must NOT have run yet — group unchanged in the store.
    expect((bucket('proxy-groups').get(g.id) as ProxyGroup).filter).toBe('(?i)old');
  });

  it('returns an error result for an unknown tool (never throws)', async () => {
    const res = await dispatch.dispatchToolCall(CTX, 'no_such_tool', {});
    expect(res.kind).toBe('error');
    expect((res.data as { error: string }).error).toContain('no_such_tool');
  });

  it('returns an error result for invalid input', async () => {
    const res = await dispatch.dispatchToolCall(CTX, 'update_proxy_group', { id: 'not-a-uuid' });
    expect(res.kind).toBe('error');
  });
});
