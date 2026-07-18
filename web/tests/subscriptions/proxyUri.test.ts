import { describe, expect, it } from 'vitest';
import {
  looksLikeProxyUriList,
  MAX_PROXY_URI_LINES,
  parseProxyUriList,
  tryBase64Decode,
} from '@/lib/proxies/uriToClash';
import { normaliseToClashProviderYaml } from '@/lib/services/subscriptionFetcher';
import { ProblemDetailsError } from '@/lib/http/problem';
import { matchFilter } from '@/lib/proxies/filterMatch';
import { parse as parseYaml } from 'yaml';

// Deterministic, synthetic 32-byte X25519 public-key payload. It is test data,
// not credential material.
const FAKE_REALITY_PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64url');
const FAKE_VLESS_X25519_ENCRYPTION = `mlkem768x25519plus.native.1rtt.${Buffer.alloc(32, 2).toString('base64url')}`;
const FAKE_VLESS_MLKEM_ENCRYPTION = `mlkem768x25519plus.native.1rtt.${Buffer.alloc(1184, 3).toString('base64url')}`;
const FAKE_CERT_FINGERPRINT = 'ab'.repeat(32);

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
  it('accepts short canonical missing padding and folded whitespace', () => {
    expect(tryBase64Decode('YWI')).toBe('ab');
    expect(tryBase64Decode('YW\nJj')).toBe('abc');
  });
  it.each(['YW=Jj', 'YWJj=', 'YWJj==', 'YQ=', 'YQ===', 'YR==', 'YWJj=tail'])(
    'rejects malformed or non-canonical base64 syntax',
    (encoded) => {
      expect(tryBase64Decode(encoded)).toBeNull();
    },
  );
  it('rejects invalid UTF-8 instead of replacing credential bytes', () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe]).toString('base64');
    expect(tryBase64Decode(invalidUtf8)).toBeNull();
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
      `vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&security=reality&type=tcp&sni=sni.example` +
      `&fp=chrome&pbk=${FAKE_REALITY_PUBLIC_KEY}&sid=ab12&flow=xtls-rprx-vision#VL-Reality`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'VL-Reality',
      type: 'vless',
      server: 'example.com',
      port: 443,
      uuid: '00000000-0000-0000-0000-000000000000',
      flow: 'xtls-rprx-vision',
      encryption: '',
      'packet-encoding': 'xudp',
      tls: true,
      servername: 'sni.example',
      'client-fingerprint': 'chrome',
      network: 'tcp',
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
    });
  });

  it('parses vless:// reality with spx by dropping spiderX (vless-reality-spx-dropped)', () => {
    const uri =
      `vless://00000000-0000-0000-0000-000000000000@example.com:443?flow=xtls-rprx-vision&fp=chrome` +
      `&pbk=${FAKE_REALITY_PUBLIC_KEY}&security=reality&sid=ab12&sni=sni.example&spx=%2FXZX2VdBg5GK9G5I&type=tcp#VL-Reality-SPX`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'VL-Reality-SPX',
      type: 'vless',
      tls: true,
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
    });
    expect(proxies[0]).not.toHaveProperty('spx');
    expect(proxies[0]).not.toHaveProperty('spider-x');
  });

  it('parses vless:// by ignoring legacy quicSecurity exporter noise (vless-quicsecurity-ignored)', () => {
    // NekoBox-style exporters emit quicSecurity on every link regardless of
    // the selected transport; Mihomo has no VLESS QUIC stream transport.
    const uri =
      `vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&flow=xtls-rprx-vision&fp=chrome` +
      `&pbk=${FAKE_REALITY_PUBLIC_KEY}&security=reality&sid=ab12&sni=sni.example&quicSecurity=none&type=tcp#VL-QuicSec`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'VL-QuicSec',
      type: 'vless',
      network: 'tcp',
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
    });
    expect(proxies[0]).not.toHaveProperty('quicSecurity');
  });

  it('parses vless:// tcp ignoring an empty transport-option dump (vless-inert-transport-noise)', () => {
    // NekoBox-style exporters emit every transport option on every link:
    // empty host/path/serviceName plus headerType=none on a plain tcp link.
    const uri =
      `vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&flow=xtls-rprx-vision&fp=chrome` +
      `&pbk=${FAKE_REALITY_PUBLIC_KEY}&security=reality&sid=ab12&sni=sni.example&headerType=none&host=&path=&serviceName=&type=tcp#VL-Dump`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ name: 'VL-Dump', type: 'vless', network: 'tcp' });
    expect(proxies[0]).not.toHaveProperty('ws-opts');
  });

  it('parses vless:// ws with a redundant headerType=none', () => {
    const uri =
      'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&security=tls&sni=cdn.example&type=ws&headerType=none&path=%2Fws&host=cdn.example#VL-WS-HT';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'cdn.example' } },
    });
  });

  it('vless://: still rejects a non-empty transport option on a mismatched transport', () => {
    const uri =
      'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=tcp&host=cdn.example#VL-Conflict';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/transport option does not match/);
  });

  it('parses vless:// with a dashless hashlike uuid (uuid-hashlike-accepted)', () => {
    const uri =
      'vless://AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE@example.com:443?encryption=none&type=tcp#VL-Hashlike';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
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
      'tuic://019f65ab-a17d-7902-9011-7b6645fa1942:pass-yy@tuic.example:8443?sni=tuic.example&congestion_control=bbr&udp_relay_mode=native&alpn=h3#TUIC';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'TUIC',
      type: 'tuic',
      server: 'tuic.example',
      port: 8443,
      uuid: '019f65ab-a17d-7902-9011-7b6645fa1942',
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

  it.each([
    'security=tls&sni=cdn.com&type=ws&path=%2Fws&host=cdn.com',
    'type=httpupgrade&path=%2Fup&host=cdn.com',
    'security=reality&sni=cdn.example&pbk=PBK&sid=ab12',
    'ws=1&wspath=%2Flegacy',
  ])('ss://: rejects an unsupported top-level transport/TLS wrapper: %s', (query) => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const { proxies, errors } = parseProxyUriList(
      `ss://${userinfo}@h.com:443?${query}#UnsupportedWrapper`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/unsupported ss/i);
  });

  it('ss://: preserves supported udp/tfo/uot flags without a transport wrapper', () => {
    const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
    const { proxies, errors } = parseProxyUriList(
      `ss://${userinfo}@h.com:443?udp=1&tfo=1&uot=1#Flags`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ udp: true, tfo: true, 'udp-over-tcp': true });
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
      JSON.stringify({
        host: 'fake.com',
        password: 'sec',
        version: 3,
        address: 'real.com',
        port: 8443,
      }),
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
      'vless://00000000-0000-0000-0000-000000000000@h.com:443?encryption=none&security=tls&sni=h.com&alpn=h2%2Chttp%2F1.1#X';
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
      'idle-session-check-interval': 30,
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
    const privateKey = Buffer.alloc(32, 1).toString('base64');
    const publicKey = Buffer.alloc(32, 2).toString('base64');
    const priv = encodeURIComponent(privateKey);
    const pub = encodeURIComponent(publicKey);
    const addrs = encodeURIComponent('10.0.0.2/32,fd00::2/128');
    const reserved = encodeURIComponent('1,2,3');
    const uriA = `wireguard://${priv}@wg.example:51820?publickey=${pub}&address=${addrs}&mtu=1420&reserved=${reserved}#WG-1`;
    const uriB = `wg://${priv}@wg.example?publickey=${pub}&address=10.0.0.5%2F24#WG-2`;
    const { proxies, errors } = parseProxyUriList(`${uriA}\n${uriB}`);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'WG-1',
      type: 'wireguard',
      server: 'wg.example',
      port: 51820,
      'private-key': privateKey,
      'public-key': publicKey,
      ip: '10.0.0.2/32',
      ipv6: 'fd00::2/128',
      mtu: 1420,
      reserved: [1, 2, 3],
      udp: true,
    });
    expect(proxies[1]).toMatchObject({
      name: 'WG-2',
      type: 'wireguard',
      port: 51820, // wg:// default
      ip: '10.0.0.5/24',
    });
  });

  it('hysteria2://: port-hopping in host (host:443,8443-8500)', () => {
    const uri = 'hy2://pwd@h.com:443,8443-8500?sni=h.com&insecure=1&fastopen=1#PH';
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

  it('hysteria2://: ?mport / ?peer / ?obfs=none / ?hop-interval / ?upmbps', () => {
    const uri =
      'hy2://pwd@h.com?peer=cdn.com&obfs=none&mport=20000-30000&hop-interval=30&upmbps=200&downmbps=500#H';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    const p = proxies[0];
    expect(p).toMatchObject({
      type: 'hysteria2',
      sni: 'cdn.com', // peer fallback
      ports: '20000-30000',
      'hop-interval': '30',
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
      '  - {"type":"anytls","name":"node-1","server":"a.com","port":443,"password":"p1","sni":"a.com","skip-cert-verify":true,"udp":true}',
      `  - {"type":"vless","name":"node-2","server":"b.com","port":443,"uuid":"00000000-0000-0000-0000-000000000000","tls":true,"reality-opts":{"public-key":"${FAKE_REALITY_PUBLIC_KEY}"},"flow":"xtls-rprx-vision","network":"tcp","servername":"b.com","udp":true,"xudp":true}`,
      '  - {"type":"hysteria2","name":"node-3","server":"c.com","port":443,"ports":"443,8443-8500","password":"p3","sni":"c.com","skip-cert-verify":true,"tfo":true}',
      '  - {"type":"trojan","name":"node-4","server":"d.com","port":443,"password":"p4","sni":"d.com","network":"tcp","udp":true}',
      '  - {"type":"ss","name":"node-5","server":"e.com","port":8388,"cipher":"aes-256-gcm","password":"p5","udp":true}',
    ].join('\n');
    const result = normaliseToClashProviderYaml(sample);
    expect(result.proxyCount).toBe(5);
    expect(result.yaml).toContain('node-1');
    expect(result.yaml).toContain('xudp');
    expect(result.yaml).toContain('ports');
  });

  it('hysteria2://: pinSHA256 maps to fingerprint', () => {
    const colonized = 'AB'.repeat(32).match(/.{2}/g)!.join(':');
    const uri = `hy2://pw@h.com:8443?sni=h.com&pinSHA256=${colonized}#X`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].fingerprint).toBe(FAKE_CERT_FINGERPRINT);
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

  it('preserves deterministic nested suffix semantics while deduplicating in amortized O(1)', () => {
    const input = [
      'anytls://pw@h.example:443#dup',
      'anytls://pw@h.example:443#dup',
      'anytls://pw@h.example:443#dup%20%232',
      'anytls://pw@h.example:443#dup%20%232',
      'anytls://pw@h.example:443#dup',
      'anytls://pw@h.example:443#dup%20%233',
      'anytls://pw@h.example:443#dup',
    ].join('\n');
    expect(parseProxyUriList(input).proxies.map(({ name }) => name)).toEqual([
      'dup',
      'dup #2',
      'dup #2 #2',
      'dup #2 #3',
      'dup #3',
      'dup #3 #2',
      'dup #4',
    ]);
  });

  it('handles 20,000 colliding names within a broad regression budget', () => {
    const count = 20_000;
    const input = Array.from({ length: count }, () => 'anytls://pw@scale.example:443#same').join(
      '\n',
    );
    const started = performance.now();
    const result = parseProxyUriList(input);
    const elapsedMs = performance.now() - started;
    expect(result.errors).toHaveLength(0);
    expect(result.proxies).toHaveLength(count);
    expect(result.proxies.at(-1)?.name).toBe(`same #${count}`);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);

  it('accepts the physical-line limit and rejects the next line before parsing', () => {
    const atLimit = `${'# comment\n'.repeat(MAX_PROXY_URI_LINES - 1)}# comment`;
    expect(parseProxyUriList(atLimit)).toEqual({ proxies: [], errors: [] });

    const overLimit = `${atLimit}\n# extra`;
    const result = parseProxyUriList(overLimit);
    expect(result.proxies).toHaveLength(0);
    expect(result.errors).toEqual([
      {
        line: 'input',
        error: `proxy URI input exceeds the ${MAX_PROXY_URI_LINES} physical-line limit`,
        issue: {
          category: 'input_line_limit',
          line: null,
        },
      },
    ]);
  });

  it('handles BOM, CRLF, case-insensitive schemes, IDN, and an emoji fragment', () => {
    const uri = 'ANYTLS://p%2Bss@例子.测试:443?sni=cdn.example#%F0%9F%8C%90';
    const { proxies, errors } = parseProxyUriList(`\uFEFF${uri}\r\n# comment\r\n`);

    expect(errors).toHaveLength(0);
    expect(proxies).toHaveLength(1);
    expect(proxies[0]).toMatchObject({
      name: '🌐',
      password: 'p+ss',
      port: 443,
    });
    expect(proxies[0].server).toMatch(/^xn--/);
  });

  it('rejects control characters in a decoded node name', () => {
    const { proxies, errors } = parseProxyUriList('anytls://secret@any.example:443#safe%0Aunsafe');

    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/control characters/i);
  });

  it('reports unsupported schemes as errors', () => {
    const marker = 'juicity-fakesecretmarker';
    const { errors } = parseProxyUriList(`${marker}://x@y:1#z`);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/unsupported/i);
    expect(errors[0].issue).toEqual({
      category: 'unsupported_scheme',
      line: 1,
    });
    expect(JSON.stringify(errors[0].issue)).not.toContain(marker);
  });

  it('does not retain credentials from a failed URI in diagnostics', () => {
    const fakeSecret = 'FAKE_SECRET_DO_NOT_LOG';
    const { errors } = parseProxyUriList(`trojan://${fakeSecret}@example.com:not-a-port#broken`);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).not.toContain(fakeSecret);
    expect(errors[0].error).not.toContain(fakeSecret);
  });
});

