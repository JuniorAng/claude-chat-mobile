// tests/unit/logic-process-group.test.mjs —— 过程痕迹分组：分类器 + 组头文案。
// 纯函数：输入是描述对象（不是 DOM 节点），这样它能留在 logic/ 并被 node:test 直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProcessNode, isTransparentNode, summarizeProcessGroup } from '../../app/public/js/logic.js';
import { setLang } from '../../app/public/js/i18n.js';

test('classifyProcessNode：思考/工具/子 agent 收进组，正文与图表断开', () => {
  assert.equal(classifyProcessNode({ kind: 'thinking' }), 'thinking');
  assert.equal(classifyProcessNode({ kind: 'tool_use' }), 'tool');
  assert.equal(classifyProcessNode({ kind: 'tool_result' }), null, '结果跟着卡走，不是独立过程项');
  assert.equal(classifyProcessNode({ kind: 'subagent-card' }), 'agent');
  assert.equal(classifyProcessNode({ kind: 'assistant-text' }), null);
  assert.equal(classifyProcessNode({ kind: 'widget' }), null);
  assert.equal(classifyProcessNode({}), null);
  assert.equal(classifyProcessNode(null), null);
});

test('summarizeProcessGroup：思考 + 两个工具名 + 时长', () => {
  setLang('zh');
  const s = summarizeProcessGroup(
    [{ type: 'thinking' }, { type: 'tool', name: 'Bash' }, { type: 'tool', name: 'Read' }, { type: 'tool', name: 'Bash' }],
    { durationMs: 14000 },
  );
  assert.equal(s.text, '思考 1 · Bash 2 · Read 1 · 14s');
  assert.deepEqual(s.toolNames, [{ name: 'Bash', count: 2 }, { name: 'Read', count: 1 }]);
});

test('summarizeProcessGroup：只有一个工具时不带计数', () => {
  const s = summarizeProcessGroup([{ type: 'tool', name: 'Read' }]);
  assert.equal(s.text, 'Read');
});

test('summarizeProcessGroup：子 agent 单独出现时带 🤖 标记', () => {
  setLang('zh');
  const s = summarizeProcessGroup([{ type: 'agent' }, { type: 'tool', name: 'Bash' }], { durationMs: 9000 });
  assert.equal(s.text, '🤖 agent 1 · Bash 1 · 9s');
});

test('summarizeProcessGroup：超过两种工具用 … 收尾', () => {
  const s = summarizeProcessGroup(
    [{ type: 'tool', name: 'Bash' }, { type: 'tool', name: 'Read' }, { type: 'tool', name: 'Edit' }],
  );
  assert.equal(s.text, 'Bash 1 · Edit 1 · …');
});

test('summarizeProcessGroup：没有工具时只报思考数与时长', () => {
  setLang('zh');
  const s = summarizeProcessGroup([{ type: 'thinking' }, { type: 'thinking' }], { durationMs: 65000 });
  assert.equal(s.text, '思考 2 · 1m 5s');
});

test('summarizeProcessGroup：工具没有名字时退回「工具」占位，不出现 undefined', () => {
  setLang('zh');
  const s = summarizeProcessGroup([{ type: 'tool' }, { type: 'tool' }]);
  assert.match(s.text, /工具 2/);
  assert.equal(/undefined/.test(s.text), false);
});

test('summarizeProcessGroup：英文界面走词典（不残留中文）', () => {
  setLang('en');
  try {
    // i18n.js 的 t() 在 en 下查 EN_DICT；缺条目会静默回落中文，所以这条同时守着词典条目真的在。
    assert.match(summarizeProcessGroup([{ type: 'thinking' }], { durationMs: 14000 }).text, /^[A-Za-z]+ 1 · 14s$/);
  } finally { setLang('zh'); }
});

test('isTransparentNode：图表既不是过程项也不断组（它跟着自己的工具卡走）', () => {
  assert.equal(isTransparentNode({ kind: 'widget' }), true);
  assert.equal(isTransparentNode({ kind: 'tool_use' }), false);
  assert.equal(isTransparentNode(null), false);
});
