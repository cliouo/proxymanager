import { parseProxyUriList } from '@/lib/proxies/uriToClash';

/**
 * Clash 节点 → 通用分享链接(ss:// vmess:// trojan:// …),供「分发」的
 * Base64 订阅格式使用 —— Shadowrocket / v2rayN 这类只认「每行一条分享链接、
 * 整体 base64」的客户端能直接导入。与 uriToClash 严格互逆:字段名对齐
 * 解析器的映射,每条生成后还会用解析器回验(parse round-trip),回验不过的
 * 节点如实跳过 —— 绝不下发一条生态解析不了的链接。
 *
 * 表达力边界(诚实跳过,不静默降级):
 *   - 没有通用分享链接格式的协议(wireguard / mieru / ssh / direct …)跳过;
 *   - `dialer-proxy` 链式前置在分享链接里无法表达 —— 丢掉它会让节点从
 *     「经前置跳板」静默变成「直连该服务器」,必须跳过;
 *   - 无法映射的字段(未知 ss plugin、非 vision 的 vless flow、xhttp 高级
 *     extra 等)按节点跳过并给出原因。
 */

export interface ShareUriSkip {
  name: string;
  type: string;
  reason: string;
}

export interface ShareUriResult {
  lines: string[];
  skipped: ShareUriSkip[];
}

export interface Base64SubscriptionResult {
  /** base64(每行一条分享链接) —— 空列表时为空串。 */
  content: string;
  /** 成功导出的节点数。 */
  lineCount: number;
  /** 无法表达为分享链接而跳过的节点。 */
  skipped: ShareUriSkip[];
}

/** 节点字段无法映射为分享链接时抛出;message 即跳过原因(可对外展示)。 */
class UnsupportedNodeError extends Error {}

// ────────────────────────────────────────────────────────────────────────────
// 小工具:字段读取、编码
// ────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optStr(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new UnsupportedNodeError(`${key} 字段不是字符串`);
  return v;
}

function needStr(p: Record<string, unknown>, key: string): string {
  const v = optStr(p, key);
  if (!v) throw new UnsupportedNodeError(`缺少 ${key} 字段`);
  return v;
}

function portOf(p: Record<string, unknown>): number {
  const v = p.port;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65_535) {
    throw new UnsupportedNodeError('port 字段不是合法端口');
  }
  return v;
}

/** alpn 在 YAML 里是字符串数组;分享链接统一逗号拼接。 */
function alpnOf(p: Record<string, unknown>): string | undefined {
  const v = p.alpn;
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((item) => typeof item === 'string') && v.length > 0) {
    return (v as string[]).join(',');
  }
  throw new UnsupportedNodeError('alpn 字段不是字符串数组');
}

function nameOf(p: Record<string, unknown>): string {
  return needStr(p, 'name');
}

