// tests/invariants/folder-picker.test.mjs —— 手机上添加 / 新建文件夹的后端判据
// 守护：FOLDER-01（浏览只回目录名；可以浏览整台电脑，家目录之外用绝对路径；家目录 / 磁盘根 / 禁区 /
//        仓库里的托管 worktree 不能添加；新建只收单段名字、非递归、建完 realpath 复核）
// 测什么：sessions/folders.js 在一次性「家目录」上的真 fs 行为——普通文件、FIFO、symlink、点目录、真 git worktree。
// 不测什么 + 为什么：① 把目录写进配置、热加载生效在 server 层（tests/invariants/server/folders.test.mjs）
//   ② 已连接之后的授权判据（子目录可达、禁区）在 folder-access.test.mjs（SCOPE-05）
// 槽位：S1（一次性目录上的真 fs）

import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  browseFolderNames, browseRoots, connectRefusalReason, validateFolderName, createSubfolder, resolveFolderToAdd, MAX_BROWSE_ENTRIES,
} from '../../app/src/sessions/folders.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); }); // safe-rm: mkdtemp 一次性目录

// 一次性「家目录」：home/{code/{app,.hidden-dir},notes.txt,fifo,link-out → 家目录外,.claude/x}，外加家目录之外的 outside/
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-folder-picker-')));
  ROOTS.push(base);
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  mkdirSync(join(home, 'code', 'app'), { recursive: true });
  mkdirSync(join(home, 'code', '.hidden-dir'));
  mkdirSync(join(home, '.claude', 'x'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(home, 'code', 'notes.txt'), 'x');
  execFileSync('mkfifo', [join(home, 'code', 'fifo')]);
  symlinkSync(outside, join(home, 'code', 'link-out'));
  const forbidden = [join(home, '.claude')];
  return { base, home, outside, forbidden, ctx: { home, forbidden, connected: [] } };
}

