import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

vi.mock('@/lib/repos/rulesRepo', () => ({
  listRules: vi.fn(async () => []),
}));
vi.mock('@/lib/repos/ruleSetsRepo', () => ({
  listRuleSets: vi.fn(async () => []),
}));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({
  listProxyGroups: vi.fn(async () => []),
}));
vi.mock('@/lib/repos/resolvedRepo', () => ({
  invalidateResolvedSnapshot: vi.fn(async () => undefined),
  setResolvedSnapshot: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/subscriptionFetcher', () => ({
  resolveSubscriptionProxies: vi.fn(),
}));

import { BaseParseError, parseBase } from '@/lib/engine/parser';
import { resolveConfig } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
import { parseAndValidate } from '@/lib/services/baseService';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import type { Rule } from '@/schemas';

const INVALID_YAML_MESSAGE = 'Invalid base YAML';
const INVALID_ROOT_MESSAGE = 'Invalid base YAML: root must be a mapping';
const INVALID_MERGE_MESSAGE = 'Invalid base YAML: merge keys are not supported';
const FAKE_SECRET = 'FAKE_SECRET_DO_NOT_USE';
const MALFORMED_WITH_FAKE_SECRET = `proxies:
  - { name: fake, type: ss, server: edge.invalid, port: 8388, cipher: aes-128-gcm, password: ${FAKE_SECRET}, broken: [ }
`;
const MARKER_ONLY_RULES = `mode: rule
rules:
  # === ANCHOR: prelude ===
  # === ANCHOR: manual ===
  # === ANCHOR: late ===
`;
const MANAGED_MATCH_RULE: Rule = {
  id: '11111111-1111-4111-8111-111111111111',
  anchor: 'manual',
  type: 'MATCH',
  value: '',
  policy: 'DIRECT',
  rank: 10,
  source: 'manual',
  added_at: 1,
  updated_at: 1,
};

function captureSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw');
}

async function captureAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

beforeEach(() => {
  vi.mocked(resolveSubscriptionProxies).mockReset();
});

describe('base parser input boundary', () => {
  it('accepts a mapping root', () => {
    const parsed = parseBase('{}');

    expect(parsed.policies).toContain('DIRECT');
  });

  it('accepts the canonical marker-only managed rules placeholder', () => {
    const parsed = parseBase(MARKER_ONLY_RULES);

    expect(parsed.anchors).toEqual(['prelude', 'manual', 'late']);
  });

  it.each([
    ['missing anchor', 'rules:\n'],
    ['explicit null', 'rules: null\n  # === ANCHOR: manual ===\n'],
    ['tilde null', 'rules: ~\n  # === ANCHOR: manual ===\n'],
    ['tagged null', 'rules: !!null\n  # === ANCHOR: manual ===\n'],
    ['anchored null', 'rules: &managed\n  # === ANCHOR: manual ===\n'],
    ['inline marker', 'rules: # === ANCHOR: manual ===\n'],
    ['marker outside rules', 'rules:\ndns:\n  # === ANCHOR: manual ===\n  enable: true\n'],
  ])('rejects a %s as a managed rules placeholder', (_label, content) => {
    const error = captureSync(() => parseBase(content));

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toBe('Invalid base YAML: "rules" must be a sequence');
  });

  it.each([
    ['sequence', '- one\n- two\n'],
    ['string scalar', 'hello\n'],
    ['null scalar', 'null\n'],
    ['empty document', ''],
  ])('rejects a %s with the fixed root-shape error', (_label, content) => {
    const error = captureSync(() => parseBase(content));

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toBe(INVALID_ROOT_MESSAGE);
  });

  it('does not retain a YAML source line or credential in a syntax error', () => {
    const error = captureSync(() => parseBase(MALFORMED_WITH_FAKE_SECRET));

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toBe(INVALID_YAML_MESSAGE);
    expect(Reflect.get(error as object, 'cause')).toBeUndefined();
    expect(String(error)).not.toContain(FAKE_SECRET);
  });

  it.each([
    ['proxies', 'mapping', 'proxies: {}\n'],
    ['proxy-groups', 'mapping', 'proxy-groups: {}\n'],
    ['rules', 'mapping', 'rules: {}\n'],
    ['proxy-providers', 'sequence', 'proxy-providers: []\n'],
    ['rule-providers', 'sequence', 'rule-providers: []\n'],
  ])('rejects a %s %s with a fixed section-shape error', (section, _shape, content) => {
    const error = captureSync(() => parseBase(content));

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toMatch(
      new RegExp(`^Invalid base YAML: "${section}" must be a (sequence|mapping)$`),
    );
    expect((error as Error).message).not.toContain(FAKE_SECRET);
  });

  it('rejects an invalid literal proxy without reflecting its fields', () => {
    const error = captureSync(() =>
      parseBase(`proxies:
  - name: FAKE_NODE_NAME_DO_NOT_LOG
    type: unknown-secret-type
    password: ${FAKE_SECRET}
`),
    );

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toContain('index 0: field "type"');
    expect((error as BaseParseError).issue).toMatchObject({
      code: 'base_proxy_invalid',
      section: 'proxies',
      path: 'proxies[0].type',
      resource: 'base.yaml',
    });
    expect((error as Error).message).not.toContain('FAKE_');
    expect((error as Error).message).not.toContain('unknown-secret-type');
  });

  it('accepts inert udp on direct but reports unknown proxy fields with a hidden path', () => {
    // 2026-07-18 leniency: mihomo's decoder silently drops `udp` on direct.
    expect(() =>
      parseBase(`proxies:
  - name: local-direct
    type: direct
    udp: true
`),
    ).not.toThrow();

    const error = captureSync(() =>
      parseBase(`proxies:
  - name: local-direct
    type: direct
    FAKE_unknown-field: true
`),
    );

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toContain(
      'field "proxy" contains an unsupported top-level field',
    );
    expect((error as BaseParseError).issue).toEqual({
      code: 'base_proxy_invalid',
      message: (error as Error).message,
      section: 'proxies',
      path: 'proxies[0].proxy',
      resource: 'base.yaml',
    });
    expect((error as Error).message).not.toContain('local-direct');
    expect((error as Error).message).not.toContain('FAKE_');
  });

  it('rejects YAML merge keys before inherited contextual references can bypass validation', () => {
    const merged = [
      'defaults: &defaults',
      '  force-domain: ["rule-set:ghost"]',
      'sniffer:',
      '  <<: *defaults',
    ].join('\n');
    const error = captureSync(() => parseBase(merged));

    expect(error).toBeInstanceOf(BaseParseError);
    expect((error as Error).message).toBe(INVALID_MERGE_MESSAGE);
  });

  it('distinguishes fixed merge syntax from an ordinary quoted << key', () => {
    expect(() => parseBase('metadata:\n  "<<": literal\n')).not.toThrow();
    expect(() => parseBase('metadata:\n  !!str <<: literal\n')).not.toThrow();
    const error = captureSync(() => parseBase('metadata:\n  !!merge "<<": { hidden: true }\n'));
    expect((error as Error).message).toBe(INVALID_MERGE_MESSAGE);
    const localTagError = captureSync(() => parseBase('metadata:\n  ! "<<": { hidden: true }\n'));
    expect((localTagError as Error).message).toBe(INVALID_MERGE_MESSAGE);
  });
});

