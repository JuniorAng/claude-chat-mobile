import { test, expect } from '@playwright/test';
import { gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionMenu, openSessionsSidebar, sessionMenuItem, workspaceSubtree } from '../../helpers/sidebar-ui';

// 2026-11-06：程序自动提交的会话（插件 / 子 agent 经 SDK 发起）不再和主会话平铺在一层。
// 判据在服务端 history.js（首条主链 user 消息 turnOrigin==='sdk'），抽屉只负责分组展示：
// 默认收起、组头带条数，展开后仍是普通会话行（点开 / 删除 / 重命名照旧）。
test.describe('自动会话分组', () => {
  test.beforeEach(async ({ page }) => {
    await gotoMock(page);
  });

  test('automated 行收进「自动会话」组；默认收起，点开后行才出现', async ({ page }) => {
    await sendChatMessage(page, 'test:automated-sessions');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    const section = workspaceSubtree(page, MAIN_WORKSPACE);
    const head = section.locator('[data-testid="session-automated-head"]');
    await expect(head).toHaveCount(1);
    await expect(head).toContainText('自动会话');
    await expect(head, '组头要报出条数，否则用户不知道里面有几个').toContainText('1');

    const row = section.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(row, '默认收起时自动会话不应混在主列表里').toHaveCount(0);

    await head.click();
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-automated', '1');
    await expect(row).toContainText('Archived Planning Session');

    // 自动会话不参与未读：「标为未读」会在一个永远不显示的 chip 上打转，菜单里不该有这个入口。
    await openSessionMenu(page, row);
    await expect(sessionMenuItem(page, 'toggle-read')).toHaveCount(0);
    await expect(sessionMenuItem(page, 'rename')).toBeEnabled();
    await page.keyboard.press('Escape');

    // 搜索态不分组：带着明确关键词来找，匹配行必须直接出现，不能被收进折叠组。
    await section.locator('[data-testid="session-search"]').fill('Archived Planning');
    await expect(row).toHaveCount(1);
    await expect(head).toHaveCount(0);
  });
});