// 文件系统分不分大小写（macOS 缺省的 APFS 不分：~/.CLAUDE 就是 ~/.claude）。分大小写的系统上（Linux CI）
// 构造不出「换个大小写的同一个目录」，那几条跳过。
function caseInsensitiveFs() {
  const d = mkdtempSync(join(tmpdir(), 'ccm-case-'));
  try { return existsSync(join(dirname(d), basename(d).toUpperCase())); } finally { rmSync(d, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
}

test('禁区换个大小写照样拒（不分大小写的文件系统）', { skip: !caseInsensitiveFs() }, () => {
  const { home, ctx } = fixture();
  assert.equal(connectRefusalReason(join(home, '.CLAUDE'), ctx), 'forbidden', '换个大小写就能把 ~/.claude 连进来');
  assert.equal(connectRefusalReason(join(home, '.Claude', 'x'), ctx), 'forbidden');
});

test('浏览只回真实目录的名字：文件、FIFO、symlink、点目录都不出现；回执与子目录都带绝对路径', () => {
  const { home, ctx } = fixture();
  const res = browseFolderNames('code', ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.entries.map(e => e.name), ['app'],
    '回文件名 = 把目录浏览变成文件浏览；跟 symlink = 一跳出家目录；点目录多是工具的内部状态');
  assert.equal(res.path, join(home, 'code'), '位置是绝对路径：家目录外的目录用相对路径表达不了');
  assert.equal(res.parent, home);
  assert.equal(res.home, ctx.home, '客户端要靠它把家目录内的位置显示成 ~/…');
  assert.ok(Array.isArray(res.roots) && res.roots.length > 0, '没有盘符列表，客户端就没法从家目录跳到 D:');
  for (const e of res.entries) assert.deepEqual(Object.keys(e).sort(), ['name', 'path', 'reason']);
  assert.equal(res.entries[0].path, join(home, 'code', 'app'), '客户端直接拿它当子目录的位置，不该自己拼路径');
});

test('浏览：相对路径仍以家目录为界：../、经 symlink 出界，一律拒绝', () => {
  const { ctx } = fixture();
  for (const p of ['..', '../outside', 'code/../../outside', 'code/link-out']) {
    const res = browseFolderNames(p, ctx);
    assert.equal(res.ok, false, `${p} 被放行了：${JSON.stringify(res)}`);
    assert.equal(res.entries, undefined, `${p}：拒绝时不得带任何目录名`);
  }
  assert.equal(browseFolderNames('', ctx).ok, true, '空路径 = 家目录本身，可浏览');
  for (const bad of [42, {}, ['code']]) {
    assert.equal(browseFolderNames(bad, ctx).ok, false, `${JSON.stringify(bad)}：载荷来自客户端，非字符串要拒绝而不是抛错`);
  }
});

test('浏览：绝对路径可以出家目录——Windows 上从盘符进 D: 就靠这一条', () => {
  const { home, outside, ctx } = fixture();
  mkdirSync(join(outside, 'proj'), { recursive: true });
  const res = browseFolderNames(outside, ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, outside);
  assert.equal(res.parent, dirname(outside));
  assert.equal(res.home, home);
  assert.deepEqual(res.entries.map(e => e.name), ['proj']);
  assert.equal(res.entries[0].path, join(outside, 'proj'));
  // 磁盘根本身也能浏览（客户端据此列盘符下的目录），只是不能添加
  const atRoot = browseFolderNames(parse(home).root, ctx);
  assert.equal(atRoot.ok, true, JSON.stringify(atRoot));
  assert.equal(atRoot.parent, null, '磁盘根没有上一级，客户端据此显示「此电脑」');
  // 禁区的绝对路径照样拒
  mkdirSync(join(outside, '.claude'), { recursive: true });
  assert.equal(browseFolderNames(join(outside, '.claude'), { ...ctx, forbidden: [join(outside, '.claude')] }).ok, false);
});

test('可浏览的文件系统根：至少一个，且都是绝对路径', () => {
  const roots = browseRoots();
  assert.ok(roots.length > 0);
  for (const r of roots) {
    assert.equal(typeof r.name, 'string');
    assert.ok(isAbsolute(r.path), `${r.path} 不是绝对路径`);
  }
});

// CI 跑在 Linux 上，Windows 那一支只能靠注入平台来验——而 D: 正是这条改动的起因。
test('可浏览的文件系统根：Windows 只列真实存在的盘符', () => {
  const roots = browseRoots({ platform: 'win32', exists: p => p === 'C:\\' || p === 'D:\\' });
  assert.deepEqual(roots, [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }]);
  assert.deepEqual(browseRoots({ platform: 'linux', exists: () => { throw new Error('非 Windows 不该探测盘符'); } }),
    [{ name: '/', path: '/' }]);
});

test('浏览有上限：超出时截断并如实标出', () => {
  const { home, ctx } = fixture();
  const many = join(home, 'many');
  for (let i = 0; i <= MAX_BROWSE_ENTRIES; i += 1) mkdirSync(join(many, `d${String(i).padStart(4, '0')}`), { recursive: true });
  const res = browseFolderNames('many', ctx);
  assert.equal(res.entries.length, MAX_BROWSE_ENTRIES);
  assert.equal(res.truncated, true);
});

test('每个条目带「能不能添加」：禁区置灰，当前目录自身也给判据', () => {
  const { ctx } = fixture();
  const root = browseFolderNames('', ctx);
  assert.equal(root.reason, 'home', '家目录本身不能添加（官方同）');
  // .claude 是点目录，不出现；它的判据由 connectRefusalReason 直接覆盖（下一条）
  assert.equal(root.entries.find(e => e.name === 'code')?.reason, null);
});

test('不能添加的：家目录、磁盘根、禁区内、不存在、文件；家目录之外的普通目录现在能加', () => {
  const { home, outside, ctx } = fixture();
  assert.equal(connectRefusalReason(home, ctx), 'home');
  assert.equal(connectRefusalReason(parse(home).root, ctx), 'root');
  assert.equal(connectRefusalReason(outside, ctx), null, '家目录之外的普通目录现在能加（盘符浏览）');
  assert.equal(connectRefusalReason(join(home, '.claude'), ctx), 'forbidden');
  assert.equal(connectRefusalReason(join(home, '.claude', 'x'), ctx), 'forbidden');
  assert.equal(connectRefusalReason(join(home, 'nope'), ctx), 'not_found');
  assert.equal(connectRefusalReason(join(home, 'code', 'notes.txt'), ctx), 'not_directory');
  assert.equal(connectRefusalReason(join(home, 'code', 'link-out'), ctx), null,
    '经 symlink 指到家目录外：按真实路径判，现在也是可加的普通目录');
  // 过宽根与配置写入侧共用一份判据：面板上不该出现「能加」，点了保存才报「太宽」。
  const broad = process.platform === 'win32'
    ? 'C:\\Users'
    : (existsSync('/Users') ? '/Users' : (existsSync('/home') ? '/home' : null));
  if (broad) assert.equal(connectRefusalReason(broad, ctx), 'too_broad', broad);
  assert.equal(connectRefusalReason(dirname(home), ctx), 'too_broad', '家目录的祖先同样过宽');
  // 正对照
  assert.equal(connectRefusalReason(join(home, 'code'), ctx), null);
});

test('已连接的不重复加；已连接文件夹的子目录可以单独加（官方同）', () => {
  const { home, ctx } = fixture();
  const code = join(home, 'code');
  const withCode = { ...ctx, connected: [code] };
  assert.equal(connectRefusalReason(code, withCode), 'already_connected');
  assert.equal(connectRefusalReason(join(code, 'app'), withCode), null);
});

// 「在这里开始会话」也用在已经连着的文件夹上（2026-10-15）：已经是连接根时照常交出真实路径并标明，
// 由上层直接开会话、不再写一遍配置。判据层的「已连接」（浏览时标出来）与「子目录能单独加」都不变。
test('要添加的位置已经是连接根：交出真实路径并标明已连接，不当成拒绝；子目录照旧单独加', () => {
  const { home, ctx } = fixture();
  const code = join(home, 'code');
  const withCode = { ...ctx, connected: [code] };
  assert.deepEqual(resolveFolderToAdd('code', withCode), { ok: true, path: code, connected: true });
  assert.deepEqual(resolveFolderToAdd('code/app', withCode), { ok: true, path: join(code, 'app') });
});

test('要添加的位置：家目录相对路径与绝对路径都认；能加时给真实路径，不能加时给原因', () => {
  const { home, outside, ctx } = fixture();
  assert.deepEqual(resolveFolderToAdd('code/app', ctx), { ok: true, path: join(home, 'code', 'app') });
  assert.deepEqual(resolveFolderToAdd(outside, ctx), { ok: true, path: outside }, '绝对路径可以在家目录之外');
  assert.deepEqual(resolveFolderToAdd('', ctx), { ok: false, error: 'home' });
  assert.deepEqual(resolveFolderToAdd('..', ctx), { ok: false, error: 'outside_home' });
  assert.deepEqual(resolveFolderToAdd('code/link-out', ctx), { ok: false, error: 'outside_home' },
    '相对路径经 symlink 出界仍拒：出家目录的唯一正路是绝对路径');
  assert.deepEqual(resolveFolderToAdd(join(outside, 'nope'), ctx), { ok: false, error: 'not_found' });
  assert.deepEqual(resolveFolderToAdd(42, ctx), { ok: false, error: 'not_found' });
});

// 照官方桌面端：只有它自己建的 worktree 不能单独加（"Worktrees that Claude Code created can't be added on
// their own"）；用户自建的平级 worktree 是普通文件夹——范围外的 worktree 不随仓库授权，不让加就再也用不上。
test('仓库里的托管 worktree（及其子目录）不能单独加；自己建的平级 worktree 能加', () => {
  const { home, ctx } = fixture();
  const repo = join(home, 'code', 'app');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init');
  const managed = join(repo, '.claude', 'worktrees', 'x');
  git('worktree', 'add', '-b', 'managed', managed);
  mkdirSync(join(managed, 'sub'));
  assert.equal(connectRefusalReason(managed, ctx), 'worktree');
  assert.equal(connectRefusalReason(join(managed, 'sub'), ctx), 'worktree');
  const wt = join(home, 'code', 'app-feat');
  git('worktree', 'add', '-b', 'feat', wt);
  mkdirSync(join(wt, 'sub'));
  assert.equal(connectRefusalReason(wt, ctx), null, '平级 worktree 不让加，手机上就再也用不上它');
  assert.equal(connectRefusalReason(join(wt, 'sub'), ctx), null);
  assert.equal(connectRefusalReason(repo, ctx), null, '仓库本身可以加');
  assert.equal(connectRefusalReason(wt, { ...ctx, connected: [wt] }), 'already_connected');
});

test('文件夹名：只收单段、非点开头、无控制字符、不超 255 字节', () => {
  for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a\0b', 'a\nb', 'x'.repeat(256), '中'.repeat(86)]) {
    assert.notEqual(validateFolderName(bad), null, `${JSON.stringify(bad).slice(0, 40)} 被放行了`);
  }
  for (const good of ['app', 'my project', '项目-2026', 'x'.repeat(255)]) {
    assert.equal(validateFolderName(good), null, `${good.slice(0, 20)} 被拒了`);
  }
  assert.notEqual(validateFolderName(42), null);
});

