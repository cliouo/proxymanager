import { expect, test, type Locator, type Page } from '@playwright/test';
import QRCode from 'qrcode';

const base = 'http://127.0.0.1:3127/api/sub/test-token/home';
const devices = ['phone', 'tablet'].map((name) => ({
  id: name,
  name,
  base_patch: {},
  features: {},
}));
const issue = {
  status: 'unverified',
  ruleNumber: 3,
  ruleType: 'RULE-SET',
  target: '出口',
  reference: 'remote',
  reason: '远程正文待核验',
};

async function workspace(page: Page, list = devices) {
  await page.addInitScript(() => localStorage.setItem('pm.admin-key', 'test-admin'));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
    const profiles = [{ id: 'p', name: 'home', kind: 'normal' }];
    const data: Record<string, unknown> = {
      '/bootstrap': { profiles, status: { state: 'configured' } },
      '/profiles': profiles,
      '/dashboard': { meta: { subscriptionUrl: base }, counts: { proxyGroups: 0, rules: 0 } },
      '/profiles/p/devices': list,
    };
    for (const device of list) {
      data['/profiles/p/devices/' + device.id] = device;
      data['/profiles/p/devices/' + device.id + '/preview'] = {
        shared: '{}',
        device: '{}',
        issues: [],
      };
    }
    return route.fulfill({ json: { data: data[path] ?? [] } });
  });
}

async function copiedAndScannable(page: Page, scope: Locator, copy: Locator, url: string) {
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  const expectedPath = [...svg.matchAll(/ d="([^"]+)"/g)].at(-1)![1];
  await expect(
    scope.getByRole('img', { name: '订阅链接二维码' }).locator('path').last(),
  ).toHaveAttribute('d', expectedPath);
}

async function globalShare(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: '订阅链接与二维码' }).click();
  return page.getByRole('dialog');
}

test('copies and scans the selected device from the list, editor shortcut and global device rows', async ({
  page,
}) => {
  await workspace(page);
  await page.goto('/p/home/devices');
  for (const entry of ['list', 'editor']) {
    if (entry === 'editor') await page.getByRole('link', { name: 'phone', exact: true }).click();
    await page.getByRole('button', { name: '复制或扫码 · phone' }).click();
    const popover = page.getByRole('dialog');
    for (const [format, suffix] of [
      ['shadowrocket', '?client=shadowrocket'],
      ['base64', '?format=base64'],
    ]) {
      await popover.getByLabel('订阅用途').selectOption(format);
      await copiedAndScannable(
        page,
        popover,
        popover.getByRole('button', { name: '复制链接' }),
        base + '/phone' + suffix,
      );
    }
    await page.keyboard.press('Escape');
  }
  await page.locator('a[href="/p/home/devices"]').first().click();
  await page.getByRole('button', { name: 'phone 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '复制链接' }).click();
  const menuShare = page.getByRole('dialog');
  await menuShare.getByLabel('订阅用途').selectOption('shadowrocket');
  await copiedAndScannable(
    page,
    menuShare,
    menuShare.getByRole('button', { name: '复制链接' }),
    base + '/phone?client=shadowrocket',
  );
  await page.keyboard.press('Escape');
  const share = await globalShare(page);
  await share.getByLabel('订阅用途').selectOption('shadowrocket');
  await expect(share.getByText('共享配置', { exact: true })).toHaveCount(0);
  for (const format of ['shadowrocket', 'base64']) {
    await share.getByLabel('订阅用途').selectOption(format);
    const row = share.getByText('设备 · tablet').locator('../../..');
    await row.getByRole('button', { name: '显示二维码' }).click();
    await copiedAndScannable(
      page,
      share,
      row.getByRole('button', { name: '复制' }),
      base + '/tablet?' + (format === 'shadowrocket' ? 'client=shadowrocket' : 'format=base64'),
    );
  }
});

test('shows rule diagnostics and recovery on the saved link, with ordinary auth and network errors', async ({
  page,
}) => {
  await workspace(page);
  await page.goto('/p/home/devices/phone');
  const card = page.getByRole('region', { name: '设备订阅链接' });
  await card.getByLabel('订阅用途').selectOption('shadowrocket');
  const url = base + '/phone?client=shadowrocket';
  let attempt = 0;
  await page.route(url, async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    attempt++;
    if (attempt === 1)
      return route.fulfill({
        status: 422,
        json: { errors: [issue, { ...issue, status: 'incompatible', ruleNumber: 4 }] },
      });
    if (attempt === 2) return route.fulfill({ body: 'rules: []', contentType: 'text/yaml' });
    if (attempt === 3) return route.fulfill({ status: 401 });
    return route.abort();
  });
  const check = card.getByRole('button', { name: '重新检查' });
  await check.click();
  for (const part of [
    '待验证',
    '已知不兼容',
    '第 3 条',
    'RULE-SET',
    '出口',
    'remote',
    '远程正文待核验',
  ]) {
    await expect(card.getByRole('status')).toContainText(part);
  }
  await copiedAndScannable(page, card, card.getByRole('button', { name: '复制' }), url);
  await check.click();
  await expect(card.getByRole('status')).toContainText('检查通过');
  await check.click();
  await expect(card.getByRole('status')).toContainText('订阅令牌');
  await check.click();
  await expect(card.getByRole('status')).toContainText('网络');
});

test('shows an add-device hint for an empty Shadowrocket share list', async ({ page }) => {
  await workspace(page, []);
  await page.goto('/p/home/devices');
  await expect(page.getByText('还没有设备')).toBeVisible();
  const share = await globalShare(page);
  await share.getByLabel('订阅用途').selectOption('shadowrocket');
  await expect(share).toContainText('请先添加设备');
  await expect(share.getByRole('img')).toHaveCount(0);
});

test('discards a late check after navigating to another device', async ({ page }) => {
  await workspace(page);
  // Deliberately finish the old request even when the caller aborts its signal.
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith('/phone?client=shadowrocket')) {
        return new Promise<Response>((resolve) => {
          window.addEventListener(
            'finish-old-check',
            () =>
              resolve(
                Response.json(
                  {
                    errors: [
                      {
                        status: 'unverified',
                        ruleNumber: 1,
                        ruleType: 'MATCH',
                        target: 'DIRECT',
                        reason: '旧设备结果',
                      },
                    ],
                  },
                  { status: 422 },
                ),
              ),
            { once: true },
          );
        });
      }
      return fetch(input, init);
    };
  });
  await page.goto('/p/home/devices/phone');
  const card = page.getByRole('region', { name: '设备订阅链接' });
  await card.getByLabel('订阅用途').selectOption('shadowrocket');
  await card.getByRole('button', { name: '重新检查' }).click();
  await expect(card.getByRole('status')).toContainText('正在检查');
  await page.locator('a[href="/p/home/devices"]').first().click();
  await page.getByRole('link', { name: 'tablet', exact: true }).click();
  await card.getByLabel('订阅用途').selectOption('shadowrocket');
  await page.route(base + '/tablet?client=shadowrocket', (route) =>
    route.fulfill({ body: 'rules: []', contentType: 'text/yaml' }),
  );
  await card.getByRole('button', { name: '重新检查' }).click();
  await expect(card.getByRole('status')).toHaveText('检查通过');
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('finish-old-check'));
    await new Promise(requestAnimationFrame);
  });
  await expect(card.getByRole('status')).toHaveText('检查通过');
});

