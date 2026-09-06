import { test, expect } from '@playwright/test';
import { mockWorkspace, openBase, profiles, initialBase } from './fixtures';

for (const viewport of [{ width: 1366, height: 768 }, { width: 844, height: 390 }]) {
  test(`17 profiles keep the last template and creation reachable at ${viewport.width}px`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { localProfiles, bases } = await mockWorkspace(context);
    for (let i = 3; i <= 17; i++) {
      const profile = {
        ...profiles[0],
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        name: `${i >= 16 ? 'template' : 'profile'}-${i}`,
        kind: i >= 16 ? 'template' : 'normal',
      };
      localProfiles.push(profile);
      bases[profile.id] = initialBase;
    }
    const openSwitcher = async () => {
      if (viewport.width <= 1100)
        await page.getByRole('button', { name: '打开导航' }).click();
      await page.locator('.profile-switch').click();
    };
    await openBase(page);
    await openSwitcher();
    const menu = page.locator('.profile-pop');
    const create = menu.getByRole('link', { name: '新建配置文件' });
    const manage = menu.getByRole('link', { name: '管理全部配置文件' });
    await expect(menu.locator('.pp-pick')).toHaveCount(17);
    await expect(create).toBeInViewport({ ratio: 1 });
    await expect(manage).toBeInViewport({ ratio: 1 });
    await menu.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );

    // Resizing an already-open menu must keep its footer on screen.
    await page.setViewportSize({ width: viewport.width, height: 360 });
    await expect(manage).toBeInViewport({ ratio: 1 });
    const footerY = (await create.boundingBox())!.y;
    const last = menu.locator('.pp-pick').filter({ hasText: 'template-17' });
    await menu.locator('.pp-pick').first().hover();
    await page.mouse.wheel(0, 1500);
    await expect(last).toBeInViewport({ ratio: 1 });
    expect((await create.boundingBox())!.y).toBeCloseTo(footerY, 0);
    // Tabbing reaches off-screen profiles without moving the footer or page.
    await page.locator('.profile-switch').focus();
    for (let i = 0; i < 33; i++) await page.keyboard.press('Tab');
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 1 });
    expect((await create.boundingBox())!.y).toBeCloseTo(footerY, 0);
    await last.click();
    await expect(page.locator('.profile-switch .pf-name')).toHaveText('template-17');

    await openSwitcher();
    await create.click();
    await expect(page).toHaveURL(/\/profiles$/);
    await page.locator('.topbar').getByRole('button', { name: '＋ 新建配置文件', exact: true }).click();
    await expect(page.getByPlaceholder('例如：home-main')).toBeVisible();
  });
}
