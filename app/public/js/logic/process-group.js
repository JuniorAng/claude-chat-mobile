// logic/process-group.js —— 过程痕迹（思考 / 工具卡 / 子 agent 卡）的分组判定与组头文案。
//
// 为什么是纯函数：分类与文案都不需要 DOM——拿到的是「这个节点是什么」的描述对象，
// 由 app/process-group.js 的工厂在投递时给出。这样规则能被 node:test 直接钉住，
// 而 live 与历史两条渲染路径共用同一份实现（刷新前后必须同构）。
import { t } from '../i18n.js';
import { formatCliDuration } from './bg-tasks.js';

const PROCESS_KINDS = new Set(['thinking', 'tool_use', 'subagent-card']);
const PROCESS_TYPE_BY_KIND = { thinking: 'thinking', tool_use: 'tool', 'subagent-card': 'agent' };

// 返回 'thinking' | 'tool' | 'agent' = 收进组；null = 这是正文/图表/其它，分组在这里断开。
// tool_result 刻意不收：它跟着自己的工具卡走（写回卡上的 .t-out），独立成项只会让计数翻倍。
export function classifyProcessNode(desc) {
  const kind = desc?.kind;
  if (!PROCESS_KINDS.has(kind)) return null;
  return PROCESS_TYPE_BY_KIND[kind];
}

// 组头文案：思考 1 · Bash 2 · Read 1 · 14s
// - 工具名按出现次数降序、同次数按名字升序，输出稳定（顺序本身也是断言的一部分）。
// - 超过两种工具就截到两种 + 「…」，手机一行放得下是这个函数唯一的长度约束。
// - 只有一个工具且没有思考段时不带计数（「Read」比「Read 1」更像一句话）。
// - durationMs 只在 >0 时追加，复用回合收尾行的 formatCliDuration（不另造第二套时长格式）。
export function summarizeProcessGroup(items, { durationMs = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const counts = { thinking: 0, tool: 0, agent: 0 };
  const byName = new Map();
  for (const item of list) {
    const type = item?.type;
    if (type === 'thinking') counts.thinking += 1;
    else if (type === 'agent') counts.agent += 1;
    else if (type === 'tool') {
      counts.tool += 1;
      const name = String(item.name || '').trim() || t('工具'); // '工具' 词典已有（'tool'，见 i18n.js 的转后台小节）
      byName.set(name, (byName.get(name) || 0) + 1);
    }
  }
  const toolNames = [...byName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const shown = toolNames.slice(0, 2);
  const more = toolNames.length > shown.length;

  const segs = [];
  if (counts.thinking) segs.push(`${t('思考')} ${counts.thinking}`);
  if (counts.agent) segs.push(`🤖 agent ${counts.agent}`);
  const onlyOneTool = counts.thinking === 0 && counts.agent === 0 && counts.tool === 1;
  for (const { name, count } of shown) segs.push(onlyOneTool ? name : `${name} ${count}`);
  if (more) segs.push('…');
  const ms = Number(durationMs);
  // 不足 1 秒不显示：刚开跑的两张卡会读出刺眼的「0s」，而它对判断「这轮贵不贵」没有信息量。
  if (Number.isFinite(ms) && ms >= 1000) segs.push(formatCliDuration(ms));

  return { text: segs.join(' · '), counts, toolNames };
}
