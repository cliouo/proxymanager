import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Collection, Subscription } from '@/schemas';

/**
 * 节点导出服务(分发链接的产物)语义测试:与渲染管线一致的
 * first-writer-wins 去重、聚合成员展开(只取启用)、聚合级 operators
 * 在去重之前作用于成员并集、个别成员失败跳过 / 全员失败抛错。
 * fetch 层 mock 掉,只测合成逻辑。
 */

vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxies: vi.fn(),
}));

import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import { exportCollectionNodes, exportSubscriptionNodes } from '@/lib/services/nodeExportService';

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
    slug: 'agg-1',
    enabled: true,
    type: 'select',
    subscription_ids: [],
    subscription_tags: [],
    operators: [],
    ...over,
  };
}

function proxiesOf(yaml: string): { name: string }[] {
  return (parse(yaml) as { proxies: { name: string }[] }).proxies;
}

describe('exportSubscriptionNodes', () => {
  it('按名去重 first-writer-wins', async () => {
    fetchMock.mockResolvedValueOnce({
      proxies: [
        { name: 'HK-01', type: 'vmess', server: 'a' },
        { name: 'HK-01', type: 'vmess', server: 'dup' },
        { name: 'JP-02', type: 'trojan', server: 'b' },
      ],
      proxyCount: 3,
    });
    const result = await exportSubscriptionNodes(makeSub());
    const proxies = proxiesOf(result.yaml);
    // 节点保留原始名(node_prefix 已移除,不再加前缀)。
    expect(proxies.map((p) => p.name)).toEqual(['HK-01', 'JP-02']);
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
    const a = makeSub({ name: 'a' });
    const b = makeSub({ name: 'b', tags: ['pool'] });
    const off = makeSub({ name: 'off', enabled: false, tags: ['pool'] });
    const col = makeCollection({ subscription_ids: [a.id], subscription_tags: ['pool'] });

    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) {
        return { proxies: [{ name: 'HK-A', type: 'vmess', server: 'a-first' }], proxyCount: 1 };
      }
      // b 自带一个与 a 跨源重名的 HK-A(应被先写者 a 顶掉),外加自身节点 HK-B
      return {
        proxies: [
          { name: 'HK-A', type: 'ss', server: 'b-dup' },
          { name: 'HK-B', type: 'ss', server: 'b-first' },
        ],
        proxyCount: 2,
      };
    });

    const result = await exportCollectionNodes(col, [a, b, off]);
    const proxies = proxiesOf(result.yaml);
    const names = proxies.map((p) => p.name);
    // 原始名(无前缀)按成员序合并;跨源重名 HK-A first-writer-wins 保留 a 的。
    expect(names).toEqual(['HK-A', 'HK-B']);
    expect((proxies[0] as { server?: string }).server).toBe('a-first');
    expect(result.proxyCount).toBe(2);
    expect(result.memberErrors).toEqual([]);
    // 停用成员不被 fetch
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: off.id }),
      expect.anything(),
    );
  });

  it('对合并后的成员并集应用 collection.operators(去重之前)', async () => {
    const a = makeSub({ name: 'a' });
    const b = makeSub({ name: 'b' });
    const col = makeCollection({
      subscription_ids: [a.id, b.id],
      operators: [
        // 丢弃所有 US-* 节点
        { kind: 'filter-regex', id: 'op-drop-us', mode: 'drop', pattern: '^US-' },
        // 把 HK- 重命名为 香港-
        { kind: 'rename-regex', id: 'op-rename', pattern: '^HK-', replacement: '香港-' },
      ],
    });

    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) {
        return {
          proxies: [
            { name: 'HK-1', type: 'vmess' },
            { name: 'US-1', type: 'vmess' },
          ],
          proxyCount: 2,
        };
      }
      return { proxies: [{ name: 'US-2', type: 'ss' }], proxyCount: 1 };
    });

    const result = await exportCollectionNodes(col, [a, b]);
    const names = proxiesOf(result.yaml).map((p) => p.name);
    // US-1 / US-2 被丢弃,HK-1 被重命名为 香港-1。
    expect(names).toEqual(['香港-1']);
    expect(result.proxyCount).toBe(1);
    expect(result.yaml).not.toContain('US-');
  });

  it('rename 把不同源节点撞成同名时,operators 先跑、再 first-writer-wins 去重', async () => {
    const a = makeSub({ name: 'a' });
    const b = makeSub({ name: 'b' });
    const col = makeCollection({
      subscription_ids: [a.id, b.id],
      // 抹掉名字里的源后缀,a 的 NODE-a 与 b 的 NODE-b 都变成 NODE。
      operators: [{ kind: 'rename-regex', id: 'op-strip', pattern: '-[ab]$', replacement: '' }],
    });

    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) {
        return { proxies: [{ name: 'NODE-a', type: 'vmess', server: 'from-a' }], proxyCount: 1 };
      }
      return { proxies: [{ name: 'NODE-b', type: 'ss', server: 'from-b' }], proxyCount: 1 };
    });

    const result = await exportCollectionNodes(col, [a, b]);
    const proxies = proxiesOf(result.yaml);
    // operators 先重命名(两者都成 NODE),再去重 → 只剩第一条(来自 a)。
    expect(proxies.map((p) => p.name)).toEqual(['NODE']);
    expect((proxies[0] as { server?: string }).server).toBe('from-a');
    expect(result.proxyCount).toBe(1);
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
