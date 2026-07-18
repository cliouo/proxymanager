import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { buildDirectAliasCandidate } from '@/lib/services/directMigrationService';
import { buildLegacyProfileRepairCandidate } from '@/lib/services/legacyProfileRepairService';
import type { BaseRecord } from '@/lib/repos/baseRepo';
import type { ProxyGroup, ProxyGroupTemplate, Rule } from '@/schemas';

const ALIAS = '直连';
const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';
const ENABLED_RULE_ID = '33333333-3333-4333-8333-333333333333';
const DISABLED_RULE_ID = '44444444-4444-4444-8444-444444444444';

function base(content: string): BaseRecord {
  return {
    content,
    etag: 'feedfacefeedface',
    anchors: [],
    policies: [],
    updated_at: 1,
  };
}

function group(over: Partial<ProxyGroup> = {}): ProxyGroup {
  return {
    id: GROUP_ID,
    kind: 'manual',
    name: '自动选择',
    type: 'select',
    rank: 10,
    updated_at: 1,
    proxies: [ALIAS, 'DIRECT', '节点 A'],
    ...over,
  } as ProxyGroup;
}

function rule(id: string, enabled?: boolean): Rule {
  return {
    id,
    anchor: 'manual',
    type: 'DOMAIN-SUFFIX',
    value: 'example.com',
    policy: ALIAS,
    rank: 10,
    source: 'manual',
    added_at: 1,
    updated_at: 1,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

describe('buildDirectAliasCandidate', () => {
  it('migrates a production-shaped marker-only rules skeleton without losing anchors', () => {
    const candidate = buildDirectAliasCandidate({
      base: base(`
mode: rule
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
rules:
  # === ANCHOR: prelude ===
  # === ANCHOR: manual ===
  # === ANCHOR: late ===
`),
      groups: [],
      rules: [rule(ENABLED_RULE_ID)],
      templates: [],
      alias: ALIAS,
      updatedAt: 99,
    });

    expect(parse(candidate.baseContent)).toMatchObject({ proxies: [], rules: null });
    expect(candidate.baseContent).toContain('# === ANCHOR: prelude ===');
    expect(candidate.baseContent).toContain('# === ANCHOR: manual ===');
    expect(candidate.baseContent).toContain('# === ANCHOR: late ===');
    expect(candidate.rules).toEqual([expect.objectContaining({ policy: 'DIRECT' })]);
  });

  it('removes only the redundant direct alias and rewrites every known reference', () => {
    const template: ProxyGroupTemplate = {
      id: TEMPLATE_ID,
      name: 'shared',
      updated_at: 1,
      'empty-fallback': ALIAS,
    };
    const candidate = buildDirectAliasCandidate({
      base: base(`
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
  - name: chained
    type: socks5
    server: 127.0.0.1
    port: 1080
    dialer-proxy: ${ALIAS}
proxy-providers:
  remote:
    type: http
    url: https://example.com/sub
    proxy: ${ALIAS}
proxy-groups:
  - name: legacy
    type: select
    proxies: [${ALIAS}, DIRECT]
    empty-fallback: ${ALIAS}
rules:
  - MATCH,${ALIAS}
`),
      groups: [group({ template_id: TEMPLATE_ID })],
      rules: [rule(ENABLED_RULE_ID), rule(DISABLED_RULE_ID, false)],
      templates: [template],
      alias: ALIAS,
      updatedAt: 99,
    });

    expect(candidate.baseContent).not.toMatch(/name: 直连/u);
    expect(candidate.baseContent).toContain('dialer-proxy: DIRECT');
    expect(candidate.baseContent).toContain('proxy: DIRECT');
    expect(candidate.baseContent).toContain('MATCH,DIRECT');
    expect(candidate.groups).toHaveLength(1);
    expect(candidate.groups[0].proxies).toEqual(['DIRECT', '节点 A']);
    expect(candidate.groups[0]['empty-fallback']).toBe('DIRECT');
    expect(candidate.rules.map((item) => [item.policy, item.enabled])).toEqual([
      ['DIRECT', undefined],
      ['DIRECT', false],
    ]);
    expect(candidate.summary).toMatchObject({
      groupMemberReferences: 1,
      inheritedTemplateOverrides: 1,
      enabledRulesTouched: 1,
      disabledRulesTouched: 1,
      baseProxyDialerReferences: 1,
      baseProviderReferences: 1,
      baseLiteralGroupReferences: 2,
      baseLiteralRuleReferences: 1,
    });
  });

  it.each(['select', 'url-test', 'fallback', 'load-balance', 'relay'])(
    'rewrites an orphaned top-level %s anchor left by legacy migration',
    (groupType) => {
      const legacyMembers = Array.from({ length: 9 }, (_, index) => `节点 ${index}`).join(', ');
      const candidate = buildDirectAliasCandidate({
        base: base(`
pr: &pr
  type: ${groupType}
  proxies: [${legacyMembers}, ${ALIAS}]
  dialer-proxy: ${ALIAS}
  empty-fallback: ${ALIAS}
  default-selected: ${ALIAS}
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
`),
        groups: [],
        rules: [],
        templates: [],
        alias: ALIAS,
        updatedAt: 99,
      });

      const migrated = parse(candidate.baseContent) as {
        pr: {
          proxies: string[];
          'dialer-proxy': string;
          'empty-fallback': string;
          'default-selected': string;
        };
        proxies: unknown[];
      };
      expect(migrated.proxies).toEqual([]);
      expect(migrated.pr.proxies[9]).toBe('DIRECT');
      expect(migrated.pr).toMatchObject({
        'dialer-proxy': 'DIRECT',
        'empty-fallback': 'DIRECT',
        'default-selected': 'DIRECT',
      });
      expect(candidate.summary.baseLiteralGroupReferences).toBe(4);
    },
  );

  it('keeps rejecting an unanchored group-shaped map at an unknown path', () => {
    expect(() =>
      buildDirectAliasCandidate({
        base: base(`
pr:
  type: select
  proxies: [${ALIAS}]
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
`),
        groups: [],
        rules: [],
        templates: [],
        alias: ALIAS,
      }),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({ errors: ['$.pr.proxies[0]'] }),
      }),
    );
  });

  it('keeps rejecting an anchored group template that still has an alias consumer', () => {
    expect(() =>
      buildDirectAliasCandidate({
        base: base(`
pr: &pr
  type: select
  proxies: [${ALIAS}]
legacy-copy: *pr
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
`),
        groups: [],
        rules: [],
        templates: [],
        alias: ALIAS,
      }),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({ errors: ['$.pr.proxies[0]'] }),
      }),
    );
  });

  it('returns a fixed safe error when deleting the node would orphan a YAML alias', () => {
    const secretAnchor = 'DO_NOT_REFLECT_SECRET_ANCHOR';
    const anchored = base(`
proxies:
  - &${secretAnchor}
    name: 直连
    type: direct
    udp: true
alias-copy: *${secretAnchor}
`);

    let error: unknown;
    try {
      buildDirectAliasCandidate({
        base: anchored,
        groups: [],
        rules: [],
        templates: [],
        alias: '直连',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as Error).message).toBe(
      'base.yaml 含有删除节点后无法解析的 YAML alias，已拒绝迁移。',
    );
    expect((error as Error).message).not.toContain(secretAnchor);
  });

  it('rejects a direct node with semantic fields without reflecting the field name', () => {
    const secretKey = 'credential-looking-secret-key';
    expect(() =>
      buildDirectAliasCandidate({
        base: base(`
proxies:
  - name: ${ALIAS}
    type: direct
    ${secretKey}: value
`),
        groups: [],
        rules: [],
        templates: [],
        alias: ALIAS,
      }),
    ).toThrowError(expect.objectContaining({ message: expect.not.stringContaining(secretKey) }));
  });

  it('rejects an exact alias left at an unknown path and returns only a safe path', () => {
    try {
      buildDirectAliasCandidate({
        base: base(`
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
custom:
  safe-field: ${ALIAS}
`),
        groups: [],
        rules: [],
        templates: [],
        alias: ALIAS,
      });
      throw new Error('expected migration to reject');
    } catch (error) {
      expect(error).toMatchObject({
        problem: {
          status: 422,
          errors: ['$.custom.safe-field'],
        },
      });
    }
  });

  it('rejects control characters in an alias before parsing config data', () => {
    expect(() =>
      buildDirectAliasCandidate({
        base: base('proxies: []\n'),
        groups: [],
        rules: [],
        templates: [],
        alias: 'bad\nname',
      }),
    ).toThrow(/控制字符/u);
  });
});

