#!/usr/bin/env node
// One-shot release: bump version → build → pack CRX → git commit + tag.
//
//   npm run release:patch   0.1.0 → 0.1.1
//   npm run release:minor   0.1.0 → 0.2.0
//   npm run release:major   0.1.0 → 1.0.0
//
// Does NOT push (you push manually after reviewing the tag). Run from
// extension/.

import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '..');
const PKG = resolve(ROOT, 'package.json');

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('Usage: release.mjs <patch|minor|major>');
  process.exit(1);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}
function runSilent(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// 1. Refuse if there are uncommitted changes inside extension/ —
//    a clean release commit needs a clean tree.
const dirty = runSilent('git status --porcelain extension').trim();
if (dirty) {
  console.error('Refusing to release: extension/ has uncommitted changes.');
  console.error(dirty);
  process.exit(1);
}

// 2. Bump version in package.json (no git tag; we tag ourselves at the end).
run(`npm version ${bump} --no-git-tag-version`);

const pkg = JSON.parse(await readFile(PKG, 'utf8'));
const version = pkg.version;
const tag = `extension-v${version}`;
console.log(`\n→ Bumped to ${version}`);

// 3. Build + pack.
run('npm run build');
run('npm run pack:crx');

// 4. Commit the version bump (only package.json + lockfile in extension/).
execSync(`git add extension/package.json extension/package-lock.json`, {
  stdio: 'inherit',
  cwd: REPO_ROOT,
});
execSync(`git commit -m "extension: release ${version}"`, {
  stdio: 'inherit',
  cwd: REPO_ROOT,
});
execSync(`git tag ${tag}`, { stdio: 'inherit', cwd: REPO_ROOT });

// 5. Done.
console.log(`\n✔ Released extension ${version}`);
console.log(`  CRX: extension/dist/proxymanager-${version}.crx`);
console.log(`  tag: ${tag} (not pushed; review then \`git push --tags\`)`);
