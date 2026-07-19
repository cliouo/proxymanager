import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  MAX_HYSTERIA_PORT_CANDIDATES,
  MAX_PROXY_NAME_LENGTH,
  MAX_PROXY_NODES,
  validateMihomoProxyList,
} from '@/lib/proxies/mihomoProxyValidator';

const endpoint = (type: string): Record<string, unknown> => ({
  name: 'SAFE-NODE',
  type,
  server: 'edge.invalid',
  port: 443,
});

const wireGuardPrivateKey = Buffer.alloc(32, 1).toString('base64');
const wireGuardPublicKey = Buffer.alloc(32, 2).toString('base64');
const masqueEcKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const masquePrivateKey = masqueEcKeyPair.privateKey
  .export({ format: 'der', type: 'sec1' })
  .toString('base64');
const masquePublicKey = masqueEcKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const openVpnCertificatePem = '-----BEGIN CERTIFICATE-----\nRkFLRQ==\n-----END CERTIFICATE-----';
const openVpnPrivateKeyPem = '-----BEGIN PRIVATE KEY-----\nRkFLRQ==\n-----END PRIVATE KEY-----';
const openVpnStaticKey = [
  '-----BEGIN OpenVPN Static key V1-----',
  Buffer.alloc(256, 4).toString('hex'),
  '-----END OpenVPN Static key V1-----',
].join('\n');

const fixedShadowsocksMethods = [
  'none',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'rc4-md5',
  'chacha20-ietf',
  'xchacha20',
  'chacha20',
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305',
  'chacha8-ietf-poly1305',
  'xchacha8-ietf-poly1305',
  'rabbit128-poly1305',
  'aes-128-ccm',
  'aes-192-ccm',
  'aes-256-ccm',
  'aes-128-gcm-siv',
  'aes-256-gcm-siv',
  'aegis-128l',
  'aegis-256',
  'aez-384',
  'deoxys-ii-256-128',
  'lea-128-gcm',
  'lea-192-gcm',
  'lea-256-gcm',
  'ascon128',
  'ascon128a',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  '2022-blake3-chacha8-poly1305',
  '2022-blake3-aes-128-ccm',
  '2022-blake3-aes-256-ccm',
] as const;

const shadowsocks2022KeyLengths: Readonly<Record<string, number>> = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
  '2022-blake3-chacha8-poly1305': 32,
  '2022-blake3-aes-128-ccm': 16,
  '2022-blake3-aes-256-ccm': 32,
};

const passwordForShadowsocksCipher = (cipher: string): string => {
  const keyLength = shadowsocks2022KeyLengths[cipher];
  return keyLength === undefined ? 'FAKE_ONLY' : Buffer.alloc(keyLength, 7).toString('base64');
};

const fixedShadowsocksRCiphers = [
  'none',
  'dummy',
  'rc4-md5',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'chacha20',
  'chacha20-ietf',
  'xchacha20',
] as const;

const fixedVmessCiphers = [
  'auto',
  'none',
  'zero',
  'aes-128-cfb',
  'aes-128-gcm',
  'chacha20-poly1305',
] as const;

const portableStructuralMinimums: Record<string, unknown>[] = [
  { ...endpoint('ss'), password: 'FAKE_ONLY', cipher: 'aes-128-gcm' },
  {
    ...endpoint('ssr'),
    password: 'FAKE_ONLY',
    cipher: 'aes-128-ctr',
    obfs: 'plain',
    protocol: 'origin',
  },
  endpoint('socks5'),
  endpoint('http'),
  {
    ...endpoint('vmess'),
    uuid: '00000000-0000-4000-8000-000000000001',
    cipher: 'auto',
  },
  { ...endpoint('vless'), uuid: '00000000-0000-4000-8000-000000000001' },
  { ...endpoint('snell'), psk: 'FAKE_ONLY' },
  { ...endpoint('trojan'), password: 'FAKE_ONLY' },
  { ...endpoint('hysteria'), up: '10 Mbps', down: '20 Mbps' },
  { ...endpoint('hysteria2'), password: 'FAKE_ONLY' },
  {
    name: 'SAFE-NODE',
    type: 'wireguard',
    server: 'edge.invalid',
    port: 51820,
    ip: '172.16.0.2/32',
    'private-key': wireGuardPrivateKey,
    'public-key': wireGuardPublicKey,
  },
  { ...endpoint('tuic'), token: 'FAKE_ONLY' },
  endpoint('gost-relay'),
  { name: 'SAFE-NODE', type: 'direct' },
  { name: 'SAFE-NODE', type: 'dns' },
  { name: 'SAFE-NODE', type: 'reject' },
  { name: 'SAFE-NODE', type: 'rematch', 'target-sub-rule': 'SAFE-SUB-RULE' },
  { ...endpoint('ssh'), username: 'FAKE_USER', password: 'FAKE_PASSWORD' },
  {
    ...endpoint('mieru'),
    transport: 'TCP',
    username: 'FAKE_USER',
    password: 'FAKE_PASSWORD',
  },
  { ...endpoint('anytls'), password: 'FAKE_ONLY' },
  { ...endpoint('sudoku'), key: 'FAKE_ONLY' },
  {
    ...endpoint('masque'),
    'private-key': masquePrivateKey,
    'public-key': masquePublicKey,
    ip: '172.16.0.2/32',
  },
  endpoint('trusttunnel'),
  {
    ...endpoint('openvpn'),
    ca: openVpnCertificatePem,
    username: 'FAKE_USER',
    password: 'FAKE_PASSWORD',
  },
];

