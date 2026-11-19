// Keeps every fixture server running for manual GUI-client tests and writes the
// parsed nodes (named after their fixture) as a local-source YAML. Not part of run.ts.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
import { fixtures, type Core, type Service } from './fixtures';

const execute = promisify(execFile);
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(web, '.tmp/core-compat', `serve-${process.pid}`);
const cores = join(homedir(), 'cores');
const exe = process.platform === 'win32' ? '.exe' : '';
const binaries: Record<Core, string> = {
  mihomo: process.env.MIHOMO_BIN ?? join(cores, `mihomo${exe}`),
  'sing-box': process.env.SING_BOX_BIN ?? join(cores, `sing-box${exe}`),
  xray: process.env.XRAY_BIN ?? join(cores, `xray${exe}`),
  xray18: process.env.XRAY18_BIN ?? join(cores, `xray-1.8.24/xray${exe}`),
  xray25: process.env.XRAY25_BIN ?? join(cores, `xray-25.3.6/xray${exe}`),
  'v2ray-plugin':
    process.env.V2RAY_PLUGIN_BIN ??
    join(cores, exe ? 'v2ray-plugin_windows_amd64.exe' : 'v2ray-plugin_linux_amd64'),
  snell4: process.env.SNELL4_BIN ?? (exe ? '/root/cores/snell4/snell-server' : join(cores, 'snell4/snell-server')),
  snell5: process.env.SNELL5_BIN ?? (exe ? '/root/cores/snell5/snell-server' : join(cores, 'snell5/snell-server')),
};
// Snell has no Windows server; on Windows SNELL*_BIN are Linux paths run through WSL.
const viaWsl = (core: Core) => exe !== '' && core.startsWith('snell');
const wslPath = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`).split(String.fromCharCode(92)).join('/');
const children: ChildProcess[] = [];
const realityVariants = ['vless-reality-vision', 'vless-reality-grpc'];
// WSL reaches the Windows target through its default gateway, not 127.0.0.1.
let wslHost = '';
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const issued = new Set<number>();
async function port(): Promise<number> {
  for (;;) {
    const value = await freePort();
    if (!issued.has(value)) return issued.add(value), value;
  }
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((done, reject) =>
    listener.once('error', reject).listen(0, '127.0.0.1', done),
  );
  const value = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return value;
}

async function server(service: Service, stem: string, cert: string) {
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
      mkdirSync(`${stem}-home`, { recursive: true });
      args = ['-d', `${stem}-home`, '-f', file];
    } else if (service.core === 'sing-box' || service.core.startsWith('xray'))
      args = ['run', '-c', file];
    else args = ['-c', viaWsl(service.core) ? wslPath(file) : file];
  }
  const log = `${stem}.log`;
  const [bin, argv] = viaWsl(service.core)
    ? ['wsl.exe', ['-e', binaries[service.core], ...args]]
    : [binaries[service.core], args];
  const child = spawn(bin, argv, {
    env: { ...process.env, SSL_CERT_FILE: cert },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (d) => appendFileSync(log, d));
  child.stderr?.on('data', (d) => appendFileSync(log, d));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${service.core} exited: ${stem}.log`);
    const out = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (/started|listening|Listening|listener|Listen at|Start snell server|TCP server running|UDP server running/.test(out))
      return;
    await delay(50);
  }
  throw new Error(`readiness timeout: ${log}`);
}

async function udpRelay(backendPort: number) {
  const backend = dgram.createSocket('udp4');
  const fronts = Array.from({ length: 16 }, () => dgram.createSocket('udp4'));
  let recipient: { socket: dgram.Socket; port: number; address: string } | undefined;
  await new Promise<void>((done) => backend.bind(0, '127.0.0.1', done));
  backend.on('message', (data) => {
    if (recipient) recipient.socket.send(data, recipient.port, recipient.address);
  });
  for (const socket of fronts) {
    socket.on('message', (data, remote) => {
      recipient = { socket, port: remote.port, address: remote.address };
      backend.send(data, backendPort, '127.0.0.1');
    });
    await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done));
  }
  return fronts.map((s) => s.address().port);
}

