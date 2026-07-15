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
  errors: { line: string; error: string }[];
}

const SCHEME_REGEX = /^([a-z][a-z0-9+.-]*):\/\//i;
const KNOWN_SCHEMES = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'hy2',
  'tuic',
  'snell',
  'anytls',
  'wireguard',
  'wg',
  'socks',
  'socks5',
  'http',
  'https',
]);

/** Heuristic: does this text contain at least one recognised proxy URI? */
export function looksLikeProxyUriList(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.match(SCHEME_REGEX);
    if (m && KNOWN_SCHEMES.has(m[1].toLowerCase())) return true;
  }
  return false;
}

/** Decode standard or URL-safe base64. Returns null on malformed input. */
export function tryBase64Decode(s: string): string | null {
  const stripped = s.replace(/\s+/g, '');
  if (!stripped) return null;
  // Quick reject: must be base64-shaped (allow URL-safe variants)
  if (!/^[A-Za-z0-9+/_=-]+$/.test(stripped)) return null;
  // Reject too-short blobs — typical hostnames pass the regex but aren't base64.
  // 4 chars = one base64 quad = ≥1 decoded byte, the practical minimum.
  if (stripped.length < 4) return null;
  const standard = stripped.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    // Reject results that contain control bytes — usually means we decoded
    // a non-base64 string by accident
    if (hasUnexpectedControlBytes(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Main entry: parse a multi-line block of proxy URIs into Clash proxies.
 * Names are de-duplicated by appending `#2`, `#3`, … to collisions.
 */
export function parseProxyUriList(text: string): ParseProxyResult {
  const proxies: ClashProxy[] = [];
  const errors: { line: string; error: string }[] = [];
  const usedNames = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const schemeMatch = line.match(SCHEME_REGEX);
    if (!schemeMatch) continue;
    const scheme = schemeMatch[1].toLowerCase();
    const parser = PARSERS[scheme];
    if (!parser) {
      errors.push({ line: truncate(line), error: `unsupported scheme ${scheme}://` });
      continue;
    }
    try {
      const proxy = parser(line);
      proxy.name = uniqueName(proxy.name || `${proxy.server}:${proxy.port}`, usedNames);
      proxies.push(proxy);
    } catch (err) {
      errors.push({
        line: truncate(line),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { proxies, errors };
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
    host = stripBrackets(hostPort.slice(0, portIdx));
    port = parseInt(hostPort.slice(portIdx + 1), 10);
  } else {
    const userPart = main.slice(0, atIdx);
    let hostPart = main.slice(atIdx + 1);
    // SIP002 allows a trailing '/' before the query; strip it
    if (hostPart.endsWith('/')) hostPart = hostPart.slice(0, -1);
    // P3-2: the base64 userinfo is sometimes percent-encoded (…%2B…%3D), which
    // fails a direct base64 decode. Retry by percent-decoding first, then fall
    // back to a plain percent-decode (already-plain method:password form).
    const decoded =
      tryBase64Decode(userPart) ??
      tryBase64Decode(safeDecode(userPart)) ??
      safeDecode(userPart);
    const colon = decoded.indexOf(':');
    if (colon === -1) throw new Error('missing method:password');
    cipher = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
    const portIdx = hostPart.lastIndexOf(':');
    if (portIdx === -1) throw new Error('missing port');
    host = stripBrackets(hostPart.slice(0, portIdx));
    port = parseInt(hostPart.slice(portIdx + 1), 10);
  }
  if (!Number.isFinite(port) || port <= 0) throw new Error('invalid port');

  const proxy: ClashProxy = {
    name: tag || `${host}:${port}`,
    type: 'ss',
    server: host,
    port,
    cipher,
    password,
    udp: true, // Clash sensible default; ?udp=0 in query will flip it
  };

  if (queryStr) {
    applySsQueryParams(proxy, parseQueryString(queryStr));
  }
  return proxy;
}

/**
 * Apply all the SS query-string addons that real-world airports use.
 * Behaviour (not source) modeled after Sub-Store's URI_SS parser to cover
 * Shadowrocket / Surge / Stash quirks: tls+reality wrapper, transport types
 * including httpupgrade, ws path early-data, Shadowrocket shadow-tls, plugin
 * variants, and the udp/tfo/uot flag triplet.
 */
function applySsQueryParams(proxy: ClashProxy, p: Record<string, string>): void {
  // Flag triplet
  if (p.udp === '0' || p.udp === 'false') proxy.udp = false;
  if (p.tfo === '1' || p.tfo === 'true') proxy.tfo = true;
  if (p.uot === '1' || p.uot === 'true') proxy['udp-over-tcp'] = true;

  // TLS / Reality wrapper
  if (p.security && p.security !== 'none') {
    proxy.tls = true;
    if (p.sni) proxy.sni = p.sni;
    else if (p.peer) proxy.sni = p.peer;
    if (p.alpn) proxy.alpn = splitList(safeDecode(p.alpn));
    if (p.allowInsecure === '1' || p.insecure === '1')
      proxy['skip-cert-verify'] = true;
    if (p.fp) proxy['client-fingerprint'] = p.fp;
    if (p.security === 'reality') {
      const opts: Record<string, unknown> = {};
      if (p.pbk) opts['public-key'] = p.pbk;
      if (p.sid) opts['short-id'] = p.sid;
      proxy['reality-opts'] = opts;
    }
  }

  // Transport (V2Ray-style on SS, often paired with v2ray-plugin)
  if (p.type) {
    const declared = p.type;
    const isHttpUpgrade = declared === 'httpupgrade';
    const network = isHttpUpgrade ? 'ws' : declared;
    proxy.network = network;
    if (network === 'ws' || network === 'h2') {
      const optsKey = `${network}-opts`;
      const opts: Record<string, unknown> = {};
      let pathStr = p.path || '/';
      if (network === 'ws') {
        const { path: cleanedPath, ed } = extractEarlyDataFromPath(pathStr);
        pathStr = cleanedPath;
        if (isHttpUpgrade) {
          opts['v2ray-http-upgrade'] = true;
          if (ed) opts['v2ray-http-upgrade-fast-open'] = true;
        } else if (ed) {
          opts['max-early-data'] = parseInt(ed, 10);
          opts['early-data-header-name'] = 'Sec-WebSocket-Protocol';
        }
      }
      opts.path = pathStr;
      if (p.host) {
        if (network === 'ws') opts.headers = { Host: safeDecode(p.host) };
        else opts.host = splitList(safeDecode(p.host));
      }
      proxy[optsKey] = opts;
    } else if (network === 'grpc') {
      proxy['grpc-opts'] = {
        'grpc-service-name': p.serviceName || '',
      };
    }
  } else if (p.ws === '1' || p.ws === 'true') {
    // Legacy ?ws=1&wspath=…
    proxy.network = 'ws';
    proxy['ws-opts'] = { path: p.wspath || '/' };
  }

  // Plugin (SIP002)
  if (p.plugin) attachSsPlugin(proxy, p.plugin);

  // Shadowrocket: shadow-tls carried in query rather than plugin
  if (p['shadow-tls']) {
    const decoded = tryBase64Decode(p['shadow-tls']);
    if (decoded) {
      try {
        const st = JSON.parse(decoded) as Record<string, unknown>;
        proxy.plugin = 'shadow-tls';
        const opts: Record<string, unknown> = {};
        if (st.host) opts.host = st.host;
        if (st.password) opts.password = st.password;
        if (st.version != null)
          opts.version = parseInt(String(st.version), 10);
        proxy['plugin-opts'] = opts;
        if (st.address) proxy.server = String(st.address);
        if (st.port != null) proxy.port = parseInt(String(st.port), 10);
      } catch {
        /* ignore malformed payload */
      }
    }
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

function attachSsPlugin(proxy: ClashProxy, raw: string): void {
  const [pluginName, ...rest] = raw.split(';');
  const opts: Record<string, unknown> = {};
  for (const seg of rest) {
    const eq = seg.indexOf('=');
    if (eq === -1) {
      opts[seg] = true;
    } else {
      opts[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
  }
  if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
    proxy.plugin = 'obfs';
    const m: Record<string, unknown> = {};
    if (opts.obfs) m.mode = opts.obfs;
    if (opts['obfs-host']) m.host = opts['obfs-host'];
    proxy['plugin-opts'] = m;
  } else if (pluginName === 'v2ray-plugin' || pluginName === 'xray-plugin') {
    proxy.plugin = 'v2ray-plugin';
    const m: Record<string, unknown> = { mode: 'websocket' };
    if (opts.tls != null) m.tls = true;
    if (opts.host) m.host = opts.host;
    if (opts.path) m.path = opts.path;
    if (opts.mux === '1') m.mux = true;
    proxy['plugin-opts'] = m;
  } else if (pluginName === 'shadow-tls') {
    proxy.plugin = 'shadow-tls';
    const m: Record<string, unknown> = {};
    if (opts.host) m.host = opts.host;
    if (opts.password) m.password = opts.password;
    if (opts.version) m.version = parseInt(String(opts.version), 10);
    proxy['plugin-opts'] = m;
  }
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
  const host = stripBrackets(parts.slice(0, -5).join(':'));
  const password = tryBase64Decode(b64password) ?? b64password;
  const params = parseQueryString(queryStr);
  const remarks = params.remarks ? (tryBase64Decode(params.remarks) ?? '') : '';
  return {
    name: remarks || `${host}:${portStr}`,
    type: 'ssr',
    server: host,
    port: parseInt(portStr, 10),
    cipher: method,
    password,
    obfs,
    protocol,
    'obfs-param': params.obfsparam ? (tryBase64Decode(params.obfsparam) ?? '') : '',
    'protocol-param': params.protoparam ? (tryBase64Decode(params.protoparam) ?? '') : '',
    udp: true,
  };
}

function parseVMess(uri: string): ClashProxy {
  const body = uri.slice('vmess://'.length);
  const decoded = tryBase64Decode(body);
  if (!decoded) throw new Error('invalid vmess base64');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(decoded);
  } catch {
    throw new Error('invalid vmess json payload');
  }
  const get = (k: string): string => (json[k] != null ? String(json[k]) : '');
  const server = stripBrackets(get('add'));
  const port = parseInt(get('port'), 10);
  if (!server || !port) throw new Error('vmess missing add/port');

  const proxy: ClashProxy = {
    name: get('ps') || `${server}:${port}`,
    type: 'vmess',
    server,
    port,
    uuid: get('id'),
    alterId: parseInt(get('aid') || '0', 10) || 0,
    cipher: get('scy') || 'auto',
    udp: true,
  };
  // P3-3: some emitters carry a boolean `"tls": true` (or "1") rather than the
  // string "tls"; treat all truthy variants as TLS so a secured node isn't
  // silently downgraded to plaintext.
  if (['tls', 'true', '1'].includes(get('tls').toLowerCase())) {
    proxy.tls = true;
    if (get('sni')) proxy.servername = get('sni');
    if (get('alpn')) proxy.alpn = splitList(get('alpn'));
  }
  // P3-5: mirror the SS ws-opts handling — map `httpupgrade` onto network `ws`
  // with the v2ray-http-upgrade flag, and lift ws early-data (`…?ed=N`) out of
  // the path into max-early-data / early-data-header-name.
  const net = (get('net') || 'tcp').toLowerCase();
  const isHttpUpgrade = net === 'httpupgrade';
  const network = isHttpUpgrade ? 'ws' : net;
  proxy.network = network;
  if (network === 'ws') {
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
    const opts: Record<string, unknown> = { path: get('path') || '/' };
    if (get('host')) opts.host = splitList(get('host'));
    proxy['h2-opts'] = opts;
  } else if (network === 'grpc') {
    proxy['grpc-opts'] = { 'grpc-service-name': get('path') };
  }
  return proxy;
}

function parseVLESS(uri: string): ClashProxy {
  const u = safeUrl(uri);
  const uuid = safeDecode(u.username);
  if (!uuid) throw new Error('vless missing uuid');
  const host = stripBrackets(u.hostname);
  const port = parseInt(u.port, 10);
  if (!host || !port) throw new Error('vless missing host/port');
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'vless',
    server: host,
    port,
    uuid,
    udp: true,
  };
  // mihomo lowercases flow: `vless["flow"] = strings.ToLower(flow)`.
  if (params.flow) proxy.flow = params.flow.toLowerCase();
  // VLESS share links use `encryption=none` as the legacy no-encryption
  // sentinel, while current Meta-Docs represents the same state as an empty
  // YAML value. Preserve real ML-KEM/x25519 encryption strings byte-for-byte.
  // `params` is already single-decoded by URLSearchParams, so do not decode it
  // again here.
  if (params.encryption) {
    proxy.encryption = params.encryption === 'none' ? '' : params.encryption;
  }

  const security = (params.security || 'none').toLowerCase();
  if (security.endsWith('tls') || security === 'reality') {
    proxy.tls = true;
    if (params.sni) proxy.servername = params.sni;
    proxy['client-fingerprint'] = params.fp || 'chrome';
    if (params.pcs) proxy.fingerprint = params.pcs;
    if (params.alpn) proxy.alpn = splitList(params.alpn);
    if (params.allowInsecure === '1' || params.insecure === '1')
      proxy['skip-cert-verify'] = true;
    if (security === 'reality' && params.pbk) {
      const opts: Record<string, unknown> = {};
      opts['public-key'] = params.pbk;
      if (params.sid) opts['short-id'] = params.sid;
      proxy['reality-opts'] = opts;
    }
  }

  // Preserve mihomo share-link semantics but emit the canonical current YAML
  // field. `xudp` / `packet-addr` remain accepted legacy aliases in the core;
  // Meta-Docs uses packet-encoding: xudp|packetaddr.
  if (params.packetEncoding === 'packet' || params.packetEncoding === 'packetaddr') {
    proxy['packet-encoding'] = 'packetaddr';
  } else if (params.packetEncoding !== 'none') {
    proxy['packet-encoding'] = 'xudp';
  }

  // Transport. mihomo common/convert/v.go lowercases `type`, then remaps
  // `type=http` → h2 (HTTP/2) and `type=tcp` + `headerType=http` → http
  // (HTTP/1.1 obfs over TCP) before switching on the network.
  let network = (params.type || 'tcp').toLowerCase();
  const headerType = (params.headerType || '').toLowerCase();
  if (network === 'tcp' && headerType === 'http') network = 'http';
  else if (network === 'http') network = 'h2';
  proxy.network = network;
  if (network === 'ws') {
    const opts: Record<string, unknown> = { path: params.path || '/' };
    if (params.host) opts.headers = { Host: params.host };
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
    if (params.mode) opts.mode = params.mode;
    // Advanced xray `extra` JSON → xmux / padding / session / download-settings.
    // mihomo only applies it when the JSON parses cleanly (`if err == nil`).
    if (params.extra) {
      try {
        const parsed: unknown = JSON.parse(params.extra);
        if (isPlainObject(parsed)) applyXHTTPExtra(parsed, opts);
      } catch {
        /* malformed extra JSON — ignore, matching mihomo's err guard */
      }
    }
    proxy['xhttp-opts'] = opts;
  }
  return proxy;
}

/**
 * Faithful port of mihomo `common/convert/v.go` parseXHTTPExtra: map an
 * xray-core XHTTP `extra` JSON object onto mihomo `xhttp-opts` fields. Only
 * keys with a stable mihomo mapping are copied; unknown keys are ignored.
 * Values come from JSON.parse, so numbers are JS numbers and maps are objects.
 */
function applyXHTTPExtra(extra: Record<string, unknown>, opts: Record<string, unknown>): void {
  const str = (k: string): string | undefined => {
    const v = extra[k];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = extra[k];
    return typeof v === 'number' ? v : undefined;
  };
  // xmux map → reuse-settings (string kept if non-empty; number → decimal string)
  const xmuxToReuse = (xmux: Record<string, unknown>): Record<string, unknown> => {
    const reuse: Record<string, unknown> = {};
    const set = (src: string, dst: string): void => {
      const v = xmux[src];
      if (typeof v === 'string') {
        if (v !== '') reuse[dst] = v;
      } else if (typeof v === 'number') {
        reuse[dst] = String(Math.trunc(v));
      }
    };
    set('maxConnections', 'max-connections');
    set('maxConcurrency', 'max-concurrency');
    set('cMaxReuseTimes', 'c-max-reuse-times');
    set('hMaxRequestTimes', 'h-max-request-times');
    set('hMaxReusableSecs', 'h-max-reusable-secs');
    const keepAlive = xmux['hKeepAlivePeriod'];
    if (typeof keepAlive === 'number') reuse['h-keep-alive-period'] = Math.trunc(keepAlive);
    return reuse;
  };

  if (extra['noGRPCHeader'] === true) opts['no-grpc-header'] = true;
  const xpb = str('xPaddingBytes');
  if (xpb) opts['x-padding-bytes'] = xpb;
  if (typeof extra['xPaddingObfsMode'] === 'boolean')
    opts['x-padding-obfs-mode'] = extra['xPaddingObfsMode'];
  const xpk = str('xPaddingKey');
  if (xpk) opts['x-padding-key'] = xpk;
  const xph = str('xPaddingHeader');
  if (xph) opts['x-padding-header'] = xph;
  const xpp = str('xPaddingPlacement');
  if (xpp) opts['x-padding-placement'] = xpp;
  const xpm = str('xPaddingMethod');
  if (xpm) opts['x-padding-method'] = xpm;
  const uhm = str('uplinkHttpMethod');
  if (uhm) opts['uplink-http-method'] = uhm;

  const sPlacement = str('sessionIDPlacement') ?? str('sessionPlacement');
  if (sPlacement) opts['session-placement'] = sPlacement;
  const sKey = str('sessionIDKey') ?? str('sessionKey');
  if (sKey) opts['session-key'] = sKey;
  const sTable = str('sessionIDTable');
  if (sTable) opts['session-table'] = sTable;
  const sLenStr = str('sessionIDLength');
  if (sLenStr) opts['session-length'] = sLenStr;
  else {
    const sLenNum = num('sessionIDLength');
    if (sLenNum !== undefined) opts['session-length'] = String(Math.trunc(sLenNum));
  }

  const seqP = str('seqPlacement');
  if (seqP) opts['seq-placement'] = seqP;
  const seqK = str('seqKey');
  if (seqK) opts['seq-key'] = seqK;
  const udP = str('uplinkDataPlacement');
  if (udP) opts['uplink-data-placement'] = udP;
  const udK = str('uplinkDataKey');
  if (udK) opts['uplink-data-key'] = udK;
  const ucs = num('uplinkChunkSize');
  if (ucs !== undefined) opts['uplink-chunk-size'] = Math.trunc(ucs);
  const scMax = num('scMaxEachPostBytes');
  if (scMax !== undefined) opts['sc-max-each-post-bytes'] = Math.trunc(scMax);
  const scMin = num('scMinPostsIntervalMs');
  if (scMin !== undefined) opts['sc-min-posts-interval-ms'] = Math.trunc(scMin);

  const xmux = extra['xmux'];
  if (isPlainObject(xmux)) {
    const reuse = xmuxToReuse(xmux);
    if (Object.keys(reuse).length > 0) opts['reuse-settings'] = reuse;
  }

  const dsAny = extra['downloadSettings'];
  if (isPlainObject(dsAny)) {
    const ds: Record<string, unknown> = {};
    const addr = dsAny['address'];
    if (typeof addr === 'string' && addr !== '') ds['server'] = addr;
    const port = dsAny['port'];
    if (typeof port === 'number') ds['port'] = Math.trunc(port);
    const secRaw = dsAny['security'];
    const sec = typeof secRaw === 'string' ? secRaw.toLowerCase() : '';
    if (sec === 'tls' || sec === 'reality') {
      ds['tls'] = true;
      const tlsAny = dsAny['tlsSettings'];
      if (isPlainObject(tlsAny)) {
        const sn = tlsAny['serverName'];
        if (typeof sn === 'string' && sn !== '') ds['servername'] = sn;
        const fp = tlsAny['fingerprint'];
        if (typeof fp === 'string' && fp !== '') ds['client-fingerprint'] = fp;
        const alpnAny = tlsAny['alpn'];
        if (Array.isArray(alpnAny)) {
          const alpnList = alpnAny.filter((a): a is string => typeof a === 'string');
          if (alpnList.length > 0) ds['alpn'] = alpnList;
        }
        if (tlsAny['allowInsecure'] === true) ds['skip-cert-verify'] = true;
      }
      if (sec === 'reality') {
        const realityAny = dsAny['realitySettings'];
        if (isPlainObject(realityAny)) {
          const realityOpts: Record<string, unknown> = {};
          const pk = realityAny['publicKey'];
          if (typeof pk === 'string' && pk !== '') realityOpts['public-key'] = pk;
          const sid = realityAny['shortId'];
          if (typeof sid === 'string' && sid !== '') realityOpts['short-id'] = sid;
          if (Object.keys(realityOpts).length > 0) ds['reality-opts'] = realityOpts;
        }
      }
    }
    const xhttpAny = dsAny['xhttpSettings'];
    if (isPlainObject(xhttpAny)) {
      const path = xhttpAny['path'];
      if (typeof path === 'string' && path !== '') ds['path'] = path;
      const host = xhttpAny['host'];
      if (typeof host === 'string' && host !== '') ds['host'] = host;
      const headers = xhttpAny['headers'];
      if (isPlainObject(headers) && Object.keys(headers).length > 0) ds['headers'] = headers;
      const dsExtra = xhttpAny['extra'];
      if (isPlainObject(dsExtra)) {
        const xmux2 = dsExtra['xmux'];
        if (isPlainObject(xmux2)) {
          const reuse = xmuxToReuse(xmux2);
          if (Object.keys(reuse).length > 0) ds['reuse-settings'] = reuse;
        }
      }
    }
    if (Object.keys(ds).length > 0) opts['download-settings'] = ds;
  }
}

function parseTrojan(uri: string): ClashProxy {
  const u = safeUrl(uri);
  const password = safeDecode(u.username);
  if (!password) throw new Error('trojan missing password');
  const host = stripBrackets(u.hostname);
  const port = parseInt(u.port, 10) || 443;
  if (!host) throw new Error('trojan missing host');
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'trojan',
    server: host,
    port,
    password,
    udp: true,
  };
  if (params.sni) proxy.sni = params.sni;
  else if (params.peer) proxy.sni = params.peer;
  if (params.alpn) proxy.alpn = splitList(params.alpn);
  if (params.allowInsecure === '1' || params.insecure === '1')
    proxy['skip-cert-verify'] = true;
  if (params.fp) proxy['client-fingerprint'] = params.fp;

  const type = params.type;
  if (type && type !== 'tcp') {
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

function parseHysteria(uri: string): ClashProxy {
  const u = safeUrl(uri);
  const host = stripBrackets(u.hostname);
  const port = parseInt(u.port, 10);
  if (!host || !port) throw new Error('hysteria missing host/port');
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'hysteria',
    server: host,
    port,
  };
  const auth = params.auth || params.auth_str;
  if (auth) proxy['auth-str'] = auth;
  if (params.peer || params.sni) proxy.sni = params.peer || params.sni;
  const up = params.up || params.upmbps;
  const down = params.down || params.downmbps;
  if (up) proxy.up = up;
  if (down) proxy.down = down;
  if (params.alpn) proxy.alpn = splitList(params.alpn);
  if (params.protocol) proxy.protocol = params.protocol;
  if (params.obfs) proxy.obfs = params.obfs;
  if (params.insecure === '1') proxy['skip-cert-verify'] = true;
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
    /^(\[[^\]]+\]|[^/?#:]+)(?::((?:\d+(?:-\d+)?)(?:[,;]\d+(?:-\d+)?)*))?\/?(?:\?([^#]*))?(?:#(.*))?$/;
  const m = re.exec(rest);
  if (!m) throw new Error('malformed hysteria2 URI');
  const [, rawHost, portSpec, query, frag] = m;
  const host = stripBrackets(rawHost);
  if (!host) throw new Error('hysteria2 missing host');

  // Single port vs port-hopping list
  let port = 443;
  let ports: string | undefined;
  if (portSpec) {
    if (/^\d+$/.test(portSpec)) {
      const n = parseInt(portSpec, 10);
      if (Number.isFinite(n) && n > 0) port = n;
    } else {
      ports = portSpec;
      // Take the first numeric port as the canonical `port`
      const firstNum = portSpec.match(/^\d+/);
      if (firstNum) port = parseInt(firstNum[0], 10);
    }
  }
  const password = safeDecode(rawPassword);
  const name = frag != null ? safeDecode(frag) : `${host}:${port}`;
  const params = parseQueryString(query ?? '');

  const proxy: ClashProxy = {
    name,
    type: 'hysteria2',
    server: host,
    port,
    password,
  };
  if (ports) proxy.ports = ports;
  if (params.sni) proxy.sni = params.sni;
  else if (params.peer) proxy.sni = params.peer;
  if (/^(1|true)$/i.test(params.insecure ?? '')) proxy['skip-cert-verify'] = true;
  if (params.obfs && params.obfs !== 'none') proxy.obfs = params.obfs;
  if (params['obfs-password']) proxy['obfs-password'] = params['obfs-password'];
  if (params.alpn) proxy.alpn = splitList(params.alpn);
  if (params.pinSHA256) proxy.fingerprint = params.pinSHA256;
  if (/^(1|true)$/i.test(params.fastopen ?? '')) proxy.tfo = true;
  // ?mport is an alternative carrier for port-hopping; the in-URI port set
  // is authoritative when both are present
  if (params.mport && !ports) proxy.ports = params.mport;
  const hopInterval = params['hop-interval'] ?? params['hop_interval'];
  if (hopInterval) proxy['hop-interval'] = hopInterval;
  if (params.keepalive && /^\d+$/.test(params.keepalive))
    proxy.keepalive = parseInt(params.keepalive, 10);
  if (params.upmbps) proxy.up = params.upmbps;
  if (params.downmbps) proxy.down = params.downmbps;
  return proxy;
}

function parseTUIC(uri: string): ClashProxy {
  const u = safeUrl(uri);
  const host = stripBrackets(u.hostname);
  const port = parseInt(u.port, 10);
  if (!host || !port) throw new Error('tuic missing host/port');
  const uuid = safeDecode(u.username);
  const password = safeDecode(u.password);
  if (!uuid) throw new Error('tuic missing uuid');
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'tuic',
    server: host,
    port,
    uuid,
    password,
  };
  if (params.sni) proxy.sni = params.sni;
  if (params.alpn) proxy.alpn = splitList(params.alpn);
  if (params.congestion_control)
    proxy['congestion-controller'] = params.congestion_control;
  if (params.udp_relay_mode) proxy['udp-relay-mode'] = params.udp_relay_mode;
  if (params.allow_insecure === '1' || params.insecure === '1')
    proxy['skip-cert-verify'] = true;
  if (params.disable_sni === '1') proxy['disable-sni'] = true;
  return proxy;
}

function parseSnell(uri: string): ClashProxy {
  const u = safeUrl(uri);
  const host = stripBrackets(u.hostname);
  const port = parseInt(u.port, 10);
  if (!host || !port) throw new Error('snell missing host/port');
  const psk = safeDecode(u.username);
  if (!psk) throw new Error('snell missing psk');
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'snell',
    server: host,
    port,
    psk,
  };
  if (params.version) proxy.version = parseInt(params.version, 10);
  if (params.obfs) {
    const opts: Record<string, unknown> = { mode: params.obfs };
    if (params['obfs-host']) opts.host = params['obfs-host'];
    proxy['obfs-opts'] = opts;
  }
  return proxy;
}

function parseSocks(uri: string): ClashProxy {
  const u = safeUrl(uri);
  const host = stripBrackets(u.hostname);
  const port = parseInt(u.port, 10);
  if (!host || !port) throw new Error('socks missing host/port');
  let username = '';
  let password = '';
  if (u.username) {
    const decoded = tryBase64Decode(safeDecode(u.username));
    if (decoded && decoded.includes(':')) {
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

// P3-4: query addons carry a type — a bare string passthrough turns `?tfo=true`
// into the string "true" and numeric knobs into strings, so mihomo sees the
// wrong YAML scalar. Coerce the well-known typed keys (grounded in mihomo's
// BasicOption / WireGuardOption fields); leave genuinely-unknown keys as raw
// strings so we never invent a mapping.
const BOOL_ADDON_KEYS = new Set([
  'tfo',
  'mptcp',
  'udp',
  'skip-cert-verify',
  'remote-dns-resolve',
]);
const NUM_ADDON_KEYS = new Set(['persistent-keepalive']);

function coerceAddonValue(key: string, value: string): unknown {
  if (BOOL_ADDON_KEYS.has(key)) return /^(1|true)$/i.test(value);
  if (NUM_ADDON_KEYS.has(key)) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function parseAnyTLS(uri: string): ClashProxy {
  // anytls://password@server[:port]?addons#name  — port defaults to 443
  const u = safeUrl(uri);
  const password = safeDecode(u.username);
  if (!password) throw new Error('anytls missing password');
  const host = stripBrackets(u.hostname);
  if (!host) throw new Error('anytls missing host');
  const port = parseInt(u.port, 10) || 443;
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'anytls',
    server: host,
    port,
    password,
    udp: true,
  };
  if (params.sni) proxy.sni = params.sni;
  else if (params.peer) proxy.sni = params.peer;
  if (params.alpn) proxy.alpn = splitList(params.alpn);
  if (/^(1|true)$/i.test(params.insecure ?? '')) proxy['skip-cert-verify'] = true;
  if (params.fp) proxy['client-fingerprint'] = params.fp;
  if (/^(0|false)$/i.test(params.udp ?? '')) proxy.udp = false;
  // Pass-through for mihomo-specific timing knobs and any custom addon, with
  // `_` → `-` normalisation (Sub-Store-style URI convention)
  const handled = new Set(['sni', 'peer', 'alpn', 'insecure', 'fp', 'udp']);
  for (const [rawKey, value] of Object.entries(params)) {
    if (!value || handled.has(rawKey)) continue;
    const key = rawKey.replace(/_/g, '-');
    if (key in proxy) continue;
    proxy[key] = coerceAddonValue(key, value); // P3-4: type-coerce known keys
  }
  return proxy;
}

function parseWireGuard(uri: string): ClashProxy {
  // wireguard:// or wg://   format: scheme://privateKey@server[:port]?addons#name
  const normalized = uri.replace(/^wg:\/\//i, 'wireguard://');
  const u = safeUrl(normalized);
  const privateKey = safeDecode(u.username);
  if (!privateKey) throw new Error('wireguard missing private-key');
  const host = stripBrackets(u.hostname);
  if (!host) throw new Error('wireguard missing host');
  const port = parseInt(u.port, 10) || 51820;
  const params = paramsToRecord(u.searchParams);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${port}`,
    type: 'wireguard',
    server: host,
    port,
    'private-key': privateKey,
    udp: true,
  };
  for (const [rawKey, value] of Object.entries(params)) {
    if (!value) continue;
    const key = rawKey.replace(/_/g, '-');
    if (key === 'reserved') {
      const parts = value
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n));
      if (parts.length === 3) proxy.reserved = parts;
    } else if (key === 'address' || key === 'ip') {
      for (const addr of value.split(',')) applyWireGuardAddress(proxy, addr.trim());
    } else if (key === 'mtu') {
      const n = parseInt(value, 10);
      if (Number.isInteger(n)) proxy.mtu = n;
    } else if (/^public-?key$/i.test(rawKey)) {
      proxy['public-key'] = value;
    } else if (/^private-?key$/i.test(rawKey)) {
      proxy['private-key'] = value;
    } else if (key === 'udp') {
      proxy.udp = /^(1|true)$/i.test(value);
    } else if (!(key in proxy) && key !== 'flag') {
      proxy[key] = coerceAddonValue(key, value); // P3-4: type-coerce known keys
    }
  }
  return proxy;
}

function applyWireGuardAddress(proxy: ClashProxy, raw: string): void {
  if (!raw) return;
  const slash = raw.indexOf('/');
  const hostRaw = slash === -1 ? raw : raw.slice(0, slash);
  const cidrRaw = slash === -1 ? '' : raw.slice(slash + 1);
  const host = hostRaw.replace(/^\[/, '').replace(/\]$/, '');
  const cidr = cidrRaw && /^\d+$/.test(cidrRaw) ? parseInt(cidrRaw, 10) : null;
  if (isIPv4(host)) {
    proxy.ip = host;
    if (cidr != null && cidr >= 0 && cidr <= 32) proxy['ip-cidr'] = cidr;
  } else if (host.includes(':')) {
    proxy.ipv6 = host;
    if (cidr != null && cidr >= 0 && cidr <= 128) proxy['ipv6-cidr'] = cidr;
  }
}

function isIPv4(s: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return false;
  return s.split('.').every((p) => {
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

function parseHttp(uri: string): ClashProxy {
  const u = safeUrl(uri);
  // Reject regular URLs (with a path) first — they're almost certainly not
  // a proxy address but a subscription/landing URL the user pasted by mistake
  if (u.pathname && u.pathname !== '/' && u.pathname !== '') {
    throw new Error('http proxy URI must not include a path');
  }
  if (!u.port) throw new Error('http proxy requires explicit port');
  const host = stripBrackets(u.hostname);
  const proxy: ClashProxy = {
    name: safeDecode(u.hash.slice(1)) || `${host}:${u.port}`,
    type: 'http',
    server: host,
    port: parseInt(u.port, 10),
  };
  if (u.username) proxy.username = safeDecode(u.username);
  if (u.password) proxy.password = safeDecode(u.password);
  if (u.protocol === 'https:') proxy.tls = true;
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

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function splitTag(uri: string): { tag: string; body: string } {
  const idx = uri.indexOf('#');
  if (idx === -1) return { tag: '', body: uri };
  return { tag: safeDecode(uri.slice(idx + 1)), body: uri.slice(0, idx) };
}

function parseQueryString(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    out[safeDecode(k)] = safeDecode(v);
  }
  return out;
}

function paramsToRecord(p: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of p.entries()) out[k] = v;
  return out;
}

function safeUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch (e) {
    throw new Error(`invalid URI: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * URL.hostname keeps the brackets around IPv6 literals (`[2001:db8::1]`),
 * but Clash/mihomo expects a bare address in the `server` field.
 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
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

function uniqueName(base: string, used: Set<string>): string {
  const start = base.length > 0 ? base : 'unnamed';
  if (!used.has(start)) {
    used.add(start);
    return start;
  }
  let i = 2;
  while (used.has(`${start} #${i}`)) i++;
  const name = `${start} #${i}`;
  used.add(name);
  return name;
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function hasUnexpectedControlBytes(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}