test('reads all issues in a long report in batches', async ({ page }) => {
  await workspace(page);
  const url = base + '/phone?client=shadowrocket';
  const errors = Array.from({ length: 120 }, (_, i) => ({ ...issue, ruleNumber: i + 1 }));
  await page.route(url, (route) => route.fulfill({ status: 422, json: { errors } }));
  await page.goto('/p/home/devices/phone');
  const card = page.getByRole('region', { name: '设备订阅链接' });
  await card.getByLabel('订阅用途').selectOption('shadowrocket');
  await card.getByRole('button', { name: '重新检查' }).click();
  await expect(card.getByRole('status')).toContainText('第 1 条');
  await expect(card.getByRole('status')).not.toContainText('第 120 条');
  while (await card.getByRole('button', { name: '显示更多诊断' }).isVisible()) {
    await card.getByRole('button', { name: '显示更多诊断' }).click();
  }
  await expect(card.getByRole('status')).toContainText('第 120 条');
});

test('invalidates a successful check after saving the same device URL', async ({ page }) => {
  await workspace(page);
  const device = { ...devices[0], updated_at: 1, notes: '' };
  await page.route('**/api/v1/profiles/p/devices/phone', (route) => {
    if (route.request().method() === 'PATCH')
      Object.assign(device, route.request().postDataJSON(), { updated_at: 2 });
    return route.fulfill({ json: { data: device } });
  });
  await page.route(base + '/phone?client=shadowrocket', (route) =>
    route.fulfill({ contentType: 'text/yaml', body: 'rules: []' }),
  );
  await page.goto('/p/home/devices/phone');
  const card = page.getByRole('region', { name: '设备订阅链接' });
  await card.getByLabel('订阅用途').selectOption('shadowrocket');
  await card.getByRole('button', { name: '重新检查' }).click();
  await expect(card.getByRole('status')).toHaveText('检查通过');
  await page.getByPlaceholder('例如：书房 NAS，只跑下载').fill('更新设备');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(card.getByRole('status')).toBeEmpty();
});
