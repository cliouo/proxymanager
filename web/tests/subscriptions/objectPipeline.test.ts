import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Operator, Subscription } from '@/schemas';

/**
 * 对象级管线(resolveSubscriptionProxies)与字符串管线
 * (resolveSubscriptionContent/Raw)的等价性测试:同一输入、同一 operators,
 * 两条路径产出的 proxies 必须逐项相等。对象级入口是为了砍掉渲染链路里
 * 重复的 parse/stringify,等价性是它存在的前提。
 */

vi.mock('@/lib/repos/fetchCacheRepo', () => ({
  buildCacheKey: vi.fn(() => 'fixed-cache-key'),
  getFetchCache: vi.fn(),
  setFetchCache: vi.fn(async () => undefined),
}));

import {
  resolveSubscriptionContent,
  resolveSubscriptionContentRaw,
  resolveSubscriptionProxies,
  resolveSubscriptionProxiesRaw,
} from '@/lib/services/subscriptionFetcher';
import { getFetchCache, setFetchCache } from '@/lib/repos/fetchCacheRepo';

const getCacheMock = getFetchCache as unknown as ReturnType<typeof vi.fn>;
const setCacheMock = setFetchCache as unknown as ReturnType<typeof vi.fn>;

const LOCAL_CONTENT = `mixed-port: 7890
proxies:
  - name: 香港 HK-01
    type: vmess
    server: hk.example.com
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
    cipher: auto
  - name: 日本 JP-02
    type: trojan
    server: jp.example.com
    port: 443
    password: secret
  - name: 剩余流量：10GB
    type: ss
    server: info.example.com
    port: 1
    cipher: aes-128-gcm
    password: p
rules:
  - MATCH,DIRECT
`;

/** 覆盖 filter / rename / set-prop 三类 operator,确保管线真的跑了。 */
const OPERATORS: Operator[] = [
  { id: 'op-1', kind: 'filter-useless', extra: [] },
  { id: 'op-2', kind: 'rename-regex', pattern: '香港 ', replacement: '', flags: 'g' },
  { id: 'op-3', kind: 'set-prop', udp: true },
];

function makeSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 'id',
    name: 'air',
    enabled: true,
    kind: 'local',
    content: LOCAL_CONTENT,
    ttl_ms: 1000,
    tags: [],
    operators: [],
    ...over,
  } as Subscription;
}

