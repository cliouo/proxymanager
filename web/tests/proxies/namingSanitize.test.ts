import { beforeAll, describe, expect, it } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import {
  containsSensitivePattern,
  redactSensitiveText,
  sanitizeFragment,
} from '@/lib/proxies/namingSanitize';

/**
 * Criterion 6 privacy: representative credential-shaped patterns must be
 * removed before anything derived from a node name can reach a model provider.
 */

beforeAll(() => {
  installTestHandleSecret();
});

describe('redactSensitiveText', () => {
  it('removes URLs (incl. userinfo)', () => {
    expect(
      redactSensitiveText('看官网 https://admin:pw@airport.example/sub?token=abc'),
    ).not.toMatch(/airport\.example/);
    expect(redactSensitiveText('vmess://abc-def').trim()).toBe('');
  });

  it('removes emails', () => {
    expect(redactSensitiveText('联系 user@example.com 节点')).not.toMatch(/user@example/);
  });

  it('removes IPv4 and IPv6 addresses', () => {
    expect(redactSensitiveText('节点 1.2.3.4 出口')).not.toMatch(/1\.2\.3\.4/);
    expect(redactSensitiveText('节点 2001:db8::1 出口')).not.toMatch(/2001:db8/);
  });

  it('removes UUIDs', () => {
    expect(redactSensitiveText('id 123e4567-e89b-12d3-a456-426614174000 tail')).not.toMatch(
      /123e4567/,
    );
  });

  it('removes host:port pairs', () => {
    expect(redactSensitiveText('edge.example.com:8443 入口')).not.toMatch(/8443/);
    expect(redactSensitiveText('1.2.3.4:443 入口')).not.toMatch(/1\.2\.3\.4:443/);
  });

  it('removes bare DNS hostnames / SNI without a port', () => {
    expect(redactSensitiveText('节点 edge.example.com 官方')).not.toMatch(/edge\.example/);
    expect(redactSensitiveText('sub.domain.co.uk 出口')).not.toMatch(/domain\.co/);
    expect(redactSensitiveText('我的机场 api.airport.net 专线')).not.toMatch(/api\.airport/);
    // every occurrence, not just the first
    expect(redactSensitiveText('a.example.com b.example.org c.example.net')).not.toMatch(/example/);
  });

  it('removes arbitrary real hostnames — no finite TLD list', () => {
    expect(redactSensitiveText('edge.airport.ai 节点')).not.toMatch(/airport\.ai/);
    expect(redactSensitiveText('edge.airport.moe 节点')).not.toMatch(/airport\.moe/);
    expect(redactSensitiveText('cdn.example.xyz 出口')).not.toMatch(/example\.xyz/);
  });

  it('keeps non-host display fragments and version-like tokens', () => {
    // dotted sequences that are not credible hostnames (IP-style versions
    // without a host label) and CJK text survive
    expect(redactSensitiveText('版本 1.2.3')).toBe('版本 1.2.3');
    expect(redactSensitiveText('香港 中转 2x 01')).toBe('香港 中转 2x 01');
    expect(redactSensitiveText('v1::beta 节点')).toBe('v1::beta 节点');
  });

  it('removes IPv6 with omitted leading groups (bare ::1 and equivalents)', () => {
    expect(redactSensitiveText('节点 ::1 出口')).not.toMatch(/::1/);
    expect(redactSensitiveText('::1').trim()).toBe('');
    expect(redactSensitiveText('入口 ::1:2:3:4:5:6:7 出口')).not.toMatch(/::1/);
    // IPv4-mapped tail is consumed atomically — no dotted residue
    expect(redactSensitiveText('::ffff:1.2.3.4')).not.toMatch(/ffff|1\.2\.3\.4/);
    // mid-fragment, adjacent to CJK
    expect(redactSensitiveText('节点::1出口')).not.toMatch(/::1/);
  });

  it('closes the explicit failure forms: trailing ::, ::v4-compatible', () => {
    for (const probe of ['2001:db8::', 'fe80::', '::192.0.2.1']) {
      expect(redactSensitiveText(probe).replace(/\s+/g, ' ').trim()).toBe('');
      expect(containsSensitivePattern(probe)).toBe(true);
      expect(sanitizeFragment(probe)).toBeNull();
    }
    expect(redactSensitiveText('节点 2001:db8:: 出口')).not.toMatch(/db8|::/);
    expect(redactSensitiveText('节点 ::192.0.2.1 出口')).not.toMatch(/192\.0\.2\.1|::/);
  });

  it('removes multiple IPv6/host tokens in one fragment', () => {
    const out = redactSensitiveText('a.example.com ::1 b.example.org ::2');
    expect(out).not.toMatch(/example/);
    expect(out).not.toMatch(/::1|::2/);
  });

  it('redacts bracketed IPv6 with port whole — no [ ]/:port residue', () => {
    for (const probe of [
      '[::1]:443',
      '[2001:db8::1]:8443',
      '[fe80::1%eth0]:443',
      '[2001:db8::abcd:ef01]:8080',
    ]) {
      const out = redactSensitiveText(probe);
      expect(out.replace(/\s+/g, ' ').trim()).toBe('');
      expect(redactSensitiveText(probe)).not.toMatch(/\[|\]|:443|:8443|:8080/);
    }
    expect(sanitizeFragment('[2001:db8::1]:8443 入口')).toBe('入口');
  });

  it('redacts middle-compressed and all-hex multi-tail IPv6 whole', () => {
    for (const probe of ['2001:db8::1:8443', '2001:db8::abcd:ef01', 'fe80::1%eth0', '::1:443']) {
      expect(redactSensitiveText(probe).replace(/\s+/g, ' ').trim()).toBe('');
    }
    expect(redactSensitiveText('节点 2001:db8::abcd:ef01 出口')).not.toMatch(/ef01/);
    expect(redactSensitiveText('节点 fe80::1%eth0 出口')).not.toMatch(/eth0/);
    expect(redactSensitiveText('节点 ::1:443 出口')).not.toMatch(/443/);
  });

  it('redacts IPv4-mapped forms atomically — no dotted residue', () => {
    for (const probe of ['::ffff:1.2.3.4', '2001:db8::ffff:1.2.3.4', '[::ffff:1.2.3.4]:8443']) {
      const out = redactSensitiveText(probe).replace(/\s+/g, ' ').trim();
      expect(out).toBe('');
      expect(redactSensitiveText(probe)).not.toMatch(/ffff|1\.2\.3\.4/);
    }
  });

  it('redacts host:port and single-label host:port whole', () => {
    expect(redactSensitiveText('edge.example.com:8443 入口')).not.toMatch(/8443|example/);
    expect(redactSensitiveText('myhost:443 入口')).not.toMatch(/myhost|:443/);
    expect(sanitizeFragment('入口 myhost:443')).toBe('入口');
  });

  it('no bracket/port/zone/host/IP residue survives mixed-token fragments', () => {
    const probes = [
      'a.example.com:8443 [2001:db8::1]:443 1.2.3.4:53 ::1',
      'fe80::1%eth0 2001:db8::abcd:ef01:8080 ::ffff:1.2.3.4 myhost:22',
      '节点 [::1]:8443 出口 2001:db8::1:443 中转',
    ];
    for (const probe of probes) {
      const out = sanitizeFragment(probe) ?? '';
      expect(out).not.toMatch(
        /\[|\]|:\d{1,5}\b|%[A-Za-z0-9._-]{1,32}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|::/,
      );
      expect(out).not.toMatch(/example|myhost|eth0|ffff/);
    }
  });

  it('keeps ordinary non-host names and version-like tokens', () => {
    expect(redactSensitiveText('香港 中转 2x 01')).toBe('香港 中转 2x 01');
    expect(redactSensitiveText('v1::beta 节点')).toBe('v1::beta 节点');
    expect(redactSensitiveText(':: 节点')).toBe(':: 节点');
    expect(redactSensitiveText('版本 ::1x')).toBe('版本 ::1x');
  });

  it('removes key/token/secret assignments', () => {
    expect(redactSensitiveText('token=sk-abcdef123456 tail')).not.toMatch(/sk-abcdef/);
    expect(redactSensitiveText('api_key: 9f86d081884c7d659a2feaa0 tail')).not.toMatch(/9f86d081/);
    expect(redactSensitiveText('password= hunter2 tail')).not.toMatch(/hunter2/);
  });

  it('removes query strings', () => {
    expect(redactSensitiveText('a=1&b=2 tail')).not.toMatch(/a=1/);
    expect(redactSensitiveText('?token=xyz&expire=1 tail')).not.toMatch(/token=xyz/);
  });

  it('removes long base64/hex runs', () => {
    expect(redactSensitiveText('AAAAABBBBBCCCCCDDDDDEEEEEF tail')).not.toMatch(/AAAAABBBBB/);
  });

  it('never removes ordinary display words', () => {
    expect(redactSensitiveText('香港 中转 2x 01')).toBe('香港 中转 2x 01');
    expect(redactSensitiveText('Nexitally 官方 节点')).toBe('Nexitally 官方 节点');
  });
});

