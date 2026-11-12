// tests/e2e/specs/process-group.spec.ts —— 过程痕迹分组的端到端外观。
// 盯三件用户直接看到的事：连续的思考/工具卡真的被收进一个组、正文永远在组外、回合结束后组自动收起。
import { test, expect } from '@playwright/test';
import { captureBrowserErrors, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('过程痕迹分组', () => {
  test('连续工具卡收进一个组，正文在组外，回合结束后自动收起', async ({ page }) => {
    captureBrowserErrors(page);
    await gotoMock(page);
    await sendChatMessage(page, 'test:tool');
    await waitForIdle(page);

    // test:tool 的序列是 思考→read→正文→edit→run（正文是断点），所以按规划会得到两个组。
    const groups = page.locator('[data-testid="process-group"]');
    await expect(groups.first()).toBeVisible({ timeout: 15_000 });
    await expect(groups.first().locator('.pg-summary')).toContainText(/read_file|Read/, { timeout: 5_000 });
    // 「正文是断点」这件事本身就是断言：组数 > 1 说明正文没被卷进组
    await expect(groups).toHaveCount(2);

    // 正文气泡必须仍是 #messages 的直接子元素（没被卷进组）
    const assistant = page.locator('[data-testid="assistant-message"]').last();
    await expect(assistant).toBeVisible();
    const direct = await assistant.evaluate(n => n.parentElement?.id === 'messages');
    expect(direct, '正文气泡被收进了过程组').toBe(true);

    // 组内条目去掉各自的左边线，只留组的一条竖线
    const inner = groups.first().locator('.pg-body > details').first();
    const border = await inner.evaluate(n => getComputedStyle(n).borderLeftWidth);
    expect(border, '组内条目还留着第二条竖线').toBe('0px');

    // 回合结束后自动收起（每个组都不带 open）
    await expect(groups.first()).not.toHaveAttribute('open', '');
    await expect(groups.last()).not.toHaveAttribute('open', '');
    await expectNoBrowserErrors(page);
  });
});
