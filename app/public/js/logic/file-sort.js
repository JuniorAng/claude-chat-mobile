// logic/file-sort.js —— 文件列表排序：纯函数，数据进数据出。
//
// shortcut: 排序只作用于【已加载】的条目。点「加载更多」跨页后顺序不是全局最优；
// 要全局排序得改成服务端排序（会改写分页 offset 的语义），而手机上一次最多 500 条。
export function sortBrowseEntries(entries, { key = 'name', dir = 'asc' } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  // name = 服务端顺序（已按名字排好，分页游标依赖它）；未知 key 同样原样返回。
  if (key !== 'mtime' && key !== 'size') return list;

  const desc = dir === 'desc';
  const valueOf = entry => Number(key === 'size' ? entry.size : entry.mtime);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const byKey = (a, b) => {
    const av = valueOf(a), bv = valueOf(b);
    const aOk = Number.isFinite(av), bOk = Number.isFinite(bv);
    if (aOk !== bOk) return aOk ? -1 : 1;        // 缺值永远排最后，两个方向一致
    if (aOk && av !== bv) return desc ? bv - av : av - bv;
    return byName(a, b);                          // 同键按名字，两个方向都升序 → 翻页可预期
  };
  const dirs = list.filter(entry => entry.kind === 'dir').sort(byKey);
  const files = list.filter(entry => entry.kind !== 'dir').sort(byKey);
  return [...dirs, ...files];
}
