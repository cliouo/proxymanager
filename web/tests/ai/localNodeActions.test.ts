import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Profile, Subscription } from '@/schemas';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { buildNodeScope, buildTargetRefScope } from '@/lib/proxies/handleScopes';

/**
 * Tests for the assistant's local-node tools
 * (lib/ai/actions/primitives/localNodeWrites.ts): list_local_nodes (redacted
 * read) + rename_local_node (source-content rename). Redis is stubbed; the
 * local-content parser runs for real (it's pure).
 */

const stores = new Map<string, Map<string, unknown>>();
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
  hget: async (key: string, id: string) => bucket(key).get(id) ?? null,
  hgetall: async (key: string) => {
    const m = bucket(key);
    return m.size === 0 ? null : Object.fromEntries(m);
  },
  hset: async (key: string, payload: Record<string, unknown>) => {
    const m = bucket(key);
    for (const [id, v] of Object.entries(payload)) m.set(id, v);
  },
  get: async (key: string) => (counters.has(key) ? counters.get(key)! : null),
  mget: async (...keys: string[]) => keys.map((k) => bucket(k).get('base') ?? null),
  // 订阅保存闸口的 CAS 提交（compare config:version → HSET → INCR）。
  eval: async (_script: string, keys: string[], args: string[]) => {
    const current = counters.get(keys[0]) ?? 0;
    if (current !== Number(args[0])) return [0, String(current)];
    await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    const next = (counters.get(keys[0]) ?? 0) + 1;
    counters.set(keys[0], next);
    return [1, String(next)];
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

const PID = '55555555-5555-4555-8555-555555555555';
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
    cipher: auto
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
  seedProfile();
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
  seedProfile();
  // the caller-visible set is the CURRENT profile binding — for remote
  // rejection tests the profile binds the remote source
  bucket(REDIS_KEYS.profiles).set(PID, {
    id: PID,
    name: 'default',
    display_name: '默认配置',
    source: { type: 'subscription', id: REMOTE_ID },
    kind: 'normal',
    updated_at: 0,
  });
}

/** Profile bound to the LOCAL subscription — the authoritative visible set. */
function seedProfile(): void {
  const profile: Profile = {
    id: PID,
    name: 'default',
    display_name: '默认配置',
    source: { type: 'subscription', id: LOCAL_ID },
    kind: 'normal',
    updated_at: 0,
  };
  bucket(REDIS_KEYS.profiles).set(PID, profile);
  // the pipeline-save preflight renders the profile's config — valid base
  // skeleton required for writes to commit
  bucket(REDIS_KEYS.base.content(PID)).set('base', 'proxies: []\nproxy-groups: []\nrules: []\n');
  bucket(REDIS_KEYS.base.meta(PID)).set('base', {
    etag: 'e',
    anchors: [],
    policies: [],
    updated_at: 0,
  });
}

const localRef = (): string =>
  buildTargetRefScope(PID, [{ type: 'subscription', id: LOCAL_ID }]).project(
    `subscription:${LOCAL_ID}`,
  );
const remoteRef = (): string =>
  buildTargetRefScope(PID, [{ type: 'subscription', id: REMOTE_ID }]).project(
    `subscription:${REMOTE_ID}`,
  );

