/**
 * pass-10 blocker 1/2 regression tests: collection LIST/ITEM alias
 * projection uses the ENABLED authoritative member set (disabled members'
 * stored aliases drop, their src- handles never project), and generic
 * create/PUT surfaces enforce the naming-row invariant.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { buildSourceAliasScope } from '@/lib/proxies/handleScopes';

/** Test-local source-handle helper: a complete one-key domain. */
const srcHandle = (key: string): string => buildSourceAliasScope([key]).project(key);
import { GET as listGET, POST as createPOST } from '@/app/api/v1/collections/route';
import { GET as itemGET } from '@/app/api/v1/collections/[id]/route';
import { PUT as subPUT } from '@/app/api/v1/subscriptions/[id]/route';

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
    for (const id of ids) if (m.delete(id)) n++;
    return n;
  },
  get: async (key: string) => (counters.has(key) ? counters.get(key)! : null),
  mget: async (...keys: string[]) => keys.map((k) => bucket(k).get('base') ?? null),
  incr: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
  eval: async (_script: string, keys: string[], args: string[]) => {
    const current = counters.get(keys[0]) ?? 0;
    if (current !== Number(args[0])) return [0, String(current)];
    await fakeRedis.hset(keys[1], { [args[1]]: JSON.parse(args[2]) });
    counters.set(keys[0], current + 1);
    return [1, String(current + 1)];
  },
  multi: () => ({
    hset: () => ({}) as never,
    incr: () => ({}) as never,
    exec: async () => [],
  }),
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: vi.fn(async () => ({
    configVersion: counters.get(REDIS_KEYS.configVersion) ?? 0,
  })),
}));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxiesRaw: vi.fn(async () => ({
    proxies: [{ name: '香港 01', type: 'ss', server: 'a.example.com', port: 443 }],
    proxyCount: 1,
  })),
}));
vi.mock('@/lib/services/nodeExportService', () => ({
  mergeCollectionMemberProxies: vi.fn(async () => ({
    merged: [{ name: '香港 01', type: 'ss', server: 'a.example.com', port: 443 }],
    memberErrors: [],
  })),
}));

const ENABLED = '11111111-1111-4111-8111-111111111111';
const DISABLED = '33333333-3333-4333-8333-333333333333';
const COL_ID = '22222222-2222-4222-8222-222222222222';

function seed(): void {
  bucket(REDIS_KEYS.subscriptions).set(ENABLED, {
    id: ENABLED,
    name: 'enabled-key',
    display_name: '在线源',
    enabled: true,
    kind: 'remote',
    url: 'https://a.example/sub',
    ttl_ms: 600000,
    tags: [],
    operators: [],
  });
  bucket(REDIS_KEYS.subscriptions).set(DISABLED, {
    id: DISABLED,
    name: 'disabled-key',
    display_name: '停用源',
    enabled: false,
    kind: 'remote',
    url: 'https://b.example/sub',
    ttl_ms: 600000,
    tags: [],
    operators: [],
  });
  bucket(REDIS_KEYS.collections).set(COL_ID, {
    id: COL_ID,
    name: '聚合池',
    slug: 'pool',
    enabled: true,
    type: 'select',
    subscription_ids: [ENABLED, DISABLED],
    subscription_tags: [],
    operators: [
      {
        id: 'rt-1',
        kind: 'rename-template',
        template: '${emoji} ${region}',
        sourceAliases: { 'enabled-key': '在线', 'disabled-key': '停用别名' },
        recognitionRules: [],
      },
    ],
  });
}

beforeAll(() => {
  installTestHandleSecret();
});

beforeEach(() => {
  stores.clear();
  counters.clear();
  seed();
});

afterEach(() => vi.restoreAllMocks());

