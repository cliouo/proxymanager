import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  referencedProviderNames,
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

const BASE = ['mode: rule', '# === RULE-PROVIDERS ===', 'rules:', '  # === ANCHOR: manual ==='].join('\n');
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
  it('extracts comma-joined rule-set names from DNS nameserver-policy keys', () => {
    const text = [
      'dns:',
      '  nameserver-policy:',
      '    "rule-set:cn_domain,private":',
      '      - https://doh.pub/dns-query',
      '    "rule-set:geolocation-!cn":',
      '      - https://dns.google/dns-query',
    ].join('\n');
    expect([...referencedProviderNamesInText(text)].sort()).toEqual([
      'cn_domain',
      'geolocation-!cn',
      'private',
    ]);
  });
});

describe('renderBase rule-providers injection', () => {
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
      set({ name: 'cn_domain', source: 'remote', url: 'https://ext/cn.mrs', format: 'mrs', content: '' }),
      set({ name: 'private', source: 'remote', url: 'https://ext/private.mrs', format: 'mrs', content: '' }),
      set({ name: 'unref', source: 'remote', url: 'https://ext/x.mrs', format: 'mrs', content: '' }),
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
      set({ name: 'ads', source: 'remote', url: 'https://ext/ads.mrs', format: 'mrs', behavior: 'domain', content: '' }),
      set({ name: 'unref', source: 'local' }), // not referenced → omitted
    ];
    const rules = [
      rule({ type: 'RULE-SET', value: 'cn_domain', policy: '直连' }),
      rule({ type: 'RULE-SET', value: 'ads', policy: 'REJECT' }),
    ];
    const res = renderBase(BASE, rules, { providers, providerUrlBase: URL_BASE });

    expect(res.ruleProvidersApplied).toEqual(['ads', 'cn_domain']);
    const parsed = parse(res.content) as { 'rule-providers': Record<string, Record<string, unknown>> };
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
    const parsed = parse(res.content) as { 'rule-providers': Record<string, Record<string, unknown>> };
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
