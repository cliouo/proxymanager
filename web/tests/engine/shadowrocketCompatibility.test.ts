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
const implicit = {
  status: 'unverified',
  mode: 'rule',
  reference: 'DIRECT',
  reason: '尚无导入此 YAML 后未命中域名走直连的出口对照（规则表缺少末尾 MATCH）。',
};

describe('Shadowrocket/3488 Clash YAML routing evidence', () => {
  it('accepts observed select targets but diagnoses their implicit unmatched exit', () => {
    expect(check()).toEqual([implicit]);
  });

  it.each([undefined, [], ['DOMAIN,example.com,固定']])(
    'diagnoses absent, empty and unterminated rule tables (%s)',
    (rules) => {
      expect(check({ rules })).toEqual([implicit]);
      expect(check({ rules })[0]).not.toHaveProperty('ruleNumber');
    },
  );

  it('does not duplicate the unmatched diagnostic for a terminal MATCH', () => {
    expect(check({ rules: ['MATCH,DIRECT'] })).toEqual([
      {
        status: 'unverified',
        ruleNumber: 1,
        ruleType: 'MATCH',
        target: 'DIRECT',
        reason: '尚无导入此 YAML 后未命中域名走直连的出口对照。',
      },
    ]);
  });

  it('accepts terminal MATCH through the existing select target checks', () => {
    expect(check({ rules: [...nested.rules, 'MATCH,业务'] })).toEqual([]);
  });

  it('keeps terminal MATCH to an unverified group or node unverified', () => {
    expect(check({
      'proxy-groups': [{ name: '出口', type: 'url-test', proxies: ['A'] }],
      rules: ['MATCH,出口'],
    })).toMatchObject([{ status: 'unverified', target: '出口', option: 'type=url-test' }]);
    expect(check({ rules: ['MATCH,A'] })).toMatchObject([
      { status: 'unverified', target: 'A', member: 'A' },
    ]);
  });

  it.each(['REJECT', 'REJECT-DROP', 'PASS'])('keeps MATCH to builtin %s unverified', (target) => {
    expect(check({ rules: [`MATCH,${target}`] })).toMatchObject([
      { status: 'unverified', ruleType: 'MATCH', target },
    ]);
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
    ).toEqual([implicit]);
  });

  it('keeps an empty raw dynamic group unverified', () => {
    expect(check({ 'proxy-groups': [dynamic], rules: ['DOMAIN,example.com,地区'] })).toMatchObject([
      { status: 'unverified', reference: '地区', reason: expect.stringContaining('零匹配') },
      implicit,
    ]);
  });

  it('locates an untested member and its protocol inside a reachable group', () => {
    expect(
      check({
        proxies: [
          http('A'),
          http('B'),
          { name: 'C', type: 'socks5', server: 'secret.example', port: 1080, password: 'secret' },
        ],
      }),
    ).toMatchObject([
      {
        ruleNumber: 2,
        target: '业务',
        reference: '地区',
        member: 'C',
        option: expect.stringContaining('type=socks5'),
        reason: expect.stringContaining('业务 → 出口 → 地区 → 成员 C（type=socks5'),
      },
      implicit,
    ]);
    const leaked = JSON.stringify(
      check({
        proxies: [
          http('A'),
          http('B'),
          { name: 'C', type: 'socks5', server: 'secret.example', port: 1080, password: 'secret' },
        ],
      }),
    );
    expect(leaked).not.toContain('secret.example');
    expect(leaked).not.toContain('"secret"');
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
        implicit,
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
      implicit,
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
      implicit,
    ]);
  });

  it.each(['DOMAIN', 'DOMAIN-SUFFIX'])('keeps IP literals outside %s hostname evidence', (type) => {
    expect(check({ rules: [type + ',192.0.2.1,固定'] })).toMatchObject([
      { ruleNumber: 1, status: 'unverified' },
      implicit,
    ]);
  });

  it('reports an active TUN route-set by field and set name without inventing a rule number', () => {
    const tun = {
      enable: true,
      'auto-route': true,
      'auto-redirect': true,
      'route-exclude-address-set': ['remote-ip'],
    };
    const config = {
      ...nested,
      tun,
      'rule-providers': { 'remote-ip': { type: 'http' }, unused: { type: 'http' } },
      rules: [],
    };
    const issues = check(config);
    expect(issues).toMatchObject([
      {
        status: 'unverified',
        field: 'route-exclude-address-set',
        setName: 'remote-ip',
        reason: expect.stringContaining('route-exclude-address-set'),
      },
      implicit,
    ]);
    expect(issues[0]).not.toHaveProperty('ruleNumber');
    expect(issues[0]?.reason).toContain('remote-ip');
    expect(check({ ...config, tun: { ...tun, enable: false } })).toEqual([implicit]);
    expect(check({ ...config, tun: { ...tun, 'auto-redirect': false } })).toEqual([implicit]);
    expect(
      check({ ...config, tun: { ...tun, 'auto-route': false, 'auto-redirect': false } }),
    ).toEqual([implicit]);
    expect(check({ ...config, tun: undefined })).toEqual([implicit]);
  });

  it('checks applicable TUN listeners and both address-set fields', () => {
    expect(
      check({
        ...nested,
        rules: [],
        listeners: [
          {
            name: 'tun-in',
            type: 'tun',
            'auto-route': true,
            'auto-redirect': true,
            'route-address-set': ['remote-ip'],
            'route-exclude-address-set': ['remote-ip'],
          },
        ],
        'rule-providers': { 'remote-ip': { type: 'http' } },
      }),
    ).toMatchObject([
      { field: 'route-address-set', setName: 'remote-ip' },
      { field: 'route-exclude-address-set', setName: 'remote-ip' },
      implicit,
    ]);
    expect(
      check({
        ...nested,
        rules: [],
        listeners: [
          {
            name: 'tun-in',
            type: 'tun',
            'auto-route': true,
            'auto-redirect': false,
            'route-address-set': ['remote-ip'],
          },
        ],
        'rule-providers': { 'remote-ip': { type: 'http' } },
      }),
    ).toEqual([implicit]);
  });

  it('checks group options and HTTP transport options even when the rule is familiar', () => {
    expect(
      check({
        'proxy-groups': [{ ...select('固定', 'A'), 'disable-udp': true }],
        rules: [nested.rules[0]],
      }),
    ).toMatchObject([
      {
        ruleNumber: 1,
        reference: '固定',
        option: 'disable-udp',
        reason: expect.stringContaining('disable-udp'),
      },
      implicit,
    ]);
    expect(
      check({ proxies: [{ ...http('A'), 'dialer-proxy': 'B' }, http('B'), http('C')] }),
    ).toMatchObject([
      { ruleNumber: 1, reference: '固定' },
      { ruleNumber: 2, reference: '出口' },
      implicit,
    ]);
  });

  it('checks a listener-selected sub-rule table and skips unreferenced tables', () => {
    const base = {
      ...nested,
      rules: [],
      'sub-rules': {
        office: ['PROCESS-NAME,reader,出口'],
        parked: ['PROCESS-NAME,parked,出口'],
      },
    };
    expect(
      check({
        ...base,
        listeners: [
          { name: 'mixed-in', type: 'mixed', port: 7890, rule: 'office' },
          { name: 'plain', type: 'mixed', port: 7891 },
        ],
      }),
    ).toMatchObject([
      {
        status: 'unverified',
        listener: 'mixed-in',
        table: 'office',
        ruleNumber: 1,
        ruleType: 'PROCESS-NAME',
        target: '出口',
      },
      implicit,
      { ...implicit, listener: 'mixed-in', table: 'office' },
    ]);
    expect(
      check({
        ...base,
        listeners: [{ name: 'mixed-in', type: 'mixed', port: 7890, rule: 'parked' }],
      }),
    ).toMatchObject([
      { listener: 'mixed-in', table: 'parked', ruleNumber: 1 },
      implicit,
      { ...implicit, listener: 'mixed-in', table: 'parked' },
    ]);
  });

  it('distinguishes the first rule of two listener-selected tables', () => {
    expect(
      check({
        ...nested,
        rules: [],
        'sub-rules': {
          office: ['PROCESS-NAME,reader,出口'],
          lab: ['PROCESS-PATH,/bin/tool,出口'],
        },
        listeners: [
          { name: 'office-in', type: 'mixed', port: 7890, rule: 'office' },
          { name: 'lab-in', type: 'mixed', port: 7891, rule: 'lab' },
        ],
      }),
    ).toMatchObject([
      {
        listener: 'office-in',
        table: 'office',
        ruleNumber: 1,
        ruleType: 'PROCESS-NAME',
        target: '出口',
      },
      {
        listener: 'lab-in',
        table: 'lab',
        ruleNumber: 1,
        ruleType: 'PROCESS-PATH',
        target: '出口',
      },
      implicit,
      { ...implicit, listener: 'office-in', table: 'office' },
      { ...implicit, listener: 'lab-in', table: 'lab' },
    ]);
  });

  it('uses the effective running mode and actual exit instead of inactive rules', () => {
    const globalProxy = http('GLOBAL-EXIT');
    const socks = { name: 'B', type: 'socks5', server: 'secret.example', port: 1080 };
    const global = {
      ...nested,
      mode: 'global',
      proxies: [globalProxy, socks],
      'proxy-groups': [select('GLOBAL', 'GLOBAL-EXIT', 'B')],
      rules: [],
    };
    const empty = check(global);
    const withIdleRule = check({ ...global, rules: ['DOMAIN,idle.example,业务'] });
    expect(empty).toMatchObject([
      {
        status: 'unverified',
        mode: 'global',
        reference: 'GLOBAL',
        member: 'B',
        option: 'type=socks5',
      },
    ]);
    expect(empty).not.toHaveProperty([0, 'ruleNumber']);
    expect(withIdleRule).toEqual(empty);
  });

  it('keeps mode: global itself unverified when GLOBAL is a verified plain HTTP exit', () => {
    const global = {
      ...nested,
      mode: 'global',
      proxies: [http('A')],
      'proxy-groups': [select('GLOBAL', 'A')],
      rules: [],
    };
    const empty = check(global);
    expect(empty).toMatchObject([
      {
        status: 'unverified',
        mode: 'global',
        reference: 'GLOBAL',
        reason: expect.stringContaining('运行模式 global'),
      },
    ]);
    // GLOBAL already resolves to an evidenced rule-mode exit; the gap is the
    // running mode itself, so no member, option or invented rule position.
    expect(empty[0]).not.toHaveProperty('member');
    expect(empty[0]).not.toHaveProperty('option');
    expect(empty[0]).not.toHaveProperty('ruleNumber');
    expect(empty[0].reason).toContain('GLOBAL');
    expect(check({ ...global, rules: ['DOMAIN,idle.example,GLOBAL'] })).toEqual(empty);
  });

  it('keeps mode-level evidence locatable and defaults to rule mode', () => {
    expect(
      check({
        ...nested,
        mode: 'global',
        proxies: [http('A'), http('B'), http('C')],
        'proxy-groups': [{ name: 'GLOBAL', type: 'url-test', proxies: ['A'] }],
        rules: ['PROCESS-NAME,reader,固定'],
      }),
    ).toMatchObject([
      {
        status: 'unverified',
        mode: 'global',
        reference: 'GLOBAL',
        option: 'type=url-test',
      },
    ]);
    expect(check({ ...nested, mode: 'direct', rules: ['PROCESS-NAME,reader,固定'] })).toMatchObject(
      [
        {
          status: 'unverified',
          mode: 'direct',
          reference: 'DIRECT',
          reason: expect.stringContaining('direct'),
        },
      ],
    );
    expect(check({ ...nested, mode: undefined })).toEqual([implicit]);
    expect(check({ ...nested, mode: 'rule' })).toEqual([implicit]);
    expect(check({ ...nested, mode: 'GLOBAL', rules: ['PROCESS-NAME,reader,固定'] })).toMatchObject(
      [
        {
          status: 'unverified',
          mode: 'GLOBAL',
          reason: expect.stringContaining('运行模式 GLOBAL'),
        },
      ],
    );
  });
});
