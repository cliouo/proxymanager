import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@/schemas';

/**
 * 订阅 fetch 并行化后的确定性契约测试:无论各订阅的 HTTP 谁先返回,
 * candidates 累积顺序、去重 first-writer-wins、subStatuses 顺序、以及
 * ignoreFailedSubs:false 的"抛原顺序第一个失败"都必须与旧串行版一致。
 * 这里通过让靠后的订阅先 resolve 来制造最坏的完成顺序。
 */

vi.mock('@/lib/repos/resolvedRepo', () => ({
  setResolvedSnapshot: vi.fn(async () => undefined),
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
}));

vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxies: vi.fn(),
}));

import { resolveConfig } from '@/lib/engine/resolve';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';

const resolveSubMock = resolveSubscriptionProxies as unknown as ReturnType<typeof vi.fn>;

const BASE = `mixed-port: 7890
proxies:
  - name: 直连
    type: direct
proxy-groups:
  - name: 默认
    type: select
    proxies: [直连]
rules:
  # === ANCHOR: manual ===
  - MATCH,默认
`;

function makeSub(over: Partial<Subscription>): Subscription {
  return {
    id: crypto.randomUUID(),
    name: 'a',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 600_000,
    tags: [],
    operators: [],
    ...over,
  } as Subscription;
}

function proxiesOf(
  items: Array<{ name: string; server?: string }>,
): Record<string, unknown>[] {
  return items.map((i) => ({
    name: i.name,
    type: 'ss',
    server: i.server ?? 'h.example',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'p',
  }));
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  resolveSubMock.mockReset();
});

describe('resolveConfig — parallel fetch keeps serial ordering semantics', () => {
  it('keeps candidate/subStatuses order by subscription array even when later subs resolve first', async () => {
    const subA = makeSub({ name: 'air-a' });
    const subB = makeSub({ name: 'air-b' });
    const subC = makeSub({ name: 'air-c' });

    // a 最慢、c 最快 — 完成顺序 c → b → a,与订阅顺序完全相反。
    resolveSubMock.mockImplementation(async (sub: Subscription) => {
      if (sub.name === 'air-a') {
        await delay(40);
        return { proxies: proxiesOf([{ name: 'HK-01', server: 'a.example' }]), proxyCount: 1 };
      }
      if (sub.name === 'air-b') {
        await delay(15);
        return {
          proxies: proxiesOf([{ name: 'HK-01', server: 'b.example' }, { name: 'JP-01' }]),
          proxyCount: 2,
        };
      }
      return { proxies: proxiesOf([{ name: 'US-01' }]), proxyCount: 1, stale: true, staleReason: 'x' };
    });

    const result = await resolveConfig(BASE, [], [subA, subB, subC], [], [], {
      persistSnapshot: false,
    });

    // subStatuses 按订阅序,而不是完成序。
    expect(result.subscriptions.map((s) => s.name)).toEqual(['air-a', 'air-b', 'air-c']);
    // 去重 first-writer-wins 按订阅序:HK-01 归 air-a,air-b 的同名被丢弃。
    expect(result.collisions).toEqual([
      { name: 'HK-01', keptFrom: 'air-a', droppedFrom: ['air-b'] },
    ]);
    expect(result.content).toContain('a.example');
    expect(result.content).not.toContain('b.example');
    // nodeNames 累积顺序 = base + 按订阅序的存活节点。
    expect(result.nodeNames).toEqual(['直连', 'HK-01', 'JP-01', 'US-01']);
    expect(result.subscriptions.map((s) => [s.name, s.injectedCount])).toEqual([
      ['air-a', 1],
      ['air-b', 1],
      ['air-c', 1],
    ]);
    // stale 标记跟着正确的订阅走。
    expect(result.subscriptions[2].stale).toBe(true);
  });

  it('ignoreFailedSubs:false throws the first failure in subscription order, not completion order', async () => {
    const subA = makeSub({ name: 'air-a' });
    const subB = makeSub({ name: 'air-b' });
    const subC = makeSub({ name: 'air-c' });

    // b 先失败(立即 reject),a 后失败(慢)——但抛出的必须是 a 的错误。
    resolveSubMock.mockImplementation(async (sub: Subscription) => {
      if (sub.name === 'air-a') {
        await delay(30);
        throw new Error('first-in-order failure');
      }
      if (sub.name === 'air-b') {
        throw new Error('first-to-complete failure');
      }
      return { proxies: proxiesOf([{ name: 'US-01' }]), proxyCount: 1 };
    });

    await expect(
      resolveConfig(BASE, [], [subA, subB, subC], [], [], {
        persistSnapshot: false,
        ignoreFailedSubs: false,
      }),
    ).rejects.toThrow('first-in-order failure');
  });

  it('default ignoreFailures records errors per-sub in subscription order and continues', async () => {
    const subA = makeSub({ name: 'air-a' });
    const subB = makeSub({ name: 'air-b' });

    resolveSubMock.mockImplementation(async (sub: Subscription) => {
      if (sub.name === 'air-a') {
        await delay(20);
        throw new Error('upstream 502');
      }
      return { proxies: proxiesOf([{ name: 'US-01' }]), proxyCount: 1 };
    });

    const result = await resolveConfig(BASE, [], [subA, subB], [], [], {
      persistSnapshot: false,
    });
    expect(result.subscriptions.map((s) => s.name)).toEqual(['air-a', 'air-b']);
    expect(result.subscriptions[0].error).toContain('upstream 502');
    expect(result.nodeNames).toEqual(['直连', 'US-01']);
  });

  it('caps in-flight fetches at 8 and still fetches every eligible sub exactly once', async () => {
    const subs = Array.from({ length: 20 }, (_, i) =>
      makeSub({ name: `sub-${String(i).padStart(2, '0')}` }),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    resolveSubMock.mockImplementation(async (sub: Subscription) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight -= 1;
      return { proxies: proxiesOf([{ name: `N-${sub.name}` }]), proxyCount: 1 };
    });

    const result = await resolveConfig(BASE, [], subs, [], [], { persistSnapshot: false });

    expect(resolveSubMock).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBeGreaterThan(1); // 真的并行了
    expect(maxInFlight).toBeLessThanOrEqual(8); // 但不超过并发上限
    // 节点顺序仍按订阅序。
    expect(result.nodeNames.slice(1)).toEqual(subs.map((s) => `N-${s.name}`));
  });

  it('disabled / filtered-out subs are never fetched (filtering happens before the pool)', async () => {
    const on = makeSub({ name: 'on' });
    const off = makeSub({ name: 'off', enabled: false });
    resolveSubMock.mockResolvedValueOnce({
      proxies: proxiesOf([{ name: 'HK-01' }]),
      proxyCount: 1,
    });

    const result = await resolveConfig(BASE, [], [on, off], [], [], { persistSnapshot: false });
    expect(resolveSubMock).toHaveBeenCalledTimes(1);
    expect(resolveSubMock.mock.calls[0][0].name).toBe('on');
    expect(result.subscriptions.map((s) => s.name)).toEqual(['on']);
  });
});
