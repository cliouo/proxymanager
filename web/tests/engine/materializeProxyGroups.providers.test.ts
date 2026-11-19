import { describe, expect, it } from 'vitest';
import { materializeDynamicProxyGroups } from '@/lib/engine/materializeProxyGroups';
import { validateFinalRenderedConfig } from '@/lib/engine/resolve';

describe('provider-dependent materialization', () => {
  it.each([
    'include-all: true',
    'include-all-proxies: true, use: [remote]',
    'include-all-proxies: true, include-all-providers: true',
  ])('preserves provider-dependent membership (%s)', (fields) => {
    const content = `proxies:
  - {name: A, type: http, server: a.example, port: 8080}
proxy-providers:
  remote: {type: http, url: https://example.test/proxies.yaml, path: ./remote.yaml}
proxy-groups:
  - {name: Exit, type: select, ${fields}, empty-fallback: REJECT}
rules: ["MATCH,Exit"]
`;
    validateFinalRenderedConfig(content);
    expect(materializeDynamicProxyGroups(content)).toBe(content);
  });
});
