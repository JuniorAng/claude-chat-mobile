// folders.js —— 手机上「添加文件夹」「新建文件夹」的后端判据（FOLDER-01）
//
// 官方桌面端给手机开的是一份文件夹清单，手机上能直接加（2026-09-23 从桌面端安装包实证）。这里收口
// 「能看到什么、能加什么、能在哪建」：浏览只回目录名，可以浏览整台电脑（2026-11-05 起，家目录之外
// 用绝对路径，Windows 上从盘符进）；家目录本身、磁盘根、禁区、仓库里的托管 worktree 不能加。加进去之后
// 怎么授权在 folder-access.js（子目录可达、范围里的 worktree 随仓库）。
//
// 协议里的位置：'' = 家目录；相对路径 = 以家目录为根（出界即拒）；绝对路径 = 电脑上的那个目录，
// 家目录内外都行。浏览回执与每条子目录都带绝对路径，客户端不必自己拼服务端路径。
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { findWorktreeOwner, isWithin } from './folder-access.js';
import { managedWorktreeRoot } from './workdirs.js';
import { overlyBroadWorkdir } from '../shared/workdir-broad.js';
import { browseRoots, isWindowsHost } from '../shared/host-platform.js';

// 可浏览的文件系统根（Windows 盘符 / POSIX 的 /）由 shared/host-platform.js 给出，
// 这里原样导出，保持既有 import 面不变。
export { browseRoots };

export const MAX_BROWSE_ENTRIES = 500;
const MAX_NAME_BYTES = 255; // 文件系统单段名字上限（字节，不是字符）
const CONTROL_RE = /\p{Cc}/u; // 控制字符整类（C0、DEL、C1），同 auth/devices.js 的别名归一

// 与 folder-access.js 同一种 realpath（.native：磁盘上的真实写法），否则换个大小写能绕过禁区
const realOrNull = p => { try { return realpathSync.native(p); } catch { return null; } };
const inForbidden = (real, forbidden = []) => forbidden.map(realOrNull).some(f => f && isWithin(real, f));

// 家目录相对路径 → 家目录内的真实路径。出界（../、经 symlink 指出去）一律 error。
// 绝对路径（'' 之外，家目录内外都行）按绝对解；不存在时 not_found。
// 返回 { real, homeReal } 或 { error }。
function resolveCandidate(input, home) {
  if (typeof input !== 'string') return { error: 'not_found' };
  // 绝对路径不依赖 home：家目录解析不出来（profile 被删、HOME 指到没挂载的卷）时，
  // 盘符浏览仍然该能用；homeReal 为 null 只影响回执里的显示基准。
  const homeReal = realOrNull(home);
  if (isAbsolute(input)) {
    const real = realOrNull(input);
    return real ? { real, homeReal } : { error: 'not_found' };
  }
  if (!homeReal) return { error: 'not_found' };
  const real = realOrNull(resolve(homeReal, input));
  if (!real) return { error: 'not_found' };
  if (!isWithin(real, homeReal)) return { error: 'outside_home' };
  return { real, homeReal };
}

// 浏览的上一层：文件系统根（POSIX 的 /、Windows 的盘符根）没有上一层（null），
// 客户端据此显示「此电脑 / 文件系统」那一屏。
const parentOf = real => { const parent = dirname(real); return parent === real ? null : parent; };

// 这个目录能不能加成已连接的文件夹。null = 能；否则是拒绝原因（前端据此置灰并说明）。
// ctx：home 家目录 · forbidden 禁区（~/.claude、CCM 数据目录、scratch 根）· connected 已连接的文件夹
export function connectRefusalReason(candidate, { home, forbidden = [], connected = [] } = {}) {
  const real = typeof candidate === 'string' && candidate ? realOrNull(candidate) : null;
  if (!real) return 'not_found';
  let st;
  try { st = statSync(real); } catch { return 'not_found'; }
  if (!st.isDirectory()) return 'not_directory';
  if (parse(real).root === real) return 'root';
  const homeReal = realOrNull(home);
  if (real === homeReal) return 'home';
  if (inForbidden(real, forbidden)) return 'forbidden';
  // 先于 worktree 判：存量配置里显式连着的平级 worktree 该说「已经连接」，不是「请添加仓库」
  if (connected.some(c => realOrNull(c) === real)) return 'already_connected';
  // 与配置写入侧同一份过宽根判据（shared/workdir-broad.js）：面板上不该出现「能加」，点了保存才
  // 报「太宽」。浏览整台电脑之后 /Users、C:\Users、盘符根都走得到，两处判据必须同源。
  if (overlyBroadWorkdir(real, home)) return 'too_broad';
  // 官方：「Worktrees that Claude Code created can't be added on their own. Add the repository」——只拦建在仓库
  // `.claude/worktrees/` 下的（CCM 与 CLI 的 EnterWorktree 都建在那里，随仓库就够了）。用户自建的平级 worktree 是
  // 普通文件夹：范围外的 worktree 不随仓库授权（SCOPE-04），这里再不让加，手机上就再也用不上它。
  const wt = findWorktreeOwner(real);
  if (wt && isWithin(wt.worktreeRoot, managedWorktreeRoot(wt.repo))) return 'worktree';
  return null;
}

