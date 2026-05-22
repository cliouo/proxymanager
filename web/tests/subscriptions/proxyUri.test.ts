import { describe, expect, it } from 'vitest';
import {
  looksLikeProxyUriList,
  parseProxyUriList,
  tryBase64Decode,
} from '@/lib/proxies/uriToClash';
import { normaliseToClashProviderYaml } from '@/lib/services/subscriptionFetcher';

describe('looksLikeProxyUriList', () => {
  it('matches a single ss:// line', () => {
    expect(looksLikeProxyUriList('ss://YWVzLTI1Ni1nY206cGFzcw==@h.com:8388#x')).toBe(true);
  });
  it('matches when surrounded by comments', () => {
    const text = '# my airport\n// 2025-05-01\nvmess://eyJ2IjoiMiJ9\n';
    expect(looksLikeProxyUriList(text)).toBe(true);
  });
  it('rejects plain YAML', () => {
    expect(looksLikeProxyUriList('proxies:\n  - name: x\n    type: ss')).toBe(false);
  });
  it('rejects random text without scheme', () => {
    expect(looksLikeProxyUriList('mixed-port: 7890\n')).toBe(false);
  });
});

describe('tryBase64Decode', () => {
  it('decodes URL-safe base64 with missing padding', () => {
    const original = 'ss://aaa@b:1#x\nvmess://eyJhIjoxfQ';
    const encoded = Buffer.from(original, 'utf-8').toString('base64url');
    expect(tryBase64Decode(encoded)).toBe(original);
  });
  it('returns null on non-base64 input', () => {
    expect(tryBase64Decode('mixed-port: 7890')).toBeNull();
    expect(tryBase64Decode('not base 64!')).toBeNull();
  });
  it('returns null on too-short blobs', () => {
    expect(tryBase64Decode('abc')).toBeNull();
  });
});

