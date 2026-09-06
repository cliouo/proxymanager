import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:3127',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.PM_E2E_PRODUCTION
      ? 'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3127'
      : 'node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3127',
    url: 'http://127.0.0.1:3127/login',
    reuseExistingServer: !process.env.CI && !process.env.PM_E2E_PRODUCTION,
    timeout: 120_000,
  },
});