describe('buildLegacyProfileRepairCandidate', () => {
  it('merges alias rewrites and filter repairs when they touch the same group', () => {
    const us = group({
      name: '美国',
      filter: String.raw`(?i)(🇺🇸|\bUS\b|美)`,
    });
    const de = group({
      id: '55555555-5555-4555-8555-555555555555',
      name: '德国',
      proxies: [],
      filter: String.raw`(?i)(🇩🇪|\bDE\b|德)`,
    });
    const candidate = buildLegacyProfileRepairCandidate({
      base: base(`
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
`),
      groups: [us, de],
      rules: [],
      templates: [],
      alias: ALIAS,
      repairs: [
        {
          id: us.id,
          filter: '(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|美)',
        },
        {
          id: de.id,
          filter: '(?i)(🇩🇪|(?<![A-Za-z])DEU?(?![A-Za-z])|德)',
        },
      ],
      updatedAt: 99,
    });

    expect(candidate.groups).toHaveLength(2);
    expect(candidate.groups.find((item) => item.id === us.id)).toMatchObject({
      proxies: ['DIRECT', '节点 A'],
      filter: '(?i)(🇺🇸|(?<![A-Za-z])USA?(?![A-Za-z])|美)',
      updated_at: 99,
    });
    expect(candidate.groups.find((item) => item.id === de.id)?.filter).toContain('DEU?');
    expect(candidate.filterRepairBefore.map((item) => item.name)).toEqual(['美国', '德国']);
  });

  it('rejects using the recovery path for groups whose edited fields are already valid', () => {
    expect(() =>
      buildLegacyProfileRepairCandidate({
        base: base(`
proxies:
  - name: ${ALIAS}
    type: direct
    udp: true
`),
        groups: [
          group({ filter: '(?i)美国' }),
          group({
            id: '55555555-5555-4555-8555-555555555555',
            name: '德国',
            filter: '(?i)德国',
          }),
        ],
        rules: [],
        templates: [],
        alias: ALIAS,
        repairs: [
          { id: GROUP_ID, filter: '(?i)美国|USA' },
          { id: '55555555-5555-4555-8555-555555555555', filter: '(?i)德国|DEU' },
        ],
      }),
    ).toThrow(/当前没有被修复字段中的非法正则/u);
  });
});
