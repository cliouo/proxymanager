import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

async function main(): Promise<void> {
  const [binaryArgument, fixtureArgument] = process.argv.slice(2);
  if (!binaryArgument || !fixtureArgument) {
    throw new Error(
      'usage: tsx scripts/proxy-compat/validate-mihomo-fixtures.ts <mihomo-binary> <fixture-dir>',
    );
  }

  const binary = resolve(binaryArgument);
  const fixtureDirectory = resolve(fixtureArgument);
  const files = (await readdir(fixtureDirectory)).filter((name) => name.endsWith('.yaml')).sort();
  if (files.length === 0) throw new Error('fixture directory contains no YAML files');

  for (const name of files) {
    const home = await mkdtemp(resolve(tmpdir(), 'proxymanager-mihomo-audit-'));
    execFileSync(binary, ['-t', '-d', home, '-f', resolve(fixtureDirectory, name)], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    process.stdout.write(`PASS ${basename(name)}\n`);
  }
}

void main();
