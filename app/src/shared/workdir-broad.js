// workdir-broad.js —— 「过宽根」判据（单一事实源）
//
// 两侧共用：`ops/env-schema.js` 的配置写入校验（WORKDIRS / path 类配置）与
// `sessions/folders.js` 的手机端文件夹选择器。放 shared 叶子层——sessions 不该 import ops，
// 而两个判据各写一份迟早会分叉（分叉的症状是「面板说能加，保存说太宽」）。
//
// 三层，任一命中即拒（失败方向是拒绝）：
//   1. 字面量：/、/Users、/home、/root（去尾斜杠后也比一次）
//   2. Windows 规范形态：先 win32.resolve 再比盘符根、家目录之父、UNC / 扩展 UNC 共享根。
//      **必须归一后再比**：D:\.、D:\dir\..、C:\Users\.、C:\Users\\、//server/share、
//      \\?\UNC\server\share 都是同一批位置的别名，只比字面量会被一个字符绕过。
//   3. 落盘形态：resolve（吃掉 . / .. / 重复斜杠）+ realpath（吃掉 symlink 与大小写）。
//      只在词法层比会漏 symlink；只在落点层比会漏「尚不存在」的路径与各平台的规范形态。
import { realpathSync } from 'node:fs';
import { resolve, win32 } from 'node:path';

const OVERLY_BROAD_ROOTS = ['/', '/Users', '/home', '/root'];

// win32.resolve 之后（已去尾分隔符）的形态：
//   盘符根 D:\        -> "D:"
//   家目录之父        -> "C:\Users" / "D:\home"
//   UNC 共享根        -> "\\server\share"
//   扩展 UNC 共享根   -> "\\?\UNC\server\share"
const WIN_DRIVE_ROOT_RE = /^[a-z]:$/i;
const WIN_HOME_PARENT_RE = /^[a-z]:\\(?:users|home)$/i;
const WIN_UNC_ROOT_RE = /^\\\\[^\\]+\\[^\\]+$/;
const WIN_EXTENDED_UNC_ROOT_RE = /^\\\\\?\\UNC\\[^\\]+\\[^\\]+$/i;

const stripTrailingSep = p => p.replace(/[\\/]+$/, '');

// 拒绝名单本身也要按落点归一，不能只比字面量：macOS 上 realpath('/Users') 是
// /System/Volumes/Data/Users，只比 '/Users' 时那个规范形态就能把整层家目录连进来。
// 缓存一次：这些系统的根不会在进程生命周期里换位置。
let broadRootFormsCache = null;
function broadRootForms() {
  if (broadRootFormsCache) return broadRootFormsCache;
  const forms = new Set();
  for (const root of OVERLY_BROAD_ROOTS) {
    forms.add(root);
    const lexical = resolve(root);
    forms.add(lexical);
    try { forms.add(realpathSync.native(lexical)); } catch { /* 该平台没有这个目录 */ }
  }
  broadRootFormsCache = [...forms];
  return broadRootFormsCache;
}

// p 是不是 child 的祖先（带分隔符边界；/home/tester2 不是 /home/tester 的祖先）。
// Windows 路径不分大小写；两侧都已经过 resolve/realpath 归一。
function isAncestor(parent, child) {
  const norm = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  const base = stripTrailingSep(norm(parent));
  const c = norm(child);
  return c.length > base.length && c.startsWith(base) && /[/\\]/.test(c[base.length]);
}

// 不看宿主 OS：配置是跨平台手写的，Linux CI 也要能验出 Windows 的过宽根。
export function isWindowsBroadRoot(rawPath) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return false;
  const bare = stripTrailingSep(win32.resolve(raw));
  return WIN_DRIVE_ROOT_RE.test(bare)
    || WIN_HOME_PARENT_RE.test(bare)
    || WIN_UNC_ROOT_RE.test(bare)
    || WIN_EXTENDED_UNC_ROOT_RE.test(bare);
}

// 返回 { lexical, real } 两种形态。**两种都要留着比**，只比一种都会漏：
//   · 只比落点：macOS 上 realpath('/home') 是 `/System/Volumes/Data/home`，字面写 `/home` 就绕过了
//     （实测，这正是本判据第一版漏掉的那格）。各平台的规范形态不可能逐个枚举。
//   · 只比词法：symlink 看不见，指向家目录的链接照样通过。
function workdirForms(rawPath) {
  const path = String(rawPath ?? '').trim();
  if (!path) return null;
  const lexical = resolve(path);
  let real = lexical;
  // .native：落到磁盘上的真实写法——macOS 不分大小写，/USERS 就是 /Users，JS 版会原样保留而漏拦
  try { real = realpathSync.native(lexical); } catch { /* 尚不存在 / 无权限：落点就按词法算，不因此放行 */ }
  return { lexical, real };
}

// 返回 'work_dir_too_broad' | 'work_dir_is_home' | null。
export function overlyBroadWorkdir(rawPath, home) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return null;
  const bare = stripTrailingSep(raw);
  // 字面量、归一后的名单形态与 Windows 规范形态先判：Windows 上 resolve('/Users') 是 C:\Users，
  // 只比归一后的 POSIX 形态会漏掉跨平台手写的配置；反过来 POSIX 宿主上 resolve('D:\\') 会把
  // 盘符当成普通路径段。
  const broadForms = broadRootForms();
  if (broadForms.includes(raw) || broadForms.includes(bare) || isWindowsBroadRoot(raw)) {
    return 'work_dir_too_broad';
  }
  const p = workdirForms(raw);
  if (!p) return null;
  if (broadForms.includes(p.lexical) || broadForms.includes(p.real)) return 'work_dir_too_broad';
  if (isWindowsBroadRoot(p.lexical) || isWindowsBroadRoot(p.real)) return 'work_dir_too_broad';
  const h = home ? workdirForms(home) : null;
  if (h) {
    if (p.lexical === h.lexical || p.real === h.real) return 'work_dir_is_home';
    // 家目录的祖先同样等于把整个家目录交给远程入口（名单只列了常见的几个，自定义家目录要按关系判）。
    if (isAncestor(p.lexical, h.lexical) || isAncestor(p.real, h.real)) return 'work_dir_too_broad';
  }
  return null;
}
