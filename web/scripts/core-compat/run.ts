import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { parseProxyUriList } from '../../lib/proxies/uriToClash';
import { validateMihomoProxyList } from '../../lib/proxies/mihomoProxyValidator';
import { fixtures, type Core, type Fixture, type Service } from './fixtures';
import { analyzeExport, markdown, type Result } from './report';
import { mapClient, type ClientCore } from './clients';

const execute = promisify(execFile);
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = join(web, '.tmp/core-compat');
const directory = join(root, `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const cores = join(homedir(), 'cores');
const binaries: Record<Core, string> = {
  mihomo: process.env.MIHOMO_BIN ?? join(cores, 'mihomo'),
  'sing-box': process.env.SING_BOX_BIN ?? join(cores, 'sing-box'),
  xray: process.env.XRAY_BIN ?? join(cores, 'xray'),
  xray18: process.env.XRAY18_BIN ?? join(cores, 'xray-1.8.24/xray'),
  xray25: process.env.XRAY25_BIN ?? join(cores, 'xray-25.3.6/xray'),
  'v2ray-plugin': process.env.V2RAY_PLUGIN_BIN ?? join(cores, 'v2ray-plugin_linux_amd64'),
  snell4: process.env.SNELL4_BIN ?? join(cores, 'snell4/snell-server'),
  snell5: process.env.SNELL5_BIN ?? join(cores, 'snell5/snell-server'),
};
const active = new Set<ChildProcess>();
const mode = process.env.LAB_MODE ?? 'all';
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .split('\n')
    .slice(-3)
    .join(' ')
    .slice(-500);

async function command(
  bin: string,
  args: string[],
  log?: string,
  env = process.env,
): Promise<string> {
  try {
    const { stdout, stderr } = await execute(bin, args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    if (log) writeFileSync(log, stdout + stderr);
    return stdout;
  } catch (e) {
    const failure = e as Error & { stdout?: string; stderr?: string };
    const output = (failure.stdout ?? '') + (failure.stderr ?? '');
    if (log) writeFileSync(log, output || failure.message);
    throw new Error(short(output || failure.message));
  }
}

async function port(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((done, reject) =>
    listener.once('error', reject).listen(0, '127.0.0.1', done),
  );
  const value = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return value;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1500);
    child.once('exit', () => {
      clearTimeout(force);
      done();
    });
    child.kill('SIGTERM');
  });
}

function launch(core: Core, args: string[], log: string, cert: string): ChildProcess {
  const child = spawn(binaries[core], args, {
    env: { ...process.env, SSL_CERT_FILE: cert },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.add(child);
  child.stdout?.on('data', (data) => appendFileSync(log, data));
  child.stderr?.on('data', (data) => appendFileSync(log, data));
  child.on('error', (e) => appendFileSync(log, message(e)));
  child.once('exit', () => active.delete(child));
  return child;
}

async function ready(child: ChildProcess, log: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(short(existsSync(log) ? readFileSync(log, 'utf8') : 'process exited'));
    }
    const output = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (
      /started|listening|Listening|listener|Listen at|Start snell server|TCP server running|UDP server running/.test(
        output,
      )
    )
      return;
    await delay(50);
  }
  throw new Error(`readiness timeout: ${short(existsSync(log) ? readFileSync(log, 'utf8') : '')}`);
}

async function server(
  service: Service,
  dir: string,
  i: number,
  cert: string,
): Promise<ChildProcess> {
  if (!existsSync(binaries[service.core]))
    throw new Error(`no server available: ${binaries[service.core]}`);
  const stem = join(dir, `server-${i}-${service.core}`);
  let args = service.args ?? [];
  if (service.config !== undefined) {
    const file = `${stem}.${service.core === 'mihomo' ? 'yaml' : typeof service.config === 'string' ? 'conf' : 'json'}`;
    writeFileSync(
      file,
      typeof service.config === 'string'
        ? service.config
        : service.core === 'mihomo'
          ? stringify(service.config)
          : JSON.stringify(service.config, null, 2),
    );
    if (service.core === 'mihomo') {
      const home = join(dir, `server-${i}-home`);
      mkdirSync(home, { recursive: true });
      args = ['-d', home, '-f', file];
    } else if (service.core === 'sing-box') args = ['run', '-c', file];
    else if (service.core.startsWith('xray')) args = ['run', '-c', file];
    else args = ['-c', file];
  }
  const log = `${stem}.log`;
  const child = launch(service.core, args, log, cert);
  await ready(child, log);
  return child;
}

async function udpRelay(backendPort: number) {
  const backend = dgram.createSocket('udp4');
  const fronts = Array.from({ length: 16 }, () => dgram.createSocket('udp4'));
  const counts = fronts.map(() => 0);
  let recipient: { socket: dgram.Socket; port: number; address: string } | undefined;
  await new Promise<void>((done) => backend.bind(0, '127.0.0.1', done));
  backend.on('message', (data) => {
    if (recipient) recipient.socket.send(data, recipient.port, recipient.address);
  });
  for (const [i, socket] of fronts.entries()) {
    socket.on('message', (data, remote) => {
      counts[i]++;
      recipient = { socket, port: remote.port, address: remote.address };
      backend.send(data, backendPort, '127.0.0.1');
    });
    await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done));
  }
  return {
    ports: fronts.map((s) => s.address().port),
    counts,
    close: () => {
      backend.close();
      fronts.forEach((s) => s.close());
    },
  };
}

async function runCase(f: Fixture, targetPort: number, cert: string): Promise<Result> {
  const dir = join(directory, f.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result: Result = {
    name: f.name,
    server: f.services.map((s) => s.core).join(' + ') || 'none',
    parse: 'SKIP',
    validate: 'SKIP',
    test: 'SKIP',
    startup: 'SKIP',
    connect: 'SKIP',
    notes: f.notes ? [f.notes] : [],
    linkTest: 'SKIP',
    linkConnect: 'SKIP',
    realityTrue: 'N/A',
  };
  const children: ChildProcess[] = [];
  const before = new Set(active);
  let relay: Awaited<ReturnType<typeof udpRelay>> | undefined;
  try {
    let uri = f.uri;
    if (f.hopping) {
      const backendPort = Number(new URL(uri).port);
      relay = await udpRelay(backendPort);
      uri = uri
        .replace(`:${backendPort}?`, `:${relay.ports.join(',')}?`)
        .replace('?', '?hop-interval=1&');
    }
    writeFileSync(join(dir, 'fixture.uri'), uri);
    const parsed = parseProxyUriList(uri);
    if (parsed.errors.length || parsed.proxies.length !== 1) {
      result.parse = 'FAIL';
      result.notes.push(
        `parse: ${parsed.errors.map((e) => e.error).join('; ') || 'expected one node'}`,
      );
      return result;
    }
    result.parse = 'PASS';
    let proxies: Record<string, unknown>[];
    try {
      proxies = validateMihomoProxyList(parsed.proxies);
      result.validate = 'PASS';
    } catch (e) {
      result.validate = 'FAIL';
      result.notes.push(`validator: ${message(e)}`);
      return result;
    }
    const exported = analyzeExport(proxies);
    result.exportStatus = exported.status;
    result.roundTrip = exported.diff;
    result.notes.push(...exported.notes.map((note) => `export: ${note}`));
    writeFileSync(join(dir, 'exported.uri'), exported.lines.join('\n'));
    writeFileSync(join(dir, 'subscription.base64'), exported.content);
    const mappings = await Promise.all(
      (['sing-box', 'xray'] as const).map(async (core) => {
        const mapping = mapClient(proxies[0], core, await port());
        result.clientNotes ??= [];
        result.clientNotes.push(
          ...mapping.notes.map((note) => `${core}: ${note}`),
          ...mapping.gaps.map((gap) => `${core} GAP: ${gap}`),
        );
        if (mapping.reason) result.clientNotes.push(`${core} UNSUPPORTED: ${mapping.reason}`);
        return { core, mapping };
      }),
    );
    result.singClient = mappings[0].mapping.reason ? 'UNSUPPORTED' : 'N/A';
    result.xrayClient = mappings[1].mapping.reason ? 'UNSUPPORTED' : 'N/A';
    const mixed = await port();
    const home = join(dir, 'client-home');
    mkdirSync(home);
    const config = join(dir, 'client.yaml');
    writeFileSync(
      config,
      stringify({
        'mixed-port': mixed,
        'bind-address': '127.0.0.1',
        'allow-lan': false,
        'log-level': 'debug',
        ipv6: false,
        proxies,
        rules: [`MATCH,${proxies[0].name}`],
      }),
    );
    const env = { ...process.env, SSL_CERT_FILE: cert };
    try {
      await command(
        binaries.mihomo,
        ['-t', '-d', home, '-f', config],
        join(dir, 'mihomo-test.log'),
        env,
      );
      result.test = 'PASS';
    } catch (e) {
      result.test = 'FAIL';
      result.notes.push(`mihomo -t: ${message(e)}`);
      return result;
    }
    if (f.unavailable) {
      result.startup = 'N/A';
      result.connect = 'N/A';
      if (mode === 'all' && exported.status === 'PASS') {
        const check = await checkConfig(
          'link-import',
          {
            'proxy-providers': {
              lab: { type: 'file', path: join(dir, 'subscription.base64') },
            },
            'proxy-groups': [{ name: 'imported', type: 'select', use: ['lab'] }],
            rules: ['MATCH,imported'],
          },
          '',
          '',
          dir,
          cert,
          false,
        );
        result.linkTest = check.test;
        result.linkConnect = check.connect;
        if (check.error) result.notes.push(`link import: ${check.error}`);
      }
      result.notes.push(`no server available: ${f.unavailable}`);
      return result;
    }
    const missing = f.services.find((s) => !existsSync(binaries[s.core]));
    if (missing) {
      result.startup = 'N/A';
      result.connect = 'N/A';
      result.notes.push(`no server available: ${binaries[missing.core]}`);
      return result;
    }
    try {
      for (const [i, service] of f.services.entries())
        children.push(await server(service, dir, i, cert));
      result.startup = 'PASS';
    } catch (e) {
      result.startup = 'FAIL';
      result.notes.push(`server: ${message(e)}`);
      return result;
    }
    const linkNonce = randomBytes(16).toString('hex');
    const linkUrl = `http://${f.targetHost ?? '127.0.0.1'}:${targetPort}/${linkNonce}`;
    if (mode !== 'reality') {
      for (const { core, mapping } of mappings) {
        if (!mapping.config) continue;
        const clientNonce = randomBytes(16).toString('hex');
        const clientUrl = `http://${f.targetHost ?? '127.0.0.1'}:${targetPort}/${clientNonce}${relay ? '?slow=1' : ''}`;
        const checked = await checkMappedClient(
          core,
          mapping.config,
          clientUrl,
          `${relay ? '.'.repeat(14) : ''}${clientNonce}`,
          dir,
          cert,
        );
        if (core === 'sing-box') result.singClient = checked.status;
        else result.xrayClient = checked.status;
        if (checked.error) result.clientNotes?.push(`${core}: ${checked.error}`);
      }
    }
    if (mode === 'clients') return result;
    if (mode !== 'reality' && exported.status === 'PASS') {
      const check = await checkConfig(
        'link-import',
        {
          'proxy-providers': {
            lab: { type: 'file', path: join(dir, 'subscription.base64') },
          },
          'proxy-groups': [{ name: 'imported', type: 'select', use: ['lab'] }],
          rules: ['MATCH,imported'],
        },
        linkUrl,
        linkNonce,
        dir,
        cert,
      );
      result.linkTest = check.test;
      result.linkConnect = check.connect;
      if (check.error) result.notes.push(`link import: ${check.error}`);
    }
    if (proxies[0]['reality-opts']) {
      const check = await checkConfig(
        'reality-true',
        {
          proxies: [
            {
              ...proxies[0],
              'reality-opts': {
                ...(proxies[0]['reality-opts'] as Record<string, unknown>),
                'support-x25519mlkem768': true,
              },
            },
          ],
          rules: [`MATCH,${proxies[0].name}`],
        },
        linkUrl,
        linkNonce,
        dir,
        cert,
      );
      result.realityTrue = check.connect;
      if (check.error) result.notes.push(`Reality flag true: ${check.error}`);
    }
    const log = join(dir, 'client.log');
    const client = launch('mihomo', ['-d', home, '-f', config], log, cert);
    children.push(client);
    await ready(client, log);
    const nonce = randomBytes(16).toString('hex');
    const url = `http://${f.targetHost ?? '127.0.0.1'}:${targetPort}/${nonce}${relay ? '?slow=1' : ''}`;
    try {
      const body = await command(
        'curl',
        [
          '--noproxy',
          '',
          '--proxy',
          `socks5h://127.0.0.1:${mixed}`,
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '15',
          url,
        ],
        join(dir, 'curl.log'),
      );
      if (body !== `${relay ? '.'.repeat(14) : ''}${nonce}`)
        throw new Error('target response did not match nonce');
      if (children.some((p) => p.exitCode !== null || p.signalCode !== null))
        throw new Error('a core exited during request');
      result.connect = 'PASS';
      if (relay) {
        writeFileSync(join(dir, 'hop-counts.json'), JSON.stringify(relay.counts));
        const used = relay.counts.filter((n) => n > 0);
        result.notes.push(
          used.length >= 2
            ? `hopping observed: ${used.length} ports during 7s stream`
            : 'HOP UNVERIFIED: randomized hop selected same port; HTTP connectivity passed',
        );
      }
    } catch (e) {
      result.connect = 'FAIL';
      result.notes.push(`connect: ${message(e)}`);
      result.notes.push(`client: ${short(readFileSync(log, 'utf8'))}`);
      const control = f.services.find((s) => s.core === 'xray');
      if (control)
        result.notes.push(
          `same-server Xray control: ${await xrayControl(control, uri, url, nonce, dir, cert)}`,
        );
    }
  } catch (e) {
    result.notes.push(`harness: ${message(e)}`);
    result.connect = 'ERROR';
  } finally {
    await Promise.all([...active].filter((p) => !before.has(p)).map(stop));
    relay?.close();
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  return result;
}