describe('ss:// fail-closed plugin mapping', () => {
  const userinfo = Buffer.from('aes-256-gcm:pw', 'utf-8').toString('base64');
  const makeUri = (plugin: string): string =>
    `ss://${userinfo}@ss.example:443?plugin=${encodeURIComponent(plugin)}#SSPlugin`;

  it('tokenizes SIP003 escaped semicolons, equals signs, and backslashes', () => {
    const plugin = String.raw`v2ray-plugin;mode=websocket;path=/socket\;matrix\=1\\tail;host=cdn.example;mux=0`;
    const { proxies, errors } = parseProxyUriList(makeUri(plugin));
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      plugin: 'v2ray-plugin',
      'plugin-opts': {
        mode: 'websocket',
        path: String.raw`/socket;matrix=1\tail`,
        host: 'cdn.example',
        mux: false,
      },
    });
  });

  it('rejects an unknown SIP003 plugin instead of emitting direct Shadowsocks', () => {
    const { proxies, errors } = parseProxyUriList(makeUri('unknown-plugin;mode=fast'));
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/unsupported ss plugin/i);
  });

  it.each(['mode=quic', 'mode=grpc', 'mode=websocket;mux=2', 'mode=websocket;mux=bad'])(
    'rejects an unrepresentable v2ray-plugin option set: %s',
    (options) => {
      const { proxies, errors } = parseProxyUriList(
        makeUri(`v2ray-plugin;${options};host=cdn.example`),
      );
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/v2ray-plugin/i);
    },
  );

  it('preserves an explicit v2ray-plugin mux=0 as false', () => {
    const { proxies, errors } = parseProxyUriList(
      makeUri('v2ray-plugin;mode=websocket;host=cdn.example;mux=0'),
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['plugin-opts']).toMatchObject({ mux: false });
  });

  it.each(['0', '4', '2x'])('rejects an invalid shadow-tls plugin version: %s', (version) => {
    const { proxies, errors } = parseProxyUriList(
      makeUri(`shadow-tls;host=cover.example;password=secret;version=${version}`),
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/shadow-tls.*version/i);
  });

  it.each([
    ['invalid base64', 'not-base64!'],
    ['non-object JSON', Buffer.from('[]', 'utf-8').toString('base64')],
    [
      'invalid port',
      Buffer.from(
        JSON.stringify({ host: 'cover.example', version: 3, address: 'edge.example', port: 70000 }),
        'utf-8',
      ).toString('base64'),
    ],
    [
      'invalid version',
      Buffer.from(JSON.stringify({ host: 'cover.example', version: 4 }), 'utf-8').toString(
        'base64',
      ),
    ],
  ])('rejects a malformed Shadowrocket shadow-tls payload: %s', (_label, payload) => {
    const { proxies, errors } = parseProxyUriList(
      `ss://${userinfo}@ss.example:443?shadow-tls=${encodeURIComponent(payload)}#BadShadowTLS`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/shadow-tls/i);
  });
});

describe('ssr:// strict field decoding', () => {
  const b64 = (value: string): string => Buffer.from(value, 'utf-8').toString('base64url');
  const makeUri = (password: string, query = ''): string => {
    const suffix = query ? `/?${query}` : '';
    return `ssr://${b64(`ssr.example:443:origin:aes-256-cfb:plain:${password}${suffix}`)}`;
  };

  it('rejects a present-but-invalid required password base64 field', () => {
    const { proxies, errors } = parseProxyUriList(makeUri('%%%'));
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/password.*base64/i);
  });

  it.each(['remarks', 'obfsparam', 'protoparam', 'group'])(
    'rejects a present-but-invalid optional %s base64 field',
    (field) => {
      const { proxies, errors } = parseProxyUriList(makeUri(b64('pw'), `${field}=not-base64!`));
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(new RegExp(`${field}.*base64`, 'i'));
    },
  );

  it.each(['udpport=53', 'uot=1'])(
    'rejects an unrepresentable non-empty SSR target field: %s',
    (query) => {
      const { proxies, errors } = parseProxyUriList(makeUri(b64('pw'), query));
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/unsupported ssr/i);
    },
  );

  it('validates then ignores group as metadata while preserving supported fields', () => {
    const query = [
      `remarks=${b64('SSR strict')}`,
      `obfsparam=${b64('cover.example')}`,
      `protoparam=${b64('42:user')}`,
      `group=${b64('synthetic group')}`,
    ].join('&');
    const { proxies, errors } = parseProxyUriList(makeUri(b64('pw'), query));
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'SSR strict',
      password: 'pw',
      'obfs-param': 'cover.example',
      'protocol-param': '42:user',
    });
    expect(proxies[0].group).toBeUndefined();
  });
});

