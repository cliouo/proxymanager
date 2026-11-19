type Node = Record<string, unknown>;
export type ClientCore = 'sing-box' | 'xray';
export interface ClientMapping {
  config?: Node;
  reason?: string;
  notes: string[];
  gaps: string[];
}

class Unsupported extends Error {}
const object = (value: unknown): Node =>
  value && typeof value === 'object' ? (value as Node) : {};
const text = (value: unknown) => (value === undefined ? '' : String(value));
const fail = (reason: string): never => {
  throw new Unsupported(reason);
};

function fields(value: Node, allowed: string[], prefix: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    fail(`${prefix}: unmapped fields ${unknown.join(', ')} (harness coverage limit)`);
}

function bandwidth(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const match = text(value).match(/^(\d+(?:\.\d+)?)\s*(?:(k|m|g)?bps)?$/i);
  if (!match) return fail('bandwidth unit not mapped by harness');
  return Number(match[1]) * ({ k: 0.001, m: 1, g: 1000 }[match[2]?.toLowerCase() ?? 'm'] ?? 1);
}

function transport(p: Node, core: ClientCore, notes: string[]): Node | undefined {
  const net = text(p.network) || 'tcp';
  if (net === 'tcp') return undefined;
  if (net === 'ws') {
    const o = object(p['ws-opts']);
    fields(
      o,
      [
        'path',
        'headers',
        'max-early-data',
        'early-data-header-name',
        'v2ray-http-upgrade',
        'v2ray-http-upgrade-fast-open',
      ],
      'ws-opts',
    );
    const upgrade = o['v2ray-http-upgrade'] === true;
    const headers = object(o.headers);
    if (core === 'sing-box') {
      notes.push(
        upgrade
          ? 'WS upgrade flags → transport.type=httpupgrade'
          : 'ws-opts → transport; early data → max_early_data/early_data_header_name',
      );
      if (upgrade && (o['max-early-data'] || o['v2ray-http-upgrade-fast-open']))
        fail('sing-box HTTPUpgrade does not expose WS early-data/fast-open flags');
      return {
        type: upgrade ? 'httpupgrade' : 'ws',
        path: o.path,
        headers,
        ...(upgrade
          ? { host: headers.Host }
          : {
              max_early_data: o['max-early-data'],
              early_data_header_name: o['early-data-header-name'],
            }),
      };
    }
    notes.push(
      upgrade
        ? 'WS upgrade flags → httpupgradeSettings'
        : 'WS early data → path ?ed=; header → earlyDataHeaderName',
    );
    let path = text(o.path) || '/';
    const earlyData =
      o['max-early-data'] ?? (upgrade && o['v2ray-http-upgrade-fast-open'] ? 2048 : undefined);
    if (earlyData) path += `${path.includes('?') ? '&' : '?'}ed=${earlyData}`;
    return {
      network: upgrade ? 'httpupgrade' : 'ws',
      [upgrade ? 'httpupgradeSettings' : 'wsSettings']: {
        path,
        headers: upgrade
          ? Object.fromEntries(
              Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'host'),
            )
          : headers,
        ...(upgrade
          ? { host: headers.Host }
          : { earlyDataHeaderName: o['early-data-header-name'] }),
      },
    };
  }
  if (net === 'grpc') {
    const o = object(p['grpc-opts']);
    fields(o, ['grpc-service-name'], 'grpc-opts');
    notes.push(
      `grpc-service-name → ${core === 'sing-box' ? 'transport.service_name' : 'grpcSettings.serviceName'}`,
    );
    return core === 'sing-box'
      ? { type: 'grpc', service_name: o['grpc-service-name'] }
      : { network: 'grpc', grpcSettings: { serviceName: o['grpc-service-name'] } };
  }
  if (net === 'h2') {
    if (core === 'xray')
      fail('Xray 26.11 removed legacy HTTP/H2 transport; XHTTP is not wire-compatible');
    const o = object(p['h2-opts']);
    fields(o, ['path', 'host'], 'h2-opts');
    notes.push('h2-opts → transport.type=http/path/host');
    return { type: 'http', path: o.path, host: o.host };
  }
  if (net === 'mkcp') {
    if (core === 'sing-box') fail('sing-box has no mKCP transport');
    const o = object(p['mkcp-opts']);
    fields(o, ['seed', 'header'], 'mkcp-opts');
    const masks: Node[] = [{ type: 'mkcp-legacy', settings: { value: o.seed ?? '' } }];
    if (o.header && o.header !== 'none')
      masks.push({ type: 'mkcp-legacy', settings: { header: o.header } });
    notes.push('mKCP seed/header → finalmask.udp mkcp-legacy (not legacy kcpSettings)');
    return { network: 'kcp', finalmask: { udp: masks } };
  }
  if (net === 'xhttp') {
    if (core === 'sing-box') fail('sing-box has no XHTTP transport');
    const o = object(p['xhttp-opts']);
    fields(o, ['path', 'host', 'mode'], 'xhttp-opts');
    notes.push('xhttp-opts → xhttpSettings');
    return { network: 'xhttp', xhttpSettings: o };
  }
  return fail(`unmapped transport ${net} (harness coverage limit)`);
}

