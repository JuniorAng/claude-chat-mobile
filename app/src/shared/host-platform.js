// host-platform.js —— 宿主平台差异的单一开关（路径判据 + 可浏览的文件系统根）
//
// 手机端文件夹选择器、配置写入校验、启动读侧白名单都要回答同一组问题：
//   · 这条路径在本机算不算绝对路径？放行一个会被 realpath 按进程 cwd 解析的相对写法，
//     等于凭一条配置把当前目录整棵放进白名单。
//   · 本机的文件系统根有哪些？Windows 是盘符（C:…Z:），POSIX 是 /。
// 这些判断此前散在三处各写一遍 `process.platform === 'win32'`，Windows 与 POSIX 的判据迟早分叉；
// 收在 shared 叶子层一处，并且 platform 可注入——Linux CI 能验证 Windows 分支，反之亦然。
import { existsSync } from 'node:fs';
import { isAbsolute as isAbsolutePosix } from 'node:path/posix';
import { isAbsolute as isAbsoluteWin32 } from 'node:path/win32';

export function isWindowsHost(platform = process.platform) {
  return platform === 'win32';
}

// 宿主平台的「绝对路径」：POSIX 只认 /…；Windows 认 C:\…、C:/…、\\server\share。
// Windows 形态只在 server 真跑在 Windows 上才认：POSIX 宿主放行 C:\… 会让 realpathSync
// 把它当成相对 cwd 的普通文件名。
export function isHostAbsolute(p, platform = process.platform) {
  const s = String(p ?? '');
  return isWindowsHost(platform) ? isAbsoluteWin32(s) : isAbsolutePosix(s);
}

// 可浏览的文件系统根：Windows 列真实存在的盘符（C:..Z:），其余平台只有 /。
// 只看盘符存不存在，不读盘里任何东西——客户端据此从家目录跳到别的磁盘 / 挂载点。
// 结果缓存一小段时间：existsSync 打在离线的网络盘/空光驱上可能阻塞事件循环，而它会在
// **每次浏览**（包括本地目录）时同步跑 24 次，一次点击就可能拖住所有在跑的会话与审批推送。
// 跳过 A:/B:（软驱位，现代机器上几乎不存在且最容易触发超时）。注入的探测函数不进缓存（测试）。
const ROOTS_TTL_MS = 30_000;
let rootsCache = null;
export function browseRoots({ platform = process.platform, exists = existsSync, now = Date.now } = {}) {
  if (!isWindowsHost(platform)) return [{ name: '/', path: '/' }];
  const injected = exists !== existsSync;
  if (!injected && rootsCache && now() - rootsCache.at < ROOTS_TTL_MS) return rootsCache.roots;
  const roots = [];
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const path = `${letter}:\\`;
    if (exists(path)) roots.push({ name: `${letter}:`, path });
  }
  if (!injected) rootsCache = { at: now(), roots };
  return roots;
}