describe('base save/validate boundary', () => {
  it('returns a credential-free 422 for malformed YAML', async () => {
    const error = await captureAsync(parseAndValidate('default', MALFORMED_WITH_FAKE_SECRET));

    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problem.status).toBe(422);
    expect((error as ProblemDetailsError).problem.errors).toEqual([
      {
        code: 'base_yaml_invalid',
        message: INVALID_YAML_MESSAGE,
        section: 'base',
        path: '$',
        resource: 'base.yaml',
      },
    ]);
    expect((error as Error).message).toBe(INVALID_YAML_MESSAGE);
    expect(String(error)).not.toContain(FAKE_SECRET);
  });

  it('rejects a non-mapping root before repository validation', async () => {
    const error = await captureAsync(parseAndValidate('default', '[]\n'));

    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as Error).message).toBe(INVALID_ROOT_MESSAGE);
  });

  it('rejects a wrong-typed known section before repository validation', async () => {
    const error = await captureAsync(parseAndValidate('default', 'rules: {}\n'));

    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as Error).message).toBe('Invalid base YAML: "rules" must be a sequence');
  });
});

describe('resolved-config legacy defense', () => {
  it('continues to render a mapping root', async () => {
    const result = await resolveConfig('{}\n', [], [], [], [], { persistSnapshot: false });

    expect(parseYaml(result.content)).toEqual({});
  });

  it('materialises managed rules into a marker-only base before final validation', async () => {
    const result = await resolveConfig(MARKER_ONLY_RULES, [MANAGED_MATCH_RULE], [], [], [], {
      persistSnapshot: false,
    });

    expect(parseYaml(result.content)).toMatchObject({ rules: ['MATCH,DIRECT'] });
  });

  it('still rejects a marker-only final config when no active rule is materialised', async () => {
    const error = await captureAsync(
      resolveConfig(MARKER_ONLY_RULES, [], [], [], [], { persistSnapshot: false }),
    );

    expect((error as Error).message).toBe(
      'Full config render rejected: the final YAML document is invalid.',
    );
  });

  it.each([
    ['sequence', '[]\n'],
    ['scalar', 'hello\n'],
  ])('rejects a stored %s root before rendering', async (_label, content) => {
    const error = await captureAsync(
      resolveConfig(content, [], [], [], [], { persistSnapshot: false }),
    );

    expect((error as Error).message).toBe(INVALID_ROOT_MESSAGE);
    expect(resolveSubscriptionProxies).not.toHaveBeenCalled();
  });

  it('does not echo a credential from malformed stored YAML', async () => {
    const error = await captureAsync(
      resolveConfig(MALFORMED_WITH_FAKE_SECRET, [], [], [], [], {
        persistSnapshot: false,
      }),
    );

    expect((error as Error).message).toBe(INVALID_YAML_MESSAGE);
    expect(String(error)).not.toContain(FAKE_SECRET);
  });

  it('rejects a wrong-typed stored section before rendering', async () => {
    const error = await captureAsync(
      resolveConfig('proxy-groups: {}\n', [], [], [], [], { persistSnapshot: false }),
    );

    expect((error as Error).message).toBe('Invalid base YAML: "proxy-groups" must be a sequence');
    expect(resolveSubscriptionProxies).not.toHaveBeenCalled();
  });

  it('rejects a stored YAML merge before the render collectors run', async () => {
    const merged = [
      'defaults: &defaults',
      '  nameserver-policy:',
      '    "rule-set:ghost": [https://dns.example/dns-query]',
      'dns:',
      '  <<: *defaults',
    ].join('\n');
    const error = await captureAsync(
      resolveConfig(merged, [], [], [], [], { persistSnapshot: false }),
    );

    expect((error as Error).message).toBe(INVALID_MERGE_MESSAGE);
    expect(resolveSubscriptionProxies).not.toHaveBeenCalled();
  });
});