// 「添加文件夹」的目标：家目录相对路径或绝对路径 → 能加时给真实路径，否则给原因（同 connectRefusalReason）。
// 已经是连接根时不当成拒绝（2026-10-15）：手机上「在这里开始会话」也用在已经连着的文件夹上，交出路径并标明
// connected，由上层直接开会话、不再写一遍配置。浏览时照旧标「已经连接」（那是提示，不再挡路）。
export function resolveFolderToAdd(input, ctx = {}) {
  const at = resolveCandidate(input, ctx.home);
  if (at.error) return { ok: false, error: at.error };
  const reason = connectRefusalReason(at.real, ctx);
  if (reason === 'already_connected') return { ok: true, path: at.real, connected: true };
  return reason ? { ok: false, error: reason } : { ok: true, path: at.real };
}

// 列出一个目录下的子目录名（只有名字）。Dirent.isDirectory 不跟随 symlink，于是文件、FIFO、symlink
// 天然不在其列；点目录多是工具的内部状态，不列。每条带绝对路径与能不能加，当前目录自身也带。
// path：'' = 家目录；相对路径以家目录为根；绝对路径按绝对解（家目录内外都行）。
export function browseFolderNames(path, ctx = {}) {
  const at = resolveCandidate(path ?? '', ctx.home);
  if (at.error) return { ok: false, error: at.error === 'outside_home' ? 'out_of_range' : at.error };
  if (inForbidden(at.real, ctx.forbidden)) return { ok: false, error: 'out_of_range' };
  let dirents;
  try { dirents = readdirSync(at.real, { withFileTypes: true }); } catch { return { ok: false, error: 'unreadable' }; }
  const names = dirents.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, MAX_BROWSE_ENTRIES);
  return {
    ok: true,
    home: at.homeReal, // 客户端据此把家目录内的位置显示成 ~/…
    // 绝对路径：家目录外的位置用相对路径表达不了，客户端也不该自己拼服务端路径。
    path: at.real,
    parent: parentOf(at.real), // null = 文件系统根，上一层是「此电脑 / 文件系统」
    roots: browseRoots(),      // 可跳转的文件系统根（Windows 盘符 / POSIX 的 /）
    // 客户端据此选文案：Windows 说「此电脑 / 磁盘」，POSIX 说「文件系统 / 位置」。
    // 以服务端宿主为准，不是因为手机是什么系统——浏览的是 server 那台电脑。
    windows: isWindowsHost(),
    reason: connectRefusalReason(at.real, ctx),
    entries: shown.map(name => ({
      name,
      path: join(at.real, name),
      reason: connectRefusalReason(join(at.real, name), ctx),
    })),
    truncated: names.length > shown.length,
  };
}

// 新建文件夹的名字：单段、不以点开头（含 . 与 ..）、无控制字符、不超单段字节上限。null = 合法。
export function validateFolderName(name) {
  if (typeof name !== 'string' || !name) return 'empty';
  if (name.startsWith('.')) return 'hidden';
  if (name.includes('/') || name.includes('\\')) return 'separator';
  if (CONTROL_RE.test(name)) return 'control';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'too_long';
  return null;
}

// 在家目录内或任意绝对目录下新建一层子目录（非递归：父目录必须已存在）。
// 建完复核（FILES-2 同款）：判定与 mkdir 之间父目录可能被换成 symlink，mkdir 会跟着它建到别处——
// 真实路径不是预期的那一个，就撤掉这个刚建的空目录再拒。
// ctx.readonly：清单在手机上改不了时的原因码（同 folders:add 的拒绝原因）。这时已连接的文件夹之外建出来的目录
// 接下来加不进清单，只会留下一个空目录（验收 O41），建之前就拒；已连接的文件夹里照常建（不用写清单）。
// ctx.mkdir 是测试注入：建目录并交回刚建好那个目录的 lstat（真实实现建完立刻 lstat）。
const mkdirAndPin = target => { mkdirSync(target); return lstatSync(target); };
export function createSubfolder(parentPath, name, ctx = {}) {
  const bad = validateFolderName(name);
  if (bad) return { ok: false, error: bad };
  const at = resolveCandidate(parentPath ?? '', ctx.home);
  if (at.error) return { ok: false, error: at.error === 'outside_home' ? 'out_of_range' : at.error };
  if (inForbidden(at.real, ctx.forbidden)) return { ok: false, error: 'out_of_range' };
  if (ctx.readonly && !(ctx.connected ?? []).map(realOrNull).some(c => c && isWithin(at.real, c))) return { ok: false, error: ctx.readonly };
  const target = join(at.real, name);
  let made;
  try {
    made = (ctx.mkdir ?? mkdirAndPin)(target);
  } catch (err) {
    return { ok: false, error: err?.code === 'EEXIST' ? 'exists' : 'mkdir_failed' };
  }
  if (!made) { try { made = lstatSync(target); } catch { /* 已不在 */ } }
  const real = realOrNull(target);
  if (real !== target) {
    // 只删自己刚建的那个空目录：父目录被换成 symlink 时它被建到了外面，经 target 删掉它；target 本身
    // 若已被换成 symlink，跟着 realpath 删掉的会是别人的目录——lstat 不跟最后一级链接，是链接就不动。
    // 还得是建好那一刻的同一个 inode：建好之后父目录才被换走时，target 指到的是外面同名的别人的目录
    // （lstat 跟着父目录走），只看「是目录」就把它删了（2026-10-11 review）。
    let st = null;
    try { st = lstatSync(target); } catch { /* 已不在 */ }
    const same = st?.isDirectory() && made && st.dev === made.dev && st.ino === made.ino;
    if (same) { try { rmdirSync(target); } catch { /* 非空：不再动它 */ } }
    return { ok: false, error: 'out_of_range' };
  }
  return { ok: true, path: real };
}