describe('parseProxyUriList per protocol', () => {
  it('parses ss:// SIP002', () => {
    // method=aes-256-gcm, password=secret123
    const userinfo = Buffer.from('aes-256-gcm:secret123', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@hk.example.com:8388#HK-01`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'HK-01',
      type: 'ss',
      server: 'hk.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'secret123',
      udp: true,
    });
  });

  it('parses ss:// with plugin=obfs-local', () => {
    const userinfo = Buffer.from('chacha20:abc', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@h.com:443/?plugin=obfs-local;obfs=tls;obfs-host=cdn.com#X`;
    const { proxies } = parseProxyUriList(uri);
    expect(proxies[0]).toMatchObject({
      type: 'ss',
      plugin: 'obfs',
      'plugin-opts': { mode: 'tls', host: 'cdn.com' },
    });
  });

  it('parses ssr://', () => {
    const password = Buffer.from('pwd', 'utf-8').toString('base64');
    const remarks = Buffer.from('MY-SSR', 'utf-8').toString('base64');
    const obfsParam = Buffer.from('foo.com', 'utf-8').toString('base64');
    const main = `host.com:443:auth_chain_a:aes-256-cfb:tls1.2_ticket_auth:${password}`;
    const query = `obfsparam=${obfsParam}&remarks=${remarks}`;
    const ssrBody = Buffer.from(`${main}/?${query}`, 'utf-8').toString('base64');
    const uri = `ssr://${ssrBody}`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'MY-SSR',
      type: 'ssr',
      server: 'host.com',
      port: 443,
      cipher: 'aes-256-cfb',
      protocol: 'auth_chain_a',
      obfs: 'tls1.2_ticket_auth',
      password: 'pwd',
      'obfs-param': 'foo.com',
    });
  });

  it('parses vmess:// (V2RayN JSON base64)', () => {
    const payload = {
      v: '2',
      ps: 'JP-Tokyo',
      add: 'jp.example.com',
      port: '443',
      id: '11111111-2222-3333-4444-555555555555',
      aid: '0',
      scy: 'auto',
      net: 'ws',
      host: 'cdn.example.com',
      path: '/ray',
      tls: 'tls',
      sni: 'sni.example.com',
    };
    const uri = `vmess://${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'JP-Tokyo',
      type: 'vmess',
      server: 'jp.example.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      alterId: 0,
      cipher: 'auto',
      tls: true,
      servername: 'sni.example.com',
      network: 'ws',
      'ws-opts': { path: '/ray', headers: { Host: 'cdn.example.com' } },
    });
  });

  it('parses vless:// with reality', () => {
    const uri =
      'vless://uuid-abc@example.com:443?encryption=none&security=reality&type=tcp&sni=sni.example&fp=chrome&pbk=PBKKEY&sid=ab12&flow=xtls-rprx-vision#VL-Reality';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'VL-Reality',
      type: 'vless',
      server: 'example.com',
      port: 443,
      uuid: 'uuid-abc',
      flow: 'xtls-rprx-vision',
      tls: true,
      servername: 'sni.example',
      'client-fingerprint': 'chrome',
      network: 'tcp',
      'reality-opts': { 'public-key': 'PBKKEY', 'short-id': 'ab12' },
    });
  });

  it('parses trojan:// with ws', () => {
    const uri =
      'trojan://pa%23ss@trojan.example:443?sni=cdn.example&type=ws&path=%2Ftj&host=cdn.example#TJ-WS';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'TJ-WS',
      type: 'trojan',
      server: 'trojan.example',
      port: 443,
      password: 'pa#ss',
      sni: 'cdn.example',
      network: 'ws',
      'ws-opts': { path: '/tj', headers: { Host: 'cdn.example' } },
    });
  });

  it('parses hysteria2:// (and accepts hy2://)', () => {
    const uri =
      'hy2://pa55@hy.example:8443?sni=hy.example&insecure=1&obfs=salamander&obfs-password=ss#hy2node';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'hy2node',
      type: 'hysteria2',
      server: 'hy.example',
      port: 8443,
      password: 'pa55',
      sni: 'hy.example',
      'skip-cert-verify': true,
      obfs: 'salamander',
      'obfs-password': 'ss',
    });
  });

  it('parses tuic://', () => {
    const uri =
      'tuic://uuid-xx:pass-yy@tuic.example:8443?sni=tuic.example&congestion_control=bbr&udp_relay_mode=native&alpn=h3#TUIC';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'TUIC',
      type: 'tuic',
      server: 'tuic.example',
      port: 8443,
      uuid: 'uuid-xx',
      password: 'pass-yy',
      sni: 'tuic.example',
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
      alpn: ['h3'],
    });
  });

  it('parses socks5:// with plain user:pass', () => {
    const uri = 'socks5://alice:secret@1.2.3.4:1080#sk5';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'sk5',
      type: 'socks5',
      server: '1.2.3.4',
      port: 1080,
      username: 'alice',
      password: 'secret',
      udp: true,
    });
  });

  it('parses http:// proxy', () => {
    const uri = 'http://user:pw@hp.example:8080#hp';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'hp',
      type: 'http',
      server: 'hp.example',
      port: 8080,
      username: 'user',
      password: 'pw',
    });
  });

  it('parses snell://', () => {
    const uri = 'snell://psk-aaa@s.example:443?obfs=http&obfs-host=fake.com&version=4#snl';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'snl',
      type: 'snell',
      server: 's.example',
      port: 443,
      psk: 'psk-aaa',
      version: 4,
      'obfs-opts': { mode: 'http', host: 'fake.com' },
    });
  });

  it('ss://: parses TLS + ws transport with ed early-data', () => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@h.com:443?security=tls&sni=cdn.com&alpn=h2%2Chttp%2F1.1&fp=chrome&type=ws&path=%2Fws%3Fed%3D2048&host=cdn.com&udp=1&tfo=1&uot=1#X`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'ss',
      tls: true,
      sni: 'cdn.com',
      'client-fingerprint': 'chrome',
      alpn: ['h2', 'http/1.1'],
      network: 'ws',
      udp: true,
      tfo: true,
      'udp-over-tcp': true,
      'ws-opts': {
        path: '/ws',
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol',
        headers: { Host: 'cdn.com' },
      },
    });
  });

  it('ss://: parses httpupgrade as ws + v2ray-http-upgrade flag', () => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@h.com:80?type=httpupgrade&path=%2Fup&host=cdn.com#X`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'ss',
      network: 'ws',
      'ws-opts': {
        path: '/up',
        'v2ray-http-upgrade': true,
        headers: { Host: 'cdn.com' },
      },
    });
  });

  it('ss://: parses Reality wrapper', () => {
    const userinfo = Buffer.from('chacha20-ietf-poly1305:pw', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@h.com:443?security=reality&sni=cdn.example&pbk=PBK&sid=ab12#X`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'ss',
      tls: true,
      sni: 'cdn.example',
      'reality-opts': { 'public-key': 'PBK', 'short-id': 'ab12' },
    });
  });

  it('ss://: ?udp=0 overrides Clash default', () => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@h.com:443?udp=0#X`;
    const { proxies } = parseProxyUriList(uri);
    expect(proxies[0].udp).toBe(false);
  });

  it('ss://: Shadowrocket shadow-tls via query param', () => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const stPayload = Buffer.from(
      JSON.stringify({ host: 'fake.com', password: 'sec', version: 3, address: 'real.com', port: 8443 }),
      'utf-8',
    ).toString('base64');
    const uri = `ss://${userinfo}@h.com:443?shadow-tls=${encodeURIComponent(stPayload)}#X`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'ss',
      server: 'real.com',
      port: 8443,
      plugin: 'shadow-tls',
      'plugin-opts': { host: 'fake.com', password: 'sec', version: 3 },
    });
  });

  it('vless://: alpn comma encoded as %2C decodes correctly', () => {
    const uri =
      'vless://uuid-abc@h.com:443?encryption=none&security=tls&sni=h.com&alpn=h2%2Chttp%2F1.1#X';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].alpn).toEqual(['h2', 'http/1.1']);
  });

  it('parses anytls://', () => {
    const uri =
      'anytls://pwd-123@anytls.example:8443?sni=anytls.example&alpn=h2%2Chttp%2F1.1&insecure=1&fp=chrome&udp=1&idle-session-check-interval=30#AT-1';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'AT-1',
      type: 'anytls',
      server: 'anytls.example',
      port: 8443,
      password: 'pwd-123',
      sni: 'anytls.example',
      alpn: ['h2', 'http/1.1'],
      'skip-cert-verify': true,
      'client-fingerprint': 'chrome',
      udp: true,
      'idle-session-check-interval': '30',
    });
  });

  it('parses anytls:// with default port 443 and ?udp=0', () => {
    const uri = 'anytls://pwd@h.com?sni=h.com&udp=0#X';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'anytls',
      server: 'h.com',
      port: 443,
      udp: false,
    });
  });

  it('parses wireguard:// (and wg:// alias)', () => {
    const priv = encodeURIComponent('aP+xQzG/Tz9+xQzG/Tz9+xQzG/Tz9+xQzG/Tz9=');
    const addrs = encodeURIComponent('10.0.0.2/32,fd00::2/128');
    const reserved = encodeURIComponent('1,2,3');
    const uriA = `wireguard://${priv}@wg.example:51820?publickey=PUBKEY&address=${addrs}&mtu=1420&reserved=${reserved}#WG-1`;
    const uriB = `wg://${priv}@wg.example?publickey=PUBKEY&address=10.0.0.5%2F24#WG-2`;
    const { proxies, errors } = parseProxyUriList(`${uriA}\n${uriB}`);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'WG-1',
      type: 'wireguard',
      server: 'wg.example',
      port: 51820,
      'private-key': 'aP+xQzG/Tz9+xQzG/Tz9+xQzG/Tz9+xQzG/Tz9=',
      'public-key': 'PUBKEY',
      ip: '10.0.0.2',
      'ip-cidr': 32,
      ipv6: 'fd00::2',
      'ipv6-cidr': 128,
      mtu: 1420,
      reserved: [1, 2, 3],
      udp: true,
    });
    expect(proxies[1]).toMatchObject({
      name: 'WG-2',
      type: 'wireguard',
      port: 51820, // wg:// default
      ip: '10.0.0.5',
      'ip-cidr': 24,
    });
  });

  it('hysteria2://: port-hopping in host (host:443,8443-8500)', () => {
    const uri =
      'hy2://pwd@h.com:443,8443-8500?sni=h.com&insecure=1&fastopen=1#PH';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'hysteria2',
      server: 'h.com',
      port: 443,
      ports: '443,8443-8500',
      sni: 'h.com',
      'skip-cert-verify': true,
      tfo: true,
    });
  });

  it('hysteria2://: ?mport / ?peer / ?obfs=none / ?hop-interval / ?keepalive / ?upmbps', () => {
    const uri =
      'hy2://pwd@h.com:8443?peer=cdn.com&obfs=none&mport=20000-30000&hop-interval=30&keepalive=15&upmbps=200&downmbps=500#H';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    const p = proxies[0];
    expect(p).toMatchObject({
      type: 'hysteria2',
      sni: 'cdn.com', // peer fallback
      ports: '20000-30000',
      'hop-interval': '30',
      keepalive: 15,
      up: '200',
      down: '500',
    });
    expect(p.obfs).toBeUndefined(); // obfs=none not written
  });

  it('anytls://: ?peer fallback to sni', () => {
    const uri = 'anytls://pwd@h.com:8443?peer=cdn.com#AT-peer';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].sni).toBe('cdn.com');
  });

  it('passes through a real-world Sub-Store provider response (yaml + json items)', () => {
    const sample = [
      'proxies:',
      '  - {"type":"anytls","name":"node-1","server":"a.com","port":443,"password":"p1","sni":"a.com","skip-cert-verify":true,"udp":true,"xudp":true}',
      '  - {"type":"vless","name":"node-2","server":"b.com","port":443,"uuid":"00000000-0000-0000-0000-000000000000","tls":true,"reality-opts":{"public-key":"PK"},"flow":"xtls-rprx-vision","network":"tcp","servername":"b.com","udp":true,"xudp":true}',
      '  - {"type":"hysteria2","name":"node-3","server":"c.com","port":443,"ports":"443,8443-8500","password":"p3","sni":"c.com","skip-cert-verify":true,"tfo":true,"udp":true}',
      '  - {"type":"trojan","name":"node-4","server":"d.com","port":443,"password":"p4","sni":"d.com","network":"tcp","udp":true}',
      '  - {"type":"ss","name":"node-5","server":"e.com","port":8388,"cipher":"aes-256-gcm","password":"p5","network":"ws","udp":true}',
    ].join('\n');
    const result = normaliseToClashProviderYaml(sample);
    expect(result.proxyCount).toBe(5);
    expect(result.yaml).toContain('node-1');
    expect(result.yaml).toContain('xudp');
    expect(result.yaml).toContain('ports');
  });

  it('hysteria2://: pinSHA256 maps to fingerprint', () => {
    const uri = 'hy2://pw@h.com:8443?sni=h.com&pinSHA256=ABCDEF1234#X';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].fingerprint).toBe('ABCDEF1234');
  });

  it('rejects http:// with a path (not a proxy URI)', () => {
    const uri = 'http://airport.example/sub?token=xyz';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/path/i);
  });

  it('skips comments and blanks; deduplicates names', () => {
    const ss = `ss://${Buffer.from('aes-128-gcm:p', 'utf-8').toString('base64')}@h:1#dup`;
    const text = `# my list\n\n${ss}\n${ss}\n//trailing\n`;
    const { proxies } = parseProxyUriList(text);
    expect(proxies).toHaveLength(2);
    expect(proxies[0].name).toBe('dup');
    expect(proxies[1].name).toBe('dup #2');
  });

  it('reports unsupported schemes as errors', () => {
    const { errors } = parseProxyUriList('juicity://x@y:1#z');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/unsupported/i);
  });
});

describe('normaliseToClashProviderYaml — URI fallback', () => {
  it('accepts plain URI list', () => {
    const userinfo = Buffer.from('aes-256-gcm:s', 'utf-8').toString('base64');
    const text = `ss://${userinfo}@h:1#node1\nss://${userinfo}@h:2#node2\n`;
    const result = normaliseToClashProviderYaml(text);
    expect(result.proxyCount).toBe(2);
    expect(result.yaml).toContain('node1');
    expect(result.yaml).toContain('node2');
  });

  it('accepts base64-wrapped URI list', () => {
    const userinfo = Buffer.from('aes-256-gcm:s', 'utf-8').toString('base64');
    const inner = `ss://${userinfo}@h:1#A\nss://${userinfo}@h:2#B`;
    const wrapped = Buffer.from(inner, 'utf-8').toString('base64');
    const result = normaliseToClashProviderYaml(wrapped);
    expect(result.proxyCount).toBe(2);
    expect(result.yaml).toContain('A');
    expect(result.yaml).toContain('B');
  });
});