async function checkMappedClient(
  core: ClientCore,
  config: Record<string, unknown>,
  url: string,
  expected: string,
  dir: string,
  cert: string,
) {
  const file = join(dir, `mapped-${core}.json`);
  const log = join(dir, `mapped-${core}.log`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  let child: ChildProcess | undefined;
  let stage = 'config';
  try {
    await command(
      binaries[core],
      core === 'sing-box' ? ['check', '-c', file] : ['run', '-test', '-c', file],
      join(dir, `mapped-${core}-test.log`),
      { ...process.env, SSL_CERT_FILE: cert },
    );
    stage = 'startup';
    child = launch(core, ['run', '-c', file], log, cert);
    await ready(child, log);
    stage = 'connect';
    const inbound = (config.inbounds as Record<string, unknown>[])[0];
    const mixed = inbound.listen_port ?? inbound.port;
    const body = await command(
      'curl',
      [
        '--noproxy',
        '',
        '--proxy',
        `socks5h://127.0.0.1:${mixed}`,
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '15',
        url,
      ],
      join(dir, `mapped-${core}-curl.log`),
    );
    if (body !== expected) throw new Error('target response did not match nonce');
    return { status: 'PASS' };
  } catch (e) {
    return {
      status: 'FAIL',
      error: `${stage}: ${message(e)}; ${existsSync(log) ? short(readFileSync(log, 'utf8')) : ''}`,
    };
  } finally {
    if (child) await stop(child);
  }
}

async function checkConfig(
  label: string,
  extra: Record<string, unknown>,
  url: string,
  nonce: string,
  dir: string,
  cert: string,
  connect = true,
) {
  const mixed = await port();
  const home = join(dir, `${label}-home`);
  mkdirSync(home);
  const config = join(dir, `${label}.yaml`);
  const controller = label === 'link-import' ? await port() : undefined;
  if (label === 'link-import') {
    const providers = extra['proxy-providers'] as Record<string, { path: string }>;
    const content = readFileSync(providers.lab.path);
    providers.lab.path = join(home, 'subscription.base64');
    writeFileSync(providers.lab.path, content);
  }
  writeFileSync(
    config,
    stringify({
      'mixed-port': mixed,
      'bind-address': '127.0.0.1',
      'allow-lan': false,
      'log-level': 'debug',
      ipv6: false,
      ...(controller ? { 'external-controller': `127.0.0.1:${controller}` } : {}),
      ...extra,
    }),
  );
  let child: ChildProcess | undefined;
  let test = 'FAIL';
  const log = join(dir, `${label}.log`);
  try {
    await command(
      binaries.mihomo,
      ['-t', '-d', home, '-f', config],
      join(dir, `${label}-test.log`),
      { ...process.env, SSL_CERT_FILE: cert },
    );
    test = 'PASS';
    child = launch('mihomo', ['-d', home, '-f', config], log, cert);
    await ready(child, log);
    if (controller) {
      let selected: { all?: string[]; now?: string } = {};
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          selected = JSON.parse(
            await command('curl', [
              '--noproxy',
              '*',
              '--fail',
              '--silent',
              '--show-error',
              '--max-time',
              '2',
              `http://127.0.0.1:${controller}/proxies/imported`,
            ]),
          );
          if (
            selected.all?.length === 1 &&
            selected.now === selected.all[0] &&
            !['DIRECT', 'REJECT', 'COMPATIBLE'].includes(selected.now)
          )
            break;
        } catch {
          /* Controller/provider initialization may follow listener readiness. */
        }
        await delay(100);
      }
      writeFileSync(join(dir, 'link-import-selection.json'), JSON.stringify(selected));
      if (
        selected.all?.length !== 1 ||
        selected.now !== selected.all[0] ||
        ['DIRECT', 'REJECT', 'COMPATIBLE'].includes(selected.now ?? '')
      ) {
        throw new Error(
          'provider did not select exactly one imported node (direct fallback forbidden)',
        );
      }
    }
    if (!connect) return { test, connect: 'N/A' };
    const body = await command(
      'curl',
      [
        '--noproxy',
        '',
        '--proxy',
        `socks5h://127.0.0.1:${mixed}`,
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '15',
        url,
      ],
      join(dir, `${label}-curl.log`),
    );
    if (body !== nonce) throw new Error('target response did not match nonce');
    return { test, connect: 'PASS' };
  } catch (e) {
    return {
      test,
      connect: test === 'PASS' ? 'FAIL' : 'SKIP',
      error: `${message(e)}; ${existsSync(log) ? short(readFileSync(log, 'utf8')) : ''}`,
    };
  } finally {
    if (child) await stop(child);
  }
}

