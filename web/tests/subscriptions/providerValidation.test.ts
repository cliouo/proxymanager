import { describe, expect, it } from 'vitest';
import {
  normaliseToClashProviderYaml,
  parseLocalProxies,
} from '@/lib/services/subscriptionFetcher';

describe('Clash provider structural validation', () => {
  it.each([
    ['non-object entry', 'proxies:\n  - FAKE_SECRET_DO_NOT_LOG'],
    ['missing type and endpoint', 'proxies:\n  - name: BROKEN'],
    ['missing endpoint', 'proxies:\n  - name: BROKEN\n    type: ss'],
    [
      'invalid port',
      'proxies:\n  - name: BROKEN\n    type: ss\n    server: edge.invalid\n    port: 70000',
    ],
  ])('rejects %s with a credential-free error', (_label, yaml) => {
    let thrown: unknown;
    try {
      normaliseToClashProviderYaml(yaml);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/proxy entry/i);
    expect((thrown as Error).message).not.toContain('FAKE_SECRET_DO_NOT_LOG');
    expect((thrown as Error).message).not.toContain('BROKEN');
  });

  it('rejects malformed local entries instead of silently dropping them', () => {
    expect(() =>
      parseLocalProxies(
        'proxies:\n  - { name: OK, type: ss, server: h.invalid, port: 8388 }\n  - FAKE_SECRET_DO_NOT_LOG\n',
      ),
    ).toThrow(/proxy entry/i);
  });

  it('accepts a structurally complete network proxy and endpoint-free built-ins', () => {
    const result = normaliseToClashProviderYaml(
      'proxies:\n' +
        '  - { name: SAFE, type: ss, server: h.invalid, port: 8388, cipher: aes-128-gcm, password: FAKE_ONLY }\n' +
        '  - { name: DIRECT-SAFE, type: direct }\n',
    );
    expect(result.proxyCount).toBe(2);
  });

  it('rejects an excessive YAML alias expansion before node validation', () => {
    const aliasBomb = [
      'a: &a [x,x,x,x,x,x,x,x,x]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'proxies: *c',
    ].join('\n');

    expect(() => normaliseToClashProviderYaml(aliasBomb)).toThrow(
      /subscription content format is not recognised/i,
    );
  });
});
