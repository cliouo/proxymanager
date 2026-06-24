import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Subscription } from '@/schemas';

/**
 * Tests for the assistant's local-node tools
 * (lib/ai/actions/primitives/localNodeWrites.ts): list_local_nodes (redacted
 * read) + rename_local_node (source-content rename). Redis is stubbed; the
 * local-content parser runs for real (it's pure).
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
  hget: async (key: string, id: string) => bucket(key).get(id) ?? null,
  hgetall: async (key: string) => {
    const m = bucket(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hset: async (key: string, payload: Record<string, unknown>) => {
    const m = bucket(key);
    for (const [id, v] of Object.entries(payload)) m.set(id, v);
  },
  incr: async () => 1,
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hset: (key: string, payload: Record<string, unknown>) => {
        ops.push(() => fakeRedis.hset(key, payload));
        return tx;
      },
      incr: () => {
        ops.push(async () => 1);
        return tx;
      },
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return tx;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));

let registry: typeof import('@/lib/ai/actions/registry');

const PID = 'prof-test';
const ctx = { actor: 'test', profileId: PID };
const LOCAL_ID = '33333333-3333-4333-8333-333333333333';
const REMOTE_ID = '44444444-4444-4444-8444-444444444444';

const LOCAL_CONTENT = `proxies:
  - name: xiagangbgp-hk-disx
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: super-secret-pw
  - name: Xiamen-hk-jp
    type: vmess
    server: 5.6.7.8
    port: 443
    uuid: 11112222-3333-4444-5555-666677778888
`;

function seedLocal(content = LOCAL_CONTENT): void {
  const sub: Subscription = {
    id: LOCAL_ID,
    name: 'mynode',
    display_name: '我的自用节点',
    enabled: true,
    kind: 'local',
    content,
    ttl_ms: 600000,
    tags: [],
    operators: [],
  };
  bucket(REDIS_KEYS.subscriptions).set(LOCAL_ID, sub);
}

function seedRemote(): void {
  const sub: Subscription = {
    id: REMOTE_ID,
    name: 'frontier',
    enabled: true,
    kind: 'remote',
    url: 'https://example.com/sub',
    ttl_ms: 600000,
    tags: [],
    operators: [],
  };
  bucket(REDIS_KEYS.subscriptions).set(REMOTE_ID, sub);
}

function getAction(name: string) {
  const a = registry.getAction(name);
  if (!a) throw new Error(`action ${name} not registered`);
  return a;
}

function storedContent(): string {
  return (bucket(REDIS_KEYS.subscriptions).get(LOCAL_ID) as Subscription).content!;
}

beforeEach(async () => {
  stores.clear();
  registry = await import('@/lib/ai/actions/registry');
});
afterEach(() => vi.restoreAllMocks());

describe('registration', () => {
  it('registers list_local_nodes + rename_local_node', () => {
    expect(registry.getAction('list_local_nodes')).toBeTruthy();
    expect(registry.getAction('rename_local_node')).toBeTruthy();
  });
});

describe('list_local_nodes', () => {
  it('returns name + type only, never credentials', async () => {
    seedLocal();
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, { id: LOCAL_ID });
    const data = env.data as { count: number; nodes: Array<Record<string, unknown>> };
    expect(data.count).toBe(2);
    expect(data.nodes).toEqual([
      { name: 'xiagangbgp-hk-disx', type: 'ss', referencedBy: [] },
      { name: 'Xiamen-hk-jp', type: 'vmess', referencedBy: [] },
    ]);
    // No secret keys leaked anywhere in the payload.
    const blob = JSON.stringify(data);
    expect(blob).not.toContain('super-secret-pw');
    expect(blob).not.toContain('11112222-3333');
    expect(blob).not.toContain('server');
  });

  it('rejects a remote source with a hint to use operators', async () => {
    seedRemote();
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    await expect(action.run(ctx, { id: REMOTE_ID })).rejects.toMatchObject({
      problem: { status: 422 },
    });
  });

  it('annotates a node with referencedBy when a chain backend pins it', async () => {
    seedLocal();
    // A chain wrap whose single backend member is the local node below.
    bucket(REDIS_KEYS.proxyGroups(PID)).set('w', {
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'raw',
      name: 'chain:F-to-xiagangbgp-hk-disx',
      type: 'select',
      proxies: ['xiagangbgp-hk-disx'],
      'dialer-proxy': 'F',
      rank: 10,
      updated_at: 0,
    });
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, { id: LOCAL_ID });
    const data = env.data as { nodes: Array<{ name: string; referencedBy: Array<{ kind: string; via: string }> }> };
    const pinned = data.nodes.find((n) => n.name === 'xiagangbgp-hk-disx');
    expect(pinned?.referencedBy).toEqual([
      { kind: 'chain-backend', via: 'chain:F-to-xiagangbgp-hk-disx' },
    ]);
    // The unreferenced node stays empty.
    expect(data.nodes.find((n) => n.name === 'Xiamen-hk-jp')?.referencedBy).toEqual([]);
  });
});

describe('rename_local_node', () => {
  it('preview shows a name-only diff and does not mutate content', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    const { diff } = await action.preview(ctx, {
      id: LOCAL_ID,
      from: 'xiagangbgp-hk-disx',
      to: '香港-1',
    });
    const d = diff as { beforeYaml: string; afterYaml: string };
    expect(d.beforeYaml).toBe('name: xiagangbgp-hk-disx');
    expect(d.afterYaml).toBe('name: 香港-1');
    expect(JSON.stringify(d)).not.toContain('super-secret-pw');
    expect(storedContent()).toContain('xiagangbgp-hk-disx'); // unchanged
  });

  it('execute renames only the target, preserving credentials', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, { id: LOCAL_ID, from: 'xiagangbgp-hk-disx', to: '香港-1' });
    const parsed = parse(storedContent()) as { proxies: Array<Record<string, unknown>> };
    expect(parsed.proxies.map((p) => p.name)).toEqual(['香港-1', 'Xiamen-hk-jp']);
    // Credentials survive the round-trip.
    expect(parsed.proxies[0].password).toBe('super-secret-pw');
    expect(parsed.proxies[0].server).toBe('1.2.3.4');
  });

  it('rejects an unknown source node name (404)', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, { id: LOCAL_ID, from: 'nope', to: 'x' }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
  });

  it('rejects renaming to a name that already exists (409)', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, { id: LOCAL_ID, from: 'xiagangbgp-hk-disx', to: 'Xiamen-hk-jp' }),
    ).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('rejects editing a remote source (422)', async () => {
    seedRemote();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, { id: REMOTE_ID, from: 'a', to: 'b' }),
    ).rejects.toMatchObject({ problem: { status: 422 } });
  });
});
