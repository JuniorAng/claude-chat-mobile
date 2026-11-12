// app/drawio-editor.js —— drawio 内联编辑器与 CCM 之间的 postMessage 桥。
//
// 【为什么是 iframe + 协议】drawio 编辑器是一个独立 webapp，且它的脚本需要 unsafe-eval。
// 我们把它放在同源但独立的 /drawio-editor/ 路由里，用 sandbox="allow-scripts"（**没有**
// allow-same-origin）装进 iframe：它在 opaque origin 里跑，读不到 CCM 的 localStorage
// （auth_token / device_token 在那里）。父页只通过 drawio 自己的嵌入协议（embed=1&proto=json）
// 传 XML 进、收 XML 出，不碰它的 DOM。
//
// 协议（实测）：编辑器先发 {event:'configure'}，回 {action:'configure', config:{}}；
// 再发 {event:'init'}，回 {action:'load', xml, title, autosave:0, saveAndExit:1}；
// 用户点 Save 发 {event:'save', xml}；点 Exit 发 {event:'exit'}。其余事件一律忽略。
import { t } from '../i18n.js';

export function createDrawioEditorBridge({
  documentRef = globalThis.document,
  socket,
  addBar = () => {},
  haptic = () => {},
  onSaved = () => {},
  onExit = () => {},
  widthCheck = () => true,
} = {}) {
  let frame = null;
  let open = null;     // { xml, name, baseHash, cwd, relPath }
  let saving = false;

  function post(message) {
    frame?.contentWindow?.postMessage(JSON.stringify(message), '*');
  }

  function close() {
    if (!frame) return;
    frame.remove?.();
    frame = null;
    open = null;
  }

  // 收到 save：整份新 XML 走 files:write（与 CodeMirror 同一条写回路径与冲突基线）。
  function saveXml(xml) {
    if (!open || saving) return;
    saving = true;
    const { cwd, relPath, baseHash } = open;
    socket.emit('files:write', { cwd, relPath, content: xml, baseHash }, response => {
      saving = false;
      // 迟到回执：编辑器已被关掉/换了文件，别把结果套到当前视图
      if (!open) return;
      if (!response?.ok) {
        // 留在编辑器里：冲突/超限要用户自己决定下一步，不擅自丢改动
        addBar(response?.error || t('保存失败'));
        return;
      }
      const done = open;
      close();
      onSaved(xml, response.contentHash, done);
    });
  }

  // 单元测试直接喂 { data, source } 形状；生产路径由 addEventListener 调进来。
  function handle(event) {
    if (!frame || event?.source !== frame.contentWindow) return;
    let message;
    try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.event === 'configure') {
      post({ action: 'configure', config: {} });
    } else if (message.event === 'init') {
      post({ action: 'load', xml: open?.xml ?? '', title: open?.name ?? '', autosave: 0, saveAndExit: 1 });
    } else if (message.event === 'save' && typeof message.xml === 'string') {
      saveXml(message.xml);
    } else if (message.event === 'exit') {
      const done = open;
      close();
      onExit(done);
    }
  }

  function openEditor({ host, xml, name, baseHash, cwd, relPath }) {
    close();
    if (!host || !documentRef) return;
    haptic('tap');
    open = { xml, name, baseHash, cwd, relPath };
    host.innerHTML = '';
    frame = documentRef.createElement('iframe');
    frame.className = 'w-full h-full border-0 bg-white';
    frame.title = t('draw.io 编辑器');
    // 没有 allow-same-origin = opaque origin：编辑器读不到 CCM 的 localStorage。
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('src', '/drawio-editor/?embed=1&proto=json&configure=1&pwa=1');
    host.appendChild(frame);
    const view = documentRef.defaultView || globalThis;
    view.addEventListener('message', handle);
  }

  return {
    open: openEditor,
    close,
    handle,
    widthCheck,
    isOpen: () => Boolean(frame),
  };
}
