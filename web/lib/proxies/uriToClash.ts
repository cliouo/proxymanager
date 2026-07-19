import { parseDocument } from 'yaml';
import { normalizeMihomoUserId } from '@/lib/proxies/mihomoUserId';

/**
 * Parse line-delimited proxy URIs into Clash proxy objects.
 *
 * Supported schemes (mirrors mihomo / clash.meta):
 *   ss://, ssr://, vmess://, vless://, trojan://, hysteria://, hysteria2://
 *   (hy2://), tuic://, snell://, socks5://, socks://, http://, https://
 *
 * Input handling:
 *   - Multi-line text, one URI per line
 *   - Blank lines and lines starting with `#` or `//` are ignored
 *   - The whole text may itself be base64; callers handle that fallback
 *
 * Reference: format conventions come from Sub-Store's parser suite. We don't
 * vendor their code — they pull peggy.js + a dozen helpers — but their shapes
 * for Clash output are what we target so existing airports keep working.
 */

/** Minimal shape any parser must return. Extra keys are protocol-specific. */
export type ClashProxy = {
  name: string;
  type: string;
  server: string;
  port: number;
} & Record<string, unknown>;

export interface ParseProxyResult {
  proxies: ClashProxy[];
  /** Lines that matched a known scheme but failed to parse. */
  errors: ProxyUriParseFailure[];
}

export type ProxyUriIssueCategory =
  | 'input_line_limit'
  | 'unrecognised_text'
  | 'unsupported_scheme'
  | 'parser_rejected'
  | 'parser_resource_limit';

/**
 * Credential-free projection of one URI-list failure. The human-readable
 * `error` field remains an internal parser diagnostic; only this projection is
 * allowed to cross config-preflight or MCP boundaries.
 */
export interface ProxyUriParseIssue {
  /** One-based physical line number, or null for a whole-input limit. */
  line: number | null;
  category: ProxyUriIssueCategory;
  /** Present only after the scheme was verified against the fixed registry. */
  scheme?: string;
}

export interface ProxyUriParseFailure {
  line: string;
  error: string;
  issue: ProxyUriParseIssue;
}

const SCHEME_REGEX = /^([a-z][a-z0-9+.-]*):\/\//i;
export const MAX_PROXY_URI_LINES = 50_000;
const MAX_HYSTERIA_PORT_CANDIDATES = 65_536;
const MAX_XHTTP_SESSION_ID_LENGTH = 256;
const MAX_XHTTP_SESSION_ID_RANGE_CARDINALITY = 256;
const MIN_XHTTP_SESSION_ID_SPACE = BigInt(2) ** BigInt(31);
const MAX_WIREGUARD_WORKERS = 256;
const MAX_ANYTLS_IDLE_SESSIONS = 256;
const MAX_SAFE_DURATION_SECONDS = 9_223_372_036;

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

/** Heuristic: does this text contain at least one recognised proxy URI? */
export function looksLikeProxyUriList(text: string): boolean {
  for (const [, raw] of iteratePhysicalLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.match(SCHEME_REGEX);
    if (m && Object.hasOwn(PARSERS, m[1].toLowerCase())) return true;
  }
  return false;
}

/** Decode standard or URL-safe base64. Returns null on malformed input. */
export function tryBase64Decode(s: string): string | null {
  const decoded = decodeCanonicalBase64Utf8(s, true);
  if (decoded === null || hasUnexpectedControlBytes(decoded)) return null;
  return decoded;
}

function decodeCanonicalBase64Utf8(value: string, allowWhitespace: boolean): string | null {
  if (!allowWhitespace && /\s/.test(value)) return null;
  const compact = allowWhitespace ? value.replace(/\s+/g, '') : value;
  if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;

  const unpadded = compact.replace(/=+$/, '');
  const paddingLength = compact.length - unpadded.length;
  const remainder = unpadded.length % 4;
  if (remainder === 1) return null;
  const requiredPadding = (4 - remainder) % 4;
  // Missing padding is legal, but present padding must be exact and canonical.
  if (paddingLength !== 0 && paddingLength !== requiredPadding) return null;
  if (/[+/]/.test(unpadded) && /[-_]/.test(unpadded)) return null;

  const standard = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat(requiredPadding);
  try {
    const bytes = Buffer.from(padded, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== standard) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Main entry: parse a multi-line block of proxy URIs into Clash proxies.
 * Names are de-duplicated by appending `#2`, `#3`, … to collisions.
 */
export function parseProxyUriList(text: string): ParseProxyResult {
  if (physicalLineCountExceeds(text, MAX_PROXY_URI_LINES)) {
    return {
      proxies: [],
      errors: [
        {
          line: 'input',
          error: `proxy URI input exceeds the ${MAX_PROXY_URI_LINES} physical-line limit`,
          issue: { line: null, category: 'input_line_limit' },
        },
      ],
    };
  }
  const proxies: ClashProxy[] = [];
  const errors: ProxyUriParseFailure[] = [];
  const usedNames = new Set<string>();
  const nextSuffixByBase = new Map<string, number>();

  for (const [index, raw] of iteratePhysicalLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const schemeMatch = line.match(SCHEME_REGEX);
    if (!schemeMatch) {
      errors.push({
        line: `line ${index + 1} (unrecognised text)`,
        error: 'non-comment line is not a proxy URI',
        issue: { line: index + 1, category: 'unrecognised_text' },
      });
      continue;
    }
    const scheme = schemeMatch[1].toLowerCase();
    const parser = Object.hasOwn(PARSERS, scheme) ? PARSERS[scheme] : undefined;
    if (!parser) {
      errors.push({
        line: `line ${index + 1} (unsupported scheme)`,
        error: 'unsupported scheme',
        issue: { line: index + 1, category: 'unsupported_scheme' },
      });
      continue;
    }
    try {
      const proxy = parser(line);
      // Per-NODE candidate budget (not shared across the list): providers
      // legitimately repeat the same hop range on every node, and nothing
      // materialises the expanded candidate list.
      if (
        (proxy.type === 'hysteria' || proxy.type === 'hysteria2') &&
        typeof proxy.ports === 'string' &&
        countCanonicalPortCandidates(proxy.ports) > MAX_HYSTERIA_PORT_CANDIDATES
      ) {
        throw new Error(
          `hysteria port sets exceed the ${MAX_HYSTERIA_PORT_CANDIDATES} candidate limit`,
        );
      }
      // Tab is the one control character free-tier exporters actually pad
      // names with; Mihomo accepts it and YAML emission escapes it.
      if (/[\x00-\x08\x0a-\x1f\x7f-\x9f]/u.test(proxy.name)) {
        throw new Error('proxy name contains control characters');
      }
      proxy.name = uniqueName(
        proxy.name || `${proxy.server}:${proxy.port}`,
        usedNames,
        nextSuffixByBase,
      );
      proxies.push(proxy);
    } catch (err) {
      errors.push({
        line: describeUriLine(index, scheme),
        error: err instanceof Error ? err.message : String(err),
        issue: {
          line: index + 1,
          category: isParserResourceLimitError(err) ? 'parser_resource_limit' : 'parser_rejected',
          scheme,
        },
      });
    }
  }
  return { proxies, errors };
}

function isParserResourceLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message ===
      `hysteria port sets exceed the ${MAX_HYSTERIA_PORT_CANDIDATES} candidate limit`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Per-protocol parsers
// ────────────────────────────────────────────────────────────────────────────

function parseSS(uri: string): ClashProxy {
  // Three forms exist in the wild:
  //   1) ss://method:password@host:port#name
  //   2) ss://base64(method:password)@host:port?plugin=…#name  (SIP002)
  //   3) ss://base64(method:password@host:port)?…#name         (legacy v2ray)
  const { tag, body } = splitTag(uri);
  const rest = body.slice('ss://'.length);

  // Separate query early — for legacy form the query lives at the end too
  const qIdx = rest.indexOf('?');
  const main = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const queryStr = qIdx === -1 ? '' : rest.slice(qIdx + 1);

  let cipher: string;
  let password: string;
  let host: string;
  let port: number;

  const atIdx = main.lastIndexOf('@');
  if (atIdx === -1) {
    // legacy form: whole main is base64-of(method:password@host:port)
    const decoded = tryBase64Decode(main);
    if (!decoded) throw new Error('invalid ss legacy base64');
    // Split from the ends rather than one regex: password may contain '@',
    // and IPv6 hosts contain ':' which a [^:@]+ host group can't match.
    const at = decoded.lastIndexOf('@');
    if (at === -1) throw new Error('malformed ss legacy payload');
    const userPart = decoded.slice(0, at);
    const hostPort = decoded.slice(at + 1);
    const colon = userPart.indexOf(':');
    const portIdx = hostPort.lastIndexOf(':');
    if (colon === -1 || portIdx === -1) throw new Error('malformed ss legacy payload');
    cipher = userPart.slice(0, colon);
    password = userPart.slice(colon + 1);
    host = normalizeUriHostname(hostPort.slice(0, portIdx));
    port = parsePort(hostPort.slice(portIdx + 1));
  } else {
    const userPart = main.slice(0, atIdx);
    let hostPart = main.slice(atIdx + 1);
    // SIP002 allows a trailing '/' before the query; strip it
    if (hostPart.endsWith('/')) hostPart = hostPart.slice(0, -1);
    // P3-2: the base64 userinfo is sometimes percent-encoded (…%2B…%3D), which
    // fails a direct base64 decode. Retry by percent-decoding first, then fall
    // back to a plain percent-decode (already-plain method:password form).
    const decoded =
      tryBase64Decode(userPart) ?? tryBase64Decode(safeDecode(userPart)) ?? safeDecode(userPart);
    const colon = decoded.indexOf(':');
    if (colon === -1) throw new Error('missing method:password');
    cipher = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
    const portIdx = hostPart.lastIndexOf(':');
    if (portIdx === -1) throw new Error('missing port');
    host = normalizeUriHostname(hostPart.slice(0, portIdx));
    port = parsePort(hostPart.slice(portIdx + 1));
  }

  const proxy: ClashProxy = {
    name: tag || `${host}:${port}`,
    type: 'ss',
    server: host,
    port,
    cipher,
    password,
    udp: true, // Clash sensible default; ?udp=0 in query will flip it
  };

  if (qIdx !== -1) {
    if (!queryStr) throw new Error('empty ss query');
    applySsQueryParams(proxy, parseQueryString(queryStr));
  }
  return proxy;
}

/** Apply SS query parameters that Mihomo can represent without changing meaning. */
function applySsQueryParams(proxy: ClashProxy, p: Record<string, string>): void {
  assertOnlyKeys(
    p,
    new Set([
      'udp',
      'tfo',
      'uot',
      'udp-over-tcp',
      'security',
      'sni',
      'peer',
      'alpn',
      'allowInsecure',
      'insecure',
      'fp',
      'pbk',
      'sid',
      'type',
      'path',
      'wspath',
      'host',
      'serviceName',
      'ws',
      'plugin',
      'shadow-tls',
    ]),
    'ss query',
  );
  assertNoAliasCollision(
    p,
    [
      ['sni', 'peer'],
      ['allowInsecure', 'insecure'],
      ['path', 'wspath'],
      ['uot', 'udp-over-tcp'],
    ],
    'ss query',
  );

  // Flag triplet
  if (Object.hasOwn(p, 'udp')) proxy.udp = parseBooleanString(p.udp, 'ss udp');
  if (Object.hasOwn(p, 'tfo')) proxy.tfo = parseBooleanString(p.tfo, 'ss tfo');
  const uotKey = Object.hasOwn(p, 'uot') ? 'uot' : 'udp-over-tcp';
  if (Object.hasOwn(p, uotKey)) {
    proxy['udp-over-tcp'] = parseBooleanString(p[uotKey], 'ss udp over tcp');
  }

  // Mihomo's SS outbound has no top-level TLS/Reality or V2Ray transport
  // fields. Emitting those keys looks secured but the target decoder ignores
  // them, so active wrappers must not degrade into direct Shadowsocks.
  if (
    (Object.hasOwn(p, 'type') && p.type !== 'tcp') ||
    [
      'sni',
      'peer',
      'alpn',
      'allowInsecure',
      'insecure',
      'fp',
      'pbk',
      'sid',
      'path',
      'wspath',
      'host',
      'serviceName',
    ].some((key) => Object.hasOwn(p, key)) ||
    (Object.hasOwn(p, 'security') && p.security !== 'none')
  ) {
    throw new Error('unsupported ss top-level transport or security wrapper');
  }
  if (Object.hasOwn(p, 'ws') && parseBooleanString(p.ws, 'ss websocket')) {
    throw new Error('unsupported ss top-level websocket wrapper');
  }

  if (Object.hasOwn(p, 'plugin') && Object.hasOwn(p, 'shadow-tls')) {
    throw new Error('ss supports only one plugin');
  }
  if (Object.hasOwn(p, 'plugin')) {
    if (!p.plugin) throw new Error('missing ss plugin');
    attachSsPlugin(proxy, p.plugin);
  }

  // Shadowrocket: shadow-tls carried in query rather than plugin
  if (Object.hasOwn(p, 'shadow-tls')) {
    const decoded = decodeStrictBase64(p['shadow-tls'], 'shadow-tls payload');
    const parsed = parseStrictJsonObject(decoded, 'shadow-tls');
    assertOnlyKeys(
      parsed,
      new Set(['host', 'password', 'version', 'address', 'port']),
      'shadow-tls',
    );

    const host = readOptionalStringField(parsed, 'host', 'shadow-tls');
    if (!host) throw new Error('shadow-tls requires host');
    const password = readOptionalStringField(parsed, 'password', 'shadow-tls');
    const version = parseShadowTlsVersion(parsed.version);
    const address = readOptionalStringField(parsed, 'address', 'shadow-tls');

    proxy.plugin = 'shadow-tls';
    const opts: Record<string, unknown> = { host };
    if (password !== '') opts.password = password;
    if (version !== undefined) opts.version = version;
    proxy['plugin-opts'] = opts;
    if (address) proxy.server = address;
    if (parsed.port !== undefined) proxy.port = parsePortField(parsed.port, 'shadow-tls port');
  }
}

/**
 * For WebSocket transport on SS/VMess/VLESS, the path may carry an `?ed=N`
 * suffix denoting max-early-data bytes (v2ray-style). Returns the cleaned
 * path and the early-data value if present.
 */
function extractEarlyDataFromPath(path: string): { path: string; ed: string | null } {
  const qIdx = path.indexOf('?');
  if (qIdx === -1) return { path, ed: null };
  const before = path.slice(0, qIdx);
  const params = parseQueryString(path.slice(qIdx + 1));
  const ed = params.ed;
  if (!ed || !/^\d+$/.test(ed)) return { path, ed: null };
  delete params.ed;
  const rebuilt = Object.entries(params)
    .map(([k, v]) =>
      v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
  return { path: rebuilt ? `${before}?${rebuilt}` : before, ed };
}

type Sip003OptionValue = string | true;

function attachSsPlugin(proxy: ClashProxy, raw: string): void {
  const { name: pluginName, options: opts } = parseSip003Plugin(raw);
  if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
    assertOnlySip003Options(opts, ['obfs', 'obfs-host', 'mode', 'host'], 'obfs');
    const mode = readSip003Option(opts, 'obfs') ?? readSip003Option(opts, 'mode');
    if (mode !== 'tls' && mode !== 'http') throw new Error('unsupported ss obfs mode');
    proxy.plugin = 'obfs';
    const m: Record<string, unknown> = { mode };
    const host = readSip003Option(opts, 'obfs-host') ?? readSip003Option(opts, 'host');
    if (host !== undefined) m.host = host;
    proxy['plugin-opts'] = m;
  } else if (pluginName === 'v2ray-plugin' || pluginName === 'xray-plugin') {
    assertOnlySip003Options(opts, ['mode', 'tls', 'host', 'path', 'mux'], 'v2ray-plugin');
    const mode = readSip003Option(opts, 'mode') ?? 'websocket';
    if (mode !== 'websocket') throw new Error('unsupported v2ray-plugin mode');
    proxy.plugin = 'v2ray-plugin';
    const m: Record<string, unknown> = { mode: 'websocket' };
    if (Object.hasOwn(opts, 'tls')) m.tls = true;
    const host = readSip003Option(opts, 'host');
    if (host !== undefined) m.host = host;
    const path = readSip003Option(opts, 'path');
    if (path !== undefined) m.path = path;
    if (Object.hasOwn(opts, 'mux')) {
      const mux = readSip003Option(opts, 'mux');
      if (mux !== '0' && mux !== '1') {
        throw new Error('unrepresentable v2ray-plugin mux concurrency');
      }
      m.mux = mux === '1';
    }
    proxy['plugin-opts'] = m;
  } else if (pluginName === 'shadow-tls') {
    assertOnlySip003Options(opts, ['host', 'password', 'version'], 'shadow-tls');
    const host = readSip003Option(opts, 'host');
    if (!host) throw new Error('shadow-tls requires host');
    proxy.plugin = 'shadow-tls';
    const m: Record<string, unknown> = { host };
    const password = readSip003Option(opts, 'password');
    if (password !== undefined) m.password = password;
    if (Object.hasOwn(opts, 'version')) {
      m.version = parseShadowTlsVersion(readSip003Option(opts, 'version'));
    }
    proxy['plugin-opts'] = m;
  } else {
    throw new Error('unsupported ss plugin');
  }
}

function parseSip003Plugin(raw: string): {
  name: string;
  options: Record<string, Sip003OptionValue>;
} {
  const segments: { value: string; equalsAt: number }[] = [];
  let value = '';
  let equalsAt = -1;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ';') {
      segments.push({ value, equalsAt });
      value = '';
      equalsAt = -1;
      continue;
    }
    if (char === '=' && equalsAt === -1) equalsAt = value.length;
    value += char;
  }
  if (escaped) throw new Error('invalid ss plugin escape');
  segments.push({ value, equalsAt });

  const name = segments[0]?.value ?? '';
  if (!name || segments[0].equalsAt !== -1) throw new Error('invalid ss plugin name');
  const options: Record<string, Sip003OptionValue> = {};
  for (const segment of segments.slice(1)) {
    if (!segment.value) throw new Error('invalid ss plugin option');
    const key = segment.equalsAt === -1 ? segment.value : segment.value.slice(0, segment.equalsAt);
    if (!key || Object.hasOwn(options, key)) throw new Error('invalid ss plugin option');
    options[key] = segment.equalsAt === -1 ? true : segment.value.slice(segment.equalsAt + 1);
  }
  return { name, options };
}

