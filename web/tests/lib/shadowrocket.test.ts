import { describe, expect, it } from 'vitest';
import { renderShadowrocket } from '@/lib/proxies/shadowrocket';

describe('Shadowrocket profile export', () => {
  const node = { name: 'Exported', type: 'http', server: 'proxy.example', port: 8080 };

  it('resolves exported nodes, groups and built-in policies', () => {
    expect(renderShadowrocket({
      proxies: [node],
      'proxy-groups': [{ name: 'Exit', type: 'select', proxies: ['Exported', 'DIRECT', 'REJECT'] }],
      rules: ['DOMAIN,example.com,Exported', 'MATCH,Exit'],
    })).toContain('Exit = select, Exported, DIRECT, REJECT');
  });

  it.each([
    { ...node, name: 'Skipped', type: 'wireguard' },
    { ...node, name: 'Skipped', 'dialer-proxy': 'DIRECT' },
  ])('rejects skipped companion nodes in rule targets and explicit members (%s)', (skipped) => {
    for (const config of [
      { rules: ['MATCH,Skipped'] },
      { rules: ['DOMAIN,example.com,Skipped'] },
      { 'proxy-groups': [{ name: 'Exit', type: 'select', proxies: ['Skipped'] }] },
    ]) {
      expect(() => renderShadowrocket({ proxies: [node, skipped], ...config })).toThrow(
        '策略或节点「Skipped」不在导出的策略组或配套节点订阅中',
      );
    }
  });

  it('rejects unknown references even with an empty companion subscription', () => {
    expect(() => renderShadowrocket({ rules: ['MATCH,Missing'] })).toThrow('「Missing」');
  });

  it('normalizes lowercase rule types and space-padded fields through the shared parser', () => {
    const conf = renderShadowrocket({
      rules: [
        ' process-name , reader , DIRECT ',
        ' domain-suffix , example.com , DIRECT ',
        ' ip-cidr , 192.0.2.0/24 , REJECT , no-resolve ',
        ' match , DIRECT ',
      ],
    });
    expect(conf).toContain('Desktop process rules omitted: 1');
    expect(conf).toContain(
      'DOMAIN-SUFFIX,example.com,DIRECT\nIP-CIDR,192.0.2.0/24,REJECT,no-resolve\nFINAL,DIRECT',
    );
  });

  it('still rejects invalid rule parameters after parsing', () => {
    expect(() => renderShadowrocket({ rules: ['ip-cidr,192.0.2.0/24,DIRECT,bogus'] })).toThrow(
      '包含无效的分流规则',
    );
  });

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
