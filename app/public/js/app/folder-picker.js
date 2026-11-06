// app/folder-picker.js —— 「选文件夹」面板（「已连接的文件夹」，2026-09-24）
//
// 照官方桌面端新会话的文件夹选择：
//   · 已连接的文件夹：点一行就在那里开新会话；「›」进去挑子文件夹、就地新建；
//   · 无文件夹：一次性目录，首条消息时服务端才建；
//   · 添加文件夹：浏览整台电脑（2026-11-05 起），只看得到目录名，不能加的置灰并写明原因；「在这里开始会话」
//     先连上再开（已经连着的不重复加，「已经连接」只是提示），就地新建的也直接连上、在里面开（2026-10-15）。
//     Windows 上从「此电脑」列盘符进别的盘；协议里的位置是绝对路径，'' = 家目录。
// 开合走 sheets 原语；数据只走 folders:browse / folders:add / folders:mkdir 三条事件，判据全在服务端
// （FOLDER-01）——这里不替服务端判断能不能加，只把它的原因码翻成人话。
import { t } from '../i18n.js';
import { folderRootLabels, folderReasonText, projectLabel, relPathUnder } from '../logic/projects.js';

const ACK_TIMEOUT_MS = 8000;

export function createFolderPicker({ $, el, socket, openSheet, closeSheet, haptic = () => {}, getProjects, getScratchRoot, getFoldersReadonly = () => null, onPick }) {
  const modal = $('folderPickerModal');
  const body = $('folderPickerBody');
  const title = $('folderPickerTitle');
  const back = $('folderPickerBack');
  const status = $('folderPickerStatus');
  let home = null; // 家目录的真实路径：服务端在每次浏览回执里给，用来把家目录内的绝对路径显示成 ~/…
  let roots = []; // 可跳转的文件系统根（Windows 盘符 / POSIX 的 /）
  let hostWindows = true; // server 跑在 Windows 上？服务端回执里的 windows 字段说了算（文案用）
  let rootsReturn = null; // 进「此电脑」前那一屏：返回键回到它，而不是一脚踢出添加流程
  let view = { mode: 'root' };
  let gen = 0; // 浏览请求代次：快速连点时只认最后一次的回执

  const emit = (event, payload) => new Promise(resolve => {
    let settled = false;
    const done = res => { if (!settled) { settled = true; resolve(res); } };
    socket.emit(event, payload, res => done(res || { ok: false }));
    setTimeout(() => done({ ok: false }), ACK_TIMEOUT_MS);
  });
  // 家目录内显示 ~/…，家目录外显示绝对路径（Windows 上就是 D:\…）。
  const displayPath = p => {
    if (!home || !p) return p || '';
    if (p === home) return '~';
    const rel = relPathUnder(p, home);
    return rel == null ? p : (rel ? `~/${rel}` : '~');
  };
  const applyAck = r => {
    home = r.home;
    if (Array.isArray(r.roots)) roots = r.roots;
    if (typeof r.windows === 'boolean') hostWindows = r.windows;
  };

  function setStatus(text) {
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
  }

  function row({ icon, label, sub = '', testid, muted = false, disabled = false, onClick, onEnter }) {
    const wrap = el(`<div class="flex items-stretch border-b border-line-soft/60" data-testid="${testid}"></div>`);
    const main = el(`<button type="button" class="flex-1 min-w-0 text-left px-4 py-2.5 flex items-center gap-3 hover:bg-sunk/40 active:bg-sunk${muted ? ' text-ink-faint' : ' text-ink'}"></button>`);
    const ic = el('<span class="shrink-0 w-5 text-center"></span>');
    ic.textContent = icon;
    const text = el('<span class="min-w-0 flex flex-col"></span>');
    const name = el('<span class="truncate text-sm font-medium" data-folder-label></span>');
    name.textContent = label;
    text.appendChild(name);
    if (sub) {
      const s = el('<span class="truncate text-[11px] text-ink-faint" data-folder-sub></span>');
      s.textContent = sub;
      text.appendChild(s);
    }
    main.append(ic, text);
    if (disabled) main.disabled = true;
    else main.onclick = () => { haptic('tap'); onClick(); };
    wrap.appendChild(main);
    if (onEnter) {
      const enter = el(`<button type="button" class="shrink-0 w-11 flex items-center justify-center text-ink-faint hover:text-ink hover:bg-sunk/40" data-testid="folder-picker-enter" aria-label="${t('查看子文件夹')}" title="${t('查看子文件夹')}">›</button>`);
      enter.onclick = () => { haptic('tap'); onEnter(); };
      wrap.appendChild(enter);
    }
    return wrap;
  }

  function actionButton(label, testid, onClick) {
    const b = el(`<button type="button" class="px-3 py-1.5 rounded-lg text-xs font-semibold border border-line text-ink hover:bg-sunk active:scale-95 disabled:opacity-40" data-testid="${testid}"></button>`);
    b.textContent = label;
    if (onClick) b.onclick = () => { haptic('tap'); onClick(); };
    else b.disabled = true;
    return b;
  }

  function pick(cwd) {
    closeSheet(modal);
    onPick(cwd);
  }

  function renderRoot() {
    view = { mode: 'root' };
    rootsReturn = null;
    gen += 1;
    title.textContent = t('选择文件夹');
    back.classList.add('hidden');
    body.innerHTML = '';
    setStatus('');
    // 「无文件夹」「添加文件夹」放在清单之上：放末尾时文件夹一多（真机 11 个）就沉到折叠线以下
    const scratch = getScratchRoot();
    if (scratch) {
      body.appendChild(row({
        icon: '💭', label: t('无文件夹'), sub: t('一次性目录，不属于任何项目'), testid: 'folder-picker-no-folder',
        onClick: () => pick(scratch),
      }));
    }
    // 手机上改不了清单时同抽屉的「选择文件夹」（验收 O41 / O129）：置灰，原因写在副标题里，不给一个走进去才被拒的入口
    const readonly = getFoldersReadonly();
    body.appendChild(row({
      icon: '＋', label: t('添加文件夹'), sub: readonly ? folderReasonText(readonly) : t('从电脑里选一个文件夹连接进来'), testid: 'folder-picker-add',
      muted: Boolean(readonly), disabled: Boolean(readonly),
      onClick: () => enterBrowse('add', null),
    }));
    const head = el('<div class="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wide text-ink-faint"></div>');
    head.textContent = t('已连接的文件夹');
    body.appendChild(head);
    for (const p of getProjects().filter(x => x.kind !== 'scratch')) {
      body.appendChild(row({
        icon: '📁', label: projectLabel(p), sub: p.key, testid: 'folder-picker-project',
        onClick: () => pick(p.key), onEnter: () => enterBrowse('pick', p.key),
      }));
    }
  }

  // purpose：pick = 在已连接的文件夹里挑子文件夹开会话；add = 在电脑上挑一个加进来。
  // startAbs：挑子文件夹时的起点（已连接的文件夹，绝对路径）；往回走不越过它。add 时 null = 不设起点。
  async function enterBrowse(purpose, startAbs) {
    if (!home) {
      const r = await emit('folders:browse', { path: '' });
      if (!r?.ok) { setStatus(folderReasonText(r?.error)); return; }
      applyAck(r);
    }
    await browse(purpose, startAbs == null ? '' : startAbs, startAbs);
  }

  // 文件系统根：Windows 列盘符，POSIX 只有 /。文案跟着 server 宿主走——手机上看到的是那台电脑。
  function renderRoots() {
    rootsReturn = view.mode === 'browse' ? view : null;
    view = { mode: 'roots' };
    gen += 1;
    const labels = folderRootLabels(hostWindows);
    title.textContent = labels.title;
    back.classList.remove('hidden');
    body.innerHTML = '';
    setStatus('');
    const head = el('<div class="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wide text-ink-faint"></div>');
    head.textContent = labels.section;
    body.appendChild(head);
    if (!roots.length) {
      const empty = el('<div class="px-4 py-4 text-xs text-ink-faint"></div>');
      empty.textContent = labels.empty;
      body.appendChild(empty);
      return;
    }
    for (const r of roots) {
      body.appendChild(row({
        icon: '💽', label: labels.root ?? (r.name || r.path), sub: r.path, testid: 'folder-picker-root',
        onClick: () => browse('add', r.path, null),
      }));
    }
  }

  async function browse(purpose, path, startPath) {
    const my = ++gen;
    const r = await emit('folders:browse', { path });
    if (my !== gen) return;
    if (!r?.ok) { setStatus(folderReasonText(r?.error)); return; }
    applyAck(r);
    view = { mode: 'browse', purpose, path: r.path, parent: r.parent ?? null, startPath: startPath ?? null };
    title.textContent = displayPath(r.path);
    back.classList.remove('hidden');
    body.innerHTML = '';
    setStatus('');

    const actions = el('<div class="px-4 py-2 flex flex-wrap items-center gap-2 border-b border-line"></div>');
    // 主按钮一律「在这里开始会话」：挑子文件夹时直接开；添加文件夹时先连上再开（已经连着的不重复加）。
    // 「已经连接」只是提示，不挡路；其余原因（家目录、磁盘根、禁区、托管 worktree……）才置灰。
    // 手机上改不了清单时（广播里的 foldersReadonly），新连的目录接下来加不进去，只会留一个空目录（验收 O41）：
    // 「新建文件夹」不给，先说清为什么；未连接的目录同样连不上，「在这里开始会话」一并置灰（已连接的照常可开）。
    // 挑子文件夹时都照常给——那是在已连接的文件夹里，不用写清单。
    const readonly = purpose === 'add' ? getFoldersReadonly() : null;
    const blocked = purpose === 'add' && r.reason !== 'already_connected' && Boolean(r.reason || readonly);
    const start = purpose === 'add' ? () => add(r.path) : () => pick(r.path);
    actions.appendChild(actionButton(t('在这里开始会话'), 'folder-picker-start-here', blocked ? null : start));
    if (!readonly) actions.appendChild(actionButton(t('新建文件夹'), 'folder-picker-mkdir', () => showMkdir(purpose, r.path)));
    if (readonly) {
      const why = el('<div class="w-full text-[11px] text-ink-faint" data-testid="folder-picker-readonly"></div>');
      why.textContent = folderReasonText(readonly);
      actions.appendChild(why);
    }
    if (purpose === 'add' && r.reason) {
      const why = el('<div class="w-full text-[11px] text-ink-faint" data-testid="folder-picker-here-reason"></div>');
      why.textContent = folderReasonText(r.reason);
      actions.appendChild(why);
    }
    body.appendChild(actions);

    if (purpose === 'add') {
      const labels = folderRootLabels(hostWindows);
      body.appendChild(row({
        icon: '💽', label: labels.jump, sub: labels.jumpSub, testid: 'folder-picker-roots',
        onClick: renderRoots,
      }));
    }
    for (const e of r.entries) {
      const why = purpose === 'add' && e.reason ? folderReasonText(e.reason) : '';
      const muted = Boolean(why) && e.reason !== 'already_connected';
      body.appendChild(row({ icon: '📁', label: e.name, sub: why, muted, testid: 'folder-picker-entry', onClick: () => browse(purpose, e.path, startPath) }));
    }
    if (!r.entries.length) {
      const empty = el('<div class="px-4 py-4 text-xs text-ink-faint"></div>');
      empty.textContent = t('这里没有子文件夹');
      body.appendChild(empty);
    }
    if (r.truncated) {
      const more = el('<div class="px-4 py-2 text-[11px] text-ink-faint"></div>');
      more.textContent = t('只列出了前 500 个');
      body.appendChild(more);
    }
  }

  async function add(path) {
    const r = await emit('folders:add', { path });
    if (!r?.ok) {
      setStatus(r?.message ? `${folderReasonText(r.error)}：${r.message}` : folderReasonText(r?.error));
      return;
    }
    haptic('success');
    pick(path); // 连上（或本来就连着）就在那里开新会话：添加文件夹本来就是为了在里面干活
  }

  function showMkdir(purpose, path) {
    body.querySelector('[data-testid="folder-picker-mkdir-form"]')?.remove();
    const form = el(`
      <form class="px-4 py-2 flex items-center gap-2 border-b border-line" data-testid="folder-picker-mkdir-form">
        <input type="text" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-line bg-surface text-sm text-ink" data-testid="folder-picker-mkdir-name" maxlength="255" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button type="submit" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cta text-white active:brightness-95" data-testid="folder-picker-mkdir-submit"></button>
      </form>`);
    const input = form.querySelector('input');
    input.placeholder = t('新文件夹的名字');
    form.querySelector('button').textContent = t('新建');
    form.onsubmit = async ev => {
      ev.preventDefault();
      const r = await emit('folders:mkdir', { path, name: input.value.trim() });
      if (!r?.ok) { setStatus(folderReasonText(r?.error)); return; }
      haptic('success');
      // 浏览电脑时新建：建好就连上、就在里面开新会话（建一个空文件夹本来就是为了在里面干活）
      if (purpose === 'pick') pick(r.path);
      else await add(r.path);
    };
    body.insertBefore(form, body.children[1] || null);
    input.focus();
  }

  function goBack() {
    if (view.mode === 'roots') {
      const back = rootsReturn;
      rootsReturn = null;
      if (back) browse(back.purpose, back.path, back.startPath);
      else renderRoot();
      return;
    }
    if (view.mode !== 'browse') return;
    // 挑子文件夹时不往起点之上走：那之上不在已连接的文件夹里，「在这里开始会话」会被服务端拒
    if (view.startPath != null && view.path === view.startPath) { renderRoot(); return; }
    // 磁盘根再往上就是「此电脑」：Windows 上从 D:\ 回到盘符列表，而不是停在一个不存在的上级
    if (view.parent == null) { renderRoots(); return; }
    browse(view.purpose, view.parent, view.startPath);
  }

  back.onclick = () => { haptic('tap'); goBack(); };
  $('folderPickerClose').onclick = () => closeSheet(modal);
  modal.onclick = ev => { if (ev.target === modal) closeSheet(modal); };

  function open({ mode = 'root' } = {}) {
    renderRoot();
    openSheet(modal);
    if (mode === 'add') enterBrowse('add', null);
  }

  return { open };
}