function b64Standard(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function b64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** IPv6 字面量进 authority 需要方括号。 */
function hostSegment(server: string): string {
  return server.includes(':') ? `[${server}]` : server;
}

type QueryPairs = Array<[string, string]>;

/** 键都是本模块写死的 ASCII,只对值做 percent-encode(空格→%20,+→%2B)。 */
function buildQuery(pairs: QueryPairs): string {
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function assemble(base: string, q: QueryPairs, name: string): string {
  const query = buildQuery(q);
  return `${base}${query ? `?${query}` : ''}#${encodeURIComponent(name)}`;
}

/** ech-opts → 分享链接 `ech=` 值;enable-only(DoH 取回形)无字面配置可写,返回 undefined。 */
function echConfigOf(p: Record<string, unknown>): string | undefined {
  const ech = p['ech-opts'];
  if (ech === undefined) return undefined;
  if (!isRecord(ech)) throw new UnsupportedNodeError('ech-opts 字段形状不合法');
  const config = ech.config;
  if (config === undefined) return undefined;
  if (typeof config !== 'string') throw new UnsupportedNodeError('ech-opts.config 不是字符串');
  return config;
}

/** ws-opts.headers 只能表达 Host 一个键;其它自定义头分享链接写不进去。 */
function wsHostHeaderOf(opts: Record<string, unknown>): string | undefined {
  const headers = opts.headers;
  if (headers === undefined) return undefined;
  if (!isRecord(headers)) throw new UnsupportedNodeError('ws-opts.headers 形状不合法');
  const keys = Object.keys(headers);
  if (keys.length === 0) return undefined;
  if (keys.length > 1 || keys[0] !== 'Host' || typeof headers.Host !== 'string') {
    throw new UnsupportedNodeError('ws 自定义请求头无法写进分享链接');
  }
  return headers.Host;
}

// ────────────────────────────────────────────────────────────────────────────
// 各协议序列化(字段映射与 uriToClash 的对应 parser 严格互逆)
// ────────────────────────────────────────────────────────────────────────────

/** SIP003 值转义:反斜杠与分号(解析侧按 `\` 转义还原)。 */
function escSip003(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;');
}

function sip003PluginValue(plugin: string, optsRaw: unknown): string {
  const opts = optsRaw === undefined ? {} : optsRaw;
  if (!isRecord(opts)) throw new UnsupportedNodeError('plugin-opts 字段形状不合法');
  const seg: string[] = [];
  if (plugin === 'obfs') {
    const mode = opts.mode;
    if (mode !== 'tls' && mode !== 'http') throw new UnsupportedNodeError('obfs 模式不合法');
    seg.push('obfs-local', `obfs=${mode}`);
    if (opts.host !== undefined) {
      if (typeof opts.host !== 'string') throw new UnsupportedNodeError('obfs host 不是字符串');
      seg.push(`obfs-host=${escSip003(opts.host)}`);
    }
    assertOnlyOptKeys(opts, ['mode', 'host'], 'obfs plugin-opts');
  } else if (plugin === 'v2ray-plugin') {
    assertOnlyOptKeys(opts, ['mode', 'tls', 'host', 'path', 'mux'], 'v2ray-plugin plugin-opts');
    if (opts.mode !== undefined && opts.mode !== 'websocket') {
      throw new UnsupportedNodeError('v2ray-plugin 仅支持 websocket 模式');
    }
    seg.push('v2ray-plugin', 'mode=websocket');
    if (opts.tls === true) seg.push('tls');
    if (opts.host !== undefined) {
      if (typeof opts.host !== 'string') throw new UnsupportedNodeError('plugin host 不是字符串');
      seg.push(`host=${escSip003(opts.host)}`);
    }
    if (opts.path !== undefined) {
      if (typeof opts.path !== 'string') throw new UnsupportedNodeError('plugin path 不是字符串');
      seg.push(`path=${escSip003(opts.path)}`);
    }
    if (opts.mux !== undefined) {
      if (typeof opts.mux !== 'boolean') throw new UnsupportedNodeError('plugin mux 不是布尔值');
      seg.push(`mux=${opts.mux ? '1' : '0'}`);
    }
  } else if (plugin === 'shadow-tls') {
    assertOnlyOptKeys(opts, ['host', 'password', 'version'], 'shadow-tls plugin-opts');
    if (typeof opts.host !== 'string' || !opts.host) {
      throw new UnsupportedNodeError('shadow-tls 缺少 host');
    }
    seg.push('shadow-tls', `host=${escSip003(opts.host)}`);
    if (opts.password !== undefined) {
      if (typeof opts.password !== 'string') {
        throw new UnsupportedNodeError('shadow-tls password 不是字符串');
      }
      seg.push(`password=${escSip003(opts.password)}`);
    }
    if (opts.version !== undefined) {
      if (typeof opts.version !== 'number' || ![1, 2, 3].includes(opts.version)) {
        throw new UnsupportedNodeError('shadow-tls version 不合法');
      }
      seg.push(`version=${opts.version}`);
    }
  } else {
    throw new UnsupportedNodeError(`ss 插件 ${plugin} 没有分享链接表示`);
  }
  return seg.join(';');
}

function assertOnlyOptKeys(
  opts: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extra = Object.keys(opts).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new UnsupportedNodeError(`${label} 含无法映射的字段 ${extra.join(', ')}`);
  }
}

function ssUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const cipher = needStr(p, 'cipher');
  const password = optStr(p, 'password') ?? '';
  const q: QueryPairs = [];
  if (p.udp === false) q.push(['udp', '0']);
  if (p.tfo === true) q.push(['tfo', '1']);
  if (p['udp-over-tcp'] === true) q.push(['uot', '1']);
  const plugin = optStr(p, 'plugin');
  if (plugin !== undefined) {
    q.push(['plugin', sip003PluginValue(plugin, p['plugin-opts'])]);
  } else if (p['plugin-opts'] !== undefined) {
    throw new UnsupportedNodeError('plugin-opts 缺少配套 plugin 字段');
  }
  const base = `ss://${b64Url(`${cipher}:${password}`)}@${hostSegment(server)}:${port}`;
  return assemble(base, q, nameOf(p));
}

function ssrUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const protocol = needStr(p, 'protocol');
  const cipher = needStr(p, 'cipher');
  const obfs = needStr(p, 'obfs');
  const password = optStr(p, 'password') ?? '';
  const main = `${server}:${port}:${protocol}:${cipher}:${obfs}:${b64Url(password)}`;
  const params: string[] = [`remarks=${b64Url(nameOf(p))}`];
  const obfsParam = optStr(p, 'obfs-param');
  if (obfsParam) params.push(`obfsparam=${b64Url(obfsParam)}`);
  const protocolParam = optStr(p, 'protocol-param');
  if (protocolParam) params.push(`protoparam=${b64Url(protocolParam)}`);
  return `ssr://${b64Url(`${main}/?${params.join('&')}`)}`;
}

function vmessUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const json: Record<string, string> = {
    v: '2',
    ps: nameOf(p),
    add: server,
    port: String(port),
    id: needStr(p, 'uuid'),
  };
  const alterId = p.alterId ?? 0;
  if (typeof alterId !== 'number' || !Number.isInteger(alterId) || alterId < 0) {
    throw new UnsupportedNodeError('alterId 字段不合法');
  }
  json.aid = String(alterId);
  json.scy = optStr(p, 'cipher') ?? 'auto';

  if (p.tls === true) {
    json.tls = 'tls';
    const sni = optStr(p, 'servername');
    if (sni) json.sni = sni;
    const alpn = alpnOf(p);
    if (alpn) json.alpn = alpn;
    const fp = optStr(p, 'client-fingerprint');
    if (fp) json.fp = fp;
    if (p['skip-cert-verify'] === true) json.insecure = '1';
  }

  const network = optStr(p, 'network') ?? 'tcp';
  if (network === 'tcp') {
    json.net = 'tcp';
  } else if (network === 'http') {
    // HTTP/1.1 头伪装:v2rayN 记法是 net=tcp + type=http。
    json.net = 'tcp';
    json.type = 'http';
    const opts = p['http-opts'];
    if (opts !== undefined) {
      if (!isRecord(opts)) throw new UnsupportedNodeError('http-opts 形状不合法');
      const path = Array.isArray(opts.path) ? opts.path[0] : opts.path;
      if (path !== undefined && typeof path !== 'string') {
        throw new UnsupportedNodeError('http-opts.path 不合法');
      }
      if (path) json.path = path;
      if (isRecord(opts.headers) && Array.isArray(opts.headers.Host)) {
        const host = opts.headers.Host[0];
        if (typeof host === 'string' && host) json.host = host;
      }
    }
  } else if (network === 'ws') {
    const opts = isRecord(p['ws-opts']) ? (p['ws-opts'] as Record<string, unknown>) : {};
    const upgrade = opts['v2ray-http-upgrade'] === true;
    json.net = upgrade ? 'httpupgrade' : 'ws';
    let path = typeof opts.path === 'string' && opts.path ? opts.path : '/';
    if (upgrade) {
      if (opts['v2ray-http-upgrade-fast-open'] === true) path = appendEd(path, 2048);
    } else if (opts['max-early-data'] !== undefined) {
      const ed = opts['max-early-data'];
      if (typeof ed !== 'number' || !Number.isInteger(ed) || ed < 0) {
        throw new UnsupportedNodeError('max-early-data 字段不合法');
      }
      const header = opts['early-data-header-name'];
      if (header !== undefined && header !== 'Sec-WebSocket-Protocol') {
        throw new UnsupportedNodeError('自定义 early-data 头无法写进 vmess 分享链接');
      }
      path = appendEd(path, ed);
    }
    json.path = path;
    const host = wsHostHeaderOf(opts);
    if (host) json.host = host;
  } else if (network === 'h2') {
    json.net = 'h2';
    const opts = isRecord(p['h2-opts']) ? (p['h2-opts'] as Record<string, unknown>) : {};
    json.path = typeof opts.path === 'string' && opts.path ? opts.path : '/';
    if (Array.isArray(opts.host) && typeof opts.host[0] === 'string' && opts.host[0]) {
      json.host = opts.host[0];
    }
  } else if (network === 'grpc') {
    json.net = 'grpc';
    const opts = isRecord(p['grpc-opts']) ? (p['grpc-opts'] as Record<string, unknown>) : {};
    const service = opts['grpc-service-name'];
    if (service !== undefined && typeof service !== 'string') {
      throw new UnsupportedNodeError('grpc-service-name 不是字符串');
    }
    json.path = (service as string | undefined) ?? '';
  } else if (network === 'mkcp') {
    json.net = 'kcp';
    const opts = isRecord(p['mkcp-opts']) ? (p['mkcp-opts'] as Record<string, unknown>) : {};
    if (opts.header !== undefined) {
      if (typeof opts.header !== 'string') throw new UnsupportedNodeError('mkcp header 不合法');
      json.type = opts.header;
    }
    if (opts.seed !== undefined) {
      if (typeof opts.seed !== 'string') throw new UnsupportedNodeError('mkcp seed 不合法');
      json.path = opts.seed;
    }
  } else {
    throw new UnsupportedNodeError(`vmess 传输层 ${network} 无法写进分享链接`);
  }
  return `vmess://${b64Standard(JSON.stringify(json))}`;
}

