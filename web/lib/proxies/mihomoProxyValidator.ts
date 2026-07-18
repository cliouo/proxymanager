import { createPrivateKey, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { PROBLEM_BASE_URL, ProblemDetailsError } from '@/lib/http/problem';
import { isCanonicalUuid, normalizeMihomoUserId } from '@/lib/proxies/mihomoUserId';

// MetaCubeX/mihomo v1.19.28, adapter/parser.go at
// cbd11db1e13a75d8e680e0fe7742c95be4cba2be.
const FIXED_MIHOMO_PROXY_TYPES = new Set([
  'ss',
  'ssr',
  'socks5',
  'http',
  'vmess',
  'vless',
  'snell',
  'trojan',
  'hysteria',
  'hysteria2',
  'wireguard',
  'tuic',
  'gost-relay',
  'direct',
  'dns',
  'reject',
  'rematch',
  'ssh',
  'mieru',
  'anytls',
  'sudoku',
  'masque',
  'trusttunnel',
  'openvpn',
  'tailscale',
]);

const ENDPOINT_FREE_PROXY_TYPES = new Set(['direct', 'dns', 'reject', 'rematch']);

const MIHOMO_DNS_NETWORK_SCHEMES = new Set(['udp', 'tcp', 'tls', 'http', 'https', 'quic']);
const MIHOMO_DNS_RCODE_TYPES = new Set([
  'success',
  'format_error',
  'server_failure',
  'name_error',
  'not_implemented',
  'refused',
]);
const DNS_SERVER_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/u;
const DNS_HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const DNS_HTTP_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]*$/u;
const DNS_SAFE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

// Transport names with explicit constructor/runtime handling in fixed Mihomo.
// It falls back to raw TCP for unknown names, so this must be a closed set
// instead of mirroring that fail-open switch default.
const VMESS_NETWORKS = new Set(['tcp', 'ws', 'http', 'h2', 'grpc', 'mekya', 'mkcp', 'kcp']);
const VLESS_NETWORKS = new Set(['tcp', 'ws', 'http', 'h2', 'grpc', 'xhttp']);
const TROJAN_NETWORKS = new Set(['tcp', 'ws', 'grpc']);
const HYSTERIA_PROTOCOLS = new Set(['udp', 'wechat-video', 'faketcp']);
const TRANSPORT_OPTIONS_BY_NETWORK: Readonly<Record<string, string>> = {
  ws: 'ws-opts',
  http: 'http-opts',
  h2: 'h2-opts',
  grpc: 'grpc-opts',
  xhttp: 'xhttp-opts',
  mekya: 'mekya-opts',
  mkcp: 'mkcp-opts',
  kcp: 'mkcp-opts',
};
const KNOWN_TRANSPORT_OPTION_FIELDS = new Set([
  ...Object.values(TRANSPORT_OPTIONS_BY_NETWORK),
  // A tempting but invalid alias: fixed Mihomo only tags `mkcp-opts`.
  'kcp-opts',
]);

const WS_OPTION_FIELDS = new Set([
  'path',
  'headers',
  'max-early-data',
  'early-data-header-name',
  'v2ray-http-upgrade',
  'v2ray-http-upgrade-fast-open',
]);
const HTTP_OPTION_FIELDS = new Set(['method', 'path', 'headers']);
const H2_OPTION_FIELDS = new Set(['host', 'path']);
const GRPC_OPTION_FIELDS = new Set([
  'grpc-service-name',
  'grpc-user-agent',
  'ping-interval',
  'max-connections',
  'min-streams',
  'max-streams',
]);
const MKCP_OPTION_FIELDS = new Set([
  'mtu',
  'tti',
  'uplink-capacity',
  'downlink-capacity',
  'congestion',
  'write-buffer',
  'read-buffer',
  'seed',
  'header',
]);
const MEKYA_OPTION_FIELDS = new Set([
  'url',
  'h2-pool-size',
  'max-write-delay',
  'max-request-size',
  'polling-interval-initial',
  'max-write-size',
  'max-write-duration-ms',
  'max-simultaneous-write-connection',
  'packet-writing-buffer',
  'kcp',
]);
const XHTTP_OPTION_FIELDS = new Set([
  'path',
  'host',
  'mode',
  'headers',
  'no-grpc-header',
  'x-padding-bytes',
  'x-padding-obfs-mode',
  'x-padding-key',
  'x-padding-header',
  'x-padding-placement',
  'x-padding-method',
  'uplink-http-method',
  'session-placement',
  'session-key',
  'session-table',
  'session-length',
  'seq-placement',
  'seq-key',
  'uplink-data-placement',
  'uplink-data-key',
  'uplink-chunk-size',
  'sc-max-each-post-bytes',
  'sc-min-posts-interval-ms',
  'reuse-settings',
  'download-settings',
]);
const XHTTP_REUSE_FIELDS = new Set([
  'max-concurrency',
  'max-connections',
  'c-max-reuse-times',
  'h-max-request-times',
  'h-max-reusable-secs',
  'h-keep-alive-period',
]);
const XHTTP_DOWNLOAD_FIELDS = new Set([
  'path',
  'host',
  'headers',
  'reuse-settings',
  'server',
  'port',
  'tls',
  'alpn',
  'ech-opts',
  'reality-opts',
  'skip-cert-verify',
  'fingerprint',
  'certificate',
  'private-key',
  'servername',
  'client-fingerprint',
]);
const XHTTP_PREDEFINED_SESSION_TABLES: Readonly<Record<string, string>> = {
  ALPHABET: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  Alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  BASE36: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  Base62: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  HEX: '0123456789ABCDEF',
  alphabet: 'abcdefghijklmnopqrstuvwxyz',
  base36: '0123456789abcdefghijklmnopqrstuvwxyz',
  hex: '0123456789abcdef',
  number: '0123456789',
};
const XHTTP_MODES = new Set(['', 'auto', 'stream-one', 'stream-up', 'packet-up']);
const XHTTP_META_PLACEMENTS = new Set(['', 'path', 'query', 'header', 'cookie']);
const XHTTP_DATA_PLACEMENTS = new Set(['', 'body', 'auto', 'header', 'cookie']);
const XHTTP_PADDING_PLACEMENTS = new Set(['', 'header', 'queryInHeader', 'cookie', 'query']);
const XHTTP_PADDING_METHODS = new Set(['', 'repeat-x', 'tokenish']);
const MKCP_HEADERS = new Set([
  '',
  'none',
  'noop',
  'srtp',
  'utp',
  'wechat-video',
  'wechat',
  'dtls',
  'wireguard',
]);
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAX_UINT32 = 0xffff_ffff;
const MAX_GO_DURATION_SECONDS = 9_223_372_036;
const MAX_GO_DURATION_MILLISECONDS = 9_223_372_036_854;
const MAX_XHTTP_SESSION_ID_LENGTH = 256;
const MAX_XHTTP_SESSION_ID_RANGE_CARDINALITY = 256;
const MIN_XHTTP_SESSION_ID_SPACE = BigInt(2) ** BigInt(31);

type ProxyFieldKind =
  | 'string'
  | 'integer'
  | 'uint64'
  | 'boolean'
  | 'string-array'
  | 'string-map'
  | 'record'
  | 'record-array'
  | 'uint8-array';

interface ProxyFieldGroups {
  strings?: readonly string[];
  integers?: readonly string[];
  uint64s?: readonly string[];
  booleans?: readonly string[];
  stringArrays?: readonly string[];
  stringMaps?: readonly string[];
  records?: readonly string[];
  recordArrays?: readonly string[];
  uint8Arrays?: readonly string[];
}

function defineProxyFields(groups: ProxyFieldGroups): Readonly<Record<string, ProxyFieldKind>> {
  const schema: Record<string, ProxyFieldKind> = {};
  const assign = (fields: readonly string[] | undefined, kind: ProxyFieldKind): void => {
    for (const field of fields ?? []) schema[field] = kind;
  };
  assign(groups.strings, 'string');
  assign(groups.integers, 'integer');
  assign(groups.uint64s, 'uint64');
  assign(groups.booleans, 'boolean');
  assign(groups.stringArrays, 'string-array');
  assign(groups.stringMaps, 'string-map');
  assign(groups.records, 'record');
  assign(groups.recordArrays, 'record-array');
  assign(groups.uint8Arrays, 'uint8-array');
  return schema;
}

const COMMON_PROXY_FIELDS = defineProxyFields({
  strings: ['name', 'type', 'interface-name', 'ip-version', 'dialer-proxy'],
  integers: ['routing-mark'],
  booleans: ['tfo', 'mptcp'],
  records: ['smux'],
});

// Direct and DNS copy only these BasicOption fields into BaseOption. Reject
// and Rematch decode BasicOption but their constructors intentionally ignore
// every externally configurable member.
const COMMON_PROXY_FIELDS_BY_TYPE: Readonly<
  Record<string, Readonly<Record<string, ProxyFieldKind>>>
> = {
  direct: defineProxyFields({
    strings: ['type', 'interface-name', 'ip-version'],
    integers: ['routing-mark'],
    booleans: ['tfo', 'mptcp'],
  }),
  dns: defineProxyFields({
    strings: ['type', 'interface-name', 'ip-version'],
    integers: ['routing-mark'],
    booleans: ['tfo', 'mptcp'],
  }),
  reject: defineProxyFields({ strings: ['type'] }),
  rematch: defineProxyFields({ strings: ['type'] }),
};

const PROXY_FIELDS_BY_TYPE: Readonly<Record<string, Readonly<Record<string, ProxyFieldKind>>>> = {
  ss: defineProxyFields({
    strings: ['name', 'server', 'password', 'cipher', 'plugin', 'client-fingerprint'],
    integers: ['port', 'udp-over-tcp-version'],
    booleans: ['udp', 'udp-over-tcp'],
    records: ['plugin-opts'],
  }),
  ssr: defineProxyFields({
    strings: [
      'name',
      'server',
      'password',
      'cipher',
      'obfs',
      'obfs-param',
      'protocol',
      'protocol-param',
    ],
    integers: ['port'],
    booleans: ['udp'],
  }),
  socks5: defineProxyFields({
    strings: [
      'name',
      'server',
      'username',
      'password',
      'fingerprint',
      'certificate',
      'private-key',
    ],
    integers: ['port'],
    booleans: ['tls', 'udp', 'skip-cert-verify'],
  }),
  http: defineProxyFields({
    strings: [
      'name',
      'server',
      'username',
      'password',
      'sni',
      'fingerprint',
      'certificate',
      'private-key',
    ],
    integers: ['port'],
    booleans: ['tls', 'skip-cert-verify'],
    stringMaps: ['headers'],
  }),
  vmess: defineProxyFields({
    strings: [
      'name',
      'server',
      'uuid',
      'cipher',
      'network',
      'fingerprint',
      'certificate',
      'private-key',
      'servername',
      'client-fingerprint',
      'packet-encoding',
    ],
    integers: ['port', 'alterId'],
    booleans: [
      'udp',
      'tls',
      'skip-cert-verify',
      'packet-addr',
      'xudp',
      'global-padding',
      'authenticated-length',
    ],
    stringArrays: ['alpn'],
    records: [
      'ech-opts',
      'reality-opts',
      'tlsmirror-opts',
      'mekya-opts',
      'mkcp-opts',
      'http-opts',
      'h2-opts',
      'grpc-opts',
      'ws-opts',
    ],
  }),
  vless: defineProxyFields({
    strings: [
      'name',
      'server',
      'uuid',
      'flow',
      'packet-encoding',
      'encryption',
      'network',
      'fingerprint',
      'certificate',
      'private-key',
      'servername',
      'client-fingerprint',
    ],
    integers: ['port'],
    booleans: ['tls', 'udp', 'packet-addr', 'xudp', 'skip-cert-verify'],
    stringArrays: ['alpn'],
    stringMaps: ['ws-headers'],
    records: [
      'ech-opts',
      'reality-opts',
      'http-opts',
      'h2-opts',
      'grpc-opts',
      'ws-opts',
      'xhttp-opts',
    ],
  }),
  snell: defineProxyFields({
    strings: ['name', 'server', 'psk', 'client-fingerprint'],
    integers: ['port', 'version'],
    booleans: ['udp', 'reuse'],
    records: ['obfs-opts'],
  }),
  trojan: defineProxyFields({
    strings: [
      'name',
      'server',
      'password',
      'sni',
      'fingerprint',
      'certificate',
      'private-key',
      'network',
      'client-fingerprint',
    ],
    integers: ['port'],
    booleans: ['skip-cert-verify', 'udp'],
    stringArrays: ['alpn'],
    records: ['ech-opts', 'reality-opts', 'grpc-opts', 'ws-opts', 'ss-opts'],
  }),
  hysteria: defineProxyFields({
    strings: [
      'name',
      'server',
      'ports',
      'protocol',
      'obfs-protocol',
      'up',
      'down',
      'auth',
      'auth-str',
      'obfs',
      'sni',
      'fingerprint',
      'certificate',
      'private-key',
    ],
    integers: ['port', 'up-speed', 'down-speed', 'recv-window-conn', 'recv-window', 'hop-interval'],
    booleans: ['skip-cert-verify', 'disable-mtu-discovery', 'fast-open'],
    stringArrays: ['alpn'],
    records: ['ech-opts'],
  }),
  hysteria2: defineProxyFields({
    strings: [
      'name',
      'server',
      'ports',
      'hop-interval',
      'up',
      'down',
      'password',
      'obfs',
      'obfs-password',
      'sni',
      'fingerprint',
      'certificate',
      'private-key',
      'bbr-profile',
    ],
    integers: ['port', 'obfs-min-packet-size', 'obfs-max-packet-size', 'cwnd', 'udp-mtu'],
    uint64s: [
      'initial-stream-receive-window',
      'max-stream-receive-window',
      'initial-connection-receive-window',
      'max-connection-receive-window',
    ],
    booleans: ['skip-cert-verify'],
    stringArrays: ['alpn'],
    records: ['ech-opts', 'realm-opts'],
  }),
  wireguard: defineProxyFields({
    strings: ['name', 'server', 'ip', 'ipv6', 'private-key', 'public-key', 'pre-shared-key'],
    integers: ['port', 'workers', 'mtu', 'persistent-keepalive', 'refresh-server-ip-interval'],
    booleans: ['udp', 'remote-dns-resolve'],
    stringArrays: ['allowed-ips', 'dns'],
    records: ['amnezia-wg-option'],
    recordArrays: ['peers'],
    uint8Arrays: ['reserved'],
  }),
  tuic: defineProxyFields({
    strings: [
      'name',
      'server',
      'token',
      'uuid',
      'password',
      'ip',
      'udp-relay-mode',
      'congestion-controller',
      'bbr-profile',
      'fingerprint',
      'certificate',
      'private-key',
      'sni',
    ],
    integers: [
      'port',
      'heartbeat-interval',
      'request-timeout',
      'max-udp-relay-packet-size',
      'max-open-streams',
      'cwnd',
      'recv-window-conn',
      'recv-window',
      'max-datagram-frame-size',
      'udp-over-stream-version',
    ],
    booleans: [
      'reduce-rtt',
      'disable-sni',
      'fast-open',
      'skip-cert-verify',
      'disable-mtu-discovery',
      'udp-over-stream',
    ],
    stringArrays: ['alpn'],
    records: ['ech-opts'],
  }),
  'gost-relay': defineProxyFields({
    strings: [
      'name',
      'server',
      'sni',
      'username',
      'password',
      'fingerprint',
      'certificate',
      'private-key',
      'client-fingerprint',
    ],
    integers: ['port'],
    booleans: ['forward', 'udp', 'tls', 'mux', 'skip-cert-verify'],
  }),
  direct: defineProxyFields({ strings: ['name'] }),
  dns: defineProxyFields({ strings: ['name'] }),
  reject: defineProxyFields({ strings: ['name'] }),
  rematch: defineProxyFields({ strings: ['name', 'target-rematch-name', 'target-sub-rule'] }),
  ssh: defineProxyFields({
    strings: ['name', 'server', 'username', 'password', 'private-key', 'private-key-passphrase'],
    integers: ['port'],
    stringArrays: ['host-key', 'host-key-algorithms'],
  }),
  mieru: defineProxyFields({
    strings: [
      'name',
      'server',
      'port-range',
      'transport',
      'username',
      'password',
      'multiplexing',
      'handshake-mode',
      'traffic-pattern',
    ],
    integers: ['port'],
    booleans: ['udp'],
  }),
  anytls: defineProxyFields({
    strings: [
      'name',
      'server',
      'password',
      'sni',
      'client-fingerprint',
      'fingerprint',
      'certificate',
      'private-key',
    ],
    integers: ['port', 'idle-session-check-interval', 'idle-session-timeout', 'min-idle-session'],
    booleans: ['skip-cert-verify', 'udp'],
    stringArrays: ['alpn'],
    records: ['ech-opts'],
  }),
  sudoku: defineProxyFields({
    strings: [
      'name',
      'server',
      'key',
      'aead-method',
      'table-type',
      'http-mask-mode',
      'http-mask-host',
      'path-root',
      'http-mask-multiplex',
      'custom-table',
    ],
    integers: ['port', 'padding-min', 'padding-max'],
    booleans: ['enable-pure-downlink', 'http-mask', 'http-mask-tls'],
    stringArrays: ['custom-tables'],
    records: ['httpmask'],
  }),
  masque: defineProxyFields({
    strings: [
      'name',
      'server',
      'private-key',
      'public-key',
      'ip',
      'ipv6',
      'uri',
      'sni',
      'network',
      'congestion-controller',
      'bbr-profile',
    ],
    integers: ['port', 'mtu', 'handshake-timeout', 'cwnd'],
    booleans: ['udp', 'skip-cert-verify', 'remote-dns-resolve'],
    stringArrays: ['dns'],
  }),
  trusttunnel: defineProxyFields({
    strings: [
      'name',
      'server',
      'username',
      'password',
      'sni',
      'client-fingerprint',
      'fingerprint',
      'certificate',
      'private-key',
      'congestion-controller',
      'bbr-profile',
    ],
    integers: ['port', 'cwnd', 'max-connections', 'min-streams', 'max-streams'],
    booleans: ['skip-cert-verify', 'udp', 'health-check', 'quic'],
    stringArrays: ['alpn'],
    records: ['ech-opts'],
  }),
  openvpn: defineProxyFields({
    strings: [
      'name',
      'server',
      'proto',
      'dev',
      'cipher',
      'auth',
      'comp-lzo',
      'ca',
      'cert',
      'key',
      'tls-crypt',
      'username',
      'password',
    ],
    integers: ['port', 'ping', 'ping-restart', 'handshake-timeout', 'mtu'],
    booleans: ['remote-dns-resolve'],
    stringArrays: ['dns'],
    stringMaps: ['peer-info'],
  }),
};

