import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { DEFAULT_PROFILE_NAME } from '@/schemas';
import { buildTargetRefScope } from '@/lib/proxies/handleScopes';
import { GLOBAL_NAMING_SCOPE_ID } from '@/lib/services/namingTargetScope';

/** Test-local ref helper: a complete one-target domain. */
const refOf = (type: 'subscription' | 'collection', id: string): string =>
  buildTargetRefScope(PID, [{ type, id }]).project(`${type}:${id}`);
const globalRefOf = (type: 'subscription' | 'collection', id: string): string =>
  buildTargetRefScope(GLOBAL_NAMING_SCOPE_ID, [{ type, id }]).project(`${type}:${id}`);
import { REDIS_KEYS } from '@/lib/redis/keys';

/**
 * Route-level test for POST /api/v1/assistant/naming-analysis:
 *   - the stored assistant config (AI 配置页) drives the model call — custom
 *     base URL / model / key are actually used, and no DEEPSEEK_API_KEY env
 *     var is required;
 *   - no stored config → 404 with a clear message (non-destructive);
 *   - the model only ever receives the scrubbed payload.
 */

const stores = new Map<string, Map<string, unknown>>();
const scalars = new Map<string, unknown>();
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
    for (const [id, v] of Object.entries(payload)) bucket(key).set(id, v);
  },
  get: async (key: string) => (scalars.has(key) ? scalars.get(key)! : null),
  set: async (key: string, value: unknown) => {
    scalars.set(key, value);
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxiesRaw: vi.fn(async () => ({
    proxies: [
      { name: '🇭🇰 香港 01', type: 'ss' },
      { name: '🇯🇵 日本 2x', type: 'ss' },
    ],
    proxyCount: 2,
  })),
}));
vi.mock('@/lib/services/nodeExportService', () => ({
  mergeCollectionMemberProxies: vi.fn(async () => ({ merged: [], memberErrors: [] })),
}));

import { POST } from '@/app/api/v1/assistant/naming-analysis/route';

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_REF = () => refOf('subscription', SUB_ID);

const SUGGESTION = {
  template:
    '${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}',
  tw2cn: false,
  sourceAliases: {},
  recognitionRules: [],
  reason: '识别稳定，建议均衡方案。',
};

let fetchMock: ReturnType<typeof vi.fn>;

function seedSubscription(): void {
  bucket(REDIS_KEYS.subscriptions).set(SUB_ID, {
    id: SUB_ID,
    name: 'my-sub',
    display_name: '我的订阅',
    enabled: true,
    kind: 'remote',
    url: 'https://example.test/sub',
    ttl_ms: 600000,
    tags: [],
    operators: [],
  });
  // pass-7: the route authorizes the ref through the DEFAULT profile's
  // source binding (the request carries no ?profile= query).
  bucket(REDIS_KEYS.profiles).set(PID, {
    id: PID,
    name: DEFAULT_PROFILE_NAME,
    display_name: '默认配置',
    source: { type: 'subscription', id: SUB_ID },
    kind: 'normal',
    updated_at: 0,
  });
}

beforeEach(() => {
  stores.clear();
  scalars.clear();
  // No server-side key — the request must work purely off the stored config.
  delete process.env.DEEPSEEK_API_KEY;
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content: JSON.stringify(SUGGESTION) } }] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  seedSubscription();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(body: unknown): Request {
  return new Request('http://localhost/api/v1/assistant/naming-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  installTestHandleSecret();
});