function readSip003Option(
  options: Record<string, Sip003OptionValue>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`invalid ${key} plugin option`);
  return value;
}

function assertOnlySip003Options(
  options: Record<string, Sip003OptionValue>,
  allowed: readonly string[],
  plugin: string,
): void {
  if (Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new Error(`unsupported ${plugin} option`);
  }
}

function parseShadowTlsVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^[123]$/.test(raw)) {
    throw new Error('invalid shadow-tls version');
  }
  return Number(raw);
}

function parseSSR(uri: string): ClashProxy {
  const body = uri.slice('ssr://'.length);
  const decoded = tryBase64Decode(body);
  if (!decoded) throw new Error('invalid ssr base64');
  const qIdx = decoded.indexOf('/?');
  const main = qIdx === -1 ? decoded : decoded.slice(0, qIdx);
  const queryStr = qIdx === -1 ? '' : decoded.slice(qIdx + 2);
  // Split from the end: the five trailing fields are colon-free, while an
  // IPv6 host contains ':' and would break a plain six-way split.
  const parts = main.split(':');
  if (parts.length < 6) throw new Error('malformed ssr');
  const [portStr, protocol, method, obfs, b64password] = parts.slice(-5);
  const host = normalizeUriHostname(parts.slice(0, -5).join(':'));
  if (!host || !protocol || !method || !obfs) throw new Error('malformed ssr');
  const password = decodeStrictBase64(b64password, 'ssr password');
  const params = parseQueryString(queryStr);
  assertOnlyKeys(
    params,
    new Set(['remarks', 'obfsparam', 'protoparam', 'group', 'udpport', 'uot']),
    'ssr query',
  );
  const remarks = decodeOptionalSsrField(params, 'remarks');
  const obfsParam = decodeOptionalSsrField(params, 'obfsparam');
  const protocolParam = decodeOptionalSsrField(params, 'protoparam');
  // `group` is display metadata with no Mihomo SSR target field. Validate its
  // encoding when supplied, then intentionally ignore it.
  decodeOptionalSsrField(params, 'group');
  if (
    (Object.hasOwn(params, 'udpport') && params.udpport !== '') ||
    (Object.hasOwn(params, 'uot') && params.uot !== '')
  ) {
    throw new Error('unsupported ssr udpport/uot target field');
  }
  const port = parsePort(portStr);
  return {
    name: remarks || `${host}:${portStr}`,
    type: 'ssr',
    server: host,
    port,
    cipher: method,
    password,
    obfs,
    protocol,
    'obfs-param': obfsParam,
    'protocol-param': protocolParam,
    udp: true,
  };
}

function decodeOptionalSsrField(params: Record<string, string>, field: string): string {
  if (!Object.hasOwn(params, field) || params[field] === '') return '';
  return decodeStrictBase64(params[field], `ssr ${field}`);
}

function parseVMess(uri: string): ClashProxy {
  const body = uri.slice('vmess://'.length);
  const decoded = tryBase64Decode(body);
  if (!decoded) throw new Error('invalid vmess base64');
  const json = parseStrictJsonObject(decoded, 'vmess');
  assertOnlyKeys(
    json,
    new Set([
      'v',
      'ps',
      'add',
      'port',
      'id',
      'aid',
      'scy',
      'tls',
      'sni',
      'alpn',
      'net',
      'type',
      'host',
      'path',
      'fp',
      'insecure',
      'pcs',
      'vcn',
    ]),
    'vmess',
  );
  if (json.v !== undefined && json.v !== '2') {
    throw new Error('unsupported vmess schema version');
  }

  // V2RayN's legacy JSON fields are strings unless explicitly handled below.
  // Validate raw JSON types before normalizing to avoid arrays/objects being
  // silently stringified into plausible endpoint values.
  const stringFields = [
    'v',
    'ps',
    'add',
    'id',
    'scy',
    'net',
    'type',
    'host',
    'path',
    'sni',
    'alpn',
    'fp',
    'insecure',
    'vcn',
    'pcs',
  ] as const;
  for (const field of stringFields) {
    if (json[field] !== undefined && typeof json[field] !== 'string') {
      throw new Error(`invalid vmess ${field} field`);
    }
  }
  const get = (key: (typeof stringFields)[number]): string =>
    (json[key] as string | undefined) ?? '';

  const server = normalizeUriHostname(get('add'));
  if (!server) throw new Error('vmess missing add');
  const port = parsePortField(json.port, 'vmess port');
  const uuid = get('id');
  if (!uuid) throw new Error('vmess missing id');
  const normalizedUserId = normalizeMihomoUserId(uuid);
  if (normalizedUserId === null) throw new Error('invalid vmess user id');
  const alterId = parseVmessAlterId(json.aid);
  const tls = parseVmessTls(json.tls);
  const insecure = parseVmessInsecure(get('insecure'));
  if (get('pcs')) throw new Error('unsupported vmess pcs field');
  if (get('vcn')) throw new Error('unsupported vmess vcn field');
  if (!tls && (get('fp') || insecure)) {
    throw new Error('vmess TLS options require tls');
  }

  const proxy: ClashProxy = {
    name: get('ps') || `${server}:${port}`,
    type: 'vmess',
    server,
    port,
    uuid: normalizedUserId,
    alterId,
    cipher: get('scy') || 'auto',
    udp: true,
  };
  if (tls) {
    proxy.tls = true;
    if (get('sni')) proxy.servername = get('sni');
    if (get('alpn')) proxy.alpn = splitList(get('alpn'));
    if (get('fp')) proxy['client-fingerprint'] = get('fp');
    if (insecure) proxy['skip-cert-verify'] = true;
  }

  let net = (get('net') || 'tcp').toLowerCase();
  // Xray ≥ 24.9 renamed the plain TCP transport to "raw".
  if (net === 'raw') net = 'tcp';
  const headerType = get('type').toLowerCase();
  if (!['tcp', 'ws', 'httpupgrade', 'http', 'h2', 'grpc', 'kcp', 'mkcp'].includes(net)) {
    throw new Error('unsupported vmess transport');
  }
  if (net === 'tcp' && headerType === 'http') {
    proxy.network = 'http';
    const headers: Record<string, string[]> = {};
    if (get('host')) headers.Host = [get('host')];
    proxy['http-opts'] = {
      path: [get('path') || '/'],
      headers,
    };
    return proxy;
  }
  if (net === 'tcp' && headerType !== '' && headerType !== 'none') {
    throw new Error('unsupported vmess tcp header type');
  }

  const isHttpUpgrade = net === 'httpupgrade';
  const network = isHttpUpgrade ? 'ws' : net === 'http' ? 'h2' : net;
  proxy.network = network;
  if (network === 'ws') {
    assertVmessHeaderType(headerType, ['none'], 'websocket');
    const opts: Record<string, unknown> = {};
    const { path: cleanedPath, ed } = extractEarlyDataFromPath(get('path') || '/');
    if (isHttpUpgrade) {
      opts['v2ray-http-upgrade'] = true;
      if (ed) opts['v2ray-http-upgrade-fast-open'] = true;
    } else if (ed) {
      opts['max-early-data'] = parseInt(ed, 10);
      opts['early-data-header-name'] = 'Sec-WebSocket-Protocol';
    }
    opts.path = cleanedPath;
    if (get('host')) opts.headers = { Host: get('host') };
    proxy['ws-opts'] = opts;
  } else if (network === 'h2') {
    assertVmessHeaderType(headerType, ['none'], 'h2');
    const opts: Record<string, unknown> = { path: get('path') || '/' };
    if (get('host')) opts.host = [get('host')];
    proxy['h2-opts'] = opts;
  } else if (network === 'grpc') {
    assertVmessHeaderType(headerType, ['none'], 'grpc');
    proxy['grpc-opts'] = { 'grpc-service-name': get('path') };
  } else if (network === 'kcp' || network === 'mkcp') {
    const header = headerType || 'none';
    if (!['none', 'srtp', 'utp', 'wechat-video', 'dtls', 'wireguard'].includes(header)) {
      throw new Error('unsupported vmess mkcp header type');
    }
    proxy.network = 'mkcp';
    const opts: Record<string, unknown> = {};
    if (header !== 'none') opts.header = header;
    if (get('path')) opts.seed = get('path');
    proxy['mkcp-opts'] = opts;
  }
  return proxy;
}

