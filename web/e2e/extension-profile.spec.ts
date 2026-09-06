import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('installed extension selects office without default and undoes the original profile', async () => {
  execFileSync(process.execPath, ['node_modules/wxt/bin/wxt.mjs', 'build'], {
    cwd: resolve('../extension'),
    stdio: 'pipe',
  });
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const requests: { method: string; path: string }[] = [];
  let capability = true;
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    res.setHeader('Content-Type', 'application/json');
    const path = new URL(req.url!, 'http://test').pathname;
    const data = path.endsWith('/meta')
      ? { capabilities: { profileIdScope: capability } }
      : path.endsWith('/profiles')
        ? [
            { id: a, name: 'office' },
            { id: b, name: 'travel' },
          ]
        : path.endsWith('/anchors')
          ? ['manual']
          : path.endsWith('/policies')
            ? ['DIRECT', 'REJECT']
            : [];
    res.end(JSON.stringify({ data, meta: { total: 0, configVersion: 7 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const extension = resolve('../extension/build/chrome-mv3');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const settings = {
      backendUrl: origin,
      adminKey: 'synthetic-test-key',
      clashUrl: '',
      clashSecret: '',
      candidateGroups: [],
      defaultAnchor: '',
      defaultRuleType: 'DOMAIN',
      speedtestTimeoutMs: 1000,
      autoReloadClash: false,
      profileId: '',
      profileName: '',
    };
    const setStorage = async (value: Record<string, unknown>) =>
      worker.evaluate(async (value) => {
        const api = (
          globalThis as unknown as {
            chrome: {
              storage: { local: { set: (value: Record<string, unknown>) => Promise<void> } };
            };
          }
        ).chrome;
        await api.storage.local.set(value);
      }, value);
    await setStorage({ 'proxymanager.settings': settings });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.getByLabel('写入 Profile').locator('option')).toHaveCount(3);
    await page.getByLabel('写入 Profile').selectOption(a);
    await expect
      .poll(() => requests.some((r) => r.path === `/api/v1/anchors?profileId=${a}`))
      .toBe(true);
    await expect
      .poll(() => requests.some((r) => r.path === `/api/v1/policies?profileId=${a}`))
      .toBe(true);
    await expect(page.getByText('写入配置 · office')).toBeVisible();
    await setStorage({
      'proxymanager.settings': { ...settings, profileId: b, profileName: 'travel' },
      'proxymanager.recentWrites': [
        {
          id: 'recent-1',
          ts: Date.now(),
          anchor: 'manual',
          ruleType: 'DOMAIN',
          value: 'original.example',
          policy: 'DIRECT',
          ruleId: 'original-rule',
          reloaded: false,
          target: { origin, profileId: a, profileName: 'office' },
        },
        {
          id: 'legacy',
          ts: Date.now() - 1,
          anchor: 'manual',
          ruleType: 'DOMAIN',
          value: 'legacy.example',
          policy: 'DIRECT',
          ruleId: 'legacy-rule',
          reloaded: false,
        },
      ],
    });
    await page.reload();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() =>
        requests.some(
          (r) => r.method === 'DELETE' && r.path === `/api/v1/rules/original-rule?profileId=${a}`,
        ),
      )
      .toBe(true);
    expect(requests.some((r) => r.method === 'DELETE' && r.path.includes(`profileId=${b}`))).toBe(
      false,
    );
    capability = false;
    const response = await page.evaluate(
      async (target) => {
        const api = (
          globalThis as unknown as {
            chrome: {
              runtime: {
                sendMessage: (value: unknown) => Promise<{ ok: boolean; error?: string }>;
              };
            };
          }
        ).chrome;
        return api.runtime.sendMessage({ type: 'deleteRule', ruleId: 'blocked-rule', target });
      },
      { origin, profileId: b, profileName: 'travel' },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain('升级服务器');
    expect(requests.some((r) => r.path.includes('blocked-rule'))).toBe(false);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