// github.com/metacubex/sing-shadowsocks2 v0.2.7, as pinned by fixed
// Mihomo v1.19.28. CreateMethod is case-sensitive.
const SHADOWSOCKS_METHODS = new Set([
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
]);

const SHADOWSOCKS_2022_KEY_LENGTHS: Readonly<Record<string, number>> = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
  '2022-blake3-chacha8-poly1305': 32,
  '2022-blake3-aes-128-ccm': 16,
  '2022-blake3-aes-256-ccm': 32,
};
const SHADOWSOCKS_2022_NO_EIH_METHODS = new Set([
  '2022-blake3-chacha20-poly1305',
  '2022-blake3-chacha8-poly1305',
]);

// Fixed Mihomo's SSR constructor accepts only the stream subset of its
// legacy PickCipher registry (plus the none/dummy compatibility spellings).
const SHADOWSOCKSR_CIPHERS = new Set([
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
]);
const SHADOWSOCKSR_OBFS = new Set([
  'plain',
  'http_simple',
  'http_post',
  'random_head',
  'tls1.2_ticket_auth',
  'tls1.2_ticket_fastauth',
]);
const SHADOWSOCKSR_PROTOCOLS = new Set([
  'origin',
  'auth_sha1_v4',
  'auth_aes128_md5',
  'auth_aes128_sha1',
  'auth_chain_a',
  'auth_chain_b',
]);

// github.com/metacubex/sing-vmess v0.2.5, as pinned by fixed Mihomo.
// Mihomo lowercases this value before constructing the client.
const VMESS_CIPHERS = new Set([
  'auto',
  'none',
  'zero',
  'aes-128-cfb',
  'aes-128-gcm',
  'chacha20-poly1305',
]);

const IP_VERSIONS = new Set(['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer']);
const SMUX_PROTOCOLS = new Set(['smux', 'yamux', 'h2mux']);
const SMUX_FIELDS = new Set([
  'enabled',
  'protocol',
  'max-connections',
  'min-streams',
  'max-streams',
  'padding',
  'statistic',
  'only-tcp',
  'brutal-opts',
]);
const SMUX_BRUTAL_FIELDS = new Set(['enabled', 'up', 'down']);
const ECH_OPTION_FIELDS = new Set(['enable', 'config', 'query-server-name']);
const HYSTERIA2_REALM_FIELDS = new Set([
  'enable',
  'server-url',
  'token',
  'realm-id',
  'stun-servers',
  'sni',
  'skip-cert-verify',
  'fingerprint',
  'certificate',
  'private-key',
  'alpn',
]);
const WIREGUARD_PEER_FIELDS = new Set([
  'server',
  'port',
  'public-key',
  'pre-shared-key',
  'reserved',
  'allowed-ips',
]);
const AMNEZIA_WG_FIELDS = new Set([
  'jc',
  'jmin',
  'jmax',
  's1',
  's2',
  's3',
  's4',
  'h1',
  'h2',
  'h3',
  'h4',
  'i1',
  'i2',
  'i3',
  'i4',
  'i5',
  'j1',
  'j2',
  'j3',
  'itime',
]);
const TROJAN_SS_FIELDS = new Set(['enabled', 'method', 'password']);
const SUDOKU_HTTP_MASK_FIELDS = new Set([
  'disable',
  'mode',
  'tls',
  'host',
  'path-root',
  'multiplex',
]);
const SHADOWSOCKS_PLUGINS = new Set([
  'obfs',
  'v2ray-plugin',
  'gost-plugin',
  'shadow-tls',
  'restls',
  'kcptun',
]);
const SIMPLE_OBFS_FIELDS = new Set(['mode', 'host']);
const V2RAY_PLUGIN_FIELDS = new Set([
  'mode',
  'host',
  'path',
  'tls',
  'ech-opts',
  'fingerprint',
  'certificate',
  'private-key',
  'headers',
  'skip-cert-verify',
  'mux',
  'v2ray-http-upgrade',
  'v2ray-http-upgrade-fast-open',
]);
const GOST_PLUGIN_FIELDS = new Set([
  'mode',
  'host',
  'path',
  'tls',
  'ech-opts',
  'fingerprint',
  'certificate',
  'private-key',
  'headers',
  'skip-cert-verify',
  'mux',
]);
const SHADOW_TLS_FIELDS = new Set([
  'password',
  'host',
  'fingerprint',
  'certificate',
  'private-key',
  'skip-cert-verify',
  'version',
  'alpn',
]);
const RESTLS_FIELDS = new Set([
  'password',
  'host',
  'version-hint',
  'restls-script',
  'fingerprint',
  'skip-cert-verify',
  'force-tls12',
]);
const KCPTUN_STRING_FIELDS = ['key', 'crypt', 'mode'] as const;
const KCPTUN_INTEGER_FIELDS = [
  'conn',
  'autoexpire',
  'scavengettl',
  'mtu',
  'ratelimit',
  'sndwnd',
  'rcvwnd',
  'datashard',
  'parityshard',
  'dscp',
  'nodelay',
  'interval',
  'resend',
  'nc',
  'sockbuf',
  'smuxver',
  'smuxbuf',
  'framesize',
  'streambuf',
  'keepalive',
] as const;
const KCPTUN_FIELDS = new Set([
  ...KCPTUN_STRING_FIELDS,
  ...KCPTUN_INTEGER_FIELDS,
  'nocomp',
  'acknodelay',
]);
const PACKET_ENCODINGS = new Set(['packetaddr', 'packet', 'xudp']);
const TUIC_UDP_RELAY_MODES = new Set(['quic', 'native']);
const TUIC_CONGESTION_CONTROLLERS = new Set([
  'cubic',
  'new_reno',
  'bbr_meta_v1',
  'bbr_meta_v2',
  'bbr',
]);
const MASQUE_NETWORKS = new Set(['', 'h3', 'h2', 'h3-l4proxy']);
const OPENVPN_PROTOS = new Set(['', 'udp', 'udp4', 'tcp', 'tcp-client', 'tcp4', 'tcp4-client']);
const OPENVPN_CIPHERS = new Set([
  '',
  'AES-CBC',
  'AES-128-GCM',
  'AES-192-GCM',
  'AES-256-GCM',
  'AES-128-CBC',
  'AES-192-CBC',
  'AES-256-CBC',
  'CHACHA20-POLY1305',
]);
const OPENVPN_AUTHS = new Set(['', 'MD5', 'SHA1', 'SHA-1', 'SHA256', 'SHA384', 'SHA512']);
const OPENVPN_COMP_LZO = new Set(['', 'no', 'yes', 'adaptive']);
const MIERU_MULTIPLEXING_LEVELS = new Set([
  'MULTIPLEXING_DEFAULT',
  'MULTIPLEXING_OFF',
  'MULTIPLEXING_LOW',
  'MULTIPLEXING_MIDDLE',
  'MULTIPLEXING_HIGH',
]);
const MIERU_HANDSHAKE_MODES = new Set([
  'HANDSHAKE_DEFAULT',
  'HANDSHAKE_STANDARD',
  'HANDSHAKE_NO_WAIT',
]);
const MAX_MIERU_TRAFFIC_PATTERN_BYTES = 65_536;
const SUDOKU_AEAD_METHODS = new Set(['', 'aes-128-gcm', 'chacha20-poly1305', 'none']);
const SUDOKU_TABLE_TYPES = new Set([
  '',
  'prefer_ascii',
  'prefer_entropy',
  'up_ascii_down_entropy',
  'up_entropy_down_ascii',
]);
const SUDOKU_HTTP_MASK_MODES = new Set(['', 'legacy', 'stream', 'poll', 'auto', 'ws']);
const SUDOKU_HTTP_MASK_MULTIPLEX = new Set(['', 'off', 'auto', 'on']);
const MAX_SUDOKU_CUSTOM_TABLES = 256;

const TLS_MIRROR_FIELDS = new Set([
  'primary-key',
  'explicit-nonce-ciphersuites',
  'defer-instance-derived-write-time',
  'transport-layer-padding',
  'connection-enrolment',
  'embedded-traffic-generator',
  'sequence-watermarking-enabled',
]);
const TLS_MIRROR_TIME_SPEC_FIELDS = new Set([
  'base-nanoseconds',
  'uniform-random-multiplier-nanoseconds',
]);
const TLS_MIRROR_CONNECTION_ENROLMENT_FIELDS = new Set([
  'primary-ingress-outbound',
  'primary-egress-outbound',
]);
const TLS_MIRROR_STEP_FIELDS = new Set([
  'name',
  'host',
  'path',
  'method',
  'headers',
  'next-step',
  'connection-ready',
  'connection-recall-exit',
  'wait-time',
  'h2-do-not-wait-for-download-finish',
]);
const TLS_MIRROR_HEADER_FIELDS = new Set(['name', 'value', 'values']);
const TLS_MIRROR_NEXT_STEP_FIELDS = new Set(['weight', 'goto-location']);
const MAX_WIREGUARD_WORKERS = 256;
const MAX_ANYTLS_IDLE_SESSIONS = 256;

const REQUIRED_STRING_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ss: ['password', 'cipher'],
  ssr: ['password', 'cipher', 'obfs', 'protocol'],
  vmess: ['uuid', 'cipher'],
  vless: ['uuid'],
  trojan: ['password'],
  snell: ['psk'],
  hysteria: ['up', 'down'],
  anytls: ['password'],
  sudoku: ['key'],
  masque: ['private-key', 'public-key'],
  openvpn: ['ca'],
};

const TOP_LEVEL_PRIVATE_KEY_TYPES = new Set(['wireguard', 'ssh', 'masque']);

export interface MihomoProxyValidationOptions {
  allowExternalDialerProxy?: boolean;
  allowLocalFileReferences?: boolean;
}

/**
 * Structured form of the validator's fixed, credential-free entry errors.
 * It remains a 400 ProblemDetailsError for direct node-input APIs; the final
 * config renderer can safely remap the same deterministic failure to 422.
 */
export class MihomoProxyValidationError extends ProblemDetailsError {
  constructor(
    public readonly index: number,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super({
      type: `${PROBLEM_BASE_URL}/bad-request`,
      title: 'Bad Request',
      status: 400,
      detail: `Invalid proxy entry at index ${index}: field "${field}" ${reason}`,
    });
    this.name = 'MihomoProxyValidationError';
  }
}

export class MihomoProxyLimitError extends ProblemDetailsError {
  constructor(
    public readonly count: number,
    public readonly limit: number,
  ) {
    super({
      type: `${PROBLEM_BASE_URL}/bad-request`,
      title: 'Bad Request',
      status: 400,
      detail: `Proxy node count ${count} exceeds limit ${limit}`,
    });
    this.name = 'MihomoProxyLimitError';
  }
}

export const MAX_PROXY_NODES = 50_000;
export const MAX_PROXY_NAME_LENGTH = 512;
export const MAX_HYSTERIA_PORT_CANDIDATES = 65_536;

/**
 * Validate proxy-provider nodes against the fixed Mihomo v1.19.28 dispatch
 * surface and the high-confidence structural requirements used by this app.
 *
 * This deliberately does not emulate Mihomo's weakly typed decoder. Provider
 * data must already use canonical field types so credentials and endpoints
 * cannot be silently coerced into a different value.
 */
export function validateMihomoProxyList(
  list: unknown[],
  options: MihomoProxyValidationOptions = {},
): Record<string, unknown>[] {
  if (list.length > MAX_PROXY_NODES) {
    throw new MihomoProxyLimitError(list.length, MAX_PROXY_NODES);
  }
  const proxies = list.map((entry, index) => validateMihomoProxy(entry, index, options));
  validateHysteriaPortBudget(proxies);
  validateUniqueNames(proxies);
  validateDialerProxyGraph(proxies, options.allowExternalDialerProxy === true);
  return proxies;
}