function parseVmessAlterId(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid vmess alterId');
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('invalid vmess alterId');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid vmess alterId');
  return parsed;
}

function parseVmessTls(value: unknown): boolean {
  if (value === undefined || value === '') return false;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') throw new Error('invalid vmess tls field');
  switch (value.toLowerCase()) {
    case 'tls':
    case 'true':
    case '1':
      return true;
    case 'none':
    case 'false':
    case '0':
      return false;
    default:
      throw new Error('invalid vmess tls field');
  }
}

function parseVmessInsecure(value: string): boolean {
  if (value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('invalid vmess insecure field');
}

function assertVmessHeaderType(value: string, allowed: readonly string[], transport: string): void {
  if (value !== '' && !allowed.includes(value)) {
    throw new Error(`unsupported vmess ${transport} header type`);
  }
}

function parseVLESS(uri: string): ClashProxy {
  const u = safeUrl(uri);
  assertNoUriPath(u, 'vless');
  assertSingleComponentUserinfo(uri, 'vless');
  assertVlessQueryIntegrity(u.searchParams);
  const uuid = safeDecode(u.username);
  if (!uuid) throw new Error('vless missing uuid');
  const normalizedUserId = normalizeMihomoUserId(uuid);
  if (normalizedUserId === null) throw new Error('invalid vless user id');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('vless missing host');
  const port = parsePort(u.port);
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'vless',
    server: host,
    port,
    uuid: normalizedUserId,
    udp: true,
  };
  if (params.flow) {
    if (params.flow.toLowerCase() !== 'xtls-rprx-vision') {
      throw new Error('unsupported vless flow');
    }
    proxy.flow = 'xtls-rprx-vision';
  }
  // Reality spiderX (`spx`) is dropped, not rejected: Mihomo's Reality options
  // cannot express it, and it only steers the client's camouflage crawl when a
  // probe is detected — never the handshake. 3x-ui emits a random spiderX on
  // every Reality share link, so rejecting would fail most 3x-ui sources.
  // VLESS share links use `encryption=none` as the legacy no-encryption
  // sentinel, while current Meta-Docs represents the same state as an empty
  // YAML value. Preserve real ML-KEM/x25519 encryption strings byte-for-byte.
  // `params` is already single-decoded by URLSearchParams, so do not decode it
  // again here.
  if (u.searchParams.has('encryption')) {
    if (params.encryption === '') throw new Error('vless encryption must not be empty');
    if (params.encryption !== 'none' && !isValidVlessEncryption(params.encryption)) {
      throw new Error('invalid vless encryption');
    }
    proxy.encryption = params.encryption === 'none' ? '' : params.encryption;
  }

  const hasSecurity = u.searchParams.has('security');
  let security = hasSecurity ? params.security : 'none';
  if (hasSecurity && security === '') throw new Error('vless security must not be empty');
  // Free-share exporters emit `security=false`/`security=0` for "no TLS";
  // mihomo's converter falls through to the no-TLS default for them.
  if (security === 'false' || security === '0') security = 'none';
  if (security !== 'none' && security !== 'tls' && security !== 'reality') {
    throw new Error('unsupported vless security');
  }
  // TLS-layer options (sni/fp/alpn/insecure) with security=none and Reality
  // options (pbk/sid) without security=reality are ignored, not rejected:
  // mihomo's converter only reads each group inside the matching security
  // branch, so on the original client they configure nothing either.
  if (security === 'tls' || security === 'reality') {
    proxy.tls = true;
    if (params.sni) proxy.servername = params.sni;
    if (security === 'reality') {
      if (!params.pbk || !isValidRealityPublicKey(params.pbk)) {
        throw new Error('vless reality requires a valid public key');
      }
      if (!params.fp) throw new Error('vless reality requires a client fingerprint');
      if (u.searchParams.has('sid') && !isValidRealityShortId(params.sid)) {
        throw new Error('vless reality short id is invalid');
      }
    }
    proxy['client-fingerprint'] = params.fp || 'chrome';
    if (params.pcs) {
      const fingerprint = normalizeSha256Fingerprint(params.pcs);
      if (fingerprint === null) throw new Error('invalid vless certificate fingerprint');
      proxy.fingerprint = fingerprint;
    }
    if (Object.hasOwn(params, 'alpn')) {
      const alpn = splitList(params.alpn);
      if (alpn.length === 0) throw new Error('invalid vless alpn');
      proxy.alpn = alpn;
    }
    const insecureKey = Object.hasOwn(params, 'allowInsecure') ? 'allowInsecure' : 'insecure';
    if (
      Object.hasOwn(params, insecureKey) &&
      parseZeroOneBoolean(params[insecureKey], 'vless insecure')
    ) {
      proxy['skip-cert-verify'] = true;
    }
    if (security === 'reality') {
      const opts: Record<string, unknown> = {};
      opts['public-key'] = params.pbk;
      if (params.sid) opts['short-id'] = params.sid;
      proxy['reality-opts'] = opts;
    } else if (Object.hasOwn(params, 'ech') && params.ech !== '') {
      // Reality carries its own hello camouflage, so `ech` only maps under
      // plain TLS (Sub-Store maps it unconditionally, but mihomo would layer
      // ECH over the Reality hello it fully controls).
      proxy['ech-opts'] = echQueryToOpts(params.ech, 'vless');
    }
  }

  // Preserve mihomo share-link semantics but emit the canonical current YAML
  // field. `xudp` / `packet-addr` remain accepted legacy aliases in the core;
  // Meta-Docs uses packet-encoding: xudp|packetaddr.
  const packetEncodingKeys = ['packetEncoding', 'packet-encoding'].filter((key) =>
    u.searchParams.has(key),
  );
  if (packetEncodingKeys.length > 1) {
    throw new Error('duplicate vless packet encoding parameters');
  }
  if (packetEncodingKeys.length === 1) {
    const packetEncoding = params[packetEncodingKeys[0]];
    if (packetEncoding === 'packet' || packetEncoding === 'packetaddr') {
      proxy['packet-encoding'] = 'packetaddr';
    } else if (packetEncoding === 'xudp') {
      proxy['packet-encoding'] = 'xudp';
    } else {
      throw new Error('unsupported vless packet encoding');
    }
  } else {
    proxy['packet-encoding'] = 'xudp';
  }

  // Transport. mihomo common/convert/v.go lowercases `type`, then remaps
  // `type=http` → h2 (HTTP/2) and `type=tcp` + `headerType=http` → http
  // (HTTP/1.1 obfs over TCP) before switching on the network.
  const hasTransport = u.searchParams.has('type');
  let network = hasTransport ? params.type : 'tcp';
  if (network === '') throw new Error('vless transport type must not be empty');
  // Xray ≥ 24.9 renamed the plain TCP transport to "raw".
  if (network === 'raw') network = 'tcp';
  const headerType = params.headerType || '';
  if (headerType !== '' && headerType !== 'none' && headerType !== 'http') {
    throw new Error('unsupported vless transport header type');
  }
  if (network === 'tcp' && headerType === 'http') network = 'http';
  else if (network === 'http') network = 'h2';
  if (!['tcp', 'http', 'h2', 'ws', 'httpupgrade', 'grpc', 'xhttp'].includes(network)) {
    throw new Error('unsupported vless transport type');
  }
  // Transport options that don't belong to the selected transport (a host on
  // tcp, mode/authority on grpc, a full NekoBox-style option dump…) are
  // ignored, not rejected: mihomo's converter reads each option only inside
  // the matching network case, so they configure nothing on the original
  // client either.
  // Fixed Mihomo implements HTTPUpgrade inside its WebSocket transport. Its
  // share-link converter leaves `network=httpupgrade`, but the outbound
  // constructor has no such switch case and would silently use raw TCP.
  // Canonicalise to `ws` and carry the explicit upgrade option instead.
  const isHttpUpgrade = network === 'httpupgrade';
  proxy.network = isHttpUpgrade ? 'ws' : network;
  if (network === 'ws' || network === 'httpupgrade') {
    const opts: Record<string, unknown> = { path: params.path || '/' };
    if (params.host) opts.headers = { Host: params.host };
    if (isHttpUpgrade) opts['v2ray-http-upgrade'] = true;
    if (u.searchParams.has('ed')) {
      const earlyData = parseNonNegativeInteger(params.ed, 'vless early data');
      if (network === 'ws') {
        opts['max-early-data'] = earlyData;
        opts['early-data-header-name'] = 'Sec-WebSocket-Protocol';
      } else {
        opts['v2ray-http-upgrade-fast-open'] = true;
      }
    }
    if (params.eh) opts['early-data-header-name'] = params.eh;
    proxy['ws-opts'] = opts;
  } else if (network === 'grpc') {
    proxy['grpc-opts'] = {
      'grpc-service-name': params.serviceName || params.path || '',
    };
  } else if (network === 'h2') {
    const opts: Record<string, unknown> = { path: params.path || '/' };
    if (params.host) opts.host = splitList(params.host);
    proxy['h2-opts'] = opts;
  } else if (network === 'http') {
    // mihomo v.go http case: path is a string list (default ["/"]); the Host
    // header is a list; optional method. Empty header map is omitted (a bare
    // `headers: {}` is functionally identical to absent).
    const opts: Record<string, unknown> = {
      path: params.path ? [params.path] : ['/'],
    };
    if (params.method) opts.method = params.method;
    if (params.host) opts.headers = { Host: [params.host] };
    proxy['http-opts'] = opts;
  } else if (network === 'xhttp') {
    // mihomo v.go xhttp case: network=xhttp + xhttp-opts{path,host,mode}.
    // host/mode only when present; path defaults to "/" (mihomo's http/h2
    // converter default and this parser's ws/h2 convention).
    const opts: Record<string, unknown> = { path: params.path || '/' };
    if (params.host) opts.host = params.host;
    if (params.mode) {
      if (!['auto', 'stream-one', 'stream-up', 'packet-up'].includes(params.mode)) {
        throw new Error('unsupported vless xhttp mode');
      }
      opts.mode = params.mode;
    }
    // Advanced xray `extra` JSON → xmux / padding / session / download-settings.
    // mihomo only applies it when the JSON parses cleanly (`if err == nil`).
    if (u.searchParams.has('extra')) {
      if (params.extra === '') throw new Error('vless xhttp extra must not be empty');
      try {
        const parsed = parseStrictJsonObject(params.extra, 'vless xhttp extra');
        applyXHTTPExtra(parsed, opts);
      } catch {
        throw new Error('invalid vless xhttp extra');
      }
    }
    proxy['xhttp-opts'] = opts;
  }
  return proxy;
}

/**
 * Faithful port of mihomo `common/convert/v.go` parseXHTTPExtra: map an
 * xray-core XHTTP `extra` JSON object onto mihomo `xhttp-opts` fields. Only
 * keys with a stable mihomo mapping are copied. Unlike the upstream helper,
 * this trust-boundary parser rejects unknown or mistyped fields instead of
 * silently dropping them and accidentally changing the requested transport.
 */
