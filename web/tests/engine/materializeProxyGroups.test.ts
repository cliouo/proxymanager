import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { materializeDynamicProxyGroups } from '@/lib/engine/materializeProxyGroups';
import { validateFinalRenderedConfig } from '@/lib/engine/resolve';

describe('materializeDynamicProxyGroups', () => {
  it.each(['include-all', 'include-all-proxies'])(
    'uses empty-fallback for a zero-match %s group',
    (flag) => {
      const content = `proxies:
  - {name: JP-1, type: http, server: jp.example, port: 8080}
proxy-groups:
  - {name: HK, type: select, ${flag}: true, filter: HK, empty-fallback: REJECT}
rules: ["MATCH,REJECT"]
`;
      const output = materializeDynamicProxyGroups(content);
      expect(() => validateFinalRenderedConfig(output)).not.toThrow();
      expect(parse(output)['proxy-groups'][0]).toEqual({
        name: 'HK',
        type: 'select',
        proxies: ['REJECT'],
      });
    },
  );

  it('uses the fallback when there are no nodes at all', () => {
    const output = materializeDynamicProxyGroups(
      'proxies: []\nproxy-groups:\n  - {name: HK, type: select, include-all: true, empty-fallback: DIRECT}\n',
    );
    expect(parse(output)['proxy-groups'][0].proxies).toEqual(['DIRECT']);
    expect(() => validateFinalRenderedConfig(output)).not.toThrow();
  });

  it.each(['', ', empty-fallback: missing'])(
    'rejects an invalid zero-match group with a named 422 (%s)',
    (fallback) => {
      try {
        materializeDynamicProxyGroups(
          `proxies: []\nproxy-groups:\n  - {name: HK, type: select, include-all: true${fallback}}\n`,
        );
        expect.fail('expected validation rejection');
      } catch (error) {
        expect(error).toMatchObject({
          problem: { status: 422, detail: expect.stringContaining('HK') },
        });
      }
    },
  );

  it('expands live nodes while preserving explicit group members', () => {
    const content = `proxies:
  - { name: HK-1, type: http, server: hk.example, port: 8080 }
  - { name: JP-1, type: http, server: jp.example, port: 8080 }
proxy-groups:
  - name: Auto
    type: url-test
    proxies: [DIRECT]
    include-all-proxies: true
    filter: HK
    exclude-filter: "-2"
    empty-fallback: REJECT
`;

    const rendered = parse(materializeDynamicProxyGroups(content)) as {
      'proxy-groups': Array<Record<string, unknown>>;
    };
    expect(rendered['proxy-groups'][0]).toEqual({
      name: 'Auto',
      type: 'url-test',
      proxies: ['DIRECT', 'HK-1'],
    });
  });

  it('leaves a config without dynamic groups untouched', () => {
    const content = 'proxies: []\nproxy-groups: []\n';
    expect(materializeDynamicProxyGroups(content)).toBe(content);
  });
});

it('recomputes membership from each fresh rendered subscription', () => {
  const initial = `proxies:
  - { name: HK-1, type: http, server: hk.example, port: 8080 }
proxy-groups:
  - name: Auto
    type: url-test
    include-all-proxies: true
    filter: HK
`;
  const withNewNode = `proxies:
  - { name: HK-1, type: http, server: hk.example, port: 8080 }
  - { name: HK-2, type: http, server: hk2.example, port: 8080 }
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
  expect(first['proxy-groups'][0]['filter']).toBeUndefined();

  // Re-running materialization on an updated subscription (a fresh render
  // with HK-2 now present) produces a list that includes the new node, so
  // delivering the first snapshot to a Mihomo client does not freeze the
  // group at 'HK-1'.
  const second = parse(materializeDynamicProxyGroups(withNewNode)) as {
    'proxy-groups': Array<Record<string, unknown>>;
  };
  expect(second['proxy-groups'][0]['proxies']).toEqual(['HK-1', 'HK-2']);
  expect(second['proxy-groups'][0]['filter']).toBeUndefined();
});

it('drops only fields that have no effect after expansion', () => {
  const content = `proxies:
  - { name: HK-1, type: http, server: hk.example, port: 8080 }
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
  expect(group['filter']).toBeUndefined();
  expect(group['exclude-filter']).toBeUndefined();
  expect(group['proxies']).toEqual(['HK-1']);
});
