import { describe, expect, it } from 'vitest';
import {
  looksLikeProxyUriList,
  parseProxyUriList,
  tryBase64Decode,
} from '@/lib/proxies/uriToClash';
import { normaliseToClashProviderYaml } from '@/lib/services/subscriptionFetcher';
import { matchFilter } from '@/lib/proxies/filterMatch';
import { parse as parseYaml } from 'yaml';

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

describe('IPv6 hosts and port-hopping regressions', () => {
  it('vless://: bracketed IPv6 host is emitted bare', () => {
    const uri = 'vless://00000000-0000-0000-0000-000000000000@[2001:db8::1]:443?security=tls&sni=v6.example#V6';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ server: '2001:db8::1', port: 443 });
  });

  it('trojan://: bracketed IPv6 host is emitted bare', () => {
    const uri = 'trojan://pwd@[2001:db8::2]:443#T6';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ server: '2001:db8::2', port: 443 });
  });

  it('ss:// SIP002: bracketed IPv6 host is emitted bare', () => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const uri = `ss://${userinfo}@[2001:db8::3]:8388#S6`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ server: '2001:db8::3', port: 8388 });
  });

  it('ss:// legacy base64: IPv6 host parses', () => {
    const payload = Buffer.from('aes-256-gcm:pw@[2001:db8::4]:8388', 'utf-8').toString('base64');
    const { proxies, errors } = parseProxyUriList(`ss://${payload}#L6`);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      cipher: 'aes-256-gcm',
      password: 'pw',
      server: '2001:db8::4',
      port: 8388,
    });
  });

  it('ssr://: IPv6 host parses via end-anchored split', () => {
    const pw = Buffer.from('pw', 'utf-8').toString('base64');
    const payload = Buffer.from(`2001:db8::5:8388:origin:aes-256-cfb:plain:${pw}`, 'utf-8').toString('base64');
    const { proxies, errors } = parseProxyUriList(`ssr://${payload}`);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'ssr',
      server: '2001:db8::5',
      port: 8388,
      cipher: 'aes-256-cfb',
      password: 'pw',
    });
  });

  it('hysteria2://: bracketed IPv6 host parses and is emitted bare', () => {
    const uri = 'hy2://pwd@[2001:db8::6]:8443?sni=h.example#H6';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ server: '2001:db8::6', port: 8443 });
  });

  it('hysteria2://: in-URI port-hopping wins over ?mport', () => {
    const uri = 'hy2://pwd@h.com:443,8443-8500?mport=20000-30000#PHM';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].ports).toBe('443,8443-8500');
  });

  it('tuic://: bracketed IPv6 host is emitted bare', () => {
    const uri = 'tuic://00000000-0000-0000-0000-000000000000:pw@[2001:db8::7]:443#U6';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ server: '2001:db8::7', port: 443 });
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

