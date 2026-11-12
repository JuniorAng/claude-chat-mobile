// tests/unit/logic-file-sort.test.mjs —— 文件列表排序的纯函数。
// 判据：name 模式保持服务端顺序（分页游标语义）；其余模式目录永远在前、同键按名字稳定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortBrowseEntries } from '../../app/public/js/logic.js';

const E = (name, kind, size, mtime) => ({ name, kind, size, mtime });
const names = out => out.map(e => e.name);

test('name 模式：原样返回服务端顺序（dir 参数不生效）', () => {
  const input = [E('b', 'file', 9, 100), E('a', 'dir', 0, 300), E('c', 'file', 1, 200)];
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'name', dir: 'desc' })), ['b', 'a', 'c']);
});

test('mtime 模式：目录永远最前，组内按时间，同时间按名字', () => {
  const input = [E('b', 'file', 9, 100), E('a', 'dir', 0, 50), E('c', 'file', 1, 300), E('d', 'file', 2, 300)];
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'mtime', dir: 'desc' })), ['a', 'c', 'd', 'b']);
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'mtime', dir: 'asc' })), ['a', 'b', 'c', 'd']);
});

test('size 模式：目录统一最前，文件按大小', () => {
  const input = [E('big', 'file', 900, 1), E('dir', 'dir', 0, 2), E('small', 'file', 1, 3)];
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'size', dir: 'desc' })), ['dir', 'big', 'small']);
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'size', dir: 'asc' })), ['dir', 'small', 'big']);
});

test('mtime 缺失：回落到名字，不产生 NaN、不丢条目', () => {
  const input = [E('a', 'file', 1, undefined), E('b', 'file', 1, 100)];
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'mtime', dir: 'desc' })), ['b', 'a']);
});

test('未知 key / dir：按 name 模式处理，不抛', () => {
  const input = [E('b', 'file', 1, 1), E('a', 'file', 1, 1)];
  assert.deepEqual(names(sortBrowseEntries(input, { key: 'nope', dir: 'sideways' })), ['b', 'a']);
});

test('不修改入参数组', () => {
  const input = [E('b', 'file', 1, 1), E('a', 'file', 2, 2)];
  const before = input.map(e => e.name);
  sortBrowseEntries(input, { key: 'size', dir: 'desc' });
  assert.deepEqual(input.map(e => e.name), before);
});
