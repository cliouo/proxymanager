import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';

const hashes = new Map<string, Map<string, string>>();
const evalCalls: Array<{ keys: string[]; args: string[] }> = [];

function hash(key: string): Map<string, string> {
  let map = hashes.get(key);
  if (!map) {
    map = new Map();
    hashes.set(key, map);
  }
  return map;
}

const fakeRedis = {
  eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
    evalCalls.push({ keys, args });
    const out: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i += 1) {
      const pid = args[i]!;
      const groupsKey = keys[i * 3]!;
      const rulesKey = keys[i * 3 + 1]!;
      const devicesKey = keys[i * 3 + 2]!;

      const groups = [...hash(groupsKey).values()]
        .map((raw) => JSON.parse(raw) as { name?: string; rank?: number })
        .filter((g): g is { name: string; rank?: number } => typeof g.name === 'string')
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name));

      let activeRules = 0;
      let disabledRules = 0;
      const policies: Record<string, number> = {};
      for (const raw of hash(rulesKey).values()) {
        const rule = JSON.parse(raw) as { enabled?: boolean; policy?: string };
        if (rule.enabled === false) disabledRules += 1;
        else activeRules += 1;
        if (typeof rule.policy === 'string' && rule.policy) {
          policies[rule.policy] = (policies[rule.policy] ?? 0) + 1;
        }
      }

      out[pid] = {
        groupsCount: groups.length,
        rankedGroupNames: groups.map((g) => g.name),
        activeRules,
        disabledRules,
        policies,
        devicesCount: hash(devicesKey).size,
      };
    }
    return JSON.stringify(out);
  }),
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

import { GET } from '@/app/api/v1/profiles/summaries/route';

describe('GET /api/v1/profiles/summaries', () => {
  beforeEach(() => {
    hashes.clear();
    evalCalls.length = 0;
    fakeRedis.eval.mockClear();
  });

  it('aggregates bounded batches in one Redis eval with ranked groups, rule policies, and device HLEN', async () => {
    hash(REDIS_KEYS.proxyGroups('p1')).set('g2', JSON.stringify({ id: 'g2', name: 'AI', rank: 20 }));
    hash(REDIS_KEYS.proxyGroups('p1')).set('g1', JSON.stringify({ id: 'g1', name: 'Proxy', rank: 10 }));
    hash(REDIS_KEYS.rules('p1')).set('r1', JSON.stringify({ id: 'r1', policy: 'Proxy', enabled: true }));
    hash(REDIS_KEYS.rules('p1')).set('r2', JSON.stringify({ id: 'r2', policy: 'Proxy', enabled: false }));
    hash(REDIS_KEYS.rules('p1')).set('r3', JSON.stringify({ id: 'r3', policy: 'DIRECT', enabled: true }));
    hash(REDIS_KEYS.devices('p1')).set('d1', JSON.stringify({ id: 'd1', name: 'mac' }));
    hash(REDIS_KEYS.devices('p1')).set('d2', JSON.stringify({ id: 'd2', name: 'iphone' }));

    const res = await GET(new Request('http://localhost/api/v1/profiles/summaries?ids=p1,p2,p1'));
    expect(res.status).toBe(200);
    expect(evalCalls).toHaveLength(1);
    expect(evalCalls[0]!.args).toEqual(['p1', 'p2']);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.p1).toEqual({
      groupsCount: 2,
      rankedGroupNames: ['Proxy', 'AI'],
      activeRules: 2,
      disabledRules: 1,
      policies: { Proxy: 2, DIRECT: 1 },
      devicesCount: 2,
    });
    expect(body.data.p2).toEqual({
      groupsCount: 0,
      rankedGroupNames: [],
      activeRules: 0,
      disabledRules: 0,
      policies: {},
      devicesCount: 0,
    });
  });

  it('rejects empty or oversized batches (> 8 ids) with 422', async () => {
    const empty = await GET(new Request('http://localhost/api/v1/profiles/summaries'));
    expect(empty.status).toBe(422);

    const nine = Array.from({ length: 9 }, (_, i) => `p${i}`).join(',');
    const oversized = await GET(new Request(`http://localhost/api/v1/profiles/summaries?ids=${nine}`));
    expect(oversized.status).toBe(422);

    const invalid = await GET(new Request('http://localhost/api/v1/profiles/summaries?ids=bad/id'));
    expect(invalid.status).toBe(422);
    expect(fakeRedis.eval).not.toHaveBeenCalled();
  });
});