test('新建：在范围内建出单层目录，返回真实路径', () => {
  const { home, ctx } = fixture();
  const res = createSubfolder('code', 'new-proj', ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, join(home, 'code', 'new-proj'));
  assert.ok(existsSync(res.path));
});

test('新建：绝对路径的父目录（家目录外）照常建；相对路径出界仍拒', () => {
  const { outside, ctx } = fixture();
  const res = createSubfolder(outside, 'outside-proj', ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, join(outside, 'outside-proj'));
  assert.ok(existsSync(res.path));
  assert.equal(createSubfolder('../outside', 'escape2', ctx).ok, false);
  assert.equal(existsSync(join(outside, 'escape2')), false);
});

// 清单在手机上改不了（来源是环境变量 / 外置文件、或没有配置文件）时，在已连接的文件夹之外建出来的目录接下来加不进清单，
// 只会在家目录里留一个空目录（验收 O41：先建出来、再报「改不了」）。已连接的文件夹里照常能建：那不用写清单。
test('新建：清单只读时，已连接的文件夹之外拒绝且什么都没建；已连接的文件夹里照常建', () => {
  const { home, ctx } = fixture();
  const ro = { ...ctx, readonly: 'source_readonly', connected: [join(home, 'code', 'app')] };
  assert.deepEqual(createSubfolder('code', 'ro-proj', ro), { ok: false, error: 'source_readonly' },
    '原因码与 folders:add 拒绝时同一个，前端同一套文案');
  assert.equal(existsSync(join(home, 'code', 'ro-proj')), false, '拒了却已经在磁盘上建出来了');
  assert.deepEqual(createSubfolder('', 'ro-top', { ...ro, readonly: 'no_config_file' }), { ok: false, error: 'no_config_file' });
  assert.equal(existsSync(join(home, 'ro-top')), false);
  const inner = createSubfolder('code/app', 'inner', ro);
  assert.equal(inner.ok, true, JSON.stringify(inner));
  assert.equal(inner.path, join(home, 'code', 'app', 'inner'));
  assert.equal(createSubfolder('code', 'rw-proj', { ...ro, readonly: null }).ok, true, '能改清单时不受影响');
});