function appendEd(path: string, ed: number): string {
  return `${path}${path.includes('?') ? '&' : '?'}ed=${ed}`;
}

function vlessUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const uuid = needStr(p, 'uuid');
  const q: QueryPairs = [];

  const encryption = optStr(p, 'encryption');
  if (encryption !== undefined) q.push(['encryption', encryption === '' ? 'none' : encryption]);

  if (p.flow !== undefined) {
    if (p.flow !== 'xtls-rprx-vision') {
      throw new UnsupportedNodeError('非 xtls-rprx-vision 的 flow 无法写进分享链接');
    }
    q.push(['flow', 'xtls-rprx-vision']);
  }

  const reality = p['reality-opts'];
  if (p.tls === true) {
    if (reality !== undefined) {
      if (!isRecord(reality)) throw new UnsupportedNodeError('reality-opts 形状不合法');
      const pbk = reality['public-key'];
      if (typeof pbk !== 'string' || !pbk) {
        throw new UnsupportedNodeError('reality-opts 缺少 public-key');
      }
      q.push(['security', 'reality'], ['pbk', pbk]);
      const sid = reality['short-id'];
      if (sid !== undefined) {
        if (typeof sid !== 'string') throw new UnsupportedNodeError('reality short-id 不合法');
        if (sid) q.push(['sid', sid]);
      }
      // 解析侧 reality 强制要求 fp;缺省补 chrome(mihomo 同款默认)。
      q.push(['fp', optStr(p, 'client-fingerprint') || 'chrome']);
    } else {
      q.push(['security', 'tls']);
      const fp = optStr(p, 'client-fingerprint');
      if (fp) q.push(['fp', fp]);
      const ech = echConfigOf(p);
      if (ech) q.push(['ech', ech]);
    }
    const sni = optStr(p, 'servername');
    if (sni) q.push(['sni', sni]);
    const alpn = alpnOf(p);
    if (alpn) q.push(['alpn', alpn]);
    if (p['skip-cert-verify'] === true) q.push(['allowInsecure', '1']);
    const pin = optStr(p, 'fingerprint');
    if (pin) q.push(['pcs', pin]);
  } else if (reality !== undefined) {
    throw new UnsupportedNodeError('reality-opts 需要 tls=true');
  }

  const packetEncoding = optStr(p, 'packet-encoding');
  if (packetEncoding === 'packetaddr') q.push(['packetEncoding', 'packetaddr']);
  else if (packetEncoding !== undefined && packetEncoding !== 'xudp') {
    throw new UnsupportedNodeError(`packet-encoding ${packetEncoding} 无法写进分享链接`);
  }

  const network = optStr(p, 'network') ?? 'tcp';
  if (network === 'ws') {
    const opts = isRecord(p['ws-opts']) ? (p['ws-opts'] as Record<string, unknown>) : {};
    const upgrade = opts['v2ray-http-upgrade'] === true;
    q.push(['type', upgrade ? 'httpupgrade' : 'ws']);
    const path = typeof opts.path === 'string' && opts.path ? opts.path : '/';
    q.push(['path', path]);
    const host = wsHostHeaderOf(opts);
    if (host) q.push(['host', host]);
    if (upgrade) {
      if (opts['v2ray-http-upgrade-fast-open'] === true) q.push(['ed', '2048']);
    } else if (opts['max-early-data'] !== undefined) {
      const ed = opts['max-early-data'];
      if (typeof ed !== 'number' || !Number.isInteger(ed) || ed < 0) {
        throw new UnsupportedNodeError('max-early-data 字段不合法');
      }
      q.push(['ed', String(ed)]);
      const header = opts['early-data-header-name'];
      if (header !== undefined && header !== 'Sec-WebSocket-Protocol') {
        if (typeof header !== 'string' || !header) {
          throw new UnsupportedNodeError('early-data-header-name 不合法');
        }
        q.push(['eh', header]);
      }
    }
  } else if (network === 'grpc') {
    q.push(['type', 'grpc']);
    const opts = isRecord(p['grpc-opts']) ? (p['grpc-opts'] as Record<string, unknown>) : {};
    const service = opts['grpc-service-name'];
    if (service !== undefined && typeof service !== 'string') {
      throw new UnsupportedNodeError('grpc-service-name 不是字符串');
    }
    if (service) q.push(['serviceName', service]);
  } else if (network === 'h2') {
    // 解析侧 type=http → h2。
    q.push(['type', 'http']);
    const opts = isRecord(p['h2-opts']) ? (p['h2-opts'] as Record<string, unknown>) : {};
    const path = typeof opts.path === 'string' && opts.path ? opts.path : '/';
    q.push(['path', path]);
    if (Array.isArray(opts.host) && opts.host.length > 0) {
      if (!opts.host.every((h) => typeof h === 'string')) {
        throw new UnsupportedNodeError('h2-opts.host 不合法');
      }
      q.push(['host', (opts.host as string[]).join(',')]);
    }
  } else if (network === 'http') {
    // HTTP/1.1 头伪装:type=tcp + headerType=http。
    q.push(['type', 'tcp'], ['headerType', 'http']);
    const opts = isRecord(p['http-opts']) ? (p['http-opts'] as Record<string, unknown>) : {};
    const path = Array.isArray(opts.path) ? opts.path[0] : undefined;
    if (typeof path === 'string' && path && path !== '/') q.push(['path', path]);
    if (typeof opts.method === 'string' && opts.method) q.push(['method', opts.method]);
    if (isRecord(opts.headers) && Array.isArray(opts.headers.Host)) {
      const host = opts.headers.Host[0];
      if (typeof host === 'string' && host) q.push(['host', host]);
    }
  } else if (network === 'xhttp') {
    q.push(['type', 'xhttp']);
    const opts = isRecord(p['xhttp-opts']) ? (p['xhttp-opts'] as Record<string, unknown>) : {};
    // xmux / padding / session 等高级 extra 字段没有稳定的反向映射。
    assertOnlyOptKeys(opts, ['path', 'host', 'mode'], 'xhttp-opts');
    const path = typeof opts.path === 'string' && opts.path ? opts.path : '/';
    q.push(['path', path]);
    if (typeof opts.host === 'string' && opts.host) q.push(['host', opts.host]);
    if (typeof opts.mode === 'string' && opts.mode) q.push(['mode', opts.mode]);
  } else if (network !== 'tcp') {
    throw new UnsupportedNodeError(`vless 传输层 ${network} 无法写进分享链接`);
  }

  const base = `vless://${encodeURIComponent(uuid)}@${hostSegment(server)}:${port}`;
  return assemble(base, q, nameOf(p));
}

function trojanUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const password = needStr(p, 'password');
  const q: QueryPairs = [];
  const sni = optStr(p, 'sni');
  if (sni) q.push(['sni', sni]);
  const alpn = alpnOf(p);
  if (alpn) q.push(['alpn', alpn]);
  if (p['skip-cert-verify'] === true) q.push(['allowInsecure', '1']);
  const fp = optStr(p, 'client-fingerprint');
  if (fp) q.push(['fp', fp]);
  const ech = echConfigOf(p);
  if (ech) q.push(['ech', ech]);

  const network = optStr(p, 'network') ?? 'tcp';
  if (network === 'ws') {
    q.push(['type', 'ws']);
    const opts = isRecord(p['ws-opts']) ? (p['ws-opts'] as Record<string, unknown>) : {};
    const path = typeof opts.path === 'string' && opts.path ? opts.path : '/';
    q.push(['path', path]);
    const host = wsHostHeaderOf(opts);
    if (host) q.push(['host', host]);
  } else if (network === 'grpc') {
    q.push(['type', 'grpc']);
    const opts = isRecord(p['grpc-opts']) ? (p['grpc-opts'] as Record<string, unknown>) : {};
    const service = opts['grpc-service-name'];
    if (typeof service === 'string' && service) q.push(['serviceName', service]);
  } else if (network !== 'tcp') {
    throw new UnsupportedNodeError(`trojan 传输层 ${network} 无法写进分享链接`);
  }

  const base = `trojan://${encodeURIComponent(password)}@${hostSegment(server)}:${port}`;
  return assemble(base, q, nameOf(p));
}

function hysteriaUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const q: QueryPairs = [];
  const auth = optStr(p, 'auth-str');
  if (auth) q.push(['auth', auth]);
  const sni = optStr(p, 'sni');
  if (sni) q.push(['peer', sni]);
  // 解析侧强制 up/down;缺了就是没法出合法链接的节点。
  q.push(['up', needStr(p, 'up')], ['down', needStr(p, 'down')]);
  const alpn = alpnOf(p);
  if (alpn) q.push(['alpn', alpn]);
  const protocol = optStr(p, 'protocol');
  if (protocol) q.push(['protocol', protocol]);
  const obfs = optStr(p, 'obfs');
  if (obfs) q.push(['obfs', 'xplus'], ['obfsParam', obfs]);
  if (p['skip-cert-verify'] === true) q.push(['insecure', '1']);
  return assemble(`hysteria://${hostSegment(server)}:${port}`, q, nameOf(p));
}

function hysteria2Uri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const ports = optStr(p, 'ports');
  // 纯端口跳跃节点(只有 ports 没有 port)是合法 mihomo 形态:authority 直接
  // 写端口集(host:20200-20399),解析侧取首端口为初连端口。有 port 时仍走
  // port + mport 的常见分享形。
  const portsOnly = p.port === undefined && ports !== undefined;
  const authorityPorts = portsOnly ? ports : String(portOf(p));
  const password = optStr(p, 'password') ?? '';
  const q: QueryPairs = [];
  const sni = optStr(p, 'sni');
  if (sni) q.push(['sni', sni]);
  if (p['skip-cert-verify'] === true) q.push(['insecure', '1']);
  const obfs = optStr(p, 'obfs');
  if (obfs) {
    const obfsPassword = optStr(p, 'obfs-password');
    if (!obfsPassword) throw new UnsupportedNodeError('obfs 缺少 obfs-password');
    q.push(['obfs', obfs], ['obfs-password', obfsPassword]);
  }
  const alpn = alpnOf(p);
  if (alpn) q.push(['alpn', alpn]);
  const pin = optStr(p, 'fingerprint');
  if (pin) q.push(['pinSHA256', pin]);
  const ech = echConfigOf(p);
  if (ech) q.push(['ech', ech]);
  if (p.tfo === true) q.push(['fastopen', '1']);
  if (ports && !portsOnly) q.push(['mport', ports]);
  const hopInterval = p['hop-interval'];
  if (hopInterval !== undefined) {
    if (!ports) throw new UnsupportedNodeError('hop-interval 需要 ports');
    q.push(['hop-interval', String(hopInterval)]);
  }
  const up = optStr(p, 'up');
  if (up) q.push(['up', up]);
  const down = optStr(p, 'down');
  if (down) q.push(['down', down]);
  const userinfo = password ? `${encodeURIComponent(password)}@` : '';
  return assemble(`hysteria2://${userinfo}${hostSegment(server)}:${authorityPorts}`, q, nameOf(p));
}

function tuicUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const uuid = needStr(p, 'uuid');
  // tuic:// 分享链接生态(v5)把 uuid 段定义为标准 UUID;mihomo YAML 里塞
  // 任意 token 的节点(有些机场 uuid=password=同一串)没有链接表示。
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new UnsupportedNodeError('tuic uuid 不是标准 UUID,分享链接无法表达');
  }
  const password = needStr(p, 'password');
  const q: QueryPairs = [];
  const sni = optStr(p, 'sni');
  if (sni) q.push(['sni', sni]);
  const alpn = alpnOf(p);
  if (alpn) q.push(['alpn', alpn]);
  const congestion = optStr(p, 'congestion-controller');
  if (congestion) q.push(['congestion_control', congestion]);
  const relayMode = optStr(p, 'udp-relay-mode');
  if (relayMode) q.push(['udp_relay_mode', relayMode]);
  if (p['skip-cert-verify'] === true) q.push(['allow_insecure', '1']);
  if (p['disable-sni'] === true) q.push(['disable_sni', '1']);
  // UUID 是十六进制字节表示,大小写同义;解析侧只认小写规范形。
  const base = `tuic://${uuid.toLowerCase()}:${encodeURIComponent(password)}@${hostSegment(server)}:${port}`;
  return assemble(base, q, nameOf(p));
}

function anytlsUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const password = needStr(p, 'password');
  const q: QueryPairs = [];
  const sni = optStr(p, 'sni');
  if (sni) q.push(['sni', sni]);
  const alpn = alpnOf(p);
  if (alpn) q.push(['alpn', alpn]);
  if (p['skip-cert-verify'] === true) q.push(['insecure', '1']);
  const fp = optStr(p, 'client-fingerprint');
  if (fp) q.push(['fp', fp]);
  for (const key of ['udp', 'tfo', 'mptcp'] as const) {
    if (p[key] !== undefined) {
      if (typeof p[key] !== 'boolean') throw new UnsupportedNodeError(`${key} 字段不合法`);
      q.push([key, p[key] ? '1' : '0']);
    }
  }
  for (const key of ['idle-session-check-interval', 'idle-session-timeout', 'min-idle-session']) {
    const v = p[key];
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new UnsupportedNodeError(`${key} 字段不合法`);
      }
      q.push([key, String(v)]);
    }
  }
  const base = `anytls://${encodeURIComponent(password)}@${hostSegment(server)}:${port}`;
  return assemble(base, q, nameOf(p));
}

function snellUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const psk = needStr(p, 'psk');
  const q: QueryPairs = [];
  const version = p.version;
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 5) {
      throw new UnsupportedNodeError('snell version 不合法');
    }
    q.push(['version', String(version)]);
  }
  const obfsOpts = p['obfs-opts'];
  if (obfsOpts !== undefined) {
    if (!isRecord(obfsOpts)) throw new UnsupportedNodeError('obfs-opts 形状不合法');
    const mode = obfsOpts.mode;
    if (mode !== 'http' && mode !== 'tls') throw new UnsupportedNodeError('snell obfs 模式不合法');
    q.push(['obfs', mode]);
    if (obfsOpts.host !== undefined) {
      if (typeof obfsOpts.host !== 'string' || !obfsOpts.host) {
        throw new UnsupportedNodeError('snell obfs host 不合法');
      }
      q.push(['obfs-host', obfsOpts.host]);
    }
  }
  const base = `snell://${encodeURIComponent(psk)}@${hostSegment(server)}:${port}`;
  return assemble(base, q, nameOf(p));
}

