#!/usr/bin/env node
// Pack the WXT chrome-mv3 build output into a signed .crx for distribution.
//
// Side effects:
//   - On first run, creates extension/key.pem (private signing key). The
//     extension's "id" is derived from this key, so DO NOT rotate it casually
//     and DO NOT commit it (it's in .gitignore). Lose this and existing
//     installs can't be updated as the same extension.
//   - Writes dist/proxymanager-{version}.crx.
//
// Run `npm run build` first (or use `npm run pack` which does both).

import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crx3 from 'crx3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'build/chrome-mv3');
const DIST = resolve(ROOT, 'dist');
const KEY = resolve(ROOT, 'key.pem');

if (!existsSync(SRC)) {
  console.error(`Build output not found at ${SRC}. Run \`npm run build\` first.`);
  process.exit(1);
}

const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

mkdirSync(DIST, { recursive: true });
const crxPath = resolve(DIST, `proxymanager-${version}.crx`);
const keyExistedBefore = existsSync(KEY);

await crx3([resolve(SRC, 'manifest.json')], {
  keyPath: KEY,
  crxPath,
});

console.log(`✓ ${crxPath}`);
if (keyExistedBefore) {
  console.log(`  signed with ${KEY}`);
} else {
  console.log(`  ⚠ new signing key created at ${KEY} — back it up safely.`);
  console.log(`  ⚠ the extension's id is derived from this key; lose it and updates break.`);
}
