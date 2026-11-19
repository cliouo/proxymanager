import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { materializeDynamicProxyGroups } from '@/lib/engine/materializeProxyGroups';
import { validateFinalRenderedConfig } from '@/lib/engine/resolve';

describe('materialization review regressions', () => {
  it('filters explicit exclusions before using the fallback, without applying the positive filter to explicit members', () => {
    const content = `proxies:
  - {name: HK-1, type: http, server: hk.example, port: 8080}
proxy-groups:
  - {name: HK, type: select, proxies: [DIRECT, HK-1], include-all-proxies: true, filter: ^JP, exclude-filter: ^HK, exclude-type: Direct, empty-fallback: REJECT}
`;
    const output = materializeDynamicProxyGroups(content);
    expect(parse(output)['proxy-groups'][0]).toEqual({
      name: 'HK',
      type: 'select',
      proxies: ['REJECT'],
    });
    validateFinalRenderedConfig(output);
    const explicit = materializeDynamicProxyGroups(content.replace('exclude-type: Direct, ', ''));
    expect(parse(explicit)['proxy-groups'][0].proxies).toEqual(['DIRECT']);
  });

  it('maps Shadowsocks adapter names and keeps only nonexcluded nodes', () => {
    const content = `proxies:
  - {name: HK-SS, type: ss, server: ss.example, port: 8388, cipher: aes-128-gcm, password: p}
  - {name: HK-HTTP, type: http, server: http.example, port: 8080}
proxy-groups:
  - {name: HK, type: select, include-all-proxies: true, filter: HK, exclude-type: Shadowsocks, empty-fallback: REJECT}
`;
    const output = materializeDynamicProxyGroups(content);
    expect(parse(output)['proxy-groups'][0]).toEqual({
      name: 'HK',
      type: 'select',
      proxies: ['HK-HTTP'],
    });
    validateFinalRenderedConfig(output);
  });
  it('uses REJECT when exclude-type removes every matched node', () => {
    const content = `proxies:
  - {name: HK-1, type: http, server: hk.example, port: 8080}
proxy-groups:
  - {name: HK, type: select, include-all-proxies: true, filter: HK, exclude-type: hTtP, empty-fallback: REJECT}
rules: ["MATCH,HK"]
`;
    validateFinalRenderedConfig(content);
    const output = materializeDynamicProxyGroups(content);
    expect(parse(output)['proxy-groups'][0]).toEqual({
      name: 'HK',
      type: 'select',
      proxies: ['REJECT'],
    });
    validateFinalRenderedConfig(output);
  });
});
