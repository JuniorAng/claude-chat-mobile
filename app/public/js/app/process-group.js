// app/process-group.js —— 过程痕迹分组：把连续的 thinking / 工具卡 / 子 agent 卡收进一个可折叠组。
//
// 形态：
//   <details class="msg-frame process-group">
//     <summary>▸ 思考 1 · Bash 2 · Read 1 · 14s</summary>
//     <div class="pg-body"> … 原来的卡片，原样搬进来 … </div>
//   </details>
//
// 规则（与 logic/process-group.js 的纯函数一致）：
//   · 只有 ≥2 个连续过程项才包组；单条保持今天的样子，不白加一次点击。
//   · 正文 / 图表 / 用户气泡 / 系统条 = 断点，组在这里结束，最终回答永远在组外可见。
//   · live 期间默认展开（看得见在干什么），回合结束（endRun）按「用户没手动点过」的条件收起。
//   · 历史回放用 openByDefault:false 构造，与 live 同一份实现，刷新前后同构。
//
// 【为什么不包 widget】图表是输出本身，不是过程痕迹；收进组等于把结果藏起来。
// 【为什么不包 tool_result】它跟着自己的工具卡走（写回卡上的 .t-out），独立成项只会让计数翻倍。
import { classifyProcessNode, summarizeProcessGroup } from '../logic/process-group.js';


export function createProcessGroups({ el, now = () => Date.now() } = {}) {
  let group = null;       // 当前打开的 { details, body, summary, first, items, startedAt }
  let pending = null;     // 已经投递、但还只有一条的过程节点（等第二条到来才包组）
  const all = new Set();  // 所有已建组：endRun 要遍历它们

  function buildGroup(waitMs = 0) {
    const startedAt = now();
    const details = el(`
      <details class="msg-frame process-group text-xs" data-testid="process-group">
        <summary class="process-group-head px-2 py-1.5 flex items-center gap-2 cursor-pointer select-none">
          <span class="pg-arrow shrink-0 text-[9px]">▸</span>
          <span class="pg-summary flex-1 min-w-0 truncate text-ink-faint"></span>
        </summary>
        <div class="pg-body pl-3 space-y-1"></div>
      </details>`);
    const summary = details.querySelector('.pg-summary');
    const body = details.querySelector('.pg-body');
    details.open = true; // live 进行中展开
    // 用户手动开合过就记住，endRun 不再强行收起。
    details.querySelector('summary').addEventListener('click', () => { details.dataset.userToggle = '1'; });
    const g = { details, body, summary, items: [], startedAt, waitMs };
    all.add(g);
    return g;
  }

  function paint(g) {
    // 组在【第二条】到来时才建：时长要从第一条的时间算起，所以把已等待的那段补进来（waitMs）。
    const s = summarizeProcessGroup(g.items, { durationMs: (g.waitMs || 0) + (now() - g.startedAt) });
    g.summary.textContent = s.text;
    g.summary.title = s.text;
  }

  function moveInto(g, node) {
    g.body.appendChild(node);
    node.classList.add('pg-flatten'); // 组内去掉各自的左边线，避免两条竖线并排变脏
  }

  // 投递一个节点。desc 缺省 = 断点（正文/图表/气泡都走这条）。
  // 返回 { grouped }：调用方据此知道自己要不要额外做事（现在没有，留给将来）。
  function append(target, node, desc = null) {
    const type = classifyProcessNode(desc);
    if (!target || !node) return { grouped: false };
    if (!type) {
      closeGroup();
      pending = null;
      target.appendChild(node);
      return { grouped: false };
    }
    const item = { type, name: desc?.name || null };
    if (pending && !group) {
      // 第二条过程项到了：把已经投递的第一条搬进组，两条一起住进去。
      const first = pending;
      pending = null;
      group = buildGroup(Math.max(0, first.at ? now() - first.at : 0));
      target.appendChild(group.details);
      group.items.push({ type: first.type, name: first.name });
      moveInto(group, first.node);
    } else if (!group) {
      // 单条：原样投递，等可能的第二条。
      pending = { type, name: item.name, node, at: now() };
      target.appendChild(node);
      return { grouped: false };
    }
    group.items.push(item);
    moveInto(group, node);
    paint(group);
    return { grouped: true };
  }

  function closeGroup() {
    if (group) all.delete(group);
    group = null;
  }

  // 回合结束：收起所有组（用户手动点过的那几个除外）。幂等——result 与 setBusy(false) 都会调。
  function endRun() {
    for (const g of all) {
      if (g.details.dataset.userToggle === '1') continue;
      g.details.open = false;
    }
    all.clear();
    group = null;
    pending = null;
  }

  // 切会话 / 清屏：丢掉当前引用，不动已经在 DOM 里的组（它们随会话 DOM 缓存一起走）。
  function reset() {
    all.clear();
    group = null;
    pending = null;
  }

  return { append, endRun, reset };
}
