import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
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

// The export path resolves persisted stable-numbering assignments; the
// assignment store is orthogonal to export semantics, so these tests stub it
// empty (input-order ordinals, no Redis dependency).
vi.mock('@/lib/repos/nodeOrdinalRepo', () => ({
  loadOrdinalAssignments: async () => new Map(),
  assignOrdinals: async () => new Map(),
  clearOrdinalAssignments: async () => undefined,
}));

import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import { exportCollectionNodes, exportSubscriptionNodes } from '@/lib/services/nodeExportService';
import { SubscriptionResolutionValidationError } from '@/lib/services/subscriptionResolutionErrors';

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

function proxy(name: string, server = 'edge.invalid'): Record<string, unknown> {
  return { name, type: 'socks5', server, port: 1080 };
}

describe('exportSubscriptionNodes', () => {
  it('按名去重 first-writer-wins', async () => {
    fetchMock.mockResolvedValueOnce({
      proxies: [proxy('HK-01', 'a'), proxy('HK-01', 'dup'), proxy('JP-02', 'b')],
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
      proxies: [proxy('N')],
      proxyCount: 1,
      traffic,
      stale: true,
      staleReason: 'HTTP 502',
    });
    const result = await exportSubscriptionNodes(makeSub());
    expect(result.traffic).toEqual(traffic);
    expect(result.stale).toBe(true);
  });

  it('rejects invalid mocked resolver output at the public export boundary', async () => {
    fetchMock.mockResolvedValueOnce({
      proxies: [{ name: '', type: 'socks5', server: 'edge.invalid', port: 1080 }],
      proxyCount: 1,
    });

    await expect(exportSubscriptionNodes(makeSub())).rejects.toThrow(/field "name"/i);
  });

  it('does not hide a non-string name during first-writer-wins deduplication', async () => {
    fetchMock.mockResolvedValueOnce({
      proxies: [{ name: 42, type: 'socks5', server: 'edge.invalid', port: 1080 }],
      proxyCount: 1,
    });

    await expect(exportSubscriptionNodes(makeSub())).rejects.toThrow(/field "name"/i);
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
        return { proxies: [proxy('HK-A', 'a-first')], proxyCount: 1 };
      }
      // b 自带一个与 a 跨源重名的 HK-A(应被先写者 a 顶掉),外加自身节点 HK-B
      return {
        proxies: [proxy('HK-A', 'b-dup'), proxy('HK-B', 'b-first')],
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

  it('MEMBER-managed status propagates (finding 5): a member with an active rename-template makes same-name distinct-identity nodes survive with a suffix — not first-writer-wins', async () => {
    const managedMember = makeSub({
      name: 'managed-member',
      operators: [
        {
          id: 'rt-m',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    const plainMember = makeSub({ name: 'plain-member' });
    // the collection itself has NO rename-template — the member's managed
    // status alone must trigger the managed-path disambiguation
    const col = makeCollection({ subscription_ids: [managedMember.id, plainMember.id] });

    fetchMock.mockImplementation(async (sub: Subscription) => {
      // same display name, DIFFERENT configs (distinct identities)
      return sub.id === managedMember.id
        ? { proxies: [proxy('香港 中转', 'm-a')], proxyCount: 1 }
        : { proxies: [proxy('香港 中转', 'p-b')], proxyCount: 1 };
    });

    const result = await exportCollectionNodes(col, [managedMember, plainMember]);
    const names = proxiesOf(result.yaml).map((p) => p.name);
    // BOTH survive — the later one deterministically suffixed (managed path)
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('香港 中转');
    // the LATER node (plain-member, input order) is suffixed with ITS label
    expect(names[1]).toBe('香港 中转 · plain-member');
    expect(result.resolvedNames).toEqual([{ from: '香港 中转', to: '香港 中转 · plain-member' }]);
    // source priority: the first member in input order keeps the plain name
    expect((proxiesOf(result.yaml)[0] as { server?: string }).server).toBe('m-a');
  });

  it('EXACT pass-3 repro [fp1/N, fp2/N, fp2/M]: the suffix-renamed keeper registers its fingerprint — fp2/M is deduped', async () => {
    const { withRawIdentity } = await import('@/lib/proxies/naming');
    // member-a is MANAGED (its own rename op) with fp1/N; member-b is plain
    // with fp2/N + fp2/M — the collection itself has NO operators, so the
    // machine's managed path decides everything
    const a = makeSub({
      name: 'a',
      operators: [
        {
          id: 'rt-a',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    const b = makeSub({ name: 'b' });
    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) {
        return {
          proxies: [
            withRawIdentity(
              {
                name: 'N',
                type: 'ss',
                server: 'fp1.example',
                port: 443,
                cipher: 'aes-128-gcm',
                password: 'p',
              },
              { key: 'a', label: 'A' },
            ),
          ],
          proxyCount: 1,
        };
      }
      return {
        proxies: [
          withRawIdentity(
            {
              name: 'N',
              type: 'ss',
              server: 'fp2.example',
              port: 443,
              cipher: 'aes-128-gcm',
              password: 'p',
            },
            { key: 'b', label: 'B' },
          ),
          withRawIdentity(
            {
              name: 'M',
              type: 'ss',
              server: 'fp2.example',
              port: 443,
              cipher: 'aes-128-gcm',
              password: 'p',
            },
            { key: 'b', label: 'B' },
          ),
        ],
        proxyCount: 2,
      };
    });
    const col = makeCollection({ subscription_ids: [a.id, b.id] });
    const result = await exportCollectionNodes(col, [a, b]);
    const names = proxiesOf(result.yaml).map((p) => p.name);
    // fp2/N kept under its suffix AND fp2/M dropped (the same identity) —
    // only the first TWO identities survive
    expect(names).toEqual(['N', 'N · b']);
    expect(result.proxyCount).toBe(2);
  });

  it('an unrelated MANAGED third member can NOT change a plain/plain pair (per-node provenance)', async () => {
    const plainA = makeSub({ name: 'plain-a' });
    const plainB = makeSub({ name: 'plain-b' });
    const managedC = makeSub({
      name: 'managed-c',
      operators: [
        {
          id: 'rt-c',
          kind: 'rename-template',
          template: '${emoji} ${region}',
          recognitionRules: [],
        },
      ],
    });
    const col = makeCollection({ subscription_ids: [plainA.id, plainB.id, managedC.id] });
    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === plainA.id) return { proxies: [proxy('X', 'x-a')], proxyCount: 1 };
      if (sub.id === plainB.id) return { proxies: [proxy('N', 'n-b')], proxyCount: 1 };
      return { proxies: [proxy('Y', 'y-c')], proxyCount: 1 };
    });
    const result = await exportCollectionNodes(col, [plainA, plainB, managedC]);
    const names = proxiesOf(result.yaml).map((p) => p.name);
    // plain/plain pair: X and N both survive with NO suffix — the managed
    // third member's status does not promote them
    expect(names).toEqual(['X', 'N', 'Y']);
    expect(result.resolvedNames ?? []).toHaveLength(0);
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
          proxies: [proxy('HK-1'), proxy('US-1')],
          proxyCount: 2,
        };
      }
      return { proxies: [proxy('US-2')], proxyCount: 1 };
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
        return { proxies: [proxy('NODE-a', 'from-a')], proxyCount: 1 };
      }
      return { proxies: [proxy('NODE-b', 'from-b')], proxyCount: 1 };
    });

    const result = await exportCollectionNodes(col, [a, b]);
    const proxies = proxiesOf(result.yaml);
    // operators 先重命名(两者都成 NODE),再去重 → 只剩第一条(来自 a)。
    expect(proxies.map((p) => p.name)).toEqual(['NODE']);
    expect((proxies[0] as { server?: string }).server).toBe('from-a');
    expect(result.proxyCount).toBe(1);
  });

  it('rejects a collection operator result that empties a node name', async () => {
    const a = makeSub({ name: 'a' });
    const col = makeCollection({
      subscription_ids: [a.id],
      operators: [{ kind: 'rename-regex', id: 'empty-name', pattern: '.+', replacement: '' }],
    });
    fetchMock.mockResolvedValueOnce({ proxies: [proxy('NODE')], proxyCount: 1 });

    await expect(exportCollectionNodes(col, [a])).rejects.toThrow(/field "name"/i);
  });

  it('个别成员失败跳过且不在 memberErrors 中反射敏感详情;全员失败抛 400', async () => {
    const a = makeSub({ name: 'a' });
    const b = makeSub({ name: 'b' });
    const col = makeCollection({ subscription_ids: [a.id, b.id] });
    const secret = 'ss://aes-128-gcm:TOP-SECRET@example.invalid:443';

    fetchMock.mockImplementation(async (sub: Subscription) => {
      if (sub.id === a.id) {
        throw new SubscriptionResolutionValidationError('content', 'subscription_content_invalid', {
          type: 'https://proxymanager.dev/errors/bad-request',
          title: 'Bad Request',
          status: 400,
          detail: `Invalid provider node: ${secret}`,
        });
      }
      return { proxies: [proxy('OK')], proxyCount: 1 };
    });
    const partial = await exportCollectionNodes(col, [a, b]);
    expect(partial.memberErrors).toEqual([
      { name: 'a', error: 'Subscription content is invalid.' },
    ]);
    expect(JSON.stringify(partial.memberErrors)).not.toContain(secret);
    expect(partial.proxyCount).toBe(1);

    fetchMock.mockRejectedValue(new Error(`boom: ${secret}`));
    await expect(exportCollectionNodes(col, [a, b])).rejects.toMatchObject({
      problem: { status: 400, detail: expect.not.stringContaining(secret) },
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

/* ─── rename-template + provenance through the export paths ─────────── */

describe('collection export with rename-template (provenance semantics)', () => {
  it('attaches per-member alias + per-source numbering, no metadata leak in YAML', async () => {
    fetchMock.mockResolvedValueOnce({
      proxies: [proxy('香港 01', 'a.com'), proxy('香港 02', 'b.com')],
      proxyCount: 2,
    });
    fetchMock.mockResolvedValueOnce({
      proxies: [proxy('日本 01', 'c.com')],
      proxyCount: 1,
    });
    const collection = makeCollection({
      subscription_ids: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template:
            '${emoji} ${region}${?rate: · ${rate}}${?note: · ${note}}${?source: · ${source}}${?index: · ${index}}',
          recognitionRules: [],
        } as never,
      ],
    });
    const subs = [
      makeSub({ id: '11111111-1111-4111-8111-111111111111', name: 'sub-a', display_name: '机场A' }),
      makeSub({ id: '22222222-2222-4222-8222-222222222222', name: 'sub-b', display_name: '机场B' }),
    ];
    const result = await exportCollectionNodes(collection, subs);
    const proxies = proxiesOf(result.yaml);
    expect(proxies.map((p) => p.name)).toEqual([
      '🇭🇰 香港 · 机场A · 01',
      '🇭🇰 香港 · 机场A · 02',
      '🇯🇵 日本 · 机场B · 01',
    ]);
    // internal provenance must never reach the public provider YAML
    expect(result.yaml).not.toContain('collection-provenance');
    expect(result.yaml).not.toContain('proxy-source-alias');
  });

  it('manual sourceAliases override member display names in the export', async () => {
    fetchMock.mockResolvedValueOnce({ proxies: [proxy('香港 01')], proxyCount: 1 });
    const collection = makeCollection({
      subscription_ids: ['11111111-1111-4111-8111-111111111111'],
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template:
            '${emoji} ${region}${?rate: · ${rate}}${?note: · ${note}}${?source: · ${source}}${?index: · ${index}}',
          recognitionRules: [],
          sourceAliases: { 'sub-a': '改名机场' },
        } as never,
      ],
    });
    const subs = [
      makeSub({ id: '11111111-1111-4111-8111-111111111111', name: 'sub-a', display_name: '机场A' }),
    ];
    const result = await exportCollectionNodes(collection, subs);
    expect(proxiesOf(result.yaml).map((p) => p.name)).toEqual(['🇭🇰 香港 · 改名机场 · 01']);
  });

  it('single-sub export reads the sub alias when requested', async () => {
    // Mirror the real fetcher: the sub's own pipeline (with provenance) runs
    // inside resolveSubscriptionProxies before the export sees the nodes.
    fetchMock.mockImplementationOnce(async (sub: Subscription) => {
      const withSource = (await import('@/lib/proxies/provenance')).withSource;
      const proxies = applyOperators(
        [withSource(proxy('香港 01'), { key: sub.name, label: sub.display_name || sub.name })],
        sub.operators as never,
      ).proxies as ClashProxy[];
      return { proxies, proxyCount: proxies.length };
    });
    const sub = makeSub({
      name: 'sub-a',
      display_name: '机场A',
      operators: [
        {
          id: 'rt-1',
          kind: 'rename-template',
          template:
            '${emoji} ${region}${?rate: · ${rate}}${?note: · ${note}}${?source: · ${source}}${?index: · ${index}}',
          recognitionRules: [],
        } as never,
      ],
    });
    const result = await exportSubscriptionNodes(sub);
    expect(proxiesOf(result.yaml).map((p) => p.name)).toEqual(['🇭🇰 香港 · 机场A · 01']);
  });

  it('preview-style callers can disable fetch-cache writes', async () => {
    fetchMock.mockResolvedValueOnce({ proxies: [proxy('香港 01')], proxyCount: 1 });
    await exportCollectionNodes(
      makeCollection({
        operators: [],
        subscription_ids: ['11111111-1111-4111-8111-111111111111'],
      }),
      [makeSub({ id: '11111111-1111-4111-8111-111111111111' })],
      { writeCache: false },
    );
    const call = fetchMock.mock.calls.at(-1) as [Subscription, { writeCache?: boolean }];
    expect(call[1]).toMatchObject({ writeCache: false });
  });

  it('raw identities that CONVERGE after set-prop both survive the collection export', async () => {
    // Member A node carries udp:false; member B node has NO udp field — RAW
    // configs differ (same endpoint). The collection pipeline's set-prop makes
    // them identical post-transform; the immutable raw fingerprint (attached
    // by the fetcher contract, simulated here with withRawIdentity) must keep
    // BOTH in the export — never a post-transform or name-based drop.
    const { withRawIdentity } = await import('@/lib/proxies/naming');
    fetchMock.mockImplementation(async (sub: Subscription) => ({
      proxies: [
        withRawIdentity(
          // Member A carries udp:false; member B has NO udp field — RAW
          // configs differ on the same endpoint.
          {
            name: '香港 01',
            type: 'socks5',
            server: 'same.example',
            port: 1080,
            ...(sub.name === 'sub-a' ? { udp: false } : {}),
          },
          { key: sub.name, label: sub.display_name || sub.name },
        ),
      ],
      proxyCount: 1,
    }));
    const collection = makeCollection({
      subscription_ids: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      operators: [
        { id: 'sp', kind: 'set-prop', udp: true },
        {
          id: 'rt-1',
          kind: 'rename-template',
          template: '${emoji} ${region}${?source: · ${source}}${?index: · ${index}}',
          recognitionRules: [],
        } as never,
      ],
    });
    const subs = [
      makeSub({ id: '11111111-1111-4111-8111-111111111111', name: 'sub-a', display_name: '机场A' }),
      makeSub({ id: '22222222-2222-4222-8222-222222222222', name: 'sub-b', display_name: '机场B' }),
    ];
    const result = await exportCollectionNodes(collection, subs);
    expect(proxiesOf(result.yaml).map((p) => p.name)).toEqual([
      '🇭🇰 香港 · 机场A · 01',
      '🇭🇰 香港 · 机场B · 01',
    ]);
    expect(result.deduped ?? []).toEqual([]);
  });
});
