import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { materializeDynamicProxyGroups } from '@/lib/engine/materializeProxyGroups';

describe('materializeDynamicProxyGroups', () => {
  it('expands live nodes while preserving explicit group members', () => {
    const content = `proxies:
  - { name: HK-1, type: ss }
  - { name: JP-1, type: ss }
proxy-groups:
  - name: Auto
    type: url-test
    proxies: [DIRECT]
    include-all-proxies: true
    filter: HK
    exclude-filter: -2
    empty-fallback: REJECT
`;

    const rendered = parse(materializeDynamicProxyGroups(content)) as {
      'proxy-groups': Array<Record<string, unknown>>;
    };
    expect(rendered['proxy-groups'][0]).toEqual({
      name: 'Auto',
      type: 'url-test',
      proxies: ['DIRECT', 'HK-1'],
      filter: 'HK',
    });
  });

  it('leaves a config without dynamic groups untouched', () => {
    const content = 'proxies: []\nproxy-groups: []\n';
    expect(materializeDynamicProxyGroups(content)).toBe(content);
  });
});

  it('keeps the original filter so membership still tracks newly added nodes', () => {
    const initial = `proxies:
  - { name: HK-1, type: ss }
proxy-groups:
  - name: Auto
    type: url-test
    include-all-proxies: true
    filter: HK
`;
    const withNewNode = `proxies:
  - { name: HK-1, type: ss }
  - { name: HK-2, type: ss }
proxy-groups:
  - name: Auto
    type: url-test
    include-all-proxies: true
    filter: HK
`;

    const first = parse(materializeDynamicProxyGroups(initial)) as {
      proxies: Array<Record<string, unknown>>;
      'proxy-groups': Array<Record<string, unknown>>;
    };
    expect(first['proxy-groups'][0]['proxies']).toEqual(['HK-1']);
    expect(first['proxy-groups'][0]['filter']).toBe('HK');

    // Re-running materialization on an updated subscription (a fresh render
    // with HK-2 now present) produces a list that includes the new node, so
    // delivering the first snapshot to a Mihomo client does not freeze the
    // group at 'HK-1'.
    const second = parse(materializeDynamicProxyGroups(withNewNode)) as {
      'proxy-groups': Array<Record<string, unknown>>;
    };
    expect(second['proxy-groups'][0]['proxies']).toEqual(['HK-1', 'HK-2']);
    expect(second['proxy-groups'][0]['filter']).toBe('HK');
  });

  it('drops only fields that have no effect after expansion', () => {
    const content = `proxies:
  - { name: HK-1, type: ss }
proxy-groups:
  - name: Auto
    type: url-test
    include-all-proxies: true
    filter: HK
    exclude-filter: "-2"
    empty-fallback: REJECT
`;
    const out = parse(materializeDynamicProxyGroups(content)) as {
      'proxy-groups': Array<Record<string, unknown>>;
    };
    const group = out['proxy-groups'][0];
    expect(group['include-all-proxies']).toBeUndefined();
    expect(group['empty-fallback']).toBeUndefined();
    expect(group['filter']).toBe('HK');
    expect(group['exclude-filter']).toBe('-2');
    expect(group['proxies']).toEqual(['HK-1']);
  });
