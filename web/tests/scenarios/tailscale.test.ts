import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyGroup, Rule } from '@/schemas';
import type { OpContext } from '@/lib/scenarios/_shared/types';

/**
 * Tailscale scenario tests: reconcile semantics of enable/disable, shape
 * detection, credential redaction in audit snapshots, and the undo pair.
 * The preflight+CAS boundary has its own suites — here it's emulated as a
 * successful atomic commit so assertions observe the resulting hashes, while
 * base.yaml mutations run through the REAL parseBase (so a tailscale
 * base-literal failing validation would fail these tests).
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
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
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

/** In-memory base.yaml store — content round-trips through real parseBase. */
let baseRecord: { content: string; etag: string; updated_at: number } | null = null;
vi.mock('@/lib/repos/baseRepo', () => ({
  getBase: vi.fn(async () => baseRecord),
  setBase: vi.fn(
    async (
      _pid: string,
      content: string,
      meta: { etag: string; updated_at: number },
    ) => {
      baseRecord = { content, etag: meta.etag, updated_at: meta.updated_at };
      return { ok: true };
    },
  ),
}));

vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: vi.fn(async () => ({ configVersion: 0, candidate: {} })),
  applyConfigEntityChanges: vi.fn(),
}));

vi.mock('@/lib/services/profileConfigMutationService', () => ({
  preflightProfileConfigChanges: vi.fn(async () => ({ configVersion: 0, candidate: {} })),
  preflightAndCommitProfileChanges: vi.fn(
    async (
      profileId: string,
      changes: {
        ruleWrites?: Rule[];
        ruleDeletes?: string[];
        proxyGroupWrites?: ProxyGroup[];
        proxyGroupDeletes?: string[];
      },
    ) => {
      for (const rule of changes.ruleWrites ?? []) bucket(`rules:${profileId}`).set(rule.id, rule);
      for (const id of changes.ruleDeletes ?? []) bucket(`rules:${profileId}`).delete(id);
      for (const group of changes.proxyGroupWrites ?? []) {
        bucket(`proxy-groups:${profileId}`).set(group.id, group);
      }
      for (const id of changes.proxyGroupDeletes ?? []) {
        bucket(`proxy-groups:${profileId}`).delete(id);
      }
    },
  ),
}));

const PID = '66666666-6666-4666-8666-666666666666';

const BASE_WITH_ANCHOR = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct
proxy-groups:
  - name: 默认
    type: select
    proxies: [DIRECT]
rules:
  # === ANCHOR: manual ===
  - MATCH,默认
`;

const BASE_WITHOUT_ANCHOR = `mixed-port: 7890
rules:
  - MATCH,DIRECT