describe('vmess:// legacy JSON strict mapping', () => {
  const base: Record<string, unknown> = {
    v: '2',
    ps: 'VMess strict',
    add: 'vmess.example',
    port: '443',
    id: '00000000-0000-0000-0000-000000000000',
    aid: '0',
    net: 'tcp',
    type: 'none',
  };
  const makeUri = (overrides: Record<string, unknown>): string =>
    `vmess://${Buffer.from(JSON.stringify({ ...base, ...overrides }), 'utf-8').toString('base64')}`;

  it('maps a bounded custom ID to UUIDv5 and normalizes hexadecimal case', () => {
    const custom = parseProxyUriList(makeUri({ id: 'example' }));
    expect(custom.errors).toHaveLength(0);
    expect(custom.proxies[0].uuid).toBe('feb54431-301b-52bb-a6dd-e1e93e81bb9e');

    const upper = parseProxyUriList(makeUri({ id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' }));
    expect(upper.errors).toHaveLength(0);
    expect(upper.proxies[0].uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const oversized = parseProxyUriList(makeUri({ id: 'x'.repeat(31) }));
    expect(oversized.proxies).toHaveLength(0);
    expect(oversized.errors[0].error).toMatch(/invalid vmess user id/i);
  });

  it.each([true, -1, '1x', Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid alterId value: %j',
    (aid) => {
      const { proxies, errors } = parseProxyUriList(makeUri({ aid }));
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/alterid/i);
    },
  );

  it.each([{}, [], 2, 'tls13'])('rejects an unsupported tls value: %j', (tls) => {
    const { proxies, errors } = parseProxyUriList(makeUri({ tls }));
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/tls/i);
  });

  it.each([
    ['add', ['vmess.example']],
    ['id', { uuid: base.id }],
    ['host', ['cdn.example']],
  ])('rejects a non-string legacy JSON %s field', (field, value) => {
    const { proxies, errors } = parseProxyUriList(makeUri({ [field]: value }));
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/vmess.*field/i);
  });

  it('maps tcp + type=http to Mihomo HTTP transport options', () => {
    const { proxies, errors } = parseProxyUriList(
      makeUri({ net: 'tcp', type: 'http', host: 'one.example,two.example', path: '/http' }),
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'http',
      'http-opts': {
        path: ['/http'],
        headers: { Host: ['one.example,two.example'] },
      },
    });
  });

  it('maps legacy net=http to Mihomo h2 transport options', () => {
    const { proxies, errors } = parseProxyUriList(
      makeUri({ net: 'http', type: 'none', host: 'cdn.example', path: '/h2' }),
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'h2',
      'h2-opts': { path: '/h2', host: ['cdn.example'] },
    });
  });

  it('maps kcp header camouflage and seed to Mihomo mkcp options', () => {
    const { proxies, errors } = parseProxyUriList(
      makeUri({ net: 'kcp', type: 'wechat-video', path: 'synthetic-seed' }),
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'mkcp',
      'mkcp-opts': { header: 'wechat-video', seed: 'synthetic-seed' },
    });
  });

  it.each(['quic', 'unknown'])(
    'rejects an unsupported legacy transport instead of falling back to TCP: %s',
    (net) => {
      const { proxies, errors } = parseProxyUriList(makeUri({ net }));
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/transport/i);
    },
  );

  it.each(['pcs', 'vcn'])(
    'rejects non-empty unrepresentable legacy certificate field %s',
    (field) => {
      const { proxies, errors } = parseProxyUriList(makeUri({ [field]: 'synthetic-value' }));
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(new RegExp(field, 'i'));
    },
  );

  it('maps documented fp and insecure fields to Mihomo TLS options', () => {
    const { proxies, errors } = parseProxyUriList(
      makeUri({ tls: 'tls', fp: 'chrome', insecure: '1', sni: 'sni.example' }),
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      tls: true,
      servername: 'sni.example',
      'client-fingerprint': 'chrome',
      'skip-cert-verify': true,
    });
  });
});

describe('IPv6 hosts and port-hopping regressions', () => {
  it('vless://: bracketed IPv6 host is emitted bare', () => {
    const uri =
      'vless://00000000-0000-0000-0000-000000000000@[2001:db8::1]:443?security=tls&sni=v6.example#V6';
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
    const payload = Buffer.from(
      `2001:db8::5:8388:origin:aes-256-cfb:plain:${pw}`,
      'utf-8',
    ).toString('base64');
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

  it('hysteria2://: rejects conflicting in-URI port-hopping and ?mport', () => {
    const uri = 'hy2://pwd@h.com:443,8443-8500?mport=20000-30000#PHM';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/conflicting.*ports.*mport/i);
  });

  it('hysteria2://: single authority port plus ?mport maps to port + ports (hysteria2-port-plus-mport)', () => {
    // Common share form: initial connection port in the authority, hopping
    // range in mport. Sub-Store maps this identically. Only two competing
    // port SETS remain ambiguous (previous test).
    const uri = 'hy2://pwd@h.com:29900?insecure=1&mport=20000-30000&sni=cdn.example#PM';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      type: 'hysteria2',
      port: 29900,
      ports: '20000-30000',
      sni: 'cdn.example',
      'skip-cert-verify': true,
    });
  });

  it('tuic://: bracketed IPv6 host is emitted bare', () => {
    const uri = 'tuic://00000000-0000-0000-0000-000000000000:pw@[2001:db8::7]:443#U6';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ server: '2001:db8::7', port: 443 });
  });
});

