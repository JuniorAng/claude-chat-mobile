// desktop-rail.js —— 桌面右栏（≥1280px）上方的三张信息卡：当前会话状态、其他工作区、后台任务。
//
// 右栏的下半截不是新实现：它就是把既有的 #workspaceModal（文件 / 改动两个 tab）在宽屏下
// 停靠成第三列（CSS 见 app.css 的 1280 断点）。所以文件浏览与 git 改动零复制，这里只画
// 三张只读小卡——数据全部来自已经在前端手里的 status_line / instances / task_status，
// 不新增任何 socket 事件。
//
// 不在这里读 window.innerWidth：窄屏由 .rail-only 直接 display:none，drawer 控制器管好
// 自己那一列即可。卡片照常更新（几行 textContent，代价可忽略），窗口拉宽时立刻是热的。
import { formatStatuslineCtxLeft, resolveDrawerStatusChip } from '../logic.js';
import { t } from '../i18n.js';

export function createDesktopRail({
  $,
  el,
  getInstancesList = () => [],
  getViewingInstanceId = () => null,
  projectsState = null,
  onOpenInstance = () => {},
} = {}) {
  let lastStatusLine = null;
  let lastTasks = [];

  const bodyOf = id => $(id);

  function row(label, value, cls = '') {
    if (value == null || value === '') return null;
    const node = el(`<div class="rail-row"><span class="rail-k"></span><span class="rail-v ${cls}"></span></div>`);
    node.querySelector('.rail-k').textContent = label;
    node.querySelector('.rail-v').textContent = value;
    return node;
  }

  function empty(text) {
    const node = el('<div class="rail-empty"></div>');
    node.textContent = text;
    return node;
  }

  // ── 1. 当前会话：把 statusline 里对「这一轮在干什么」最要紧的几项压成 4 行 ──
  function renderSession() {
    const body = bodyOf('railSessionBody');
    const badge = bodyOf('railSessionBadge');
    if (!body) return;
    body.textContent = '';
    const p = lastStatusLine;
    if (badge) {
      const viewing = getInstancesList().find(i => i.instanceId === getViewingInstanceId());
      const chip = resolveDrawerStatusChip({ liveState: viewing?.state });
      badge.textContent = chip?.label || '';
      badge.classList.toggle('hidden', !chip);
    }
    if (!p) { body.appendChild(empty(t('暂无状态'))); return; }
    body.appendChild(row(t('模型'), p.model));
    if (p.ctx && Number.isFinite(p.ctx.usedPercent)) {
      const left = formatStatuslineCtxLeft(p.ctx);
      body.appendChild(row(t('上下文'), `${p.ctx.usedPercent}%${left ? ` · ${left}` : ''}`));
    }
    if (p.git?.branch) {
      let b = p.git.branch;
      if (p.git.staged) b += ` +${p.git.staged}`;
      if (p.git.modified) b += ` !${p.git.modified}`;
      if (p.git.untracked) b += ` ?${p.git.untracked}`;
      body.appendChild(row('Git', b));
    }
    const rate = p.rate?.fiveHour && Number.isFinite(p.rate.fiveHour.usedPercent)
      ? `5h ${Math.round(p.rate.fiveHour.usedPercent)}%` : null;
    if (rate) body.appendChild(row('额度', rate, p.rate.fiveHour.usedPercent >= 90 ? 'text-danger' : ''));
  }

  // ── 2. 其他工作区：除当前查看实例之外还开着的会话，点一下就切过去 ──
  function renderWorkspaces() {
    const body = bodyOf('railWorkspacesBody');
    const count = bodyOf('railWorkspacesCount');
    if (!body) return;
    const viewing = getViewingInstanceId();
    const others = getInstancesList().filter(i => i?.instanceId && i.instanceId !== viewing);
    body.textContent = '';
    if (count) count.textContent = others.length ? String(others.length) : '';
    if (!others.length) { body.appendChild(empty(t('没有其他打开的会话'))); return; }
    for (const inst of others) {
      const chip = resolveDrawerStatusChip({ liveState: inst.state });
      const btn = el(`<button type="button" class="rail-ws" data-testid="rail-workspace-row"></button>`);
      btn.dataset.instanceId = inst.instanceId;
      const dot = el('<span class="rail-ws-dot"></span>');
      dot.dataset.state = chip?.status || 'idle';
      const text = el('<span class="rail-ws-text"><span class="rail-ws-project"></span><span class="rail-ws-title"></span></span>');
      text.querySelector('.rail-ws-project').textContent = projectsState?.labelFor?.(inst.projectKey || inst.cwd) || '';
      text.querySelector('.rail-ws-title').textContent = inst.title || String(inst.sessionId || '').slice(0, 8) || t('新会话');
      const state = el('<span class="rail-ws-state"></span>');
      state.textContent = chip?.label || t('空闲');
      btn.appendChild(dot);
      btn.appendChild(text);
      btn.appendChild(state);
      btn.onclick = () => onOpenInstance(inst.instanceId);
      body.appendChild(btn);
    }
  }

  // ── 3. 后台任务：task_status 控制器手里的当前实例任务快照 ──
  function renderTasks() {
    const body = bodyOf('railTasksBody');
    const count = bodyOf('railTasksCount');
    if (!body) return;
    body.textContent = '';
    if (count) count.textContent = lastTasks.length ? String(lastTasks.length) : '';
    if (!lastTasks.length) { body.appendChild(empty(t('没有后台任务'))); return; }
    for (const task of lastTasks) {
      const item = el('<div class="rail-task"><span class="rail-task-text"></span></div>');
      const text = task?.message || task?.description || task?.lastToolName || task?.taskType || '';
      item.querySelector('.rail-task-text').textContent = text;
      if (task?.taskType) item.dataset.type = task.taskType;
      body.appendChild(item);
    }
  }

  function refresh() {
    renderSession();
    renderWorkspaces();
    renderTasks();
  }

  return {
    refresh,
    setStatusLine(p) { lastStatusLine = p || null; renderSession(); },
    setTasks(tasks) { lastTasks = Array.isArray(tasks) ? tasks : []; renderTasks(); },
    setInstances() { renderSession(); renderWorkspaces(); },
  };
}