describe('fixed Mihomo v1.19.28 proxy node validation', () => {
  it.each(portableStructuralMinimums.map((proxy) => [proxy.type as string, proxy]))(
    'accepts the portable structural minimum for %s',
    (_type, proxy) => {
      expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
    },
  );

  it.each(portableStructuralMinimums.map((proxy) => [proxy.type as string, proxy]))(
    'rejects unsupported top-level fields for the fixed %s descriptor',
    (_type, proxy) => {
      expect(() =>
        validateMihomoProxyList([{ ...proxy, FAKE_SECRET_UNKNOWN_FIELD: true }]),
      ).toThrow(/field "proxy" contains an unsupported top-level field/);
    },
  );

  it.each([
    ['VLESS flow array', { ...portableStructuralMinimums[5], flow: [] }, 'flow'],
    [
      'TUIC congestion controller array',
      { ...portableStructuralMinimums[11], 'congestion-controller': [] },
      'congestion-controller',
    ],
    [
      'AnyTLS idle timeout array',
      { ...portableStructuralMinimums[19], 'idle-session-timeout': [] },
      'idle-session-timeout',
    ],
    ['SOCKS username array', { ...portableStructuralMinimums[2], username: [] }, 'username'],
    [
      'Shadowsocks plugin options array',
      { ...portableStructuralMinimums[0], plugin: 'obfs', 'plugin-opts': [] },
      'plugin-opts',
    ],
    ['Hysteria ECH scalar', { ...portableStructuralMinimums[8], 'ech-opts': 'bad' }, 'ech-opts'],
  ])('rejects top-level primitive poisoning: %s', (_label, proxy, field) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "${field}"`));
  });

  it('returns the original records without credential-changing copies', () => {
    const proxy = {
      ...endpoint('ss'),
      password: 'FAKE_ONLY',
      cipher: 'aes-128-gcm',
    };
    const result = validateMihomoProxyList([proxy]);
    expect(result[0]).toBe(proxy);
  });

  it('accepts udp on a direct proxy as inert noise (mihomo decoder has no ErrorUnused)', () => {
    const proxy = { name: '直连', type: 'direct', udp: true };
    expect(validateMihomoProxyList([proxy])[0]).toBe(proxy);
    expect(() => validateMihomoProxyList([{ name: '直连', type: 'direct', udp: 'yes' }])).toThrow(
      /field "udp" must be a boolean/,
    );
  });

  it('accepts exactly the inclusive proxy node limit', () => {
    const proxies = Array.from({ length: MAX_PROXY_NODES }, (_, index) => ({
      name: `SAFE-NODE-${index}`,
      type: 'direct',
    }));
    expect(validateMihomoProxyList(proxies)).toHaveLength(MAX_PROXY_NODES);
  });

  it('rejects one node above the limit before reflecting or parsing node data', () => {
    const proxies = Array.from({ length: MAX_PROXY_NODES + 1 }, (_, index) => ({
      name: `FAKE_SECRET_NODE_${index}`,
      type: 'direct',
    }));
    let thrown: unknown;
    try {
      validateMihomoProxyList(proxies);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProblemDetailsError);
    expect((thrown as Error).message).toContain('50001');
    expect((thrown as Error).message).toContain('50000');
    expect((thrown as Error).message).not.toContain('FAKE_SECRET');
  });

  it('rejects proxy names above the bounded regex/runtime input length', () => {
    expect(() =>
      validateMihomoProxyList([{ name: 'N'.repeat(MAX_PROXY_NAME_LENGTH + 1), type: 'direct' }]),
    ).toThrow(new RegExp(`field "name" must not exceed ${MAX_PROXY_NAME_LENGTH} characters`));
  });

  it('rejects duplicate names before downstream first-writer dedup can hide a node', () => {
    const first = { ...portableStructuralMinimums[0], name: 'DUPLICATE' };
    const second = { ...portableStructuralMinimums[3], name: 'DUPLICATE' };
    expect(() => validateMihomoProxyList([first, second])).toThrow(
      /index 1: field "name" duplicates another proxy entry/,
    );
  });

  it('accepts an internal dialer-proxy chain and rejects dangling or cyclic references', () => {
    const upstream = { ...portableStructuralMinimums[0], name: 'UPSTREAM' };
    const chained = {
      ...portableStructuralMinimums[3],
      name: 'CHAINED',
      'dialer-proxy': 'UPSTREAM',
    };
    expect(validateMihomoProxyList([upstream, chained])).toEqual([upstream, chained]);
    expect(() =>
      validateMihomoProxyList([{ ...chained, 'dialer-proxy': 'DOES-NOT-EXIST' }]),
    ).toThrow(/field "dialer-proxy" references a proxy outside this node source/);
    expect(() =>
      validateMihomoProxyList([
        { ...upstream, 'dialer-proxy': 'CHAINED' },
        { ...chained, 'dialer-proxy': 'UPSTREAM' },
      ]),
    ).toThrow(/field "dialer-proxy" creates a dependency cycle/);
  });

  it.each([
    ['direct', portableStructuralMinimums[13]],
    ['dns', portableStructuralMinimums[14]],
  ])('allows only constructor-consumed BasicOption fields on endpoint-free %s', (_type, base) => {
    const proxy = {
      ...base,
      tfo: true,
      mptcp: false,
      'interface-name': 'en0',
      'routing-mark': 123,
      'ip-version': 'ipv4-prefer',
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each([
    ['direct', portableStructuralMinimums[13]],
    ['dns', portableStructuralMinimums[14]],
  ])('rejects inert dialer-proxy and smux fields on endpoint-free %s', (_type, base) => {
    const upstream = { ...portableStructuralMinimums[0], name: 'UPSTREAM' };
    expect(() =>
      validateMihomoProxyList([
        upstream,
        { ...base, name: 'ENDPOINT-FREE', 'dialer-proxy': 'UPSTREAM' },
      ]),
    ).toThrow(/field "proxy" contains an unsupported top-level field/);
    expect(() => validateMihomoProxyList([{ ...base, smux: { enabled: true } }])).toThrow(
      /field "proxy" contains an unsupported top-level field/,
    );
  });

  it.each([
    ['reject', portableStructuralMinimums[15]],
    ['rematch', portableStructuralMinimums[16]],
  ])('rejects every ignored BasicOption and smux field on endpoint-free %s', (_type, base) => {
    const ignoredFields = [
      ['tfo', true],
      ['mptcp', true],
      ['interface-name', 'en0'],
      ['routing-mark', 123],
      ['ip-version', 'ipv4-prefer'],
      ['dialer-proxy', 'UPSTREAM'],
      ['smux', { enabled: true }],
    ] as const;
    const upstream = { ...portableStructuralMinimums[0], name: 'UPSTREAM' };

    for (const [field, value] of ignoredFields) {
      expect(() =>
        validateMihomoProxyList([upstream, { ...base, name: 'ENDPOINT-FREE', [field]: value }]),
      ).toThrow(/field "proxy" contains an unsupported top-level field/);
    }
  });

  it('rejects subscription-controlled TLS filesystem paths while allowing trusted base policy', () => {
    const pathBacked = {
      ...portableStructuralMinimums[7],
      certificate: './client.crt',
      'private-key': './client.key',
    };
    expect(() => validateMihomoProxyList([pathBacked])).toThrow(
      /field "certificate" must be inline PEM material/,
    );
    expect(
      validateMihomoProxyList([pathBacked], {
        allowExternalDialerProxy: true,
        allowLocalFileReferences: true,
      }),
    ).toEqual([pathBacked]);
  });

  it('rejects TLS filesystem paths nested in Shadowsocks plugin options', () => {
    const pluginPathBacked = {
      ...portableStructuralMinimums[0],
      plugin: 'v2ray-plugin',
      'plugin-opts': {
        mode: 'websocket',
        tls: true,
        certificate: '-----BEGIN CERTIFICATE-----\nFAKE_ONLY\n-----END CERTIFICATE-----',
        'private-key': './client.key',
      },
    };
    expect(() => validateMihomoProxyList([pluginPathBacked])).toThrow(
      /field "plugin-opts\.private-key" must be inline PEM material/,
    );
    expect(validateMihomoProxyList([pluginPathBacked], { allowLocalFileReferences: true })).toEqual(
      [pluginPathBacked],
    );
  });

  it('rejects present but incomplete or malformed Reality options before fixed Mihomo', () => {
    const vless = portableStructuralMinimums[5];
    expect(() => validateMihomoProxyList([{ ...vless, tls: true, 'reality-opts': {} }])).toThrow(
      /field "reality-opts.public-key"/,
    );
    expect(() =>
      validateMihomoProxyList([
        {
          ...vless,
          tls: true,
          'reality-opts': { 'public-key': 'not-a-key', 'short-id': 'xyz' },
        },
      ]),
    ).toThrow(/field "reality-opts.public-key"/);
  });

  it.each(['unknown', 'select', 'url-test', 'fallback', 'load-balance', 'relay'])(
    'rejects unknown and policy/group type %s even when an endpoint is present',
    (type) => {
      expect(() => validateMihomoProxyList([endpoint(type)])).toThrow(
        /index 0: field "type" is not supported by fixed Mihomo v1\.19\.28/,
      );
    },
  );

  it.each(['reject-drop', 'pass', 'compatible'])(
    'rejects legacy endpoint-free heuristic type %s because ParseProxy does not dispatch it',
    (type) => {
      expect(() => validateMihomoProxyList([{ name: 'SAFE-NODE', type }])).toThrow(
        /field "type" is not supported/,
      );
    },
  );

  it.each(['SS', 'Vless', ' ss', 'ss '])('rejects non-canonical type spelling %s', (type) => {
    expect(() => validateMihomoProxyList([endpoint(type)])).toThrow(
      /field "type" must be a canonical lowercase type/,
    );
  });

  it('rejects tailscale instead of guessing whether the runtime build includes it', () => {
    expect(() => validateMihomoProxyList([{ name: 'SAFE-NODE', type: 'tailscale' }])).toThrow(
      /field "type" requires a build-dependent runtime capability/,
    );
  });

  it.each([
    ['non-object', 'FAKE_SECRET_DO_NOT_LOG'],
    ['array', ['FAKE_SECRET_DO_NOT_LOG']],
    ['missing name', { type: 'direct' }],
    ['empty name', { name: ' ', type: 'direct' }],
    ['control character name', { name: 'SAFE\nUNSAFE', type: 'direct' }],
    ['missing type', { name: 'SAFE-NODE' }],
    ['empty type', { name: 'SAFE-NODE', type: '' }],
  ])('rejects %s entries with an indexed field error', (_label, proxy) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(/index 0: field/);
  });

  it.each([
    ['missing server', { ...endpoint('http'), server: undefined }],
    ['numeric server', { ...endpoint('http'), server: 203000113001 }],
    ['empty server', { ...endpoint('http'), server: ' ' }],
    ['missing port', { ...endpoint('http'), port: undefined }],
    // A canonical digit-string port now coerces (WeaklyTypedInput mirror);
    // only non-canonical strings stay rejected.
    ['non-canonical string port', { ...endpoint('http'), port: '4,43' }],
    ['fractional port', { ...endpoint('http'), port: 443.5 }],
    ['zero port', { ...endpoint('http'), port: 0 }],
    ['overflowing port', { ...endpoint('http'), port: 65536 }],
  ])('rejects strict endpoint violation: %s', (_label, proxy) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(/index 0: field "(server|port)"/);
  });

  it.each([
    ['ss', 'password'],
    ['ss', 'cipher'],
    ['ssr', 'password'],
    ['ssr', 'cipher'],
    ['ssr', 'obfs'],
    ['ssr', 'protocol'],
    ['vmess', 'uuid'],
    ['vmess', 'cipher'],
    ['vless', 'uuid'],
    ['trojan', 'password'],
    ['snell', 'psk'],
    // hysteria up/down accept integers now (weakly typed FormatInt mirror);
    // their required-string shape is covered by the float rejection below.
    ['hysteria', 'up', 4.2],
    ['hysteria', 'down', 4.2],
    ['anytls', 'password'],
  ])('requires %s.%s as a non-empty string', (type, field, value: unknown = 42) => {
    const proxy = {
      ...portableStructuralMinimums.find((candidate) => candidate.type === type),
      [field]: value,
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(
      new RegExp(`index 0: field "${field}" must be a non-empty string`),
    );
  });

  it.each([
    ['vmess', 'tcp'],
    ['vmess', 'ws'],
    ['vmess', 'http'],
    ['vmess', 'h2'],
    ['vmess', 'grpc'],
    ['vmess', 'mekya'],
    ['vmess', 'mkcp'],
    ['vmess', 'kcp'],
    ['vless', 'tcp'],
    ['vless', 'ws'],
    ['vless', 'http'],
    ['vless', 'h2'],
    ['vless', 'grpc'],
    ['vless', 'xhttp'],
    ['trojan', 'tcp'],
    ['trojan', 'ws'],
    ['trojan', 'grpc'],
  ])('accepts fixed %s network %s', (type, network) => {
    const proxy = {
      ...portableStructuralMinimums.find((candidate) => candidate.type === type),
      network,
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each([
    ['vmess', 'xhttp'],
    ['vmess', 'quic'],
    ['vmess', 'httpupgrade'],
    ['vless', 'mekya'],
    ['vless', 'quic'],
    ['trojan', 'http'],
    ['trojan', 'h2'],
    ['trojan', 'xhttp'],
    ['trojan', ''],
  ])('rejects unsupported %s network %s', (type, network) => {
    const proxy = {
      ...portableStructuralMinimums.find((candidate) => candidate.type === type),
      network,
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(/field "network"/);
  });

  it.each([
    ['vmess', 'ws', 'ws-opts'],
    ['vmess', 'http', 'http-opts'],
    ['vmess', 'h2', 'h2-opts'],
    ['vmess', 'grpc', 'grpc-opts'],
    ['vmess', 'mekya', 'mekya-opts'],
    ['vmess', 'mkcp', 'mkcp-opts'],
    ['vmess', 'kcp', 'mkcp-opts'],
    ['vless', 'xhttp', 'xhttp-opts'],
  ])('accepts matching %s %s transport options in %s', (type, network, optionsField) => {
    const proxy = {
      ...portableStructuralMinimums.find((candidate) => candidate.type === type),
      network,
      [optionsField]: {},
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it('rejects malformed, mismatched, and orphan transport option containers', () => {
    const vmess = portableStructuralMinimums[4];
    expect(() => validateMihomoProxyList([{ ...vmess, network: 'ws', 'ws-opts': 'bad' }])).toThrow(
      /field "ws-opts" must be a plain object/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...vmess, network: 'ws', 'ws-opts': new Date(0) }]),
    ).toThrow(/field "ws-opts" must be a plain object/);
    expect(() => validateMihomoProxyList([{ ...vmess, network: 'ws', 'grpc-opts': {} }])).toThrow(
      /field "grpc-opts" does not match the selected network/,
    );
    expect(() => validateMihomoProxyList([{ ...vmess, 'ws-opts': {} }])).toThrow(
      /field "ws-opts" does not match the selected network/,
    );
  });

  it.each([
    [
      'WS',
      'vless',
      'ws',
      'ws-opts',
      {
        path: '/ws',
        headers: { Host: 'edge.invalid', 'X-Test': 'safe' },
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol',
        'v2ray-http-upgrade': true,
        'v2ray-http-upgrade-fast-open': false,
      },
    ],
    [
      'HTTP',
      'vmess',
      'http',
      'http-opts',
      { method: 'GET', path: ['/', '/video'], headers: { Connection: ['keep-alive'] } },
    ],
    ['H2', 'vless', 'h2', 'h2-opts', { host: ['one.invalid', 'two.invalid'], path: '/h2' }],
    [
      'gRPC',
      'trojan',
      'grpc',
      'grpc-opts',
      {
        'grpc-service-name': 'GunService',
        'grpc-user-agent': 'grpc-go/1.36.0',
        'ping-interval': 30,
        'max-connections': 2,
        'min-streams': 1,
        'max-streams': 0,
      },
    ],
    [
      'XHTTP',
      'vless',
      'xhttp',
      'xhttp-opts',
      {
        path: '/xhttp',
        host: 'cdn.invalid',
        mode: 'packet-up',
        headers: { 'X-Test': 'safe' },
        'no-grpc-header': false,
        'x-padding-bytes': '100-1000',
        'x-padding-obfs-mode': true,
        'x-padding-key': 'x_padding',
        'x-padding-header': 'X-Padding',
        'x-padding-placement': 'queryInHeader',
        'x-padding-method': 'repeat-x',
        'uplink-http-method': 'POST',
        'session-placement': 'query',
        'session-key': 'x_session',
        'session-table': 'abcdefghijklmnopqrstuvwxyz',
        'session-length': '8-12',
        'seq-placement': 'header',
        'seq-key': 'X-Seq',
        'uplink-data-placement': 'header',
        'uplink-data-key': 'X-Data',
        'uplink-chunk-size': '64-128',
        'sc-max-each-post-bytes': '1000000',
        'sc-min-posts-interval-ms': '30',
        'reuse-settings': {
          'max-concurrency': '0',
          'max-connections': '1-2',
          'c-max-reuse-times': '0',
          'h-max-request-times': '600-900',
          'h-max-reusable-secs': '1800-3000',
          'h-keep-alive-period': 30,
        },
        'download-settings': {
          path: '/download',
          host: 'download.invalid',
          headers: { 'X-Download': 'safe' },
          'reuse-settings': {
            'max-concurrency': '1',
            'max-connections': '0',
            'c-max-reuse-times': '2',
            'h-max-request-times': '10',
            'h-max-reusable-secs': '60',
            'h-keep-alive-period': 15,
          },
          server: 'download.invalid',
          port: 443,
          tls: true,
          alpn: ['h2'],
          'skip-cert-verify': false,
          fingerprint: 'FAKE_CERT_PIN',
          servername: 'download.invalid',
          'client-fingerprint': 'chrome',
        },
      },
    ],
    [
      'Mekya',
      'vmess',
      'mekya',
      'mekya-opts',
      {
        url: 'https://edge.invalid/mekya',
        'h2-pool-size': 8,
        'max-write-delay': 80,
        'max-request-size': 96000,
        'polling-interval-initial': 200,
        'max-write-size': 1048576,
        'max-write-duration-ms': 100,
        'max-simultaneous-write-connection': 16,
        'packet-writing-buffer': 1024,
        kcp: {
          mtu: 1350,
          tti: 15,
          'uplink-capacity': 40,
          'downlink-capacity': 2000,
          congestion: false,
          'write-buffer': 67108864,
          'read-buffer': 67108864,
          seed: 'synthetic-seed',
          header: 'wechat-video',
        },
      },
    ],
    [
      'mKCP',
      'vmess',
      'mkcp',
      'mkcp-opts',
      {
        mtu: 1350,
        tti: 50,
        'uplink-capacity': 5,
        'downlink-capacity': 20,
        congestion: false,
        'write-buffer': 2097152,
        'read-buffer': 2097152,
        seed: 'synthetic-seed',
        header: 'none',
      },
    ],
  ])(
    'accepts every fixed %s transport option field with canonical types',
    (_label, type, network, optionsField, options) => {
      const proxy = {
        ...portableStructuralMinimums.find((candidate) => candidate.type === type),
        network,
        [optionsField]: options,
      };
      expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
    },
  );

  it.each([
    ['VLESS WS headers scalar', 'vless', 'ws', 'ws-opts', { headers: 'bad' }, 'headers'],
    ['VLESS WS path array', 'vless', 'ws', 'ws-opts', { path: [] }, 'path'],
    [
      'Trojan gRPC service array',
      'trojan',
      'grpc',
      'grpc-opts',
      { 'grpc-service-name': [] },
      'grpc-service-name',
    ],
    ['HTTP path scalar', 'vmess', 'http', 'http-opts', { path: '/' }, 'path'],
    ['H2 host scalar', 'vless', 'h2', 'h2-opts', { host: 'edge.invalid' }, 'host'],
    ['XHTTP headers array', 'vless', 'xhttp', 'xhttp-opts', { headers: [] }, 'headers'],
    ['Mekya nested KCP scalar', 'vmess', 'mekya', 'mekya-opts', { kcp: true }, 'kcp'],
    ['mKCP uint32 overflow', 'vmess', 'mkcp', 'mkcp-opts', { mtu: 2 ** 32 }, 'mtu'],
  ])(
    'rejects fixed-constructor transport poisoning: %s',
    (_label, type, network, optionsField, options, badField) => {
      const proxy = {
        ...portableStructuralMinimums.find((candidate) => candidate.type === type),
        network,
        [optionsField]: options,
      };
      expect(() => validateMihomoProxyList([proxy])).toThrow(
        new RegExp(`field "${optionsField}\\.${badField}"`),
      );
    },
  );

  it.each([
    ['ws', 'ws-opts'],
    ['http', 'http-opts'],
    ['h2', 'h2-opts'],
    ['grpc', 'grpc-opts'],
    ['xhttp', 'xhttp-opts'],
    ['mekya', 'mekya-opts'],
    ['mkcp', 'mkcp-opts'],
  ])('rejects unknown fields inside %s transport options', (network, optionsField) => {
    const type = network === 'xhttp' || network === 'h2' ? 'vless' : 'vmess';
    const proxy = {
      ...portableStructuralMinimums.find((candidate) => candidate.type === type),
      network,
      [optionsField]: { unknown: true },
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(
      new RegExp(`field "${optionsField}" contains an unsupported field`),
    );
  });

  it('rejects kcp-opts because fixed Mihomo only decodes mkcp-opts', () => {
    const vmess = portableStructuralMinimums[4];
    expect(() =>
      validateMihomoProxyList([{ ...vmess, network: 'mkcp', 'kcp-opts': { mtu: 1350 } }]),
    ).toThrow(/field "kcp-opts" is not decoded by fixed Mihomo; use mkcp-opts/);
  });

  it('enforces non-negative gRPC controls and mutually exclusive mux modes', () => {
    const trojan = portableStructuralMinimums[7];
    expect(() =>
      validateMihomoProxyList([
        { ...trojan, network: 'grpc', 'grpc-opts': { 'ping-interval': -1 } },
      ]),
    ).toThrow(/field "grpc-opts\.ping-interval"/);
    expect(() =>
      validateMihomoProxyList([
        {
          ...trojan,
          network: 'grpc',
          'grpc-opts': { 'max-connections': 1, 'max-streams': 1 },
        },
      ]),
    ).toThrow(/field "grpc-opts\.max-streams" conflicts/);
    expect(() =>
      validateMihomoProxyList([{ ...trojan, network: 'grpc', 'grpc-opts': { 'min-streams': 1 } }]),
    ).toThrow(/field "grpc-opts\.min-streams" requires max-connections/);
  });

  it('validates Trojan Shadowsocks options as a closed nested object', () => {
    const trojan = portableStructuralMinimums[7];
    const valid = {
      ...trojan,
      'ss-opts': { enabled: true, method: 'AES-128-GCM', password: 'FAKE_ONLY' },
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() =>
      validateMihomoProxyList([{ ...trojan, 'ss-opts': { enabled: true, unknown: true } }]),
    ).toThrow(/field "ss-opts" contains an unsupported field/);
    expect(() => validateMihomoProxyList([{ ...trojan, 'ss-opts': [] }])).toThrow(
      /field "ss-opts"/,
    );
  });

  it.each(fixedShadowsocksMethods)('accepts fixed Shadowsocks method %s', (cipher) => {
    const proxy = {
      ...portableStructuralMinimums[0],
      cipher,
      password: passwordForShadowsocksCipher(cipher),
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each([
    ['obfs', { mode: 'tls', host: 'edge.invalid' }],
    [
      'v2ray-plugin',
      {
        mode: 'websocket',
        host: 'edge.invalid',
        path: '/ws',
        tls: true,
        'ech-opts': { enable: false },
        headers: { 'X-Test': 'safe' },
        mux: true,
        'v2ray-http-upgrade': false,
        'v2ray-http-upgrade-fast-open': false,
      },
    ],
    [
      'gost-plugin',
      {
        mode: 'websocket',
        host: 'edge.invalid',
        path: '/ws',
        tls: true,
        'skip-cert-verify': false,
        headers: { 'X-Test': 'safe' },
        mux: false,
      },
    ],
    [
      'shadow-tls',
      {
        password: 'FAKE_ONLY',
        host: 'edge.invalid',
        version: 2,
        alpn: ['h2', 'http/1.1'],
      },
    ],
    [
      'restls',
      {
        password: 'FAKE_ONLY',
        host: 'edge.invalid',
        'version-hint': 'tls13',
        'restls-script': 'FAKE_ONLY',
        'skip-cert-verify': false,
        'force-tls12': false,
      },
    ],
    [
      'kcptun',
      {
        key: 'FAKE_ONLY',
        crypt: 'aes',
        mode: 'fast',
        conn: 1,
        mtu: 1350,
        sndwnd: 128,
        rcvwnd: 512,
        nocomp: false,
        acknodelay: true,
      },
    ],
  ])('accepts strict fixed Shadowsocks plugin options for %s', (plugin, pluginOptions) => {
    const proxy = {
      ...portableStructuralMinimums[0],
      plugin,
      'plugin-opts': pluginOptions,
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each([
    [
      'unknown plugin',
      { ...portableStructuralMinimums[0], plugin: 'unknown', 'plugin-opts': {} },
      'plugin',
    ],
    [
      'orphan options',
      { ...portableStructuralMinimums[0], 'plugin-opts': { mode: 'tls' } },
      'plugin-opts',
    ],
    ['missing options', { ...portableStructuralMinimums[0], plugin: 'obfs' }, 'plugin-opts'],
    [
      'unknown nested field',
      {
        ...portableStructuralMinimums[0],
        plugin: 'obfs',
        'plugin-opts': { mode: 'tls', unknown: true },
      },
      'plugin-opts',
    ],
    [
      'websocket TLS field without TLS',
      {
        ...portableStructuralMinimums[0],
        plugin: 'v2ray-plugin',
        'plugin-opts': { mode: 'websocket', 'skip-cert-verify': false },
      },
      'plugin-opts.tls',
    ],
  ])('rejects ambiguous or poisoned Shadowsocks plugin input: %s', (_label, proxy, field) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(
      new RegExp(`field "${field.replace('.', '\\.')}`),
    );
  });

  it('accepts AES-2022 EIH key chains but forbids multiple ChaCha PSKs', () => {
    const key16 = Buffer.alloc(16, 1).toString('base64');
    const key32 = Buffer.alloc(32, 2).toString('base64');
    const aes = {
      ...portableStructuralMinimums[0],
      cipher: '2022-blake3-aes-128-gcm',
      password: `${key16}:${key16}`,
    };
    expect(validateMihomoProxyList([aes])).toEqual([aes]);
    expect(() =>
      validateMihomoProxyList([
        {
          ...portableStructuralMinimums[0],
          cipher: '2022-blake3-chacha20-poly1305',
          password: `${key32}:${key32}`,
        },
      ]),
    ).toThrow(/field "password" does not allow multiple PSKs/);
  });

  it.each([
    ['non-Base64 key', '2022-blake3-aes-128-gcm', 'p'],
    ['non-canonical Base64 key', '2022-blake3-aes-128-gcm', 'AQ'],
    ['wrong 128-bit key length', '2022-blake3-aes-128-ccm', Buffer.alloc(32).toString('base64')],
    ['wrong 256-bit key length', '2022-blake3-aes-256-gcm', Buffer.alloc(16).toString('base64')],
    ['empty EIH segment', '2022-blake3-aes-128-gcm', `${Buffer.alloc(16).toString('base64')}:`],
  ])('rejects invalid Shadowsocks 2022 password: %s', (_label, cipher, password) => {
    expect(() =>
      validateMihomoProxyList([{ ...portableStructuralMinimums[0], cipher, password }]),
    ).toThrow(/field "password" must contain canonical Base64 keys/);
  });

  it.each(fixedShadowsocksRCiphers)('accepts fixed ShadowsocksR stream cipher %s', (cipher) => {
    const proxy = { ...portableStructuralMinimums[1], cipher };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each(fixedVmessCiphers)('accepts fixed VMess cipher %s', (cipher) => {
    const proxy = { ...portableStructuralMinimums[4], cipher };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each(['vmess', 'vless'])('normalizes canonical and bounded custom %s user IDs', (type) => {
    const base = portableStructuralMinimums.find((candidate) => candidate.type === type)!;
    const upper = { ...base, uuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' };
    expect(validateMihomoProxyList([upper])[0].uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(validateMihomoProxyList([{ ...base, uuid: 'example' }])[0].uuid).toBe(
      'feb54431-301b-52bb-a6dd-e1e93e81bb9e',
    );
    expect(() => validateMihomoProxyList([{ ...base, uuid: 'x'.repeat(31) }])).toThrow(
      /field "uuid" must be a bounded Mihomo user ID/,
    );
    // Dashless "hashlike" spelling: gofrs/uuid FromString (fixed Mihomo's user
    // ID parser) accepts it as the same identity, so it must canonicalise
    // rather than reject on the 30-byte custom bound (uuid-hashlike-accepted).
    expect(
      validateMihomoProxyList([{ ...base, uuid: 'AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE' }])[0].uuid,
    ).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('mirrors weakly-typed Mihomo decoding for ecosystem provider emissions', () => {
    const hy2 = portableStructuralMinimums.find((candidate) => candidate.type === 'hysteria2')!;
    // Inert `udp` on QUIC-native types is dropped, not rejected.
    const withUdp = validateMihomoProxyList([{ ...hy2, udp: true }]);
    expect(withUdp[0]).not.toHaveProperty('udp');
    // Canonical digit-string port coerces to its integer.
    const coerced = validateMihomoProxyList([{ ...hy2, port: '27001' }]);
    expect(coerced[0].port).toBe(27001);
    // Non-canonical string ports still reject.
    expect(() => validateMihomoProxyList([{ ...hy2, port: '27,001' }])).toThrow(
      /field "port" must be a safe integer/,
    );
    // TUIC `version` metadata (v4/v5 is decided by the credential shape) drops.
    const tuic = portableStructuralMinimums.find((candidate) => candidate.type === 'tuic')!;
    const noVersion = validateMihomoProxyList([{ ...tuic, version: 5 }]);
    expect(noVersion[0]).not.toHaveProperty('version');
    expect(() => validateMihomoProxyList([{ ...tuic, version: 'latest' }])).toThrow(
      /unsupported top-level field/,
    );
    // A key with an empty YAML value (`flow:`) parses as null and means "not
    // set"; Mihomo's decoder leaves the field at its zero value.
    const vless = portableStructuralMinimums.find((candidate) => candidate.type === 'vless')!;
    const nullFlow = validateMihomoProxyList([{ ...vless, flow: null }]);
    expect(nullFlow[0]).not.toHaveProperty('flow');
    // Required fields stay required: a null server is still missing.
    expect(() => validateMihomoProxyList([{ ...vless, server: null }])).toThrow(/field "server"/);
    // Hysteria declared-string knobs emitted as integers coerce via the same
    // FormatInt semantics (`up: 300` ≡ `up: "300"`).
    const hy2Int = validateMihomoProxyList([
      { ...hy2, ports: '8443-20000', up: 300, down: 300, 'hop-interval': 20 },
    ]);
    expect(hy2Int[0]).toMatchObject({ up: '300', down: '300', 'hop-interval': '20' });
    const hy1 = portableStructuralMinimums.find((candidate) => candidate.type === 'hysteria')!;
    const hy1Int = validateMihomoProxyList([{ ...hy1, up: 10, down: 20 }]);
    expect(hy1Int[0]).toMatchObject({ up: '10', down: '20' });
    // Floats do not coerce: Mihomo formats them in exponent notation and its
    // own bandwidth parser rejects that.
    expect(() => validateMihomoProxyList([{ ...hy2, up: 3.5 }])).toThrow(/field "up"/);
  });

  it('accepts tab-padded proxy names but keeps other control characters rejected', () => {
    const base = portableStructuralMinimums.find((candidate) => candidate.type === 'vmess')!;
    const tabbed = { ...base, name: 'Netflix AC:user@mail.invalid\t\t\t \t PW:0000' };
    expect(validateMihomoProxyList([tabbed])[0].name).toBe(tabbed.name);
    for (const bad of ['SAFE\nUNSAFE', 'SAFE\rUNSAFE', 'SAFE\x00UNSAFE', 'SAFE\x7fUNSAFE']) {
      expect(() => validateMihomoProxyList([{ ...base, name: bad }])).toThrow(
        /field "name" must not contain control characters/,
      );
    }
  });

  it('budgets hysteria2 port-hopping candidates per node, not across the list', () => {
    const hy2 = portableStructuralMinimums.find((candidate) => candidate.type === 'hysteria2')!;
    // 8 × 10001 candidates exceeds 65536 in aggregate but is an ordinary
    // airport emission; every node must validate independently.
    const fleet = Array.from({ length: 8 }, (_, i) => ({
      ...hy2,
      name: `hop-${i}`,
      ports: '20000-30000',
    }));
    expect(validateMihomoProxyList(fleet)).toHaveLength(8);
  });

  it('accepts canonically typed common TLS fields and rejects weak scalar types', () => {
    const valid = {
      ...portableStructuralMinimums[5],
      tls: true,
      'skip-cert-verify': false,
      servername: 'edge.invalid',
      'client-fingerprint': 'chrome',
      alpn: ['h2', 'http/1.1'],
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);

    for (const [field, value] of [
      ['tls', []],
      ['skip-cert-verify', 'false'],
      ['servername', ''],
      ['client-fingerprint', 42],
      ['fingerprint', ''],
      ['alpn', []],
      ['alpn', ['h2', '']],
      ['alpn', 'h2'],
    ] as const) {
      expect(() => validateMihomoProxyList([{ ...valid, [field]: value }])).toThrow(
        new RegExp(`field "${field}"`),
      );
    }
  });

  it('accepts HTTP SNI with TLS and rejects inert TLS-only fields', () => {
    const http = { ...portableStructuralMinimums[3], tls: true, sni: 'edge.invalid' };
    expect(validateMihomoProxyList([http])).toEqual([http]);
    expect(() =>
      validateMihomoProxyList([{ ...portableStructuralMinimums[3], sni: 'edge.invalid' }]),
    ).toThrow(/field "tls" must be true when TLS-only fields are present/);
  });

  it.each(['vmess', 'vless'])(
    'requires TLS for valid %s Reality and ECH options instead of silently using plaintext',
    (type) => {
      const base = portableStructuralMinimums.find((candidate) => candidate.type === type)!;
      const reality = {
        ...base,
        'reality-opts': { 'public-key': Buffer.alloc(32, 3).toString('base64url') },
      };
      expect(() => validateMihomoProxyList([reality])).toThrow(
        /field "tls" must be true when TLS-only fields are present/,
      );
      expect(() => validateMihomoProxyList([{ ...base, 'ech-opts': { enable: false } }])).toThrow(
        /field "tls" must be true when TLS-only fields are present/,
      );
    },
  );

  it('validates VMess TLSMirror recursively and requires TLS plus a primary key', () => {
    const vmess = portableStructuralMinimums[4];
    const options = {
      'primary-key': 'FAKE_ONLY',
      'explicit-nonce-ciphersuites': [0x1301, 0x1302],
      'defer-instance-derived-write-time': {
        'base-nanoseconds': 1000,
        'uniform-random-multiplier-nanoseconds': 2000,
      },
      'transport-layer-padding': { enabled: true },
      'connection-enrolment': {
        'primary-ingress-outbound': 'SAFE-IN',
        'primary-egress-outbound': 'SAFE-OUT',
      },
      'embedded-traffic-generator': {
        steps: [
          {
            name: 'step-1',
            host: 'edge.invalid',
            path: '/',
            method: 'GET',
            headers: [{ name: 'X-Test', value: 'safe', values: ['safe'] }],
            'next-step': [{ weight: 1, 'goto-location': 0 }],
            'connection-ready': true,
            'connection-recall-exit': false,
            'wait-time': { 'base-nanoseconds': 1 },
            'h2-do-not-wait-for-download-finish': false,
          },
        ],
      },
      'sequence-watermarking-enabled': true,
    };
    const valid = { ...vmess, tls: true, 'tlsmirror-opts': options };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() => validateMihomoProxyList([{ ...vmess, 'tlsmirror-opts': options }])).toThrow(
      /field "tls"/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...vmess, tls: true, 'tlsmirror-opts': { unknown: true } }]),
    ).toThrow(/field "tlsmirror-opts"/);
  });

  it.each([
    ['vmess', 'packetaddr'],
    ['vmess', 'packet'],
    ['vmess', 'xudp'],
    ['vless', 'packetaddr'],
    ['vless', 'packet'],
    ['vless', 'xudp'],
  ])('accepts exact %s packet encoding %s', (type, encoding) => {
    const base = portableStructuralMinimums.find((candidate) => candidate.type === type)!;
    const proxy = { ...base, 'packet-encoding': encoding };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it('rejects silently ignored flow and ambiguous packet encoding aliases', () => {
    const vless = portableStructuralMinimums[5];
    expect(
      validateMihomoProxyList([
        { ...vless, flow: '' },
        { ...vless, name: 'VISION', flow: 'xtls-rprx-vision' },
      ]),
    ).toHaveLength(2);
    expect(() => validateMihomoProxyList([{ ...vless, flow: 'vision-typo' }])).toThrow(
      /field "flow"/,
    );
    expect(() => validateMihomoProxyList([{ ...vless, 'packet-encoding': 'typo' }])).toThrow(
      /field "packet-encoding"/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...vless, 'packet-encoding': 'xudp', xudp: true }]),
    ).toThrow(/field "packet-encoding" conflicts/);
    expect(() => validateMihomoProxyList([{ ...vless, 'packet-addr': true, xudp: true }])).toThrow(
      /field "xudp" conflicts/,
    );
  });

  it.each(['hysteria', 'hysteria2'] as const)(
    'normalizes a valid %s certificate fingerprint and rejects malformed pins',
    (type) => {
      const required = type === 'hysteria' ? { up: '10 Mbps', down: '20 Mbps' } : {};
      const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');
      const proxy = { ...endpoint(type), ...required, fingerprint };
      expect(validateMihomoProxyList([proxy])[0].fingerprint).toBe('aa'.repeat(32));
      expect(() =>
        validateMihomoProxyList([{ ...endpoint(type), ...required, fingerprint: 'x' }]),
      ).toThrow(/field "fingerprint" must be a 32-byte hexadecimal digest/);
    },
  );

  it('requires canonical DER EC key material for MASQUE', () => {
    const valid = portableStructuralMinimums.find((proxy) => proxy.type === 'masque')!;
    expect(validateMihomoProxyList([valid])).toEqual([valid]);

    const trailingPrivateKey = Buffer.concat([
      Buffer.from(masquePrivateKey, 'base64'),
      Buffer.from([0]),
    ]).toString('base64');
    const ed25519 = generateKeyPairSync('ed25519');
    const ed25519PublicKey = ed25519.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    expect(() => validateMihomoProxyList([{ ...valid, 'private-key': 'not-base64!' }])).toThrow(
      /field "private-key" must be canonical Base64 DER SEC1 EC key material/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...valid, 'private-key': trailingPrivateKey }]),
    ).toThrow(/field "private-key" must be canonical Base64 DER SEC1 EC key material/);
    expect(() => validateMihomoProxyList([{ ...valid, 'public-key': ed25519PublicKey }])).toThrow(
      /field "public-key" must be canonical Base64 DER SPKI ECDSA key material/,
    );
  });

  it.each([
    ['ss', 'cipher', 'definitely-not-a-method'],
    ['ss', 'cipher', 'AES-128-GCM'],
    ['ssr', 'cipher', 'aes-128-gcm'],
    ['ssr', 'obfs', 'tls1.3_ticket_auth'],
    ['ssr', 'protocol', 'auth_chain_c'],
    ['vmess', 'cipher', 'chacha20-ietf-poly1305'],
  ])('rejects constructor-invalid %s.%s value', (type, field, value) => {
    const proxy = {
      ...portableStructuralMinimums.find((candidate) => candidate.type === type),
      [field]: value,
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "${field}"`));
  });

  it.each([
    ['plain', 'origin'],
    ['http_simple', 'auth_sha1_v4'],
    ['http_post', 'auth_aes128_md5'],
    ['random_head', 'auth_aes128_sha1'],
    ['tls1.2_ticket_auth', 'auth_chain_a'],
    ['tls1.2_ticket_fastauth', 'auth_chain_b'],
  ])('accepts fixed ShadowsocksR obfs %s and protocol %s', (obfs, protocol) => {
    const proxy = { ...portableStructuralMinimums[1], obfs, protocol };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it('accepts canonically typed common fields and strict smux options', () => {
    const proxy = {
      ...portableStructuralMinimums[0],
      udp: true,
      'interface-name': 'en0',
      'routing-mark': 123,
      tfo: false,
      mptcp: true,
      'ip-version': 'ipv4-prefer',
      smux: {
        enabled: true,
        protocol: 'h2mux',
        'max-connections': 2,
        'min-streams': 4,
        'max-streams': 0,
        padding: true,
        statistic: false,
        'only-tcp': true,
        'brutal-opts': {
          enabled: false,
          up: '10 Mbps',
          down: '20 Mbps',
        },
      },
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each([
    ['udp', 'true'],
    ['interface-name', ''],
    ['routing-mark', '123'],
    ['routing-mark', 1.5],
    ['routing-mark', -1],
    ['tfo', 1],
    ['mptcp', 'false'],
    ['ip-version', 'IPv4'],
    ['ip-version', 'unknown'],
    ['dialer-proxy', 42],
    ['dialer-proxy', ''],
    ['smux', true],
  ])('rejects weakly typed or invalid common field %s', (field, value) => {
    const proxy = { ...portableStructuralMinimums[0], [field]: value };
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "${field}`));
  });

  it.each([
    ['unknown', true],
    ['enabled', 'true'],
    ['protocol', 'quic'],
    ['protocol', ''],
    ['max-connections', '2'],
    ['min-streams', -1],
    ['max-streams', 1.5],
    ['padding', 1],
    ['statistic', 'false'],
    ['only-tcp', null],
    ['brutal-opts', true],
  ])('rejects invalid smux option %s', (field, value) => {
    const proxy = {
      ...portableStructuralMinimums[0],
      smux: { enabled: true, [field]: value },
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "smux`));
  });

  it.each([
    ['unknown', true],
    ['enabled', 'true'],
    ['up', 10],
    ['down', ''],
  ])('rejects invalid smux brutal option %s', (field, value) => {
    const proxy = {
      ...portableStructuralMinimums[0],
      smux: {
        enabled: true,
        'brutal-opts': { enabled: false, [field]: value },
      },
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "smux\\.brutal-opts`));
  });

  it('accepts unauthenticated Hysteria 2 because the pinned target makes password optional', () => {
    const proxy = endpoint('hysteria2');
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each(['hysteria', 'hysteria2'] as const)(
    'accepts a fixed %s ports-only endpoint and a port plus ports endpoint',
    (type) => {
      const required = type === 'hysteria' ? { up: '10 Mbps', down: '20 Mbps' } : {};
      const portsOnly = {
        name: `${type}-ports-only`,
        type,
        server: 'edge.invalid',
        ports: '443,8443-8444',
        ...required,
      };
      const both = { ...portsOnly, name: `${type}-both`, port: 443 };
      expect(validateMihomoProxyList([portsOnly, both])).toEqual([portsOnly, both]);
    },
  );

  it('accepts slash-separated Hysteria 2 ranges and validates its hop range', () => {
    const proxy = {
      name: 'H2-HOP',
      type: 'hysteria2',
      server: 'edge.invalid',
      ports: '443/8443-8444',
      'hop-interval': '5-30',
      up: '10 Mbps',
      down: '20Mbps',
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it('validates Hysteria 2 realm options as a closed nested descriptor', () => {
    const proxy = {
      ...endpoint('hysteria2'),
      'realm-opts': {
        enable: true,
        'server-url': 'https://realm.invalid',
        token: 'FAKE_ONLY',
        'realm-id': 'SAFE-REALM',
        'stun-servers': ['stun:stun.invalid:3478'],
        sni: 'realm.invalid',
        'skip-cert-verify': false,
        fingerprint: 'FAKE_CERT_PIN',
        alpn: ['h2'],
      },
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
    expect(() =>
      validateMihomoProxyList([
        { ...endpoint('hysteria2'), 'realm-opts': { enable: true, unknown: true } },
      ]),
    ).toThrow(/field "realm-opts" contains an unsupported field/);
    expect(() =>
      validateMihomoProxyList([
        { ...endpoint('hysteria2'), 'realm-opts': { enable: true, 'stun-servers': 'bad' } },
      ]),
    ).toThrow(/field "realm-opts\.stun-servers"/);
    expect(() =>
      validateMihomoProxyList([{ ...endpoint('hysteria2'), 'realm-opts': { enable: true } }]),
    ).toThrow(/field "realm-opts\.server-url"/);
    expect(() =>
      validateMihomoProxyList([{ ...endpoint('hysteria2'), 'realm-opts': { token: 'FAKE_ONLY' } }]),
    ).toThrow(/field "realm-opts\.enable"/);
  });

  it.each([
    ['hysteria2 empty', { ...endpoint('hysteria2'), ports: '' }],
    ['hysteria2 zero', { ...endpoint('hysteria2'), ports: '0' }],
    ['hysteria2 overflow', { ...endpoint('hysteria2'), ports: '65536' }],
    ['hysteria2 descending', { ...endpoint('hysteria2'), ports: '8444-8443' }],
    ['hysteria2 empty segment', { ...endpoint('hysteria2'), ports: '443,,8443' }],
    [
      'hysteria2 too many segments',
      { ...endpoint('hysteria2'), ports: Array(29).fill('443').join(',') },
    ],
    [
      'hysteria slash separator',
      { ...endpoint('hysteria'), ports: '443/8443', up: '10 Mbps', down: '20 Mbps' },
    ],
    [
      'hysteria too many segments',
      {
        ...endpoint('hysteria'),
        ports: Array(29).fill('443').join(','),
        up: '10 Mbps',
        down: '20 Mbps',
      },
    ],
  ])('rejects an invalid fixed port-set shape: %s', (_label, proxy) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(/field "ports"/);
  });

  it.each([
    [
      'Hysteria 2 orphan hop interval',
      { ...endpoint('hysteria2'), 'hop-interval': '30' },
      'hop-interval',
    ],
    [
      'Hysteria 2 descending hop interval',
      { ...endpoint('hysteria2'), ports: '443,8443', 'hop-interval': '30-5' },
      'hop-interval',
    ],
    ['Hysteria 2 malformed upload', { ...endpoint('hysteria2'), up: '10mbps' }, 'up'],
    [
      'Hysteria 2 oversized hop integer',
      { ...endpoint('hysteria2'), ports: '443,8443', 'hop-interval': '9'.repeat(1000) },
      'hop-interval',
    ],
    [
      'Hysteria 2 overflowing duration',
      { ...endpoint('hysteria2'), ports: '443,8443', 'hop-interval': '9223372037' },
      'hop-interval',
    ],
    [
      'Hysteria 2 oversized upload integer',
      { ...endpoint('hysteria2'), up: '9'.repeat(1000) },
      'up',
    ],
    [
      'Hysteria malformed download',
      { ...endpoint('hysteria'), up: '10 Mbps', down: 'unlimited' },
      'down',
    ],
    [
      'Hysteria overflowing duration',
      {
        ...endpoint('hysteria'),
        up: '10 Mbps',
        down: '20 Mbps',
        'hop-interval': 9_223_372_037,
      },
      'hop-interval',
    ],
    [
      'Hysteria unknown protocol',
      { ...endpoint('hysteria'), up: '10 Mbps', down: '20 Mbps', protocol: 'quic' },
      'protocol',
    ],
    [
      'Hysteria protocol alias collision',
      {
        ...endpoint('hysteria'),
        up: '10 Mbps',
        down: '20 Mbps',
        protocol: 'udp',
        'obfs-protocol': 'udp',
      },
      'obfs-protocol',
    ],
    [
      'Hysteria auth collision',
      {
        ...endpoint('hysteria'),
        up: '10 Mbps',
        down: '20 Mbps',
        auth: 'RkFLRQ==',
        'auth-str': 'FAKE',
      },
      'auth',
    ],
    [
      'Hysteria malformed base64 auth',
      { ...endpoint('hysteria'), up: '10 Mbps', down: '20 Mbps', auth: 'not-base64!' },
      'auth',
    ],
  ])('rejects a constructor-invalid or ambiguous Hysteria field: %s', (_label, proxy, field) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "${field}"`));
  });

  it('budgets Hysteria port expansion per node — big ranges on several nodes all pass', () => {
    // The candidate budget stopped being shared across the list on 2026-07-18:
    // providers legitimately repeat a large hop range on every node and
    // nothing materialises the expanded list.
    const first = {
      name: 'H2-RANGE-1',
      type: 'hysteria2',
      server: 'one.invalid',
      ports: '1-40000',
    };
    const second = { ...first, name: 'H2-RANGE-2', server: 'two.invalid' };
    expect(validateMihomoProxyList([first, second])).toHaveLength(2);
  });

  it('accepts both TUIC v4 token and v5 UUID/password credential shapes', () => {
    const v4 = { ...endpoint('tuic'), name: 'TUIC-V4', token: 'FAKE_ONLY' };
    const v5 = {
      ...endpoint('tuic'),
      name: 'TUIC-V5',
      uuid: '00000000-0000-4000-8000-000000000001',
      password: 'FAKE_ONLY',
    };
    expect(validateMihomoProxyList([v4, v5])).toEqual([v4, v5]);
  });

  it.each([
    endpoint('tuic'),
    { ...endpoint('tuic'), uuid: '00000000-0000-4000-8000-000000000001' },
    { ...endpoint('tuic'), token: 42 },
    { ...endpoint('tuic'), uuid: 'not-a-uuid', password: 'FAKE_ONLY' },
  ])('rejects incomplete or weakly typed TUIC credentials', (proxy) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(/index 0: field/);
  });

  it.each([
    [
      'mixed credential dialects',
      {
        ...endpoint('tuic'),
        token: 'FAKE_ONLY',
        uuid: '00000000-0000-4000-8000-000000000001',
        password: 'FAKE_ONLY',
      },
      'token',
    ],
    [
      'V4-only request timeout on V5',
      {
        ...endpoint('tuic'),
        uuid: '00000000-0000-4000-8000-000000000001',
        password: 'FAKE_ONLY',
        'request-timeout': 1000,
      },
      'request-timeout',
    ],
    [
      'unknown UDP relay mode',
      { ...endpoint('tuic'), token: 'FAKE_ONLY', 'udp-relay-mode': 'auto' },
      'udp-relay-mode',
    ],
    [
      'unknown congestion controller',
      { ...endpoint('tuic'), token: 'FAKE_ONLY', 'congestion-controller': 'reno' },
      'congestion-controller',
    ],
    [
      'negative receive window',
      { ...endpoint('tuic'), token: 'FAKE_ONLY', 'recv-window': -1 },
      'recv-window',
    ],
    [
      'overflowing millisecond duration',
      { ...endpoint('tuic'), token: 'FAKE_ONLY', 'heartbeat-interval': 9_223_372_036_855 },
      'heartbeat-interval',
    ],
    [
      'clamped datagram size',
      { ...endpoint('tuic'), token: 'FAKE_ONLY', 'max-datagram-frame-size': 1401 },
      'max-datagram-frame-size',
    ],
  ])('rejects ambiguous or unsafe TUIC semantics: %s', (_label, proxy, field) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`field "${field}"`));
  });

  it('bounds AnyTLS timers and idle session allocation', () => {
    const base = portableStructuralMinimums[19];
    const valid = {
      ...base,
      'idle-session-check-interval': 30,
      'idle-session-timeout': 300,
      'min-idle-session': 256,
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() =>
      validateMihomoProxyList([{ ...base, 'idle-session-timeout': 9_223_372_037 }]),
    ).toThrow(/field "idle-session-timeout"/);
    expect(() => validateMihomoProxyList([{ ...base, 'min-idle-session': 257 }])).toThrow(
      /field "min-idle-session"/,
    );
  });

  it('accepts WireGuard peers form and validates nested endpoint fields', () => {
    const proxy = {
      name: 'SAFE-NODE',
      type: 'wireguard',
      ip: '172.16.0.2/32',
      'private-key': wireGuardPrivateKey,
      peers: [
        {
          server: 'edge.invalid',
          port: 51820,
          'public-key': wireGuardPublicKey,
          'allowed-ips': ['0.0.0.0/0'],
        },
      ],
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
    expect(() =>
      validateMihomoProxyList([
        {
          ...proxy,
          peers: [{ ...proxy.peers[0], port: '51820' }],
        },
      ]),
    ).toThrow(/field "peers\[0\]\.port"/);
  });

  it('validates WireGuard peer and Amnezia nested descriptors plus resource caps', () => {
    const base = portableStructuralMinimums[10];
    const amnezia = {
      jc: 4,
      jmin: 40,
      jmax: 70,
      s1: 0,
      s2: 0,
      s3: 0,
      s4: 0,
      h1: '1',
      h2: '2',
      h3: '3',
      h4: '4',
      i1: '<r 10>',
      i2: '<r 20>',
      i3: '<r 30>',
      i4: '<r 40>',
      i5: '<r 50>',
      j1: '<c>',
      j2: '<t>',
      j3: '<d>',
      itime: 10,
    };
    const valid = {
      ...base,
      workers: 256,
      mtu: 1280,
      'persistent-keepalive': 65_535,
      'refresh-server-ip-interval': 60,
      'amnezia-wg-option': amnezia,
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() => validateMihomoProxyList([{ ...base, workers: 257 }])).toThrow(/field "workers"/);
    expect(() =>
      validateMihomoProxyList([{ ...base, 'refresh-server-ip-interval': 9_223_372_037 }]),
    ).toThrow(/field "refresh-server-ip-interval"/);
    expect(() => validateMihomoProxyList([{ ...base, 'persistent-keepalive': 65_536 }])).toThrow(
      /field "persistent-keepalive"/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...base, 'amnezia-wg-option': { unknown: true } }]),
    ).toThrow(/field "amnezia-wg-option" contains an unsupported field/);
  });

  it('rejects unknown WireGuard peer fields instead of weakly decoding them', () => {
    const proxy = {
      name: 'SAFE-NODE',
      type: 'wireguard',
      ip: '172.16.0.2/32',
      'private-key': wireGuardPrivateKey,
      peers: [
        {
          server: 'edge.invalid',
          port: 51820,
          'public-key': wireGuardPublicKey,
          'allowed-ips': ['0.0.0.0/0'],
          unknown: true,
        },
      ],
    };
    expect(() => validateMihomoProxyList([proxy])).toThrow(
      /field "peers\[0\]" contains an unsupported field/,
    );
  });

  it.each([
    ['missing private key', { ...portableStructuralMinimums[10], 'private-key': undefined }],
    ['missing local address', { ...portableStructuralMinimums[10], ip: undefined }],
    ['empty peers', { ...portableStructuralMinimums[10], peers: [] }],
    [
      'missing peer routes',
      {
        ...portableStructuralMinimums[10],
        peers: [{ server: 'edge.invalid', port: 51820, 'public-key': wireGuardPublicKey }],
      },
    ],
    ['invalid private key', { ...portableStructuralMinimums[10], 'private-key': 'FAKE_ONLY' }],
    ['invalid local IPv4 prefix', { ...portableStructuralMinimums[10], ip: 'not-an-ip' }],
    ['wrong-family local IPv6 prefix', { ...portableStructuralMinimums[10], ipv6: '10.0.0.2/32' }],
    ['invalid reserved bytes', { ...portableStructuralMinimums[10], reserved: [0, 1, 256] }],
  ])('rejects WireGuard structural violation: %s', (_label, proxy) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(/index 0: field/);
  });

  it('supports Mieru port-range without accepting conflicting endpoint forms', () => {
    const ranged = {
      name: 'SAFE-NODE',
      type: 'mieru',
      server: 'edge.invalid',
      'port-range': '20000-30000',
      transport: 'TCP',
      username: 'FAKE_USER',
      password: 'FAKE_PASSWORD',
    };
    expect(validateMihomoProxyList([ranged])).toEqual([ranged]);
    expect(() => validateMihomoProxyList([{ ...ranged, port: 443 }])).toThrow(
      /must provide exactly one of port or port-range/,
    );
    expect(() => validateMihomoProxyList([{ ...ranged, 'port-range': '30000-20000' }])).toThrow(
      /field "port-range"/,
    );
  });

  it('closes fixed Mieru enum and traffic-pattern protobuf inputs', () => {
    const base = portableStructuralMinimums[18];
    const valid = {
      ...base,
      multiplexing: 'MULTIPLEXING_HIGH',
      'handshake-mode': 'HANDSHAKE_NO_WAIT',
      // TrafficPattern{seed: 1}.
      'traffic-pattern': Buffer.from([0x08, 0x01]).toString('base64'),
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() =>
      validateMihomoProxyList([{ ...base, multiplexing: 'MULTIPLEXING_UNKNOWN' }]),
    ).toThrow(/field "multiplexing"/);
    expect(() => validateMihomoProxyList([{ ...base, 'handshake-mode': '0RTT' }])).toThrow(
      /field "handshake-mode"/,
    );
    expect(() => validateMihomoProxyList([{ ...base, 'traffic-pattern': 'not-base64!' }])).toThrow(
      /field "traffic-pattern"/,
    );
    expect(() =>
      validateMihomoProxyList([
        {
          ...base,
          // TrafficPattern{tcp_fragment: {max_sleep_ms: 101}}.
          'traffic-pattern': Buffer.from([0x1a, 0x02, 0x10, 0x65]).toString('base64'),
        },
      ]),
    ).toThrow(/field "traffic-pattern"/);
  });

  it.each([
    ['Mieru credentials', { ...endpoint('mieru'), transport: 'TCP' }],
    [
      'Mieru transport',
      {
        ...endpoint('mieru'),
        transport: 'tcp',
        username: 'FAKE_USER',
        password: 'FAKE_PASSWORD',
      },
    ],
    ['Sudoku key', endpoint('sudoku')],
    [
      'MASQUE local address',
      {
        ...endpoint('masque'),
        'private-key': masquePrivateKey,
        'public-key': masquePublicKey,
      },
    ],
    [
      'MASQUE invalid local address',
      {
        ...endpoint('masque'),
        'private-key': masquePrivateKey,
        'public-key': masquePublicKey,
        ip: 'not-an-ip',
      },
    ],
    ['OpenVPN CA', endpoint('openvpn')],
    ['SSH username/authentication', endpoint('ssh')],
    [
      'SSH filesystem key reference',
      { ...endpoint('ssh'), username: 'FAKE_USER', 'private-key': './secret-key.pem' },
    ],
  ])('rejects fixed-constructor or local-material violation: %s', (_label, proxy) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(/index 0: field/);
  });

  it('validates Sudoku HTTP mask options as a closed nested descriptor', () => {
    const base = portableStructuralMinimums[20];
    const valid = {
      ...base,
      httpmask: {
        disable: false,
        mode: 'stream',
        tls: true,
        host: 'edge.invalid',
        'path-root': '/safe',
        multiplex: 'auto',
      },
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() =>
      validateMihomoProxyList([{ ...base, httpmask: { disable: false, unknown: true } }]),
    ).toThrow(/field "httpmask" contains an unsupported field/);
    for (const [field, value] of [
      ['aead-method', 'aes-256-gcm'],
      ['table-type', 'random'],
      ['http-mask-mode', 'h3'],
      ['http-mask-multiplex', 'always'],
      ['path-root', 'two/segments'],
      ['padding-max', 101],
      ['custom-table', 'xxxxxxxx'],
    ] as const) {
      expect(() => validateMihomoProxyList([{ ...base, [field]: value }])).toThrow(
        new RegExp(`field "${field}"`),
      );
    }
    expect(() =>
      validateMihomoProxyList([
        { ...base, 'custom-table': 'xxppvvvv', 'custom-tables': ['xxppvvvv'] },
      ]),
    ).toThrow(/field "custom-table" conflicts/);
  });

  it('validates the fixed OpenVPN install-script subset without silent fallbacks', () => {
    const base = portableStructuralMinimums[23];
    const valid = {
      ...base,
      proto: 'tcp4-client',
      dev: 'tun',
      cipher: 'AES-256-GCM',
      auth: 'SHA-1',
      'comp-lzo': 'adaptive',
      'tls-crypt': openVpnStaticKey,
      ping: 10,
      'ping-restart': 60,
      'handshake-timeout': 30,
      mtu: 1500,
      'remote-dns-resolve': true,
      dns: ['1.1.1.1'],
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);

    const certificateAuth = {
      ...endpoint('openvpn'),
      ca: openVpnCertificatePem,
      cert: openVpnCertificatePem,
      key: openVpnPrivateKeyPem,
    };
    expect(validateMihomoProxyList([certificateAuth])).toEqual([certificateAuth]);

    for (const [field, value] of [
      ['proto', 'quic'],
      ['dev', 'tap'],
      ['cipher', 'BF-CBC'],
      ['auth', 'SHA3'],
      ['comp-lzo', 'maybe'],
      ['ca', 'FAKE_CA_MATERIAL'],
      ['tls-crypt', '00'],
      ['mtu', -1],
    ] as const) {
      expect(() => validateMihomoProxyList([{ ...base, [field]: value }])).toThrow(
        new RegExp(`field "${field}"`),
      );
    }
    expect(() => validateMihomoProxyList([{ ...base, cert: openVpnCertificatePem }])).toThrow(
      /field "key"/,
    );
    expect(() => validateMihomoProxyList([{ ...base, dns: ['1.1.1.1'] }])).toThrow(
      /field "remote-dns-resolve"/,
    );
    expect(() => validateMihomoProxyList([{ ...base, 'remote-dns-resolve': true }])).toThrow(
      /field "dns"/,
    );
    expect(() => validateMihomoProxyList([{ ...base, udp: false }])).toThrow(
      /field "proxy" contains an unsupported top-level field/,
    );
  });

  it.each([
    ['OpenVPN', portableStructuralMinimums[23]],
    ['WireGuard', portableStructuralMinimums[10]],
    ['MASQUE', portableStructuralMinimums[21]],
  ])('accepts the conservative fixed parseNameServer subset for %s', (_type, base) => {
    const proxy = {
      ...base,
      'remote-dns-resolve': true,
      dns: [
        '1.1.1.1',
        '2001:4860:4860::8888',
        'dns.example',
        'dns.example.',
        'localhost',
        'dns.example:5353',
        '[2001:4860:4860::8844]:5353',
        'udp://1.0.0.1:53',
        'udp://[2001:4860:4860::8888]:53',
        'tcp://dns.example:53',
        'tls://dns.example:853',
        'http://dns.example/dns-query',
        'https://dns.example/dns-query',
        'quic://dns.example:853',
        'system',
        'system://',
        'ts://TAILSCALE',
        'tailscale://TAILSCALE',
        'dhcp://en0',
        'dhcp://system',
        'rcode://success',
        'rcode://format_error',
        'rcode://server_failure',
        'rcode://name_error',
        'rcode://not_implemented',
        'rcode://refused',
      ],
    };
    expect(validateMihomoProxyList([proxy])).toEqual([proxy]);
  });

  it.each([
    ['OpenVPN', portableStructuralMinimums[23]],
    ['WireGuard', portableStructuralMinimums[10]],
    ['MASQUE', portableStructuralMinimums[21]],
  ])('requires remote-dns-resolve and a non-empty dns list together for %s', (_type, base) => {
    expect(() => validateMihomoProxyList([{ ...base, dns: ['1.1.1.1'] }])).toThrow(
      /field "remote-dns-resolve"/,
    );
    expect(() => validateMihomoProxyList([{ ...base, 'remote-dns-resolve': true }])).toThrow(
      /field "dns"/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...base, 'remote-dns-resolve': true, dns: [] }]),
    ).toThrow(/field "dns"/);
    expect(() =>
      validateMihomoProxyList([{ ...base, 'remote-dns-resolve': false, dns: ['1.1.1.1'] }]),
    ).toThrow(/field "remote-dns-resolve"/);
  });

  it.each([
    ['OpenVPN', portableStructuralMinimums[23]],
    ['WireGuard', portableStructuralMinimums[10]],
    ['MASQUE', portableStructuralMinimums[21]],
  ])('rejects unsafe or fixed-parser-ignored dns server syntax for %s', (_type, base) => {
    const invalidServers = [
      '',
      ' dns.example',
      'dns example',
      'bad_host.example',
      '-bad.example',
      'bad-.example',
      '999.999.999.999',
      'fe80::1%en0',
      'udp://',
      'udp://dns.example:0',
      'udp://dns.example:65536',
      'udp://dns.example:not-a-port',
      'udp://user@dns.example',
      'udp://dns.example/ignored',
      'udp://dns.example?ignored=true',
      'udp://dns.example#PROXY',
      'https://user:password@dns.example/dns-query',
      'https://dns.example/dns-query?ignored=true',
      'system://ignored.example',
      'ts://TAILSCALE/ignored',
      'tailscale://',
      'dhcp://',
      'dhcp://en0/ignored',
      'rcode://success/ignored',
      'rcode://unknown',
      'ftp://dns.example',
    ];

    for (const server of invalidServers) {
      expect(() =>
        validateMihomoProxyList([{ ...base, 'remote-dns-resolve': true, dns: [server] }]),
      ).toThrow(/field "dns\[0\]"/);
    }
  });

  it('closes MASQUE network and congestion semantics', () => {
    const base = portableStructuralMinimums[21];
    for (const network of ['', 'h3', 'h2', 'h3-l4proxy']) {
      expect(validateMihomoProxyList([{ ...base, network }])).toHaveLength(1);
    }
    expect(() => validateMihomoProxyList([{ ...base, network: 'quic' }])).toThrow(
      /field "network"/,
    );
    expect(() => validateMihomoProxyList([{ ...base, 'congestion-controller': 'reno' }])).toThrow(
      /field "congestion-controller"/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...base, network: 'h2', 'congestion-controller': 'cubic' }]),
    ).toThrow(/field "network" must use a QUIC mode/);
  });

  it('requires TrustTunnel QUIC mode for QUIC-only controls and closes mux settings', () => {
    const base = portableStructuralMinimums[22];
    const valid = {
      ...base,
      quic: true,
      'congestion-controller': 'bbr',
      cwnd: 32,
      'bbr-profile': 'default',
      'max-connections': 2,
      'min-streams': 1,
      'max-streams': 0,
    };
    expect(validateMihomoProxyList([valid])).toEqual([valid]);
    expect(() => validateMihomoProxyList([{ ...base, 'congestion-controller': 'cubic' }])).toThrow(
      /field "quic" must be true/,
    );
    expect(() =>
      validateMihomoProxyList([{ ...base, quic: true, 'congestion-controller': 'reno' }]),
    ).toThrow(/field "congestion-controller"/);
    expect(() =>
      validateMihomoProxyList([{ ...base, 'max-connections': 1, 'max-streams': 1 }]),
    ).toThrow(/field "max-streams" conflicts/);
  });

  it.each([
    [{ ...endpoint('hysteria2'), obfs: 'unknown', 'obfs-password': 'FAKE_ONLY' }, 'obfs'],
    [{ ...endpoint('hysteria2'), obfs: 'salamander' }, 'obfs-password'],
    [{ ...endpoint('hysteria2'), 'obfs-password': 'FAKE_ONLY' }, 'obfs-password'],
    [{ ...endpoint('snell'), psk: 'FAKE_ONLY', version: 6 }, 'version'],
    [{ ...endpoint('snell'), psk: 'FAKE_ONLY', 'obfs-opts': 'http' }, 'obfs-opts'],
  ])('rejects constructor-invalid optional field at %s', (proxy, field) => {
    expect(() => validateMihomoProxyList([proxy])).toThrow(new RegExp(`index 0: field "${field}"`));
  });

  it('validates Snell obfs options and version-specific UDP support', () => {
    const base = portableStructuralMinimums[6];
    const simple = { ...base, 'obfs-opts': { mode: 'tls', host: 'edge.invalid' } };
    const shadow = {
      ...base,
      'obfs-opts': {
        mode: 'shadow-tls',
        password: 'FAKE_ONLY',
        host: 'edge.invalid',
        version: 2,
        alpn: ['h2'],
      },
    };
    expect(validateMihomoProxyList([simple, { ...shadow, name: 'SHADOW' }])).toHaveLength(2);
    expect(() =>
      validateMihomoProxyList([{ ...base, 'obfs-opts': { mode: 'tls', unknown: true } }]),
    ).toThrow(/field "obfs-opts" contains an unsupported field/);
    expect(() => validateMihomoProxyList([{ ...base, version: 1, udp: true }])).toThrow(
      /field "udp" is not supported by Snell version 1/,
    );
    expect(() => validateMihomoProxyList([{ ...base, version: 2, udp: true }])).toThrow(
      /field "udp" is not supported by Snell version 2/,
    );
  });

  it('requires a real Rematch target but no network endpoint', () => {
    expect(() => validateMihomoProxyList([{ name: 'SAFE-NODE', type: 'rematch' }])).toThrow(
      /requires target-rematch-name or target-sub-rule/,
    );
    expect(
      validateMihomoProxyList([
        { name: 'SAFE-NODE', type: 'rematch', 'target-rematch-name': 'SAFE-TARGET' },
      ]),
    ).toHaveLength(1);
  });

  it('uses a 400 ProblemDetails error without reflecting node data', () => {
    let thrown: unknown;
    try {
      validateMihomoProxyList([
        { name: 'SAFE-FIRST', type: 'direct' },
        {
          name: 'FAKE_NODE_NAME_DO_NOT_LOG',
          type: 'unknown-secret-type',
          server: 'FAKE_SERVER_DO_NOT_LOG',
          port: 'FAKE_SECRET_DO_NOT_LOG',
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProblemDetailsError);
    expect((thrown as ProblemDetailsError).problem.status).toBe(400);
    expect((thrown as Error).message).toContain('index 1: field "type"');
    expect((thrown as Error).message).not.toMatch(/FAKE_|unknown-secret-type/);
  });
});
