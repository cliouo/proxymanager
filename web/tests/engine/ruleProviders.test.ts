import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  referencedProviderNames,
  referencedProviderNamesInColonList,
  referencedProviderNamesInText,
  renderBase,
} from '@/lib/engine/renderer';
import { ruleProvidersBlockViolations } from '@/lib/services/baseService';
import type { Rule, RuleSet } from '@/schemas';

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: crypto.randomUUID(),
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'example.com',
    policy: '香港',
    rank: 100,
    source: 'manual',
    added_at: 1716000000,
    updated_at: 1716000000,
    ...overrides,
  };
}

function set(overrides: Partial<RuleSet>): RuleSet {
  return {
    id: crypto.randomUUID(),
    name: 'cn_domain',
    source: 'local',
    format: 'yaml',
    behavior: 'domain',
    content: 'payload: []',
    updated_at: 1716000000,
    ...overrides,
  };
}

const BASE = [
  'mode: rule',
  '# === RULE-PROVIDERS ===',
  'rules:',
  '  # === ANCHOR: manual ===',
].join('\n');
const URL_BASE = 'https://host.example/api/rule-providers/TOK';

describe('referencedProviderNames', () => {
  it('collects RULE-SET values only', () => {
    const refs = referencedProviderNames([
      rule({ type: 'RULE-SET', value: 'cn_domain' }),
      rule({ type: 'DOMAIN', value: 'a.com' }),
      rule({ type: 'RULE-SET', value: 'ads' }),
    ]);
    expect([...refs].sort()).toEqual(['ads', 'cn_domain']);
  });
});

describe('referencedProviderNamesInText', () => {
  it('extracts comma-joined names only from an index-zero, case-insensitive prefix', () => {
    expect([...referencedProviderNamesInText('rule-set:cn_domain,private')].sort()).toEqual([
      'cn_domain',
      'private',
    ]);
    expect([...referencedProviderNamesInText('RULE-SET:geolocation-!cn')]).toEqual([
      'geolocation-!cn',
    ]);
    expect([...referencedProviderNamesInText('rule-set:ads:ignored')]).toEqual(['ads:ignored']);
    expect([...referencedProviderNamesInText('rule-set:')]).toEqual(['']);
    expect([...referencedProviderNamesInText('rule-set:ads,')]).toEqual(['ads', '']);
    expect([...referencedProviderNamesInText('rule-set:ads,,private')]).toEqual([
      'ads',
      '',
      'private',
    ]);
    expect([...referencedProviderNamesInText('foo-rule-set:ads')]).toEqual([]);
    expect([...referencedProviderNamesInText(' rule-set:ads')]).toEqual([]);
  });

  it('mirrors the distinct fixed parseDomain colon truncation for scalar lists', () => {
    expect([...referencedProviderNamesInColonList('rule-set:ads:ignored')]).toEqual(['ads']);
    expect([...referencedProviderNamesInColonList('foo-rule-set:ads')]).toEqual([]);
  });
});