async function keypair(kind: 'x25519' | 'wg') {
  const { stdout } = await execute(binaries.xray, [kind]);
  const privateKey = stdout.match(/^PrivateKey: (.+)$/m)?.[1]?.trim();
  const publicKey = stdout.match(/^Password \(PublicKey\): (.+)$/m)?.[1]?.trim();
  if (!privateKey || !publicKey) throw new Error(`unexpected ${kind} key output`);
  return { privateKey, publicKey };
}

async function main() {
  mkdirSync(directory, { recursive: true });
  if (exe) {
    const { stdout } = await execute('wsl.exe', ['-e', 'ip', 'route', 'show', 'default']);
    wslHost = stdout.split(/\s+/)[2] ?? '';
  }
  // A stable LAB_CERT_DIR lets a GUI client trust the lab CA once (Windows Go
  // ignores SSL_CERT_FILE).
  const certDir = process.env.LAB_CERT_DIR ?? directory;
  mkdirSync(certDir, { recursive: true });
  const cert = join(certDir, 'cert.pem');
  const key = join(certDir, 'key.pem');
  if (!existsSync(cert)) await execute('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ]);
  const targetLog = join(directory, 'target.log');
  const target = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    appendFileSync(targetLog, `${new Date().toISOString()} ${request.headers.host} ${request.url}\n`);
    response.end(url.pathname.slice(1));
  });
  const camouflage = http2.createSecureServer(
    { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.3', allowHTTP1: true },
    (_req, res) => res.end('local camouflage'),
  );
  await new Promise<void>((done) => target.listen(0, wslHost ? '0.0.0.0' : '127.0.0.1', done));
  await new Promise<void>((done) => camouflage.listen(0, '127.0.0.1', done));
  const targetPort = (target.address() as net.AddressInfo).port;
  const { stdout: enc } = await execute(binaries.xray, ['vlessenc']);
  const encryption = [...enc.matchAll(/"decryption": "([^"]+)"\s+"encryption": "([^"]+)"/g)].map(
    (m) => ({ decryption: m[1], encryption: m[2] }),
  );
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
  const nodes: Record<string, unknown>[] = [];
  const manifest: { name: string; uri: string; targetHost: string; error?: string }[] = [];
  for (const f of cases) {
    // Server-version variants reuse their original's port and client URI. Reality
    // vision/gRPC is served by Xray 25 so the Mihomo X25519MLKEM768 split (see
    // docs/core-compatibility.md) does not mask client import differences.
    if (f.unavailable || !f.services.length || /-(sing-box|xray18)$/.test(f.name)) continue;
    if (realityVariants.includes(f.name)) continue;
    const name = f.name.replace(/-xray25$/, '');
    let uri = f.uri;
    try {
      if (f.hopping) {
        const backendPort = Number(new URL(uri).port);
        const ports = await udpRelay(backendPort);
        uri = uri.replace(`:${backendPort}?`, `:${ports.join(',')}?`);
      }
      for (const [i, s] of f.services.entries())
        await server(s, join(directory, `${f.name}-${i}-${s.core}`), cert);
      const parsed = parseProxyUriList(uri);
      if (parsed.errors.length || parsed.proxies.length !== 1) throw new Error('parse failed');
      const [node] = validateMihomoProxyList(parsed.proxies);
      nodes.push({ ...node, name });
      manifest.push({ name, uri, targetHost: viaWsl(f.services[0].core) ? wslHost : (f.targetHost ?? '127.0.0.1') });
      console.log(`up: ${name}`);
    } catch (e) {
      manifest.push({ name, uri, targetHost: '', error: String(e) });
      console.log(`FAIL: ${name}: ${e}`);
    }
  }
  writeFileSync(join(directory, 'nodes.yaml'), stringify({ proxies: nodes }));
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({ targetPort, cert, targetLog, nodes: manifest }, null, 2),
  );
  console.log(`READY ${directory} target=${targetPort} nodes=${nodes.length}`);
}

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
main().catch((e) => {
  console.error(e);
  shutdown();
});