function applyXHTTPExtra(extra: Record<string, unknown>, opts: Record<string, unknown>): void {
  assertOnlyKeys(
    extra,
    new Set([
      'noGRPCHeader',
      'xPaddingBytes',
      'xPaddingObfsMode',
      'xPaddingKey',
      'xPaddingHeader',
      'xPaddingPlacement',
      'xPaddingMethod',
      'headers',
      'uplinkHTTPMethod',
      'uplinkHttpMethod',
      'sessionIDPlacement',
      'sessionPlacement',
      'sessionIDKey',
      'sessionKey',
      'sessionIDTable',
      'sessionIDLength',
      'seqPlacement',
      'seqKey',
      'uplinkDataPlacement',
      'uplinkDataKey',
      'uplinkChunkSize',
      'scMaxEachPostBytes',
      'scMinPostsIntervalMs',
      'xmux',
      'downloadSettings',
    ]),
    'xhttp extra',
  );
  if (Object.keys(extra).length === 0) throw new Error('empty xhttp extra');
  assertNoAliasCollision(
    extra,
    [
      ['sessionIDPlacement', 'sessionPlacement'],
      ['sessionIDKey', 'sessionKey'],
      ['uplinkHTTPMethod', 'uplinkHttpMethod'],
    ],
    'xhttp extra',
  );

  const str = (k: string): string | undefined => {
    const v = extra[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v === '') throw new Error(`invalid xhttp ${k}`);
    return v;
  };
  const num = (k: string): number | undefined => {
    const v = extra[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new Error(`invalid xhttp ${k}`);
    }
    return v;
  };
  // xmux map → reuse-settings (string kept if non-empty; number → decimal string)
  const xmuxToReuse = (xmux: Record<string, unknown>): Record<string, unknown> => {
    assertOnlyKeys(
      xmux,
      new Set([
        'maxConnections',
        'maxConcurrency',
        'cMaxReuseTimes',
        'hMaxRequestTimes',
        'hMaxReusableSecs',
        'hKeepAlivePeriod',
      ]),
      'xhttp xmux',
    );
    if (Object.keys(xmux).length === 0) throw new Error('empty xhttp xmux');
    const reuse: Record<string, unknown> = {};
    const set = (src: string, dst: string): void => {
      const v = xmux[src];
      if (v === undefined) return;
      if (typeof v === 'string') {
        reuse[dst] = validateUnsignedRange(v, `xhttp xmux ${src}`);
      } else if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) throw new Error(`invalid xhttp xmux ${src}`);
        reuse[dst] = String(v);
      } else {
        throw new Error(`invalid xhttp xmux ${src}`);
      }
    };
    set('maxConnections', 'max-connections');
    set('maxConcurrency', 'max-concurrency');
    set('cMaxReuseTimes', 'c-max-reuse-times');
    set('hMaxRequestTimes', 'h-max-request-times');
    set('hMaxReusableSecs', 'h-max-reusable-secs');
    const maxConnections = reuse['max-connections'];
    const maxConcurrency = reuse['max-concurrency'];
    if (
      typeof maxConnections === 'string' &&
      typeof maxConcurrency === 'string' &&
      unsignedRangeUpper(maxConnections) > 0 &&
      unsignedRangeUpper(maxConcurrency) > 0
    ) {
      throw new Error('xhttp xmux maxConnections conflicts with maxConcurrency');
    }
    const keepAlive = xmux['hKeepAlivePeriod'];
    if (keepAlive !== undefined) {
      if (
        typeof keepAlive !== 'number' ||
        !Number.isSafeInteger(keepAlive) ||
        keepAlive < 0 ||
        keepAlive > MAX_SAFE_DURATION_SECONDS
      ) {
        throw new Error('invalid xhttp xmux hKeepAlivePeriod');
      }
      reuse['h-keep-alive-period'] = keepAlive;
    }
    return reuse;
  };

  const headers = extra['headers'];
  if (headers !== undefined) {
    opts.headers = normalizeXhttpHeaders(headers, 'xhttp headers');
  }

  if (extra['noGRPCHeader'] !== undefined) {
    if (typeof extra['noGRPCHeader'] !== 'boolean') {
      throw new Error('invalid xhttp noGRPCHeader');
    }
    if (extra['noGRPCHeader']) opts['no-grpc-header'] = true;
  }
  const xpb = str('xPaddingBytes');
  if (xpb) opts['x-padding-bytes'] = validateUnsignedRange(xpb, 'xhttp xPaddingBytes');
  const xPaddingObfsMode = extra['xPaddingObfsMode'];
  if (xPaddingObfsMode !== undefined) {
    if (typeof xPaddingObfsMode !== 'boolean') {
      throw new Error('invalid xhttp xPaddingObfsMode');
    }
    opts['x-padding-obfs-mode'] = xPaddingObfsMode;
  }
  const xpk = str('xPaddingKey');
  if (xpk) opts['x-padding-key'] = xpk;
  const xph = str('xPaddingHeader');
  if (xph) opts['x-padding-header'] = xph;
  const xpp = str('xPaddingPlacement');
  if (xpp) {
    if (!['header', 'queryInHeader', 'cookie', 'query'].includes(xpp)) {
      throw new Error('invalid xhttp padding placement');
    }
    opts['x-padding-placement'] = xpp;
  }
  const xpm = str('xPaddingMethod');
  if (xpm) {
    if (!['repeat-x', 'tokenish'].includes(xpm)) throw new Error('invalid xhttp padding method');
    opts['x-padding-method'] = xpm;
  }
  const uhm = str('uplinkHTTPMethod') ?? str('uplinkHttpMethod');
  if (uhm) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(uhm)) {
      throw new Error('invalid xhttp uplink HTTP method');
    }
    const method = uhm.toUpperCase();
    if (method === 'GET' && opts.mode !== 'packet-up') {
      throw new Error('xhttp GET uplink method requires packet-up mode');
    }
    opts['uplink-http-method'] = method;
  }

  const paddingDetailKeys = [
    'xPaddingKey',
    'xPaddingHeader',
    'xPaddingPlacement',
    'xPaddingMethod',
  ];
  if (paddingDetailKeys.some((key) => Object.hasOwn(extra, key))) {
    if (xPaddingObfsMode !== true) {
      throw new Error('xhttp padding details require enabled obfuscation');
    }
  }
  if (xPaddingObfsMode === true) {
    const effectiveKey = xpk ?? 'x_padding';
    const effectiveHeader = xph ?? 'X-Padding';
    const effectivePlacement = xpp ?? 'queryInHeader';
    const effectiveMethod = xpm ?? 'repeat-x';
    if (['cookie', 'query', 'queryInHeader'].includes(effectivePlacement) && !effectiveKey) {
      throw new Error('xhttp padding placement requires a key');
    }
    if (['header', 'queryInHeader'].includes(effectivePlacement) && !effectiveHeader) {
      throw new Error('xhttp padding placement requires a header');
    }
    opts['x-padding-key'] = effectiveKey;
    opts['x-padding-header'] = effectiveHeader;
    opts['x-padding-placement'] = effectivePlacement;
    opts['x-padding-method'] = effectiveMethod;
  }

  const sPlacement = str('sessionIDPlacement') ?? str('sessionPlacement');
  if (sPlacement) {
    if (!['path', 'query', 'header', 'cookie'].includes(sPlacement)) {
      throw new Error('invalid xhttp session placement');
    }
    opts['session-placement'] = sPlacement;
  }
  const sKey = str('sessionIDKey') ?? str('sessionKey');
  if (sKey) opts['session-key'] = sKey;
  const rawSessionTable = str('sessionIDTable');
  const sessionTable =
    rawSessionTable === undefined
      ? undefined
      : (XHTTP_PREDEFINED_SESSION_TABLES[rawSessionTable] ?? rawSessionTable);
  if (sessionTable !== undefined) {
    if (!/^[\x20-\x7e]+$/u.test(sessionTable)) throw new Error('invalid xhttp session table');
    opts['session-table'] = sessionTable;
  }
  const sessionLength = extra['sessionIDLength'];
  if (sessionLength !== undefined && (!rawSessionTable || rawSessionTable === 'uuid')) {
    throw new Error('xhttp session length requires a custom session table');
  }
  if (sessionTable !== undefined && rawSessionTable !== 'uuid') {
    const normalized = normalizeXhttpSessionLength(sessionLength ?? '16-32');
    if (!hasMinimumXhttpSessionSpace(sessionTable.length, normalized.min, normalized.max)) {
      throw new Error('xhttp session table and length provide insufficient identifier space');
    }
    opts['session-length'] = normalized.value;
  }

  const seqP = str('seqPlacement');
  if (seqP) {
    if (!['path', 'query', 'header', 'cookie'].includes(seqP)) {
      throw new Error('invalid xhttp sequence placement');
    }
    opts['seq-placement'] = seqP;
  }
  const seqK = str('seqKey');
  if (seqK) opts['seq-key'] = seqK;
  const udP = str('uplinkDataPlacement');
  if (udP) {
    if (!['body', 'auto', 'header', 'cookie'].includes(udP)) {
      throw new Error('invalid xhttp uplink data placement');
    }
    opts['uplink-data-placement'] = udP;
  }
  const udK = str('uplinkDataKey');
  if (udK) opts['uplink-data-key'] = udK;
  if (sKey && (!sPlacement || sPlacement === 'path')) {
    throw new Error('xhttp session key requires a keyed placement');
  }
  if (seqK && (!seqP || seqP === 'path')) {
    throw new Error('xhttp sequence key requires a keyed placement');
  }
  if (udK && (!udP || !['header', 'cookie'].includes(udP))) {
    throw new Error('xhttp uplink data key requires header or cookie placement');
  }
  if (udP && ['header', 'cookie'].includes(udP) && !udK) {
    throw new Error('xhttp keyed uplink data placement requires a key');
  }
  const ucs = num('uplinkChunkSize');
  if (ucs !== undefined) {
    if (ucs === 0) throw new Error('invalid xhttp uplinkChunkSize');
    if (!udP || !['header', 'cookie'].includes(udP)) {
      throw new Error('xhttp uplink chunk size requires header or cookie placement');
    }
    // Fixed Mihomo decodes XHTTP ranges as strings even when Xray's JSON
    // source uses numbers. A numeric YAML scalar fails provider decoding.
    opts['uplink-chunk-size'] = String(ucs);
  }
  const scMax = num('scMaxEachPostBytes');
  if (scMax !== undefined) {
    if (scMax === 0) throw new Error('invalid xhttp scMaxEachPostBytes');
    opts['sc-max-each-post-bytes'] = String(scMax);
  }
  const scMin = num('scMinPostsIntervalMs');
  if (scMin !== undefined) {
    if (scMin === 0) throw new Error('invalid xhttp scMinPostsIntervalMs');
    opts['sc-min-posts-interval-ms'] = String(scMin);
  }

  const xmux = extra['xmux'];
  if (xmux !== undefined && !isPlainObject(xmux)) throw new Error('invalid xhttp xmux');
  if (isPlainObject(xmux)) {
    const reuse = xmuxToReuse(xmux);
    if (Object.keys(reuse).length > 0) opts['reuse-settings'] = reuse;
  }

  const dsAny = extra['downloadSettings'];
  if (dsAny !== undefined && !isPlainObject(dsAny)) {
    throw new Error('invalid xhttp download settings');
  }
  if (opts.mode === 'stream-one' && isPlainObject(dsAny)) {
    throw new Error('xhttp stream-one cannot use download settings');
  }
  if (isPlainObject(dsAny)) {
    assertOnlyKeys(
      dsAny,
      new Set(['address', 'port', 'security', 'tlsSettings', 'realitySettings', 'xhttpSettings']),
      'xhttp download settings',
    );
    if (Object.keys(dsAny).length === 0) throw new Error('empty xhttp download settings');
    const ds: Record<string, unknown> = {};
    const addr = dsAny['address'];
    if (addr !== undefined) {
      if (typeof addr !== 'string' || addr === '')
        throw new Error('invalid xhttp download address');
      ds['server'] = addr;
    }
    const port = dsAny['port'];
    if (port !== undefined) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('invalid xhttp download port');
      }
      ds['port'] = port;
    }
    const secRaw = dsAny['security'];
    if (secRaw !== undefined && typeof secRaw !== 'string') {
      throw new Error('invalid xhttp download security');
    }
    if (secRaw === '') throw new Error('invalid xhttp download security');
    const sec = typeof secRaw === 'string' ? secRaw.toLowerCase() : '';
    if (sec !== '' && sec !== 'none' && sec !== 'tls' && sec !== 'reality') {
      throw new Error('unsupported xhttp download security');
    }
    const tlsAny = dsAny['tlsSettings'];
    const realityAny = dsAny['realitySettings'];
    if (sec !== 'tls' && sec !== 'reality' && tlsAny !== undefined) {
      throw new Error('xhttp download tls settings require TLS or Reality');
    }
    if (sec !== 'reality' && realityAny !== undefined) {
      throw new Error('xhttp download reality settings require Reality');
    }
    if (sec === 'none') ds['tls'] = false;
    if (sec === 'tls' || sec === 'reality') {
      ds['tls'] = true;
      if (tlsAny !== undefined && !isPlainObject(tlsAny)) {
        throw new Error('invalid xhttp download tls settings');
      }
      if (isPlainObject(tlsAny)) {
        assertOnlyKeys(
          tlsAny,
          new Set(['serverName', 'fingerprint', 'alpn', 'allowInsecure']),
          'xhttp download tls settings',
        );
        if (Object.keys(tlsAny).length === 0) {
          throw new Error('empty xhttp download tls settings');
        }
        const sn = tlsAny['serverName'];
        if (sn !== undefined) {
          if (typeof sn !== 'string' || sn === '') {
            throw new Error('invalid xhttp download server name');
          }
          ds['servername'] = sn;
        }
        const fp = tlsAny['fingerprint'];
        if (fp !== undefined) {
          if (typeof fp !== 'string' || fp === '') {
            throw new Error('invalid xhttp download fingerprint');
          }
          ds['client-fingerprint'] = fp;
        }
        const alpnAny = tlsAny['alpn'];
        if (alpnAny !== undefined) {
          if (
            !Array.isArray(alpnAny) ||
            alpnAny.length === 0 ||
            alpnAny.some((item) => typeof item !== 'string' || item === '')
          ) {
            throw new Error('invalid xhttp download alpn');
          }
          ds['alpn'] = alpnAny;
        }
        const allowInsecure = tlsAny['allowInsecure'];
        if (allowInsecure !== undefined && typeof allowInsecure !== 'boolean') {
          throw new Error('invalid xhttp download certificate policy');
        }
        if (allowInsecure === true) ds['skip-cert-verify'] = true;
      }
      if (sec === 'reality') {
        if (!isPlainObject(realityAny)) throw new Error('missing xhttp download reality settings');
        assertOnlyKeys(
          realityAny,
          new Set(['pbk', 'publicKey', 'sid', 'shortId']),
          'xhttp download reality settings',
        );
        assertNoAliasCollision(
          realityAny,
          [
            ['pbk', 'publicKey'],
            ['sid', 'shortId'],
          ],
          'xhttp download reality settings',
        );
        const pbk = realityAny['pbk'];
        const publicKey = realityAny['publicKey'];
        const pk = pbk ?? publicKey;
        if (typeof pk !== 'string' || !isValidRealityPublicKey(pk)) {
          throw new Error('invalid xhttp download reality public key');
        }
        const fingerprint = isPlainObject(tlsAny) ? tlsAny['fingerprint'] : undefined;
        if (typeof fingerprint !== 'string' || fingerprint === '') {
          throw new Error('missing xhttp download reality fingerprint');
        }
        const realityOpts: Record<string, unknown> = { 'public-key': pk };
        const shortAlias = realityAny['sid'];
        const shortId = realityAny['shortId'];
        const sid = shortAlias ?? shortId;
        if (sid !== undefined) {
          if (typeof sid !== 'string' || !isValidRealityShortId(sid)) {
            throw new Error('invalid xhttp download reality short id');
          }
          if (sid !== '') realityOpts['short-id'] = sid;
        }
        ds['reality-opts'] = realityOpts;
      }
    }
    const xhttpAny = dsAny['xhttpSettings'];
    if (xhttpAny !== undefined && !isPlainObject(xhttpAny)) {
      throw new Error('invalid nested xhttp settings');
    }
    if (isPlainObject(xhttpAny)) {
      assertOnlyKeys(
        xhttpAny,
        new Set(['path', 'host', 'headers', 'extra']),
        'nested xhttp settings',
      );
      if (Object.keys(xhttpAny).length === 0) throw new Error('empty nested xhttp settings');
      const path = xhttpAny['path'];
      if (path !== undefined) {
        if (typeof path !== 'string' || path === '') throw new Error('invalid nested xhttp path');
        ds['path'] = path;
      }
      const host = xhttpAny['host'];
      if (host !== undefined) {
        if (typeof host !== 'string' || host === '') throw new Error('invalid nested xhttp host');
        ds['host'] = host;
      }
      const headers = xhttpAny['headers'];
      if (headers !== undefined) {
        ds['headers'] = normalizeXhttpHeaders(headers, 'nested xhttp headers');
      }
      const dsExtra = xhttpAny['extra'];
      if (dsExtra !== undefined && !isPlainObject(dsExtra)) {
        throw new Error('invalid nested xhttp extra');
      }
      if (isPlainObject(dsExtra)) {
        assertOnlyKeys(dsExtra, new Set(['xmux']), 'nested xhttp extra');
        if (Object.keys(dsExtra).length === 0) throw new Error('empty nested xhttp extra');
        const xmux2 = dsExtra['xmux'];
        if (!isPlainObject(xmux2)) throw new Error('invalid nested xhttp xmux');
        const reuse = xmuxToReuse(xmux2);
        ds['reuse-settings'] = reuse;
      }
    }
    if (Object.keys(ds).length === 0) throw new Error('empty xhttp download mapping');
    opts['download-settings'] = ds;
  }
}

