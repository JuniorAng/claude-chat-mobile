// host-platform.js：宿主平台差异的单一开关——绝对路径判据与可浏览的文件系统根。
// 两侧（写侧 env-schema、读侧 workdirs、文件夹选择器）都吃这一份，所以这里按注入平台把
// Linux 与 Windows 两支都跑一遍；只在各自宿主上测等于永远漏掉另一半。
import test from 'node:test';
import assert from 'node:assert/strict';

import { browseRoots, isHostAbsolute, isWindowsHost } from '../../app/src/shared/host-platform.js';

test('isWindowsHost：只有 win32 算 Windows', () => {
  assert.equal(isWindowsHost('win32'), true);
  for (const p of ['linux', 'darwin', 'freebsd', '']) assert.equal(isWindowsHost(p), false, p);
});

test('isHostAbsolute：POSIX 宿主只认 /…，Windows 形态一律不算', () => {
  for (const p of ['/home/u/proj', '/', '//server/share']) assert.equal(isHostAbsolute(p, 'linux'), true, p);
  for (const p of ['C:\\Users\\u', 'C:/Users/u', '\\\\server\\share', 'C:', 'relative/path', '~']) {
    assert.equal(isHostAbsolute(p, 'linux'), false, p);
  }
});

test('isHostAbsolute：Windows 宿主认盘符绝对路径与 UNC，不认盘符相对', () => {
  for (const p of ['C:\\Users\\u', 'C:/Users/u', '\\\\server\\share', '/x']) assert.equal(isHostAbsolute(p, 'win32'), true, p);
  for (const p of ['C:', 'relative\\path', '']) assert.equal(isHostAbsolute(p, 'win32'), false, p);
});

test('browseRoots：POSIX 只有 /，且不探测盘符', () => {
  assert.deepEqual(browseRoots({ platform: 'linux', exists: () => { throw new Error('POSIX 不该探测盘符'); } }),
    [{ name: '/', path: '/' }]);
  assert.deepEqual(browseRoots({ platform: 'darwin', exists: () => { throw new Error('POSIX 不该探测盘符'); } }),
    [{ name: '/', path: '/' }]);
});

test('browseRoots：Windows 只列真实存在的盘符，跳过 A:/B:', () => {
  const seen = [];
  const roots = browseRoots({
    platform: 'win32',
    exists: (p) => { seen.push(p); return p === 'A:\\' || p === 'C:\\' || p === 'D:\\'; },
  });
  assert.deepEqual(roots, [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }]);
  assert.ok(!seen.includes('A:\\') || !roots.some(r => r.name === 'A:'), 'A: 即使存在也不列');
});
