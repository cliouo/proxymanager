import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  listRules: vi.fn(),
  getConfigVersion: vi.fn(),
  resolveScopeProfile: vi.fn(),
}));
vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: mocks.listRules }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: mocks.getConfigVersion }));
vi.mock('@/lib/profileScope', () => ({ resolveScopeProfile: mocks.resolveScopeProfile }));
vi.mock('@/lib/redis/client', () => ({
  getRedis: () => ({
    get: async () => null,
    mget: async () => [await mocks.getConfigVersion(), null],
    multi: () => {
      const tx = { zadd: () => tx, expire: () => tx, set: () => tx, exec: async () => [] };
      return tx;
    },
    zrange: async (_key: string, start: number, end: number) => {
      const { filterAndSortRules } = await import('@/lib/services/rulePage');
      return filterAndSortRules(await mocks.listRules(), lastQuery)
        .slice(start, end + 1)
        .map((r) => r.id);
    },
    hmget: async (_key: string, ...ids: string[]) =>
      Object.fromEntries(
        (await mocks.listRules())
          .filter((r: { id: string }) => ids.includes(r.id))
          .map((r: { id: string }) => [r.id, r]),
      ),
  }),
}));
let lastQuery: import('@/lib/services/rulePage').RuleQuery = { sort: 'rank:asc' };
vi.mock('@/lib/services/rulePage', async (original) => {
  const mod = await original<typeof import('@/lib/services/rulePage')>();
  return {
    ...mod,
    readRulePage: (...args: Parameters<typeof mod.readRulePage>) => {
      lastQuery = args[1];
      return mod.readRulePage(...args);
    },
  };
});
import { GET } from '@/app/api/v1/rules/route';
import { GET as summary } from '@/app/api/v1/rules/summary/route';
beforeEach(() => {
  mocks.resolveScopeProfile.mockResolvedValue({ id: 'profile-a' });
  mocks.getConfigVersion.mockResolvedValue(3);
  mocks.listRules.mockResolvedValue(
    Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(4, '0'),
      anchor: 'manual',
      type: i === 1000 ? 'RULE-SET' : 'DOMAIN',
      value: i === 1000 ? 'last-set' : `${i}.test`,
      note: '',
      options: i === 1000 ? ['no-resolve'] : [],
      policy: i === 1000 ? 'last-group' : 'DIRECT',
      enabled: i !== 1000,
      rank: i === 1000 ? 999 : i,
    })),
  );
});
it('pages and searches beyond the first 500, including options and enabled', async () => {
  const last = await (
    await GET(new Request('https://pm.test/api/v1/rules?limit=100&offset=1000'))
  ).json();
  expect(last.data.map((r: { id: string }) => r.id)).toEqual(['1000']);
  expect(last.meta).toMatchObject({ total: 1001, configVersion: 3 });
  const search = await (
    await GET(new Request('https://pm.test/api/v1/rules?q=no-resolve&enabled=false'))
  ).json();
  expect(search.data).toHaveLength(1);
  expect(search.data[0].id).toBe('1000');
  const counts = await (await summary(new Request('https://pm.test/api/v1/rules/summary'))).json();
  expect(counts.data).toMatchObject({
    total: 1001,
    active: 1000,
    disabled: 1,
    policies: { 'last-group': 1 },
    ruleSets: { 'last-set': 1 },
    anchors: { manual: { total: 1001, active: 1000 } },
  });
});
it('refuses to label an unstable list with a new config version', async () => {
  let version = 0;
  mocks.getConfigVersion.mockImplementation(async () => ++version);
  expect((await GET(new Request('https://pm.test/api/v1/rules'))).status).toBe(412);
});
