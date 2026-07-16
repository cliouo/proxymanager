import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Core = 'xray' | 'v2ray' | 'sing-box';

interface Probe {
  name: string;
  core: Core;
  config: Record<string, unknown>;
}

interface ProbeResult {
  name: string;
  core: Core;
  accepted: boolean;
  exitCode: number | null;
}

async function main(): Promise<void> {
  const [xrayArgument, singBoxArgument, v2rayArgument, vlessencArgument, outputArgument] =
    process.argv.slice(2);

  if (!xrayArgument || !singBoxArgument || !v2rayArgument || !vlessencArgument || !outputArgument) {
    throw new Error(
      'usage: tsx scripts/proxy-compat/validate-core-comparison.ts ' +
        '<xray> <sing-box> <v2ray> <xray-vlessenc-output> <output-dir>',
    );
  }

  const binaries: Record<Core, string> = {
    xray: resolve(xrayArgument),
    'sing-box': resolve(singBoxArgument),
    v2ray: resolve(v2rayArgument),
  };
  const outputDirectory = resolve(outputArgument);
  const UUID = '00000000-0000-4000-8000-000000000000';

  const vlessenc = await readFile(resolve(vlessencArgument), 'utf8');
  const encryptions = Array.from(
    vlessenc.matchAll(/^"encryption": "([^"]+)"$/gm),
    (match) => match[1],
  );
  if (
    encryptions.length !== 2 ||
    encryptions.some((value) => !value.startsWith('mlkem768x25519plus.native.0rtt.'))
  ) {
    throw new Error('unexpected xray vlessenc output shape');
  }
  const [x25519Encryption, mlkemEncryption] = encryptions;

  function xrayStyleConfig(encryption: string | undefined): Record<string, unknown> {
    const user: Record<string, unknown> = { id: UUID };
    if (encryption !== undefined) user.encryption = encryption;
    return {
      log: { loglevel: 'none' },
      outbounds: [
        {
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: 'comparison.invalid',
                port: 443,
                users: [user],
              },
            ],
          },
          streamSettings: { network: 'tcp', security: 'none' },
        },
      ],
    };
  }

  function singBoxConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      log: { disabled: true },
      outbounds: [
        {
          type: 'vless',
          tag: 'comparison',
          server: 'comparison.invalid',
          server_port: 443,
          uuid: UUID,
          ...extra,
        },
      ],
    };
  }

  const probes: Probe[] = [
    { name: 'none', core: 'xray', config: xrayStyleConfig('none') },
    { name: 'omitted', core: 'xray', config: xrayStyleConfig(undefined) },
    { name: 'empty', core: 'xray', config: xrayStyleConfig('') },
    { name: 'generated-x25519', core: 'xray', config: xrayStyleConfig(x25519Encryption) },
    { name: 'generated-mlkem', core: 'xray', config: xrayStyleConfig(mlkemEncryption) },
    { name: 'none', core: 'v2ray', config: xrayStyleConfig('none') },
    { name: 'omitted', core: 'v2ray', config: xrayStyleConfig(undefined) },
    { name: 'empty', core: 'v2ray', config: xrayStyleConfig('') },
    { name: 'generated-x25519', core: 'v2ray', config: xrayStyleConfig(x25519Encryption) },
    { name: 'generated-mlkem', core: 'v2ray', config: xrayStyleConfig(mlkemEncryption) },
    { name: 'baseline', core: 'sing-box', config: singBoxConfig() },
    {
      name: 'packet-encoding-xudp',
      core: 'sing-box',
      config: singBoxConfig({ packet_encoding: 'xudp' }),
    },
    {
      name: 'xray-encryption-field',
      core: 'sing-box',
      config: singBoxConfig({ encryption: 'none' }),
    },
  ];

  function commandFor(core: Core, configPath: string): string[] {
    if (core === 'xray') return ['run', '-test', '-c', configPath];
    if (core === 'v2ray') return ['test', '-c', configPath];
    return ['check', '-c', configPath];
  }

  await mkdir(outputDirectory, { recursive: true });
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const configPath = resolve(outputDirectory, `${probe.core}-${probe.name}.json`);
    await writeFile(configPath, `${JSON.stringify(probe.config, null, 2)}\n`, { mode: 0o600 });
    const run = spawnSync(binaries[probe.core], commandFor(probe.core, configPath), {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const result: ProbeResult = {
      name: probe.name,
      core: probe.core,
      accepted: run.status === 0,
      exitCode: run.status,
    };
    results.push(result);
    process.stdout.write(`${result.accepted ? 'ACCEPT' : 'REJECT'} ${probe.core} ${probe.name}\n`);
  }

  await writeFile(
    resolve(outputDirectory, 'comparison-results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
    { mode: 0o600 },
  );
}

void main();