describe('proxy URI port validation', () => {
  const b64 = (value: string): string => Buffer.from(value, 'utf-8').toString('base64');

  it('rejects non-numeric, zero, and out-of-range ports across parser families', () => {
    const invalidUris = [
      `ss://${b64('aes-128-gcm:fake')}@example.com:443junk#ss-partial`,
      `ss://${b64('aes-128-gcm:fake')}@example.com:70000#ss-high`,
      `ssr://${b64(`example.com:70000:origin:aes-256-cfb:plain:${b64('fake')}/?remarks=${b64('ssr-high')}`)}`,
      `vmess://${b64(
        JSON.stringify({
          v: '2',
          ps: 'vmess-high',
          add: 'example.com',
          port: '70000',
          id: '00000000-0000-0000-0000-000000000000',
          aid: '0',
          net: 'tcp',
        }),
      )}`,
      'hy2://fake@example.com:70000#hy2-high',
      'hy2://fake@example.com:0#hy2-zero',
      'trojan://fake@example.com:0#trojan-zero',
      'anytls://fake@example.com:0#anytls-zero',
      'wireguard://fake@example.com:0#wg-zero',
    ];

    for (const uri of invalidUris) {
      const { proxies, errors } = parseProxyUriList(uri);
      expect(proxies, uri.slice(0, uri.indexOf('://'))).toHaveLength(0);
      expect(errors, uri.slice(0, uri.indexOf('://'))).toHaveLength(1);
    }
  });

  it('accepts the inclusive port boundaries', () => {
    const userinfo = b64('aes-128-gcm:fake');
    const { proxies, errors } = parseProxyUriList(
      `ss://${userinfo}@one.example:1#low\nss://${userinfo}@high.example:65535#high`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies.map((proxy) => proxy.port)).toEqual([1, 65535]);
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

  it('rejects a mixed URI list instead of silently dropping failed nodes', () => {
    const valid = 'vless://00000000-0000-0000-0000-000000000000@example.com:443?type=tcp#good';
    const invalid = 'trojan://FAKE_SECRET_DO_NOT_LOG@example.com:not-a-port#broken';
    expect(() => normaliseToClashProviderYaml(`${valid}\n${invalid}`)).toThrow(ProblemDetailsError);
  });

  it('rejects non-comment text mixed into a URI list', () => {
    const valid = 'vless://00000000-0000-0000-0000-000000000000@example.com:443?type=tcp#good';
    expect(() => normaliseToClashProviderYaml(`NOTICE: maintenance\n${valid}`)).toThrow(
      ProblemDetailsError,
    );
  });

  it('keeps the fallback error support list in sync with the parser registry', () => {
    let thrown: unknown;
    try {
      normaliseToClashProviderYaml('not a proxy subscription');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProblemDetailsError);
    const message = (thrown as Error).message;
    for (const scheme of [
      'anytls://',
      'wireguard://',
      'wg://',
      'socks://',
      'hysteria://',
      'hy2://',
      'https://',
    ]) {
      expect(message).toContain(scheme);
    }
  });
});

// Grounded in current Meta-Docs for emitted YAML fields, while preserving
// mihomo share-link semantics for VLESS Encryption and transport mapping.
describe('vless:// transport + VLESS Encryption (mihomo mapping)', () => {
  // Non-secret placeholder UUID; no real credentials appear in these tests.
  const UUID = '00000000-0000-0000-0000-000000000000';

  it('maps a bounded custom ID to UUIDv5 and normalizes hexadecimal case', () => {
    const custom = parseProxyUriList('vless://example@h.example:443');
    expect(custom.errors).toHaveLength(0);
    expect(custom.proxies[0].uuid).toBe('feb54431-301b-52bb-a6dd-e1e93e81bb9e');

    const upper = parseProxyUriList('vless://AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE@h.example:443');
    expect(upper.errors).toHaveLength(0);
    expect(upper.proxies[0].uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const oversized = parseProxyUriList(`vless://${'x'.repeat(31)}@h.example:443`);
    expect(oversized.proxies).toHaveLength(0);
    expect(oversized.errors[0].error).toMatch(/invalid vless user id/i);
  });

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

  it('encryption: valid X25519 value is passed through verbatim', () => {
    const enc = FAKE_VLESS_X25519_ENCRYPTION;
    const uri = `vless://${UUID}@h.example:443?encryption=${encodeURIComponent(enc)}&type=tcp#E`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].encryption).toBe(enc);
  });

  it('encryption: long (>1600 char) synthetic value survives char-for-char', () => {
    // Synthetic, NON-SECRET. Includes + / = . to exercise the percent-encoding
    // round-trip through URLSearchParams (which decodes exactly once). Never a
    // real key: this is a repeated literal, not key material.
    const SYNTH = FAKE_VLESS_MLKEM_ENCRYPTION;
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

  it('encryption=none is normalized to the canonical empty YAML value', () => {
    const uri = `vless://${UUID}@h.example:443?encryption=none&security=tls&sni=h.example&type=tcp#N`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].encryption).toBe('');
  });

  it('omitted encryption uses the documented no-encryption default', () => {
    const { proxies } = parseProxyUriList(
      `vless://${UUID}@h.example:443?security=tls&sni=h.example&type=tcp#NoEnc`,
    );
    expect('encryption' in proxies[0]).toBe(false);
  });

  it('rejects explicitly empty VLESS encryption', () => {
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=&type=tcp#Empty`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/encryption/i);
  });

  it.each([
    'unsupported',
    'mlkem768x25519plus.bad-mode.1rtt.padding',
    'mlkem768x25519plus.native.bad-rtt.padding',
    'mlkem768x25519plus.native.1rtt.padding-only',
    `mlkem768x25519plus.native.1rtt.${Buffer.alloc(31, 4).toString('base64url')}`,
  ])('rejects unsupported or malformed VLESS encryption without echoing it: %s', (encryption) => {
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=${encodeURIComponent(encryption)}#BadEncryption`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe('invalid vless encryption');
  });

  it('maps exact security=reality with the required public key and fingerprint', () => {
    const uri =
      `vless://${UUID}@h.example:443?security=reality&sni=h.example&fp=chrome` +
      `&pbk=${FAKE_REALITY_PUBLIC_KEY}&sid=ab12&pcs=${FAKE_CERT_FINGERPRINT}&type=tcp#Reality`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      tls: true,
      servername: 'h.example',
      'client-fingerprint': 'chrome',
      fingerprint: FAKE_CERT_FINGERPRINT,
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
    });
  });

  it.each([
    ['missing public key', `security=reality&fp=chrome`],
    ['empty public key', `security=reality&fp=chrome&pbk=`],
    ['malformed public key', `security=reality&fp=chrome&pbk=not-a-32-byte-key`],
    ['missing fingerprint', `security=reality&pbk=${FAKE_REALITY_PUBLIC_KEY}`],
    ['empty fingerprint', `security=reality&pbk=${FAKE_REALITY_PUBLIC_KEY}&fp=`],
  ])('rejects Reality with %s', (_label, query) => {
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?${query}&type=tcp#BadReality`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/reality/i);
  });

  it.each(['', 'Reality', 'notls', 'tls13', 'unknown'])(
    'rejects an explicit non-standard security constant %j',
    (security) => {
      const { proxies, errors } = parseProxyUriList(
        `vless://${UUID}@h.example:443?security=${security}&type=tcp#BadSecurity`,
      );
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/security/i);
    },
  );

  it('allows omitted security and exact none/tls constants', () => {
    for (const query of ['', 'security=none', 'security=tls']) {
      const separator = query ? `?${query}&` : '?';
      const { proxies, errors } = parseProxyUriList(
        `vless://${UUID}@h.example:443${separator}type=tcp#Security`,
      );
      expect(errors, query).toHaveLength(0);
      expect(proxies, query).toHaveLength(1);
    }
  });

  it.each(['security=tls&security=none', 'Security=tls', 'SECURITY=reality'])(
    'rejects duplicate or wrong-case security parameters: %s',
    (query) => {
      const { proxies, errors } = parseProxyUriList(
        `vless://${UUID}@h.example:443?${query}&type=tcp#AmbiguousSecurity`,
      );
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/parameter|security/i);
    },
  );

  it('type=http remaps to network h2 with h2-opts (mihomo v.go)', () => {
    const uri = `vless://${UUID}@h.example:443?encryption=none&security=tls&type=http&path=%2Fh2&host=cdn.example#H2R`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'h2',
      'h2-opts': { path: '/h2', host: ['cdn.example'] },
    });
    expect(proxies[0]['http-opts']).toBeUndefined();
  });

  it('type=tcp + headerType=http remaps to network http with http-opts', () => {
    const uri = `vless://${UUID}@h.example:443?encryption=none&type=tcp&headerType=http&path=%2Fp&host=cdn.example#HTTP`;
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

  it('maps httpupgrade and its early-data flag without dropping transport options', () => {
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=httpupgrade&path=%2Fup` +
        `&host=cdn.example&ed=2048&eh=X-Early-Data#HU`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      network: 'ws',
      'ws-opts': {
        path: '/up',
        headers: { Host: 'cdn.example' },
        'v2ray-http-upgrade': true,
        'v2ray-http-upgrade-fast-open': true,
        'early-data-header-name': 'X-Early-Data',
      },
    });
  });

  it('maps explicit WebSocket early-data fields', () => {
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=ws&path=%2Fws&ed=1024&eh=X-ED#WSED`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['ws-opts']).toMatchObject({
      'max-early-data': 1024,
      'early-data-header-name': 'X-ED',
    });
  });

  it.each(['type=', 'type=WS', 'type=unknown', 'type=tcp&headerType=UNKNOWN', 'type=ws&ed=1x'])(
    'rejects unknown, wrong-case, or malformed transport input: %s',
    (query) => {
      const { proxies, errors } = parseProxyUriList(
        `vless://${UUID}@h.example:443?${query}#BadTransport`,
      );
      expect(proxies).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/transport|type|early data/i);
    },
  );

  it('full delivery chain: parse → provider YAML → re-parse keeps encryption + xhttp-opts', () => {
    const SYNTH = FAKE_VLESS_MLKEM_ENCRYPTION;
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

  it('full delivery chain emits canonical standard VLESS fields', () => {
    const uri =
      `vless://${UUID}@edge.example:443?encryption=none&security=reality` +
      `&sni=edge.example&fp=chrome&pbk=${FAKE_REALITY_PUBLIC_KEY}&sid=ab12&type=tcp#Canonical`;
    const { yaml, proxyCount } = normaliseToClashProviderYaml(uri);
    expect(proxyCount).toBe(1);
    const parsed = parseYaml(yaml) as { proxies: Record<string, unknown>[] };
    expect(parsed.proxies[0]).toMatchObject({
      encryption: '',
      'packet-encoding': 'xudp',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
    });
    expect(parsed.proxies[0].xudp).toBeUndefined();
    expect(parsed.proxies[0]['packet-addr']).toBeUndefined();
  });

  it('packet encoding uses the canonical packet-encoding field without legacy aliases', () => {
    const def = parseProxyUriList(`vless://${UUID}@h.example:443?encryption=none&type=tcp#PE0`)
      .proxies[0];
    expect(def['packet-encoding']).toBe('xudp');
    expect(def.xudp).toBeUndefined();
    expect(def['packet-addr']).toBeUndefined();

    const packet = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=packet#PE1`,
    ).proxies[0];
    expect(packet['packet-encoding']).toBe('packetaddr');
    expect(packet['packet-addr']).toBeUndefined();
    expect(packet.xudp).toBeUndefined();

    const packetAddr = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=packetaddr#PE1A`,
    ).proxies[0];
    expect(packetAddr['packet-encoding']).toBe('packetaddr');

    const none = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=none#PE2`,
    );
    expect(none.proxies).toHaveLength(0);
    expect(none.errors).toHaveLength(1);
    expect(none.errors[0].error).toMatch(/packet encoding/i);

    const explicitXudp = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=xudp#PE3`,
    ).proxies[0];
    expect(explicitXudp['packet-encoding']).toBe('xudp');
    expect(explicitXudp.xudp).toBeUndefined();

    const kebabAlias = parseProxyUriList(
      `vless://${UUID}@h.example:443?encryption=none&type=tcp&packet-encoding=packetaddr#PE4`,
    ).proxies[0];
    expect(kebabAlias['packet-encoding']).toBe('packetaddr');

    for (const value of ['', 'XUDP', 'unknown']) {
      const { proxies, errors } = parseProxyUriList(
        `vless://${UUID}@h.example:443?encryption=none&type=tcp&packetEncoding=${value}#BadPE`,
      );
      expect(proxies, value).toHaveLength(0);
      expect(errors, value).toHaveLength(1);
      expect(errors[0].error).toMatch(/packet encoding/i);
    }

    const duplicateAliases = parseProxyUriList(
      `vless://${UUID}@h.example:443?packetEncoding=xudp&packet-encoding=none#BadAliases`,
    );
    expect(duplicateAliases.proxies).toHaveLength(0);
    expect(duplicateAliases.errors).toHaveLength(1);
    expect(duplicateAliases.errors[0].error).toMatch(/packet encoding/i);
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
      xmux: { maxConnections: 4, maxConcurrency: '0', hKeepAlivePeriod: 30 },
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
      'sc-max-each-post-bytes': '1000000',
      'reuse-settings': {
        'max-connections': '4',
        'max-concurrency': '0',
        'h-keep-alive-period': 30,
      },
    });
  });

  it('xhttp extra maps root headers, official method spelling, padding defaults, and session defaults', () => {
    const expandedBase62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const extra = {
      headers: { 'X-Audit': 'synthetic' },
      uplinkHTTPMethod: 'get',
      xPaddingObfsMode: true,
      sessionIDTable: 'Base62',
    };
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&mode=packet-up` +
        `&extra=${encodeURIComponent(JSON.stringify(extra))}`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['xhttp-opts']).toMatchObject({
      mode: 'packet-up',
      headers: { 'X-Audit': 'synthetic' },
      'uplink-http-method': 'GET',
      'x-padding-obfs-mode': true,
      'x-padding-key': 'x_padding',
      'x-padding-header': 'X-Padding',
      'x-padding-placement': 'queryInHeader',
      'x-padding-method': 'repeat-x',
      'session-table': expandedBase62,
      'session-length': '16-32',
    });
  });

  it('xhttp extra maps validated padding, placement, session, sequence, and uplink fields', () => {
    const extra = {
      noGRPCHeader: true,
      xPaddingBytes: '100-200',
      xPaddingObfsMode: true,
      xPaddingKey: 'x_padding',
      xPaddingHeader: 'Referer',
      xPaddingPlacement: 'queryInHeader',
      xPaddingMethod: 'tokenish',
      uplinkHttpMethod: 'POST',
      sessionIDPlacement: 'header',
      sessionIDKey: 'X-Session',
      sessionIDTable: '0123456789abcdef',
      sessionIDLength: '16-32',
      seqPlacement: 'query',
      seqKey: 'x_seq',
      uplinkDataPlacement: 'header',
      uplinkDataKey: 'X-Data',
      uplinkChunkSize: 4096,
      scMinPostsIntervalMs: 30,
      xmux: {
        cMaxReuseTimes: '4-8',
        hMaxRequestTimes: 32,
        hMaxReusableSecs: 60,
      },
    };
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&extra=${encodeURIComponent(JSON.stringify(extra))}`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['xhttp-opts']).toMatchObject({
      'no-grpc-header': true,
      'x-padding-bytes': '100-200',
      'x-padding-obfs-mode': true,
      'x-padding-key': 'x_padding',
      'x-padding-header': 'Referer',
      'x-padding-placement': 'queryInHeader',
      'x-padding-method': 'tokenish',
      'uplink-http-method': 'POST',
      'session-placement': 'header',
      'session-key': 'X-Session',
      'session-table': '0123456789abcdef',
      'session-length': '16-32',
      'seq-placement': 'query',
      'seq-key': 'x_seq',
      'uplink-data-placement': 'header',
      'uplink-data-key': 'X-Data',
      'uplink-chunk-size': '4096',
      'sc-min-posts-interval-ms': '30',
      'reuse-settings': {
        'c-max-reuse-times': '4-8',
        'h-max-request-times': '32',
        'h-max-reusable-secs': '60',
      },
    });
  });

  it('normalises XHTTP numeric JSON scalars into Mihomo string ranges end to end', () => {
    const extra = {
      uplinkDataPlacement: 'header',
      uplinkDataKey: 'X-Data',
      uplinkChunkSize: 4096,
      scMaxEachPostBytes: 1_000_000,
      scMinPostsIntervalMs: 30,
    };
    const uri =
      `vless://${UUID}@h.example:443?type=xhttp` +
      `&extra=${encodeURIComponent(JSON.stringify(extra))}#XHTTP-E2E`;

    const normalised = normaliseToClashProviderYaml(uri);
    const proxy = (parseYaml(normalised.yaml) as { proxies: Record<string, unknown>[] }).proxies[0];

    expect(proxy['xhttp-opts']).toMatchObject({
      'uplink-chunk-size': '4096',
      'sc-max-each-post-bytes': '1000000',
      'sc-min-posts-interval-ms': '30',
    });
  });

  it('xhttp extra JSON maps downloadSettings → download-settings (reality)', () => {
    const extra = {
      downloadSettings: {
        address: 'dl.example',
        port: 8443,
        security: 'reality',
        tlsSettings: { fingerprint: 'chrome' },
        realitySettings: { publicKey: FAKE_REALITY_PUBLIC_KEY, shortId: 'ab12' },
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
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
      path: '/dl',
      host: 'dl.example',
    });
  });

  it('xhttp extra accepts nested Reality pbk/sid raw aliases and emits canonical keys', () => {
    const extra = {
      downloadSettings: {
        address: 'dl.example',
        port: 8443,
        security: 'reality',
        tlsSettings: { fingerprint: 'chrome' },
        realitySettings: { pbk: FAKE_REALITY_PUBLIC_KEY, sid: 'ab12' },
      },
    };
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&mode=packet-up` +
        `&extra=${encodeURIComponent(JSON.stringify(extra))}#RealityAliases`,
    );
    expect(errors).toHaveLength(0);
    expect(
      (proxies[0]['xhttp-opts'] as Record<string, unknown>)['download-settings'],
    ).toMatchObject({
      server: 'dl.example',
      port: 8443,
      tls: true,
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': FAKE_REALITY_PUBLIC_KEY, 'short-id': 'ab12' },
    });
  });

  it('xhttp extra rejects stream-one combined with downloadSettings', () => {
    const extra = { downloadSettings: { address: 'dl.example', port: 443 } };
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&mode=stream-one` +
        `&extra=${encodeURIComponent(JSON.stringify(extra))}#ConflictingDownload`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/xhttp extra/i);
  });

  it.each([
    {
      label: 'missing download Reality public key',
      downloadSettings: {
        security: 'reality',
        tlsSettings: { fingerprint: 'chrome' },
        realitySettings: {},
      },
    },
    {
      label: 'missing download Reality fingerprint',
      downloadSettings: {
        security: 'reality',
        realitySettings: { publicKey: FAKE_REALITY_PUBLIC_KEY },
      },
    },
    {
      label: 'unknown download security',
      downloadSettings: { security: 'notls' },
    },
    {
      label: 'out-of-range download port',
      downloadSettings: { address: 'dl.example', port: 70000 },
    },
    {
      label: 'fractional download port',
      downloadSettings: { address: 'dl.example', port: 443.5 },
    },
  ])('rejects $label', ({ downloadSettings }) => {
    const extra = encodeURIComponent(JSON.stringify({ downloadSettings }));
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&extra=${extra}#BadDownload`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/xhttp extra/i);
  });

  it('xhttp extra: malformed JSON is rejected instead of silently dropped', () => {
    const uri = `vless://${UUID}@h.example:443?encryption=none&type=xhttp&mode=auto&extra=%7Bnot-json#XM`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/xhttp extra/i);
  });

  it.each([
    ['wrong xmux scalar type', { xmux: { maxConnections: true } }],
    ['wrong top-level numeric type', { scMaxEachPostBytes: '4096' }],
    ['unknown top-level field', { futureField: true }],
    ['wrong nested xhttp path type', { downloadSettings: { xhttpSettings: { path: 42 } } }],
  ])('xhttp extra rejects %s instead of silently dropping it', (_label, extraObject) => {
    const extra = encodeURIComponent(JSON.stringify(extraObject));
    const { proxies, errors } = parseProxyUriList(
      `vless://${UUID}@h.example:443?type=xhttp&extra=${extra}#StrictExtra`,
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/xhttp extra/i);
  });
});