function validateMihomoProxy(
  entry: unknown,
  index: number,
  options: MihomoProxyValidationOptions,
): Record<string, unknown> {
  if (!isRecord(entry)) {
    return invalidProxyEntry(index, '<entry>', 'must be an object');
  }

  const name = requireNonEmptyString(entry, 'name', index);
  if (/[\x00-\x1f\x7f-\x9f]/u.test(name)) {
    return invalidProxyEntry(index, 'name', 'must not contain control characters');
  }
  if (name.length > MAX_PROXY_NAME_LENGTH) {
    return invalidProxyEntry(index, 'name', `must not exceed ${MAX_PROXY_NAME_LENGTH} characters`);
  }
  const type = requireNonEmptyString(entry, 'type', index);
  if (type !== type.trim() || type !== type.toLowerCase()) {
    return invalidProxyEntry(index, 'type', 'must be a canonical lowercase type');
  }
  if (!FIXED_MIHOMO_PROXY_TYPES.has(type)) {
    return invalidProxyEntry(index, 'type', 'is not supported by fixed Mihomo v1.19.28');
  }
  if (type === 'tailscale') {
    return invalidProxyEntry(
      index,
      'type',
      'requires a build-dependent runtime capability and is not portable',
    );
  }
  // Fixed Mihomo decodes proxy options weakly typed and ignores unknown keys.
  // Mirror the two ecosystem-wide provider emissions that would otherwise
  // reject whole lists: a canonical digit-string `port` coerces to its integer
  // (WeaklyTypedInput semantics), and the inert `udp` flag on QUIC-native
  // types (always UDP-capable; their option structs have no such field) is
  // dropped. Any other shape still fails the fixed portable schema below.
  if (typeof entry.port === 'string' && /^\d{1,5}$/.test(entry.port)) {
    entry.port = Number(entry.port);
  }
  if (
    (type === 'hysteria' || type === 'hysteria2' || type === 'tuic') &&
    typeof entry.udp === 'boolean'
  ) {
    delete entry.udp;
  }
  // TUIC's protocol version is decided by the credential shape (token = v4,
  // uuid+password = v5); Mihomo has no `version` field and ignores the key.
  if (
    type === 'tuic' &&
    (entry.version === 4 || entry.version === 5 || entry.version === '4' || entry.version === '5')
  ) {
    delete entry.version;
  }
  for (const field of REQUIRED_STRING_FIELDS[type] ?? []) {
    requireNonEmptyString(entry, field, index);
  }
  if (hasOwn(entry, 'kcp-opts')) {
    invalidProxyEntry(index, 'kcp-opts', 'is not decoded by fixed Mihomo; use mkcp-opts');
  }
  validateTopLevelProxySchema(entry, index, type);
  validateCommonFields(entry, index);
  if (hasOwn(entry, 'ech-opts')) {
    validateEchOptionsAt(entry['ech-opts'], index, 'ech-opts');
  }
  validateRealityOptions(entry, index);
  validateTlsFieldDependencies(entry, index, type);
  if (hasOwn(entry, 'tlsmirror-opts')) {
    validateTlsMirrorOptions(entry['tlsmirror-opts'], index, 'tlsmirror-opts');
  }
  if (!options.allowLocalFileReferences) {
    validateInlineTlsMaterial(entry, index, type);
  }

  if (type === 'wireguard') {
    validateWireGuard(entry, index);
  } else if (type === 'mieru') {
    validateMieruEndpoint(entry, index);
  } else if (type === 'hysteria' || type === 'hysteria2') {
    validateHysteriaEndpoint(entry, index, type);
  } else if (!ENDPOINT_FREE_PROXY_TYPES.has(type)) {
    validateEndpoint(entry, index);
  }

  switch (type) {
    case 'ss':
      validateShadowsocks(entry, index);
      break;
    case 'ssr':
      validateShadowsocksR(entry, index);
      break;
    case 'vmess':
      validateUuid(entry, index);
      validateVmess(entry, index);
      break;
    case 'vless':
      validateUuid(entry, index);
      validateVless(entry, index);
      break;
    case 'trojan':
      validateTrojan(entry, index);
      break;
    case 'rematch':
      validateRematch(entry, index);
      break;
    case 'tuic':
      validateTuicCredentials(entry, index);
      break;
    case 'hysteria2':
      validateHysteria2(entry, index);
      break;
    case 'snell':
      validateSnell(entry, index);
      break;
    case 'ssh':
      validateSsh(entry, index, options.allowLocalFileReferences === true);
      break;
    case 'mieru':
      validateMieru(entry, index);
      break;
    case 'sudoku':
      validateSudoku(entry, index);
      break;
    case 'masque':
      validateMasque(entry, index);
      break;
    case 'hysteria':
      validateHysteria(entry, index);
      break;
    case 'anytls':
      validateAnyTls(entry, index);
      break;
    case 'openvpn':
      validateOpenVpn(entry, index);
      break;
    case 'trusttunnel':
      validateTrustTunnel(entry, index);
      break;
    default:
      break;
  }

  return entry;
}

function validateTopLevelProxySchema(
  proxy: Record<string, unknown>,
  index: number,
  type: string,
): void {
  const typeFields = PROXY_FIELDS_BY_TYPE[type];
  if (typeFields === undefined) {
    invalidProxyEntry(index, 'type', 'does not have a fixed portable schema');
  }
  const commonFields = COMMON_PROXY_FIELDS_BY_TYPE[type] ?? COMMON_PROXY_FIELDS;

  for (const [field, value] of Object.entries(proxy)) {
    const kind = typeFields[field] ?? commonFields[field];
    if (kind === undefined) {
      // `udp` on `direct` is a common legacy alias and both identifiers are
      // fixed schema names, so reporting this one path is safe and actionable.
      // Every other unknown/inert key stays hidden because an attacker-controlled
      // key may itself contain subscription credentials or other sensitive data.
      if (type === 'direct' && field === 'udp') {
        invalidProxyEntry(index, field, 'is not supported for type "direct"');
      }
      invalidProxyEntry(index, 'proxy', 'contains an unsupported top-level field');
    }
    validateProxyFieldKind(value, kind, index, field);
  }
}

function validateProxyFieldKind(
  value: unknown,
  kind: ProxyFieldKind,
  index: number,
  field: string,
): void {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') invalidProxyEntry(index, field, 'must be a string');
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        invalidProxyEntry(index, field, 'must be a safe integer');
      }
      return;
    case 'uint64':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        invalidProxyEntry(index, field, 'must be a non-negative safe integer');
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') invalidProxyEntry(index, field, 'must be a boolean');
      return;
    case 'string-array':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        invalidProxyEntry(index, field, 'must be a string array');
      }
      return;
    case 'string-map':
      if (!isPlainRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
        invalidProxyEntry(index, field, 'must be a plain string map');
      }
      return;
    case 'record':
      if (!isPlainRecord(value)) invalidProxyEntry(index, field, 'must be a plain object');
      return;
    case 'record-array':
      if (!Array.isArray(value) || value.some((item) => !isPlainRecord(item))) {
        invalidProxyEntry(index, field, 'must be an array of plain objects');
      }
      return;
    case 'uint8-array':
      if (
        !Array.isArray(value) ||
        value.some(
          (item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 0xff,
        )
      ) {
        invalidProxyEntry(index, field, 'must be a byte array');
      }
  }
}

function validateCommonFields(proxy: Record<string, unknown>, index: number): void {
  optionalBoolean(proxy, 'udp', index);
  optionalBoolean(proxy, 'tfo', index);
  optionalBoolean(proxy, 'mptcp', index);
  optionalBoolean(proxy, 'tls', index);
  optionalBoolean(proxy, 'skip-cert-verify', index);
  optionalNonEmptyString(proxy, 'interface-name', index);
  optionalNonEmptyString(proxy, 'servername', index);
  optionalNonEmptyString(proxy, 'sni', index);
  optionalNonEmptyString(proxy, 'client-fingerprint', index);
  optionalNonEmptyString(proxy, 'fingerprint', index);
  validateAlpn(proxy, index);
  if (hasOwn(proxy, 'routing-mark')) {
    optionalNonNegativeInteger(proxy, 'routing-mark', index);
  }
  if (hasOwn(proxy, 'dialer-proxy')) {
    requireNonEmptyString(proxy, 'dialer-proxy', index);
  }
  if (hasOwn(proxy, 'ip-version')) {
    const ipVersion = requireNonEmptyString(proxy, 'ip-version', index);
    if (!IP_VERSIONS.has(ipVersion)) {
      invalidProxyEntry(index, 'ip-version', 'must use a fixed Mihomo IP version');
    }
  }
  if (hasOwn(proxy, 'smux')) {
    validateSmux(proxy.smux, index);
  }
}

function validateSmux(value: unknown, index: number): void {
  if (!isRecord(value)) {
    invalidProxyEntry(index, 'smux', 'must be an object');
  }
  rejectUnknownFields(value, SMUX_FIELDS, index, 'smux');
  optionalBoolean(value, 'enabled', index, 'smux');
  optionalBoolean(value, 'padding', index, 'smux');
  optionalBoolean(value, 'statistic', index, 'smux');
  optionalBoolean(value, 'only-tcp', index, 'smux');
  if (hasOwn(value, 'protocol')) {
    const protocol = requireNonEmptyString(value, 'protocol', index, 'smux');
    if (!SMUX_PROTOCOLS.has(protocol)) {
      invalidProxyEntry(index, 'smux.protocol', 'must be smux, yamux, or h2mux');
    }
  }
  for (const field of ['max-connections', 'min-streams', 'max-streams']) {
    if (hasOwn(value, field)) {
      optionalNonNegativeInteger(value, field, index, 'smux');
    }
  }
  if (hasOwn(value, 'brutal-opts')) {
    const brutal = value['brutal-opts'];
    if (!isRecord(brutal)) {
      invalidProxyEntry(index, 'smux.brutal-opts', 'must be an object');
    }
    rejectUnknownFields(brutal, SMUX_BRUTAL_FIELDS, index, 'smux.brutal-opts');
    optionalBoolean(brutal, 'enabled', index, 'smux.brutal-opts');
    optionalNonEmptyString(brutal, 'up', index, 'smux.brutal-opts');
    optionalNonEmptyString(brutal, 'down', index, 'smux.brutal-opts');
  }
}

function validateShadowsocks(proxy: Record<string, unknown>, index: number): void {
  const cipher = requireNonEmptyString(proxy, 'cipher', index);
  if (!SHADOWSOCKS_METHODS.has(cipher)) {
    invalidProxyEntry(index, 'cipher', 'is not supported by fixed Mihomo Shadowsocks');
  }
  const keyLength = SHADOWSOCKS_2022_KEY_LENGTHS[cipher];
  if (keyLength !== undefined) {
    const password = requireNonEmptyString(proxy, 'password', index);
    const keys = password.split(':');
    for (const key of keys) {
      if (
        key === '' ||
        !isCanonicalStandardBase64(key) ||
        Buffer.from(key, 'base64').length !== keyLength
      ) {
        invalidProxyEntry(
          index,
          'password',
          `must contain canonical Base64 keys of exactly ${keyLength} bytes`,
        );
      }
    }
    if (SHADOWSOCKS_2022_NO_EIH_METHODS.has(cipher) && keys.length !== 1) {
      invalidProxyEntry(index, 'password', 'does not allow multiple PSKs for this cipher');
    }
  }

  const plugin = optionalNonEmptyString(proxy, 'plugin', index);
  if (plugin === undefined) {
    if (hasOwn(proxy, 'plugin-opts')) {
      invalidProxyEntry(index, 'plugin-opts', 'requires a plugin');
    }
  } else {
    if (!SHADOWSOCKS_PLUGINS.has(plugin)) {
      invalidProxyEntry(index, 'plugin', 'is not implemented by fixed Mihomo');
    }
    if (!hasOwn(proxy, 'plugin-opts')) {
      invalidProxyEntry(index, 'plugin-opts', 'is required by the selected plugin');
    }
    validateShadowsocksPluginOptions(plugin, proxy['plugin-opts'], index);
  }

  if (hasOwn(proxy, 'udp-over-tcp-version')) {
    const version = proxy['udp-over-tcp-version'];
    if (version !== 1 && version !== 2) {
      invalidProxyEntry(index, 'udp-over-tcp-version', 'must be fixed UOT version 1 or 2');
    }
  }
}

function validateShadowsocksPluginOptions(plugin: string, value: unknown, index: number): void {
  const prefix = 'plugin-opts';
  if (!isPlainRecord(value)) invalidProxyEntry(index, prefix, 'must be a plain object');
  switch (plugin) {
    case 'obfs': {
      rejectUnknownFields(value, SIMPLE_OBFS_FIELDS, index, prefix);
      const mode = optionalString(value, 'mode', index, prefix);
      optionalString(value, 'host', index, prefix);
      if (mode !== 'tls' && mode !== 'http') {
        invalidProxyEntry(index, `${prefix}.mode`, 'must be tls or http');
      }
      break;
    }
    case 'v2ray-plugin':
      validateWebsocketPluginOptions(value, index, prefix, true);
      break;
    case 'gost-plugin':
      validateWebsocketPluginOptions(value, index, prefix, false);
      break;
    case 'shadow-tls':
      validateShadowTlsOptions(value, index, prefix);
      break;
    case 'restls':
      rejectUnknownFields(value, RESTLS_FIELDS, index, prefix);
      for (const field of ['password', 'host', 'version-hint', 'restls-script', 'fingerprint']) {
        optionalString(value, field, index, prefix);
      }
      optionalBoolean(value, 'skip-cert-verify', index, prefix);
      optionalBoolean(value, 'force-tls12', index, prefix);
      break;
    case 'kcptun':
      rejectUnknownFields(value, KCPTUN_FIELDS, index, prefix);
      for (const field of KCPTUN_STRING_FIELDS) optionalString(value, field, index, prefix);
      for (const field of KCPTUN_INTEGER_FIELDS) {
        if (!hasOwn(value, field)) continue;
        const item = value[field];
        if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
          invalidProxyEntry(index, `${prefix}.${field}`, 'must be a safe integer');
        }
      }
      optionalBoolean(value, 'nocomp', index, prefix);
      optionalBoolean(value, 'acknodelay', index, prefix);
      break;
    default:
      invalidProxyEntry(index, 'plugin', 'is not implemented by fixed Mihomo');
  }
}

function validateWebsocketPluginOptions(
  value: Record<string, unknown>,
  index: number,
  prefix: string,
  v2ray: boolean,
): void {
  rejectUnknownFields(value, v2ray ? V2RAY_PLUGIN_FIELDS : GOST_PLUGIN_FIELDS, index, prefix);
  for (const field of ['mode', 'host', 'path', 'fingerprint', 'certificate', 'private-key']) {
    optionalString(value, field, index, prefix);
  }
  if (value.mode !== 'websocket') {
    invalidProxyEntry(index, `${prefix}.mode`, 'must be websocket');
  }
  for (const field of ['tls', 'skip-cert-verify', 'mux']) {
    optionalBoolean(value, field, index, prefix);
  }
  if (v2ray) {
    optionalBoolean(value, 'v2ray-http-upgrade', index, prefix);
    optionalBoolean(value, 'v2ray-http-upgrade-fast-open', index, prefix);
  }
  if (hasOwn(value, 'headers')) {
    const headers = value.headers;
    if (
      !isPlainRecord(headers) ||
      Object.values(headers).some((item) => typeof item !== 'string')
    ) {
      invalidProxyEntry(index, `${prefix}.headers`, 'must be a plain string map');
    }
  }
  if (hasOwn(value, 'ech-opts')) {
    validateEchOptionsAt(value['ech-opts'], index, `${prefix}.ech-opts`);
  }
  requireTlsForFields(value, index, prefix, [
    'ech-opts',
    'fingerprint',
    'certificate',
    'private-key',
    'skip-cert-verify',
  ]);
}

function validateShadowTlsOptions(
  value: Record<string, unknown>,
  index: number,
  prefix: string,
  allowMode = false,
): void {
  rejectUnknownFields(
    value,
    allowMode ? new Set([...SHADOW_TLS_FIELDS, 'mode']) : SHADOW_TLS_FIELDS,
    index,
    prefix,
  );
  if (allowMode && optionalString(value, 'mode', index, prefix) !== 'shadow-tls') {
    invalidProxyEntry(index, `${prefix}.mode`, 'must be shadow-tls');
  }
  for (const field of ['password', 'host', 'fingerprint', 'certificate', 'private-key']) {
    optionalString(value, field, index, prefix);
  }
  optionalBoolean(value, 'skip-cert-verify', index, prefix);
  if (hasOwn(value, 'version')) {
    const version = value.version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
      invalidProxyEntry(index, `${prefix}.version`, 'must be a safe integer');
    }
  }
  validateStringArray(value, 'alpn', index, prefix);
}

function validateShadowsocksR(proxy: Record<string, unknown>, index: number): void {
  const cipher = requireNonEmptyString(proxy, 'cipher', index);
  if (!SHADOWSOCKSR_CIPHERS.has(cipher.toLowerCase())) {
    invalidProxyEntry(index, 'cipher', 'is not a fixed Mihomo ShadowsocksR stream cipher');
  }
  const obfs = requireNonEmptyString(proxy, 'obfs', index);
  if (!SHADOWSOCKSR_OBFS.has(obfs)) {
    invalidProxyEntry(index, 'obfs', 'is not supported by fixed Mihomo ShadowsocksR');
  }
  const protocol = requireNonEmptyString(proxy, 'protocol', index);
  if (!SHADOWSOCKSR_PROTOCOLS.has(protocol)) {
    invalidProxyEntry(index, 'protocol', 'is not supported by fixed Mihomo ShadowsocksR');
  }
}

function validateVmess(proxy: Record<string, unknown>, index: number): void {
  const cipher = requireNonEmptyString(proxy, 'cipher', index);
  if (!VMESS_CIPHERS.has(cipher.toLowerCase())) {
    invalidProxyEntry(index, 'cipher', 'is not supported by fixed Mihomo VMess');
  }
  validatePacketEncoding(proxy, index);
  validateNetwork(proxy, index, VMESS_NETWORKS);
}

function validateVless(proxy: Record<string, unknown>, index: number): void {
  const flow = optionalString(proxy, 'flow', index);
  if (flow !== undefined && flow !== '' && flow !== 'xtls-rprx-vision') {
    invalidProxyEntry(index, 'flow', 'must be empty or xtls-rprx-vision');
  }
  validatePacketEncoding(proxy, index);
  validateNetwork(proxy, index, VLESS_NETWORKS);
}