function parseProxies(yaml: string): Record<string, unknown>[] {
  const doc = parse(yaml) as { proxies?: unknown };
  return (doc.proxies ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
  getCacheMock.mockReset();
  setCacheMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('object pipeline ≡ string pipeline', () => {
  it('local sub without operators: proxies equal parse(contentRaw.yaml).proxies', async () => {
    const sub = makeSub();
    const obj = await resolveSubscriptionProxies(sub);
    const str = await resolveSubscriptionContentRaw(sub);

    expect(obj.proxies).toEqual(parseProxies(str.yaml));
    expect(obj.proxies).toHaveLength(3);
    expect(obj.proxyCount).toBe(3);
  });

  it('local sub with operators: both pipelines produce identical processed proxies', async () => {
    const sub = makeSub({ operators: OPERATORS });
    const obj = await resolveSubscriptionProxies(sub);
    const str = await resolveSubscriptionContent(sub);

    const fromYaml = parseProxies(str.yaml);
    expect(obj.proxies).toEqual(fromYaml);
    expect(obj.proxyCount).toBe(str.proxyCount);
    // 管线真实生效:info 节点被滤掉、前缀被删、udp 被设上。
    expect(obj.proxies.map((p) => p.name)).toEqual(['HK-01', '日本 JP-02']);
    expect(obj.proxies.every((p) => p.udp === true)).toBe(true);
  });

  it('remote sub on cache hit: object path parses the cached YAML to the same proxies', async () => {
    const cachedYaml =
      'proxies:\n  - { name: HK-01, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n  - { name: US-02, type: ss, server: u, port: 2, cipher: aes-128-gcm, password: p }\n';
    // 两次 resolve 各读一次缓存(fresh 命中,不触发 fetch)。
    getCacheMock.mockResolvedValue({
      content: cachedYaml,
      proxy_count: 2,
      fetched_at: Date.now(),
      traffic: { upload: 1, download: 2, total: 3, expire: 4 },
    });

    const sub = makeSub({ kind: 'remote', content: undefined, url: 'https://up.example/sub' });
    const obj = await resolveSubscriptionProxies(sub);
    const str = await resolveSubscriptionContent(sub);

    expect(obj.proxies).toEqual(parseProxies(str.yaml));
    expect(str.yaml).toBe(cachedYaml); // 字符串路径仍原样返回缓存条目
    expect(obj.traffic).toEqual({ upload: 1, download: 2, total: 3, expire: 4 });
  });

  it('remote sub stale-on-error: object path carries the same stale flag + proxies', async () => {
    const cachedYaml =
      'proxies:\n  - { name: HK-01, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n';
    getCacheMock.mockResolvedValue({
      content: cachedYaml,
      proxy_count: 1,
      fetched_at: 0, // 远超 ttl_ms → 触发重新 fetch
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const sub = makeSub({ kind: 'remote', content: undefined, url: 'https://up.example/sub' });
      const obj = await resolveSubscriptionProxies(sub);
      expect(obj.stale).toBe(true);
      expect(obj.staleReason).toContain('ECONNREFUSED');
      expect(obj.proxies.map((p) => p.name)).toEqual(['HK-01']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fresh remote fetch still writes the YAML-string cache entry (entry format unchanged)', async () => {
    getCacheMock.mockResolvedValueOnce(null);
    const upstream =
      'proxies:\n  - { name: FRESH, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n';
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(upstream, { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const sub = makeSub({ kind: 'remote', content: undefined, url: 'https://up.example/sub' });
      const obj = await resolveSubscriptionProxies(sub);
      expect(obj.proxies.map((p) => p.name)).toEqual(['FRESH']);

      expect(setCacheMock).toHaveBeenCalledTimes(1);
      const [, entry] = setCacheMock.mock.calls[0];
      // 缓存条目仍是 provider-YAML 字符串,能被再 parse 回同一份 proxies。
      expect(typeof entry.content).toBe('string');
      expect(parseProxies(entry.content)).toEqual(obj.proxies);
      expect(entry.proxy_count).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('raw object path ≡ raw string path: same proxies, operators NOT applied (preview endpoint contract)', async () => {
    // operators 设上但 raw 路径必须无视 —— 预览端点拿原始 proxies 自己跑未保存管线。
    const sub = makeSub({ operators: OPERATORS });
    const obj = await resolveSubscriptionProxiesRaw(sub);
    const str = await resolveSubscriptionContentRaw(sub);

    // 等价性:对象路径 = parse(字符串路径)。这是 preview 路由砍掉那次 parse 的前提。
    expect(obj.proxies).toEqual(parseProxies(str.yaml));
    expect(obj.proxyCount).toBe(str.proxyCount);
    // operators 未生效:info 节点还在、前缀未删。
    expect(obj.proxies.map((p) => p.name)).toEqual(['香港 HK-01', '日本 JP-02', '剩余流量：10GB']);
  });

  it('raw object path on cache hit parses the cached YAML; stale fallback carries the same flags', async () => {
    const cachedYaml =
      'proxies:\n  - { name: HK-01, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n';
    getCacheMock.mockResolvedValue({
      content: cachedYaml,
      proxy_count: 1,
      fetched_at: Date.now(),
      traffic: { upload: 1, download: 2, total: 3, expire: 4 },
    });
    const sub = makeSub({
      kind: 'remote',
      content: undefined,
      url: 'https://up.example/sub',
      operators: OPERATORS,
    });
    const obj = await resolveSubscriptionProxiesRaw(sub);
    expect(obj.proxies).toEqual(parseProxies(cachedYaml));
    expect(obj.proxyCount).toBe(1);
    expect(obj.traffic).toEqual({ upload: 1, download: 2, total: 3, expire: 4 });

    // stale-on-error:缓存过期 + fetch 失败 → 同样的 stale 标记与 proxies。
    getCacheMock.mockResolvedValue({ content: cachedYaml, proxy_count: 1, fetched_at: 0 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const stale = await resolveSubscriptionProxiesRaw(sub);
      expect(stale.stale).toBe(true);
      expect(stale.staleReason).toContain('ECONNREFUSED');
      expect(stale.proxies).toEqual(parseProxies(cachedYaml));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('non-object entries in the proxies array are dropped by the object path (same guard as the old extractProxies)', async () => {
    const sub = makeSub({
      content: 'proxies:\n  - { name: OK, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n  - 不是对象\n  - null\n',
    });
    const obj = await resolveSubscriptionProxies(sub);
    expect(obj.proxies.map((p) => p.name)).toEqual(['OK']);
    expect(obj.proxyCount).toBe(1);
    // 字符串路径保留原始条目(行为不变),proxyCount 仍按原始数组计数。
    const str = await resolveSubscriptionContentRaw(sub);
    expect(str.proxyCount).toBe(3);
    expect(str.yaml).toContain('不是对象');
  });
});
