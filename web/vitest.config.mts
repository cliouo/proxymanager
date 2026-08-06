import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// ESM-safe web root: __dirname is undefined in .mts configs under several
// loaders; the file URL form resolves to the identical directory everywhere.
const WEB_ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(WEB_ROOT, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