describe('userinfo and transport ambiguity hardening', () => {
  it.each([
    ['Trojan', 'trojan://alpha:beta@edge.example:443#BadTrojan'],
    ['VLESS', 'vless://00000000-0000-4000-8000-000000000001:ignored@edge.example:443#BadVless'],
    ['AnyTLS', 'anytls://alpha:beta@edge.example:443#BadAnyTLS'],
  ])('rejects an unescaped password delimiter in a single-component %s userinfo', (_label, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/userinfo/i);
  });

  it('preserves an encoded colon in a single-component Trojan password', () => {
    const { proxies, errors } = parseProxyUriList(
      'trojan://alpha%3Abeta@edge.example:443#EncodedColon',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0].password).toBe('alpha:beta');
  });

  it('rejects an unknown Trojan transport instead of letting Mihomo fall back to TCP', () => {
    const { proxies, errors } = parseProxyUriList(
      'trojan://secret@edge.example:443?type=mystery#BadTransport',
    );
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/trojan transport/i);
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

describe('QUIC URI hardening — Hysteria 1 and Hysteria 2', () => {
  it('hysteria://: maps official obfsParam to the Mihomo obfs password', () => {
    const uri =
      'hysteria://h1.example:443?protocol=udp&auth=pa%3Ass&peer=cdn.example&insecure=1&upmbps=10&downmbps=20&alpn=h3%2Chysteria&obfs=xplus&obfsParam=secret%20value#H1%20official';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'H1 official',
      type: 'hysteria',
      server: 'h1.example',
      port: 443,
      protocol: 'udp',
      'auth-str': 'pa:ss',
      sni: 'cdn.example',
      up: '10',
      down: '20',
      alpn: ['h3', 'hysteria'],
      obfs: 'secret value',
      'skip-cert-verify': true,
    });
    expect(proxies[0].obfs).not.toBe('xplus');
  });

  it.each(['udp', 'wechat-video', 'faketcp'])(
    'hysteria://: accepts the target protocol enum %s',
    (protocol) => {
      const { proxies, errors } = parseProxyUriList(
        `hysteria://h1.example:443?protocol=${protocol}&upmbps=10&downmbps=20#H1`,
      );
      expect(errors).toHaveLength(0);
      expect(proxies[0].protocol).toBe(protocol);
    },
  );

  it('hysteria://: keeps the evidenced up/down aliases', () => {
    const { proxies, errors } = parseProxyUriList(
      'hysteria://h1.example:443?up=10%20Mbps&down=20Mbps#aliases',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ up: '10 Mbps', down: '20Mbps' });
  });

  it.each([
    ['missing upload', 'hysteria://h1.example:443?downmbps=20'],
    ['missing download', 'hysteria://h1.example:443?upmbps=10'],
    ['zero upload', 'hysteria://h1.example:443?upmbps=0&downmbps=20'],
    ['malformed download', 'hysteria://h1.example:443?upmbps=10&downmbps=20.5'],
    ['unknown protocol', 'hysteria://h1.example:443?protocol=bbr&upmbps=10&downmbps=20'],
    ['xplus without password', 'hysteria://h1.example:443?upmbps=10&downmbps=20&obfs=xplus'],
    [
      'unknown obfs mode',
      'hysteria://h1.example:443?upmbps=10&downmbps=20&obfs=other&obfsParam=secret',
    ],
  ])('hysteria://: rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('hysteria2://: maps official ech to Mihomo ech-opts', () => {
    const ech = 'ZmFrZS1lY2g=';
    const { proxies, errors } = parseProxyUriList(
      `hysteria2://auth@hy2.example:443?ech=${encodeURIComponent(ech)}#ECH`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['ech-opts']).toEqual({ enable: true, config: ech });
  });

  it('hysteria2://: accepts gecko only with its password', () => {
    const { proxies, errors } = parseProxyUriList(
      'hy2://auth@hy2.example:443?obfs=gecko&obfs-password=secret#gecko',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ obfs: 'gecko', 'obfs-password': 'secret' });
  });

  it('hysteria2://: applies form-query plus decoding and preserves an encoded plus', () => {
    const { proxies, errors } = parseProxyUriList(
      [
        'hy2://auth@hy2.example:443?obfs=salamander&obfs-password=a+b#space',
        'hy2://auth@hy2.example:443?obfs=salamander&obfs-password=a%2Bb#plus',
      ].join('\n'),
    );
    expect(errors).toHaveLength(0);
    expect(proxies.map((proxy) => proxy['obfs-password'])).toEqual(['a b', 'a+b']);
  });

  it('hysteria2://: maps up/down aliases and rejects collisions with upmbps/downmbps', () => {
    const valid = parseProxyUriList('hy2://auth@hy2.example:443?up=10&down=20');
    expect(valid.errors).toHaveLength(0);
    expect(valid.proxies[0]).toMatchObject({ up: '10', down: '20' });

    const collision = parseProxyUriList('hy2://auth@hy2.example:443?up=10&upmbps=10&down=20');
    expect(collision.proxies).toHaveLength(0);
    expect(collision.errors).toHaveLength(1);
  });

  it('hysteria2://: canonicalizes duplicate full ranges before applying the resource budget', () => {
    const repeated = Array.from({ length: 28 }, () => '1-65535').join(',');
    const result = parseProxyUriList(`hy2://auth@hy2.example:${repeated}#merged`);
    expect(result.errors).toHaveLength(0);
    expect(result.proxies[0]).toMatchObject({ port: 1, ports: '1-65535' });
  });

  it('hysteria2://: budgets expanded port candidates per line, not across the list', () => {
    // Shared-across-the-list budgeting was dropped 2026-07-18: providers
    // legitimately repeat a large hop range on every node.
    const result = parseProxyUriList(
      ['hy2://auth@one.example:1-65535#one', 'hy2://auth@two.example:1-65535#two'].join('\n'),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.proxies).toHaveLength(2);
  });

  it.each([
    ['semicolon authority', 'hy2://auth@hy2.example:443;8443#semi'],
    ['semicolon mport', 'hy2://auth@hy2.example:443?mport=443%3B8443#semi-query'],
    ['descending mport range', 'hy2://auth@hy2.example:443?mport=9000-8000#range'],
    ['salamander without password', 'hy2://auth@hy2.example:443?obfs=salamander'],
    ['gecko without password', 'hy2://auth@hy2.example:443?obfs=gecko'],
    ['unknown obfs', 'hy2://auth@hy2.example:443?obfs=xplus&obfs-password=secret'],
    ['password with none', 'hy2://auth@hy2.example:443?obfs=none&obfs-password=secret'],
    ['password without mode', 'hy2://auth@hy2.example:443?obfs-password=secret'],
    ['short certificate fingerprint', 'hy2://auth@hy2.example:443?pinSHA256=abcd'],
  ])('hysteria2://: rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('keeps Hysteria Realm schemes explicitly unsupported', () => {
    const input = [
      'hysteria2+realm://token@realm.example/realm-id',
      'hysteria2+realm+http://token@realm.example/realm-id',
    ].join('\n');
    const { proxies, errors } = parseProxyUriList(input);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors.every(({ error }) => /unsupported scheme/i.test(error))).toBe(true);
  });
});