function validatePacketEncoding(proxy: Record<string, unknown>, index: number): void {
  if (proxy['packet-addr'] === true && proxy.xudp === true) {
    invalidProxyEntry(index, 'xudp', 'conflicts with packet-addr');
  }
  if (!hasOwn(proxy, 'packet-encoding')) return;
  const encoding = optionalString(proxy, 'packet-encoding', index);
  if (encoding === undefined || !PACKET_ENCODINGS.has(encoding)) {
    invalidProxyEntry(index, 'packet-encoding', 'is not implemented by fixed Mihomo');
  }
  if (hasOwn(proxy, 'packet-addr') || hasOwn(proxy, 'xudp')) {
    invalidProxyEntry(index, 'packet-encoding', 'conflicts with explicit packet mode aliases');
  }
}

function validateTrojan(proxy: Record<string, unknown>, index: number): void {
  validateNetwork(proxy, index, TROJAN_NETWORKS);
  if (!hasOwn(proxy, 'ss-opts')) return;
  const options = proxy['ss-opts'];
  if (!isPlainRecord(options)) invalidProxyEntry(index, 'ss-opts', 'must be a plain object');
  rejectUnknownFields(options, TROJAN_SS_FIELDS, index, 'ss-opts');
  optionalBoolean(options, 'enabled', index, 'ss-opts');
  optionalString(options, 'method', index, 'ss-opts');
  optionalString(options, 'password', index, 'ss-opts');
  if (options.enabled === true) {
    requireNonEmptyString(options, 'password', index, 'ss-opts');
  } else if (hasOwn(options, 'method') || hasOwn(options, 'password')) {
    invalidProxyEntry(index, 'ss-opts.enabled', 'must be true when cipher details are present');
  }
}

function validateUuid(proxy: Record<string, unknown>, index: number): void {
  const uuid = requireNonEmptyString(proxy, 'uuid', index);
  const normalized = isCanonicalUuid(uuid) ? uuid.toLowerCase() : normalizeMihomoUserId(uuid);
  if (normalized === null) {
    invalidProxyEntry(index, 'uuid', 'must be a bounded Mihomo user ID');
  }
  proxy.uuid = normalized;
}

function validateNetwork(
  proxy: Record<string, unknown>,
  index: number,
  allowed: ReadonlySet<string>,
): void {
  let network = 'tcp';
  if (hasOwn(proxy, 'network')) {
    network = requireNonEmptyString(proxy, 'network', index);
    if (!allowed.has(network)) {
      invalidProxyEntry(index, 'network', 'is not supported for this fixed proxy type');
    }
  }

  const selectedOptionsField = TRANSPORT_OPTIONS_BY_NETWORK[network];
  for (const field of KNOWN_TRANSPORT_OPTION_FIELDS) {
    if (!hasOwn(proxy, field)) continue;
    if (field === 'kcp-opts') {
      invalidProxyEntry(index, field, 'is not decoded by fixed Mihomo; use mkcp-opts');
    }
    if (field !== selectedOptionsField) {
      invalidProxyEntry(index, field, 'does not match the selected network');
    }
    if (!isPlainRecord(proxy[field])) {
      invalidProxyEntry(index, field, 'must be a plain object');
    }
    validateTransportOptions(proxy[field], index, field);
  }
}

function validateTransportOptions(
  options: Record<string, unknown>,
  index: number,
  field: string,
): void {
  switch (field) {
    case 'ws-opts':
      validateWsOptions(options, index, field);
      break;
    case 'http-opts':
      validateHttpOptions(options, index, field);
      break;
    case 'h2-opts':
      validateH2Options(options, index, field);
      break;
    case 'grpc-opts':
      validateGrpcOptions(options, index, field);
      break;
    case 'xhttp-opts':
      validateXhttpOptions(options, index, field);
      break;
    case 'mekya-opts':
      validateMekyaOptions(options, index, field);
      break;
    case 'mkcp-opts':
      validateMkcpOptions(options, index, field);
      break;
    default:
      invalidProxyEntry(index, field, 'is not a fixed Mihomo transport option');
  }
}

function validateWsOptions(options: Record<string, unknown>, index: number, prefix: string): void {
  rejectUnknownFields(options, WS_OPTION_FIELDS, index, prefix);
  optionalString(options, 'path', index, prefix);
  validateHeaderMap(options, 'headers', index, prefix, false);
  optionalNonNegativeInteger(options, 'max-early-data', index, prefix);
  optionalString(options, 'early-data-header-name', index, prefix);
  optionalBoolean(options, 'v2ray-http-upgrade', index, prefix);
  optionalBoolean(options, 'v2ray-http-upgrade-fast-open', index, prefix);
}

function validateHttpOptions(
  options: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(options, HTTP_OPTION_FIELDS, index, prefix);
  optionalString(options, 'method', index, prefix);
  validateStringArray(options, 'path', index, prefix);
  validateHeaderMap(options, 'headers', index, prefix, true);
}

function validateH2Options(options: Record<string, unknown>, index: number, prefix: string): void {
  rejectUnknownFields(options, H2_OPTION_FIELDS, index, prefix);
  validateStringArray(options, 'host', index, prefix);
  optionalString(options, 'path', index, prefix);
}

function validateGrpcOptions(
  options: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(options, GRPC_OPTION_FIELDS, index, prefix);
  optionalString(options, 'grpc-service-name', index, prefix);
  optionalString(options, 'grpc-user-agent', index, prefix);
  const pingInterval = optionalNonNegativeInteger(options, 'ping-interval', index, prefix);
  if (pingInterval !== undefined && pingInterval > MAX_GO_DURATION_SECONDS) {
    invalidProxyEntry(index, `${prefix}.ping-interval`, 'would overflow fixed Mihomo duration');
  }
  const maxConnections = optionalNonNegativeInteger(options, 'max-connections', index, prefix) ?? 0;
  const minStreams = optionalNonNegativeInteger(options, 'min-streams', index, prefix) ?? 0;
  const maxStreams = optionalNonNegativeInteger(options, 'max-streams', index, prefix) ?? 0;
  if (maxStreams > 0 && (maxConnections > 0 || minStreams > 0)) {
    invalidProxyEntry(
      index,
      `${prefix}.max-streams`,
      'conflicts with connection-based mux controls',
    );
  }
  if (minStreams > 0 && maxConnections === 0) {
    invalidProxyEntry(index, `${prefix}.min-streams`, 'requires max-connections');
  }
}

function validateMkcpOptions(
  options: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(options, MKCP_OPTION_FIELDS, index, prefix);
  for (const field of [
    'mtu',
    'tti',
    'uplink-capacity',
    'downlink-capacity',
    'write-buffer',
    'read-buffer',
  ]) {
    optionalUint32(options, field, index, prefix);
  }
  if (typeof options.tti === 'number' && options.tti > 1000) {
    invalidProxyEntry(index, `${prefix}.tti`, 'must not make fixed Mihomo divide by zero');
  }
  optionalBoolean(options, 'congestion', index, prefix);
  optionalString(options, 'seed', index, prefix);
  const header = optionalString(options, 'header', index, prefix);
  if (header !== undefined && !MKCP_HEADERS.has(header)) {
    invalidProxyEntry(index, `${prefix}.header`, 'is not a fixed Mihomo mKCP header');
  }
}

function validateMekyaOptions(
  options: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(options, MEKYA_OPTION_FIELDS, index, prefix);
  optionalString(options, 'url', index, prefix);
  for (const field of [
    'h2-pool-size',
    'max-write-delay',
    'max-request-size',
    'polling-interval-initial',
    'max-write-size',
    'max-write-duration-ms',
    'max-simultaneous-write-connection',
    'packet-writing-buffer',
  ]) {
    optionalNonNegativeInteger(options, field, index, prefix);
  }
  if (hasOwn(options, 'kcp')) {
    const kcp = options.kcp;
    if (!isPlainRecord(kcp)) {
      invalidProxyEntry(index, `${prefix}.kcp`, 'must be a plain object');
    }
    validateMkcpOptions(kcp, index, `${prefix}.kcp`);
  }
}

function validateXhttpOptions(
  options: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(options, XHTTP_OPTION_FIELDS, index, prefix);
  optionalString(options, 'path', index, prefix);
  optionalString(options, 'host', index, prefix);
  const mode = optionalString(options, 'mode', index, prefix) ?? '';
  if (!XHTTP_MODES.has(mode)) {
    invalidProxyEntry(index, `${prefix}.mode`, 'is not implemented by fixed Mihomo');
  }
  validateHeaderMap(options, 'headers', index, prefix, false, true);
  optionalBoolean(options, 'no-grpc-header', index, prefix);
  optionalBoolean(options, 'x-padding-obfs-mode', index, prefix);

  validateXhttpRange(options, 'x-padding-bytes', index, prefix);
  for (const field of [
    'x-padding-key',
    'x-padding-header',
    'session-key',
    'seq-key',
    'uplink-data-key',
  ]) {
    optionalString(options, field, index, prefix);
  }

  const paddingPlacement = optionalString(options, 'x-padding-placement', index, prefix) ?? '';
  if (!XHTTP_PADDING_PLACEMENTS.has(paddingPlacement)) {
    invalidProxyEntry(index, `${prefix}.x-padding-placement`, 'is not supported');
  }
  const paddingMethod = optionalString(options, 'x-padding-method', index, prefix) ?? '';
  if (!XHTTP_PADDING_METHODS.has(paddingMethod)) {
    invalidProxyEntry(index, `${prefix}.x-padding-method`, 'is not supported');
  }
  const paddingDetails = [
    'x-padding-key',
    'x-padding-header',
    'x-padding-placement',
    'x-padding-method',
  ];
  if (
    paddingDetails.some((field) => hasOwn(options, field)) &&
    options['x-padding-obfs-mode'] !== true
  ) {
    invalidProxyEntry(index, `${prefix}.x-padding-obfs-mode`, 'must enable padding detail fields');
  }

  const method = optionalString(options, 'uplink-http-method', index, prefix) ?? '';
  if (method !== '' && !HTTP_HEADER_NAME_PATTERN.test(method)) {
    invalidProxyEntry(index, `${prefix}.uplink-http-method`, 'must be a valid HTTP method token');
  }
  if (method.toUpperCase() === 'GET' && mode !== 'packet-up') {
    invalidProxyEntry(index, `${prefix}.uplink-http-method`, 'requires packet-up mode for GET');
  }

  const sessionPlacement = optionalString(options, 'session-placement', index, prefix) ?? '';
  if (!XHTTP_META_PLACEMENTS.has(sessionPlacement)) {
    invalidProxyEntry(index, `${prefix}.session-placement`, 'is not supported');
  }
  const seqPlacement = optionalString(options, 'seq-placement', index, prefix) ?? '';
  if (!XHTTP_META_PLACEMENTS.has(seqPlacement)) {
    invalidProxyEntry(index, `${prefix}.seq-placement`, 'is not supported');
  }
  const dataPlacement = optionalString(options, 'uplink-data-placement', index, prefix) ?? '';
  if (!XHTTP_DATA_PLACEMENTS.has(dataPlacement)) {
    invalidProxyEntry(index, `${prefix}.uplink-data-placement`, 'is not supported');
  }
  if (hasOwn(options, 'session-key') && (sessionPlacement === '' || sessionPlacement === 'path')) {
    invalidProxyEntry(index, `${prefix}.session-key`, 'requires a keyed session placement');
  }
  if (hasOwn(options, 'seq-key') && (seqPlacement === '' || seqPlacement === 'path')) {
    invalidProxyEntry(index, `${prefix}.seq-key`, 'requires a keyed sequence placement');
  }
  if (
    hasOwn(options, 'uplink-data-key') &&
    dataPlacement !== 'header' &&
    dataPlacement !== 'cookie'
  ) {
    invalidProxyEntry(index, `${prefix}.uplink-data-key`, 'requires header or cookie placement');
  }
  if (
    (dataPlacement === 'header' || dataPlacement === 'cookie') &&
    !hasOwn(options, 'uplink-data-key')
  ) {
    invalidProxyEntry(index, `${prefix}.uplink-data-key`, 'is required by the selected placement');
  }

  validateXhttpSession(options, index, prefix);
  const chunkSize = validateXhttpRange(options, 'uplink-chunk-size', index, prefix, true);
  if (chunkSize !== undefined && dataPlacement !== 'header' && dataPlacement !== 'cookie') {
    invalidProxyEntry(index, `${prefix}.uplink-chunk-size`, 'requires header or cookie placement');
  }
  validateXhttpRange(options, 'sc-max-each-post-bytes', index, prefix, true);
  validateXhttpRange(options, 'sc-min-posts-interval-ms', index, prefix, true);

  if (hasOwn(options, 'reuse-settings')) {
    const reuse = options['reuse-settings'];
    if (!isPlainRecord(reuse)) {
      invalidProxyEntry(index, `${prefix}.reuse-settings`, 'must be a plain object');
    }
    validateXhttpReuseSettings(reuse, index, `${prefix}.reuse-settings`);
  }
  if (hasOwn(options, 'download-settings')) {
    const download = options['download-settings'];
    if (!isPlainRecord(download)) {
      invalidProxyEntry(index, `${prefix}.download-settings`, 'must be a plain object');
    }
    if (mode === 'stream-one') {
      invalidProxyEntry(index, `${prefix}.download-settings`, 'conflicts with stream-one mode');
    }
    validateXhttpDownloadSettings(download, index, `${prefix}.download-settings`);
  }
}

function validateXhttpSession(
  options: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  const rawTable = optionalString(options, 'session-table', index, prefix);
  const hasLength = hasOwn(options, 'session-length');
  if (rawTable === undefined || rawTable === '' || rawTable === 'uuid') {
    if (hasLength) {
      optionalString(options, 'session-length', index, prefix);
      invalidProxyEntry(index, `${prefix}.session-length`, 'requires a custom session table');
    }
    return;
  }

  const table = XHTTP_PREDEFINED_SESSION_TABLES[rawTable] ?? rawTable;
  if (!/^[\x20-\x7e]+$/u.test(table)) {
    invalidProxyEntry(index, `${prefix}.session-table`, 'must contain printable ASCII characters');
  }
  if (table !== rawTable) options['session-table'] = table;
  const range = hasLength
    ? validateXhttpRange(options, 'session-length', index, prefix, true)
    : { min: 16, max: 32 };
  if (
    range === undefined ||
    range.max > MAX_XHTTP_SESSION_ID_LENGTH ||
    range.max - range.min + 1 > MAX_XHTTP_SESSION_ID_RANGE_CARDINALITY
  ) {
    invalidProxyEntry(index, `${prefix}.session-length`, 'exceeds the bounded session ID policy');
  }
  if (!hasMinimumXhttpSessionSpace(table.length, range.min, range.max)) {
    invalidProxyEntry(index, `${prefix}.session-table`, 'has insufficient identifier space');
  }
}

function validateXhttpReuseSettings(
  reuse: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(reuse, XHTTP_REUSE_FIELDS, index, prefix);
  const ranges = new Map<string, { min: number; max: number }>();
  for (const field of [
    'max-concurrency',
    'max-connections',
    'c-max-reuse-times',
    'h-max-request-times',
    'h-max-reusable-secs',
  ]) {
    const range = validateXhttpRange(reuse, field, index, prefix);
    if (range !== undefined) ranges.set(field, range);
  }
  if (
    (ranges.get('max-concurrency')?.max ?? 0) > 0 &&
    (ranges.get('max-connections')?.max ?? 0) > 0
  ) {
    invalidProxyEntry(index, `${prefix}.max-connections`, 'conflicts with max-concurrency');
  }
  const keepAlive = optionalNonNegativeInteger(reuse, 'h-keep-alive-period', index, prefix);
  if (keepAlive !== undefined && keepAlive > MAX_GO_DURATION_SECONDS) {
    invalidProxyEntry(
      index,
      `${prefix}.h-keep-alive-period`,
      'would overflow fixed Mihomo duration',
    );
  }
}