/** Mirror of the production node-handle MAC (profile+source+position+name). */
function nodeHandleOf(name: string, position: number): string {
  // test-local node handle over the complete one-node domain (same bytes as
  // the production local-node scope construction)
  return buildNodeScope(`${PID}\x00${LOCAL_ID}`, [`${position}\x00${name}`]).project(
    `${position}\x00${name}`,
  );
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
  installTestHandleSecret();
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
  it('returns opaque node handles + bounded display + allowlisted type only — never raw names or credentials', async () => {
    seedLocal();
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, { ref: localRef() });
    const data = env.data as {
      count: number;
      nodes: Array<{ node: string; display: string; type: string; referencedBy: unknown[] }>;
    };
    expect(data.count).toBe(2);
    expect(data.nodes).toEqual([
      {
        node: nodeHandleOf('xiagangbgp-hk-disx', 0),
        // round-1 (invariant 6): the display is the bounded SANITIZED
        // original name — useful recognition content, credential-free
        display: 'xiagangbgp-hk-disx',
        type: 'ss',
        referencedBy: [],
      },
      {
        node: nodeHandleOf('Xiamen-hk-jp', 1),
        display: 'Xiamen-hk-jp',
        type: 'vmess',
        referencedBy: [],
      },
    ]);
    const blob = JSON.stringify(data);
    // pass-8 blocker 4: the RAW source label never serializes — the ref
    // identifies the source; no secret keys anywhere in the payload
    expect(blob).not.toContain('super-secret-pw');
    expect(blob).not.toContain('11112222-3333');
    expect(blob).not.toContain('server');
    expect(blob).not.toContain('mynode');
    expect(blob).not.toContain(LOCAL_ID);
    // round-1: the sanitized DISPLAY names appear (useful display content);
    // the node identity is still the opaque handle — never the raw name as a key
    expect(data.nodes[0].node).toMatch(/^nd-[0-9a-f]{16}$/);
    expect(JSON.stringify(data.nodes[0].node)).not.toContain('xiagangbgp');
  });

  it('pass-8: allowlisted protocol types project verbatim; unknown / wrong-case / padded types are rejected at the parse boundary', async () => {
    seedLocal(
      `proxies:
  - name: node-ss
    type: ss
    server: 1.2.3.4
    port: 443
    cipher: aes-128-gcm
    password: pw
  - name: node-vmess
    type: vmess
    server: 1.2.3.4
    port: 443
    uuid: 11112222-3333-4444-5555-666677778888
    cipher: auto
`,
    );
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, { ref: localRef() });
    const data = env.data as { nodes: Array<{ type: string }> };
    expect(data.nodes.map((n) => n.type)).toEqual(['ss', 'vmess']);
    // wrong-case / padded / unknown types are REJECTED by the shared
    // production validator at the parse boundary — never projected raw
    for (const bad of ['SS', 'vmess ', 'trojan-custom']) {
      seedLocal(
        `proxies:
  - name: node-bad
    type: "${bad}"
    server: 1.2.3.4
    port: 443
    cipher: aes-128-gcm
    password: pw
`,
      );
      const thrown = await action.run(ctx, { ref: localRef() }).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toContain('trojan-custom');
      expect(message).not.toContain('SS');
    }
  });

  it('pass-8: credential-shaped node names project as redacted bounded display', async () => {
    seedLocal(
      `proxies:
  - name: "香港 https://evil.example/sub?token=abc123 ::1"
    type: ss
    server: 1.2.3.4
    port: 443
    cipher: aes-128-gcm
    password: pw
`,
    );
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    const env = await action.run(ctx, { ref: localRef() });
    const data = env.data as { nodes: Array<{ display: string }> };
    expect(data.nodes[0].display).not.toContain('evil.example');
    expect(data.nodes[0].display).not.toContain('token=');
    expect(data.nodes[0].display).not.toContain('::1');
    expect(data.nodes[0].display.length).toBeLessThanOrEqual(25);
  });

  it('pass-8: a forced node-handle MAC collision fails the list closed (bounded)', async () => {
    seedLocal();
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    // EVERY node maps to the same nd- handle — ambiguous, never first-match
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      const action = getAction('list_local_nodes');
      if (action.risk !== 'read') throw new Error('expected read');
      await expect(action.run(ctx, { ref: localRef() })).rejects.toMatchObject({
        problem: { status: 400 },
      });
    } finally {
      injectHandleSignerForTests(null);
    }
  });

  it('rejects a remote source with a hint to use operators', async () => {
    seedRemote();
    const action = getAction('list_local_nodes');
    if (action.risk !== 'read') throw new Error('expected read');
    await expect(action.run(ctx, { ref: remoteRef() })).rejects.toMatchObject({
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
    const env = await action.run(ctx, { ref: localRef() });
    const data = env.data as {
      nodes: Array<{ node: string; referencedBy: Array<{ kind: string; via: string }> }>;
    };
    const pinned = data.nodes.find((n) => n.node === nodeHandleOf('xiagangbgp-hk-disx', 0));
    expect(pinned?.referencedBy).toEqual([
      // pass-9 blocker 4: referencing-entity names project as bounded
      // category ordinals — never the raw name (chain names embed node names)
      { kind: 'chain-backend', via: '引用 1' },
    ]);
    // The unreferenced node stays empty.
    expect(
      data.nodes.find((n) => n.node === nodeHandleOf('Xiamen-hk-jp', 1))?.referencedBy,
    ).toEqual([]);
  });
});

