import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, openSessionsSidebar, workspaceRow } from '../../helpers/sidebar-ui';

// 抽屉项目分组（2026-11-12）：「今天 + 昨天」活跃的文件夹放「最近活跃」，其余放「更早」；
// 「更早」默认收起，点组头展开。活动时间由服务端给（transcript mtime），前端只划日界。
const DAY = 86_400_000;

test.describe('抽屉项目分组', () => {
  test('P0-GROUP-1 最近活跃 / 更早两组；更早默认收起，组头可展开', async ({ page }) => {
    await gotoMock(page);
    await page.request.post(`/__set-connected-folders?dirs=${encodeURIComponent(`${MAIN_WORKSPACE},${ANOTHER_WORKSPACE}`)}`);
    await page.request.post(`/__set-project-activity?activity=${encodeURIComponent(JSON.stringify({
      [MAIN_WORKSPACE]: Date.now(),
      [ANOTHER_WORKSPACE]: Date.now() - 5 * DAY,
    }))}`);
    await openSessionsSidebar(page);

    const groups = page.locator('[data-testid="dir-group"]');
    await expect(groups).toHaveCount(2);
    const recent = page.locator('[data-testid="dir-group"][data-group="recent"]');
    const earlier = page.locator('[data-testid="dir-group"][data-group="earlier"]');
    await expect(recent).toContainText('最近活跃');
    await expect(earlier).toContainText('更早');
    await expect(recent).toHaveAttribute('open', '');
    await expect(earlier).not.toHaveAttribute('open', '');

    // 主工作区在最近组、可点；另一个在收起着的更早组里，先看不见
    await expect(workspaceRow(page, MAIN_WORKSPACE)).toBeVisible();
    const earlierRow = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(earlierRow).toBeHidden();

    await earlier.locator('summary').click();
    await expect(earlier).toHaveAttribute('open', '');
    await expect(earlierRow).toBeVisible();
    await expectNoBrowserErrors(page);
  });

  test('P0-GROUP-2 当前工作区即使活动时间早也留在最近组（不会被默认收起）', async ({ page }) => {
    await gotoMock(page);
    await page.request.post(`/__set-connected-folders?dirs=${encodeURIComponent(`${MAIN_WORKSPACE},${ANOTHER_WORKSPACE}`)}`);
    // 当前查看的是 MAIN（__set-connected-folders 把视图拨到 scratch，但实例仍在 MAIN）；
    // 把 MAIN 的活动时间拨到很早，它仍应因「当前 cwd / 活实例」被 forceRecent 拉回最近组。
    await page.request.post(`/__set-project-activity?activity=${encodeURIComponent(JSON.stringify({
      [MAIN_WORKSPACE]: Date.now() - 30 * DAY,
      [ANOTHER_WORKSPACE]: Date.now() - 20 * DAY,
    }))}`);
    await openSessionsSidebar(page);

    const recent = page.locator('[data-testid="dir-group"][data-group="recent"]');
    await expect(recent).toContainText('最近活跃');
    await expect(workspaceRow(page, MAIN_WORKSPACE)).toBeVisible();
    await expectNoBrowserErrors(page);
  });

  test('P0-GROUP-3 没有活动时间时退回平铺：不凭空多出两个组头', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expect(page.locator('[data-testid="dir-group"]')).toHaveCount(0);
    await expect(workspaceRow(page, MAIN_WORKSPACE)).toBeVisible();
    await expectNoBrowserErrors(page);
  });
});
