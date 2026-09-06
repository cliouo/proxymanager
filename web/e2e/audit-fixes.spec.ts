import { test, expect } from '@playwright/test';
import { mockWorkspace, openBase, profiles, initialBase, sub } from './fixtures';

test('two tabs keep distinct IDs despite shared cookies and cancelled switching', async ({
  context,
  page,
}) => {
  const { requests, bases } = await mockWorkspace(context);
  await openBase(page);
  const second = await context.newPage();
  await second.addInitScript((id) => sessionStorage.setItem('pm.profileId', id), profiles[1].id);
  await openBase(second);
  await context.addCookies([
    { name: 'pm.active_profile', value: 'office', url: 'http://127.0.0.1:3127' },
  ]);
  await page.locator('.cm-content').fill(initialBase + '# tab-A-draft');
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  await page.locator('.profile-switch').click();
  await page.locator('.pp-pick').filter({ hasText: 'office' }).click();
  expect(dialogs).toBe(1);
  await expect(page.locator('.topbar')).toContainText('default');
  await expect(page.locator('.cm-content')).toContainText('tab-A-draft');
  await page.getByRole('button', { name: /^保存/ }).click();
  await expect.poll(() => bases[profiles[0].id]).toContain('tab-A-draft');
  await second.locator('.cm-content').fill(initialBase + '# tab-B-draft');
  await second.getByRole('button', { name: /^保存/ }).click();
  await expect.poll(() => bases[profiles[1].id]).toContain('tab-B-draft');
  expect(
    requests.filter((r) => r.path === '/api/v1/base' && r.method === 'PUT').map((r) => r.scope),
  ).toEqual(profiles.map((p) => p.id));
});

test('source refresh and refresh failure preserve the editor and block writes', async ({
  context,
  page,
}) => {
  const { controls, requests } = await mockWorkspace(context);
  await openBase(page);
  await page.locator('.cm-content').fill(initialBase + '# retain-source-draft');
  await page
    .locator('select')
    .filter({ has: page.locator(`option[value="sub:${sub.id}"]`) })
    .selectOption(`sub:${sub.id}`);
  await expect(page.locator('.cm-content')).toContainText('retain-source-draft');
  await expect(page.getByRole('button', { name: /^保存/ })).toBeEnabled();
  controls.failProfiles = true;
  await page
    .locator('select')
    .filter({ has: page.locator('option[value="none"]') })
    .selectOption('none');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Profile read unavailable' }),
  ).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('retain-source-draft');
  await expect(page.getByRole('button', { name: /^保存/ })).toBeDisabled();
  await page.locator('.cm-content').press('Control+s');
  expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
});

test('saving version one retains edits typed during the request', async ({ context, page }) => {
  const { controls, bases } = await mockWorkspace(context);
  controls.delaySave = 700;
  await openBase(page);
  await page.locator('.cm-content').fill(initialBase + '# submitted-version');
  await page.getByRole('button', { name: /^保存/ }).click();
  await page.locator('.cm-content').fill(initialBase + '# newer-version');
  await expect.poll(() => bases[profiles[0].id]).toContain('submitted-version');
  await expect(page.locator('.cm-content')).toContainText('newer-version');
  await expect(page.getByRole('button', { name: /^保存/ })).toBeEnabled();
  await page.getByRole('button', { name: /^保存/ }).click();
  await expect.poll(() => bases[profiles[0].id]).toContain('newer-version');
  await expect(page.getByRole('button', { name: /^保存/ })).toBeDisabled();
});

test('rule-set selection and rule navigation protect unsaved forms', async ({ context, page }) => {
  await mockWorkspace(context);
  await page.goto('/rule-sets');
  await expect(page.locator('.cm-content')).toContainText('example.com');
  await page.locator('.cm-content').fill('payload:\n  - unsaved.example\n');
  let dialogs = 0;
  const dismiss = async (dialog: import('@playwright/test').Dialog) => {
    dialogs++;
    await dialog.dismiss();
  };
  page.on('dialog', dismiss);
  await page.locator('.md-list button').filter({ hasText: 'set-b' }).click();
  expect(dialogs).toBe(1);
  await expect(page.locator('.cm-content')).toContainText('unsaved.example');
  page.off('dialog', dismiss);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.side-nav a[href="/rules"]').click();
  await expect(page.getByText('domain-0.example', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '＋ 新增规则' }).click();
  await page.getByPlaceholder('值（如 emby.media）').fill('draft.example');
  page.on('dialog', dismiss);
  await page.locator('.side-nav a[href="/base"]').click();
  await expect(page.getByPlaceholder('值（如 emby.media）')).toHaveValue('draft.example');
});

