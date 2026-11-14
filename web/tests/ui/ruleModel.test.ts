import { describe, expect, it } from 'vitest';
import type { Rule } from '@/schemas';
import {
  detectRule,
  domainEntryMatches,
  evaluateRuleSetContent,
  evaluateWithOptions,
  ipv4InCidr,
  parseProbe,
  ruleText,
  sectionize,
} from '@/ui/features/rules/rule-model';

function rule(partial: Partial<Rule> & Pick<Rule, 'type' | 'policy'>): Rule {
  return {
    id: partial.id ?? `${partial.type}-${partial.value ?? ''}-${partial.rank ?? 0}`,
    anchor: partial.anchor ?? 'manual',
    value: partial.value ?? '',
    rank: partial.rank ?? 10,
    source: 'manual',
    added_at: 0,
    updated_at: 0,
    ...partial,
  } as Rule;
}

describe('detectRule — smart composer input', () => {
  it('treats a bare domain as DOMAIN-SUFFIX and strips www', () => {
    expect(detectRule('google.com')).toEqual({ type: 'DOMAIN-SUFFIX', value: 'google.com' });
    expect(detectRule('www.netflix.com')).toEqual({ type: 'DOMAIN-SUFFIX', value: 'netflix.com' });
  });

  it('extracts the host from a pasted URL and says so', () => {
    expect(detectRule('https://www.example.org/path?q=1')).toMatchObject({
      type: 'DOMAIN-SUFFIX',
      value: 'example.org',
      note: expect.any(String),
    });
  });

  it('recognises wildcard prefixes, IPs, CIDRs, ports and geo shortcuts', () => {
    expect(detectRule('*.apple.com')).toEqual({ type: 'DOMAIN-SUFFIX', value: 'apple.com' });
    expect(detectRule('+.apple.com')).toEqual({ type: 'DOMAIN-SUFFIX', value: 'apple.com' });
    expect(detectRule('10.0.0.0/8')).toEqual({ type: 'IP-CIDR', value: '10.0.0.0/8' });
    expect(detectRule('1.1.1.1')).toMatchObject({ type: 'IP-CIDR', value: '1.1.1.1/32' });
    expect(detectRule('2001:db8::/32')).toEqual({ type: 'IP-CIDR6', value: '2001:db8::/32' });
    expect(detectRule('443')).toEqual({ type: 'DST-PORT', value: '443' });
    expect(detectRule('geosite:cn')).toEqual({ type: 'GEOSITE', value: 'cn' });
    expect(detectRule('geoip:cn')).toEqual({ type: 'GEOIP', value: 'CN' });
  });

  it('falls back to DOMAIN-KEYWORD for single words and accepts full rule lines', () => {
    expect(detectRule('gemini')).toEqual({ type: 'DOMAIN-KEYWORD', value: 'gemini' });
    expect(detectRule('DOMAIN,api.example.com,DIRECT')).toEqual({ type: 'DOMAIN', value: 'api.example.com' });
    expect(detectRule('   ')).toBeNull();
  });
});