function parseTrojan(uri: string): ClashProxy {
  const u = safeUrl(uri);
  assertNoUriPath(u, 'trojan');
  assertSingleComponentUserinfo(uri, 'trojan');
  const password = safeDecode(u.username);
  if (!password) throw new Error('trojan missing password');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('trojan missing host');
  const port = parsePort(u.port, 443);
  const params = paramsToRecord(u.searchParams);
  assertOnlyKeys(
    params,
    new Set([
      'sni',
      'peer',
      'alpn',
      'allowInsecure',
      'insecure',
      'fp',
      'ech',
      'security',
      'type',
      'path',
      'host',
      'serviceName',
    ]),
    'trojan query',
  );
  // Trojan is TLS by definition; exporters restating `security=tls` add no
  // information. Any other value contradicts the protocol.
  if (Object.hasOwn(params, 'security') && params.security !== 'tls') {
    throw new Error('unsupported trojan security');
  }
  assertNoAliasCollision(
    params,
    [
      ['sni', 'peer'],
      ['allowInsecure', 'insecure'],
    ],
    'trojan query',
  );
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'trojan',
    server: host,
    port,
    password,
    udp: true,
  };
  const sni = params.sni ?? params.peer;
  if (sni !== undefined) {
    if (!sni) throw new Error('invalid trojan server name');
    proxy.sni = sni;
  }
  if (Object.hasOwn(params, 'alpn')) {
    const alpn = splitList(params.alpn);
    if (alpn.length === 0) throw new Error('invalid trojan alpn');
    proxy.alpn = alpn;
  }
  const insecureKey = Object.hasOwn(params, 'allowInsecure') ? 'allowInsecure' : 'insecure';
  if (
    Object.hasOwn(params, insecureKey) &&
    parseZeroOneBoolean(params[insecureKey], 'trojan insecure')
  ) {
    proxy['skip-cert-verify'] = true;
  }
  if (Object.hasOwn(params, 'fp')) {
    if (!params.fp) throw new Error('invalid trojan client fingerprint');
    proxy['client-fingerprint'] = params.fp;
  }
  if (Object.hasOwn(params, 'ech') && params.ech !== '') {
    proxy['ech-opts'] = echQueryToOpts(params.ech, 'trojan');
  }

  const type = params.type ?? 'tcp';
  if (!['tcp', 'ws', 'grpc'].includes(type)) {
    throw new Error('unsupported trojan transport type');
  }
  const transportFields = ['path', 'host', 'serviceName'];
  const allowedTransportFields =
    type === 'ws'
      ? new Set(['path', 'host'])
      : type === 'grpc'
        ? new Set(['serviceName'])
        : new Set();
  if (
    transportFields.some((key) => Object.hasOwn(params, key) && !allowedTransportFields.has(key))
  ) {
    throw new Error('trojan transport option does not match the selected transport');
  }
  if (type !== 'tcp') {
    proxy.network = type;
    if (type === 'ws') {
      const opts: Record<string, unknown> = { path: params.path || '/' };
      if (params.host) opts.headers = { Host: params.host };
      proxy['ws-opts'] = opts;
    } else if (type === 'grpc') {
      proxy['grpc-opts'] = {
        'grpc-service-name': params.serviceName || '',
      };
    }
  }
  return proxy;
}

const HYSTERIA_PROTOCOLS = new Set(['udp', 'wechat-video', 'faketcp']);
const HYSTERIA2_OBFS_MODES = new Set(['salamander', 'gecko']);

function isValidHysteriaSpeed(raw: string): boolean {
  // Mirrors the pinned target's StringToBps grammar. Unitless values are Mbps;
  // explicit units use an uppercase SI prefix and a byte/bit B marker.
  const match = raw.match(/^(\d+)(?:\s*([KMGT]?)([Bb])ps)?$/);
  if (!match) return false;
  const magnitude = Number(match[1]);
  if (!Number.isSafeInteger(magnitude)) return false;
  const prefix = match[2];
  const unit = match[3];
  const factors: Record<string, number> = {
    '': 1,
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
  };
  let bytesPerSecond = magnitude * (unit === undefined ? factors.M : factors[prefix]);
  if (unit === 'b') bytesPerSecond = Math.floor(bytesPerSecond / 8);
  return Number.isSafeInteger(bytesPerSecond) && bytesPerSecond > 0;
}

// Xray's `ech` query value is either a Base64 ECHConfigList or a
// `[queryServerName+]DoH-URL` fetch instruction. Mihomo's ech-opts can only
// carry the literal config; for the DoH form emit enable-only — the core then
// resolves the config over DNS itself, its documented behaviour when `config`
// is absent.
function echQueryToOpts(raw: string, label: string): Record<string, unknown> {
  if (raw.includes('://')) return { enable: true };
  if (!isCanonicalStandardBase64(raw)) throw new Error(`invalid ${label} ech base64`);
  return { enable: true, config: raw };
}

function normalizeSha256Fingerprint(raw: string): string | null {
  const compact = raw.trim().replace(/:/g, '');
  return /^[0-9a-f]{64}$/i.test(compact) ? compact.toLowerCase() : null;
}

function normalizeHysteria2PortSet(
  raw: string,
  field: string,
): { firstPort: number; ports: string } {
  if (!raw || raw.includes(';')) throw new Error(`invalid hysteria2 ${field}`);
  const segments = raw.split(/[,/]/);
  if (segments.length > 28 || segments.some((segment) => segment.length === 0)) {
    throw new Error(`invalid hysteria2 ${field}`);
  }

  let firstPort: number | undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const segment of segments) {
    const match = segment.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`invalid hysteria2 ${field}`);
    const start = parsePort(match[1]);
    if (firstPort === undefined) firstPort = start;
    let end = start;
    if (match[2] !== undefined) {
      end = parsePort(match[2]);
      if (end < start) throw new Error(`invalid hysteria2 ${field} range`);
    }
    ranges.push({ start, end });
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return {
    firstPort: firstPort ?? 443,
    ports: merged
      .map(({ start, end }) => (start === end ? String(start) : `${start}-${end}`))
      .join(','),
  };
}

function countCanonicalPortCandidates(raw: string): number {
  let count = 0;
  for (const segment of raw.split(',')) {
    const [start, end = start] = segment.split('-').map(Number);
    count += end - start + 1;
  }
  return count;
}

function validateUnsignedRange(raw: string, field: string): string {
  const match = raw.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`invalid ${field}`);
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error(`invalid ${field}`);
  }
  return raw;
}

function validateBoundedUnsignedRange(raw: string, field: string, maxValue: number): string {
  const normalized = validateUnsignedRange(raw, field);
  if (unsignedRangeUpper(normalized) > maxValue) throw new Error(`invalid ${field}`);
  return normalized;
}

function parseHysteria(uri: string): ClashProxy {
  const u = safeUrl(uri);
  assertNoUriPath(u, 'hysteria');
  if (u.username || u.password || hasExplicitAuthorityPassword(uri)) {
    throw new Error('hysteria userinfo is unsupported');
  }
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('hysteria missing host');
  const port = parsePort(u.port);
  const params = paramsToRecord(u.searchParams);
  assertOnlyKeys(
    params,
    new Set([
      'auth',
      'auth_str',
      'peer',
      'sni',
      'up',
      'upmbps',
      'down',
      'downmbps',
      'alpn',
      'protocol',
      'obfs',
      'obfsParam',
      'insecure',
    ]),
    'hysteria query',
  );
  assertNoAliasCollision(
    params,
    [
      ['auth', 'auth_str'],
      ['peer', 'sni'],
      ['up', 'upmbps'],
      ['down', 'downmbps'],
    ],
    'hysteria query',
  );
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'hysteria',
    server: host,
    port,
  };
  const auth = params.auth ?? params.auth_str;
  if (auth !== undefined) {
    if (!auth) throw new Error('invalid hysteria auth');
    proxy['auth-str'] = auth;
  }
  const sni = params.peer ?? params.sni;
  if (sni !== undefined) {
    if (!sni) throw new Error('invalid hysteria server name');
    proxy.sni = sni;
  }
  const up = params.up ?? params.upmbps;
  const down = params.down ?? params.downmbps;
  if (!up || !isValidHysteriaSpeed(up)) throw new Error('invalid hysteria upload speed');
  if (!down || !isValidHysteriaSpeed(down)) throw new Error('invalid hysteria download speed');
  proxy.up = up;
  proxy.down = down;
  if (Object.hasOwn(params, 'alpn')) {
    const alpn = splitList(params.alpn);
    if (alpn.length === 0) throw new Error('invalid hysteria alpn');
    proxy.alpn = alpn;
  }
  if (params.protocol) {
    if (!HYSTERIA_PROTOCOLS.has(params.protocol)) throw new Error('invalid hysteria protocol');
    proxy.protocol = params.protocol;
  }
  const hasObfsMode = Object.hasOwn(params, 'obfs');
  const hasObfsPassword = Object.hasOwn(params, 'obfsParam');
  if (hasObfsMode) {
    if (params.obfs !== 'xplus') throw new Error('invalid hysteria obfs mode');
    if (!params.obfsParam) throw new Error('hysteria xplus requires obfsParam');
    proxy.obfs = params.obfsParam;
  } else if (hasObfsPassword) {
    throw new Error('hysteria obfsParam requires obfs=xplus');
  }
  if (
    Object.hasOwn(params, 'insecure') &&
    parseZeroOneBoolean(params.insecure, 'hysteria insecure')
  ) {
    proxy['skip-cert-verify'] = true;
  }
  return proxy;
}