describe('rename_local_node', () => {
  it('preview shows a name-only diff and does not mutate content', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    const { diff } = await action.preview(ctx, {
      source_type: 'subscription',
      ref: localRef(),
      node: nodeHandleOf('xiagangbgp-hk-disx', 0),
      to: '香港-1',
    });
    const d = diff as { beforeYaml: string; afterYaml: string };
    // round-1: the OLD name projects as a bounded sanitized display name;
    // the NEW name is the model's own bounded input — never credentials
    expect(d.beforeYaml).toBe('name: xiagangbgp-hk-disx');
    expect(d.afterYaml).toBe('name: 香港-1');
    expect(JSON.stringify(d)).not.toContain('super-secret-pw');
    expect(storedContent()).toContain('xiagangbgp-hk-disx'); // unchanged
  });

  it('execute renames only the target, preserving credentials', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await action.execute(ctx, {
      source_type: 'subscription',
      ref: localRef(),
      node: nodeHandleOf('xiagangbgp-hk-disx', 0),
      to: '香港-1',
    });
    const parsed = parse(storedContent()) as { proxies: Array<Record<string, unknown>> };
    expect(parsed.proxies.map((p) => p.name)).toEqual(['香港-1', 'Xiamen-hk-jp']);
    // Credentials survive the round-trip.
    expect(parsed.proxies[0].password).toBe('super-secret-pw');
    expect(parsed.proxies[0].server).toBe('1.2.3.4');
  });

  it('rejects an unknown/stale node handle with a bounded error', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: localRef(),
        node: 'nd-deadbeefdeadbeef',
        to: 'x',
      }),
    ).rejects.toMatchObject({ problem: { status: 400 } });
    const thrown = await action
      .execute(ctx, {
        source_type: 'subscription',
        ref: localRef(),
        node: 'nd-deadbeefdeadbeef',
        to: 'x',
      })
      .catch((e: unknown) => e);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain('deadbeef');
  });

  it('rejects renaming to a name that already exists (409)', async () => {
    seedLocal();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, {
        source_type: 'subscription',
        ref: localRef(),
        node: nodeHandleOf('xiagangbgp-hk-disx', 0),
        to: 'Xiamen-hk-jp',
      }),
    ).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('pass-8: a forced node-handle MAC collision fails the rename closed', async () => {
    seedLocal();
    const { injectHandleSignerForTests } = await import('@/lib/proxies/handles');
    injectHandleSignerForTests({ mac: () => 'deadbeefdeadbeef' });
    try {
      const action = getAction('rename_local_node');
      if (action.risk !== 'write') throw new Error('expected write');
      await expect(
        action.execute(ctx, {
          source_type: 'subscription',
          ref: localRef(),
          node: 'nd-deadbeefdeadbeef',
          to: 'x',
        }),
      ).rejects.toMatchObject({ problem: { status: 400 } });
      // nothing was written
      expect(storedContent()).toContain('xiagangbgp-hk-disx');
    } finally {
      injectHandleSignerForTests(null);
    }
  });

  it('rejects editing a remote source (422)', async () => {
    seedRemote();
    const action = getAction('rename_local_node');
    if (action.risk !== 'write') throw new Error('expected write');
    await expect(
      action.execute(ctx, { source_type: 'subscription', ref: remoteRef(), from: 'a', to: 'b' }),
    ).rejects.toMatchObject({
      problem: { status: 422 },
    });
  });
});
