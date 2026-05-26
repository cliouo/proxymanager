import { describe, expect, it } from 'vitest';
import { buildOutline, fullRedactedYaml, getConfigSection } from '@/lib/ai/configAccess';

// Mirrors the user's real structure: top-level anchors (&pr/&p), a group that
// merges an anchor (<<: *pr), a provider that merges another (<<: *p), comments,
// flow maps, and credentials in several places.
const YAML = `# top comment
mixed-port: 7890
mode: rule
secret: super-secret-controller-key
dns:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 1.1.1.1
sniffer:
  enable: true
# 锚点 start
pr: &pr {type: select, proxies: [HK-1, DIRECT]}
p: &p {type: http, interval: 3600, health-check: {enable: true, url: https://cp.cloudflare.com}}
proxies:
  - {name: HK-1, type: ss, server: hk.example.com, password: p@ssw0rd}
proxy-groups:
  - name: OpenAI
    type: select
    proxies: [HK-1, DIRECT]
  - <<: *pr
    name: 香港
proxy-providers:
  # old-sub:
  #   <<: *p
  #   url: https://old.example.com/sub?token=DEADBEEFTOKEN
  sub-store:
    <<: *p
    url: https://x/api/sub/SECRETTOKEN/main
rule-providers:
  openai_classic: {type: http, behavior: classical, url: https://example.com/openai.yaml}
  selfhost: {type: http, behavior: domain, url: https://my.host/AbC123def456GHI789xyz/rules.yaml}
`;

describe('buildOutline', () => {
  const outline = buildOutline(YAML);
  const by = (k: string) => outline.find((e) => e.key === k);

  it('classifies sequences of named maps as list-named with their names', () => {
    expect(by('proxy-groups')).toMatchObject({ kind: 'list-named', names: ['OpenAI', '香港'] });
  });

  it('classifies maps with their child keys', () => {
    const dns = by('dns');
    expect(dns?.kind).toBe('map');
    expect((dns as { children: string[] }).children).toContain('enhanced-mode');
  });

  it('masks sensitive top-level scalars', () => {
    expect(by('secret')).toMatchObject({ kind: 'scalar', value: '***' });
    expect(by('mixed-port')).toMatchObject({ kind: 'scalar', value: 7890 });
  });
});

describe('getConfigSection redaction', () => {
  it('masks node passwords but keeps structure', () => {
    const r = getConfigSection(YAML, 'proxies');
    expect(r.found).toBe(true);
    expect(r.redacted).toBe(true);
    expect(r.yaml).toContain('***');
    expect(r.yaml).not.toContain('p@ssw0rd');
    expect(r.yaml).toContain('HK-1');
  });

  it('masks proxy-providers url (subscription token) but not rule-providers url', () => {
    const pp = getConfigSection(YAML, 'proxy-providers.sub-store');
    expect(pp.yaml).not.toContain('SECRETTOKEN');
    expect(pp.redacted).toBe(true);
    // Section view resolves the merge to effective config (no dangling alias).
    expect(pp.yaml).toContain('http');

    const rp = getConfigSection(YAML, 'rule-providers.openai_classic');
    expect(rp.yaml).toContain('example.com/openai.yaml');
    expect(rp.redacted).toBe(false);
  });

  it('masks a scalar leaf when the path itself points at a credential', () => {
    expect(getConfigSection(YAML, 'secret').yaml).toBe('***');
    expect(getConfigSection(YAML, 'proxies[HK-1].password').yaml).toBe('***');
  });
});

describe('getConfigSection navigation', () => {
  it('resolves [name] selectors in sequences', () => {
    const g = getConfigSection(YAML, 'proxy-groups[OpenAI]');
    expect(g.found).toBe(true);
    expect(g.redacted).toBe(false);
    expect(g.yaml).toContain('select');
  });

  it('reads scalar leaves via map paths', () => {
    expect(getConfigSection(YAML, 'dns.enhanced-mode').yaml).toBe('fake-ip');
  });

  it('reports not-found for missing paths', () => {
    expect(getConfigSection(YAML, 'does.not.exist').found).toBe(false);
    expect(getConfigSection(YAML, 'proxy-groups[NoSuchGroup]').found).toBe(false);
  });
});

describe('fullRedactedYaml', () => {
  const yaml = fullRedactedYaml(YAML);

  it('masks all credentials across the whole config', () => {
    expect(yaml).not.toContain('p@ssw0rd');
    expect(yaml).not.toContain('SECRETTOKEN');
    expect(yaml).not.toContain('super-secret-controller-key');
  });

  it('scrubs secrets out of commented-out subscriptions too', () => {
    expect(yaml).not.toContain('DEADBEEFTOKEN');
    expect(yaml).not.toContain('old.example.com');
    // ...but the comment structure itself is still there.
    expect(yaml).toContain('old-sub');
  });

  it('preserves anchors, merge keys and aliases (no inline expansion)', () => {
    expect(yaml).toContain('&pr');
    expect(yaml).toContain('&p');
    expect(yaml).toContain('<<: *pr');
    expect(yaml).toContain('<<: *p');
  });

  it('preserves comments', () => {
    expect(yaml).toContain('# top comment');
    expect(yaml).toContain('# 锚点 start');
  });

  it('keeps public urls and does not over-mask urls outside node/subscription scope', () => {
    expect(yaml).toContain('example.com/openai.yaml');
    expect(yaml).toContain('cp.cloudflare.com');
  });

  it('masks tokens inside self-hosted rule-set URLs but keeps host + filename', () => {
    expect(yaml).not.toContain('AbC123def456GHI789xyz');
    expect(yaml).toContain('my.host');
    expect(yaml).toContain('rules.yaml');
  });
});