async function xrayControl(
  service: Service,
  uri: string,
  url: string,
  nonce: string,
  dir: string,
  cert: string,
) {
  const config = service.config as {
    inbounds: {
      port: number;
      protocol: string;
      settings: { clients?: { id: string; flow?: string }[] };
      streamSettings?: Record<string, unknown>;
    }[];
  };
  const inbound = config.inbounds[0];
  if (!['vmess', 'vless'].includes(inbound.protocol)) return 'not implemented for this protocol';
  const mixed = await port();
  const u = inbound.protocol === 'vless' ? new URL(uri) : undefined;
  const stream = { ...inbound.streamSettings };
  if (stream.security === 'tls')
    stream.tlsSettings = { serverName: 'localhost', allowInsecure: true };
  if (stream.security === 'reality')
    stream.realitySettings = {
      serverName: 'localhost',
      fingerprint: 'chrome',
      publicKey: u?.searchParams.get('pbk'),
      shortId: u?.searchParams.get('sid'),
    };
  const users = inbound.settings.clients?.map((client) => ({
    ...client,
    ...(inbound.protocol === 'vless'
      ? { encryption: u?.searchParams.get('encryption') ?? 'none' }
      : { security: 'auto' }),
  }));
  try {
    await server(
      {
        core: 'xray',
        config: {
          log: { loglevel: 'debug' },
          inbounds: [
            { listen: '127.0.0.1', port: mixed, protocol: 'socks', settings: { auth: 'noauth' } },
          ],
          outbounds: [
            {
              protocol: inbound.protocol,
              settings: { vnext: [{ address: '127.0.0.1', port: inbound.port, users }] },
              streamSettings: stream,
            },
          ],
        },
      },
      dir,
      99,
      cert,
    );
    const body = await command(
      'curl',
      [
        '--noproxy',
        '',
        '--proxy',
        `socks5h://127.0.0.1:${mixed}`,
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '8',
        url,
      ],
      join(dir, 'control-curl.log'),
    );
    return body === nonce ? 'PASS' : 'FAIL (wrong target response)';
  } catch (e) {
    return `FAIL (${message(e)})`;
  }
}