function validateXhttpDownloadSettings(
  download: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  rejectUnknownFields(download, XHTTP_DOWNLOAD_FIELDS, index, prefix);
  for (const field of [
    'path',
    'host',
    'server',
    'fingerprint',
    'certificate',
    'private-key',
    'servername',
    'client-fingerprint',
  ]) {
    optionalString(download, field, index, prefix);
  }
  validateHeaderMap(download, 'headers', index, prefix, false, true);
  if (hasOwn(download, 'reuse-settings')) {
    const reuse = download['reuse-settings'];
    if (!isPlainRecord(reuse)) {
      invalidProxyEntry(index, `${prefix}.reuse-settings`, 'must be a plain object');
    }
    validateXhttpReuseSettings(reuse, index, `${prefix}.reuse-settings`);
  }
  if (hasOwn(download, 'port')) requirePort(download, 'port', index, prefix);
  optionalBoolean(download, 'tls', index, prefix);
  optionalBoolean(download, 'skip-cert-verify', index, prefix);
  validateStringArray(download, 'alpn', index, prefix, true);
  if (hasOwn(download, 'ech-opts')) {
    validateEchOptionsAt(download['ech-opts'], index, `${prefix}.ech-opts`);
  }
  requireTlsForFields(download, index, prefix, [
    'alpn',
    'ech-opts',
    'reality-opts',
    'skip-cert-verify',
    'fingerprint',
    'certificate',
    'private-key',
    'servername',
    'client-fingerprint',
  ]);
}

function validateXhttpRange(
  record: Record<string, unknown>,
  field: string,
  index: number,
  prefix: string,
  requirePositive = false,
): { min: number; max: number } | undefined {
  if (!hasOwn(record, field)) return undefined;
  const value = record[field];
  if (typeof value !== 'string') {
    invalidProxyEntry(index, `${prefix}.${field}`, 'must be an unsigned integer or range string');
  }
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value);
  if (!match) {
    invalidProxyEntry(index, `${prefix}.${field}`, 'must be an unsigned integer or range string');
  }
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < (requirePositive ? 1 : 0) ||
    max < min
  ) {
    invalidProxyEntry(index, `${prefix}.${field}`, 'must be a bounded ascending integer range');
  }
  return { min, max };
}

function hasMinimumXhttpSessionSpace(tableSize: number, min: number, max: number): boolean {
  const base = BigInt(tableSize);
  let room = BigInt(0);
  for (let length = min; length <= max; length += 1) {
    room += base ** BigInt(length);
    if (room >= MIN_XHTTP_SESSION_ID_SPACE) return true;
  }
  return false;
}

function validateHeaderMap(
  record: Record<string, unknown>,
  field: string,
  index: number,
  prefix: string,
  arrayValues: boolean,
  rejectHost = false,
): void {
  if (!hasOwn(record, field)) return;
  const value = record[field];
  if (!isPlainRecord(value)) {
    invalidProxyEntry(index, `${prefix}.${field}`, 'must be a plain header map');
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      !HTTP_HEADER_NAME_PATTERN.test(name) ||
      (rejectHost && name.toLowerCase() === 'host') ||
      (arrayValues
        ? !Array.isArray(headerValue) ||
          headerValue.some((item) => typeof item !== 'string' || /[\r\n]/u.test(item))
        : typeof headerValue !== 'string' || /[\r\n]/u.test(headerValue))
    ) {
      invalidProxyEntry(index, `${prefix}.${field}`, 'must contain canonical HTTP headers');
    }
  }
}

function validateStringArray(
  record: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
  requireNonEmpty = false,
): void {
  if (!hasOwn(record, field)) return;
  const value = record[field];
  if (
    !Array.isArray(value) ||
    (requireNonEmpty && value.length === 0) ||
    value.some((item) => typeof item !== 'string' || (requireNonEmpty && item.trim() === ''))
  ) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be a string array');
  }
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): string | undefined {
  if (!hasOwn(record, field)) return undefined;
  const value = record[field];
  if (typeof value !== 'string') {
    invalidProxyEntry(index, joinField(prefix, field), 'must be a string');
  }
  return value;
}

function optionalUint32(
  record: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): number | undefined {
  if (!hasOwn(record, field)) return undefined;
  const value = record[field];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_UINT32
  ) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be an unsigned 32-bit integer');
  }
  return value;
}

function validateEchOptionsAt(value: unknown, index: number, prefix: string): void {
  if (!isPlainRecord(value)) {
    invalidProxyEntry(index, prefix, 'must be a plain object');
  }
  rejectUnknownFields(value, ECH_OPTION_FIELDS, index, prefix);
  optionalBoolean(value, 'enable', index, prefix);
  const config = optionalString(value, 'config', index, prefix);
  optionalString(value, 'query-server-name', index, prefix);
  if (config !== undefined && config !== '' && !isCanonicalStandardBase64(config)) {
    invalidProxyEntry(index, `${prefix}.config`, 'must be canonical standard Base64');
  }
}

function validateTlsFieldDependencies(
  proxy: Record<string, unknown>,
  index: number,
  type: string,
): void {
  const fieldsByType: Readonly<Record<string, readonly string[]>> = {
    vmess: [
      'alpn',
      'skip-cert-verify',
      'fingerprint',
      'certificate',
      'private-key',
      'servername',
      'client-fingerprint',
      'ech-opts',
      'reality-opts',
      'tlsmirror-opts',
    ],
    vless: [
      'alpn',
      'skip-cert-verify',
      'fingerprint',
      'certificate',
      'private-key',
      'servername',
      'client-fingerprint',
      'ech-opts',
      'reality-opts',
    ],
    http: ['sni', 'skip-cert-verify', 'fingerprint', 'certificate', 'private-key'],
    socks5: ['skip-cert-verify', 'fingerprint', 'certificate', 'private-key'],
    'gost-relay': [
      'sni',
      'skip-cert-verify',
      'fingerprint',
      'certificate',
      'private-key',
      'client-fingerprint',
    ],
  };
  const dependentFields = fieldsByType[type];
  if (dependentFields !== undefined) {
    requireTlsForFields(proxy, index, undefined, dependentFields);
  }
}

function requireTlsForFields(
  value: Record<string, unknown>,
  index: number,
  prefix: string | undefined,
  dependentFields: readonly string[],
): void {
  if (value.tls !== true && dependentFields.some((field) => hasOwn(value, field))) {
    invalidProxyEntry(
      index,
      joinField(prefix, 'tls'),
      'must be true when TLS-only fields are present',
    );
  }
}

function validateTlsMirrorOptions(value: unknown, index: number, prefix: string): void {
  if (!isPlainRecord(value)) invalidProxyEntry(index, prefix, 'must be a plain object');
  rejectUnknownFields(value, TLS_MIRROR_FIELDS, index, prefix);
  requireNonEmptyString(value, 'primary-key', index, prefix);
  optionalBoolean(value, 'sequence-watermarking-enabled', index, prefix);
  if (hasOwn(value, 'explicit-nonce-ciphersuites')) {
    const suites = value['explicit-nonce-ciphersuites'];
    if (
      !Array.isArray(suites) ||
      suites.some(
        (suite) =>
          typeof suite !== 'number' || !Number.isInteger(suite) || suite < 0 || suite > 0xffff,
      )
    ) {
      invalidProxyEntry(index, `${prefix}.explicit-nonce-ciphersuites`, 'must be a uint16 array');
    }
  }
  if (hasOwn(value, 'defer-instance-derived-write-time')) {
    validateTlsMirrorTimeSpec(
      value['defer-instance-derived-write-time'],
      index,
      `${prefix}.defer-instance-derived-write-time`,
    );
  }
  if (hasOwn(value, 'transport-layer-padding')) {
    const padding = value['transport-layer-padding'];
    if (!isPlainRecord(padding)) {
      invalidProxyEntry(index, `${prefix}.transport-layer-padding`, 'must be a plain object');
    }
    rejectUnknownFields(padding, new Set(['enabled']), index, `${prefix}.transport-layer-padding`);
    optionalBoolean(padding, 'enabled', index, `${prefix}.transport-layer-padding`);
  }
  if (hasOwn(value, 'connection-enrolment')) {
    const enrolment = value['connection-enrolment'];
    if (!isPlainRecord(enrolment)) {
      invalidProxyEntry(index, `${prefix}.connection-enrolment`, 'must be a plain object');
    }
    rejectUnknownFields(
      enrolment,
      TLS_MIRROR_CONNECTION_ENROLMENT_FIELDS,
      index,
      `${prefix}.connection-enrolment`,
    );
    optionalString(enrolment, 'primary-ingress-outbound', index, `${prefix}.connection-enrolment`);
    optionalString(enrolment, 'primary-egress-outbound', index, `${prefix}.connection-enrolment`);
  }
  if (hasOwn(value, 'embedded-traffic-generator')) {
    validateTlsMirrorTrafficGenerator(
      value['embedded-traffic-generator'],
      index,
      `${prefix}.embedded-traffic-generator`,
    );
  }
}

function validateTlsMirrorTimeSpec(value: unknown, index: number, prefix: string): void {
  if (!isPlainRecord(value)) invalidProxyEntry(index, prefix, 'must be a plain object');
  rejectUnknownFields(value, TLS_MIRROR_TIME_SPEC_FIELDS, index, prefix);
  for (const field of TLS_MIRROR_TIME_SPEC_FIELDS) {
    if (!hasOwn(value, field)) continue;
    const item = value[field];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
      invalidProxyEntry(index, `${prefix}.${field}`, 'must be a non-negative safe integer');
    }
  }
}

function validateTlsMirrorTrafficGenerator(value: unknown, index: number, prefix: string): void {
  if (!isPlainRecord(value)) invalidProxyEntry(index, prefix, 'must be a plain object');
  rejectUnknownFields(value, new Set(['steps']), index, prefix);
  if (!hasOwn(value, 'steps')) return;
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.some((step) => !isPlainRecord(step))) {
    invalidProxyEntry(index, `${prefix}.steps`, 'must be an array of plain objects');
  }
  steps.forEach((step, stepIndex) => {
    const stepPrefix = `${prefix}.steps[${stepIndex}]`;
    rejectUnknownFields(step, TLS_MIRROR_STEP_FIELDS, index, stepPrefix);
    for (const field of ['name', 'host', 'path', 'method']) {
      optionalString(step, field, index, stepPrefix);
    }
    for (const field of [
      'connection-ready',
      'connection-recall-exit',
      'h2-do-not-wait-for-download-finish',
    ]) {
      optionalBoolean(step, field, index, stepPrefix);
    }
    if (hasOwn(step, 'wait-time')) {
      validateTlsMirrorTimeSpec(step['wait-time'], index, `${stepPrefix}.wait-time`);
    }
    validateTlsMirrorHeaders(step, index, stepPrefix);
    validateTlsMirrorNextSteps(step, index, stepPrefix);
  });
}

function validateTlsMirrorHeaders(
  step: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  if (!hasOwn(step, 'headers')) return;
  const headers = step.headers;
  if (!Array.isArray(headers) || headers.some((header) => !isPlainRecord(header))) {
    invalidProxyEntry(index, `${prefix}.headers`, 'must be an array of plain objects');
  }
  headers.forEach((header, headerIndex) => {
    const headerPrefix = `${prefix}.headers[${headerIndex}]`;
    rejectUnknownFields(header, TLS_MIRROR_HEADER_FIELDS, index, headerPrefix);
    optionalString(header, 'name', index, headerPrefix);
    optionalString(header, 'value', index, headerPrefix);
    validateStringArray(header, 'values', index, headerPrefix);
  });
}

function validateTlsMirrorNextSteps(
  step: Record<string, unknown>,
  index: number,
  prefix: string,
): void {
  if (!hasOwn(step, 'next-step')) return;
  const candidates = step['next-step'];
  if (!Array.isArray(candidates) || candidates.some((candidate) => !isPlainRecord(candidate))) {
    invalidProxyEntry(index, `${prefix}.next-step`, 'must be an array of plain objects');
  }
  candidates.forEach((candidate, candidateIndex) => {
    const candidatePrefix = `${prefix}.next-step[${candidateIndex}]`;
    rejectUnknownFields(candidate, TLS_MIRROR_NEXT_STEP_FIELDS, index, candidatePrefix);
    for (const field of ['weight', 'goto-location']) {
      if (!hasOwn(candidate, field)) continue;
      const item = candidate[field];
      if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
        invalidProxyEntry(index, `${candidatePrefix}.${field}`, 'must be a safe integer');
      }
      if (field === 'weight' && (item < -2_147_483_648 || item > 2_147_483_647)) {
        invalidProxyEntry(index, `${candidatePrefix}.weight`, 'must fit a signed 32-bit integer');
      }
    }
  });
}

function validateAlpn(proxy: Record<string, unknown>, index: number): void {
  if (!hasOwn(proxy, 'alpn')) return;
  const value = proxy.alpn;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((protocol) => typeof protocol !== 'string' || protocol.trim() === '')
  ) {
    invalidProxyEntry(index, 'alpn', 'must be a non-empty string array');
  }
}

function validateEndpoint(proxy: Record<string, unknown>, index: number): void {
  requireNonEmptyString(proxy, 'server', index);
  requirePort(proxy, 'port', index);
}

function validateHysteriaEndpoint(
  proxy: Record<string, unknown>,
  index: number,
  type: 'hysteria' | 'hysteria2',
): void {
  requireNonEmptyString(proxy, 'server', index);
  const hasPort = hasOwn(proxy, 'port');
  const hasPorts = hasOwn(proxy, 'ports');
  if (!hasPort && !hasPorts) {
    invalidProxyEntry(index, 'port', 'requires port or ports');
  }
  if (hasPort) requirePort(proxy, 'port', index);
  if (hasPorts) parseHysteriaPortSet(proxy, index, type);
}

function parseHysteriaPortSet(
  proxy: Record<string, unknown>,
  index: number,
  type: 'hysteria' | 'hysteria2',
): number {
  const value = requireNonEmptyString(proxy, 'ports', index);
  const segments = type === 'hysteria2' ? value.split(/[,/]/) : value.split(',');
  if (
    segments.some((segment) => segment === '' || segment !== segment.trim()) ||
    segments.length > 28
  ) {
    invalidProxyEntry(index, 'ports', 'must use a fixed Mihomo port/range list');
  }

  let count = 0;
  for (const segment of segments) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(segment);
    if (!match) {
      invalidProxyEntry(index, 'ports', 'must use a fixed Mihomo port/range list');
    }
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end > 65535 ||
      end < start
    ) {
      invalidProxyEntry(index, 'ports', 'must contain ascending ports from 1 through 65535');
    }
    count += end - start + 1;
  }
  return count;
}

function validateHysteriaPortBudget(proxies: Record<string, unknown>[]): void {
  // The candidate budget is per NODE, not shared across the list: providers
  // legitimately emit the same hop range on every node (8 × "20000-30000" is
  // an ordinary airport, not a resource attack), nothing here materialises
  // the expanded candidate list, and ascending-unique segments already bound
  // one node's arithmetic.
  proxies.forEach((proxy, index) => {
    if ((proxy.type !== 'hysteria' && proxy.type !== 'hysteria2') || !hasOwn(proxy, 'ports')) {
      return;
    }
    if (parseHysteriaPortSet(proxy, index, proxy.type) > MAX_HYSTERIA_PORT_CANDIDATES) {
      invalidProxyEntry(
        index,
        'ports',
        `expands the list beyond ${MAX_HYSTERIA_PORT_CANDIDATES} port candidates`,
      );
    }
  });
}

function validateMieruEndpoint(proxy: Record<string, unknown>, index: number): void {
  requireNonEmptyString(proxy, 'server', index);
  const hasPort = hasOwn(proxy, 'port');
  const hasPortRange = hasOwn(proxy, 'port-range');
  if (hasPort === hasPortRange) {
    invalidProxyEntry(index, 'port', 'must provide exactly one of port or port-range');
  }
  if (hasPort) {
    requirePort(proxy, 'port', index);
  } else {
    const portRange = requireNonEmptyString(proxy, 'port-range', index);
    if (!/^\d+-\d+$/.test(portRange)) {
      invalidProxyEntry(index, 'port-range', 'must be an inclusive numeric range');
    }
    const [start, end] = portRange.split('-').map(Number);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end > 65535 ||
      start > end
    ) {
      invalidProxyEntry(index, 'port-range', 'must contain ports from 1 through 65535');
    }
  }
}

function validateRematch(proxy: Record<string, unknown>, index: number): void {
  const rematchName = optionalNonEmptyString(proxy, 'target-rematch-name', index);
  const subRule = optionalNonEmptyString(proxy, 'target-sub-rule', index);
  if (rematchName === undefined && subRule === undefined) {
    invalidProxyEntry(
      index,
      'target-rematch-name',
      'requires target-rematch-name or target-sub-rule',
    );
  }
}