function tls(p: Node, core: ClientCore, notes: string[], gaps: string[]): Node | undefined {
  const reality = object(p['reality-opts']);
  const enabled =
    p.tls || ['trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls'].includes(text(p.type));
  if (!enabled) return undefined;
  const name = p.servername ?? p.sni ?? p.server;
  if (Object.keys(reality).length) {
    fields(reality, ['public-key', 'short-id', 'support-x25519mlkem768'], 'reality-opts');
    if (!reality['public-key']) {
      gaps.push('Reality public key missing');
      fail('Reality requires public key');
    }
    notes.push(
      'Reality public-key/short-id → public_key/short_id (sing-box) or publicKey/shortId (Xray); fingerprint → uTLS',
    );
    if (reality['support-x25519mlkem768'] !== undefined)
      fail('Mihomo-specific hybrid-key-share boolean has no exact client schema equivalent');
    return core === 'sing-box'
      ? {
          enabled: true,
          server_name: name,
          utls: { enabled: true, fingerprint: p['client-fingerprint'] ?? 'chrome' },
          reality: {
            enabled: true,
            public_key: reality['public-key'],
            short_id: reality['short-id'] ?? '',
          },
        }
      : {
          security: 'reality',
          realitySettings: {
            serverName: name,
            fingerprint: p['client-fingerprint'] ?? 'chrome',
            publicKey: reality['public-key'],
            shortId: reality['short-id'] ?? '',
          },
        };
  }
  if (core === 'xray') {
    if (p['skip-cert-verify'] === true) {
      gaps.push(
        'URI supplies insecure=true but no certificate pin/trust material; current Xray removed allowInsecure (not a missing Mihomo field)',
      );
      fail('Xray 26.11 removed allowInsecure; cannot faithfully map skip-cert-verify=true');
    }
    return {
      security: 'tls',
      tlsSettings: {
        serverName: name,
        alpn: p.alpn,
        fingerprint: p['client-fingerprint'] ?? 'chrome',
      },
    };
  }
  notes.push(
    'TLS servername/sni → server_name; skip-cert-verify → insecure; client-fingerprint → utls',
  );
  return {
    enabled: true,
    server_name: name,
    insecure: p['skip-cert-verify'],
    alpn: p.alpn,
    ...(p['client-fingerprint']
      ? { utls: { enabled: true, fingerprint: p['client-fingerprint'] } }
      : {}),
  };
}