describe('pass-10 blocker 1: collection alias routes use the ENABLED authoritative set', () => {
  it('LIST projects only the enabled member — the disabled member alias and its src- handle never appear', async () => {
    const res = await listGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ operators: Array<{ sourceAliases?: Record<string, string> }> }>;
    };
    const op = body.data[0].operators.find(
      (o) => (o as { kind?: string }).kind === 'rename-template',
    ) as { sourceAliases?: Record<string, string> };
    // Delivery probe: the disabled-only key projected `{"src-…":"STALE"}`
    // before — the enabled authoritative set must project ONLY enabled-key
    expect(op.sourceAliases).toEqual({ [srcHandle('enabled-key')]: '在线' });
    expect(JSON.stringify(body)).not.toContain('disabled-key');
    expect(JSON.stringify(body)).not.toContain(srcHandle('disabled-key'));
  });

  it('ITEM GET projects only the enabled member too', async () => {
    const res = await itemGET(new Request('http://localhost/api/v1/collections/' + COL_ID), {
      params: Promise.resolve({ id: COL_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { operators: Array<{ sourceAliases?: Record<string, string> }> };
    };
    const op = body.data.operators.find(
      (o) => (o as { kind?: string }).kind === 'rename-template',
    ) as { sourceAliases?: Record<string, string> };
    expect(op.sourceAliases).toEqual({ [srcHandle('enabled-key')]: '在线' });
    expect(JSON.stringify(body)).not.toContain('disabled-key');
  });
});

describe('pass-10 blocker 2: generic create/PUT naming-row invariant', () => {
  it('collection CREATE with a rename-template operator fails the dedicated gate with zero writes', async () => {
    counters.set(REDIS_KEYS.configVersion, 3);
    const before = JSON.stringify([...bucket(REDIS_KEYS.collections).values()]);
    const res = await createPOST(
      new Request('http://localhost/api/v1/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'new-col',
          slug: 'new-col',
          operators: [
            {
              id: 'rt-new',
              kind: 'rename-template',
              template: '${region}',
              recognitionRules: [],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('名称统一');
    expect(JSON.stringify([...bucket(REDIS_KEYS.collections).values()])).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(3);
  });

  it('subscription PUT (replace) touching/moving/deleting the naming row fails the gate with byte-identical state', async () => {
    const SUB = '44444444-4444-4444-8444-444444444444';
    const rt = {
      id: 'rt-1',
      kind: 'rename-template',
      template: '${emoji} ${region}',
      recognitionRules: [],
    };
    bucket(REDIS_KEYS.subscriptions).set(SUB, {
      id: SUB,
      name: 'replace-me',
      display_name: '替换源',
      enabled: true,
      kind: 'remote',
      url: 'https://c.example/sub',
      ttl_ms: 600000,
      tags: [],
      operators: [{ id: 'f1', kind: 'filter-useless', extra: [] }, rt],
    });
    counters.set(REDIS_KEYS.configVersion, 3);
    const before = JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB));
    const put = (operators: unknown[]) =>
      subPUT(
        new Request('http://localhost/api/v1/subscriptions/' + SUB, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'replace-me',
            enabled: true,
            kind: 'remote',
            url: 'https://c.example/sub',
            ttl_ms: 600000,
            tags: [],
            operators,
          }),
        }),
        { params: Promise.resolve({ id: SUB }) } as never,
      );
    // TOUCH the naming row (template changed)
    const touched = await put([
      { id: 'f1', kind: 'filter-useless', extra: [] },
      { ...rt, template: '${region}' },
    ]);
    expect(touched.status).toBe(400);
    // DELETE the naming row
    const deleted = await put([{ id: 'f1', kind: 'filter-useless', extra: [] }]);
    expect(deleted.status).toBe(400);
    // MOVE the naming row (index 1 → 0)
    const moved = await put([rt, { id: 'f1', kind: 'filter-useless', extra: [] }]);
    expect(moved.status).toBe(400);
    // CREATE a NEW naming row (different id) in the candidate
    const created = await put([
      { id: 'f1', kind: 'filter-useless', extra: [] },
      { id: 'rt-2', kind: 'rename-template', template: '${region}', recognitionRules: [] },
    ]);
    expect(created.status).toBe(400);
    // every rejection left entity/version byte-identical
    expect(JSON.stringify(bucket(REDIS_KEYS.subscriptions).get(SUB))).toBe(before);
    expect(counters.get(REDIS_KEYS.configVersion)).toBe(3);
    // a NON-name replace succeeds with the naming row byte-identical/unmoved
    const ok = await put([
      { id: 'f1', kind: 'filter-useless', extra: [] },
      rt,
      { id: 'f2', kind: 'sort', by: 'name', order: 'asc' },
    ]);
    expect(ok.status).toBe(200);
    const stored = bucket(REDIS_KEYS.subscriptions).get(SUB) as { operators: unknown[] };
    expect(stored.operators[1]).toEqual(rt);
  });
});