describe('QUIC URI hardening — TUIC v5 and WireGuard flat dialect', () => {
  const uuid = '019f65ab-a17d-7902-9011-7b6645fa1942';
  const privateKey = Buffer.alloc(32, 1).toString('base64');
  const publicKey = Buffer.alloc(32, 2).toString('base64');
  const preSharedKey = Buffer.alloc(32, 3).toString('base64');
  const wgUri = (query: string, authorityKey = privateKey): string =>
    `wireguard://${encodeURIComponent(authorityKey)}@wg.example:51820?${query}#WG`;

  it.each(['cubic', 'new_reno', 'bbr'])(
    'tuic://: accepts the documented congestion controller %s',
    (controller) => {
      const { proxies, errors } = parseProxyUriList(
        `tuic://${uuid}:secret@tuic.example:443?congestion_control=${controller}`,
      );
      expect(errors).toHaveLength(0);
      expect(proxies[0]['congestion-controller']).toBe(controller);
    },
  );

  it.each(['native', 'quic'])('tuic://: accepts the UDP relay mode %s', (mode) => {
    const { proxies, errors } = parseProxyUriList(
      `tuic://${uuid}:secret@tuic.example:443?udp_relay_mode=${mode}`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['udp-relay-mode']).toBe(mode);
  });

  it('tuic://: maps exact 0/1 booleans without inventing false fields', () => {
    const { proxies, errors } = parseProxyUriList(
      `tuic://${uuid}:secret@tuic.example:443?allow_insecure=1&disable_sni=0`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['skip-cert-verify']).toBe(true);
    expect(proxies[0]['disable-sni']).toBeUndefined();
  });

  it.each([
    ['token-only v4 authority', 'tuic://legacy-token@tuic.example:443'],
    ['missing v5 password', `tuic://${uuid}:@tuic.example:443`],
    ['non-canonical UUID', 'tuic://019F65AB-A17D-7902-9011-7B6645FA1942:secret@tuic.example:443'],
    [
      'unknown congestion controller',
      `tuic://${uuid}:secret@tuic.example:443?congestion_control=reno`,
    ],
    ['unknown UDP relay mode', `tuic://${uuid}:secret@tuic.example:443?udp_relay_mode=stream`],
    ['non-binary insecure flag', `tuic://${uuid}:secret@tuic.example:443?insecure=true`],
    ['non-binary disable-sni flag', `tuic://${uuid}:secret@tuic.example:443?disable_sni=false`],
  ])('tuic://: rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('wireguard://: emits valid keys, prefixes, and known typed options', () => {
    const query = new URLSearchParams({
      'public-key': publicKey,
      address: '10.0.0.2/24,fd00::2/64',
      'pre-shared-key': preSharedKey,
      reserved: '1,2,255',
      mtu: '1420',
      udp: '0',
      'persistent-keepalive': '25',
      workers: '2',
      'refresh-server-ip-interval': '60',
    });
    const { proxies, errors } = parseProxyUriList(wgUri(query.toString()));
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      'private-key': privateKey,
      'public-key': publicKey,
      'pre-shared-key': preSharedKey,
      ip: '10.0.0.2/24',
      ipv6: 'fd00::2/64',
      reserved: [1, 2, 255],
      mtu: 1420,
      udp: false,
      'persistent-keepalive': 25,
      workers: 2,
      'refresh-server-ip-interval': 60,
    });
  });

  it.each([
    ['missing public key', wgUri('address=10.0.0.2%2F32')],
    ['missing local address', wgUri(`publickey=${encodeURIComponent(publicKey)}`)],
    [
      'non-standard private key Base64',
      wgUri(
        `publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32`,
        privateKey.replace(/=+$/, ''),
      ),
    ],
    [
      'wrong-length public key',
      wgUri(
        `publickey=${encodeURIComponent(Buffer.alloc(31, 2).toString('base64'))}&address=10.0.0.2%2F32`,
      ),
    ],
    [
      'invalid local address',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=999.0.0.2%2F32`),
    ],
    [
      'two IPv4 local addresses',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32%2C10.0.0.3%2F32`),
    ],
    [
      'short reserved tuple',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&reserved=1%2C2`),
    ],
    [
      'out-of-byte reserved value',
      wgUri(
        `publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&reserved=1%2C2%2C256`,
      ),
    ],
    [
      'non-binary udp flag',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&udp=true`),
    ],
    [
      'partially numeric MTU',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&mtu=1420junk`),
    ],
    [
      'allowed-ips claim',
      wgUri(
        `publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&allowed-ips=10.0.0.0%2F8`,
      ),
    ],
    [
      'peers claim',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&peers=%5B%5D`),
    ],
    [
      'dns claim',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&dns=1.1.1.1`),
    ],
    [
      'remote DNS claim without representable dns list',
      wgUri(
        `publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&remote-dns-resolve=1`,
      ),
    ],
    [
      'unknown addon',
      wgUri(`publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32&label=edge`),
    ],
  ])('wireguard://: rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});

describe('QUIC URI hardening — Snell, SOCKS, HTTP(S), and AnyTLS', () => {
  it('snell://: materialises the pinned target default version 1', () => {
    const { proxies, errors } = parseProxyUriList('snell://psk@snell.example:443#Snell');
    expect(errors).toHaveLength(0);
    expect(proxies[0].version).toBe(1);
  });

  it.each([1, 2, 3, 4, 5])('snell://: accepts pinned target version %i', (version) => {
    const { proxies, errors } = parseProxyUriList(
      `snell://psk@snell.example:443?version=${version}#Snell`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0].version).toBe(version);
  });

  it.each(['http', 'tls'])('snell://: accepts representable obfs mode %s', (mode) => {
    const { proxies, errors } = parseProxyUriList(
      `snell://psk@snell.example:443?version=4&obfs=${mode}&obfs-host=cdn.example#Snell`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]['obfs-opts']).toEqual({ mode, host: 'cdn.example' });
  });

  it.each([
    ['non-integer version', 'snell://psk@snell.example:443?version=bogus'],
    ['fractional version', 'snell://psk@snell.example:443?version=1.5'],
    ['empty version', 'snell://psk@snell.example:443?version='],
    ['version zero', 'snell://psk@snell.example:443?version=0'],
    ['version above target', 'snell://psk@snell.example:443?version=6'],
    ['negative version', 'snell://psk@snell.example:443?version=-1'],
    ['unknown obfs', 'snell://psk@snell.example:443?obfs=websocket'],
    ['unrepresentable ShadowTLS', 'snell://psk@snell.example:443?obfs=shadow-tls'],
    ['obfs host without a mode', 'snell://psk@snell.example:443?obfs-host=cdn.example'],
  ])('snell://: rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('socks5://: explicit password disables username Base64 guessing', () => {
    const { proxies, errors } = parseProxyUriList(
      'socks5://dXNlcjpwYXNz:literal-pass@socks.example:1080#SOCKS',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      username: 'dXNlcjpwYXNz',
      password: 'literal-pass',
    });
  });

  it('socks5://: explicit empty password still disables Base64 guessing', () => {
    const { proxies, errors } = parseProxyUriList(
      'socks5://dXNlcjpwYXNz:@socks.example:1080#SOCKS-empty',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0].username).toBe('dXNlcjpwYXNz');
    expect(proxies[0].password).toBeUndefined();
  });

  it('socks5://: keeps the username-only Base64 shorthand', () => {
    const { proxies, errors } = parseProxyUriList(
      'socks5://dXNlcjpwYXNz@socks.example:1080#SOCKS-short',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({ username: 'user', password: 'pass' });
  });

  it.each([
    ['http://user:pw@proxy.example:80#HTTP-default', 80, false],
    ['https://user:pw@proxy.example:443#HTTPS-default', 443, true],
    ['https://user%40name:p%3A%23@proxy.example:8443#HTTPS-encoded', 8443, true],
    ['https://user:pw@[2001:db8::8]:443#HTTPS-v6', 443, true],
  ])('HTTP(S): preserves explicit authority port in %s', (uri, port, tls) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].port).toBe(port);
    expect(proxies[0].tls === true).toBe(tls);
  });

  it.each([
    ['explicit root path', 'http://proxy.example:8080/#root'],
    ['query without path', 'http://proxy.example:8080?token=value#query'],
    ['root path plus query', 'https://proxy.example:8443/?token=value#query'],
    ['non-root path', 'http://proxy.example:8080/subscription#path'],
    ['missing explicit port', 'https://proxy.example#origin'],
  ])('HTTP(S): rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('anytls://: accepts the official stable keys with exact 0/1', () => {
    const { proxies, errors } = parseProxyUriList(
      'anytls://p%40ss@any.example?sni=cdn.example&insecure=0#AnyTLS%20official',
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'AnyTLS official',
      password: 'p@ss',
      server: 'any.example',
      port: 443,
      sni: 'cdn.example',
      udp: true,
    });
    expect(proxies[0]['skip-cert-verify']).toBeUndefined();
  });

  it('anytls://: maps the named target extensions with canonical scalar types', () => {
    const query = new URLSearchParams({
      peer: 'cdn.example',
      alpn: 'h2,http/1.1',
      fp: 'chrome',
      udp: '0',
      tfo: '1',
      mptcp: '0',
      'idle-session-check-interval': '30',
      idle_session_timeout: '45',
      'min-idle-session': '2',
    });
    const { proxies, errors } = parseProxyUriList(
      `anytls://secret@any.example:8443?${query.toString()}#AnyTLS-extensions`,
    );
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      sni: 'cdn.example',
      alpn: ['h2', 'http/1.1'],
      'client-fingerprint': 'chrome',
      udp: false,
      tfo: true,
      mptcp: false,
      'idle-session-check-interval': 30,
      'idle-session-timeout': 45,
      'min-idle-session': 2,
    });
  });

  it('anytls://: tolerates a bare "/" and ignores group/type=tcp exporter noise (anytls-bare-slash-metadata)', () => {
    // Real-world 3x-ui/NekoBox shape: `host:port/?addons` plus provider
    // metadata `group` (base64) and a redundant `type=tcp`.
    const uri =
      'anytls://secret@any.example:22001/?peer=cdn.example&insecure=1&udp=1&group=SW1tVGVsZWNvbQ&type=tcp#HKG%2001';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0]).toMatchObject({
      name: 'HKG 01',
      type: 'anytls',
      server: 'any.example',
      port: 22001,
      sni: 'cdn.example',
      'skip-cert-verify': true,
      udp: true,
    });
    expect(proxies[0]).not.toHaveProperty('group');
  });

  it.each([
    ['unknown addon', 'anytls://secret@any.example?unknown_key=value'],
    ['a real path', 'anytls://secret@any.example/ws?sni=any.example'],
    ['a non-tcp transport type', 'anytls://secret@any.example?type=ws'],
    ['non-binary insecure', 'anytls://secret@any.example?insecure=true'],
    ['non-binary udp', 'anytls://secret@any.example?udp=false'],
    ['non-binary tfo', 'anytls://secret@any.example?tfo=true'],
    ['non-integer timing', 'anytls://secret@any.example?idle-session-check-interval=30seconds'],
    ['overflowing idle timeout', 'anytls://secret@any.example?idle-session-timeout=9223372037'],
    ['excess retained sessions', 'anytls://secret@any.example?min-idle-session=257'],
    ['duplicate canonical key', 'anytls://secret@any.example?sni=one.example&sni=two.example'],
  ])('anytls://: rejects %s', (_case, uri) => {
    const { proxies, errors } = parseProxyUriList(uri);
    expect(proxies).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});