// Grounded in mihomo source (Meta branch):
//   common/convert/converter.go — VLESS `encryption` param
//   common/convert/v.go handleVShareLink — transport switch (xhttp/http/h2/ws/grpc)
describe('vless:// transport + VLESS Encryption (mihomo mapping)', () => {
  // Non-secret placeholder UUID; no real credentials appear in these tests.
  const UUID = '00000000-0000-0000-0000-000000000000';

  it('xhttp: basic parse — network + full xhttp-opts (path/host/mode)', () => {
    const uri =
      `vless://${UUID}@example.com:443?encryption=none&security=tls&sni=example.com` +
      `&type=xhttp&path=%2Fapi&host=cdn.example.com&mode=auto#XH`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'XH',
      type: 'vless',
      server: 'example.com',
      port: 443,
      network: 'xhttp',
      'xhttp-opts': { path: '/api', host: 'cdn.example.com', mode: 'auto' },
    });
  });

  it('xhttp: mode=packet-up + custom path + host + alpn=h2 + flow=xtls-rprx-vision together', () => {
    const uri =
      `vless://${UUID}@a.example:443?encryption=none&security=tls&sni=a.example` +
      `&alpn=h2&flow=xtls-rprx-vision&type=xhttp&path=%2Fapi%2Fv3%2Fsync&host=a.example&mode=packet-up#PU`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'vless',
      flow: 'xtls-rprx-vision',
      tls: true,
      servername: 'a.example',
      alpn: ['h2'],
      network: 'xhttp',
      'xhttp-opts': { path: '/api/v3/sync', host: 'a.example', mode: 'packet-up' },
    });
  });

  it('encryption: short value passed through verbatim', () => {
    const enc = 'mlkem768x25519plus.native';
    const uri = `vless://${UUID}@h.example:443?encryption=${encodeURIComponent(enc)}&type=tcp#E`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].encryption).toBe(enc);
  });

  it('encryption: long (>1600 char) synthetic value survives char-for-char', () => {
    // Synthetic, NON-SECRET. Includes + / = . to exercise the percent-encoding
    // round-trip through URLSearchParams (which decodes exactly once). Never a
    // real key: this is a repeated literal, not key material.
    const SYNTH = 'mlkem768x25519plus.native/xorpub.' + 'AbC+/9zZ.1rtt='.repeat(120);
    expect(SYNTH.length).toBeGreaterThan(1600);
    const uri =
      `vless://${UUID}@h.example:443?encryption=${encodeURIComponent(SYNTH)}` +
      `&type=xhttp&path=%2Fx&mode=packet-up#L`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].encryption).toBe(SYNTH);
    expect(proxies[0].encryption).toHaveLength(SYNTH.length);
  });

  it('xhttp: percent-encoded path is decoded exactly once (no double-decode)', () => {
    // %2F → "/" once.
    const { proxies } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&path=%2Fapi%2Fv3&mode=auto#P1`,
    );
    expect((proxies[0]['xhttp-opts'] as Record<string, unknown>).path).toBe('/api/v3');
    // %252F must stop at "%2F" — a second decode (bug) would yield "/".
    const { proxies: p2 } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&path=%252Fdbl#P2`,
    );
    expect((p2[0]['xhttp-opts'] as Record<string, unknown>).path).toBe('%2Fdbl');
  });

  it('encryption=none is emitted verbatim (mihomo keeps any non-empty value as-is)', () => {
    const uri = `vless://${UUID}@h.example:443?encryption=none&security=tls&sni=h.example&type=tcp#N`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].encryption).toBe('none');
  });

  it('encryption absent or empty is omitted (mihomo writes only when != "")', () => {
    const { proxies } = parseProxyUriList(
      `vless://${UUID}@h.example:443?security=tls&sni=h.example&type=tcp#NoEnc`,
    );
    expect('encryption' in proxies[0]).toBe(false);
    const { proxies: pe } = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=&type=tcp#Empty`,
    );
    expect('encryption' in pe[0]).toBe(false);
  });

  it('type=http remaps to network h2 with h2-opts (mihomo v.go)', () => {
    const uri =
      `vless://${UUID}@h.example:443?encryption=none&security=tls&type=http&path=%2Fh2&host=cdn.example#H2R`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'h2',
      'h2-opts': { path: '/h2', host: ['cdn.example'] },
    });
    expect(proxies[0]['http-opts']).toBeUndefined();
  });

  it('type=tcp + headerType=http remaps to network http with http-opts', () => {
    const uri =
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&headerType=http&path=%2Fp&host=cdn.example#HTTP`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'http',
      'http-opts': { path: ['/p'], headers: { Host: ['cdn.example'] } },
    });
  });

  it('ws/grpc/h2/tcp transports remain unchanged', () => {
    const ws = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=ws&path=%2Fws&host=cdn#W`,
    ).proxies[0];
    expect(ws).toMatchObject({
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'cdn' } },
    });

    const grpc = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=grpc&serviceName=gs#G`,
    ).proxies[0];
    expect(grpc).toMatchObject({ network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'gs' } });

    const h2 = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=h2&path=%2Fh&host=cdn#H`,
    ).proxies[0];
    expect(h2).toMatchObject({ network: 'h2', 'h2-opts': { path: '/h', host: ['cdn'] } });

    const tcp = parseProxyUriList(`vless://${UUID}@h.example:443?encryption=none&type=tcp#T`)
      .proxies[0];
    expect(tcp.network).toBe('tcp');
    expect(tcp['xhttp-opts']).toBeUndefined();
  });

  it('full delivery chain: parse → provider YAML → re-parse keeps encryption + xhttp-opts', () => {
    const SYNTH = 'mlkem768x25519plus.native/xorpub.' + 'Zz9+/8yY.0rtt='.repeat(120);
    expect(SYNTH.length).toBeGreaterThan(1600);
    const uri =
      `vless://${UUID}@edge.example:443?encryption=${encodeURIComponent(SYNTH)}` +
      `&security=tls&sni=edge.example&type=xhttp&path=%2Fapi%2Fv3%2Fsync&host=edge.example&mode=packet-up#E2E`;
    const { yaml, proxyCount } = normaliseToClashProviderYaml(uri);
    expect(proxyCount).toBe(1);
    const parsed = parseYaml(yaml) as { proxies: Record<string, unknown>[] };
    const p = parsed.proxies[0];
    expect(p.encryption).toBe(SYNTH);
    expect(p.network).toBe('xhttp');
    expect(p['xhttp-opts']).toEqual({
      path: '/api/v3/sync',
      host: 'edge.example',
      mode: 'packet-up',
    });
  });

  it('packet encoding: absent → xudp:true; packet → packet-addr; none → neither', () => {
    const def = parseProxyUriList(`vless://${UUID}@h.example:443?encryption=none&type=tcp#PE0`)
      .proxies[0];
    expect(def.xudp).toBe(true);
    expect(def['packet-addr']).toBeUndefined();

    const packet = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=packet#PE1`,
    ).proxies[0];
    expect(packet['packet-addr']).toBe(true);
    expect(packet.xudp).toBeUndefined();

    const none = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=none#PE2`,
    ).proxies[0];
    expect(none.xudp).toBeUndefined();
    expect(none['packet-addr']).toBeUndefined();
  });

  it('flow is lowercased (mihomo strings.ToLower)', () => {
    const p = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&flow=XTLS-RPRX-Vision&type=tcp#FL`,
    ).proxies[0];
    expect(p.flow).toBe('xtls-rprx-vision');
  });

  it('xhttp extra JSON maps xmux → reuse-settings and scalar fields', () => {
    const extra = {
      xPaddingBytes: '100-1000',
      scMaxEachPostBytes: 1000000,
      xmux: { maxConnections: 4, maxConcurrency: '16', hKeepAlivePeriod: 30 },
    };
    const uri =
      `vless://${UUID}@h.example:443?encryption=none&type=xhttp&mode=auto&host=h.example` +
      `&extra=${encodeURIComponent(JSON.stringify(extra))}#XE`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]['xhttp-opts']).toMatchObject({
      mode: 'auto',
      host: 'h.example',
      'x-padding-bytes': '100-1000',
      'sc-max-each-post-bytes': 1000000,
      'reuse-settings': {
        'max-connections': '4',
        'max-concurrency': '16',
        'h-keep-alive-period': 30,
      },
    });
  });

  it('xhttp extra JSON maps downloadSettings → download-settings (reality)', () => {
    const extra = {
      downloadSettings: {
        address: 'dl.example',
        port: 8443,
        security: 'reality',
        realitySettings: { publicKey: 'PBK', shortId: 'ab12' },
        xhttpSettings: { path: '/dl', host: 'dl.example' },
      },
    };
    const uri =
      `vless://${UUID}@h.example:443?encryption=none&type=xhttp&mode=packet-up` +
      `&extra=${encodeURIComponent(JSON.stringify(extra))}#XD`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect((proxies[0]['xhttp-opts'] as Record<string, unknown>)['download-settings']).toEqual({
      server: 'dl.example',
      port: 8443,
      tls: true,
      'reality-opts': { 'public-key': 'PBK', 'short-id': 'ab12' },
      path: '/dl',
      host: 'dl.example',
    });
  });

  it('xhttp extra: malformed JSON is ignored, node still parses', () => {
    const uri = `vless://${UUID}@h.example:443?encryption=none&type=xhttp&mode=auto&extra=%7Bnot-json#XM`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].network).toBe('xhttp');
    expect((proxies[0]['xhttp-opts'] as Record<string, unknown>).mode).toBe('auto');
    expect(
      (proxies[0]['xhttp-opts'] as Record<string, unknown>)['reuse-settings'],
    ).toBeUndefined();
  });
});

