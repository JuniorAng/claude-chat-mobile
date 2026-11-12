import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 桌面右栏（≥1280px）：#workspaceModal 不再是底部弹层，而是常驻第三列；上半截是三张信息卡，
// 下半截仍是文件 / 改动两个 tab（同一份 DOM、同一个控制器，不另写一套）。
// 其余 E2E 都跑在 375 宽，这条专门把窗口拉到宽屏，守住停靠布局与卡片数据。
test.describe('桌面右栏', () => {
  test('P0-RAIL-1 宽屏下右栏常驻：聊天列居中、文件列表已加载、信息卡可见', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);

    const rail = page.getByTestId('desktop-rail');
    await expect(rail).toBeVisible();
    await expect(page.getByTestId('rail-session')).toBeVisible();
    await expect(page.getByTestId('rail-workspaces')).toBeVisible();
    await expect(page.getByTestId('rail-tasks')).toBeVisible();

    // 停靠：面板在聊天列右侧，而不是盖在聊天上
    const messages = (await page.locator('#messages').boundingBox())!;
    const panel = (await page.locator('#workspaceModal').boundingBox())!;
    expect(panel.x, '右栏没有停到聊天列右边').toBeGreaterThanOrEqual(messages.x + messages.width - 1);
    expect(panel.width, '右栏宽度没吃掉第三列').toBeGreaterThan(250);

    // 下半截是真实文件列表（不是空壳）：ensure 跟着当前 cwd 自动加载
    await expect(page.locator('#fileBrowseBody')).toContainText('demo.js');

    // 三张卡都有内容或明确的空态，不是空白框
    await expect(page.getByTestId('rail-session-body')).not.toBeEmpty();
    await expect(page.getByTestId('rail-workspaces-body')).not.toBeEmpty();
    await expect(page.getByTestId('rail-tasks-body')).toContainText('没有后台任务');

    await expectNoBrowserErrors(page);
  });

  test('P0-RAIL-2 窄屏不出现右栏，工作区面板仍是底部弹层', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);

    await expect(page.getByTestId('desktop-rail')).toBeHidden();
    // 弹层默认收起：点顶栏 pill 才出来
    await expect(page.locator('#workspaceModal')).toBeHidden();
    await page.locator('#topContextPill').click();
    await expect(page.locator('#workspaceModal')).toBeVisible();
    await expectNoBrowserErrors(page);
  });
});
