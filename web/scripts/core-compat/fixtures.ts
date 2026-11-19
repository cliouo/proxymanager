import { randomBytes } from 'node:crypto';

export type Core =
  | 'mihomo'
  | 'sing-box'
  | 'xray'
  | 'xray18'
  | 'xray25'
  | 'v2ray-plugin'
  | 'snell4'
  | 'snell5';
export interface Service {
  core: Core;
  config?: Record<string, unknown> | string;
  args?: string[];
}
export interface Fixture {
  name: string;
  uri: string;
  services: Service[];
  notes?: string;
  unavailable?: string;
  hopping?: boolean;
  targetHost?: string;
}
export interface Context {
  port: () => Promise<number>;
  cert: string;
  key: string;
  tlsPort: number;
  targetPort: number;
  reality: { privateKey: string; publicKey: string };
  wgServer: { privateKey: string; publicKey: string };
  wgClient: { privateKey: string; publicKey: string };
  encryption: { encryption: string; decryption: string }[];
}

const uuid = 'a4ca72b5-2231-4f79-957c-d0942b992eb5';
const password = 'lab-password-only';
const enc = encodeURIComponent;
const base64 = (s: string) => Buffer.from(s).toString('base64');
const query = (p: Record<string, string>) => new URLSearchParams(p).toString();
const endpoint = (port: number) => `127.0.0.1:${port}`;