// P3-1: hysteria2 userinfo/'@' handling — optional auth + last-'@' split.
describe('P3-1 hysteria2:// optional userinfo + @ in password', () => {
  it('accepts a no-auth link (hysteria2://host:port, no @)', () => {
    const uri = 'hysteria2://h.example:8443?sni=h.example#NoAuth';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'NoAuth',
      type: 'hysteria2',
      server: 'h.example',
      port: 8443,
      password: '',
      sni: 'h.example',
    });
  });

  it('splits on the LAST @ so a password containing @ round-trips', () => {
    const uri = 'hy2://pa@ss@h.example:8443?sni=h.example#AtPw';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'hysteria2',
      server: 'h.example',
      port: 8443,
      password: 'pa@ss',
      sni: 'h.example',
    });
  });
});

// P3-2: SS SIP002 percent-encoded base64 userinfo.
describe('P3-2 ss:// SIP002 percent-encoded base64 userinfo', () => {
  it('decodes a URL-encoded base64 method:password userinfo', () => {
    // base64('aes-256-gcm:pass') ends with '==' → percent-encoded to %3D%3D,
    // which a direct base64 decode rejects.
    const b64 = Buffer.from('aes-256-gcm:pass', 'utf-8').toString('base64');
    expect(b64).toContain('=');
    const uri = `ss://${encodeURIComponent(b64)}@h.example:8388#PctB64`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'ss',
      server: 'h.example',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'pass',
    });
  });
});