// 建完再 realpath 复核：判完父目录到 mkdir 之间，路径可能被换成 symlink（家目录里的东西模型写得动）。
// mkdir 注入成「先换、再建」，把这个窗口确定地复现出来。
test('新建后复核：父目录在建的一刻被换成指向外面的 symlink——拒绝，并把被骗建到外面的空目录删掉', () => {
  const { home, outside, ctx } = fixture();
  const parent = join(home, 'code');
  const mkdir = target => {
    renameSync(parent, `${parent}-moved`);
    symlinkSync(outside, parent);
    mkdirSync(target);
  };
  assert.deepEqual(createSubfolder('code', 'swapped', { ...ctx, mkdir }), { ok: false, error: 'out_of_range' });
  assert.equal(existsSync(join(outside, 'swapped')), false, '建到家目录外的目录留在了那里');
  assert.ok(existsSync(outside), '外面那个目录本身不能被动');
});

test('新建后复核：刚建好的目录被换成指向别人目录的 symlink——拒绝，且别人的目录原样保留', () => {
  const { outside, ctx } = fixture();
  const victim = join(outside, 'someone-else');
  mkdirSync(victim);
  const mkdir = target => {
    mkdirSync(target);
    rmdirSync(target);
    symlinkSync(victim, target);
  };
  assert.deepEqual(createSubfolder('code', 'decoy', { ...ctx, mkdir }), { ok: false, error: 'out_of_range' });
  assert.ok(existsSync(victim), '复核时跟着 symlink 把别人的空目录删了');
});