`;

let scenario: typeof import('@/lib/scenarios/tailscale/scenario');
let baseMutator: typeof import('@/lib/scenarios/_shared/baseMutator');

function seedBase(content: string): void {
  baseRecord = { content, etag: 'seed', updated_at: 0 };
}

function makeCtx(): OpContext {
  return {
    actor: 'test',
    profileId: PID,
    configVersion: 0,
    base: baseMutator.createBaseStore(PID),
    rules: {
      list: async () => Array.from(bucket(`rules:${PID}`).values()) as Rule[],
      get: async (id) => ((bucket(`rules:${PID}`).get(id) as Rule) ?? null),
      upsert: async (r) => {
        bucket(`rules:${PID}`).set(r.id, r);
      },
      delete: async (id) => bucket(`rules:${PID}`).delete(id),
      computeNextRank: async (anchor) => {
        const rules = Array.from(bucket(`rules:${PID}`).values()) as Rule[];
        const ranks = rules.filter((r) => r.anchor === anchor).map((r) => r.rank);
        return (ranks.length > 0 ? Math.max(...ranks) : 0) + 10;
      },
    },
    taxonomy: {
      all: async () => ({}),
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    },
  };
}

async function runEnable(payload: Record<string, unknown> = {}) {
  return scenario.tailscaleScenario.ops.enable(makeCtx(), {
    hostname: 'mate70',
    authKey: 'FAKE_TSKEY_DO_NOT_LOG',
    ...payload,
  });
}

beforeEach(async () => {
  stores.clear();
  counters.clear();
  baseRecord = null;
  seedBase(BASE_WITH_ANCHOR);
  scenario = await import('@/lib/scenarios/tailscale/scenario');
  baseMutator = await import('@/lib/scenarios/_shared/baseMutator');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tailscale enable', () => {
  it('creates node + group + CGNAT rule in one pass', async () => {
    const { data, events } = await runEnable();
    expect(data).toMatchObject({
      nodeName: 'ts-mate70',
      groupName: 'Tailscale',
      anchor: 'manual',
      nodeCreated: true,
      groupCreated: true,
      alreadyEnabled: false,
    });

    // Node landed in base.yaml with the credential (base is where it lives).
    expect(baseRecord!.content).toContain('type: tailscale');
    expect(baseRecord!.content).toContain('hostname: mate70');
    expect(baseRecord!.content).toContain('state-dir: ./ts-mate70');
    expect(baseRecord!.content).toContain('FAKE_TSKEY_DO_NOT_LOG');

    const groups = Array.from(bucket(`proxy-groups:${PID}`).values()) as ProxyGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: 'Tailscale',
      type: 'select',
      proxies: ['ts-mate70'],
    });

    const rules = Array.from(bucket(`rules:${PID}`).values()) as Rule[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      type: 'IP-CIDR',
      value: '100.64.0.0/10',
      policy: 'Tailscale',
      anchor: 'manual',
      options: ['no-resolve'],
    });

    // Audit snapshot must be credential-free.
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('FAKE_TSKEY_DO_NOT_LOG');
    expect((events[0].after as { node: { hasAuthKey: boolean } }).node.hasAuthKey).toBe(true);
  });

  it('is a reconcile: re-running is a no-op with no events', async () => {
    await runEnable();
    const { data, events } = await runEnable();
    expect(data).toMatchObject({ alreadyEnabled: true, nodeCreated: false, groupCreated: false });
    expect(events).toHaveLength(0);
    expect(Array.from(bucket(`rules:${PID}`).values())).toHaveLength(1);
  });

  it('adopts a hand-written tailscale node instead of duplicating it', async () => {
    seedBase(`${BASE_WITH_ANCHOR.replace(
      '  - name: 直连\n    type: direct\n',
      '  - name: 直连\n    type: direct\n  - name: ts-mate70\n    type: tailscale\n    hostname: mate70\n',
    )}`);
    const { data } = await runEnable();
    expect(data).toMatchObject({ nodeCreated: false, groupCreated: true });
    // Still exactly one tailscale entry in base.
    expect(baseRecord!.content.match(/type: tailscale/g)).toHaveLength(1);
  });

  it('refuses when the node name collides with a non-tailscale base node', async () => {
    await expect(runEnable({ nodeName: '直连' })).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('refuses when the group exists without the node as member', async () => {
    const gid = crypto.randomUUID();
    bucket(`proxy-groups:${PID}`).set(gid, {
      id: gid,
      kind: 'raw',
      name: 'Tailscale',
      type: 'select',
      proxies: ['DIRECT'],
      rank: 10,
      created_at: 0,
      updated_at: 0,
    });
    await expect(runEnable()).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('emits IP-CIDR6 for IPv6 extra ranges and dedupes against the CGNAT default', async () => {
    const { data } = await runEnable({
      extraCidrs: ['192.168.50.0/24', 'fd7a:115c:a1e0::/48', '100.64.0.0/10'],
    });
    const rules = Array.from(bucket(`rules:${PID}`).values()) as Rule[];
    expect(rules).toHaveLength(3);
    const byValue = new Map(rules.map((r) => [r.value, r]));
    expect(byValue.get('192.168.50.0/24')!.type).toBe('IP-CIDR');
    expect(byValue.get('fd7a:115c:a1e0::/48')!.type).toBe('IP-CIDR6');
    expect((data as { createdRules: unknown[] }).createdRules).toHaveLength(3);
  });

  it('rejects when base has no rule anchor', async () => {
    seedBase(BASE_WITHOUT_ANCHOR);
    await expect(runEnable()).rejects.toMatchObject({ problem: { status: 422 } });
  });
});

describe('tailscale disable', () => {
  it('tears down rules + group + node and redacts the credential', async () => {
    await runEnable();
    const { data, events } = await scenario.tailscaleScenario.ops.disable(makeCtx(), {});
    expect(data).toMatchObject({
      nodeName: 'ts-mate70',
      groupName: 'Tailscale',
      removed: { node: true, group: true },
    });
    expect(baseRecord!.content).not.toContain('tailscale');
    expect(Array.from(bucket(`proxy-groups:${PID}`).values())).toHaveLength(0);
    expect(Array.from(bucket(`rules:${PID}`).values())).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain('FAKE_TSKEY_DO_NOT_LOG');
    const before = events[0].before as { node: { hasAuthKey: boolean } };
    expect(before.node.hasAuthKey).toBe(true);
  });

  it('refuses when a foreign group references the node', async () => {
    await runEnable();
    const gid = crypto.randomUUID();
    bucket(`proxy-groups:${PID}`).set(gid, {
      id: gid,
      kind: 'raw',
      name: '出口聚合',
      type: 'select',
      proxies: ['ts-mate70', 'DIRECT'],
      rank: 20,
      created_at: 0,
      updated_at: 0,
    });
    // Without an explicit group the ambiguity refusal fires first (422).
    await expect(scenario.tailscaleScenario.ops.disable(makeCtx(), {})).rejects.toMatchObject({
      problem: { status: 422 },
    });
    // With the group pinned, the foreign-reference scan refuses the teardown.
    await expect(
      scenario.tailscaleScenario.ops.disable(makeCtx(), { groupName: 'Tailscale' }),
    ).rejects.toMatchObject({ problem: { status: 409 } });
  });

  it('refuses a user-reshaped group (narrow shape check)', async () => {
    await runEnable();
    const groups = bucket(`proxy-groups:${PID}`);
    const g = Array.from(groups.values())[0] as ProxyGroup;
    groups.set(g.id, { ...g, proxies: ['ts-mate70', 'DIRECT'] });
    await expect(scenario.tailscaleScenario.ops.disable(makeCtx(), {})).rejects.toMatchObject({
      problem: { status: 422 },
    });
  });
});

describe('tailscale undo', () => {
  it('inverse of enable removes exactly what enable created', async () => {
    const { events } = await runEnable();
    const inverse = scenario.tailscaleScenario.inverses!.enable;
    await inverse(makeCtx(), { id: 'e1', after: events[0].after });
    expect(baseRecord!.content).not.toContain('tailscale');
    expect(Array.from(bucket(`proxy-groups:${PID}`).values())).toHaveLength(0);
    expect(Array.from(bucket(`rules:${PID}`).values())).toHaveLength(0);
  });

  it('inverse of enable refuses when a created rule was modified afterwards', async () => {
    const { events } = await runEnable();
    const rules = bucket(`rules:${PID}`);
    const r = Array.from(rules.values())[0] as Rule;
    rules.set(r.id, { ...r, updated_at: r.updated_at + 100 });
    const inverse = scenario.tailscaleScenario.inverses!.enable;
    await expect(inverse(makeCtx(), { id: 'e1', after: events[0].after })).rejects.toMatchObject({
      problem: { status: 409 },
    });
  });

  it('inverse of disable restores everything except the auth-key', async () => {
    await runEnable();
    const { events } = await scenario.tailscaleScenario.ops.disable(makeCtx(), {});
    const inverse = scenario.tailscaleScenario.inverses!.disable;
    const { data } = await inverse(makeCtx(), { id: 'e2', before: events[0].before });

    expect(baseRecord!.content).toContain('type: tailscale');
    expect(baseRecord!.content).toContain('hostname: mate70');
    // The credential is gone by design; the caller is told to re-enter it.
    expect(baseRecord!.content).not.toContain('FAKE_TSKEY_DO_NOT_LOG');
    expect((data as { authKeyNote?: string }).authKeyNote).toBeTruthy();
    expect(Array.from(bucket(`proxy-groups:${PID}`).values())).toHaveLength(1);
    expect(Array.from(bucket(`rules:${PID}`).values())).toHaveLength(1);
  });
});

describe('summariseTailscale', () => {
  it('reports uninitialized profiles', async () => {
    baseRecord = null;
    const summary = await scenario.summariseTailscale(PID);
    expect(summary.initialized).toBe(false);
  });

  it('detects the enable-emitted shape and never leaks the auth-key', async () => {
    await runEnable();
    const summary = await scenario.summariseTailscale(PID);
    expect(summary.initialized).toBe(true);
    expect(summary.nodes).toHaveLength(1);
    expect(summary.nodes[0]).toMatchObject({
      name: 'ts-mate70',
      hostname: 'mate70',
      hasAuthKey: true,
    });
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({ name: 'Tailscale', managedShape: true });
    expect(summary.rules).toHaveLength(1);
    expect(summary.anchors).toContain('manual');
    expect(JSON.stringify(summary)).not.toContain('FAKE_TSKEY_DO_NOT_LOG');
  });

  it('flags a user-reshaped group as unmanaged', async () => {
    await runEnable();
    const groups = bucket(`proxy-groups:${PID}`);
    const g = Array.from(groups.values())[0] as ProxyGroup;
    groups.set(g.id, { ...g, proxies: ['ts-mate70', 'DIRECT'] });
    const summary = await scenario.summariseTailscale(PID);
    expect(summary.groups[0].managedShape).toBe(false);
  });
});