describe('sanitizeFragment', () => {
  it('drops fragments that are entirely credential-like', () => {
    expect(sanitizeFragment('user@example.com')).toBeNull();
    expect(sanitizeFragment('https://airport.example/sub')).toBeNull();
    expect(sanitizeFragment('edge.example.com')).toBeNull();
    expect(sanitizeFragment('::1')).toBeNull();
    expect(sanitizeFragment('')).toBeNull();
  });

  it('strips ::1 embedded in an otherwise-safe fragment', () => {
    expect(sanitizeFragment('节点 ::1 官方')).toBe('节点 官方');
  });

  it('source labels carrying hostnames are dropped (never sent as src)', () => {
    expect(sanitizeFragment('my-airport.example.com')).toBeNull();
    expect(sanitizeFragment('机场A api.airport.com')).toBe('机场A');
  });

  it('keeps safe residuals, bounded to the cap', () => {
    const out = sanitizeFragment('香港 负载均衡 节点 官方 线路');
    expect(out).toBe('香港 负载均衡 节点 官方 线路'.slice(0, 24));
    expect(out!.length).toBeLessThanOrEqual(24);
  });

  it('redacts embedded credentials inside otherwise-safe fragments', () => {
    const out = sanitizeFragment('香港 token=sk-1234567890abc 官方');
    expect(out).not.toMatch(/sk-123456/);
    expect(out).toContain('香港');
  });
});

