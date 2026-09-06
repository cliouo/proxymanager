import { beforeEach, expect, it, vi } from 'vitest';
import type { ProxyGroup, Rule } from '@/schemas';
const state = vi.hoisted(() => ({
  version: 7,
  groups: [] as ProxyGroup[],
  rules: [] as Rule[],
  race: false,
  audits: vi.fn(),
  eval: vi.fn(),
}));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: async () => state.version }));
vi.mock('@/lib/repos/nodeOrdinalRepo', () => ({ getOrdinalGeneration: async () => 0 }));
vi.mock('@/lib/repos/profilesRepo', () => ({
  getProfile: async () => ({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'default',
    source: { type: 'none' },
    kind: 'normal',
    updated_at: 1,
  }),
}));
vi.mock('@/lib/profileScope', () => ({
  resolveScopeProfile: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
}));
vi.mock('@/lib/repos/baseRepo', () => ({
  getBase: async () => ({
    content:
      'mixed-port: 7890\nproxies: []\n\n# === PROXY-GROUPS ===\n\nrules:\n  # === ANCHOR: manual ===\n  - MATCH,DIRECT\n',
    anchors: ['manual'],
    policies: ['DIRECT'],
    etag: 'base',
    updated_at: 1,
  }),
}));
vi.mock('@/lib/repos/proxyGroupsRepo', async (original) => ({
  ...(await original<typeof import('@/lib/repos/proxyGroupsRepo')>()),
  listProxyGroups: async () => structuredClone(state.groups),
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: async () => structuredClone(state.rules) }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: async () => [] }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: async () => [] }));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({ listRuleSets: async () => [] }));
vi.mock('@/lib/repos/proxyGroupTemplatesRepo', () => ({ listProxyGroupTemplates: async () => [] }));
vi.mock('@/lib/repos/devicesRepo', () => ({ listDevices: async () => [] }));
vi.mock('@/lib/repos/auditRepo', () => ({ recordEvent: state.audits, recordEvents: state.audits }));
vi.mock('@/lib/redis/client', () => ({ getRedis: () => ({ eval: state.eval }) }));

// Real service, final renderer/preflight, and repository serialization/CAS;
// only external storage is replaced by an in-memory CAS transport.
import { reorderProxyGroups, moveRule } from '@/lib/services/orderService';
import { POST as batch } from '@/app/api/v1/rules/batch/route';
const PROFILE = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rule = (id: string, rank: number): Rule => ({
  id,
  anchor: 'manual',
  type: 'DOMAIN',
  value: `${rank}.test`,
  policy: 'DIRECT',
  source: 'manual',
  rank,
  added_at: 1,
  updated_at: 1,
});
beforeEach(() => {
  state.version = 7;
  state.race = false;
  state.audits.mockClear();
  state.eval.mockReset();
  state.groups = [A, B].map(
    (id, i) =>
      ({
        id,
        name: `group-${i}`,
        kind: 'raw',
        type: 'select',
        proxies: ['DIRECT'],
        rank: (i + 1) * 10,
        created_at: 1,
        updated_at: 1,
      }) as ProxyGroup,
  );
  state.rules = [rule(A, 10), rule(B, 20)];
  state.eval.mockImplementation(async (_script: string, _keys: string[], args: string[]) => {
    if (state.race) state.version++;
    if (Number(args[0]) !== state.version) return [0, String(state.version)];
    let cursor = 2;
    const apply = <T extends { id: string }>(items: T[]) => {
      const map = new Map(items.map((v) => [v.id, v]));
      const count = Number(args[cursor++]);
      for (let i = 0; i < count; i++) {
        const id = args[cursor++];
        map.set(id, JSON.parse(args[cursor++]));
      }
      const deletes = Number(args[cursor++]);
      for (let i = 0; i < deletes; i++) map.delete(args[cursor++]);
      return [...map.values()];
    };
    state.rules = apply(state.rules);
    state.groups = apply(state.groups);
    state.version++;
    return [1, String(state.version)];
  });
});

it('persists a complete group swap with one version increment and one non-undoable audit', async () => {
  await reorderProxyGroups(PROFILE, [B, A], 7, 'test');
  expect(state.groups.map((g) => [g.id, g.rank])).toEqual([
    [A, 20],
    [B, 10],
  ]);
  expect(state.version).toBe(8);
  expect(state.eval).toHaveBeenCalledOnce();
  expect(state.audits).toHaveBeenCalledWith(
    expect.objectContaining({ undoable: false, profileId: PROFILE }),
  );
});
it('leaves every rank untouched when the final CAS conflicts', async () => {
  const before = structuredClone(state.groups);
  state.race = true;
  await expect(reorderProxyGroups(PROFILE, [B, A], 7, 'test')).rejects.toMatchObject({
    problem: { status: 412 },
  });
  expect(state.groups).toEqual(before);
  expect(state.audits).not.toHaveBeenCalled();
});
it.each([[A], [A, A], [A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']])(
  'rejects incomplete, duplicate or foreign ID lists before writing: %j',
  async (...ids) => {
    await expect(reorderProxyGroups(PROFILE, ids, 7, 'test')).rejects.toMatchObject({
      problem: { status: 422 },
    });
    expect(state.version).toBe(7);
    expect(state.eval).not.toHaveBeenCalled();
  },
);
it('still rejects a final config with a missing group reference', async () => {
  state.groups[0].proxies = ['missing-group'];
  await expect(reorderProxyGroups(PROFILE, [B, A], 7, 'test')).rejects.toMatchObject({
    name: 'ConfigValidationError',
  });
  expect(state.eval).not.toHaveBeenCalled();
  expect(state.version).toBe(7);
});
it('moves against the complete anchor across the 100-row boundary', async () => {
  state.rules = Array.from({ length: 101 }, (_, i) => rule(crypto.randomUUID(), (i + 1) * 10));
  const before = state.rules[99],
    after = state.rules[100];
  await moveRule(PROFILE, before.id, 'down', 7, 'test');
  expect(state.rules.find((r) => r.id === before.id)?.rank).toBe(1010);
  expect(state.rules.find((r) => r.id === after.id)?.rank).toBe(1000);
  expect(state.version).toBe(8);
});
it.each([
  ['update', 'update'],
  ['update', 'delete'],
  ['delete', 'delete'],
])('rejects duplicate %s/%s before storage or audit', async (first, second) => {
  const response = await batch(
    new Request('https://pm.test/api/v1/rules/batch', {
      method: 'POST',
      body: JSON.stringify({
        ops: [first, second].map((op) => ({
          op,
          id: A,
          ...(op === 'update' ? { patch: { note: 'new' } } : {}),
        })),
      }),
    }),
  );
  expect(response.status).toBe(422);
  expect(state.eval).not.toHaveBeenCalled();
  expect(state.audits).not.toHaveBeenCalled();
  expect(state.rules[0].note).toBeUndefined();
});
it('persists a merged multi-field rule patch as one final state', async () => {
  const response = await batch(
    new Request('https://pm.test/api/v1/rules/batch', {
      method: 'POST',
      body: JSON.stringify({
        ops: [{ op: 'update', id: A, patch: { policy: 'REJECT', note: 'merged' } }],
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(state.rules[0]).toMatchObject({ policy: 'REJECT', note: 'merged' });
  expect(state.version).toBe(8);
});
