import { describe, expect, it } from 'vitest';
import { buildBase64Subscription, proxiesToShareUris } from '@/lib/proxies/clashToUri';
import { parseProxyUriList } from '@/lib/proxies/uriToClash';

/**
 * Clash 节点 → 分享链接序列化的往返测试:serialize → parse 回来的节点
 * 必须与输入语义一致(字段名与 uriToClash 的映射互逆)。另测诚实跳过:
 * 没有分享链接表示的协议 / 字段要进 skipped 并给原因,绝不静默丢参数。
 */

/** 序列化单个节点并断言解析回验后与期望一致。 */
function roundTrip(proxy: Record<string, unknown>): Record<string, unknown> {
  const { lines, skipped } = proxiesToShareUris([proxy]);
  expect(skipped).toEqual([]);
  expect(lines).toHaveLength(1);
  const parsed = parseProxyUriList(lines[0]);
  expect(parsed.errors).toEqual([]);
  expect(parsed.proxies).toHaveLength(1);
  return parsed.proxies[0];
}

describe('proxiesToShareUris 往返', () => {
  it('ss 基本节点(含中文名与特殊字符密码)', () => {
    const back = roundTrip({
      name: '香港 HK-01 ①',
      type: 'ss',
      server: 'hk.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'p@ss:word/加密+',
    });
    expect(back).toMatchObject({
      name: '香港 HK-01 ①',
      type: 'ss',
      server: 'hk.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'p@ss:word/加密+',
    });
  });

  it('ss + obfs 插件与 udp/tfo 标志', () => {
    const back = roundTrip({
      name: 'obfs 节点',
      type: 'ss',
      server: '1.2.3.4',
      port: 443,
      cipher: 'chacha20-ietf-poly1305',
      password: 'secret',
      udp: false,
      tfo: true,
      plugin: 'obfs',
      'plugin-opts': { mode: 'http', host: 'bing.com' },
    });
    expect(back).toMatchObject({
      udp: false,
      tfo: true,
      plugin: 'obfs',
      'plugin-opts': { mode: 'http', host: 'bing.com' },
    });
  });

  it('ss + v2ray-plugin websocket tls', () => {
    const back = roundTrip({
      name: 'ws 节点',
      type: 'ss',
      server: 'ws.example.com',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'pw',
      plugin: 'v2ray-plugin',
      'plugin-opts': { mode: 'websocket', tls: true, host: 'cdn.example.com', path: '/ws' },
    });
    expect(back).toMatchObject({
      plugin: 'v2ray-plugin',
      'plugin-opts': { mode: 'websocket', tls: true, host: 'cdn.example.com', path: '/ws' },
    });
  });

  it('ss + shadow-tls 插件', () => {
    const back = roundTrip({
      name: 'stls',
      type: 'ss',
      server: '9.9.9.9',
      port: 443,
      cipher: '2022-blake3-aes-128-gcm',
      password: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
      plugin: 'shadow-tls',
      'plugin-opts': { host: 'cloud.tencent.com', password: 'stls-pw', version: 3 },
    });
    expect(back).toMatchObject({
      plugin: 'shadow-tls',
      'plugin-opts': { host: 'cloud.tencent.com', password: 'stls-pw', version: 3 },
    });
  });

  it('ssr 含 obfs/protocol 参数', () => {
    const back = roundTrip({
      name: 'SSR 节点',
      type: 'ssr',
      server: 'ssr.example.com',
      port: 9000,
      cipher: 'aes-256-cfb',
      password: 'pw#1',
      obfs: 'tls1.2_ticket_auth',
      protocol: 'auth_aes128_md5',
      'obfs-param': 'download.windowsupdate.com',
      'protocol-param': '1234:abc',
    });
    expect(back).toMatchObject({
      type: 'ssr',
      cipher: 'aes-256-cfb',
      password: 'pw#1',
      obfs: 'tls1.2_ticket_auth',
      protocol: 'auth_aes128_md5',
      'obfs-param': 'download.windowsupdate.com',
      'protocol-param': '1234:abc',
    });
  });

  it('vmess ws + tls + early data', () => {
    const back = roundTrip({
      name: 'VMess WS',
      type: 'vmess',
      server: 'vm.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      tls: true,
      servername: 'cdn.example.com',
      'client-fingerprint': 'chrome',
      'skip-cert-verify': true,
      network: 'ws',
      'ws-opts': {
        path: '/ray',
        headers: { Host: 'cdn.example.com' },
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol',
      },
    });
    expect(back).toMatchObject({
      type: 'vmess',
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      tls: true,
      servername: 'cdn.example.com',
      'skip-cert-verify': true,
      network: 'ws',
      'ws-opts': {
        path: '/ray',
        headers: { Host: 'cdn.example.com' },
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol',
      },
    });
  });

  it('vmess grpc', () => {
    const back = roundTrip({
      name: 'VMess gRPC',
      type: 'vmess',
      server: '8.8.4.4',
      port: 2053,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 64,
      cipher: 'aes-128-gcm',
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'GunService' },
    });
    expect(back).toMatchObject({
      alterId: 64,
      cipher: 'aes-128-gcm',
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'GunService' },
    });
  });

  it('vless reality + vision flow', () => {
    const back = roundTrip({
      name: 'Reality 节点',
      type: 'vless',
      server: 'r.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      flow: 'xtls-rprx-vision',
      tls: true,
      servername: 'www.microsoft.com',
      'client-fingerprint': 'chrome',
      'reality-opts': {
        'public-key': 'SOln5thnzKmUyhrsvvNuTb2XCFY0w-Cy_lXbSIzHRnM',
        'short-id': '0123abcd',
      },
    });
    expect(back).toMatchObject({
      type: 'vless',
      flow: 'xtls-rprx-vision',
      tls: true,
      servername: 'www.microsoft.com',
      'client-fingerprint': 'chrome',
      'reality-opts': {
        'public-key': 'SOln5thnzKmUyhrsvvNuTb2XCFY0w-Cy_lXbSIzHRnM',
        'short-id': '0123abcd',
      },
    });
  });

  it('vless ws + tls(encryption 哨兵与 packet-encoding 默认往返)', () => {
    const back = roundTrip({
      name: 'VLESS WS',
      type: 'vless',
      server: 'v.example.com',
      port: 8443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      encryption: '',
      tls: true,
      'client-fingerprint': 'firefox',
      'packet-encoding': 'xudp',
      network: 'ws',
      'ws-opts': { path: '/vl', headers: { Host: 'v.example.com' } },
    });
    expect(back).toMatchObject({
      encryption: '',
      tls: true,
      'client-fingerprint': 'firefox',
      'packet-encoding': 'xudp',
      network: 'ws',
      'ws-opts': { path: '/vl', headers: { Host: 'v.example.com' } },
    });
  });

  it('trojan ws + 跳证书校验', () => {
    const back = roundTrip({
      name: 'Trojan 节点',
      type: 'trojan',
      server: 't.example.com',
      port: 443,
      password: 'trojan-pw@#',
      sni: 'cdn.example.org',
      'skip-cert-verify': true,
      alpn: ['h2', 'http/1.1'],
      network: 'ws',
      'ws-opts': { path: '/tj', headers: { Host: 'cdn.example.org' } },
    });
    expect(back).toMatchObject({
      type: 'trojan',
      password: 'trojan-pw@#',
      sni: 'cdn.example.org',
      'skip-cert-verify': true,
      alpn: ['h2', 'http/1.1'],
      network: 'ws',
      'ws-opts': { path: '/tj', headers: { Host: 'cdn.example.org' } },
    });
  });

  it('hysteria2 obfs + 端口跳跃', () => {
    const back = roundTrip({
      name: 'Hy2 节点',
      type: 'hysteria2',
      server: 'h2.example.com',
      port: 443,
      password: 'hy2-pass',
      sni: 'h2.example.com',
      obfs: 'salamander',
      'obfs-password': 'obfs-pw',
      ports: '20000-30000',
      'hop-interval': '30',
      up: '100 Mbps',
      down: '500 Mbps',
    });
    expect(back).toMatchObject({
      type: 'hysteria2',
      password: 'hy2-pass',
      obfs: 'salamander',
      'obfs-password': 'obfs-pw',
      ports: '20000-30000',
      'hop-interval': '30',
      up: '100 Mbps',
      down: '500 Mbps',
    });
  });

  it('hysteria2 纯端口跳跃(只有 ports 没有 port)走 authority 端口集', () => {
    const back = roundTrip({
      name: 'Hy2 跳跃',
      type: 'hysteria2',
      server: 'hk2.example.com',
      ports: '20200-20399',
      password: 'pw',
      sni: 'hk2.example.com',
    });
    // 解析侧取端口集首端口为初连端口。
    expect(back).toMatchObject({
      type: 'hysteria2',
      port: 20200,
      ports: '20200-20399',
      password: 'pw',
      sni: 'hk2.example.com',
    });
  });

  it('hysteria v1(up/down 必带)', () => {
    const back = roundTrip({
      name: 'Hy1',
      type: 'hysteria',
      server: 'h1.example.com',
      port: 443,
      'auth-str': 'auth-token',
      sni: 'h1.example.com',
      up: '50',
      down: '200',
      'skip-cert-verify': true,
    });
    expect(back).toMatchObject({
      type: 'hysteria',
      'auth-str': 'auth-token',
      up: '50',
      down: '200',
      'skip-cert-verify': true,
    });
  });

  it('tuic v5', () => {
    const back = roundTrip({
      name: 'TUIC 节点',
      type: 'tuic',
      server: 'tu.example.com',
      port: 8443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      password: 'tuic:pw@x',
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
      alpn: ['h3'],
    });
    expect(back).toMatchObject({
      type: 'tuic',
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      password: 'tuic:pw@x',
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
      alpn: ['h3'],
    });
  });

  it('anytls', () => {
    const back = roundTrip({
      name: 'AnyTLS',
      type: 'anytls',
      server: 'a.example.com',
      port: 443,
      password: 'anytls-pw',
      sni: 'a.example.com',
      'client-fingerprint': 'chrome',
      udp: true,
    });
    expect(back).toMatchObject({
      type: 'anytls',
      password: 'anytls-pw',
      sni: 'a.example.com',
      'client-fingerprint': 'chrome',
      udp: true,
    });
  });

  it('snell v4 + obfs', () => {
    const back = roundTrip({
      name: 'Snell',
      type: 'snell',
      server: 's.example.com',
      port: 6160,
      psk: 'snell-psk',
      version: 4,
      'obfs-opts': { mode: 'tls', host: 'gateway.icloud.com' },
    });
    expect(back).toMatchObject({
      type: 'snell',
      psk: 'snell-psk',
      version: 4,
      'obfs-opts': { mode: 'tls', host: 'gateway.icloud.com' },
    });
  });

  it('socks5 带认证(用户名恰似 base64 也不误解)', () => {
    const back = roundTrip({
      name: 'SOCKS 节点',
      type: 'socks5',
      server: '10.0.0.1',
      port: 1080,
      username: 'dXNlcjpwYXNz',
      password: 'p@ss',
    });
    expect(back).toMatchObject({
      type: 'socks5',
      username: 'dXNlcjpwYXNz',
      password: 'p@ss',
    });
  });

  it('https 代理(tls + sni)', () => {
    const back = roundTrip({
      name: 'HTTPS 代理',
      type: 'http',
      server: 'proxy.example.com',
      port: 8443,
      username: 'u',
      password: 'p',
      tls: true,
      sni: 'proxy.example.com',
    });
    expect(back).toMatchObject({
      type: 'http',
      username: 'u',
      password: 'p',
      tls: true,
      sni: 'proxy.example.com',
    });
  });

  it('IPv6 服务器进方括号', () => {
    const back = roundTrip({
      name: 'v6 节点',
      type: 'trojan',
      server: '2001:db8::1',
      port: 443,
      password: 'pw',
    });
    expect(back).toMatchObject({ server: '2001:db8::1', port: 443 });
  });
});

