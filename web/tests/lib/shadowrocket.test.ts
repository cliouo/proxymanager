import { describe, expect, it } from 'vitest';
import { renderShadowrocket } from '@/lib/proxies/shadowrocket';

describe('Shadowrocket profile export', () => {
  it.each(['direct', 'global', null, 'unknown'])('rejects unsupported running mode %s', (mode) => {
    expect(() => renderShadowrocket({ mode, rules: ['MATCH,DIRECT'] })).toThrow(
      'Shadowrocket 配置无法转换：仅支持 rule 运行模式，其他运行模式的选路行为无法保留',
    );
  });

  it.each([undefined, 'rule'])('accepts rule mode and its default (%s)', (mode) => {
    expect(renderShadowrocket({ mode, rules: [] })).toContain('[Rule]');
  });

  it('preserves nested selector order, subscription scope and rule precedence', () => {
    const conf = renderShadowrocket({
      'proxy-groups': [
        {
          name: 'JP',
          type: 'url-test',
          'include-all-proxies': true,
          filter: '日本|JP',
          interval: 600,
        },
        { name: 'Codex', type: 'select', proxies: ['JP', 'DIRECT'] },
      ],
      rules: [
        'PROCESS-NAME,codex,Codex',
        'DOMAIN-SUFFIX,openai.com,Codex',
        'GEOIP,CN,DIRECT',
        'MATCH,JP',
      ],
    });
    expect(conf).toContain(
      'JP = url-test, ProxyManager-Nodes, use=true, policy-regex-filter=日本|JP, interval=600',
    );
    expect(conf).toContain('Codex = select, JP, DIRECT');
    expect(conf).toContain('omitted: 1');
    expect(conf).toContain('DOMAIN-SUFFIX,openai.com,Codex\nGEOIP,CN,DIRECT\nFINAL,JP');
  });

  it('rejects unsupported rules and config injection', () => {
    expect(() => renderShadowrocket({ rules: ['RULE-SET,external,DIRECT'] })).toThrow();
    expect(() => renderShadowrocket({ rules: ['MATCH,OK\n[Host]'] })).toThrow();
  });
});
