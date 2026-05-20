#!/usr/bin/env node
// Rasterise extension/assets/icon.svg into the PNG sizes Chrome MV3 wants.
// Run via `npm run icons`. Re-run whenever you edit icon.svg.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SVG_PATH = resolve(ROOT, 'assets/icon.svg');
const OUT_DIR = resolve(ROOT, 'public/icon');
const SIZES = [16, 32, 48, 96, 128];

const svg = await readFile(SVG_PATH);
await mkdir(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const out = resolve(OUT_DIR, `${size}.png`);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`✓ ${size}.png`);
}