// P3-3: vmess boolean "tls": true (not the string "tls").
describe('P3-3 vmess:// boolean tls field', () => {
  it('treats "tls": true (boolean) as TLS enabled', () => {
    const payload = {
      v: '2',
      ps: 'BoolTLS',
      add: 'jp.example.com',
      port: '443',
      id: '00000000-0000-0000-0000-000000000000',
      aid: '0',
      net: 'tcp',
      tls: true, // boolean, not the string "tls"
      sni: 'sni.example.com',
    };
    const uri = `vmess://${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'vmess',
      tls: true,
      servername: 'sni.example.com',
    });
  });
});

// P3-4: anytls / wireguard typed query passthrough (booleans + numbers).
describe('P3-4 typed query passthrough (anytls + wireguard)', () => {
  it('anytls://: ?tfo=true becomes a boolean, not the string "true"', () => {
    const uri = 'anytls://pwd@h.example:8443?sni=h.example&tfo=true#AT-tfo';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].tfo).toBe(true);
  });

  it('wireguard://: booleans/numbers coerced; unknown keys stay strings', () => {
    const priv = encodeURIComponent('aP+xQzG/Tz9+xQzG/Tz9+xQzG/Tz9+xQzG/Tz9=');
    const uri =
      `wireguard://${priv}@wg.example:51820` +
      `?publickey=PUBKEY&remote-dns-resolve=true&persistent-keepalive=25&label=edge#WG`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]['remote-dns-resolve']).toBe(true);
    expect(proxies[0]['persistent-keepalive']).toBe(25);
    // Genuinely-unknown key is left as a raw string (no invented mapping).
    expect(proxies[0].label).toBe('edge');
  });
});

// P3-5: vmess httpupgrade network + ws early-data (?ed=).
describe('P3-5 vmess:// httpupgrade + ws early-data', () => {
  const base = {
    v: '2',
    add: 'jp.example.com',
    port: '443',
    id: '00000000-0000-0000-0000-000000000000',
    aid: '0',
  };

  it('maps net=httpupgrade to ws + v2ray-http-upgrade flag', () => {
    const payload = { ...base, ps: 'HU', net: 'httpupgrade', path: '/up', host: 'cdn.example.com' };
    const uri = `vmess://${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'vmess',
      network: 'ws',
      'ws-opts': {
        path: '/up',
        'v2ray-http-upgrade': true,
        headers: { Host: 'cdn.example.com' },
      },
    });
  });

  it('lifts ws ?ed=N out of the path into max-early-data', () => {
    const payload = { ...base, ps: 'ED', net: 'ws', path: '/ws?ed=2048', host: 'cdn.example.com' };
    const uri = `vmess://${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'ws',
      'ws-opts': {
        path: '/ws',
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol',
        headers: { Host: 'cdn.example.com' },
      },
    });
  });
});

// P3-6: matchFilter must reject RE2-incompatible constructs (lookaround /
// backreferences) that JS RegExp accepts, so the preview matches mihomo.
describe('P3-6 matchFilter RE2 compatibility', () => {
  const nodes = ['🇺🇸 US-01', '🇭🇰 HK-01', 'Australia-1'];

  it('rejects lookahead (?=…)', () => {
    const res = matchFilter(nodes, 'US(?=-)');
    expect(res.matched).toHaveLength(0);
    expect(res.error).toBeTruthy();
  });

  it('rejects negative lookbehind (?<!…)', () => {
    const res = matchFilter(nodes, '(?<!A)US');
    expect(res.matched).toHaveLength(0);
    expect(res.error).toBeTruthy();
  });

  it('rejects backreferences (\\1)', () => {
    const res = matchFilter(nodes, '(US)-\\1');
    expect(res.matched).toHaveLength(0);
    expect(res.error).toBeTruthy();
  });

  it('still accepts RE2-valid word boundaries + inline (?i) flag', () => {
    const res = matchFilter(nodes, '(?i)\\bus\\b');
    expect(res.error).toBeNull();
    expect(res.matched).toEqual(['🇺🇸 US-01']);
  });
});