describe('proxiesToShareUris 诚实跳过', () => {
  it('没有通用分享链接格式的协议', () => {
    const { lines, skipped } = proxiesToShareUris([
      { name: 'WG', type: 'wireguard', server: '1.1.1.1', port: 51820 },
      { name: 'Mieru', type: 'mieru', server: '1.1.1.2', port: 3000 },
    ]);
    expect(lines).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0].reason).toContain('没有通用分享链接格式');
  });

  it('dialer-proxy 链式前置必须跳过而不是丢参数', () => {
    const { lines, skipped } = proxiesToShareUris([
      {
        name: '链式出口',
        type: 'trojan',
        server: 't.example.com',
        port: 443,
        password: 'pw',
        'dialer-proxy': '前置池',
      },
    ]);
    expect(lines).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('dialer-proxy');
  });

  it('未知 ss 插件跳过并给原因', () => {
    const { lines, skipped } = proxiesToShareUris([
      {
        name: 'restls',
        type: 'ss',
        server: '1.2.3.4',
        port: 443,
        cipher: 'aes-256-gcm',
        password: 'pw',
        plugin: 'restls',
        'plugin-opts': { host: 'x' },
      },
    ]);
    expect(lines).toEqual([]);
    expect(skipped[0].reason).toContain('restls');
  });

  it('tuic uuid 不是标准 UUID 时给出明确原因', () => {
    const { lines, skipped } = proxiesToShareUris([
      {
        name: 'token 型 tuic',
        type: 'tuic',
        server: 'tw1.example.com',
        port: 8080,
        uuid: 'not-a-uuid-token',
        password: 'not-a-uuid-token',
      },
    ]);
    expect(lines).toEqual([]);
    expect(skipped[0].reason).toContain('不是标准 UUID');
  });

  it('非 vision 的 vless flow 跳过', () => {
    const { skipped } = proxiesToShareUris([
      {
        name: 'flow',
        type: 'vless',
        server: 'v.example.com',
        port: 443,
        uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
        flow: 'xtls-rprx-direct',
      },
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('flow');
  });

  it('跳过不影响其余节点导出', () => {
    const { lines, skipped } = proxiesToShareUris([
      { name: 'WG', type: 'wireguard', server: '1.1.1.1', port: 51820 },
      { name: 'OK', type: 'socks5', server: '10.0.0.1', port: 1080 },
    ]);
    expect(lines).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});

describe('buildBase64Subscription', () => {
  it('正文是逐行分享链接的 base64,可解码还原', () => {
    const result = buildBase64Subscription([
      { name: 'A', type: 'socks5', server: '10.0.0.1', port: 1080 },
      { name: 'B', type: 'trojan', server: 't.example.com', port: 443, password: 'pw' },
    ]);
    expect(result.lineCount).toBe(2);
    expect(result.skipped).toEqual([]);
    const text = Buffer.from(result.content, 'base64').toString('utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('socks5://')).toBe(true);
    expect(lines[1].startsWith('trojan://')).toBe(true);
    // 整包再过一遍解析器:两条全部有效。
    const parsed = parseProxyUriList(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.proxies.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('空列表得到空正文', () => {
    const result = buildBase64Subscription([]);
    expect(result.content).toBe('');
    expect(result.lineCount).toBe(0);
  });
});
