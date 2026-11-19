import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { checkShadowrocketRules } from '@/lib/engine/shadowrocketCompatibility';

const http = (name: string) => ({ name, type: 'http', server: 'proxy.example', port: 8080 });
const select = (name: string, ...proxies: string[]) => ({ name, type: 'select', proxies });
const dynamic = {
  name: '地区',
  type: 'select',
  'include-all-proxies': true,
  filter: '^HK-',
  'empty-fallback': 'REJECT',
};
const nested = {
  mode: 'rule',
  proxies: ['A', 'B', 'C'].map(http),
  'proxy-groups': [
    select('固定', 'A'),
    select('业务', '出口', 'A'),
    select('出口', '地区', 'A'),
    select('地区', 'B', 'C'),
  ],
  rules: ['DOMAIN,example.com,固定', 'DOMAIN-SUFFIX,example.com,业务'],
};
const check = (over = {}) => checkShadowrocketRules(stringify({ ...nested, ...over }));

describe('Shadowrocket/3488 Clash YAML routing evidence', () => {
  it('accepts exact and suffix rules through the observed three select levels', () => {
    expect(check()).toEqual([]);
  });

  it.each([
    ['HK-A', 'HK-B'],
    ['HK-A', 'HK-B', 'HK-C'],
  ])('checks the current prefix-filtered members (%s)', (...names) => {
    expect(
      check({
        proxies: [...names.map(http), { ...http('JP-X'), tls: true }],
        'proxy-groups': [dynamic, select('未引用', 'JP-X')],
        rules: ['DOMAIN,example.com,地区'],
        'rule-providers': { unused: { type: 'http' } },
      }),
    ).toEqual([]);
  });

  it('keeps an empty raw dynamic group unverified', () => {
    expect(check({ 'proxy-groups': [dynamic], rules: ['DOMAIN,example.com,地区'] })).toMatchObject([
      { status: 'unverified', reference: '地区', reason: expect.stringContaining('零匹配') },
    ]);
  });

  it('locates an untested node protocol in a reachable inner group', () => {
    expect(
      check({ proxies: [http('A'), http('B'), { ...http('C'), type: 'socks5' }] }),
    ).toMatchObject([
      {
        ruleNumber: 2,
        target: '业务',
        reference: '地区',
        reason: expect.stringContaining('业务 → 出口 → 地区'),
      },
    ]);
  });

  it.each(['PROCESS-NAME', 'PROCESS-PATH'])('locates %s after final rule insertion', (type) => {
    const rule = type + ',process,固定';
    for (const n of [1, 2]) {
      expect(check({ rules: [...Array(n).fill(nested.rules[0]), rule] })).toMatchObject([
        {
          status: 'unverified',
          ruleNumber: n + 1,
          ruleType: type,
          target: '固定',
          reason: expect.stringContaining('进程'),
        },
      ]);
    }
  });

  it('preserves outer logic targets and actual nested provider references', () => {
    expect(
      check({
        rules: [
          'AND,((NETWORK,TCP),(DST-PORT,443)),业务',
          'RULE-SET,remote,固定',
          'AND,((NETWORK,TCP),(RULE-SET,remote)),业务',
        ],
        'rule-providers': { remote: { type: 'http' } },
      }),
    ).toMatchObject([
      { ruleType: 'AND', target: '业务' },
      { ruleNumber: 2, reference: 'remote', reason: expect.stringContaining('远程正文') },
      { ruleNumber: 3, reference: 'remote', target: '业务' },
    ]);
  });

  it('does not infer a direct exit from the presence of MATCH,DIRECT in the sample', () => {
    expect(check({ rules: [...nested.rules, 'MATCH,DIRECT'] })).toMatchObject([
      {
        ruleNumber: 3,
        status: 'unverified',
        target: 'DIRECT',
        reason: expect.stringContaining('未命中'),
      },
    ]);
  });

  it('requires a numeric port in the actual distributed YAML', () => {
    expect(
      check({ proxies: [{ ...http('A'), port: '08080' }, http('B'), http('C')] }),
    ).toMatchObject([
      { ruleNumber: 1, reference: '固定' },
      { ruleNumber: 2, reference: '出口' },
    ]);
  });

  it.each(['DOMAIN', 'DOMAIN-SUFFIX'])('keeps IP literals outside %s hostname evidence', (type) => {
    expect(check({ rules: [type + ',192.0.2.1,固定'] })).toMatchObject([
      { ruleNumber: 1, status: 'unverified' },
    ]);
  });

  it('checks group options and HTTP transport options even when the rule is familiar', () => {
    expect(
      check({
        'proxy-groups': [{ ...select('固定', 'A'), 'disable-udp': true }],
        rules: [nested.rules[0]],
      }),
    ).toHaveLength(1);
    expect(
      check({ proxies: [{ ...http('A'), 'dialer-proxy': 'B' }, http('B'), http('C')] }),
    ).toHaveLength(2);
  });
});