function socksUri(p: Record<string, unknown>): string {
  if (p.tls === true) throw new UnsupportedNodeError('TLS socks5 没有分享链接表示');
  const server = needStr(p, 'server');
  const port = portOf(p);
  const username = optStr(p, 'username') ?? '';
  const password = optStr(p, 'password') ?? '';
  // 恒用 user:pass 冒号形:裸 username 恰好长得像 base64(user:pass) 时,
  // 解析侧会误解码 —— 显式冒号绕开这条歧义路径。
  const userinfo =
    username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  return assemble(`socks5://${userinfo}${hostSegment(server)}:${port}`, [], nameOf(p));
}

function httpUri(p: Record<string, unknown>): string {
  const server = needStr(p, 'server');
  const port = portOf(p);
  const username = optStr(p, 'username') ?? '';
  const password = optStr(p, 'password') ?? '';
  const userinfo =
    username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  const q: QueryPairs = [];
  const tls = p.tls === true;
  if (tls) {
    const sni = optStr(p, 'sni');
    if (sni) q.push(['sni', sni]);
    if (p['skip-cert-verify'] === true) q.push(['insecure', '1']);
  }
  const scheme = tls ? 'https' : 'http';
  return assemble(`${scheme}://${userinfo}${hostSegment(server)}:${port}`, q, nameOf(p));
}

const SERIALIZERS: Record<string, (p: Record<string, unknown>) => string> = {
  ss: ssUri,
  ssr: ssrUri,
  vmess: vmessUri,
  vless: vlessUri,
  trojan: trojanUri,
  hysteria: hysteriaUri,
  hysteria2: hysteria2Uri,
  tuic: tuicUri,
  anytls: anytlsUri,
  snell: snellUri,
  socks5: socksUri,
  http: httpUri,
};

// ────────────────────────────────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────────────────────────────────

/** 逐节点序列化;每条链接再经 parseProxyUriList 回验,不合格的跳过。 */
export function proxiesToShareUris(proxies: Record<string, unknown>[]): ShareUriResult {
  const lines: string[] = [];
  const skipped: ShareUriSkip[] = [];
  for (const proxy of proxies) {
    const name = typeof proxy.name === 'string' ? proxy.name : '(未命名)';
    const type = typeof proxy.type === 'string' ? proxy.type : '(未知类型)';
    const skip = (reason: string) => skipped.push({ name, type, reason });

    if (proxy['dialer-proxy'] !== undefined) {
      skip('链式前置(dialer-proxy)无法写进分享链接,丢掉它会静默变成直连');
      continue;
    }
    const serializer = Object.hasOwn(SERIALIZERS, type) ? SERIALIZERS[type] : undefined;
    if (!serializer) {
      skip(`${type} 协议没有通用分享链接格式`);
      continue;
    }
    let uri: string;
    try {
      uri = serializer(proxy);
    } catch (err) {
      skip(err instanceof UnsupportedNodeError ? err.message : '节点字段无法映射为分享链接');
      continue;
    }
    const roundTrip = parseProxyUriList(uri);
    if (roundTrip.errors.length > 0 || roundTrip.proxies.length !== 1) {
      skip(`生成的链接未通过解析回验:${roundTrip.errors[0]?.error ?? '未知原因'}`);
      continue;
    }
    lines.push(uri);
  }
  return { lines, skipped };
}

/** 分享链接列表 → Base64 订阅正文(v2ray 订阅格式,Shadowrocket / v2rayN 通用)。 */
export function buildBase64Subscription(
  proxies: Record<string, unknown>[],
): Base64SubscriptionResult {
  const { lines, skipped } = proxiesToShareUris(proxies);
  return {
    content: lines.length > 0 ? b64Standard(`${lines.join('\n')}\n`) : '',
    lineCount: lines.length,
    skipped,
  };
}