test('pagination reaches rule 1001 and search includes the full dataset', async ({
  context,
  page,
}) => {
  const { requests } = await mockWorkspace(context);
  await page.goto('/rules');
  await expect(page.getByText('domain-99.example', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('domain-100.example', { exact: true })).toBeVisible();
  await page.getByPlaceholder('搜索值 / 备注 / 修饰符…').fill('domain-1000.example');
  await expect(page.getByText('domain-1000.example', { exact: true })).toBeVisible();
  expect(requests.some((r) => r.path === '/api/v1/rules' && r.query.includes('offset=100'))).toBe(
    true,
  );
  expect(
    requests.some((r) => r.path === '/api/v1/rules' && r.query.includes('q=domain-1000.example')),
  ).toBe(true);
});

for (const status of [404, 422, 502])
  test(`preview ${status} disables ordinary exports and labels retained content`, async ({
    context,
    page,
  }) => {
    const { controls } = await mockWorkspace(context);
    await page.goto('/config');
    await expect(page.getByText('配置已就绪', { exact: true })).toBeVisible();
    controls.failPreview = status;
    await page.getByRole('button', { name: '重新检查' }).click();
    await expect(page.getByText('上次成功版本，最新检查失败', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '下载 YAML', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '复制 YAML', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '导出上次成功版本' })).toBeEnabled();
  });

test('mobile topbar remains reachable and modal focus is trapped/restored', async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockWorkspace(context);
  await openBase(page);
  for (const label of ['打开导航', '更多操作']) {
    const button = page.getByLabel(label);
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  }
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('dialog', { name: '主导航' })).toBeVisible();
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.side')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused();
  await page.getByRole('button', { name: '锚点 / 检查' }).click();
  await expect(page.getByRole('dialog', { name: '锚点与检查' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '锚点 / 检查' })).toBeFocused();
  expect(
    await page
      .locator('aside[aria-label="锚点与检查"]')
      .evaluate((el) => getComputedStyle(el).boxShadow),
  ).toBe('none');
});

test('source state shows actual usage and distribution dialog traps focus', async ({
  context,
  page,
}) => {
  await mockWorkspace(context);
  await page.goto('/subscriptions');
  await page.getByRole('button', { name: /分发/ }).first().click();
  const modal = page.getByRole('dialog', { name: '分发设置' });
  await expect(modal.getByRole('button', { name: '启用订阅源' })).toBeVisible();
  await expect(modal).toContainText('combined');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.dist')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('accepted profile switching asks once and removes the temporary history entry', async ({
  context,
  page,
}) => {
  await mockWorkspace(context);
  await openBase(page);
  const originalLength = await page.evaluate(() => history.length);
  await page.locator('.cm-content').fill(initialBase + '# unsaved');
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.accept();
  });
  await page.locator('.profile-switch').click();
  await page.locator('.pp-pick').filter({ hasText: 'office' }).click();
  await expect(page.locator('.topbar')).toContainText('office');
  expect(dialogs).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('pm.profileId'))).toBe(profiles[1].id);
  // Forward history may retain the old duplicate, but the current index must
  // no longer be the protected entry after the document was replaced.
  expect(await page.evaluate(() => Boolean(history.state?.__proxymanagerUnsavedGuard))).toBe(false);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(originalLength + 1);
});

test('browser Back cancellation keeps the rule draft; form Cancel asks only once', async ({
  context,
  page,
}) => {
  await mockWorkspace(context);
  await openBase(page);
  await page.locator('.side-nav a[href="/rules"]').click();
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await page.getByPlaceholder('值（如 emby.media）').fill('keep-draft.example');
  let dialogs = 0;
  const dismiss = async (dialog: import('@playwright/test').Dialog) => {
    dialogs++;
    await dialog.dismiss();
  };
  page.on('dialog', dismiss);
  await page.evaluate(() => history.back());
  await expect.poll(() => dialogs).toBe(1);
  await expect(page.getByPlaceholder('值（如 emby.media）')).toHaveValue('keep-draft.example');
  page.off('dialog', dismiss);
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.accept();
  });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByPlaceholder('值（如 emby.media）')).toHaveCount(0);
  expect(dialogs).toBe(2);
});

test('deleted active profile retains the draft and allows explicit recovery', async ({
  context,
  page,
}) => {
  const { localProfiles } = await mockWorkspace(context);
  await openBase(page);
  await page.locator('.cm-content').fill(initialBase + '# orphan-draft');
  localProfiles.splice(0, 1);
  await page
    .locator('select')
    .filter({ has: page.locator(`option[value="sub:${sub.id}"]`) })
    .selectOption(`sub:${sub.id}`);
  await expect(page.getByRole('button', { name: /^保存/ })).toBeDisabled();
  await expect(page.locator('.cm-content')).toContainText('orphan-draft');
  await page.locator('.profile-switch').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.pp-pick').filter({ hasText: 'office' }).click();
  await expect(page.locator('.topbar')).toContainText('office');
});

for (const width of [375, 600, 1100, 1440])
  test(`topbars fit long profile names at ${width}px`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { localProfiles } = await mockWorkspace(context);
    localProfiles[0].name = 'a-very-long-profile-name-for-an-ordinary-workspace';
    for (const path of ['/base', '/rules', '/subscriptions']) {
      await page.goto(path);
      await expect(page.locator('.topbar h1')).toBeVisible();
      expect(
        await page.locator('.topbar').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      const rectangles = await page
        .locator('.topbar button, .topbar summary')
        .evaluateAll((nodes) =>
          nodes
            .filter((n) => n.checkVisibility())
            .map((n) => {
              const r = n.getBoundingClientRect();
              return { x: r.x, right: r.right, width: r.width, height: r.height };
            }),
        );
      for (const rect of rectangles) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(rect.width).toBeGreaterThanOrEqual(40);
        expect(rect.height).toBeGreaterThanOrEqual(40);
      }
    }
  });