function parseHysteria2(uri: string): ClashProxy {
  // hysteria2:// or hy2://
  // Use a hand-rolled regex (not URL constructor) because Hysteria2 supports
  // port-hopping syntax `host:443,8443-8500` which URL.port rejects as invalid.
  const body = uri.replace(/^(hysteria2|hy2):\/\//i, '');

  // P3-1: The userinfo (password) is OPTIONAL — a bare `hysteria2://host:port`
  // link has no auth — and a password may itself contain '@'. Peel the
  // userinfo off the front by splitting on the LAST '@' that precedes the host
  // section (bounded by the first '?' or '#' so an '@' inside the query or
  // fragment can't be mistaken for the separator). Everything before it is the
  // password; when there's no such '@', there's no auth.
  const cut = body.search(/[?#]/);
  const head = cut === -1 ? body : body.slice(0, cut);
  const atIdx = head.lastIndexOf('@');
  const rawPassword = atIdx === -1 ? '' : body.slice(0, atIdx);
  const rest = atIdx === -1 ? body : body.slice(atIdx + 1);
  // host (: port-or-port-set)? (/)? (? addons)? (# name)?
  // Host is either a bracketed IPv6 literal or anything up to :/?#
  const re =
    /^(\[[^\]]+\]|[^/?#:]+)(?::((?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*))?\/?(?:\?([^#]*))?(?:#(.*))?$/;
  const m = re.exec(rest);
  if (!m) throw new Error('malformed hysteria2 URI');
  const [, rawHost, portSpec, query, frag] = m;
  let host: string;
  try {
    // Reuse WHATWG host parsing for IDNA, percent-decoding, IPv6 validation,
    // and forbidden-host-code-point checks without giving it the port set.
    host = normalizeUriHostname(rawHost);
  } catch {
    throw new Error('invalid hysteria2 host');
  }
  if (!host) throw new Error('hysteria2 missing host');

  // Single port vs port-hopping list
  let port = 443;
  let ports: string | undefined;
  if (portSpec) {
    const normalizedPorts = normalizeHysteria2PortSet(portSpec, 'authority ports');
    port = normalizedPorts.firstPort;
    if (portSpec.includes(',') || portSpec.includes('-')) {
      ports = normalizedPorts.ports;
    }
  }
  const password = safeDecode(rawPassword);
  const name = frag != null ? safeDecode(frag) : `${host}:${port}`;
  const params = parseQueryString(query ?? '', true);
  assertOnlyKeys(
    params,
    new Set([
      'sni',
      'peer',
      'insecure',
      // v2rayN-style exporters reuse their trojan/vless `allowInsecure` key on
      // hysteria2 links; the semantic is identical to the official `insecure`.
      'allowInsecure',
      'obfs',
      'obfs-password',
      'alpn',
      'pinSHA256',
      'ech',
      'fastopen',
      'mport',
      'hop-interval',
      'hop_interval',
      'keepalive',
      'up',
      'upmbps',
      'down',
      'downmbps',
    ]),
    'hysteria2 query',
  );
  assertNoAliasCollision(
    params,
    [
      ['sni', 'peer'],
      ['insecure', 'allowInsecure'],
      ['hop-interval', 'hop_interval'],
      ['up', 'upmbps'],
      ['down', 'downmbps'],
    ],
    'hysteria2 query',
  );

  const proxy: ClashProxy = {
    name,
    type: 'hysteria2',
    server: host,
    port,
    password,
  };
  if (ports) proxy.ports = ports;
  const sni = params.sni ?? params.peer;
  if (sni !== undefined) {
    if (!sni) throw new Error('invalid hysteria2 server name');
    proxy.sni = sni;
  }
  const insecureKey = Object.hasOwn(params, 'insecure') ? 'insecure' : 'allowInsecure';
  if (
    Object.hasOwn(params, insecureKey) &&
    parseBooleanString(params[insecureKey], 'hysteria2 insecure')
  ) {
    proxy['skip-cert-verify'] = true;
  }
  const hasObfsMode = Object.hasOwn(params, 'obfs');
  const hasObfsPassword = Object.hasOwn(params, 'obfs-password');
  if (hasObfsMode && params.obfs !== 'none') {
    if (!HYSTERIA2_OBFS_MODES.has(params.obfs)) throw new Error('invalid hysteria2 obfs mode');
    if (!params['obfs-password']) throw new Error('hysteria2 obfs requires password');
    proxy.obfs = params.obfs;
    proxy['obfs-password'] = params['obfs-password'];
  } else if (hasObfsPassword) {
    throw new Error('hysteria2 obfs password requires a supported mode');
  }
  if (Object.hasOwn(params, 'alpn')) {
    const alpn = splitList(params.alpn);
    if (alpn.length === 0) throw new Error('invalid hysteria2 alpn');
    proxy.alpn = alpn;
  }
  if (Object.hasOwn(params, 'pinSHA256')) {
    const fingerprint = normalizeSha256Fingerprint(params.pinSHA256);
    if (fingerprint === null) throw new Error('invalid hysteria2 certificate fingerprint');
    proxy.fingerprint = fingerprint;
  }
  if (Object.hasOwn(params, 'ech')) {
    if (!isCanonicalStandardBase64(params.ech)) throw new Error('invalid hysteria2 ech base64');
    proxy['ech-opts'] = { enable: true, config: params.ech };
  }
  if (
    Object.hasOwn(params, 'fastopen') &&
    parseBooleanString(params.fastopen, 'hysteria2 fastopen')
  ) {
    proxy.tfo = true;
  }
  if (Object.hasOwn(params, 'mport')) {
    // A single authority port plus `mport` is the common share form (initial
    // connection port + hopping range; Sub-Store maps it to port + ports the
    // same way). Only two competing port SETS are genuinely ambiguous.
    if (portSpec !== undefined && (portSpec.includes(',') || portSpec.includes('-'))) {
      throw new Error('conflicting hysteria2 authority ports and mport');
    }
    proxy.ports = normalizeHysteria2PortSet(params.mport, 'mport').ports;
  }
  const hopInterval = params['hop-interval'] ?? params['hop_interval'];
  if (hopInterval !== undefined) {
    if (proxy.ports === undefined) {
      throw new Error('hysteria2 hop interval requires port hopping');
    }
    proxy['hop-interval'] = validateBoundedUnsignedRange(
      hopInterval,
      'hysteria2 hop interval',
      MAX_SAFE_DURATION_SECONDS,
    );
  }
  if (Object.hasOwn(params, 'keepalive')) {
    throw new Error('hysteria2 keepalive is unsupported by the target');
  }
  const up = params.up ?? params.upmbps;
  if (up !== undefined) {
    if (!isValidHysteriaSpeed(up)) throw new Error('invalid hysteria2 upload speed');
    proxy.up = up;
  }
  const down = params.down ?? params.downmbps;
  if (down !== undefined) {
    if (!isValidHysteriaSpeed(down)) {
      throw new Error('invalid hysteria2 download speed');
    }
    proxy.down = down;
  }
  return proxy;
}

function parseTUIC(uri: string): ClashProxy {
  const u = safeUrl(uri);
  assertNoUriPath(u, 'tuic');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('tuic missing host');
  const port = parsePort(u.port);
  const uuid = safeDecode(u.username);
  const password = safeDecode(u.password);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error('tuic requires a canonical v5 uuid');
  }
  if (!password) throw new Error('tuic v5 requires password');
  const params = paramsToRecord(u.searchParams);
  assertOnlyKeys(
    params,
    new Set([
      'sni',
      'alpn',
      'congestion_control',
      'udp_relay_mode',
      'allow_insecure',
      'insecure',
      'disable_sni',
      'security',
      'version',
    ]),
    'tuic query',
  );
  assertNoAliasCollision(params, [['allow_insecure', 'insecure']], 'tuic query');
  // Some exporters restate protocol invariants as query noise: TUIC is always
  // TLS-over-QUIC, and the uuid:password authority form already pins v5.
  // Accept-ignore the exact invariant values; anything else is a real
  // contradiction.
  if (Object.hasOwn(params, 'security') && params.security !== 'tls') {
    throw new Error('unsupported tuic security');
  }
  if (Object.hasOwn(params, 'version') && params.version !== '5') {
    throw new Error('unsupported tuic version');
  }
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'tuic',
    server: host,
    port,
    uuid,
    password,
  };
  if (Object.hasOwn(params, 'sni')) {
    if (!params.sni) throw new Error('invalid tuic server name');
    proxy.sni = params.sni;
  }
  if (Object.hasOwn(params, 'alpn')) {
    const alpn = splitList(params.alpn);
    if (alpn.length === 0) throw new Error('invalid tuic alpn');
    proxy.alpn = alpn;
  }
  if (Object.hasOwn(params, 'congestion_control')) {
    if (!['cubic', 'new_reno', 'bbr'].includes(params.congestion_control)) {
      throw new Error('invalid tuic congestion controller');
    }
    proxy['congestion-controller'] = params.congestion_control;
  }
  if (Object.hasOwn(params, 'udp_relay_mode')) {
    if (!['native', 'quic'].includes(params.udp_relay_mode)) {
      throw new Error('invalid tuic udp relay mode');
    }
    proxy['udp-relay-mode'] = params.udp_relay_mode;
  }
  let skipCertVerify = false;
  for (const key of ['allow_insecure', 'insecure']) {
    if (Object.hasOwn(params, key)) {
      skipCertVerify = parseZeroOneBoolean(params[key], `tuic ${key}`) || skipCertVerify;
    }
  }
  if (skipCertVerify) proxy['skip-cert-verify'] = true;
  if (
    Object.hasOwn(params, 'disable_sni') &&
    parseZeroOneBoolean(params.disable_sni, 'tuic disable_sni')
  ) {
    proxy['disable-sni'] = true;
  }
  return proxy;
}

function parseSnell(uri: string): ClashProxy {
  const u = safeUrl(uri);
  assertNoUriPath(u, 'snell');
  assertSingleComponentUserinfo(uri, 'snell');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('snell missing host');
  const port = parsePort(u.port);
  const psk = safeDecode(u.username);
  if (!psk) throw new Error('snell missing psk');
  const params = paramsToRecord(u.searchParams);
  assertOnlyKeys(params, new Set(['version', 'obfs', 'obfs-host']), 'snell query');
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'snell',
    server: host,
    port,
    psk,
    version: 1,
  };
  if (Object.hasOwn(params, 'version')) {
    proxy.version = parseBoundedInteger(params.version, 'snell version', 1, 5);
  }
  if (Object.hasOwn(params, 'obfs')) {
    if (!['http', 'tls'].includes(params.obfs)) {
      throw new Error('unsupported snell obfs mode');
    }
    const opts: Record<string, unknown> = { mode: params.obfs };
    if (Object.hasOwn(params, 'obfs-host')) {
      if (!params['obfs-host']) throw new Error('invalid snell obfs host');
      opts.host = params['obfs-host'];
    }
    proxy['obfs-opts'] = opts;
  } else if (Object.hasOwn(params, 'obfs-host')) {
    throw new Error('snell obfs host requires a supported mode');
  }
  return proxy;
}

function parseSocks(uri: string): ClashProxy {
  const u = safeUrl(uri);
  assertNoUriPath(u, 'socks');
  if (hasExplicitQueryDelimiter(uri)) throw new Error('socks URI query is unsupported');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('socks missing host');
  const port = parsePort(u.port);
  let username = '';
  let password = '';
  const explicitPassword = hasExplicitAuthorityPassword(uri);
  if (u.username || u.password || explicitPassword) {
    const decoded = explicitPassword ? null : tryBase64Decode(safeDecode(u.username));
    if (decoded?.includes(':')) {
      const idx = decoded.indexOf(':');
      username = decoded.slice(0, idx);
      password = decoded.slice(idx + 1);
    } else {
      username = safeDecode(u.username);
      password = safeDecode(u.password);
    }
  }
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'socks5',
    server: host,
    port,
    udp: true,
  };
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  return proxy;
}