function validateTuicCredentials(proxy: Record<string, unknown>, index: number): void {
  const token = optionalNonEmptyString(proxy, 'token', index);
  const uuid = optionalNonEmptyString(proxy, 'uuid', index);
  const password = optionalNonEmptyString(proxy, 'password', index);
  if (token === undefined && (uuid === undefined || password === undefined)) {
    invalidProxyEntry(index, 'token', 'requires token or both uuid and password');
  }
  if (token !== undefined && (uuid !== undefined || password !== undefined)) {
    invalidProxyEntry(index, 'token', 'conflicts with the UUID/password credential dialect');
  }
  if (uuid !== undefined && !isCanonicalUuid(uuid)) {
    invalidProxyEntry(index, 'uuid', 'must be a canonical UUID');
  }
  const udpRelayMode = optionalString(proxy, 'udp-relay-mode', index);
  if (udpRelayMode !== undefined && !TUIC_UDP_RELAY_MODES.has(udpRelayMode)) {
    invalidProxyEntry(index, 'udp-relay-mode', 'must be quic or native');
  }
  const congestionController = optionalString(proxy, 'congestion-controller', index);
  if (
    congestionController !== undefined &&
    !TUIC_CONGESTION_CONTROLLERS.has(congestionController)
  ) {
    invalidProxyEntry(index, 'congestion-controller', 'is not implemented by fixed Mihomo');
  }
  for (const field of [
    'heartbeat-interval',
    'request-timeout',
    'max-udp-relay-packet-size',
    'max-open-streams',
    'cwnd',
    'recv-window-conn',
    'recv-window',
    'max-datagram-frame-size',
  ]) {
    const value = optionalNonNegativeInteger(proxy, field, index);
    if (
      (field === 'heartbeat-interval' || field === 'request-timeout') &&
      value !== undefined &&
      value > MAX_GO_DURATION_MILLISECONDS
    ) {
      invalidProxyEntry(index, field, 'would overflow fixed Mihomo duration');
    }
  }
  if (hasOwn(proxy, 'request-timeout') && token === undefined) {
    invalidProxyEntry(index, 'request-timeout', 'is only used by the TUIC token dialect');
  }
  const maxPacketSize = proxy['max-udp-relay-packet-size'];
  if (typeof maxPacketSize === 'number' && (maxPacketSize < 1 || maxPacketSize > 1400)) {
    invalidProxyEntry(index, 'max-udp-relay-packet-size', 'must be from 1 through 1400');
  }
  const maxDatagramSize = proxy['max-datagram-frame-size'];
  if (typeof maxDatagramSize === 'number' && (maxDatagramSize < 64 || maxDatagramSize > 1400)) {
    invalidProxyEntry(index, 'max-datagram-frame-size', 'must be from 64 through 1400');
  }
  if (hasOwn(proxy, 'udp-over-stream-version')) {
    const version = proxy['udp-over-stream-version'];
    if (version !== 1 && version !== 2) {
      invalidProxyEntry(index, 'udp-over-stream-version', 'must be fixed UOT version 1 or 2');
    }
    if (proxy['udp-over-stream'] !== true) {
      invalidProxyEntry(index, 'udp-over-stream-version', 'requires udp-over-stream');
    }
  }
}

function validateAnyTls(proxy: Record<string, unknown>, index: number): void {
  validateDurationSeconds(proxy, 'idle-session-check-interval', index);
  validateDurationSeconds(proxy, 'idle-session-timeout', index);
  const minIdleSessions = optionalNonNegativeInteger(proxy, 'min-idle-session', index);
  if (minIdleSessions !== undefined && minIdleSessions > MAX_ANYTLS_IDLE_SESSIONS) {
    invalidProxyEntry(index, 'min-idle-session', `must not exceed ${MAX_ANYTLS_IDLE_SESSIONS}`);
  }
}

function validateRemoteDnsOptions(proxy: Record<string, unknown>, index: number): void {
  const hasDns = hasOwn(proxy, 'dns');
  const remoteDnsResolve = proxy['remote-dns-resolve'] === true;
  if (hasDns !== remoteDnsResolve) {
    invalidProxyEntry(
      index,
      hasDns ? 'remote-dns-resolve' : 'dns',
      'must enable remote-dns-resolve together with a non-empty dns list',
    );
  }
  if (!hasDns) return;

  const servers = proxy.dns;
  if (!Array.isArray(servers) || servers.length === 0) {
    invalidProxyEntry(index, 'dns', 'must be a non-empty string array');
  }
  servers.forEach((server, serverIndex) => {
    const field = `dns[${serverIndex}]`;
    if (typeof server !== 'string') {
      invalidProxyEntry(index, field, 'must be a string');
    }
    validateMihomoDnsNameServer(server, index, field);
  });
}

function validateMihomoDnsNameServer(server: string, index: number, field: string): void {
  if (!/^[\x21-\x7e]+$/u.test(server) || server.includes('\\') || server.includes('%')) {
    invalidProxyEntry(index, field, 'must use conservative fixed Mihomo nameserver syntax');
  }
  if (server === 'system') return;

  const schemeMatch = DNS_SERVER_SCHEME_PATTERN.exec(server);
  if (schemeMatch === null) {
    if (isIP(server) === 6) return;
    validateDnsServerAuthority(server, index, field);
    return;
  }

  const [, scheme, target] = schemeMatch;
  if (MIHOMO_DNS_NETWORK_SCHEMES.has(scheme)) {
    validateDnsNetworkNameServer(scheme, target, index, field);
    return;
  }
  if (scheme === 'system') {
    if (target !== '') invalidDnsNameServer(index, field);
    return;
  }
  if (scheme === 'ts' || scheme === 'tailscale' || scheme === 'dhcp') {
    if (!DNS_SAFE_NAME_PATTERN.test(target)) invalidDnsNameServer(index, field);
    return;
  }
  if (scheme === 'rcode') {
    if (!MIHOMO_DNS_RCODE_TYPES.has(target)) invalidDnsNameServer(index, field);
    return;
  }
  invalidDnsNameServer(index, field);
}

function validateDnsNetworkNameServer(
  scheme: string,
  target: string,
  index: number,
  field: string,
): void {
  if (
    target.includes('?') ||
    target.includes('#') ||
    target.includes('@') ||
    target.includes('\\')
  ) {
    invalidDnsNameServer(index, field);
  }

  const slashIndex = target.indexOf('/');
  const authority = slashIndex === -1 ? target : target.slice(0, slashIndex);
  const path = slashIndex === -1 ? '' : target.slice(slashIndex);
  validateDnsServerAuthority(authority, index, field);

  if (scheme !== 'http' && scheme !== 'https') {
    if (path !== '') invalidDnsNameServer(index, field);
    return;
  }
  if (
    path !== '' &&
    (!DNS_HTTP_PATH_PATTERN.test(path) ||
      path.includes('//') ||
      path.split('/').some((segment) => segment === '.' || segment === '..'))
  ) {
    invalidDnsNameServer(index, field);
  }
}

function validateDnsServerAuthority(authority: string, index: number, field: string): void {
  if (authority === '') invalidDnsNameServer(index, field);

  let host: string;
  let port: string | undefined;
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    if (closingBracket === -1) invalidDnsNameServer(index, field);
    host = authority.slice(1, closingBracket);
    const remainder = authority.slice(closingBracket + 1);
    if (remainder !== '') {
      if (!remainder.startsWith(':')) invalidDnsNameServer(index, field);
      port = remainder.slice(1);
    }
    if (isIP(host) !== 6) invalidDnsNameServer(index, field);
  } else {
    const firstColon = authority.indexOf(':');
    const lastColon = authority.lastIndexOf(':');
    if (firstColon !== lastColon) invalidDnsNameServer(index, field);
    if (firstColon === -1) {
      host = authority;
    } else {
      host = authority.slice(0, firstColon);
      port = authority.slice(firstColon + 1);
    }
    if (!isValidDnsServerHost(host)) invalidDnsNameServer(index, field);
  }

  if (port !== undefined) {
    if (!/^\d{1,5}$/u.test(port)) invalidDnsNameServer(index, field);
    const numericPort = Number(port);
    if (numericPort < 1 || numericPort > 65_535) invalidDnsNameServer(index, field);
  }
}

function isValidDnsServerHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  const withoutTrailingDot = host.endsWith('.') ? host.slice(0, -1) : host;
  if (
    withoutTrailingDot === '' ||
    withoutTrailingDot.length > 253 ||
    /^[0-9.]+$/u.test(withoutTrailingDot)
  ) {
    return false;
  }
  return withoutTrailingDot.split('.').every((label) => DNS_HOST_LABEL_PATTERN.test(label));
}

function invalidDnsNameServer(index: number, field: string): never {
  invalidProxyEntry(index, field, 'must use conservative fixed Mihomo nameserver syntax');
}

function validateOpenVpn(proxy: Record<string, unknown>, index: number): void {
  const proto = optionalString(proxy, 'proto', index);
  if (proto !== undefined && !OPENVPN_PROTOS.has(proto)) {
    invalidProxyEntry(index, 'proto', 'is not supported by fixed Mihomo OpenVPN');
  }
  const dev = optionalString(proxy, 'dev', index);
  if (dev !== undefined && dev !== '' && dev !== 'tun') {
    invalidProxyEntry(index, 'dev', 'must be empty or tun');
  }
  const cipher = optionalString(proxy, 'cipher', index);
  if (cipher !== undefined && !OPENVPN_CIPHERS.has(cipher.toUpperCase())) {
    invalidProxyEntry(index, 'cipher', 'is not supported by fixed Mihomo OpenVPN');
  }
  const auth = optionalString(proxy, 'auth', index);
  if (auth !== undefined && !OPENVPN_AUTHS.has(auth.toUpperCase())) {
    invalidProxyEntry(index, 'auth', 'is not supported by fixed Mihomo OpenVPN');
  }
  const compLzo = optionalString(proxy, 'comp-lzo', index);
  if (compLzo !== undefined && !OPENVPN_COMP_LZO.has(compLzo.toLowerCase())) {
    invalidProxyEntry(index, 'comp-lzo', 'is not supported by fixed Mihomo OpenVPN');
  }

  validateInlinePemBlock(proxy.ca, index, 'ca', 'CERTIFICATE');
  const hasCert = hasOwn(proxy, 'cert') && proxy.cert !== '';
  const hasKey = hasOwn(proxy, 'key') && proxy.key !== '';
  if (hasCert !== hasKey) {
    invalidProxyEntry(index, hasCert ? 'key' : 'cert', 'must be paired with cert and key');
  }
  if (hasCert && hasKey) {
    validateInlinePemBlock(proxy.cert, index, 'cert', 'CERTIFICATE');
    validateInlinePemBlock(proxy.key, index, 'key', 'PRIVATE KEY');
  } else {
    requireNonEmptyString(proxy, 'username', index);
  }

  if (hasOwn(proxy, 'tls-crypt')) {
    const tlsCrypt = optionalString(proxy, 'tls-crypt', index) ?? '';
    const encoded = tlsCrypt
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== '' &&
          !line.startsWith('#') &&
          !line.startsWith('-----BEGIN OpenVPN Static key') &&
          !line.startsWith('-----END OpenVPN Static key'),
      )
      .join('');
    if (!/^[0-9a-fA-F]{512}$/u.test(encoded)) {
      invalidProxyEntry(index, 'tls-crypt', 'must contain exactly 256 bytes of hexadecimal key');
    }
  }

  validateDurationSeconds(proxy, 'handshake-timeout', index);
  validateDurationSeconds(proxy, 'ping', index);
  validateDurationSeconds(proxy, 'ping-restart', index);
  if (hasOwn(proxy, 'mtu')) {
    const mtu = optionalNonNegativeInteger(proxy, 'mtu', index);
    if (mtu !== undefined && mtu > 65_535) {
      invalidProxyEntry(index, 'mtu', 'must not exceed 65535');
    }
  }

  validateRemoteDnsOptions(proxy, index);
}

function validateInlinePemBlock(
  value: unknown,
  index: number,
  field: string,
  requiredLabel: string,
): void {
  if (typeof value !== 'string') invalidProxyEntry(index, field, 'must be inline PEM material');
  const trimmed = value.trim();
  const match =
    /^-----BEGIN ([^-\r\n]+)-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END \1-----$/u.exec(trimmed);
  if (match === null || !match[1].includes(requiredLabel)) {
    invalidProxyEntry(index, field, 'must be inline PEM material');
  }
  const base64 = match[2].replace(/\s/gu, '');
  if (!isCanonicalStandardBase64(base64) || Buffer.from(base64, 'base64').length === 0) {
    invalidProxyEntry(index, field, 'must be inline PEM material');
  }
}

function validateDurationSeconds(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): void {
  const value = optionalNonNegativeInteger(proxy, field, index, prefix);
  if (value !== undefined && value > MAX_GO_DURATION_SECONDS) {
    invalidProxyEntry(index, joinField(prefix, field), 'would overflow fixed Mihomo duration');
  }
}

function validateHysteria2(proxy: Record<string, unknown>, index: number): void {
  validateHysteriaFingerprint(proxy, index);
  if (hasOwn(proxy, 'hop-interval')) {
    if (!hasOwn(proxy, 'ports')) {
      invalidProxyEntry(index, 'hop-interval', 'requires ports');
    }
    validateUnsignedRangeString(proxy, 'hop-interval', index, BigInt(MAX_GO_DURATION_SECONDS));
  }
  for (const field of ['obfs-min-packet-size', 'obfs-max-packet-size', 'cwnd', 'udp-mtu']) {
    optionalNonNegativeInteger(proxy, field, index);
  }
  for (const field of ['up', 'down']) {
    if (hasOwn(proxy, field)) validateHysteriaSpeed(proxy, field, index);
  }
  const obfs = optionalNonEmptyString(proxy, 'obfs', index);
  const obfsPassword = optionalNonEmptyString(proxy, 'obfs-password', index);
  if (obfs !== undefined && obfs !== 'salamander' && obfs !== 'gecko') {
    invalidProxyEntry(index, 'obfs', 'must be salamander or gecko');
  }
  if (obfs !== undefined && obfsPassword === undefined) {
    invalidProxyEntry(index, 'obfs-password', 'is required when obfs is enabled');
  }
  if (obfs === undefined && obfsPassword !== undefined) {
    invalidProxyEntry(index, 'obfs-password', 'requires an obfs type');
  }
  if (hasOwn(proxy, 'realm-opts')) {
    validateHysteria2RealmOptions(proxy['realm-opts'], index);
  }
}

function validateHysteria2RealmOptions(value: unknown, index: number): void {
  const prefix = 'realm-opts';
  if (!isPlainRecord(value)) invalidProxyEntry(index, prefix, 'must be a plain object');
  rejectUnknownFields(value, HYSTERIA2_REALM_FIELDS, index, prefix);
  optionalBoolean(value, 'enable', index, prefix);
  optionalBoolean(value, 'skip-cert-verify', index, prefix);
  for (const field of [
    'server-url',
    'token',
    'realm-id',
    'sni',
    'fingerprint',
    'certificate',
    'private-key',
  ]) {
    optionalString(value, field, index, prefix);
  }
  validateStringArray(value, 'stun-servers', index, prefix);
  validateStringArray(value, 'alpn', index, prefix);
  const detailFields = [...HYSTERIA2_REALM_FIELDS].filter((field) => field !== 'enable');
  if (value.enable === true) {
    requireNonEmptyString(value, 'server-url', index, prefix);
  } else if (detailFields.some((field) => hasOwn(value, field))) {
    invalidProxyEntry(index, `${prefix}.enable`, 'must be true when realm details are present');
  }
}

