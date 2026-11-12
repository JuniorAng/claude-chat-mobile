// tests/unit/frontend-message-actions.test.mjs —— 消息操作栏（复制 / 朗读 / 分叉 / 时间戳）的 DOM 契约。
// 只测我们从 app.js 抽出来的那部分：时间戳挂不挂、文案对不对；不测 Web Speech、剪贴板这些浏览器能力。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageActions } from '../../app/public/js/app/message-actions.js';

// 极简 el：解析出根节点的 tagName 与 class，够本文件断言用。
function fakeEl(html) {
  const tag = /^<([a-z0-9-]+)/i.exec(html)?.[1]?.toUpperCase() || 'DIV';
  const cls = /class="([^"]*)"/.exec(html)?.[1] || '';
  return {
    tagName: tag, className: cls, textContent: '', title: '', children: [],
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    querySelector() { return null; },
  };
}

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime();

function harness() {
  const actions = createMessageActions({
    el: fakeEl,
    copyText: async () => true,
    addBar: () => {},
    haptic: () => {},
    now: () => at(2026, 10, 12, 12, 0),
  });
  return { actions };
}

test('appendCopyAction：给了 ts 就在栏尾挂紧凑时间戳，title 是完整日期', () => {
  const { actions } = harness();
  const container = fakeEl('<div class="bubble"></div>');
  actions.appendCopyAction(container, () => 'text', 'left', null, at(2026, 10, 12, 9, 5));
  const bar = container.children.at(-1);
  const stamp = bar.children.find(c => c.className.includes('msg-action-ts'));
  assert.ok(stamp, '有 ts 时没有挂时间戳');
  assert.equal(stamp.textContent, '11-12 09:05');
  assert.equal(stamp.title, '今天 09:05', 'title 走与时间分隔行同一套日历日文案');
});

test('appendCopyAction：没有 ts（或 ts 非法）就不挂时间戳', () => {
  for (const bad of [undefined, null, 0, 'not-a-date']) {
    const { actions } = harness();
    const container = fakeEl('<div class="bubble"></div>');
    actions.appendCopyAction(container, () => 'text', 'left', null, bad);
    assert.equal(container.children.at(-1).children.some(c => c.className.includes('msg-action-ts')), false,
      `ts=${String(bad)} 不该挂时间戳`);
  }
});

test('appendCopyAction：用户气泡（右对齐）同样挂时间戳，原有复制/回填两个按钮都在', () => {
  const { actions } = harness();
  const container = fakeEl('<div class="bubble"></div>');
  actions.appendCopyAction(container, () => 'text', 'right', null, at(2026, 10, 12, 9, 5));
  const bar = container.children.at(-1);
  assert.equal(bar.children.length, 3, '复制 + 填入输入框 + 时间戳');
  assert.equal(bar.children.filter(c => c.className.includes('msg-action-btn')).length, 2);
  assert.ok(bar.children.at(-1).className.includes('msg-action-ts'));
});
