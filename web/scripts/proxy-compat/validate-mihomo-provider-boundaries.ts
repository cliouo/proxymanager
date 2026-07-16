import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stringify } from 'yaml';

interface Probe {
  name: string;
  proxy: Record<string, unknown>;
  accepted: boolean;
}

async function main(): Promise<void> {
  const [binaryArgument, outputArgument] = process.argv.slice(2);
  if (!binaryArgument || !outputArgument) {
    throw new Error(
      'usage: tsx scripts/proxy-compat/validate-mihomo-provider-boundaries.ts ' +
        '<mihomo-binary> <output-dir>',
    );
  }

  const binary = resolve(binaryArgument);
  const outputDirectory = resolve(outputArgument);
  const UUID = '00000000-0000-4000-8000-000000000001';
  const probes: Probe[] = [
    {
      name: 'valid-ss',
      accepted: true,
      proxy: {
        name: 'AUDIT-NODE',
        type: 'ss',
        server: 'edge.invalid',
        port: 8388,
        cipher: 'aes-128-gcm',
        password: 'FAKE_ONLY',
      },
    },
    {
      name: 'valid-vless',
      accepted: true,
      proxy: {
        name: 'AUDIT-NODE',
        type: 'vless',
        server: 'edge.invalid',
        port: 443,
        uuid: UUID,
        'packet-encoding': 'xudp',
      },
    },
    {
      name: 'valid-hysteria2-without-password',
      accepted: true,
      proxy: { name: 'AUDIT-NODE', type: 'hysteria2', server: 'edge.invalid', port: 443 },
    },
    {
      name: 'valid-hysteria2-ports-only',
      accepted: true,
      proxy: {
        name: 'AUDIT-NODE',
        type: 'hysteria2',
        server: 'edge.invalid',
        ports: '443,8443-8444',
      },
    },
    {
      name: 'valid-hysteria-ports-only',
      accepted: true,
      proxy: {
        name: 'AUDIT-NODE',
        type: 'hysteria',
        server: 'edge.invalid',
        ports: '443,8443-8444',
        up: '10 Mbps',
        down: '20 Mbps',
      },
    },
    {
      name: 'valid-wireguard-flat',
      accepted: true,
      proxy: {
        name: 'AUDIT-NODE',
        type: 'wireguard',
        server: 'edge.invalid',
        port: 51820,
        ip: '10.0.0.2/32',
        'private-key': Buffer.alloc(32, 1).toString('base64'),
        'public-key': Buffer.alloc(32, 2).toString('base64'),
      },
    },
    {
      name: 'build-dependent-tailscale',
      accepted: true,
      proxy: { name: 'AUDIT-NODE', type: 'tailscale', hostname: 'audit-node' },
    },
    {
      name: 'unknown-type',
      accepted: false,
      proxy: { name: 'AUDIT-NODE', type: 'future-unknown', server: 'edge.invalid', port: 443 },
    },
    {
      name: 'policy-as-proxy',
      accepted: false,
      proxy: { name: 'AUDIT-NODE', type: 'select', server: 'edge.invalid', port: 443 },
    },
    {
      name: 'ss-without-credentials',
      accepted: false,
      proxy: { name: 'AUDIT-NODE', type: 'ss', server: 'edge.invalid', port: 8388 },
    },
    {
      name: 'valid-vmess-custom-id',
      accepted: true,
      proxy: {
        name: 'AUDIT-NODE',
        type: 'vmess',
        server: 'edge.invalid',
        port: 443,
        uuid: 'example',
        alterId: 0,
        cipher: 'auto',
      },
    },
    {
      name: 'rematch-without-target',
      accepted: false,
      proxy: { name: 'AUDIT-NODE', type: 'rematch' },
    },
    {
      name: 'weak-numeric-string-port',
      accepted: true,
      proxy: { name: 'AUDIT-NODE', type: 'http', server: 'edge.invalid', port: '443' },
    },
    {
      name: 'weak-numeric-server',
      accepted: true,
      proxy: { name: 'AUDIT-NODE', type: 'http', server: 203000113001, port: 443 },
    },
    {
      name: 'weak-overflow-port',
      accepted: true,
      proxy: { name: 'AUDIT-NODE', type: 'http', server: 'edge.invalid', port: 70000 },
    },
  ];

  await mkdir(outputDirectory, { recursive: true });
  for (const probe of probes) {
    const configPath = resolve(outputDirectory, `${probe.name}.yaml`);
    await writeFile(
      configPath,
      stringify(
        {
          'mixed-port': 17892,
          mode: 'rule',
          'log-level': 'silent',
          proxies: [probe.proxy],
          'proxy-groups': [{ name: 'AUDIT', type: 'select', proxies: ['AUDIT-NODE'] }],
          rules: ['MATCH,AUDIT'],
        },
        { lineWidth: 0 },
      ),
      { mode: 0o600 },
    );
    const home = await mkdtemp(resolve(tmpdir(), 'proxymanager-mihomo-provider-audit-'));
    const run = spawnSync(binary, ['-t', '-d', home, '-f', configPath], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const actual = run.status === 0;
    if (actual !== probe.accepted) {
      throw new Error(
        `${probe.name}: expected ${probe.accepted ? 'ACCEPT' : 'REJECT'}, got ${
          actual ? 'ACCEPT' : 'REJECT'
        }`,
      );
    }
    process.stdout.write(`${actual ? 'ACCEPT' : 'REJECT'} ${probe.name}\n`);
  }
}

void main();