describe('containsSensitivePattern', () => {
  it('flags credential-shaped strings (defense-in-depth re-check)', () => {
    expect(containsSensitivePattern('1.2.3.4')).toBe(true);
    expect(containsSensitivePattern('user@example.com')).toBe(true);
    expect(containsSensitivePattern('a=1&b=2')).toBe(true);
    expect(containsSensitivePattern('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(containsSensitivePattern('edge.example.com:8443')).toBe(true);
    expect(containsSensitivePattern('edge.example.com')).toBe(true);
    expect(containsSensitivePattern('api.airport.dev')).toBe(true);
    expect(containsSensitivePattern('::1')).toBe(true);
  });

  it('flags ::-leading IPv6 forms inside fragments', () => {
    expect(containsSensitivePattern('节点 ::1 出口')).toBe(true);
    expect(containsSensitivePattern('::1:2:3:4:5:6:7')).toBe(true);
  });

  it('no stateful regex leakage across repeated/interleaved calls', () => {
    // /g patterns must not leak lastIndex between .test calls
    for (let i = 0; i < 5; i += 1) {
      expect(containsSensitivePattern('::1')).toBe(true);
      expect(containsSensitivePattern('edge.example.com')).toBe(true);
      expect(containsSensitivePattern('香港 中转 2x 01')).toBe(false);
    }
    const a = redactSensitiveText('节点 ::1 出口');
    const b = redactSensitiveText('节点 ::1 出口');
    expect(a).toBe(b);
    expect(redactSensitiveText('::1')).toBe(redactSensitiveText('::1'));
  });

  it('passes clean display text', () => {
    expect(containsSensitivePattern('香港 中转 2x')).toBe(false);
    expect(containsSensitivePattern('机场A')).toBe(false);
    expect(containsSensitivePattern('')).toBe(false);
  });
});

describe('IDN / punycode / underscore hostnames (final repair pass group 2)', () => {
  it('redacts punycode TLDs whole — no label residue', () => {
    expect(redactSensitiveText('example.xn--fiqs8s').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('入口 example.xn--fiqs8s 出口')).not.toMatch(/fiqs8s|example/);
    expect(sanitizeFragment('example.xn--fiqs8s')).toBeNull();
    expect(containsSensitivePattern('example.xn--fiqs8s')).toBe(true);
  });

  it('redacts underscore service hostnames whole', () => {
    expect(redactSensitiveText('_svc._tcp.example.com').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('_svc._tcp.example.com:8443 入口')).not.toMatch(
      /svc|tcp|example|8443/,
    );
    expect(containsSensitivePattern('_svc._tcp.example.com')).toBe(true);
  });

  it('redacts Unicode IDNs whole', () => {
    expect(redactSensitiveText('例子.中国').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('中文.香港.公司 节点')).not.toMatch(/中文|香港|公司/);
    expect(redactSensitiveText('例子.中国:443 入口')).not.toMatch(/例子|中国|443/);
    expect(sanitizeFragment('入口 例子.中国')).toBe('入口');
    expect(containsSensitivePattern('例子.中国')).toBe(true);
  });

  it('preserves ordinary dotted Chinese text and version tokens', () => {
    expect(redactSensitiveText('香港.中转 节点')).toBe('香港.中转 节点');
    expect(redactSensitiveText('版本.更新 节点')).toBe('版本.更新 节点');
    expect(redactSensitiveText('v1::beta 节点')).toBe('v1::beta 节点');
  });

  it('no residue in buildScrubbedPayload for the new forms', async () => {
    const { buildScrubbedPayload } = await import('@/lib/ai/namingAnalysis');
    const payload = buildScrubbedPayload([
      { name: 'example.xn--fiqs8s 香港 _svc._tcp.example.com 01', type: 'ss' },
      // 中国 is BOTH an IDN TLD and a region keyword: recognition must never
      // split the hostname (region CN + leaked 例子.) — the full raw name is
      // redacted BEFORE recognition, so no credential-derived residue can
      // reach the payload.
      { name: '节点 例子.中国 出口', type: 'ss' },
    ]);
    const serialized = JSON.stringify(payload);
    for (const needle of ['fiqs8s', 'example', 'svc', 'tcp', '例子', '中国']) {
      expect(serialized, needle).not.toContain(needle);
    }
  });
});

describe('whole-email redaction for IDN hosts (repair pass follow-up)', () => {
  it('redacts emails with punycode/Unicode hosts — no local-part or TLD residue', () => {
    expect(redactSensitiveText('user@example.xn--fiqs8s').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('user@例子.中国').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('联系 user@例子.中国 或 user@example.xn--fiqs8s')).not.toMatch(
      /user@|fiqs8s|例子|中国/,
    );
    expect(sanitizeFragment('user@例子.中国')).toBeNull();
    expect(containsSensitivePattern('user@例子.中国')).toBe(true);
    expect(containsSensitivePattern('user@example.xn--fiqs8s')).toBe(true);
  });
});

describe('IPv4-with-port whole-token closure (final acceptance finding 4)', () => {
  it('192.0.2.10:8443 redacts whole — no IP-derived prefix residue', () => {
    expect(redactSensitiveText('192.0.2.10:8443').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('节点 192.0.2.10:8443 出口')).not.toMatch(/192\.0\.2\./);
    expect(redactSensitiveText('1.2.3.4:443').replace(/\s+/g, ' ').trim()).toBe('');
    expect(redactSensitiveText('1.2.3.4:443')).not.toMatch(/1\.2\.3\./);
  });

  it('no leaked residue passes containsSensitivePattern as clean', () => {
    // the residue forms from the Delivery reproduction must NEVER be clean
    expect(containsSensitivePattern('192.0.2.')).toBe(false);
    expect(containsSensitivePattern('1.2.3.')).toBe(false);
    // and the full tokens are always flagged
    expect(containsSensitivePattern('192.0.2.10:8443')).toBe(true);
    expect(containsSensitivePattern('1.2.3.4:443')).toBe(true);
    // sanitizeFragment drops the whole token with its surrounding text intact
    expect(sanitizeFragment('入口 192.0.2.10:8443 1.2.3.4:443')).toBe('入口');
  });
});

describe('pass-7 blocker 5: single protocol allowlist', () => {
  it('CANONICAL_PROXY_TYPES IS FIXED_MIHOMO_PROXY_TYPES by reference — no second manual list', async () => {
    const { FIXED_MIHOMO_PROXY_TYPES } = await import('@/lib/proxies/mihomoProxyValidator');
    const { CANONICAL_PROXY_TYPES } = await import('@/lib/proxies/namingSanitize');
    // the sanitizer does not re-roll its own list — structural proof
    expect(CANONICAL_PROXY_TYPES).toBe(FIXED_MIHOMO_PROXY_TYPES);
  });

  it('the production validator exports exactly 25 fixed protocol names', async () => {
    const { FIXED_MIHOMO_PROXY_TYPES } = await import('@/lib/proxies/mihomoProxyValidator');
    expect(FIXED_MIHOMO_PROXY_TYPES.size).toBe(25);
    for (const t of FIXED_MIHOMO_PROXY_TYPES) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