export async function fixtures(c: Context): Promise<Fixture[]> {
  const result: Fixture[] = [];
  const tls = (alpn?: string[]) => ({
    enabled: true,
    server_name: 'localhost',
    certificate_path: c.cert,
    key_path: c.key,
    ...(alpn ? { alpn } : {}),
  });
  const sing = (inbounds: Record<string, unknown>[], extra = {}): Service => ({
    core: 'sing-box',
    config: {
      log: { level: 'debug', timestamp: true },
      inbounds,
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'direct' },
      ...extra,
    },
  });
  const inbound = (type: string, port: number, extra = {}) => ({
    type,
    tag: 'server',
    listen: '127.0.0.1',
    listen_port: port,
    ...extra,
  });
  const freedom = (extra = {}) => ({
    protocol: 'freedom',
    settings: {
      finalRules: [{ action: 'allow', ip: ['127.0.0.1/32'], port: String(c.targetPort) }],
      ...extra,
    },
  });
  const ssUri = (port: number, cipher: string, pass: string, plugin?: string) =>
    `ss://${base64(`${cipher}:${pass}`)}@${endpoint(port)}${plugin ? `?plugin=${enc(plugin)}` : ''}#lab`;
  const mihomoSS = (port: number, extra: Record<string, unknown>): Service => ({
    core: 'mihomo',
    config: {
      'log-level': 'debug',
      listeners: [
        {
          name: 'server',
          type: 'shadowsocks',
          listen: '127.0.0.1',
          port,
          cipher: 'aes-128-gcm',
          password,
          ...extra,
        },
      ],
      rules: ['MATCH,DIRECT'],
    },
  });

  for (const cipher of ['aes-128-gcm', '2022-blake3-aes-128-gcm']) {
    const port = await c.port();
    const pass = cipher.startsWith('2022') ? randomBytes(16).toString('base64') : password;
    result.push({
      name: `ss-${cipher}`,
      uri: ssUri(port, cipher, pass),
      services: [sing([inbound('shadowsocks', port, { method: cipher, password: pass })])],
    });
  }
  for (const mode of ['http', 'tls']) {
    const port = await c.port();
    result.push({
      name: `ss-obfs-${mode}`,
      uri: ssUri(port, 'aes-128-gcm', password, `obfs-local;obfs=${mode};obfs-host=localhost`),
      services: [mihomoSS(port, { 'simple-obfs': { enable: true, mode } })],
      notes: 'Mihomo native simple-obfs server',
    });
  }
  for (const secure of [false, true]) {
    const port = await c.port();
    const backend = await c.port();
    result.push({
      name: `ss-v2ray-plugin-ws${secure ? '-tls' : ''}`,
      uri: ssUri(
        port,
        'aes-128-gcm',
        password,
        `v2ray-plugin;mode=websocket;host=localhost;path=/lab;mux=0${secure ? ';tls' : ''}`,
      ),
      services: [
        sing([inbound('shadowsocks', backend, { method: 'aes-128-gcm', password })]),
        {
          core: 'v2ray-plugin',
          args: [
            '-server',
            '-localAddr',
            '127.0.0.1',
            '-localPort',
            String(port),
            '-remoteAddr',
            '127.0.0.1',
            '-remotePort',
            String(backend),
            '-host',
            'localhost',
            '-path',
            '/lab',
            '-mux',
            '0',
            ...(secure ? ['-tls', '-cert', c.cert, '-key', c.key] : []),
          ],
        },
      ],
      notes: secure
        ? 'Lab CA trusted via SSL_CERT_FILE (plugin URI has no insecure flag)'
        : undefined,
    });
  }
  {
    const port = await c.port();
    result.push({
      name: 'ss-shadow-tls-v3',
      uri: ssUri(
        port,
        'aes-128-gcm',
        password,
        'shadow-tls;host=localhost;password=shadow-password;version=3',
      ),
      services: [
        mihomoSS(port, {
          'shadow-tls': {
            enable: true,
            version: 3,
            users: [{ name: 'lab', password: 'shadow-password' }],
            handshake: { dest: endpoint(c.tlsPort) },
          },
        }),
      ],
      notes: 'Local TLS 1.3 camouflage; lab CA trusted via SSL_CERT_FILE',
    });
  }
  result.push({
    name: 'ssr',
    uri: `ssr://${base64(`127.0.0.1:${await c.port()}:auth_sha1_v4:aes-128-cfb:tls1.2_ticket_auth:${base64(password)}/?remarks=${base64('lab')}`)}`,
    services: [],
    unavailable:
      'No SSR server binary installed; upstream shadowsocksr-libev has no release assets',
  });

  for (const variant of ['tcp', 'ws', 'ws-tls', 'grpc', 'h2', 'httpupgrade', 'mkcp']) {
    const port = await c.port();
    const secure = variant === 'ws-tls' || variant === 'h2';
    const transport = variant === 'ws-tls' ? 'ws' : variant;
    const uri = `vmess://${base64(
      JSON.stringify({
        v: '2',
        ps: 'lab',
        add: '127.0.0.1',
        port: String(port),
        id: uuid,
        aid: '0',
        scy: 'auto',
        net: transport,
        type: 'none',
        ...(transport !== 'tcp' ? { path: transport === 'grpc' ? 'lab' : '/lab' } : {}),
        ...(secure ? { tls: 'tls', sni: 'localhost', insecure: '1' } : {}),
      }),
    )}`;
    if (transport === 'mkcp') {
      result.push({
        name: 'vmess-mkcp',
        uri,
        services: [
          {
            core: 'xray',
            config: {
              log: { loglevel: 'debug' },
              inbounds: [
                {
                  listen: '127.0.0.1',
                  port,
                  protocol: 'vmess',
                  settings: { clients: [{ id: uuid, alterId: 0 }] },
                  streamSettings: {
                    network: 'kcp',
                    finalmask: { udp: [{ type: 'mkcp-legacy', settings: { value: '/lab' } }] },
                  },
                },
              ],
              outbounds: [freedom()],
            },
          },
        ],
        notes:
          'Xray 26.11 uses finalmask mkcp-legacy for the URI seed (legacy kcpSettings.seed is ignored)',
      });
    } else {
      const t = transport === 'h2' ? 'http' : transport;
      result.push({
        name: `vmess-${variant}`,
        uri,
        services: [
          sing([
            inbound('vmess', port, {
              users: [{ uuid, alterId: 0 }],
              ...(secure ? { tls: tls() } : {}),
              ...(t !== 'tcp'
                ? {
                    transport: {
                      type: t,
                      ...(t === 'grpc' ? { service_name: 'lab' } : { path: '/lab' }),
                    },
                  }
                : {}),
            }),
          ]),
        ],
      });
    }
  }

  for (const variant of [
    'tcp-tls',
    'ws',
    'grpc',
    'httpupgrade',
    'h2',
    'reality-vision',
    'reality-grpc',
    'xhttp-tls',
    'xhttp-reality',
    'encryption-x25519',
    'encryption-mlkem',
  ]) {
    const port = await c.port();
    const reality = variant.includes('reality');
    const secure = reality || variant.includes('tls') || variant === 'h2';
    const network = variant.includes('xhttp')
      ? 'xhttp'
      : variant.includes('grpc')
        ? 'grpc'
        : ['ws', 'httpupgrade', 'h2'].includes(variant)
          ? variant
          : 'tcp';
    const flow = variant === 'reality-vision' ? 'xtls-rprx-vision' : '';
    const encryption = variant.startsWith('encryption-')
      ? c.encryption[variant.endsWith('mlkem') ? 1 : 0]
      : undefined;
    const p: Record<string, string> = {
      type: network,
      encryption: encryption?.encryption ?? 'none',
      security: reality ? 'reality' : secure ? 'tls' : 'none',
    };
    if (secure) Object.assign(p, { sni: 'localhost', insecure: '1' });
    if (reality)
      Object.assign(p, { fp: 'chrome', pbk: c.reality.publicKey, sid: 'abcdef0123456789' });
    if (flow) p.flow = flow;
    if (network === 'grpc') p.serviceName = 'lab';
    else if (network !== 'tcp') p.path = '/lab';
    if (network === 'xhttp') p.mode = 'auto';
    const uri = `vless://${uuid}@${endpoint(port)}?${query(p)}#lab`;
    if (reality || network === 'xhttp' || encryption) {
      const stream: Record<string, unknown> = {
        network,
        security: reality ? 'reality' : secure ? 'tls' : 'none',
      };
      if (reality)
        stream.realitySettings = {
          dest: endpoint(c.tlsPort),
          serverNames: ['localhost'],
          show: true,
          privateKey: c.reality.privateKey,
          shortIds: ['abcdef0123456789'],
        };
      else if (secure)
        stream.tlsSettings = { certificates: [{ certificateFile: c.cert, keyFile: c.key }] };
      if (network === 'grpc') stream.grpcSettings = { serviceName: 'lab' };
      if (network === 'xhttp') stream.xhttpSettings = { path: '/lab', mode: 'auto' };
      result.push({
        name: `vless-${variant}`,
        uri,
        services: [
          {
            core: 'xray',
            config: {
              log: { loglevel: 'debug' },
              inbounds: [
                {
                  listen: '127.0.0.1',
                  port,
                  protocol: 'vless',
                  settings: {
                    decryption: encryption?.decryption ?? 'none',
                    clients: [{ id: uuid, ...(flow ? { flow } : {}) }],
                  },
                  streamSettings: stream,
                },
              ],
              outbounds: [freedom()],
            },
          },
        ],
      });
      if (reality && network !== 'xhttp') {
        result.push({
          name: `vless-${variant}-sing-box`,
          uri,
          services: [
            sing([
              inbound('vless', port, {
                users: [{ uuid, ...(flow ? { flow } : {}) }],
                tls: {
                  enabled: true,
                  server_name: 'localhost',
                  reality: {
                    enabled: true,
                    handshake: { server: '127.0.0.1', server_port: c.tlsPort },
                    private_key: c.reality.privateKey,
                    short_id: ['abcdef0123456789'],
                  },
                },
                ...(network === 'grpc' ? { transport: { type: 'grpc', service_name: 'lab' } } : {}),
              }),
            ]),
          ],
        });
      }
    } else {
      const t = network === 'h2' ? 'http' : network;
      result.push({
        name: `vless-${variant}`,
        uri,
        services: [
          sing([
            inbound('vless', port, {
              users: [{ uuid }],
              ...(secure ? { tls: tls() } : {}),
              ...(t !== 'tcp'
                ? {
                    transport: {
                      type: t,
                      ...(t === 'grpc' ? { service_name: 'lab' } : { path: '/lab' }),
                    },
                  }
                : {}),
            }),
          ]),
        ],
      });
    }
  }

  for (const network of ['tcp', 'ws', 'grpc']) {
    const port = await c.port();
    result.push({
      name: `trojan-${network === 'tcp' ? 'tls' : network}`,
      uri: `trojan://${password}@${endpoint(port)}?${query({
        sni: 'localhost',
        insecure: '1',
        type: network,
        ...(network === 'ws' ? { path: '/lab' } : network === 'grpc' ? { serviceName: 'lab' } : {}),
      })}#lab`,
      services: [
        sing([
          inbound('trojan', port, {
            users: [{ password }],
            tls: tls(),
            ...(network !== 'tcp'
              ? {
                  transport: {
                    type: network,
                    ...(network === 'grpc' ? { service_name: 'lab' } : { path: '/lab' }),
                  },
                }
              : {}),
          }),
        ]),
      ],
    });
  }
  {
    const port = await c.port();
    result.push({
      name: 'hysteria-v1',
      uri: `hysteria://${endpoint(port)}?${query({ auth: password, upmbps: '100', downmbps: '100', sni: 'localhost', insecure: '1', alpn: 'hysteria' })}#lab`,
      services: [
        sing([
          inbound('hysteria', port, {
            users: [{ auth_str: password }],
            up_mbps: 100,
            down_mbps: 100,
            tls: tls(['hysteria']),
          }),
        ]),
      ],
    });
  }
  for (const variant of ['plain', 'salamander', 'port-hopping']) {
    const port = await c.port();
    result.push({
      name: `hysteria2-${variant}`,
      hopping: variant === 'port-hopping',
      uri: `hysteria2://${password}@${endpoint(port)}?${query({
        sni: 'localhost',
        insecure: '1',
        ...(variant === 'salamander' ? { obfs: 'salamander', 'obfs-password': password } : {}),
      })}#lab`,
      services: [
        sing([
          inbound('hysteria2', port, {
            users: [{ password }],
            tls: tls(['h3']),
            ...(variant === 'salamander' ? { obfs: { type: 'salamander', password } } : {}),
          }),
        ]),
      ],
    });
  }
  {
    const port = await c.port();
    result.push({
      name: 'tuic-v5',
      uri: `tuic://${uuid}:${password}@${endpoint(port)}?sni=localhost&insecure=1&alpn=h3#lab`,
      services: [
        sing([
          inbound('tuic', port, {
            users: [{ uuid, password }],
            tls: tls(['h3']),
            congestion_control: 'bbr',
          }),
        ]),
      ],
    });
  }
  {
    const port = await c.port();
    result.push({
      name: 'anytls',
      uri: `anytls://${password}@${endpoint(port)}?sni=localhost&insecure=1#lab`,
      services: [sing([inbound('anytls', port, { users: [{ password }], tls: tls() })])],
    });
  }
  for (const version of [4, 5] as const) {
    const port = await c.port();
    result.push({
      name: `snell-v${version}`,
      uri: `snell://${password}@${endpoint(port)}?version=${version}#lab`,
      services: [
        {
          core: version === 4 ? 'snell4' : 'snell5',
          config: `[snell-server]\nlisten = ${endpoint(port)}\npsk = ${password}\nipv6 = false\n`,
        },
      ],
    });
  }
  {
    const port = await c.port();
    result.push({
      name: 'wireguard',
      uri: `wireguard://${enc(c.wgClient.privateKey)}@${endpoint(port)}?${query({ 'public-key': c.wgServer.publicKey, address: '10.77.0.2/32' })}#lab`,
      services: [
        {
          core: 'xray',
          config: {
            log: { loglevel: 'debug' },
            inbounds: [
              {
                listen: '127.0.0.1',
                port,
                protocol: 'wireguard',
                settings: {
                  secretKey: c.wgServer.privateKey,
                  address: ['10.77.0.1/24'],
                  noKernelTun: true,
                  peers: [{ publicKey: c.wgClient.publicKey, allowedIPs: ['10.77.0.2/32'] }],
                },
              },
            ],
            outbounds: [freedom({ redirect: `127.0.0.1:${c.targetPort}` })],
          },
        },
      ],
      targetHost: '198.18.0.1',
      notes:
        'Userspace WG; virtual target 198.18.0.1 mapped by server to local HTTP target (WG stack rejects loopback destinations)',
    });
  }
  for (const protocol of ['socks5', 'http', 'https']) {
    const port = await c.port();
    result.push({
      name: `${protocol}-auth`,
      uri: `${protocol}://lab:${password}@${endpoint(port)}${protocol === 'https' ? '?sni=localhost&insecure=1' : ''}#lab`,
      services: [
        sing([
          inbound(protocol === 'socks5' ? 'socks' : 'http', port, {
            users: [{ username: 'lab', password }],
            ...(protocol === 'https' ? { tls: tls() } : {}),
          }),
        ]),
      ],
    });
  }
  for (const original of [...result]) {
    if (!['vless-reality-vision', 'vless-reality-grpc'].includes(original.name)) continue;
    for (const core of ['xray18', 'xray25'] as const) {
      const config = structuredClone(original.services[0].config) as Record<string, unknown>;
      config.outbounds = [{ protocol: 'freedom', settings: {} }];
      result.push({ ...original, name: `${original.name}-${core}`, services: [{ core, config }] });
    }
  }
  return result;
}
