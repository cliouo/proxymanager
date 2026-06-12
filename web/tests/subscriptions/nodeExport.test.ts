import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Collection, Subscription } from '@/schemas';

/**
 * 节点导出服务(分发链接的产物)语义测试:与渲染管线一致的
 * node_prefix 前缀、first-writer-wins 去重、聚合成员展开(只取启用)、
 * 个别成员失败跳过 / 全员失败抛错。fetch 层 mock 掉,只测合成逻辑。
 */

vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxies: vi.fn(),
}));

import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import {
  exportCollectionNodes,
  exportSubscriptionNodes,
} from '@/lib/services/nodeExportService';

const fetchMock = resolveSubscriptionProxies as unknown as ReturnType<typeof vi.fn>;

function makeSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: over.id ?? crypto.randomUUID(),
    name: 'sub-a',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
    ...over,
  };
}

function makeCollection(over: Partial<Collection> = {}): Collection {
  return {
    id: over.id ?? crypto.randomUUID(),
    name: '聚合一号',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    ...over,
  };
}

function proxiesOf(yaml: string): { name: string }[] {
  return (parse(yaml) as { proxies: { name: string }[] }).proxies;
}

describe('exportSubscriptionNodes', () => {
  it('应用 node_prefix 并按名去重(first-writer-wins)', async () => {
    fetchMock.mockResolvedValueOnce({
      proxies: [
        { name: 'HK-01', type: 'vmess', server: 'a' },
        { name: 'HK-01', type: 'vmess', server: 'dup' },
        { name: 'JP-02', type: 'trojan', server: 'b' },
      ],
      proxyCount: 3,
    });
    const result = await exportSubscriptionNodes(makeSub({ node_prefix: '[A] ' }));
    const proxies = proxiesOf(result.yaml);
    expect(proxies.map((p) => p.name)).toEqual(['[A] HK-01', '[A] JP-02']);
    // first-writer-wins:保留的是第一条 HK-01
    expect((proxies[0] as { server?: string }).server).toBe('a');
    expect(result.proxyCount).toBe(2);
    expect(result.stale).toBe(false);
  });

  it('透传 traffic 与 stale', async () => {
    const traffic = { upload: 1, download: 2, total: 3, expire: 4 };
    fetchMock.mockResolvedValueOnce({
      proxies: [{ name: 'N', type: 'ss' }],
      proxyCount: 1,
      traffic,
      stale: true,
      staleReason: 'HTTP 502',
    });
    const result = await exportSubscriptionNodes(makeSub());
    expect(result.traffic).toEqual(traffic);
    expect(result.stale).toBe(true);
  });
});

describe('exportCollectionNodes', () => {
  it('成员展开(直接指定+标签,只取启用)、按成员序合并去重', async () => {
    const a = makeSub({ name: 'a', node_prefix: '[A] ' });
    const b = makeSub({ name: 'b', tags: ['pool'] });
    const off = makeSub({ name: 'off', enabled: false, tags: ['pool'] });
    const col = makeCollection({ subscription_ids: [a.id], subscription_tags: ['pool'] });

    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) {
        return { proxies: [{ name: 'HK', type: 'vmess' }], proxyCount: 1 };
      }
      // b 与 a 前缀后不同名,但自带一个与自己重复的名字
      return {
        proxies: [
          { name: 'HK', type: 'ss', server: 'b-first' },
          { name: 'HK', type: 'ss', server: 'b-dup' },
        ],
        proxyCount: 2,
      };
    });

    const result = await exportCollectionNodes(col, [a, b, off]);
    const names = proxiesOf(result.yaml).map((p) => p.name);
    expect(names).toEqual(['[A] HK', 'HK']);
    expect(result.proxyCount).toBe(2);
    expect(result.memberErrors).toEqual([]);
    // 停用成员不被 fetch
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: off.id }),
      expect.anything(),
    );
  });

  it('个别成员失败跳过并记入 memberErrors;全员失败抛 400', async () => {
    const a = makeSub({ name: 'a' });
    const b = makeSub({ name: 'b' });
    const col = makeCollection({ subscription_ids: [a.id, b.id] });

    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) throw new Error('Upstream returned HTTP 502');
      return { proxies: [{ name: 'OK', type: 'ss' }], proxyCount: 1 };
    });
    const partial = await exportCollectionNodes(col, [a, b]);
    expect(partial.memberErrors).toEqual([{ name: 'a', error: 'Upstream returned HTTP 502' }]);
    expect(partial.proxyCount).toBe(1);

    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(exportCollectionNodes(col, [a, b])).rejects.toMatchObject({
      problem: { status: 400 },
    });
  });

  it('没有启用中的成员时抛 422', async () => {
    const off = makeSub({ name: 'off', enabled: false });
    const col = makeCollection({ subscription_ids: [off.id] });
    await expect(exportCollectionNodes(col, [off])).rejects.toMatchObject({
      problem: { status: 422 },
    });
  });
});
