// tests/unit/frontend-process-group.test.mjs —— 分组工厂的 DOM 契约。
// 只测「什么时候包组、包进什么、什么时候收起」；组头文案本身由 logic-process-group.test.mjs 钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProcessGroups } from '../../app/public/js/app/process-group.js';

// 极简 HTML → 假 DOM：只处理本文件用到的标签（details/summary/div/span），按顺序建树。
function fakeEl(html = '') {
  const attrsOf = raw => {
    const attrs = new Map();
    for (const m of raw.matchAll(/([a-z-]+)="([^"]*)"/g)) attrs.set(m[1], m[2]);
    return attrs;
  };
  const make = (tagName, rawAttrs) => {
    const attrs = attrsOf(rawAttrs);
    const el = {
      tagName: tagName.toUpperCase(),
      className: attrs.get('class') || '',
      textContent: '',
      title: '',
      open: false,
      children: [],
      dataset: {},
      _listeners: [],
      appendChild(child) { el.children.push(child); return child; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      classList: { add: c => { const parts = el.className.split(/\s+/).filter(Boolean); if (!parts.includes(c)) el.className = [...parts, c].join(' '); } },
      addEventListener(_type, fn) { el._listeners.push(fn); },
      querySelector(sel) {
        const want = sel.replace(/^\s+/, '').split(/\s+/).pop().replace(/^\./, '').replace(/:\w+/g, '');
        const walk = n => {
          for (const c of n.children) {
            if (c.className.split(/\s+/).includes(want) || c.tagName.toLowerCase() === want) return c;
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(el);
      },
      querySelectorAll() { return []; },
    };
    return el;
  };
  const root = make('div', '');
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)([^>]*)>/gi)) {
    const [, close, name, rest] = m;
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    if (/^(br|img|meta|link|input)$/i.test(name) || rest.trim().endsWith('/')) continue;
    const node = make(name, rest);
    stack.at(-1).appendChild(node);
    if (!/^(br|img|meta|link|input)$/i.test(name)) stack.push(node);
  }
  // 根节点本身代表传入的那一个标签
  const first = root.children[0];
  return first || root;
}

const node = (cls) => fakeEl(`<details class="${cls}"></details>`);

test('连续两个过程项包进一个组；正文把它断开', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Bash' });
  groups.append(host, node('thinking'), { kind: 'thinking' });
  assert.equal(host.children.filter(c => c.className.includes('process-group')).length, 1, '两个过程项没有包成组');
  const group = host.children.find(c => c.className.includes('process-group'));
  assert.equal(group.children.length >= 1, true);
  assert.equal(group.querySelector('.pg-body').children.length, 2, '组内应有两条');

  groups.append(host, fakeEl('<div data-testid="assistant-message"></div>'), { kind: 'assistant-text' });
  assert.equal(host.children.at(-1).getAttribute('data-testid'), 'assistant-message', '正文必须仍是直接子元素');
});

test('单个过程项不包组（保持现状，不多一次点击）', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Read' });
  groups.endRun();
  assert.equal(host.children.filter(c => c.className.includes('process-group')).length, 0);
  assert.equal(host.children.length, 1);
});

test('回合结束收起；用户手动开合过就不强制收起', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Bash' });
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Read' });
  const group = host.children.find(c => c.className.includes('process-group'));
  assert.equal(group.open, true, 'live 期间默认展开');

  groups.endRun();
  assert.equal(group.open, false, '回合结束没有收起');

  // 用户手动点过的那一组：再跑一轮也不强制收起
  const host2 = fakeEl('<main></main>');
  const g2 = createProcessGroups({ el: fakeEl, now: () => 1000 });
  g2.append(host2, node('toolcard'), { kind: 'tool_use', name: 'Bash' });
  g2.append(host2, node('toolcard'), { kind: 'tool_use', name: 'Read' });
  const group2 = host2.children.find(c => c.className.includes('process-group'));
  group2.dataset.userToggle = '1'; // 模拟用户点了组头
  g2.endRun();
  assert.equal(group2.open, true, '用户手动展开过，不该被强制收起');
});

test('新的一轮从新组开始：reset 后上一轮的组不会再被续写', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Bash' });
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Read' });
  const firstGroup = host.children.find(c => c.className.includes('process-group'));
  groups.reset();
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Edit' });
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Grep' });
  assert.equal(firstGroup.querySelector('.pg-body').children.length, 2, '上一轮的组被续写了');
  assert.equal(host.children.filter(c => c.className.includes('process-group')).length, 2, '新一轮没有建新组');
});

test('组头文案随时间刷新（live 秒表），端到端接的是 summarizeProcessGroup', () => {
  let clock = 1000;
  const groups = createProcessGroups({ el: fakeEl, now: () => clock });
  const host = fakeEl('<main></main>');
  groups.append(host, node('thinking'), { kind: 'thinking' });
  clock = 5000;
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Bash' });
  const group = host.children.find(c => c.className.includes('process-group'));
  const head = group.querySelector('.pg-summary').textContent;
  assert.match(head, /思考 1/);
  assert.match(head, /4s/);
});

test('正文断开之后，前一组仍归本回合管：endRun 照样收起它', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  groups.append(host, node('thinking'), { kind: 'thinking' });
  groups.append(host, node('toolcard'), { kind: 'tool_use', name: 'Read' });
  groups.append(host, fakeEl('<div data-testid="assistant-message"></div>'));
  const group = host.children.find(c => c.className.includes('process-group'));
  assert.equal(group.open, true);
  groups.endRun();
  assert.equal(group.open, false, '正文断开后的组没有被回合结束收起——用户会一直看着一堆展开的过程');
});

test('图表跟在工具卡后面：不拆组，也不把卡和图标拆到两处', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  const card = fakeEl('<details class="toolcard"></details>');
  const widget = fakeEl('<figure class="widget-card"></figure>');
  groups.append(host, card, { kind: 'tool_use', name: 'mcp__visualize__show_widget' });
  groups.append(host, widget, { kind: 'widget' });
  // 单条过程项时组还没建：图仍紧跟卡
  assert.equal(host.children.at(-1), widget);
  assert.equal(host.children.at(-2), card);
});

test('组已开时，图表进组并紧跟自己的卡（而不是插到组外）', () => {
  const groups = createProcessGroups({ el: fakeEl, now: () => 1000 });
  const host = fakeEl('<main></main>');
  const c1 = fakeEl('<details class="toolcard"></details>');
  const c2 = fakeEl('<details class="toolcard"></details>');
  const widget = fakeEl('<figure class="widget-card"></figure>');
  groups.append(host, c1, { kind: 'tool_use', name: 'Bash' });
  groups.append(host, c2, { kind: 'tool_use', name: 'mcp__visualize__show_widget' });
  groups.append(host, widget, { kind: 'widget' });
  const group = host.children.find(c => c.className.includes('process-group'));
  const body = group.querySelector('.pg-body');
  assert.equal(body.children.at(-1), widget, '图没有紧跟它自己的卡（卡与图被拆开了）');
  assert.equal(body.children.at(-2), c2);
});