// P3-4: anytls / wireguard typed query passthrough (booleans + numbers).
describe('P3-4 typed query passthrough (anytls + wireguard)', () => {
  it('anytls://: ?tfo=1 becomes a boolean, not the string "1"', () => {
    const uri = 'anytls://pwd@h.example:8443?sni=h.example&tfo=1#AT-tfo';
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].tfo).toBe(true);
  });

  it('wireguard://: known booleans and numbers use target scalar types', () => {
    const priv = encodeURIComponent(Buffer.alloc(32, 1).toString('base64'));
    const pub = encodeURIComponent(Buffer.alloc(32, 2).toString('base64'));
    const uri =
      `wireguard://${priv}@wg.example:51820` +
      `?publickey=${pub}&address=10.0.0.2%2F32&udp=0&persistent-keepalive=25#WG`;
    const { proxies, errors } = parseProxyUriList(uri);
    expect(errors).toHaveLength(0);
    expect(proxies[0].udp).toBe(false);
    expect(proxies[0]['persistent-keepalive']).toBe(25);
  });
});

describe('closed URI grammars reject ambiguous or silently dropped input', () => {
  const uuid = '00000000-0000-0000-0000-000000000000';
  const privateKey = Buffer.alloc(32, 1).toString('base64');
  const publicKey = Buffer.alloc(32, 2).toString('base64');
  const wgBase = `wireguard://${encodeURIComponent(privateKey)}@wg.example:51820`;
  const wgRequired = `publickey=${encodeURIComponent(publicKey)}&address=10.0.0.2%2F32`;

  it.each([
    ['Trojan unknown query', 'trojan://pw@edge.example:443?label=ignored'],
    ['Trojan explicit path', 'trojan://pw@edge.example:443/'],
    ['Trojan SNI alias collision', 'trojan://pw@edge.example:443?sni=a.example&peer=b.example'],
    ['Trojan invalid boolean', 'trojan://pw@edge.example:443?insecure=true'],
    ['Trojan orphan WS path', 'trojan://pw@edge.example:443?type=tcp&path=%2Fws'],
    ['Hysteria 1 unknown query', 'hysteria://h.example:443?up=10&down=20&label=x'],
    ['Hysteria 1 userinfo', 'hysteria://pw@h.example:443?up=10&down=20'],
    ['Hysteria 1 explicit path', 'hysteria://h.example:443/?up=10&down=20'],
    ['Hysteria 1 speed alias collision', 'hysteria://h.example:443?up=10&upmbps=10&down=20'],
    ['Hysteria 1 invalid boolean', 'hysteria://h.example:443?up=10&down=20&insecure=true'],
    ['Hysteria 2 unknown query', 'hy2://pw@h.example?label=x'],
    ['Hysteria 2 SNI alias collision', 'hy2://pw@h.example?sni=a.example&peer=b.example'],
    ['Hysteria 2 hop without ports', 'hy2://pw@h.example?hop-interval=30'],
    ['Hysteria 2 malformed hop range', 'hy2://pw@h.example?mport=443-444&hop-interval=30-10'],
    [
      'Hysteria 2 overflowing hop range',
      'hy2://pw@h.example?mport=443-444&hop-interval=9223372037',
    ],
    ['Hysteria 2 unsupported keepalive', 'hy2://pw@h.example?keepalive=15'],
    ['Hysteria 2 invalid speed', 'hy2://pw@h.example?upmbps=0'],
    ['Hysteria 2 authority/mport conflict', 'hy2://pw@h.example:443,8443-8500?mport=8443-8500'],
    ['TUIC unknown query', `tuic://${uuid}:pw@tuic.example:443?label=x`],
    ['TUIC explicit path', `tuic://${uuid}:pw@tuic.example:443/`],
    [
      'TUIC insecure alias collision',
      `tuic://${uuid}:pw@tuic.example:443?allow_insecure=0&insecure=0`,
    ],
    ['TUIC empty ALPN', `tuic://${uuid}:pw@tuic.example:443?alpn=`],
    ['Snell unknown query', 'snell://pw@snell.example:443?label=x'],
    ['Snell explicit path', 'snell://pw@snell.example:443/'],
    ['Snell ambiguous userinfo', 'snell://user:pw@snell.example:443'],
    ['SOCKS explicit root path', 'socks5://user:pw@socks.example:1080/'],
    ['SOCKS query', 'socks5://user:pw@socks.example:1080?udp=1'],
    ['AnyTLS explicit path', 'anytls://pw@any.example:443/ws'],
    ['AnyTLS SNI alias collision', 'anytls://pw@any.example:443?sni=a.example&peer=b.example'],
    ['WireGuard explicit path', `${wgBase}/?${wgRequired}`],
    ['WireGuard address alias collision', `${wgBase}?${wgRequired}&ip=fd00%3A%3A2%2F128`],
    [
      'WireGuard authority/query private key collision',
      `${wgBase}?${wgRequired}&private-key=${encodeURIComponent(privateKey)}`,
    ],
    ['WireGuard excessive worker fanout', `${wgBase}?${wgRequired}&workers=257`],
    [
      'WireGuard overflowing refresh interval',
      `${wgBase}?${wgRequired}&refresh-server-ip-interval=9223372037`,
    ],
  ])('rejects %s', (_label, uri) => {
    const result = parseProxyUriList(uri);
    expect(result.proxies).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it.each([
    ['empty object', {}],
    ['fractional top-level integer', { uplinkChunkSize: 1.5 }],
    ['invalid root range', { xPaddingBytes: '100-' }],
    ['duplicate session aliases', { sessionIDPlacement: 'path', sessionPlacement: 'path' }],
    ['wrong noGRPCHeader type', { noGRPCHeader: 'true' }],
    ['orphan session length', { sessionIDLength: 16 }],
    ['session length above policy budget', { sessionIDTable: 'abc', sessionIDLength: 257 }],
    ['insufficient session entropy', { sessionIDTable: 'a', sessionIDLength: 16 }],
    ['positive xmux modes conflict', { xmux: { maxConnections: 1, maxConcurrency: 1 } }],
    [
      'official and compatibility method aliases collide',
      { uplinkHTTPMethod: 'POST', uplinkHttpMethod: 'POST' },
    ],
    ['GET requires packet-up', { uplinkHTTPMethod: 'GET' }],
    ['root Host header is forbidden', { headers: { host: 'edge.example' } }],
    [
      'nested Host header is forbidden',
      { downloadSettings: { xhttpSettings: { headers: { HOST: 'edge.example' } } } },
    ],
    ['orphan uplink chunk size', { uplinkChunkSize: 4096 }],
    [
      'zero uplink chunk size',
      { uplinkDataPlacement: 'header', uplinkDataKey: 'X-Data', uplinkChunkSize: 0 },
    ],
    ['unknown xmux key', { xmux: { maxConnections: 2, label: 'x' } }],
    ['fractional xmux integer', { xmux: { maxConnections: 2.5 } }],
    [
      'unknown download TLS key',
      { downloadSettings: { security: 'tls', tlsSettings: { fingerprint: 'chrome', label: 'x' } } },
    ],
    ['empty download security', { downloadSettings: { address: 'dl.example', security: '' } }],
    [
      'non-string nested header',
      { downloadSettings: { xhttpSettings: { headers: { Host: { value: 'edge.example' } } } } },
    ],
    [
      'unknown nested extra key',
      {
        downloadSettings: { xhttpSettings: { extra: { xmux: { maxConnections: 2 }, label: 'x' } } },
      },
    ],
    [
      'Reality alias collision',
      {
        downloadSettings: {
          security: 'reality',
          tlsSettings: { fingerprint: 'chrome' },
          realitySettings: {
            pbk: FAKE_REALITY_PUBLIC_KEY,
            publicKey: FAKE_REALITY_PUBLIC_KEY,
          },
        },
      },
    ],
  ])('rejects XHTTP extra with %s', (_label, extra) => {
    const result = parseProxyUriList(
      `vless://${uuid}@h.example:443?type=xhttp&extra=${encodeURIComponent(JSON.stringify(extra))}`,
    );
    expect(result.proxies).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/xhttp extra/i);
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

// Fixed Mihomo v1.19.28 uses dlclark/regexp2, not Go RE2. The preview accepts
// its safe ECMAScript-compatible subset and rejects constructs whose Unicode
// meaning differs between regexp2 and JS.
describe('P3-6 matchFilter fixed-regexp2 compatibility', () => {
  const nodes = ['🇺🇸 US-01', 'US-US', '🇭🇰 HK-01', 'Australia-1', '香港', '😀'];

  it('accepts safe lookahead (?=…)', () => {
    const res = matchFilter(nodes, 'US(?=-)');
    expect(res.error).toBeNull();
    expect(res.matched).toEqual(['🇺🇸 US-01', 'US-US']);
  });

  it('accepts safe negative lookbehind (?<!…)', () => {
    const res = matchFilter(nodes, '(?<!A)US');
    expect(res.error).toBeNull();
    expect(res.matched).toEqual(['🇺🇸 US-01', 'US-US']);
  });

  it('accepts a safe backreference (\\1)', () => {
    const res = matchFilter(nodes, '(US)-\\1');
    expect(res.error).toBeNull();
    expect(res.matched).toEqual(['US-US']);
  });

  it.each(['^\\w+$', '\\bUS\\b', '^\\p{L}+$'])(
    'rejects a JS/regexp2 Unicode-semantic mismatch: %s',
    (pattern) => {
      const res = matchFilter(nodes, pattern);
      expect(res.matched).toHaveLength(0);
      expect(res.error).toBeTruthy();
    },
  );

  it.each(['(?i)(K|KK)+$', '(?i)(ß|ẞß)+$', '(?i)(K|\\u212AK)+$', '(?i)(ß|\\u1E9Eß)+$'])(
    'rejects Unicode IgnoreCase overlap that the safety analyzer cannot model: %s',
    (pattern) => {
      const res = matchFilter(nodes, pattern);
      expect(res.matched).toHaveLength(0);
      expect(res.error).toBeTruthy();
    },
  );

  it.each(['(?i)(K|[℀-∀]K)+$', '(?i)(K|[\\u2100-\\u2200]K)+$'])(
    'rejects a Unicode IgnoreCase class range that can hide a folding code point: %s',
    (pattern) => {
      const res = matchFilter(nodes, pattern);
      expect(res.matched).toHaveLength(0);
      expect(res.error).toBeTruthy();
    },
  );

  it('keeps uncased non-ASCII names usable under IgnoreCase', () => {
    expect(matchFilter(nodes, '(?i)🇺🇸|香港').error).toBeNull();
  });

  it('uses Unicode code points for dot and supports backtick-separated OR filters', () => {
    expect(matchFilter(['😀'], '^.$')).toEqual({ matched: ['😀'], error: null });
    expect(matchFilter(nodes, 'HK`US-01').matched).toEqual(['🇺🇸 US-01', '🇭🇰 HK-01']);
  });
});