async function keypair(kind: 'x25519' | 'wg') {
  const output = await command(binaries.xray, [kind]);
  const privateKey = output.match(/^PrivateKey: (.+)$/m)?.[1];
  const publicKey = output.match(/^Password \(PublicKey\): (.+)$/m)?.[1];
  if (!privateKey || !publicKey) throw new Error(`unexpected ${kind} key output`);
  return { privateKey, publicKey };
}

async function main() {
  if (!['all', 'clients', 'reality'].includes(mode))
    throw new Error('LAB_MODE must be all, clients, or reality');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const cert = join(directory, 'cert.pem');
  const key = join(directory, 'key.pem');
  await command(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    join(directory, 'openssl.log'),
  );
  const target = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const nonce = url.pathname.slice(1);
    appendFileSync(join(directory, 'target.log'), `${request.url}\n`);
    if (url.searchParams.has('slow')) {
      let ticks = 0;
      const timer = setInterval(() => {
        response.write('.');
        if (++ticks === 14) {
          clearInterval(timer);
          response.end(nonce);
        }
      }, 500);
      response.once('close', () => clearInterval(timer));
    } else response.end(nonce);
  });
  const camouflage = http2.createSecureServer(
    { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.3', allowHTTP1: true },
    (_req, res) => res.end('local camouflage'),
  );
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
  await new Promise<void>((done) => camouflage.listen(0, '127.0.0.1', done));
  const targetPort = (target.address() as net.AddressInfo).port;
  try {
    const versions: Record<string, string> = {};
    for (const core of Object.keys(binaries) as Core[]) {
      if (!existsSync(binaries[core])) {
        versions[core] = 'not installed';
        continue;
      }
      versions[core] = await command(
        binaries[core],
        core === 'mihomo' || core.startsWith('snell')
          ? ['-v']
          : core === 'v2ray-plugin'
            ? ['-version']
            : ['version'],
      );
    }
    writeFileSync(
      join(directory, 'versions.json'),
      JSON.stringify({ binaries, versions }, null, 2),
    );
    const encryptionOutput = await command(binaries.xray, ['vlessenc']);
    const encryption = [
      ...encryptionOutput.matchAll(/"decryption": "([^"]+)"\s+"encryption": "([^"]+)"/g),
    ].map((m) => ({ decryption: m[1], encryption: m[2] }));
    if (encryption.length !== 2) throw new Error('unexpected xray vlessenc output');
    const cases = await fixtures({
      port,
      cert,
      key,
      targetPort,
      tlsPort: (camouflage.address() as net.AddressInfo).port,
      reality: await keypair('x25519'),
      wgClient: await keypair('wg'),
      wgServer: await keypair('wg'),
      encryption,
    });
    const filter = process.env.CASE_FILTER ? new RegExp(process.env.CASE_FILTER) : undefined;
    const selected = cases.filter(
      (f) => (!filter || filter.test(f.name)) && (mode !== 'reality' || f.name.includes('reality')),
    );
    if (!selected.length) throw new Error('CASE_FILTER matched no cases');
    const baseline = await command('curl', [
      '--noproxy',
      '*',
      '--silent',
      '--show-error',
      '--max-time',
      '3',
      `http://127.0.0.1:${targetPort}/baseline`,
    ]);
    if (baseline !== 'baseline') throw new Error('direct target baseline failed');
    let bypass = false;
    try {
      await command('curl', [
        '--noproxy',
        '',
        '--proxy',
        `http://127.0.0.1:${await port()}`,
        '--silent',
        '--show-error',
        '--max-time',
        '2',
        `http://127.0.0.1:${targetPort}/must-not-arrive`,
      ]);
      bypass = true;
    } catch {
      /* A dead proxy must not reach the target. */
    }
    if (bypass) throw new Error('curl bypassed the dead proxy');
    console.log(`Artifacts: ${directory}`);
    const results: Result[] = [];
    for (const fixture of selected) {
      const result = await runCase(fixture, targetPort, cert);
      results.push(result);
      writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2));
      writeFileSync(join(directory, 'report.md'), markdown(results));
      console.log(
        `${fixture.name}: parse=${result.parse} validate=${result.validate} test=${result.test} server=${result.startup} connect=${result.connect} realityTrue=${result.realityTrue} sing=${result.singClient} xray=${result.xrayClient}`,
      );
    }
    console.log('\n' + markdown(results));
    console.log(`Report: ${join(directory, 'report.md')}`);
    if (
      results.some((r) =>
        [
          r.parse,
          r.validate,
          r.test,
          r.startup,
          r.connect,
          r.linkTest,
          r.linkConnect,
          r.exportStatus,
          r.realityTrue,
          r.singClient,
          r.xrayClient,
        ].some((s) => s === 'FAIL' || s === 'ERROR'),
      )
    )
      process.exitCode = 1;
  } finally {
    await Promise.all([...active].map(stop));
    target.closeAllConnections();
    target.close();
    camouflage.close();
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    for (const child of active) child.kill('SIGTERM');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
main().catch((e) => {
  console.error(message(e));
  process.exitCode = 1;
});