export function mapClient(p: Node, core: ClientCore, port: number): ClientMapping {
  const notes: string[] = [],
    gaps: string[] = [];
  try {
    fields(
      p,
      [
        'name',
        'type',
        'server',
        'port',
        'udp',
        'tfo',
        'uuid',
        'password',
        'cipher',
        'alterId',
        'plugin',
        'plugin-opts',
        'tls',
        'servername',
        'sni',
        'alpn',
        'skip-cert-verify',
        'client-fingerprint',
        'reality-opts',
        'network',
        'ws-opts',
        'grpc-opts',
        'h2-opts',
        'mkcp-opts',
        'xhttp-opts',
        'flow',
        'encryption',
        'packet-encoding',
        'auth-str',
        'up',
        'down',
        'obfs',
        'obfs-password',
        'ports',
        'hop-interval',
        'congestion-controller',
        'udp-relay-mode',
        'disable-sni',
        'private-key',
        'public-key',
        'pre-shared-key',
        'ip',
        'ipv6',
        'mtu',
        'reserved',
        'persistent-keepalive',
        'username',
        'version',
        'protocol',
        'protocol-param',
        'obfs-param',
      ],
      'node',
    );
    const type = text(p.type);
    if (['snell', 'ssr'].includes(type))
      fail(
        `${core} ${type === 'ssr' ? 'does not ship an SSR outbound in these versions' : 'has no Snell outbound'}`,
      );
    if (core === 'xray' && ['anytls', 'tuic', 'hysteria'].includes(type))
      fail(`Xray has no ${type} outbound${type === 'hysteria' ? ' (only Hysteria v2)' : ''}`);
    if (core === 'sing-box' && p.encryption && p.encryption !== 'none')
      fail('sing-box VLESS has no ML-KEM/x25519 encryption field');
    if (core === 'xray' && p.plugin) fail(`Xray has no native SS ${p.plugin} plugin`);
    const common = { server: p.server, server_port: p.port };
    const sing: Node = { type, tag: 'proxy', ...common };
    const xray: Node = { tag: 'proxy' };
    const extraSing: Node[] = [];
    let endpoint: Node | undefined;
    if (type === 'wireguard') {
      const address = [p.ip, p.ipv6].filter(Boolean);
      if (!address.length || !p['private-key'] || !p['public-key']) {
        gaps.push('WireGuard needs local address and key pair');
        fail('WireGuard address/key missing');
      }
      notes.push(
        'flat WG → userspace endpoint/peer; implicit all-destinations routing → allowed_ips/allowedIPs 0.0.0.0/0,::/0',
      );
      const peer = {
        public_key: p['public-key'],
        pre_shared_key: p['pre-shared-key'],
        address: p.server,
        port: p.port,
        allowed_ips: ['0.0.0.0/0', '::/0'],
        reserved: p.reserved,
        persistent_keepalive_interval: p['persistent-keepalive'],
      };
      endpoint = {
        type: 'wireguard',
        tag: 'proxy',
        system: false,
        address,
        private_key: p['private-key'],
        mtu: p.mtu,
        peers: [peer],
      };
      Object.assign(xray, {
        protocol: 'wireguard',
        settings: {
          secretKey: p['private-key'],
          address,
          mtu: p.mtu,
          reserved: p.reserved,
          noKernelTun: true,
          peers: [
            {
              publicKey: p['public-key'],
              preSharedKey: p['pre-shared-key'],
              endpoint: `${p.server}:${p.port}`,
              allowedIPs: ['0.0.0.0/0', '::/0'],
              keepAlive: p['persistent-keepalive'],
            },
          ],
        },
      });
    } else if (type === 'ss') {
      Object.assign(sing, { type: 'shadowsocks', method: p.cipher, password: p.password });
      Object.assign(xray, {
        protocol: 'shadowsocks',
        settings: {
          servers: [{ address: p.server, port: p.port, method: p.cipher, password: p.password }],
        },
      });
      const o = object(p['plugin-opts']);
      if (p.plugin === 'shadow-tls') {
        fields(o, ['host', 'password', 'version'], 'shadow-tls');
        sing.detour = 'shadow';
        extraSing.push({
          type: 'shadowtls',
          tag: 'shadow',
          ...common,
          version: o.version,
          password: o.password,
          tls: { enabled: true, server_name: o.host },
        });
        notes.push(
          'SS shadow-tls plugin → separate shadowtls outbound + SS detour; lab CA trusted',
        );
      } else if (p.plugin === 'obfs' || p.plugin === 'v2ray-plugin') {
        fields(o, ['mode', 'host', 'path', 'tls', 'mux'], 'plugin-opts');
        sing.plugin = p.plugin === 'obfs' ? 'obfs-local' : 'v2ray-plugin';
        sing.plugin_opts =
          p.plugin === 'obfs'
            ? `obfs=${o.mode};obfs-host=${o.host}`
            : `mode=${o.mode};host=${o.host};path=${o.path ?? '/'}${o.tls ? ';tls' : ''};mux=${o.mux === false ? 0 : 1}`;
        notes.push('plugin-opts object → SIP003 plugin_opts string; mux false → mux=0');
      } else if (p.plugin) fail(`unknown SS plugin ${p.plugin}`);
    } else if (['vmess', 'vless', 'trojan'].includes(type)) {
      const t = transport(p, core, notes);
      const security = tls(p, core, notes, gaps);
      if (type === 'trojan') {
        sing.password = p.password;
        Object.assign(xray, {
          protocol: type,
          settings: { servers: [{ address: p.server, port: p.port, password: p.password }] },
        });
      } else {
        Object.assign(sing, {
          uuid: p.uuid,
          ...(type === 'vmess'
            ? { security: p.cipher ?? 'auto', alter_id: p.alterId ?? 0 }
            : { flow: p.flow, packet_encoding: p['packet-encoding'] }),
        });
        const user = {
          id: p.uuid,
          ...(type === 'vmess'
            ? { security: p.cipher ?? 'auto', alterId: p.alterId ?? 0 }
            : { flow: p.flow, encryption: p.encryption || 'none' }),
        };
        Object.assign(xray, {
          protocol: type,
          settings: { vnext: [{ address: p.server, port: p.port, users: [user] }] },
        });
        if (type === 'vless')
          notes.push(
            'empty VLESS encryption → Xray none; flow preserved; packet-encoding → sing-box packet_encoding',
          );
      }
      if (core === 'sing-box') {
        if (t) sing.transport = t;
        if (security) sing.tls = security;
      } else xray.streamSettings = { network: 'tcp', ...(t ?? {}), ...(security ?? {}) };
    } else if (['hysteria', 'hysteria2', 'tuic', 'anytls'].includes(type)) {
      if (core === 'sing-box') {
        sing.tls = tls(p, core, notes, gaps);
        if (type === 'hysteria')
          Object.assign(sing, {
            auth_str: p['auth-str'],
            up_mbps: bandwidth(p.up),
            down_mbps: bandwidth(p.down),
            obfs: p.obfs,
          });
        else if (type === 'tuic') {
          Object.assign(sing, {
            uuid: p.uuid,
            password: p.password,
            congestion_control: p['congestion-controller'],
            udp_relay_mode: p['udp-relay-mode'],
          });
          if (p['disable-sni']) object(sing.tls).disable_sni = true;
          notes.push(
            'TUIC congestion-controller/udp-relay-mode → congestion_control/udp_relay_mode',
          );
        } else sing.password = p.password;
        if (type === 'hysteria2') {
          if (p.obfs) sing.obfs = { type: p.obfs, password: p['obfs-password'] };
          Object.assign(sing, { up_mbps: bandwidth(p.up), down_mbps: bandwidth(p.down) });
          if (p.ports) {
            if (Number(p['hop-interval'] ?? 30) < 5)
              fail('sing-box hopping minimum is 5s; node requests a shorter interval');
            sing.server_ports = text(p.ports)
              .split(',')
              .map((s) => (s.includes('-') ? s.replace('-', ':') : `${s}:${s}`));
            sing.hop_interval = `${p['hop-interval'] ?? 30}s`;
          }
          notes.push(
            'HY2 obfs/password → obfs object; comma/hyphen ports → server_ports array/colon ranges; hop interval → duration',
          );
        }
      } else {
        const security = tls(p, core, notes, gaps);
        const masks: Node[] = [];
        if (p.obfs) {
          if (p.obfs !== 'salamander') fail('Xray mapping only covers salamander');
          masks.push({ type: 'salamander', settings: { password: p['obfs-password'] } });
        }
        if (p.ports) {
          if (Number(p['hop-interval'] ?? 30) < 5)
            fail('Xray UDP hopping minimum is 5s; node requests a shorter interval');
          masks.push({
            type: 'udphop',
            settings: {
              mode: 'intervalremote',
              interval: Number(p['hop-interval'] ?? 30),
              remotePorts: p.ports,
            },
          });
        }
        Object.assign(xray, {
          protocol: 'hysteria',
          settings: { version: 2, address: p.server, port: p.port },
          streamSettings: {
            network: 'hysteria',
            ...(security ?? {}),
            hysteriaSettings: { version: 2, auth: p.password },
            finalmask: { udp: masks },
          },
        });
        notes.push('HY2 → protocol/transport hysteria version=2; obfs/hopping → finalmask');
      }
    } else if (type === 'http' || type === 'socks5') {
      Object.assign(sing, {
        type: type === 'http' ? 'http' : 'socks',
        username: p.username,
        password: p.password,
      });
      const security = tls(p, core, notes, gaps);
      if (security && core === 'sing-box') sing.tls = security;
      Object.assign(xray, {
        protocol: type === 'http' ? 'http' : 'socks',
        settings: {
          servers: [
            {
              address: p.server,
              port: p.port,
              ...(p.username ? { users: [{ user: p.username, pass: p.password }] } : {}),
            },
          ],
        },
        ...(security ? { streamSettings: security } : {}),
      });
      notes.push('proxy username/password → Xray servers[].users[].user/pass');
    } else fail(`unmapped node type ${type} (harness coverage limit)`);
    if (p.tfo !== undefined && core === 'sing-box') sing.tcp_fast_open = p.tfo;
    const config =
      core === 'sing-box'
        ? {
            log: { level: 'debug' },
            inbounds: [{ type: 'socks', listen: '127.0.0.1', listen_port: port }],
            outbounds: endpoint ? [] : [sing, ...extraSing],
            ...(endpoint ? { endpoints: [endpoint] } : {}),
            route: { final: 'proxy' },
          }
        : {
            log: { loglevel: 'debug' },
            inbounds: [
              { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } },
            ],
            outbounds: [xray],
          };
    return { config, notes, gaps };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    return { reason: e.message, notes, gaps };
  }
}