describe('route tester matching', () => {
  const host = parseProbe('https://chat.openai.com/c/123')!;
  const ip = parseProbe('10.1.2.3')!;

  it('parses probes from URLs, hosts with ports and IPs', () => {
    expect(host).toEqual({ host: 'chat.openai.com', ip: null });
    expect(parseProbe('example.com:8443')).toEqual({ host: 'example.com', ip: null });
    expect(ip).toEqual({ host: null, ip: '10.1.2.3' });
  });

  it('evaluates domain rules deterministically', () => {
    expect(evaluateWithOptions(rule({ type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'AI' }), host)).toBe('match');
    expect(evaluateWithOptions(rule({ type: 'DOMAIN-SUFFIX', value: 'ai.com', policy: 'AI' }), host)).toBe('no');
    expect(evaluateWithOptions(rule({ type: 'DOMAIN', value: 'openai.com', policy: 'AI' }), host)).toBe('no');
    expect(evaluateWithOptions(rule({ type: 'DOMAIN-KEYWORD', value: 'openai', policy: 'AI' }), host)).toBe('match');
    expect(evaluateWithOptions(rule({ type: 'DOMAIN-REGEX', value: '^chat\\.', policy: 'AI' }), host)).toBe('match');
    expect(evaluateWithOptions(rule({ type: 'MATCH', policy: 'Final' }), host)).toBe('match');
  });

  it('is honest about what the browser cannot know', () => {
    expect(evaluateWithOptions(rule({ type: 'GEOSITE', value: 'cn', policy: 'D' }), host)).toBe('unknown');
    expect(evaluateWithOptions(rule({ type: 'IP-CIDR', value: '10.0.0.0/8', policy: 'D' }), host)).toBe('unknown');
    expect(evaluateWithOptions(rule({ type: 'RULE-SET', value: 'openai', policy: 'AI' }), host)).toBe('unknown');
    expect(evaluateWithOptions(rule({ type: 'PROCESS-NAME', value: 'Steam', policy: 'D' }), host)).toBe('unknown');
  });

  it('skips IP rules marked no-resolve for domain probes and matches CIDRs for IP probes', () => {
    expect(
      evaluateWithOptions(rule({ type: 'IP-CIDR', value: '10.0.0.0/8', policy: 'D', options: ['no-resolve'] }), host),
    ).toBe('no');
    expect(evaluateWithOptions(rule({ type: 'IP-CIDR', value: '10.0.0.0/8', policy: 'D' }), ip)).toBe('match');
    expect(evaluateWithOptions(rule({ type: 'IP-CIDR', value: '192.168.0.0/16', policy: 'D' }), ip)).toBe('no');
    expect(evaluateWithOptions(rule({ type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'AI' }), ip)).toBe('no');
  });

  it('checks IPv4 CIDR containment including edge prefixes', () => {
    expect(ipv4InCidr('10.255.0.1', '10.0.0.0/8')).toBe(true);
    expect(ipv4InCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipv4InCidr('1.1.1.1', '1.1.1.1/32')).toBe(true);
    expect(ipv4InCidr('1.1.1.2', '1.1.1.1/32')).toBe(false);
  });

  it('evaluates hosted rule-set bodies by behaviour', () => {
    const bili = parseProbe('www.bilibili.com')!;
    expect(evaluateRuleSetContent('+.bilibili.com\n+.zhihu.com\n', 'domain', bili)).toBe('match');
    expect(evaluateRuleSetContent('+.zhihu.com\n', 'domain', bili)).toBe('no');
    expect(evaluateRuleSetContent('payload:\n  - DOMAIN-SUFFIX,bilibili.com\n', 'classical', bili)).toBe('match');
    expect(evaluateRuleSetContent('payload:\n  - GEOSITE,cn\n', 'classical', bili)).toBe('unknown');
    expect(evaluateRuleSetContent('10.0.0.0/8\n', 'ipcidr', ip)).toBe('match');
    expect(evaluateRuleSetContent('10.0.0.0/8\n', 'ipcidr', bili)).toBe('unknown');
  });

  it('follows rule-set domain entry syntax', () => {
    expect(domainEntryMatches('+.example.com', 'a.b.example.com')).toBe(true);
    expect(domainEntryMatches('.example.com', 'example.com')).toBe(true);
    expect(domainEntryMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(domainEntryMatches('*.example.com', 'a.b.example.com')).toBe(false);
    expect(domainEntryMatches('example.com', 'www.example.com')).toBe(false);
  });
});

describe('sectionize — evaluation order', () => {
  it('orders anchors as in the base, ranks within, active MATCH last, unknown anchors appended', () => {
    const rules = [
      rule({ id: 'm', anchor: 'late', type: 'MATCH', policy: 'Final', rank: 1 }),
      rule({ id: 'l2', anchor: 'late', type: 'GEOIP', value: 'CN', policy: 'D', rank: 20 }),
      rule({ id: 'p1', anchor: 'prelude', type: 'DOMAIN', value: 'a.com', policy: 'X', rank: 10 }),
      rule({ id: 'x', anchor: 'ghost', type: 'DOMAIN', value: 'b.com', policy: 'X', rank: 10 }),
      rule({ id: 'off', anchor: 'late', type: 'MATCH', policy: 'Old', rank: 5, enabled: false }),
    ];
    const sections = sectionize(rules, ['prelude', 'manual', 'late']);
    expect(sections.map((s) => [s.anchor, s.known, s.rules.map((r) => r.id)])).toEqual([
      ['prelude', true, ['p1']],
      ['manual', true, []],
      ['late', true, ['off', 'l2', 'm']],
      ['ghost', false, ['x']],
    ]);
  });

  it('renders rules as their mihomo line', () => {
    expect(ruleText(rule({ type: 'IP-CIDR', value: '10.0.0.0/8', policy: 'DIRECT', options: ['no-resolve'] }))).toBe(
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    );
    expect(ruleText(rule({ type: 'MATCH', policy: '默认' }))).toBe('MATCH,默认');
  });
});