describe('renderBase rule-providers injection', () => {
  it('does not activate a provider named only inside DOMAIN-REGEX text', () => {
    const base = [
      'mode: rule',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  - DOMAIN-REGEX,^(RULE-SET,ads)$,DIRECT',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const dormantUrl = 'https://example.invalid/should-stay-dormant.yaml';
    const res = renderBase(base, [], {
      providers: [set({ name: 'ads', source: 'remote', url: dormantUrl, content: '' })],
      providerUrlBase: URL_BASE,
    });
    expect(res.ruleProvidersApplied).toEqual([]);
    expect(res.content).not.toContain(dormantUrl);
    expect(res.content).not.toContain('rule-providers:');
  });

  it('does not activate a provider from an embedded contextual rule-set substring', () => {
    const dormantUrl = 'https://example.invalid/should-stay-dormant.yaml';
    const base = [
      'mode: rule',
      'sniffer:',
      '  force-domain:',
      '    - "foo-rule-set:ads"',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const res = renderBase(base, [], {
      providers: [set({ name: 'ads', source: 'remote', url: dormantUrl, content: '' })],
      providerUrlBase: URL_BASE,
    });

    expect(res.ruleProvidersApplied).toEqual([]);
    expect(res.content).not.toContain(dormantUrl);
    expect(res.content).not.toContain('rule-providers:');
  });

  it('uses parseDomain colon semantics for a real sniffer rule-set prefix', () => {
    const providerUrl = 'https://example.invalid/ads.yaml';
    const base = [
      'mode: rule',
      'sniffer:',
      '  force-domain:',
      '    - "rule-set:ads:ignored"',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const res = renderBase(base, [], {
      providers: [set({ name: 'ads', source: 'remote', url: providerUrl, content: '' })],
      providerUrlBase: URL_BASE,
    });

    expect(res.ruleProvidersApplied).toEqual(['ads']);
    expect(res.content).toContain(providerUrl);
  });

  it.each([
    ['root TUN disabled', ['  enable: false', '  auto-route: true', '  auto-redirect: true']],
    [
      'root auto-redirect disabled',
      ['  enable: true', '  auto-route: true', '  auto-redirect: false'],
    ],
    [
      'root auto-route disabled',
      ['  enable: true', '  auto-route: false', '  auto-redirect: true'],
    ],
  ])('does not activate a dormant provider when %s', (_label, tunOptions) => {
    const dormantUrl = 'https://example.invalid/should-stay-dormant.yaml';
    const base = [
      'mode: rule',
      'tun:',
      ...tunOptions,
      '  route-address-set: [ads]',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const res = renderBase(base, [], {
      providers: [set({ name: 'ads', source: 'remote', url: dormantUrl, content: '' })],
      providerUrlBase: URL_BASE,
    });

    expect(res.ruleProvidersApplied).toEqual([]);
    expect(res.content).not.toContain(dormantUrl);
  });

  it('activates a TUN route provider only on an enabled auto-route + auto-redirect path', () => {
    const providerUrl = 'https://example.invalid/ads-ip.yaml';
    const base = [
      'mode: rule',
      'tun:',
      '  enable: true',
      // Root RawTun defaults auto-route to true in fixed Mihomo.
      '  auto-redirect: true',
      '  route-address-set: [ads]',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const res = renderBase(base, [], {
      providers: [
        set({
          name: 'ads',
          source: 'remote',
          behavior: 'ipcidr',
          url: providerUrl,
          content: '',
        }),
      ],
      providerUrlBase: URL_BASE,
    });

    expect(res.ruleProvidersApplied).toEqual(['ads']);
    expect(res.content).toContain(providerUrl);
  });

  it.each(['redir-host', undefined])(
    'does not activate fake-ip-filter providers outside fake-IP mode: %s',
    (enhancedMode) => {
      const dormantUrl = 'https://example.invalid/should-stay-dormant.yaml';
      const base = [
        'mode: rule',
        'dns:',
        ...(enhancedMode ? [`  enhanced-mode: ${enhancedMode}`] : []),
        '  fake-ip-filter:',
        '    - rule-set:ads',
        '# === RULE-PROVIDERS ===',
        'rules:',
        '  # === ANCHOR: manual ===',
      ].join('\n');
      const res = renderBase(base, [], {
        providers: [set({ name: 'ads', source: 'remote', url: dormantUrl, content: '' })],
        providerUrlBase: URL_BASE,
      });

      expect(res.ruleProvidersApplied).toEqual([]);
      expect(res.content).not.toContain(dormantUrl);
    },
  );

  it('honors case-insensitive fake-IP and rule modes when collecting providers', () => {
    const providerUrl = 'https://example.invalid/ads.yaml';
    const base = [
      'mode: rule',
      'dns:',
      '  enhanced-mode: FAKE-IP',
      '  fake-ip-filter-mode: RULE',
      '  fake-ip-filter:',
      '    - RULE-SET,ads,fake-ip',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const res = renderBase(base, [], {
      providers: [set({ name: 'ads', source: 'remote', url: providerUrl, content: '' })],
      providerUrlBase: URL_BASE,
    });

    expect(res.ruleProvidersApplied).toEqual(['ads']);
    expect(res.content).toContain(providerUrl);
  });

  it('emits providers referenced only by a base `rule-set:` reference (e.g. DNS policy)', () => {
    // Regression: mihomo `not found rule-set: private` — `private` is named only
    // in a DNS nameserver-policy key, never by a RULE-SET rule, yet must still be
    // declared under rule-providers.
    const base = [
      'mode: rule',
      'dns:',
      '  nameserver-policy:',
      '    "rule-set:cn_domain,private":',
      '      - https://doh.pub/dns-query',
      '# === RULE-PROVIDERS ===',
      'rules:',
      '  # === ANCHOR: manual ===',
    ].join('\n');
    const providers = [
      set({
        name: 'cn_domain',
        source: 'remote',
        url: 'https://ext/cn.mrs',
        format: 'mrs',
        content: '',
      }),
      set({
        name: 'private',
        source: 'remote',
        url: 'https://ext/private.mrs',
        format: 'mrs',
        content: '',
      }),
      set({
        name: 'unref',
        source: 'remote',
        url: 'https://ext/x.mrs',
        format: 'mrs',
        content: '',
      }),
    ];
    // Only cn_domain has a RULE-SET rule; private is referenced solely by the DNS policy.
    const rules = [rule({ type: 'RULE-SET', value: 'cn_domain', policy: '直连' })];
    const res = renderBase(base, rules, { providers, providerUrlBase: URL_BASE });

    expect(res.ruleProvidersApplied).toEqual(['cn_domain', 'private']);
    const parsed = parse(res.content) as { 'rule-providers': Record<string, unknown> };
    expect(Object.keys(parsed['rule-providers']).sort()).toEqual(['cn_domain', 'private']);
  });

  it('emits only referenced + enabled providers, alphabetically', () => {
    const providers = [
      set({ name: 'cn_domain', source: 'local', behavior: 'domain' }),
      set({
        name: 'ads',
        source: 'remote',
        url: 'https://ext/ads.mrs',
        format: 'mrs',
        behavior: 'domain',
        content: '',
      }),
      set({ name: 'unref', source: 'local' }), // not referenced → omitted
    ];
    const rules = [
      rule({ type: 'RULE-SET', value: 'cn_domain', policy: '直连' }),
      rule({ type: 'RULE-SET', value: 'ads', policy: 'REJECT' }),
    ];
    const res = renderBase(BASE, rules, { providers, providerUrlBase: URL_BASE });

    expect(res.ruleProvidersApplied).toEqual(['ads', 'cn_domain']);
    const parsed = parse(res.content) as {
      'rule-providers': Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(parsed['rule-providers'])).toEqual(['ads', 'cn_domain']);
    expect(parsed['rule-providers'].cn_domain).toMatchObject({
      type: 'http',
      behavior: 'domain',
      format: 'yaml',
      url: `${URL_BASE}/cn_domain`,
      interval: 86400,
    });
    expect(parsed['rule-providers'].ads.url).toBe('https://ext/ads.mrs');
  });

  it('skips providers referenced only by a disabled (parked) rule', () => {
    const providers = [set({ name: 'cn_domain' })];
    const rules = [rule({ type: 'RULE-SET', value: 'cn_domain', enabled: false })];
    const res = renderBase(BASE, rules, { providers, providerUrlBase: URL_BASE });
    expect(res.ruleProvidersApplied).toEqual([]);
    expect(res.content).not.toContain('rule-providers:');
  });

  it('honours a custom interval and proxy', () => {
    const providers = [set({ name: 'cn_domain', interval: 3600, proxy: '订阅更新' })];
    const rules = [rule({ type: 'RULE-SET', value: 'cn_domain' })];
    const res = renderBase(BASE, rules, { providers, providerUrlBase: URL_BASE });
    const parsed = parse(res.content) as {
      'rule-providers': Record<string, Record<string, unknown>>;
    };
    expect(parsed['rule-providers'].cn_domain).toMatchObject({ interval: 3600, proxy: '订阅更新' });
  });
});

describe('ruleProvidersBlockViolations', () => {
  it('passes a marker-only skeleton', () => {
    expect(ruleProvidersBlockViolations(BASE)).toEqual([]);
  });

  it('flags each hand-written provider entry', () => {
    const content = [
      'rule-providers:',
      '  cn_domain:',
      '    type: http',
      '    url: https://x',
      '  ads:',
      '    type: http',
      'rules:',
    ].join('\n');
    const v = ruleProvidersBlockViolations(content);
    expect(v.map((o) => o.rule_id)).toEqual(['rule-providers:cn_domain', 'rule-providers:ads']);
  });
});