describe('POST /api/v1/assistant/naming-analysis', () => {
  it('accepts a global workspace ref even when the active profile does not consume the target', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'cfg-key-123',
    });
    bucket(REDIS_KEYS.profiles).set(PID, {
      id: PID,
      name: DEFAULT_PROFILE_NAME,
      display_name: '默认配置',
      source: { type: 'none' },
      kind: 'normal',
      updated_at: 1,
    });

    const res = await POST(request({ ref: globalRefOf('subscription', SUB_ID) }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the STORED assistant config (custom base URL/model/key), no env key needed', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, {
      baseUrl: 'https://custom-llm.example/v1',
      model: 'custom-model-7b',
      apiKey: 'cfg-key-123',
      thinking: 'disabled',
      reasoningEffort: 'low',
      maxTokens: 2048,
    });

    const res = await POST(request({ ref: SUB_REF() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { suggestion: unknown; payload: { nodeCount: number } };
    };
    expect(body.data.suggestion).toEqual(SUGGESTION);
    expect(body.data.payload.nodeCount).toBe(2);

    // the model request went to the configured endpoint with the configured
    // model and the configured key
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://custom-llm.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer cfg-key-123');
    expect(JSON.parse(init.body).model).toBe('custom-model-7b');
  });

  it('round-1: sanitized names + labels reach the model bounded; credentials/stable keys never do', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'cfg-key-123',
    });
    const res = await POST(request({ ref: SUB_REF() }));
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sent = init.body;
    // round-1 (invariant 6): sanitized ORIGINAL display names and safe
    // source labels are authorized display content — they reach the model
    // bounded; the stable key and credentials never do
    expect(sent).toContain('香港 01');
    expect(sent).toContain('我的订阅');
    expect(sent).not.toContain('my-sub');
    expect(sent).not.toContain('edge.invalid');
    // the feature payload is JSON-embedded (inner quotes escaped) — region/rate
    // features are present
    expect(sent).toContain('region');
    expect(sent).toContain('rate');
  });

  it('round-1: benign ordinary names + partial residues reach the MODEL MESSAGE bounded; connection fields never do', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'cfg-key-123',
    });
    // the Delivery probe fixture: benign unique names + partial residues
    const fetcher = await import('@/lib/services/subscriptionFetcher');
    const raw = fetcher.resolveSubscriptionProxiesRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockResolvedValueOnce({
      proxies: [
        { name: 'BenignUniqueNodeName', type: 'ss', server: 'n1.invalid', port: 443 },
        { name: '机场甲 专线A', type: 'vmess', server: 'n2.invalid', port: 8443 },
        { name: '香港 01', type: 'trojan', server: 'n3.invalid', port: 443 },
      ],
      proxyCount: 3,
    });
    try {
      const res = await POST(request({ ref: SUB_REF() }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          payload: {
            nodeCount: number;
            nodes: Array<{ hasResidual: boolean; name: string | null }>;
            sourcesTotal: number;
          };
        };
      };
      const payload = body.data.payload;
      expect(payload.nodeCount).toBe(3);
      expect(payload.nodes.every((n) => n.hasResidual === true)).toBe(true);
      // round-1: the returned privacy payload KEEPS the sanitized original
      // names (useful display content) and stays free of connection fields
      const returned = JSON.stringify(payload);
      for (const seed of ['BenignUniqueNodeName', '机场甲', '专线A', '香港 01']) {
        expect(returned, `returned payload should keep ${seed}`).toContain(seed);
      }
      for (const seed of ['n1.invalid', '8443', 'n2.invalid', 'n3.invalid']) {
        expect(returned, `returned payload leaks ${seed}`).not.toContain(seed);
      }
      // byte bound on the returned payload
      expect(returned.length).toBeLessThan(64 * 1024);
      // the MODEL MESSAGE keeps the useful names and is free of the seeds
      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      const sent = init.body;
      for (const seed of ['BenignUniqueNodeName', '机场甲', '专线A', '香港 01']) {
        expect(sent, `model message should keep ${seed}`).toContain(seed);
      }
      for (const seed of ['n1.invalid', '8443', 'n2.invalid', 'n3.invalid']) {
        expect(sent, `model message leaks ${seed}`).not.toContain(seed);
      }
      // canonical facts survive for the AI: hasResidual flags + true totals
      expect(sent).toContain('hasResidual');
      expect(sent).toContain('nodeCount');
    } finally {
      raw.mockReset();
    }
  });

  it('404s with a clear message when the assistant is not configured', async () => {
    const res = await POST(request({ ref: SUB_REF() }));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pass-5: missing handle secret fails the one-shot route closed with a GENERIC 500 — no env name, no key material', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'cfg-key-123',
    });
    const { resetHandleSecret, injectHandleSecret } = await import('@/lib/proxies/handles');
    // the ref must be minted under the ACTIVE test key BEFORE the secret is
    // cleared — the route re-derives and compares it AFTER the reset
    const ref = SUB_REF();
    resetHandleSecret();
    const previous = process.env.NODE_HANDLE_SECRET;
    delete process.env.NODE_HANDLE_SECRET;
    try {
      const res = await POST(request({ ref }));
      expect(res.status).toBe(500);
      const text = await res.text();
      // server misconfiguration is a 5xx, never a 422 with reflected detail
      expect(text).not.toContain('NODE_HANDLE_SECRET');
      expect(text).not.toContain('test-only-handle-secret');
      expect(text).not.toContain('0000000000000000');
    } finally {
      if (previous !== undefined) process.env.NODE_HANDLE_SECRET = previous;
      injectHandleSecret('test-only-handle-secret-0000000000000000');
    }
  });

  it('pass-5: a WEAK production secret fails the one-shot route closed with the same GENERIC 500', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'cfg-key-123',
    });
    const { resetHandleSecret, injectHandleSecret } = await import('@/lib/proxies/handles');
    const ref = SUB_REF();
    resetHandleSecret();
    const previous = process.env.NODE_HANDLE_SECRET;
    process.env.NODE_HANDLE_SECRET = 'x';
    try {
      const res = await POST(request({ ref }));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('NODE_HANDLE_SECRET');
      expect(text).not.toContain('test-only-handle-secret');
    } finally {
      if (previous !== undefined) process.env.NODE_HANDLE_SECRET = previous;
      injectHandleSecret('test-only-handle-secret-0000000000000000');
    }
  });

  it('rejects unknown source types', async () => {
    scalars.set(REDIS_KEYS.assistantConfig, { apiKey: 'k' });
    const res = await POST(request({ ref: 'garbage' }));
    expect(res.status).toBe(422);
  });

  it('pass-8 blocker 5: an AUTHORIZED COLLECTION (aggregate) target resolves and analyzes', async () => {
    const COL_ID = '22222222-2222-4222-8222-222222222222';
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合池',
      slug: 'pool',
      enabled: true,
      type: 'select',
      subscription_ids: [SUB_ID],
      subscription_tags: [],
      operators: [],
    });
    // rebind the default profile to the collection
    bucket(REDIS_KEYS.profiles).set(PID, {
      id: PID,
      name: 'default',
      display_name: '默认配置',
      source: { type: 'collection', id: COL_ID },
      kind: 'normal',
      updated_at: 0,
    });
    const exportSvc = await import('@/lib/services/nodeExportService');
    (
      exportSvc.mergeCollectionMemberProxies as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      merged: [
        {
          name: '🇭🇰 香港 01',
          type: 'ss',
          server: 'hk.invalid',
          port: 443,
          cipher: 'aes-128-gcm',
          password: 'x',
        },
        {
          name: '🇺🇸 美国 2x',
          type: 'ss',
          server: 'us.invalid',
          port: 443,
          cipher: 'aes-128-gcm',
          password: 'x',
        },
      ],
      memberErrors: [],
    });
    scalars.set(REDIS_KEYS.assistantConfig, { apiKey: 'k' });
    const res = await POST(request({ ref: refOf('collection', COL_ID) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { payload: { nodeCount: number } } };
    expect(body.data.payload.nodeCount).toBe(2);
  });

  it('pass-8 blocker 5: authorization happens BEFORE the assistant-config read — an unauthorized ref fails the bounded scope error even with NO config', async () => {
    // NO assistant config seeded — the config 404 must never preempt the
    // scope gate
    scalars.delete(REDIS_KEYS.assistantConfig);
    // a ref minted under a DIFFERENT (absent) profile
    const foreign = buildTargetRefScope('99999999-9999-4999-8999-999999999999', [
      { type: 'subscription', id: SUB_ID },
    ]).project(`subscription:${SUB_ID}`);
    const res = await POST(request({ ref: foreign }));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('AI 助手尚未配置');
    expect(text).toContain('来源范围');
  });

  it('pass-9 blocker 5: a target deleted after authorization collapses to the bounded scope error for BOTH kinds — no raw UUID', async () => {
    const COL_ID = '22222222-2222-4222-8222-222222222222';
    bucket(REDIS_KEYS.collections).set(COL_ID, {
      id: COL_ID,
      name: '聚合池',
      slug: 'pool',
      enabled: true,
      type: 'select',
      subscription_ids: [SUB_ID],
      subscription_tags: [],
      operators: [],
    });
    scalars.set(REDIS_KEYS.assistantConfig, { apiKey: 'k' });
    const fetchMock2 = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock2);

    const originalHget = fakeRedis.hget;
    // SUBSCRIPTION kind: delete the sub between the visible-set resolution
    // and the second read
    let subReads = 0;
    fakeRedis.hget = async (key: string, id: string) => {
      if (key === REDIS_KEYS.subscriptions && id === SUB_ID) {
        subReads++;
        if (subReads === 2) bucket(key).delete(id);
      }
      return originalHget(key, id);
    };
    try {
      const subRes = await POST(request({ ref: SUB_REF() }));
      expect(subRes.status).toBe(404);
      const subText = await subRes.text();
      expect(subText).toContain('来源范围');
      expect(subText).not.toContain(SUB_ID);
    } finally {
      fakeRedis.hget = originalHget;
    }

    // COLLECTION kind: the bound collection deleted after authorization
    bucket(REDIS_KEYS.profiles).set(PID, {
      id: PID,
      name: 'default',
      display_name: '默认配置',
      source: { type: 'collection', id: COL_ID },
      kind: 'normal',
      updated_at: 0,
    });
    bucket(REDIS_KEYS.collections).delete(COL_ID);
    const colRes = await POST(request({ ref: refOf('collection', COL_ID) }));
    expect(colRes.status).toBe(404);
    const colText = await colRes.text();
    expect(colText).toContain('来源范围');
    expect(colText).not.toContain(COL_ID);
  });

  it('round-6: the shared strict { ref } schema rejects the obsolete raw { type, id } request and every extra key', async () => {
    // the UI must send exactly { ref } — the route fails closed on the old
    // raw-id contract and on any extra key
    for (const body of [
      { type: 'subscription', id: SUB_ID },
      { ref: SUB_REF(), type: 'subscription', id: SUB_ID },
      { ref: SUB_REF(), type: 'subscription' },
      {},
      { ref: 'raw-uuid' },
    ]) {
      const res = await POST(request(body));
      expect(res.status, JSON.stringify(body)).toBe(422);
      const text = await res.text();
      expect(text).not.toContain(SUB_ID);
      expect(text).not.toContain('my-sub');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