function validateHysteria(proxy: Record<string, unknown>, index: number): void {
  validateHysteriaFingerprint(proxy, index);
  validateHysteriaSpeed(proxy, 'up', index);
  validateHysteriaSpeed(proxy, 'down', index);

  const protocol = optionalNonEmptyString(proxy, 'protocol', index);
  const obfsProtocol = optionalNonEmptyString(proxy, 'obfs-protocol', index);
  if (protocol !== undefined && obfsProtocol !== undefined) {
    invalidProxyEntry(index, 'obfs-protocol', 'conflicts with protocol');
  }
  const selectedProtocol = obfsProtocol ?? protocol;
  if (selectedProtocol !== undefined && !HYSTERIA_PROTOCOLS.has(selectedProtocol)) {
    invalidProxyEntry(
      index,
      protocol === undefined ? 'obfs-protocol' : 'protocol',
      'is not supported',
    );
  }

  for (const field of [
    'up-speed',
    'down-speed',
    'recv-window-conn',
    'recv-window',
    'hop-interval',
  ]) {
    if (hasOwn(proxy, field)) {
      const value = optionalNonNegativeInteger(proxy, field, index);
      if (field === 'hop-interval' && value !== undefined && value > MAX_GO_DURATION_SECONDS) {
        invalidProxyEntry(index, field, 'would overflow fixed Mihomo duration');
      }
    }
  }

  const auth = optionalNonEmptyString(proxy, 'auth', index);
  const authString = optionalNonEmptyString(proxy, 'auth-str', index);
  if (auth !== undefined && authString !== undefined) {
    invalidProxyEntry(index, 'auth', 'conflicts with auth-str');
  }
  if (auth !== undefined && !isCanonicalStandardBase64(auth)) {
    invalidProxyEntry(index, 'auth', 'must be canonical standard Base64');
  }
}

function validateHysteriaFingerprint(proxy: Record<string, unknown>, index: number): void {
  const fingerprint = optionalNonEmptyString(proxy, 'fingerprint', index);
  if (fingerprint === undefined) return;
  const normalized = fingerprint.replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    invalidProxyEntry(index, 'fingerprint', 'must be a 32-byte hexadecimal digest');
  }
  proxy.fingerprint = normalized;
}

function validateHysteriaSpeed(proxy: Record<string, unknown>, field: string, index: number): void {
  const value = requireNonEmptyString(proxy, field, index);
  const match = /^(\d+)(?:\s*([KMGT]?)([Bb])ps)?$/.exec(value);
  if (!match) invalidProxyEntry(index, field, 'must use fixed Mihomo bandwidth syntax');
  if (match[1].length > 20) {
    invalidProxyEntry(index, field, 'must fit fixed Mihomo uint64 bandwidth arithmetic');
  }

  const factors: Readonly<Record<string, bigint>> = {
    '': BigInt(1),
    K: BigInt(1_000),
    M: BigInt(1_000_000),
    G: BigInt(1_000_000_000),
    T: BigInt(1_000_000_000_000),
  };
  let bytesPerSecond = BigInt(match[1]) * (match[2] === undefined ? factors.M : factors[match[2]]);
  if (match[3] === 'b') bytesPerSecond /= BigInt(8);
  if (bytesPerSecond <= BigInt(0) || bytesPerSecond > BigInt('18446744073709551615')) {
    invalidProxyEntry(index, field, 'must be a positive fixed Mihomo bandwidth');
  }
}

function validateUnsignedRangeString(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  maximum = BigInt('18446744073709551615'),
): void {
  const value = requireNonEmptyString(proxy, field, index);
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) invalidProxyEntry(index, field, 'must be an unsigned integer or range');
  if (match[1].length > 20 || (match[2] !== undefined && match[2].length > 20)) {
    invalidProxyEntry(index, field, 'must fit a uint64 range');
  }
  const start = BigInt(match[1]);
  const end = BigInt(match[2] ?? match[1]);
  if (end < start || end > maximum) {
    invalidProxyEntry(index, field, 'must be an ascending uint64 range');
  }
}

function isCanonicalStandardBase64(value: string): boolean {
  return (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function validateSnell(proxy: Record<string, unknown>, index: number): void {
  let version = 1;
  if (hasOwn(proxy, 'version')) {
    version = proxy.version as number;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 5) {
      invalidProxyEntry(index, 'version', 'must be an integer from 1 through 5');
    }
  }
  if ((version === 1 || version === 2) && proxy.udp === true) {
    invalidProxyEntry(index, 'udp', `is not supported by Snell version ${version}`);
  }
  if (hasOwn(proxy, 'obfs-opts')) {
    const options = proxy['obfs-opts'];
    if (!isPlainRecord(options)) {
      invalidProxyEntry(index, 'obfs-opts', 'must be a plain object');
    }
    const mode = optionalString(options, 'mode', index, 'obfs-opts') ?? '';
    if (mode === 'shadow-tls') {
      validateShadowTlsOptions(options, index, 'obfs-opts', true);
    } else {
      rejectUnknownFields(options, SIMPLE_OBFS_FIELDS, index, 'obfs-opts');
      optionalString(options, 'host', index, 'obfs-opts');
      if (mode !== '' && mode !== 'tls' && mode !== 'http') {
        invalidProxyEntry(index, 'obfs-opts.mode', 'must be tls, http, or shadow-tls');
      }
    }
  }
}

function validateSsh(
  proxy: Record<string, unknown>,
  index: number,
  allowLocalFileReferences: boolean,
): void {
  requireNonEmptyString(proxy, 'username', index);
  const password = optionalNonEmptyString(proxy, 'password', index);
  const privateKey = optionalNonEmptyString(proxy, 'private-key', index);
  if (password === undefined && privateKey === undefined) {
    invalidProxyEntry(index, 'password', 'requires password or private-key authentication');
  }
  if (
    privateKey !== undefined &&
    !allowLocalFileReferences &&
    !privateKey.includes('PRIVATE KEY')
  ) {
    invalidProxyEntry(index, 'private-key', 'must be inline key material, not a filesystem path');
  }
}

function validateMieru(proxy: Record<string, unknown>, index: number): void {
  const transport = requireNonEmptyString(proxy, 'transport', index);
  if (transport !== 'TCP' && transport !== 'UDP') {
    invalidProxyEntry(index, 'transport', 'must be TCP or UDP');
  }
  requireNonEmptyString(proxy, 'username', index);
  requireNonEmptyString(proxy, 'password', index);
  const multiplexing = optionalString(proxy, 'multiplexing', index);
  if (multiplexing !== undefined && !MIERU_MULTIPLEXING_LEVELS.has(multiplexing)) {
    invalidProxyEntry(index, 'multiplexing', 'is not supported by fixed Mihomo Mieru');
  }
  const handshakeMode = optionalString(proxy, 'handshake-mode', index);
  if (handshakeMode !== undefined && !MIERU_HANDSHAKE_MODES.has(handshakeMode)) {
    invalidProxyEntry(index, 'handshake-mode', 'is not supported by fixed Mihomo Mieru');
  }
  const trafficPattern = optionalString(proxy, 'traffic-pattern', index);
  if (trafficPattern !== undefined && trafficPattern !== '') {
    validateMieruTrafficPattern(trafficPattern, index);
  }
}

interface ProtoField {
  number: number;
  wire: number;
  value: bigint | Uint8Array;
}

function validateMieruTrafficPattern(encoded: string, index: number): void {
  if (!isCanonicalStandardBase64(encoded)) {
    invalidProxyEntry(index, 'traffic-pattern', 'must be canonical standard Base64 protobuf');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_MIERU_TRAFFIC_PATTERN_BYTES) {
    invalidProxyEntry(index, 'traffic-pattern', 'exceeds the bounded protobuf size');
  }
  let fields: ProtoField[];
  try {
    fields = decodeProtoFields(bytes);
    rejectDuplicateOrUnknownProtoFields(fields, new Set([1, 2, 3, 4, 5]), new Set());
    for (const field of fields) {
      if (field.number <= 2) requireProtoWire(field, 0);
      if (field.number === 3) validateMieruTcpFragment(requireProtoBytes(field));
      if (field.number === 4) validateMieruNoncePattern(requireProtoBytes(field));
      if (field.number === 5) validateMieruPaddingPattern(requireProtoBytes(field));
    }
  } catch {
    invalidProxyEntry(index, 'traffic-pattern', 'is not a valid fixed Mieru traffic pattern');
  }
}

function validateMieruTcpFragment(bytes: Uint8Array): void {
  const fields = decodeProtoFields(bytes);
  rejectDuplicateOrUnknownProtoFields(fields, new Set([1, 2]), new Set());
  for (const field of fields) {
    requireProtoWire(field, 0);
    if (field.number === 2) {
      const value = protoInt32(field.value as bigint);
      if (value < 0 || value > 100) throw new Error('invalid max sleep');
    }
  }
}

function validateMieruNoncePattern(bytes: Uint8Array): void {
  const fields = decodeProtoFields(bytes);
  rejectDuplicateOrUnknownProtoFields(fields, new Set([1, 2, 3, 4, 5]), new Set([5]));
  let minLength: number | undefined;
  let maxLength: number | undefined;
  for (const field of fields) {
    if (field.number <= 4) {
      requireProtoWire(field, 0);
      if (field.number === 3) minLength = protoInt32(field.value as bigint);
      if (field.number === 4) maxLength = protoInt32(field.value as bigint);
    } else {
      const value = decodeCanonicalUtf8(requireProtoBytes(field));
      if (!/^(?:[0-9a-fA-F]{2}){0,12}$/u.test(value)) throw new Error('invalid nonce hex');
    }
  }
  if (
    (minLength !== undefined && (minLength < 0 || minLength > 12)) ||
    (maxLength !== undefined && (maxLength < 0 || maxLength > 12)) ||
    (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
  ) {
    throw new Error('invalid nonce length');
  }
}

function validateMieruPaddingPattern(bytes: Uint8Array): void {
  const fields = decodeProtoFields(bytes);
  rejectDuplicateOrUnknownProtoFields(fields, new Set([1, 2]), new Set());
  for (const field of fields) {
    requireProtoWire(field, 0);
    const value = protoInt32(field.value as bigint);
    if (value < 0 || value > 255) throw new Error('invalid padding length');
  }
}

function decodeProtoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  const readVarint = (): bigint => {
    let result = BigInt(0);
    for (let byteIndex = 0; byteIndex < 10; byteIndex += 1) {
      if (offset >= bytes.length) throw new Error('truncated varint');
      const byte = bytes[offset++];
      if (byteIndex === 9 && byte > 1) throw new Error('varint overflow');
      result |= BigInt(byte & 0x7f) << BigInt(byteIndex * 7);
      if ((byte & 0x80) === 0) return result;
    }
    throw new Error('varint overflow');
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    const number = Number(tag >> BigInt(3));
    const wire = Number(tag & BigInt(7));
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid field number');
    if (wire === 0) {
      fields.push({ number, wire, value: readVarint() });
    } else if (wire === 2) {
      const length = Number(readVarint());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
        throw new Error('invalid field length');
      }
      fields.push({ number, wire, value: bytes.slice(offset, offset + length) });
      offset += length;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw new Error('truncated fixed64');
      offset += 8;
      fields.push({ number, wire, value: BigInt(0) });
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) throw new Error('truncated fixed32');
      offset += 4;
      fields.push({ number, wire, value: BigInt(0) });
    } else {
      throw new Error('unsupported wire type');
    }
  }
  return fields;
}

function rejectDuplicateOrUnknownProtoFields(
  fields: ProtoField[],
  allowed: ReadonlySet<number>,
  repeated: ReadonlySet<number>,
): void {
  const seen = new Set<number>();
  for (const field of fields) {
    if (!allowed.has(field.number) || (seen.has(field.number) && !repeated.has(field.number))) {
      throw new Error('unknown or duplicate protobuf field');
    }
    seen.add(field.number);
  }
}

function requireProtoWire(field: ProtoField, wire: number): void {
  if (field.wire !== wire) throw new Error('wrong protobuf wire type');
}

function requireProtoBytes(field: ProtoField): Uint8Array {
  requireProtoWire(field, 2);
  if (!(field.value instanceof Uint8Array)) throw new Error('expected protobuf bytes');
  return field.value;
}

function protoInt32(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

function decodeCanonicalUtf8(value: Uint8Array): string {
  const decoded = Buffer.from(value).toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(Buffer.from(value))) throw new Error('invalid UTF-8');
  return decoded;
}

function validateSudoku(proxy: Record<string, unknown>, index: number): void {
  for (const field of ['padding-min', 'padding-max']) {
    const value = optionalNonNegativeInteger(proxy, field, index);
    if (value !== undefined && value > 100) {
      invalidProxyEntry(index, field, 'must be from 0 through 100');
    }
  }
  if (
    typeof proxy['padding-min'] === 'number' &&
    typeof proxy['padding-max'] === 'number' &&
    proxy['padding-min'] > proxy['padding-max']
  ) {
    invalidProxyEntry(index, 'padding-min', 'must not exceed padding-max');
  }
  const aeadMethod = optionalString(proxy, 'aead-method', index);
  if (aeadMethod !== undefined && !SUDOKU_AEAD_METHODS.has(aeadMethod)) {
    invalidProxyEntry(index, 'aead-method', 'is not supported by fixed Mihomo Sudoku');
  }
  const tableType = optionalString(proxy, 'table-type', index);
  if (tableType !== undefined && !SUDOKU_TABLE_TYPES.has(tableType)) {
    invalidProxyEntry(index, 'table-type', 'is not supported by fixed Mihomo Sudoku');
  }
  validateSudokuHttpMaskMode(proxy, 'http-mask-mode', index);
  validateSudokuHttpMaskMultiplex(proxy, 'http-mask-multiplex', index);
  validateSudokuPathRoot(proxy, 'path-root', index);
  const customTable = optionalString(proxy, 'custom-table', index);
  if (customTable !== undefined && customTable !== '') {
    validateSudokuCustomTable(customTable, index, 'custom-table');
  }
  if (hasOwn(proxy, 'custom-tables')) {
    const tables = proxy['custom-tables'] as string[];
    if (tables.length === 0 || tables.length > MAX_SUDOKU_CUSTOM_TABLES) {
      invalidProxyEntry(index, 'custom-tables', 'must be a bounded non-empty string array');
    }
    tables.forEach((table) => validateSudokuCustomTable(table, index, 'custom-tables'));
    if (customTable !== undefined && customTable !== '') {
      invalidProxyEntry(index, 'custom-table', 'conflicts with custom-tables');
    }
  }
  if (hasOwn(proxy, 'httpmask')) {
    const options = proxy.httpmask;
    if (!isPlainRecord(options)) {
      invalidProxyEntry(index, 'httpmask', 'must be a plain object');
    }
    rejectUnknownFields(options, SUDOKU_HTTP_MASK_FIELDS, index, 'httpmask');
    optionalBoolean(options, 'disable', index, 'httpmask');
    optionalBoolean(options, 'tls', index, 'httpmask');
    for (const field of ['mode', 'host', 'path-root', 'multiplex']) {
      optionalString(options, field, index, 'httpmask');
    }
    validateSudokuHttpMaskMode(options, 'mode', index, 'httpmask');
    validateSudokuHttpMaskMultiplex(options, 'multiplex', index, 'httpmask');
    validateSudokuPathRoot(options, 'path-root', index, 'httpmask');
  }
}

function validateSudokuHttpMaskMode(
  value: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): void {
  const mode = optionalString(value, field, index, prefix);
  if (mode !== undefined && !SUDOKU_HTTP_MASK_MODES.has(mode)) {
    invalidProxyEntry(index, joinField(prefix, field), 'is not a fixed Sudoku HTTP mask mode');
  }
}

function validateSudokuHttpMaskMultiplex(
  value: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): void {
  const mode = optionalString(value, field, index, prefix);
  if (mode !== undefined && !SUDOKU_HTTP_MASK_MULTIPLEX.has(mode)) {
    invalidProxyEntry(index, joinField(prefix, field), 'is not a fixed Sudoku multiplex mode');
  }
}

function validateSudokuPathRoot(
  value: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): void {
  const pathRoot = optionalString(value, field, index, prefix);
  if (pathRoot === undefined || pathRoot.trim() === '') return;
  const segment = pathRoot.trim().replace(/^\/+|\/+$/gu, '');
  if (segment === '' || !/^[A-Za-z0-9_-]+$/u.test(segment)) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be one safe path segment');
  }
}

function validateSudokuCustomTable(value: string, index: number, field: string): void {
  const normalized = value.trim().replaceAll(' ', '').toLowerCase();
  if (
    normalized.length !== 8 ||
    !/^[xpv]+$/u.test(normalized) ||
    [...normalized].filter((character) => character === 'x').length !== 2 ||
    [...normalized].filter((character) => character === 'p').length !== 2 ||
    [...normalized].filter((character) => character === 'v').length !== 4
  ) {
    invalidProxyEntry(index, field, 'must contain exactly 2 x, 2 p, and 4 v symbols');
  }
}