function hasExplicitAuthorityPassword(uri: string): boolean {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return false;
  const rest = uri.slice(schemeEnd + 3);
  const delimiter = rest.search(/[/?#]/);
  const authority = delimiter === -1 ? rest : rest.slice(0, delimiter);
  const at = authority.lastIndexOf('@');
  return at !== -1 && authority.slice(0, at).includes(':');
}

function assertSingleComponentUserinfo(uri: string, label: string): void {
  if (hasExplicitAuthorityPassword(uri)) {
    throw new Error(`${label} userinfo must contain one percent-encoded component`);
  }
}

function assertNoUriPath(uri: URL, label: string, allowBareSlash = false): void {
  if (allowBareSlash && uri.pathname === '/') return;
  if (uri.pathname !== '') throw new Error(`${label} URI path is unsupported`);
}

function hasExplicitQueryDelimiter(uri: string): boolean {
  const fragment = uri.indexOf('#');
  const head = fragment === -1 ? uri : uri.slice(0, fragment);
  return head.includes('?');
}

function parseAnyTLS(uri: string): ClashProxy {
  // anytls://password@server[:port]?addons#name  — port defaults to 443.
  // A bare "/" before the query is URL-serialisation noise (3x-ui-style
  // generators emit `host:port/?addons` on every link); it carries no routing
  // information, so tolerate exactly that and keep rejecting any longer path.
  const u = safeUrl(uri);
  assertNoUriPath(u, 'anytls', true);
  assertSingleComponentUserinfo(uri, 'anytls');
  const password = safeDecode(u.username);
  if (!password) throw new Error('anytls missing password');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('anytls missing host');
  const port = parsePort(u.port, 443);
  const allowedKeys = new Set([
    'sni',
    'peer',
    'alpn',
    'insecure',
    'fp',
    'udp',
    'tfo',
    'mptcp',
    'idle-session-check-interval',
    'idle-session-timeout',
    'min-idle-session',
    // Accepted-and-ignored exporter noise; see the checks below the loop.
    'group',
    'type',
  ]);
  const params: Record<string, string> = {};
  for (const [rawKey, value] of u.searchParams.entries()) {
    const key = rawKey.replace(/_/g, '-');
    if (!allowedKeys.has(key)) throw new Error('unsupported anytls query parameter');
    if (Object.hasOwn(params, key)) throw new Error(`duplicate anytls query parameter ${key}`);
    params[key] = value;
  }
  assertNoAliasCollision(params, [['sni', 'peer']], 'anytls query');
  // `group` is provider metadata with no Mihomo field (same class as SSR's
  // group, an intentional metadata omission), and `type=tcp` merely restates
  // AnyTLS's fixed TCP session layer. NekoBox-style exporters emit both on
  // every link, so ignore them; any other `type` value is a real conflict.
  if (Object.hasOwn(params, 'type') && params.type !== 'tcp') {
    throw new Error('unsupported anytls transport type');
  }
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'anytls',
    server: host,
    port,
    password,
    udp: true,
  };
  const sni = params.sni ?? params.peer;
  if (sni !== undefined) {
    if (!sni) throw new Error('invalid anytls server name');
    proxy.sni = sni;
  }
  if (Object.hasOwn(params, 'alpn')) {
    const alpn = splitList(params.alpn);
    if (alpn.length === 0) throw new Error('invalid anytls alpn');
    proxy.alpn = alpn;
  }
  if (
    Object.hasOwn(params, 'insecure') &&
    parseZeroOneBoolean(params.insecure, 'anytls insecure')
  ) {
    proxy['skip-cert-verify'] = true;
  }
  if (Object.hasOwn(params, 'fp')) {
    if (!params.fp) throw new Error('invalid anytls client fingerprint');
    proxy['client-fingerprint'] = params.fp;
  }
  for (const key of ['udp', 'tfo', 'mptcp']) {
    if (Object.hasOwn(params, key)) {
      proxy[key] = parseZeroOneBoolean(params[key], `anytls ${key}`);
    }
  }
  for (const key of ['idle-session-check-interval', 'idle-session-timeout']) {
    if (Object.hasOwn(params, key)) {
      proxy[key] = parseBoundedInteger(params[key], `anytls ${key}`, 0, MAX_SAFE_DURATION_SECONDS);
    }
  }
  if (Object.hasOwn(params, 'min-idle-session')) {
    proxy['min-idle-session'] = parseBoundedInteger(
      params['min-idle-session'],
      'anytls min-idle-session',
      0,
      MAX_ANYTLS_IDLE_SESSIONS,
    );
  }
  return proxy;
}

function parseWireGuard(uri: string): ClashProxy {
  // wireguard:// or wg://   format: scheme://privateKey@server[:port]?addons#name
  const normalized = uri.replace(/^wg:\/\//i, 'wireguard://');
  const u = safeUrl(normalized);
  assertNoUriPath(u, 'wireguard');
  assertSingleComponentUserinfo(normalized, 'wireguard');
  const privateKey = safeDecode(u.username);
  if (!privateKey) throw new Error('wireguard missing private-key');
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('wireguard missing host');
  const port = parsePort(u.port, 51820);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'wireguard',
    server: host,
    port,
    udp: true,
  };
  const allowedKeys = new Set([
    'public-key',
    'private-key',
    'address',
    'ip',
    'reserved',
    'mtu',
    'udp',
    'pre-shared-key',
    'persistent-keepalive',
    'workers',
    'refresh-server-ip-interval',
  ]);
  const seen = new Set<string>();
  let localAddressCarrier: 'address' | 'ip' | undefined;
  for (const [rawKey, value] of u.searchParams.entries()) {
    let key = rawKey.toLowerCase().replace(/_/g, '-');
    if (key === 'publickey') key = 'public-key';
    if (key === 'privatekey') key = 'private-key';
    if (['allowed-ips', 'peers', 'dns'].includes(key)) {
      throw new Error(`wireguard flat dialect does not support ${key}`);
    }
    if (!allowedKeys.has(key)) throw new Error('unsupported wireguard query parameter');
    if (seen.has(key)) throw new Error(`duplicate wireguard query parameter ${key}`);
    seen.add(key);

    if (key === 'public-key') {
      proxy['public-key'] = value;
    } else if (key === 'private-key') {
      throw new Error('wireguard private-key query conflicts with authority userinfo');
    } else if (key === 'address' || key === 'ip') {
      if (localAddressCarrier !== undefined) {
        throw new Error('conflicting wireguard local address aliases');
      }
      localAddressCarrier = key;
      const addresses = value.split(',');
      if (addresses.some((address) => address.trim() === '')) {
        throw new Error('invalid wireguard local address');
      }
      for (const address of addresses) applyWireGuardAddress(proxy, address.trim());
    } else if (key === 'reserved') {
      const parts = value.split(',');
      if (
        parts.length !== 3 ||
        parts.some((part) => !/^\d+$/.test(part.trim()) || Number(part.trim()) > 255)
      ) {
        throw new Error('invalid wireguard reserved value');
      }
      proxy.reserved = parts.map((part) => Number(part.trim()));
    } else if (key === 'mtu') {
      proxy.mtu = parseBoundedInteger(value, 'wireguard mtu', 1, 65_535);
    } else if (key === 'udp') {
      proxy[key] = parseZeroOneBoolean(value, `wireguard ${key}`);
    } else if (key === 'persistent-keepalive') {
      proxy[key] = parseBoundedInteger(value, `wireguard ${key}`, 0, 65_535);
    } else if (key === 'workers') {
      proxy[key] = parseBoundedInteger(value, 'wireguard workers', 0, MAX_WIREGUARD_WORKERS);
    } else if (key === 'refresh-server-ip-interval') {
      proxy[key] = parseBoundedInteger(
        value,
        'wireguard refresh-server-ip-interval',
        0,
        MAX_SAFE_DURATION_SECONDS,
      );
    } else if (key === 'pre-shared-key') {
      proxy[key] = value;
    }
  }

  if (!isCanonicalStandardBase64(privateKey, 32)) {
    throw new Error('invalid wireguard private-key');
  }
  const publicKey = proxy['public-key'];
  if (typeof publicKey !== 'string' || !isCanonicalStandardBase64(publicKey, 32)) {
    throw new Error('invalid or missing wireguard public-key');
  }
  const preSharedKey = proxy['pre-shared-key'];
  if (
    preSharedKey !== undefined &&
    (typeof preSharedKey !== 'string' || !isCanonicalStandardBase64(preSharedKey, 32))
  ) {
    throw new Error('invalid wireguard pre-shared-key');
  }
  if (typeof proxy.ip !== 'string' && typeof proxy.ipv6 !== 'string') {
    throw new Error('wireguard missing local address');
  }
  proxy['private-key'] = privateKey;
  return proxy;
}

function applyWireGuardAddress(proxy: ClashProxy, raw: string): void {
  if (!raw) throw new Error('invalid wireguard local address');
  if ((raw.match(/\//g) ?? []).length > 1) throw new Error('invalid wireguard local address');
  const slash = raw.indexOf('/');
  const hostRaw = slash === -1 ? raw : raw.slice(0, slash);
  const cidrRaw = slash === -1 ? '' : raw.slice(slash + 1);
  if (hostRaw.startsWith('[') !== hostRaw.endsWith(']')) {
    throw new Error('invalid wireguard local address');
  }
  const host = hostRaw.replace(/^\[/, '').replace(/\]$/, '');
  if (slash !== -1 && !/^\d+$/.test(cidrRaw)) throw new Error('invalid wireguard local prefix');
  const cidr = slash === -1 ? undefined : Number(cidrRaw);
  if (isIPv4(host)) {
    if (cidr !== undefined && (!Number.isInteger(cidr) || cidr < 0 || cidr > 32)) {
      throw new Error('invalid wireguard IPv4 prefix');
    }
    if (proxy.ip !== undefined) throw new Error('multiple wireguard IPv4 local addresses');
    proxy.ip = cidr === undefined ? host : `${host}/${cidr}`;
  } else if (isIPv6(host)) {
    if (cidr !== undefined && (!Number.isInteger(cidr) || cidr < 0 || cidr > 128)) {
      throw new Error('invalid wireguard IPv6 prefix');
    }
    if (proxy.ipv6 !== undefined) throw new Error('multiple wireguard IPv6 local addresses');
    proxy.ipv6 = cidr === undefined ? host : `${host}/${cidr}`;
  } else {
    throw new Error('invalid wireguard local address');
  }
}

function isIPv4(s: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return false;
  return s.split('.').every((p) => {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return false;
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

function isIPv6(s: string): boolean {
  if (!s.includes(':') || s.includes('%')) return false;
  try {
    return new URL(`http://[${s}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

function parseHttp(uri: string): ClashProxy {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) throw new Error('invalid http proxy URI');
  const rest = uri.slice(schemeEnd + 3);
  const delimiter = rest.search(/[/?#]/);
  const authority = delimiter === -1 ? rest : rest.slice(0, delimiter);
  const suffix = delimiter === -1 ? '' : rest.slice(delimiter);
  if (suffix.startsWith('/')) throw new Error('http proxy URI must not include a path');

  const at = authority.lastIndexOf('@');
  const rawHostPort = at === -1 ? authority : authority.slice(at + 1);
  let rawPort = '';
  if (rawHostPort.startsWith('[')) {
    const match = rawHostPort.match(/^\[[^\]]+\]:(\d+)$/);
    if (match) rawPort = match[1];
  } else {
    const colon = rawHostPort.lastIndexOf(':');
    if (colon > 0) rawPort = rawHostPort.slice(colon + 1);
  }
  if (!rawPort) throw new Error('http proxy requires explicit port');

  const u = safeUrl(uri);
  const host = normalizeUriHostname(u.hostname);
  if (!host) throw new Error('http proxy missing host');
  const port = parsePort(rawPort);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'http',
    server: host,
    port,
  };
  if (u.username) proxy.username = safeDecode(u.username);
  if (u.password) proxy.password = safeDecode(u.password);
  const params = paramsToRecord(u.searchParams);
  assertOnlyKeys(params, new Set(['sni', 'allowInsecure', 'insecure']), 'http proxy query');
  assertNoAliasCollision(params, [['allowInsecure', 'insecure']], 'http proxy query');
  if (u.protocol === 'https:') {
    proxy.tls = true;
    if (params.sni) proxy.sni = params.sni;
    const insecureKey = Object.hasOwn(params, 'allowInsecure') ? 'allowInsecure' : 'insecure';
    if (
      Object.hasOwn(params, insecureKey) &&
      parseZeroOneBoolean(params[insecureKey], 'http proxy insecure')
    ) {
      proxy['skip-cert-verify'] = true;
    }
  }
  // On plain http the TLS query options configure nothing; ignore them.
  return proxy;
}

const PARSERS: Record<string, (uri: string) => ClashProxy> = {
  ss: parseSS,
  ssr: parseSSR,
  vmess: parseVMess,
  vless: parseVLESS,
  trojan: parseTrojan,
  hysteria: parseHysteria,
  hysteria2: parseHysteria2,
  hy2: parseHysteria2,
  tuic: parseTUIC,
  snell: parseSnell,
  anytls: parseAnyTLS,
  wireguard: parseWireGuard,
  wg: parseWireGuard,
  socks: parseSocks,
  socks5: parseSocks,
  http: parseHttp,
  https: parseHttp,
};

/** Registry-derived list used by diagnostics and compatibility inventory. */
export function listSupportedProxyUriSchemes(): string[] {
  return Object.keys(PARSERS);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function splitTag(uri: string): { tag: string; body: string } {
  const idx = uri.indexOf('#');
  if (idx === -1) return { tag: '', body: uri };
  return { tag: safeDecode(uri.slice(idx + 1)), body: uri.slice(0, idx) };
}

function parseQueryString(qs: string, plusAsSpace = false): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) throw new Error('invalid empty query parameter');
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    const key = safeDecode(plusAsSpace ? k.replace(/\+/g, ' ') : k);
    if (!key || Object.hasOwn(out, key)) throw new Error('duplicate or empty query parameter');
    out[key] = safeDecode(plusAsSpace ? v.replace(/\+/g, ' ') : v);
  }
  return out;
}

function normalizeXhttpHeaders(value: unknown, field: string): Record<string, string> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new Error(`invalid ${field}`);
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) ||
      key.toLowerCase() === 'host' ||
      typeof headerValue !== 'string' ||
      /[\r\n]/u.test(headerValue)
    ) {
      throw new Error(`invalid ${field}`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

function unsignedRangeUpper(raw: string): number {
  const separator = raw.indexOf('-');
  return Number(separator === -1 ? raw : raw.slice(separator + 1));
}

function normalizeXhttpSessionLength(value: unknown): { min: number; max: number; value: string } {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string') throw new Error('invalid xhttp sessionIDLength');
  const match = raw.match(/^(\d+)(?:-(\d+))?$/u);
  if (!match) throw new Error('invalid xhttp sessionIDLength');
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < 1 ||
    max < min ||
    max > MAX_XHTTP_SESSION_ID_LENGTH ||
    max - min + 1 > MAX_XHTTP_SESSION_ID_RANGE_CARDINALITY
  ) {
    throw new Error('invalid xhttp sessionIDLength');
  }
  return { min, max, value: min === max ? String(min) : `${min}-${max}` };
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

function paramsToRecord(p: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of p.entries()) {
    if (!k || Object.hasOwn(out, k)) throw new Error('duplicate or empty query parameter');
    out[k] = v;
  }
  return out;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`unsupported ${label} field`);
  }
}

function assertNoAliasCollision(
  value: Record<string, unknown>,
  groups: readonly (readonly string[])[],
  label: string,
): void {
  // Exporters often dump both spellings of an alias pair with the same value
  // (`allowInsecure=0&insecure=0`); only differing values are a real conflict.
  for (const group of groups) {
    const present = group.filter((key) => Object.hasOwn(value, key));
    if (present.length > 1 && new Set(present.map((key) => value[key])).size > 1) {
      throw new Error(`conflicting ${label} aliases`);
    }
  }
}

function parseStrictJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    const document = parseDocument(raw, { schema: 'json', uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('duplicate JSON key');
  } catch {
    throw new Error(`invalid ${label} JSON payload`);
  }
  if (!isPlainObject(parsed)) throw new Error(`invalid ${label} JSON payload`);
  return parsed;
}

const VLESS_QUERY_PARAMETERS = [
  'encryption',
  'security',
  'sni',
  'fp',
  'pcs',
  'alpn',
  'allowInsecure',
  'insecure',
  'pbk',
  'sid',
  'spx',
  'packetEncoding',
  'packet-encoding',
  // Legacy xray QUIC-transport option. Fixed Mihomo has no QUIC stream
  // transport for VLESS (`type=quic` already rejects as an unsupported
  // transport), and NekoBox-style exporters emit `quicSecurity` on every link
  // regardless of the selected transport — so it is accepted and ignored, the
  // same treatment as Reality `spx`.
  'quicSecurity',
  // Xray ECH config (Base64 ECHConfigList or DoH fetch instruction); mapped
  // to Mihomo ech-opts under plain TLS, ignored otherwise.
  'ech',
  // Xray gRPC authority. Mihomo's grpc-opts cannot express it (the target
  // authority falls back to the Host/SNI), so it is accepted and ignored.
  'authority',
  'type',
  'headerType',
  'path',
  'host',
  'method',
  'serviceName',
  'mode',
  'extra',
  'flow',
  'ed',
  'eh',
] as const;

function assertVlessQueryIntegrity(params: URLSearchParams): void {
  const seen = new Set<string>();
  const semanticSeen = new Set<string>();
  const canonicalByLower = new Map(VLESS_QUERY_PARAMETERS.map((key) => [key.toLowerCase(), key]));
  const semanticAliases = new Map([
    ['allowInsecure', 'insecure'],
    ['insecure', 'insecure'],
    ['packetEncoding', 'packet-encoding'],
    ['packet-encoding', 'packet-encoding'],
  ]);
  for (const [key, value] of params) {
    if (seen.has(key)) throw new Error('duplicate vless query parameter');
    seen.add(key);
    const canonical = canonicalByLower.get(key.toLowerCase());
    if (canonical === undefined) throw new Error('unsupported vless query parameter');
    if (key !== canonical) {
      throw new Error('non-canonical vless query parameter casing');
    }
    const semantic = semanticAliases.get(key) ?? key;
    if (semanticSeen.has(semantic)) {
      if (semantic === 'packet-encoding') {
        throw new Error('conflicting vless packet encoding aliases');
      }
      if (semantic === 'insecure') {
        const otherKey = key === 'insecure' ? 'allowInsecure' : 'insecure';
        if (params.get(otherKey) === value) continue;
        throw new Error('conflicting vless insecure aliases');
      }
      throw new Error('conflicting vless query aliases');
    }
    semanticSeen.add(semantic);
  }
}

function safeUrl(uri: string): URL {
  try {
    assertValidPercentEncoding(uri);
    return new URL(uri);
  } catch {
    throw new Error('invalid URI');
  }
}

function parsePort(raw: string, defaultPort?: number): number {
  if (raw === '') {
    if (defaultPort !== undefined) return defaultPort;
    throw new Error('missing port');
  }
  if (!/^\d+$/.test(raw)) throw new Error('invalid port');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid port');
  }
  return port;
}

function parsePortField(value: unknown, field: string): number {
  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`invalid ${field}`);
    raw = String(value);
  } else if (typeof value === 'string') {
    raw = value;
  } else {
    throw new Error(`invalid ${field}`);
  }
  try {
    return parsePort(raw);
  } catch {
    throw new Error(`invalid ${field}`);
  }
}

function readOptionalStringField(
  value: Record<string, unknown>,
  key: string,
  fieldPrefix: string,
): string {
  const field = value[key];
  if (field === undefined || field === null) return '';
  if (typeof field !== 'string') throw new Error(`invalid ${fieldPrefix} ${key}`);
  return field;
}

function decodeStrictBase64(value: string, field: string): string {
  const decoded = decodeCanonicalBase64Utf8(value, false);
  if (decoded === null) throw new Error(`invalid ${field} base64`);
  return decoded;
}

function decodeCanonicalStandardBase64Bytes(value: string): Buffer | null {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? bytes : null;
  } catch {
    return null;
  }
}

function isCanonicalStandardBase64(value: string, expectedBytes?: number): boolean {
  const bytes = decodeCanonicalStandardBase64Bytes(value);
  return bytes !== null && (expectedBytes === undefined || bytes.length === expectedBytes);
}

function parseNonNegativeInteger(raw: string, field: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${field}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${field}`);
  return value;
}

function parseBoundedInteger(raw: string, field: string, min: number, max: number): number {
  const value = parseNonNegativeInteger(raw, field);
  if (value < min || value > max) throw new Error(`invalid ${field}`);
  return value;
}

function parseZeroOneBoolean(raw: string, field: string): boolean {
  if (raw !== '0' && raw !== '1') throw new Error(`invalid ${field}`);
  return raw === '1';
}

function parseBooleanString(raw: string, field: string): boolean {
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`invalid ${field}`);
}

function isValidRealityPublicKey(value: string): boolean {
  // Reality uses an unpadded base64url-encoded 32-byte X25519 public key.
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

function isValidRealityShortId(value: string): boolean {
  return value.length <= 16 && value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

function isValidVlessEncryption(value: string): boolean {
  const parts = value.split('.');
  if (parts.length < 4 || parts[0] !== 'mlkem768x25519plus') return false;
  if (!['native', 'xorpub', 'random'].includes(parts[1])) return false;
  if (parts[2] !== '1rtt' && parts[2] !== '0rtt') return false;

  let keyCount = 0;
  const padding: string[] = [];
  for (const segment of parts.slice(3)) {
    if (segment.length < 20) {
      padding.push(segment);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
    try {
      const decoded = Buffer.from(segment, 'base64url');
      if (decoded.toString('base64url') !== segment) return false;
      if (decoded.length !== 32 && decoded.length !== 1184) return false;
      keyCount += 1;
    } catch {
      return false;
    }
  }
  return keyCount > 0 && isValidVlessEncryptionPadding(padding);
}

function isValidVlessEncryptionPadding(parts: string[]): boolean {
  let maximumLength = 0;
  for (const [index, part] of parts.entries()) {
    const match = part.match(/^(\d+)-(\d+)-(\d+)$/);
    if (!match) return false;
    const values = match.slice(1).map(Number);
    if (values.some((item) => !Number.isSafeInteger(item))) return false;
    if (index === 0 && (values[0] < 100 || values[1] < 35 || values[2] < 35)) return false;
    if (index % 2 === 0) maximumLength += Math.max(values[1], values[2]);
  }
  return maximumLength <= 65553;
}

/**
 * URL.hostname keeps the brackets around IPv6 literals (`[2001:db8::1]`),
 * but Clash/mihomo expects a bare address in the `server` field.
 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * WHATWG does not apply IDNA conversion to hosts of non-special schemes such
 * as `anytls:`. Reparse only the isolated authority host through `http:` so
 * every URI family shares IDNA, IPv6, and forbidden-host-code-point checks.
 */
function normalizeUriHostname(host: string): string {
  try {
    const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return stripBrackets(new URL(`http://${authorityHost}/`).hostname);
  } catch {
    throw new Error('invalid proxy host');
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new Error('invalid percent-encoding');
  }
}

function assertValidPercentEncoding(value: string): void {
  for (let index = value.indexOf('%'); index !== -1; index = value.indexOf('%', index + 1)) {
    if (!/^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      throw new Error('invalid percent-encoding');
    }
  }
}

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Narrow to a non-null, non-array object (a JSON "map"). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function uniqueName(
  base: string,
  used: Set<string>,
  nextSuffixByBase: Map<string, number>,
): string {
  const start = base.length > 0 ? base : 'unnamed';
  if (!used.has(start)) {
    used.add(start);
    return start;
  }
  let i = nextSuffixByBase.get(start) ?? 2;
  while (used.has(`${start} #${i}`)) i++;
  const name = `${start} #${i}`;
  nextSuffixByBase.set(start, i + 1);
  used.add(name);
  return name;
}

function physicalLineCountExceeds(text: string, limit: number): boolean {
  if (text.length === 0) return false;
  let count = 1;
  for (let index = 0; index < text.length - 1; index++) {
    if (text.charCodeAt(index) === 0x0a && ++count > limit) return true;
  }
  return count > limit;
}

function* iteratePhysicalLines(text: string): Generator<readonly [number, string]> {
  if (text.length === 0) return;
  let start = 0;
  let line = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const withoutCarriageReturn = end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
    yield [line, text.slice(start, withoutCarriageReturn)] as const;
    line++;
    if (newline === -1) break;
    start = newline + 1;
  }
}

function describeUriLine(zeroBasedIndex: number, scheme: string): string {
  return `line ${zeroBasedIndex + 1} (${scheme}://)`;
}

function hasUnexpectedControlBytes(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}
