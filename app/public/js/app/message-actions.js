// app/message-actions.js —— 每条消息下方的操作栏（复制 / 朗读 / 分叉 / 回填 / 时间戳）。
// 从 app.js 原样迁出；只有本模块用的可变态（正在朗读的按钮）留在本模块，跨模块依赖经注入。
//
// 时间戳是第 5 个参数：调用方给信封/transcript 的原始 ts，缺失或非法时不挂节点——
// 客户端时钟不可信（见 message-timeline.js 头注），宁可没有，也不补一个猜的时刻。
import { t } from '../i18n.js';
import { formatActionBarTs, formatCalendarDayLabel, formatClockHm, normalizeMessageTs } from '../logic/message-time.js';

export function createMessageActions({
  el,
  haptic = () => {},
  copyText = async () => false,
  addBar = () => {},
  getInputEl = () => null,
  requestSessionFork = () => {},
  scrollBottom = () => {},
  now = () => Date.now(),
} = {}) {
  let activeSpeechBtn = null; // 语音朗读当前播放的按钮

  // 复制按钮的内容。尺寸由调用方写字面量类名（Tailwind 靠扫源码产出 utility）：代码块 w-3、消息操作栏 w-3.5。
  function copyBtnInnerHtml(sizeClasses) {
    return `
      <svg class="${sizeClasses}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
      </svg>
      <span>${t('复制')}</span>
    `;
  }

  function wireCopyFeedback(btn, getText, { stopPropagation = false } = {}) {
    btn.onclick = async (e) => {
      if (stopPropagation) e.stopPropagation();
      haptic('tap');
      const ok = await copyText(getText());
      const span = btn.querySelector('span');
      if (span) span.textContent = ok ? t('已复制') : t('失败');
      setTimeout(() => { if (span) span.textContent = t('复制'); }, 1500);
    };
  }

  function speakIdleHtml() {
    return `
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
      </svg>
      <span>${t('朗读')}</span>
    `;
  }

  function resetSpeakBtn(btn) {
    btn.innerHTML = speakIdleHtml();
  }

  // 栏尾的紧凑时间。完整值进 title + aria-label（手机没有 hover，读屏与长按才拿得到完整日期）。
  function appendStamp(row, raw) {
    const text = formatActionBarTs(raw, { now: now() });
    if (!text) return;
    const ms = normalizeMessageTs(raw);
    const stamp = el(`<span class="msg-action-ts" data-testid="msg-action-ts"></span>`);
    stamp.textContent = text;
    stamp.title = `${formatCalendarDayLabel(ms, now())} ${formatClockHm(ms)}`;
    stamp.setAttribute('aria-label', stamp.title);
    row.appendChild(stamp);
  }

  // E18: 消息气泡下方的操作栏。anchorUuid：这条气泡自己的权威 uuid，缺了就不挂需要锚点的入口。
  function appendCopyAction(container, getText, align, anchorUuid, ts) {
    if (!getText()) return;   // Empty messages have no action bar

    // For User messages (aligned to the right), render a single clean copy icon button aligned to the right
    if (align === 'right') {
      const row = el(`<div class="mt-1 text-right msg-action-bar justify-end"></div>`);
      const btn = el(`<button class="msg-action-btn hit-44" title="${t('复制消息')}">${copyBtnInnerHtml('w-3.5 h-3.5')}</button>`);
      wireCopyFeedback(btn, getText);
      row.appendChild(btn);
      // UX-012 / #362：填入输入框放在用户气泡；只回填原文，不 rewind / 不改历史
      const rewrite = el(`
        <button class="msg-action-btn hit-44" title="${t('将原文填入输入框（不回退历史）')}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          <span>${t('填入输入框')}</span>
        </button>
      `);
      rewrite.onclick = () => {
        haptic('tap');
        const val = getText();
        const inputEl = getInputEl();
        if (inputEl) {
          inputEl.value = val;
          inputEl.focus();
          inputEl.dispatchEvent(new Event('input'));
          scrollBottom(true);
        }
      };
      row.appendChild(rewrite);
      appendStamp(row, ts);
      container.appendChild(row);
      return;
    }

    // For Assistant messages (aligned to the left), render a beautiful multi-action bar
    const bar = el(`<div class="msg-action-bar justify-start"></div>`);

    // 1. Copy Button
    const copyBtn = el(`<button class="msg-action-btn" title="${t('复制消息')}">${copyBtnInnerHtml('w-3.5 h-3.5')}</button>`);
    wireCopyFeedback(copyBtn, getText);
    bar.appendChild(copyBtn);

    // 2. Speak (TTS) Button using browser-native Web Speech API
    const speakBtn = el(`<button class="msg-action-btn" title="${t('语音朗读')}">${speakIdleHtml()}</button>`);
    speakBtn.onclick = () => {
      // 特性检测：部分移动端浏览器/内嵌 WebView 不支持 Web Speech API，speechSynthesis 为 undefined
      // 时直接访问 .speaking 会抛未捕获 TypeError（同 copyText 的 navigator.clipboard && 检测风格）。
      if (typeof window.speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
        addBar(t('此设备不支持语音朗读'), 'text-info');
        return;
      }
      if (window.speechSynthesis.speaking && activeSpeechBtn === speakBtn) {
        window.speechSynthesis.cancel();
        resetSpeakBtn(speakBtn);
        activeSpeechBtn = null;
        return;
      }

      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        if (activeSpeechBtn) resetSpeakBtn(activeSpeechBtn);
      }

      haptic('tap');
      const text = getText();
      // Remove basic markdown formatting for cleaner speech synthesis output
      const cleanText = text.replace(/[*_`#]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
      if (!cleanText) return;

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.onend = () => {
        resetSpeakBtn(speakBtn);
        if (activeSpeechBtn === speakBtn) activeSpeechBtn = null;
      };

      speakBtn.innerHTML = `
        <svg class="w-3.5 h-3.5 text-danger animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <span class="text-danger font-semibold">${t('停止')}</span>
      `;
      activeSpeechBtn = speakBtn;
      window.speechSynthesis.speak(utterance);
    };
    bar.appendChild(speakBtn);

    // 对话轴分叉的可见入口。对齐 Claude Desktop 1.52386.6——它把「Fork from here」放在
    // assistant 消息的操作栏里，与复制/朗读同排。2026-10-26 起它是唯一入口（气泡长按还给了系统选字，
    // 见 requestSessionFork 头注）。
    //
    // 【为什么判 anchorUuid】没有锚点就分叉不了（requestSessionFork 开头直接 return）。
    // 流式气泡由 getStream 建、不带 dataset.uuid，旧 transcript 里也有缺 uuid 的条目——
    // 那两档摆出按钮就是摆一个点了必然失败的东西。「复制」不需要锚点，所以它照常在。
    if (anchorUuid) {
      const forkBtn = el(`
        <button class="msg-action-btn" data-testid="fork-action" title="${t('从这里分叉')}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 3v12m0 0a3 3 0 103 3 3 3 0 00-3-3zm0-12a3 3 0 110 6 3 3 0 010-6zm12 0a3 3 0 100 6 3 3 0 000-6zm0 6c0 6-6 3-6 9" />
          </svg>
          <span>${t('分叉')}</span>
        </button>
      `);
      // 确认框在 requestSessionFork 里，haptic 同理——按钮可见不等于一键执行。
      // uuid 在点击时由该函数从 container.dataset 读，不用这里的 anchorUuid：
      // 气泡的 dataset 才是权威值，且历史回显路径是先挂操作栏、后补 uuid。
      forkBtn.onclick = () => requestSessionFork(container);
      bar.appendChild(forkBtn);
    }

    // UX-012 / #362：编辑已迁到用户气泡「填入输入框」
    appendStamp(bar, ts);

    container.appendChild(bar);
  }

  return { appendCopyAction, copyBtnInnerHtml, wireCopyFeedback, speakIdleHtml };
}