// 建好之后父目录才被换成 symlink：target 的最后一段仍是目录（外面那个同名的），lstat 不跟最后一段、却跟着
// 父目录——只看「是不是目录」就会把别人的空目录 rmdir 掉（2026-10-11 review）。认的是建好那一刻的那个 inode。
// 注入的 mkdir 照真实实现那样建好、记下 lstat 再交回，换父目录发生在那之后。
test('新建后复核：建好之后父目录才被换成 symlink——外面同名的空目录不是自己建的，不删', () => {
  const { home, outside, ctx } = fixture();
  const parent = join(home, 'code');
  const victim = join(outside, 'late');
  mkdirSync(victim);
  const mkdir = target => {
    mkdirSync(target);
    const made = lstatSync(target);
    renameSync(parent, `${parent}-moved`);
    symlinkSync(outside, parent);
    return made;
  };
  assert.deepEqual(createSubfolder('code', 'late', { ...ctx, mkdir }), { ok: false, error: 'out_of_range' });
  assert.ok(existsSync(victim), '把父目录换走之后，外面那个同名的空目录被当成自己建的删了');
});

test('新建：已存在、名字不合法、父目录出界或在禁区里，一律拒绝且什么都没建出来', () => {
  const { home, outside, ctx } = fixture();
  assert.deepEqual(createSubfolder('code', 'app', ctx), { ok: false, error: 'exists' },
    '已存在：不能当成功（用户以为建了个新的空目录），也要和「建失败」分得开——前端提示不同');
  const before = readdirSync(join(home, 'code')).sort();
  assert.equal(createSubfolder('code', 'a/b', ctx).ok, false);
  assert.equal(createSubfolder('code', '..', ctx).ok, false);
  assert.equal(createSubfolder('code', '.hidden-new', ctx).ok, false, '点开头的名字 mkdir 本身建得出来，只有名字校验挡得住');
  assert.deepEqual(readdirSync(join(home, 'code')).sort(), before);
  assert.equal(createSubfolder('code/link-out', 'escaped', ctx).ok, false, '经 symlink 把目录建到家目录外');
  assert.equal(existsSync(join(outside, 'escaped')), false);
  assert.equal(createSubfolder('.claude', 'x2', ctx).ok, false);
  assert.equal(existsSync(join(home, '.claude', 'x2')), false);
  assert.equal(createSubfolder('../outside', 'y', ctx).ok, false);
  assert.equal(existsSync(join(outside, 'y')), false);
  assert.equal(createSubfolder('nope', 'z', ctx).ok, false, '父目录不存在时不能顺手递归建出来');
  assert.equal(existsSync(join(home, 'nope')), false);
});