function validateMasque(proxy: Record<string, unknown>, index: number): void {
  validateDurationSeconds(proxy, 'handshake-timeout', index);
  const network = optionalString(proxy, 'network', index);
  if (network !== undefined && !MASQUE_NETWORKS.has(network)) {
    invalidProxyEntry(index, 'network', 'is not implemented by fixed Mihomo MASQUE');
  }
  const congestionController = optionalString(proxy, 'congestion-controller', index);
  if (
    congestionController !== undefined &&
    !TUIC_CONGESTION_CONTROLLERS.has(congestionController)
  ) {
    invalidProxyEntry(index, 'congestion-controller', 'is not implemented by fixed Mihomo');
  }
  if (
    network === 'h2' &&
    ['congestion-controller', 'cwnd', 'bbr-profile'].some((field) => hasOwn(proxy, field))
  ) {
    invalidProxyEntry(index, 'network', 'must use a QUIC mode when QUIC-only fields are present');
  }
  optionalNonNegativeInteger(proxy, 'cwnd', index);
  if (hasOwn(proxy, 'mtu')) {
    const mtu = optionalNonNegativeInteger(proxy, 'mtu', index);
    if (mtu === undefined || mtu < 1 || mtu > 65_535) {
      invalidProxyEntry(index, 'mtu', 'must be an integer from 1 through 65535');
    }
  }
  validateMasqueEcKey(proxy, 'private-key', index, 'private');
  validateMasqueEcKey(proxy, 'public-key', index, 'public');
  const ip = optionalNonEmptyString(proxy, 'ip', index);
  const ipv6 = optionalNonEmptyString(proxy, 'ipv6', index);
  if (ip === undefined && ipv6 === undefined) {
    invalidProxyEntry(index, 'ip', 'requires ip or ipv6');
  }
  if (ip !== undefined) validateIpPrefix(ip, 4, index, 'ip');
  if (ipv6 !== undefined) validateIpPrefix(ipv6, 6, index, 'ipv6');
  validateRemoteDnsOptions(proxy, index);
}

function validateTrustTunnel(proxy: Record<string, unknown>, index: number): void {
  const congestionController = optionalString(proxy, 'congestion-controller', index);
  if (
    congestionController !== undefined &&
    !TUIC_CONGESTION_CONTROLLERS.has(congestionController)
  ) {
    invalidProxyEntry(index, 'congestion-controller', 'is not implemented by fixed Mihomo');
  }
  if (
    proxy.quic !== true &&
    ['congestion-controller', 'cwnd', 'bbr-profile'].some((field) => hasOwn(proxy, field))
  ) {
    invalidProxyEntry(index, 'quic', 'must be true when QUIC-only fields are present');
  }
  const maxConnections = optionalNonNegativeInteger(proxy, 'max-connections', index) ?? 0;
  const minStreams = optionalNonNegativeInteger(proxy, 'min-streams', index) ?? 0;
  const maxStreams = optionalNonNegativeInteger(proxy, 'max-streams', index) ?? 0;
  optionalNonNegativeInteger(proxy, 'cwnd', index);
  if (maxStreams > 0 && (maxConnections > 0 || minStreams > 0)) {
    invalidProxyEntry(index, 'max-streams', 'conflicts with connection-based mux controls');
  }
  if (minStreams > 0 && maxConnections === 0) {
    invalidProxyEntry(index, 'min-streams', 'requires max-connections');
  }
}

function validateMasqueEcKey(
  proxy: Record<string, unknown>,
  field: 'private-key' | 'public-key',
  index: number,
  kind: 'private' | 'public',
): void {
  const value = requireNonEmptyString(proxy, field, index);
  let valid = false;
  if (isCanonicalStandardBase64(value)) {
    const der = Buffer.from(value, 'base64');
    try {
      if (kind === 'private') {
        const key = createPrivateKey({ key: der, format: 'der', type: 'sec1' });
        const exported = key.export({ format: 'der', type: 'sec1' });
        valid = key.asymmetricKeyType === 'ec' && Buffer.isBuffer(exported) && exported.equals(der);
      } else {
        const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
        const exported = key.export({ format: 'der', type: 'spki' });
        valid = key.asymmetricKeyType === 'ec' && Buffer.isBuffer(exported) && exported.equals(der);
      }
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    invalidProxyEntry(
      index,
      field,
      kind === 'private'
        ? 'must be canonical Base64 DER SEC1 EC key material'
        : 'must be canonical Base64 DER SPKI ECDSA key material',
    );
  }
}

function validateWireGuard(proxy: Record<string, unknown>, index: number): void {
  requireWireGuardKey(proxy, 'private-key', index);
  const workers = optionalNonNegativeInteger(proxy, 'workers', index);
  if (workers !== undefined && workers > MAX_WIREGUARD_WORKERS) {
    invalidProxyEntry(index, 'workers', `must not exceed ${MAX_WIREGUARD_WORKERS}`);
  }
  if (hasOwn(proxy, 'mtu')) {
    const mtu = optionalNonNegativeInteger(proxy, 'mtu', index);
    if (mtu === undefined || mtu < 1 || mtu > 65_535) {
      invalidProxyEntry(index, 'mtu', 'must be an integer from 1 through 65535');
    }
  }
  const persistentKeepalive = optionalNonNegativeInteger(proxy, 'persistent-keepalive', index);
  if (persistentKeepalive !== undefined && persistentKeepalive > 65_535) {
    invalidProxyEntry(index, 'persistent-keepalive', 'must not exceed 65535 seconds');
  }
  validateDurationSeconds(proxy, 'refresh-server-ip-interval', index);
  if (hasOwn(proxy, 'amnezia-wg-option')) {
    validateAmneziaWireGuardOptions(proxy['amnezia-wg-option'], index);
  }
  const ip = optionalNonEmptyString(proxy, 'ip', index);
  const ipv6 = optionalNonEmptyString(proxy, 'ipv6', index);
  if (ip === undefined && ipv6 === undefined) {
    invalidProxyEntry(index, 'ip', 'requires ip or ipv6');
  }
  if (ip !== undefined) validateIpPrefix(ip, 4, index, 'ip');
  if (ipv6 !== undefined) validateIpPrefix(ipv6, 6, index, 'ipv6');
  validateRemoteDnsOptions(proxy, index);

  if (!hasOwn(proxy, 'peers')) {
    validateEndpoint(proxy, index);
    requireWireGuardKey(proxy, 'public-key', index);
    optionalWireGuardKey(proxy, 'pre-shared-key', index);
    validateReserved(proxy, 'reserved', index);
    if (hasOwn(proxy, 'allowed-ips')) {
      validateWireGuardAllowedIps(proxy['allowed-ips'], index, 'allowed-ips');
    }
    return;
  }

  const peers = proxy.peers;
  if (!Array.isArray(peers) || peers.length === 0) {
    invalidProxyEntry(index, 'peers', 'must be a non-empty array');
  }
  peers.forEach((peer, peerIndex) => {
    const field = `peers[${peerIndex}]`;
    if (!isRecord(peer)) {
      invalidProxyEntry(index, field, 'must be an object');
    }
    rejectUnknownFields(peer, WIREGUARD_PEER_FIELDS, index, field);
    requireNonEmptyString(peer, 'server', index, field);
    requirePort(peer, 'port', index, field);
    requireWireGuardKey(peer, 'public-key', index, field);
    optionalWireGuardKey(peer, 'pre-shared-key', index, field);
    validateReserved(peer, 'reserved', index, field);
    validateWireGuardAllowedIps(peer['allowed-ips'], index, `${field}.allowed-ips`);
  });
}

function validateWireGuardAllowedIps(value: unknown, index: number, field: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    invalidProxyEntry(index, field, 'must be a non-empty string array');
  }
  for (const allowedIP of value as string[]) {
    validateIpPrefix(allowedIP, undefined, index, field, true);
  }
}

function validateAmneziaWireGuardOptions(value: unknown, index: number): void {
  const prefix = 'amnezia-wg-option';
  if (!isPlainRecord(value)) invalidProxyEntry(index, prefix, 'must be a plain object');
  rejectUnknownFields(value, AMNEZIA_WG_FIELDS, index, prefix);
  for (const field of ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'itime']) {
    if (!hasOwn(value, field)) continue;
    const item = value[field];
    if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
      invalidProxyEntry(index, `${prefix}.${field}`, 'must be a safe integer');
    }
  }
  for (const field of ['h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5', 'j1', 'j2', 'j3']) {
    optionalString(value, field, index, prefix);
  }
}

function validateUniqueNames(proxies: Record<string, unknown>[]): void {
  const names = new Set<string>();
  proxies.forEach((proxy, index) => {
    const name = proxy.name as string;
    if (names.has(name)) {
      invalidProxyEntry(index, 'name', 'duplicates another proxy entry');
    }
    names.add(name);
  });
}

function validateDialerProxyGraph(
  proxies: Record<string, unknown>[],
  allowExternalReferences: boolean,
): void {
  const indexByName = new Map<string, number>();
  proxies.forEach((proxy, index) => indexByName.set(proxy.name as string, index));

  const references = new Map<string, string>();
  proxies.forEach((proxy, index) => {
    if (!hasOwn(proxy, 'dialer-proxy')) return;
    const target = proxy['dialer-proxy'] as string;
    if (!indexByName.has(target)) {
      if (!allowExternalReferences) {
        invalidProxyEntry(index, 'dialer-proxy', 'references a proxy outside this node source');
      }
      return;
    }
    references.set(proxy.name as string, target);
  });

  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      invalidProxyEntry(indexByName.get(name) ?? 0, 'dialer-proxy', 'creates a dependency cycle');
    }
    state.set(name, 'visiting');
    const target = references.get(name);
    if (target !== undefined) visit(target);
    state.set(name, 'done');
  };
  for (const name of indexByName.keys()) visit(name);
}

function validateRealityOptions(
  value: Record<string, unknown>,
  index: number,
  prefix?: string,
  isRoot = true,
): void {
  if (hasOwn(value, 'reality-opts')) {
    const field = joinField(prefix, 'reality-opts');
    const options = value['reality-opts'];
    if (!isPlainRecord(options)) {
      invalidProxyEntry(index, field, 'must be a plain object');
    }
    const allowedKeys = new Set(['public-key', 'short-id', 'support-x25519mlkem768']);
    if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
      invalidProxyEntry(index, field, 'contains an unsupported field');
    }
    const publicKey = requireNonEmptyString(options, 'public-key', index, field);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(publicKey) ||
      Buffer.from(publicKey, 'base64url').length !== 32 ||
      Buffer.from(publicKey, 'base64url').toString('base64url') !== publicKey
    ) {
      invalidProxyEntry(index, `${field}.public-key`, 'must be a canonical 32-byte Base64URL key');
    }
    if (hasOwn(options, 'short-id')) {
      const shortId = options['short-id'];
      if (
        typeof shortId !== 'string' ||
        shortId.length > 16 ||
        shortId.length % 2 !== 0 ||
        !/^[0-9a-fA-F]*$/.test(shortId)
      ) {
        invalidProxyEntry(index, `${field}.short-id`, 'must be at most 16 even hex characters');
      }
    }
    if (
      hasOwn(options, 'support-x25519mlkem768') &&
      typeof options['support-x25519mlkem768'] !== 'boolean'
    ) {
      invalidProxyEntry(index, `${field}.support-x25519mlkem768`, 'must be a boolean');
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'reality-opts') continue;
    // Top-level keys already passed the fixed proxy schema. Deeper object keys
    // can come from arbitrary maps such as headers, so never reflect them in a
    // public validation path; retain only the trusted top-level container.
    const childPrefix = isRoot ? key : prefix;
    if (isRecord(child)) validateRealityOptions(child, index, childPrefix, false);
    if (Array.isArray(child)) {
      child.forEach((item) => {
        if (isRecord(item)) {
          validateRealityOptions(item, index, childPrefix, false);
        }
      });
    }
  }
}

function validateInlineTlsMaterial(
  value: Record<string, unknown>,
  index: number,
  type: string,
  prefix?: string,
  isRoot = true,
): void {
  const hasCertificate = hasOwn(value, 'certificate');
  const hasPrivateKey = hasOwn(value, 'private-key');
  const privateKeyHasAnotherMeaning = isRoot && TOP_LEVEL_PRIVATE_KEY_TYPES.has(type);

  if (hasCertificate && privateKeyHasAnotherMeaning) {
    invalidProxyEntry(index, joinField(prefix, 'certificate'), 'is not supported for this type');
  }
  if (!privateKeyHasAnotherMeaning && (hasCertificate || hasPrivateKey)) {
    const certificateField = joinField(prefix, 'certificate');
    const privateKeyField = joinField(prefix, 'private-key');
    const certificate = value.certificate;
    const privateKey = value['private-key'];
    if (typeof certificate !== 'string' || !certificate.includes('-----BEGIN CERTIFICATE-----')) {
      invalidProxyEntry(index, certificateField, 'must be inline PEM material');
    }
    if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY-----')) {
      invalidProxyEntry(index, privateKeyField, 'must be inline PEM material');
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'certificate' || key === 'private-key') continue;
    // As above, only the root proxy key is guaranteed to be a fixed schema
    // name. Nested map keys may contain credentials and must stay out of the
    // ProblemDetails message and every downstream ConfigValidationError path.
    const childPrefix = isRoot ? key : prefix;
    if (isRecord(child)) {
      validateInlineTlsMaterial(child, index, type, childPrefix, false);
    }
    if (Array.isArray(child)) {
      child.forEach((item) => {
        if (isRecord(item)) {
          validateInlineTlsMaterial(item, index, type, childPrefix, false);
        }
      });
    }
  }
}

function validateIpPrefix(
  value: string,
  family: 4 | 6 | undefined,
  index: number,
  field: string,
  requirePrefix = false,
): void {
  const parts = value.split('/');
  if (parts.length > 2 || (requirePrefix && parts.length !== 2)) {
    invalidProxyEntry(index, field, 'must be a valid IP prefix');
  }
  const detectedFamily = isIP(parts[0]);
  if (detectedFamily === 0 || (family !== undefined && detectedFamily !== family)) {
    invalidProxyEntry(
      index,
      field,
      `must be a valid IPv${family ?? '4 or IPv6'} address or prefix`,
    );
  }
  if (parts.length === 2) {
    const max = detectedFamily === 4 ? 32 : 128;
    if (!/^\d+$/.test(parts[1]) || Number(parts[1]) > max) {
      invalidProxyEntry(index, field, 'must use a valid prefix length');
    }
  }
}

function requireWireGuardKey(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): string {
  const value = requireNonEmptyString(proxy, field, index, prefix);
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  ) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be a canonical 32-byte Base64 key');
  }
  return value;
}

function optionalWireGuardKey(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): void {
  if (hasOwn(proxy, field)) requireWireGuardKey(proxy, field, index, prefix);
}

function validateReserved(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): void {
  if (!hasOwn(proxy, field)) return;
  const value = proxy[field];
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255,
    )
  ) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be exactly three byte integers');
  }
}

function optionalNonNegativeInteger(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): number | undefined {
  if (!hasOwn(proxy, field)) return undefined;
  const value = proxy[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be a non-negative safe integer');
  }
  return value;
}

function optionalBoolean(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): boolean | undefined {
  if (!hasOwn(proxy, field)) return undefined;
  const value = proxy[field];
  if (typeof value !== 'boolean') {
    invalidProxyEntry(index, joinField(prefix, field), 'must be a boolean');
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  index: number,
  prefix: string,
): void {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    invalidProxyEntry(index, prefix, 'contains an unsupported field');
  }
}

function requireNonEmptyString(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): string {
  const value = proxy[field];
  if (typeof value !== 'string' || value.trim() === '') {
    invalidProxyEntry(index, joinField(prefix, field), 'must be a non-empty string');
  }
  return value;
}

function optionalNonEmptyString(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): string | undefined {
  if (!hasOwn(proxy, field)) return undefined;
  return requireNonEmptyString(proxy, field, index, prefix);
}

function requirePort(
  proxy: Record<string, unknown>,
  field: string,
  index: number,
  prefix?: string,
): number {
  const value = proxy[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    invalidProxyEntry(index, joinField(prefix, field), 'must be an integer from 1 through 65535');
  }
  return value;
}

function invalidProxyEntry(index: number, field: string, reason: string): never {
  throw new MihomoProxyValidationError(index, field, reason);
}

function joinField(prefix: string | undefined, field: string): string {
  return prefix ? `${prefix}.${field}` : field;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
