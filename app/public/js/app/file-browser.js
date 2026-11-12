/* global CodeMirror */
import { t } from '../i18n.js';
import { lineSpan } from '../logic/file-links.js';
import { sortBrowseEntries } from '../logic/file-sort.js';
import { formatBrowseTime } from '../logic/message-time.js';
import { showPanelMessage } from './panel-message.js';

const ICONS = { dir: '📁', file: '📄', symlink: '🔗' };
const FILE_OPEN_TIMEOUT_MS = 10_000;
// 目标行在 256KB 一页的第几页都有可能，但手机不能为一个行号把几十 MB 的日志拉完
const MAX_AUTO_PAGES = 8;

const MEDIA_HTML = {
  image: '<img class="max-w-full max-h-full" data-testid="file-preview-media">',
  video: '<video controls playsinline preload="metadata" class="max-w-full max-h-full" data-testid="file-preview-media"></video>',
  audio: '<audio controls class="w-full" data-testid="file-preview-media"></audio>',
};

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 扩展名 → CM5 MIME（直接用 mode 文件自己 defineMIME 注册的字符串，不拉 meta.js 的全量 200+ 语言表）。
// 只覆盖已 vendor 的 9 个 mode（javascript/xml/htmlmixed/css/markdown/python/shell/yaml/jsx，见
// public/vendor/codemirror/）；未命中回退 null → renderContent 退回纯文本 <pre>，不是错误态。
const CM_MIME_BY_EXT = {
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  jsx: 'text/jsx', ts: 'application/typescript', tsx: 'text/typescript-jsx',
  json: 'application/json', jsonc: 'application/json', map: 'application/json',
  html: 'text/html', htm: 'text/html',
  xml: 'application/xml', svg: 'application/xml',
  css: 'text/css', less: 'text/x-less', scss: 'text/x-scss',
  md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown',
  py: 'text/x-python', pyw: 'text/x-python',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  yml: 'text/x-yaml', yaml: 'text/x-yaml',
};

// 无高亮 mode 的文件挂 CM 的行数上限（见 renderContent）；有 mode 的文件不受此限，沿用既有行为。
const PLAIN_CM_MAX_LINES = 2000;

// public/vendor/codemirror/ 下按需加载的脚本（见 loadCodeMirror），核心排第一。
const CM_SCRIPTS = [
  'codemirror.min.js', 'mode-javascript.min.js', 'mode-xml.min.js', 'mode-css.min.js', 'mode-htmlmixed.min.js',
  'mode-jsx.min.js', 'mode-markdown.min.js', 'mode-python.min.js', 'mode-shell.min.js', 'mode-yaml.min.js',
];

export function cmModeForFileName(name) {
  const dot = String(name || '').lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return CM_MIME_BY_EXT[ext] || null;
}

// drawio 的公开嵌入协议：div.mxgraph + data-mxgraph(原始 JSON)。setAttribute 会处理引号转义，
// 不能再 encodeURIComponent——viewer 直接 JSON.parse 这个属性（实测报 "Unexpected token '%'"）。
// XML 全文交给 viewer 自己解析，不经我们 innerHTML。
export function drawioEmbedJson(xml) {
  return JSON.stringify({ xml, toolbar: '', nav: false, resize: true });
}

// draw.io 的静态 viewer 把 .drawio 里的 label HTML 铺进【应用文档】里（与 mermaid 不同，没有
// DOMPurify 第二道）。CSP 已经挡住脚本执行（script-src 'self'，无 unsafe-inline）与网络外带
// （default-src / img-src 'self'），这里再把能在 DOM 里留后手的节点、事件属性与 javascript: URL
// 拆掉——纵深防御不依赖单一控制。返回值只用于测试/诊断。
//
// SMIL（animate/set/discard…）也是攻击面：它能在我们的检查【之后】改写属性（把 href 改成
// javascript:）。viewer 的 SVG 用不到动画，直接拆掉。
const DANGEROUS_DRAWIO_TAGS = 'script,iframe,object,embed,meta,base,link,style,animate,set,animateTransform,animateMotion,discard';

// URL 属性只认会执行的三个名字。判定前先按浏览器解析 URL 的口径剥掉 C0 控制符与空白：
// `\x01javascript:` / `java\tscript:` 在地址栏里照样是 javascript:，而正则若只看原串会漏掉。
const normalizeUrlForSchemeCheck = value => String(value || '').replace(/[\u0000- ]+/g, '').toLowerCase();

export function isDangerousDrawioAttr(name, value) {
  const n = String(name || '').toLowerCase();
  if (n.startsWith('on')) return true;
  return /^(href|src|xlink:href)$/.test(n) && normalizeUrlForSchemeCheck(value).startsWith('javascript:');
}

export function hardenDrawioDom(root) {
  if (!root?.querySelectorAll) return 0;
  let removed = 0;
  for (const node of [...root.querySelectorAll(DANGEROUS_DRAWIO_TAGS)]) { node.remove(); removed += 1; }
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...(el.attributes || [])]) {
      if (!isDangerousDrawioAttr(attr.name, attr.value)) continue;
      el.removeAttribute(attr.name);
      removed += 1;
    }
  }
  return removed;
}

export function createFileBrowser(context, {
  baseName = path => String(path || '').split('/').filter(Boolean).pop() || '',
  // 编辑态下经返回/关闭/切 tab/点背景退出前的二次确认（由 app.js 注入 appConfirm 包装）；默认放行，
  // 免得忘注入时既有测试/调用方静默卡住——真实拦截行为完全靠调用方是否传入靠谱实现。
  confirmDiscardEdit = async () => true,
  createElement,
  haptic = () => {},
  renderMarkdown = null, // 与消息正文同一份 marked + DOMPurify，见 renderContent 的 markdown 预览
  sanitizeHtml = null,   // mermaid 预览的第二道净化；drawio 走 vendor viewer，见 hardenDrawioDom
  getDrawioEditor = () => null, // drawio 内联编辑器桥（app/drawio-editor.js）；惰性注入避免与控制器互相构造
} = {}) {
  const dom = context.dom;
  const documentRef = context.dependencies.document || globalThis.document;
  let cwd = null;
  let segments = [];
  let mode = 'list';
  let fileName = null;
  let listEntries = [];
  let listOffset = 0;
  let listTruncated = false;
  let listTotal = 0;
  let sortKey = 'name';   // 'name' | 'mtime' | 'size'；name 模式的顺序就是服务端顺序（分页游标依赖它）
  let sortDir = 'asc';
  let contentText = '';
  let contentOffset = 0;
  let contentReadGen = 0; // 每发一次 browse:read 加一，见 fetchContentPage
  let usedPagination = false; // 一旦分页续读过，本文件全程走 pre 纯文本，不中途切 CM（避免重建/滚动跳动）
  let cmInstance = null;   // 当前 content 视图里活的 CM 实例（只读预览态也是它，编辑态只是切它的 readOnly）
  let editMode = 'view';   // 'view' | 'editing'；离开 content 模式（back/loadContent 新文件）即复位
  let baseHash = null;     // files:write 的冲突基线——来自最近一次 browse:read 或 files:write 成功后的 contentHash
  let editOnDemand = false; // 行多的纯文本：查看留在 <pre>，点「编辑」才挂 CM（验收 O103，见 renderContent）
  let previewKind = null; // null | 'markdown' | 'html' | 'mermaid' | 'drawio'；编辑/保存后回到同一种预览
  let codeMirrorLoad = null; // CM 脚本的按需加载，见 loadCodeMirror
  let codeMirrorReady = false; // 整包（核心＋全部 mode）都执行完才算；核心先执行，全局在不等于 mode 到齐
  let mermaidLoad = null;   // mermaid 脚本的按需加载（同 CodeMirror 的单例模式）
  let mermaidSeq = 0;       // mermaid.render 要唯一 DOM id
  let drawioViewerLoad = null; // drawio 只读 viewer 的按需加载
  let drawioEditing = false; // 内联 drawio 编辑器是否正在接管正文区
  let previewPending = false; // 异步预览器（mermaid/drawio）还在加载：此时不给「编辑」
  let targetLine = null;   // 文件链接带的行号，定位到后清掉
  let autoPages = 0;       // 为了够到 targetLine 已自动续读的页数

  function relativePath() { return segments.join('/') || '.'; }

  // CM5（核心＋9 个语言 mode，约 250KB）只有文件浏览器用，不进启动链：第一次打开文件时才插 <script>，与 browse:read
  // 并行拉。async = false 让动态插入的脚本按插入顺序执行，mode 才挂得到核心上。vendor 按 immutable 缓存一年，
  // URL 得带版本戳才换得到新文件：服务端给全部相对 import 戳了 ?v=，本模块自己的 URL 上就有。
  // 整包到齐后返回 null，调用方照旧同步渲染。拉不到也照常 resolve：renderContent 本来就会在 CM 不在时回退 <pre>；
  // 单例随之清空，下次打开文件整包重拉（缓存命中的几个很快），别让一次网络抖动记一整个会话。
  function loadCodeMirror() {
    if (codeMirrorReady) return null;
    if (!codeMirrorLoad) {
      const version = new URL(import.meta.url).searchParams.get('v');
      codeMirrorLoad = Promise.all(CM_SCRIPTS.map(name => new Promise((resolve, reject) => {
        const script = documentRef.createElement('script');
        script.async = false;
        script.onload = resolve;
        script.onerror = reject;
        script.src = `/vendor/codemirror/${name}${version ? `?v=${version}` : ''}`;
        documentRef.head.appendChild(script);
      }))).then(() => { codeMirrorReady = true; }, () => { codeMirrorLoad = null; });
    }
    return codeMirrorLoad;
  }

  function renderHeader() {
    const rootList = mode === 'list' && segments.length === 0;
    dom.fileBrowseBack?.classList.toggle('hidden', rootList);
    if (!dom.fileBrowsePath) return;
    const parts = [baseName(cwd || '')].concat(segments);
    if (mode === 'content' && fileName) parts.push(fileName);
    dom.fileBrowsePath.textContent = parts.join(' / ');
  }

  function showMessage(text, className) {
    showPanelMessage(dom.fileBrowseBody, text, className, documentRef);
  }

  function fetchListPage(requestedPath, offset) {
    const requestedCwd = cwd;
    context.socket.emit('browse:list', { cwd, relPath: requestedPath, offset }, response => {
      if (cwd !== requestedCwd) return;
      if (mode !== 'list' || relativePath() !== requestedPath) return;
      if (!response?.ok) {
        showMessage(`${t('无法加载：')}${response?.error || t('未知错误')}`, 'text-danger');
        return;
      }
      listEntries = listEntries.concat(response.entries);
      listOffset = offset + response.entries.length;
      listTruncated = response.truncated;
      listTotal = response.totalCount;
      renderList();
    });
  }

  function loadList() {
    mode = 'list';
    listEntries = [];
    listOffset = 0;
    listTruncated = false;
    listTotal = 0;
    renderHeader();
    showMessage(t('加载中…'));
    fetchListPage(relativePath(), 0);
  }

  function renderList() {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    if (!listEntries.length) {
      showMessage(t('（空目录）'));
      return;
    }
    // 排序只作用于已加载条目；服务端顺序仍按名字分页（见 logic/file-sort.js 的 shortcut 注释）。
    const now = Date.now();
    const ordered = sortBrowseEntries(listEntries, { key: sortKey, dir: sortDir });
    for (const entry of ordered) {
      const row = createElement('<button class="w-full flex items-center gap-2 px-4 py-2.5 border-b border-line-soft text-left hover:bg-sunk/30 active:opacity-70" data-testid="browse-entry"></button>');
      const icon = createElement('<span class="shrink-0 w-5 text-center"></span>');
      icon.textContent = ICONS[entry.kind] || '❔';
      row.appendChild(icon);
      const name = createElement('<span class="flex-1 min-w-0 truncate text-xs text-ink"></span>');
      name.textContent = entry.name;
      row.appendChild(name);
      // 名称模式维持现状（文件显示大小、目录不显示）；按修改时间排序时两行都显示时间。
      const meta = entry.kind === 'dir'
        ? (sortKey === 'mtime' ? formatBrowseTime(entry.mtime, { now }) : '')
        : [formatFileSize(entry.size), sortKey === 'mtime' ? formatBrowseTime(entry.mtime, { now }) : '']
          .filter(Boolean).join(' · ');
      if (meta) {
        const cell = createElement('<span class="shrink-0 text-[10px] text-ink-faint"></span>');
        cell.textContent = meta;
        row.appendChild(cell);
      }
      row.onclick = () => {
        haptic('tap');
        openEntry(entry);
      };
      dom.fileBrowseBody.appendChild(row);
    }
    if (listTruncated) {
      const more = createElement('<button class="w-full p-3 text-center text-[11px] text-accent hover:bg-sunk/30 active:opacity-70"></button>');
      more.textContent = `${t('加载更多（已显示')} ${listEntries.length}/${listTotal}）`;
      more.onclick = () => {
        haptic('tap');
        fetchListPage(relativePath(), listOffset);
      };
      dom.fileBrowseBody.appendChild(more);
    }
  }

  function openEntry(entry) {
    if (entry.kind === 'dir') {
      segments.push(entry.name);
      loadList();
      return;
    }
    if (entry.kind === 'file') {
      loadContent(entry.name);
      return;
    }
    const requestedPath = segments.concat(entry.name).join('/');
    const requestedCwd = cwd;
    context.socket.emit('browse:list', { cwd, relPath: requestedPath }, response => {
      if (cwd !== requestedCwd) return;
      if (mode !== 'list' || relativePath() !== segments.join('/')) return;
      if (response?.ok) {
        segments.push(entry.name);
        listEntries = response.entries;
        listOffset = response.entries.length;
        listTruncated = response.truncated;
        listTotal = response.totalCount;
        renderHeader();
        renderList();
      } else {
        loadContent(entry.name);
      }
    });
  }

  // 只认最近一次读请求的回执。只比路径不够：打开、返回、再打开同一个文件（或换了 cwd 后同名的相对路径），
  // 两次回执都过得了路径检查，正文被接两遍，而 baseHash 仍是合法的，保存会把两遍的正文写回磁盘。
  // codeMirrorReady：loadCodeMirror() 的返回值，正文到了先等它再渲染，CM 才挂得上；等完要再认一遍，等的这段里用户可能已换了文件。
  function fetchContentPage(requestedPath, offset, codeMirrorReady = null) {
    const gen = ++contentReadGen;
    const stale = () => gen !== contentReadGen || mode !== 'content'
      || segments.concat(fileName || '').join('/') !== requestedPath;
    context.socket.emit('browse:read', { cwd, relPath: requestedPath, offset }, response => {
      if (stale()) return;
      if (!response?.ok) {
        showMessage(`${t('无法加载：')}${response?.error || t('未知错误')}`, 'text-danger');
        return;
      }
      if (response.binary) {
        requestFile(requestedPath, opened => {
          if (stale()) return;
          if (opened?.ok) renderBinary(opened);
          else showMessage(`${t('无法打开：')}${opened?.error || t('未知错误')}`, 'text-danger');
        });
        return;
      }
      const render = () => {
        if (stale()) return;
        contentText += response.content;
        contentOffset = offset + (response.bytesRead ?? response.content.length);
        renderContent(response.truncated, response.totalSize, response.contentHash);
      };
      if (codeMirrorReady) codeMirrorReady.then(render);
      else render();
    });
  }

  function loadContent(name, line = null) {
    mode = 'content';
    fileName = name;
    contentText = '';
    contentOffset = 0;
    usedPagination = false;
    targetLine = line;
    autoPages = 0;
    editMode = 'view';
    baseHash = null;
    hideSaveError();
    syncEditButtons();
    renderHeader();
    showMessage(t('加载中…'));
    fetchContentPage(segments.concat(name).join('/'), 0, loadCodeMirror());
  }

  // 前端随 pull 即时上线、后端要重启，旧后端不认 file:open、也就不回 ack，所以要有超时。
  function requestFile(path, onDone) {
    context.socket.timeout(FILE_OPEN_TIMEOUT_MS).emit('file:open', { cwd, path }, (err, response) => {
      onDone(err ? { ok: false, error: t('服务端没响应，刚更新过的话要重启后端') } : response);
    });
  }

  function renderBinary({ media, url, size }) {
    if (media) {
      const element = createElement(MEDIA_HTML[media]);
      // 文件不存在、编码放不了（比如 .mov 里的 HEVC）都走这里；元素已被换掉时不该再动正文
      element.onerror = () => {
        if (element.isConnected) showMessage(t('无法预览，可以下载后查看'), 'text-danger');
      };
      if (media === 'image') element.alt = fileName;
      element.src = url;
      const frame = createElement('<div class="h-full flex items-center justify-center p-2"></div>');
      frame.appendChild(element);
      dom.fileBrowseBody.innerHTML = '';
      dom.fileBrowseBody.appendChild(frame);
    } else {
      showMessage(`${t('二进制文件（')}${formatFileSize(size)}${t('），不支持预览')}`);
    }
    syncEditButtons();
  }

  // 票据现取：看了半小时的文件，打开时那张已经过期了。不用 location.assign：出错时 PWA 会跳到错误页，没有返回键。
  function download() {
    const name = fileName;
    haptic('tap');
    hideSaveError();
    requestFile(segments.concat(name).join('/'), opened => {
      if (!opened?.ok) {
        showSaveError(`${t('无法下载：')}${opened?.error || t('未知错误')}`);
        return;
      }
      const anchor = documentRef.createElement('a');
      anchor.href = `${opened.url}?download=1`;
      anchor.download = name;
      anchor.click();
    });
  }

  function stopMedia() {
    dom.fileBrowseBody?.querySelector('video, audio')?.pause();
  }

  function hideSaveError() {
    if (dom.fileBrowseSaveError) { dom.fileBrowseSaveError.classList.add('hidden'); dom.fileBrowseSaveError.textContent = ''; }
  }

  function showSaveError(text) {
    if (!dom.fileBrowseSaveError) return;
    dom.fileBrowseSaveError.textContent = text;
    dom.fileBrowseSaveError.classList.remove('hidden');
  }

  // 三态互斥：可编辑且未在编辑 → 编辑；正在编辑 → 保存+取消。不可编辑（无 baseHash：截断/二进制，或分页续读过）
  // → 三个都不显，file-browse.js 只读铁律的既有语义在这些场景下原样保留。
  // 排序控件只在列表模式可见；内容视图已经有编辑/保存/下载，再挤两个控件会把路径压没。
  function syncSortControls() {
    const listMode = mode === 'list';
    dom.fileBrowseSortGroup?.classList.toggle('hidden', !listMode);
    if (!listMode) return;
    if (dom.fileBrowseSortKey) dom.fileBrowseSortKey.value = sortKey;
    if (dom.fileBrowseSortDir) {
      dom.fileBrowseSortDir.textContent = sortDir === 'asc' ? '↑' : '↓';
      const label = sortDir === 'asc' ? t('升序') : t('降序');
      dom.fileBrowseSortDir.setAttribute?.('aria-label', label);
      dom.fileBrowseSortDir.title = label;
    }
  }

  function syncEditButtons() {
    syncSortControls();
    const editable = Boolean(baseHash) && (Boolean(cmInstance) || editOnDemand) && !drawioEditing && !previewPending;
    dom.fileBrowseEdit?.classList.toggle('hidden', !(editable && editMode === 'view'));
    dom.fileBrowseSave?.classList.toggle('hidden', editMode !== 'editing');
    dom.fileBrowseCancelEdit?.classList.toggle('hidden', editMode !== 'editing');
    dom.fileBrowseDownload?.classList.toggle('hidden', mode !== 'content' || !fileName || editMode === 'editing' || drawioEditing);
  }

  // 预览上方的一行提示（宽屏要求 / 放弃修改）。不替换正文，下一次 renderPreview 自然消失。
  function showPreviewNotice(text, testid) {
    if (!dom.fileBrowseBody) return;
    const notice = documentRef.createElement('div');
    notice.className = 'px-4 py-1.5 text-[10px] text-ink-faint border-b border-line-soft';
    if (testid) notice.setAttribute('data-testid', testid);
    notice.textContent = text;
    dom.fileBrowseBody.prepend?.(notice);
  }

  function enterEditMode() {
    // .drawio：宽屏走内联 drawio 编辑器；窄屏给一句说明并退回源码编辑（不是破碎的 UI）。
    const drawioEditor = getDrawioEditor();
    let showWideHint = false;
    if (previewKind === 'drawio' && drawioEditor) {
      if (drawioEditor.widthCheck()) {
        hideSaveError();
        drawioEditing = true;
        editMode = 'view';
        drawioEditor.open({
          host: dom.fileBrowseBody,
          xml: contentText,
          name: fileName,
          baseHash,
          cwd,
          relPath: segments.concat(fileName).join('/'),
        });
        syncEditButtons();
        return;
      }
      showWideHint = true;
    }
    if (!cmInstance && editOnDemand && baseHash) {
      dom.fileBrowseBody.innerHTML = '';
      mountCodeMirror(cmModeForFileName(fileName) || 'text/plain');
    }
    // 提示要在挂 CM 之后加：挂载会清空正文区，先加就被抹掉了。
    if (showWideHint) showPreviewNotice(t('这个编辑器需要更宽的屏幕；已改用源码编辑'), 'drawio-needs-wide');
    if (!cmInstance || editMode !== 'view') return;
    haptic('tap');
    hideSaveError();
    editMode = 'editing';
    cmInstance.setOption('readOnly', false);
    syncEditButtons();
    cmInstance.focus();
  }

  function exitEditMode() {
    if (editMode !== 'editing') return;
    haptic('tap');
    cmInstance?.setValue(contentText); // 撤销未保存的改动，回到加载/上次保存成功时的内容
    editMode = 'view';
    hideSaveError();
    if (previewKind) renderPreview();
    else cmInstance?.setOption('readOnly', 'nocursor');
    syncEditButtons();
  }

  function saveEdit() {
    if (!cmInstance || editMode !== 'editing' || !baseHash) return;
    haptic('tap');
    hideSaveError();
    const newContent = cmInstance.getValue();
    const path = segments.concat(fileName).join('/');
    if (dom.fileBrowseSave) dom.fileBrowseSave.disabled = true;
    context.socket.emit('files:write', { cwd, relPath: path, content: newContent, baseHash }, response => {
      if (dom.fileBrowseSave) dom.fileBrowseSave.disabled = false;
      // 迟到 ack 守卫：保存在途时用户已切走这个文件/关了浏览器，别把结果套到当前视图上。
      if (mode !== 'content' || segments.concat(fileName).join('/') !== path) return;
      if (!response?.ok) {
        showSaveError(response?.error || t('保存失败')); // 留在编辑态：冲突/超限等需要用户自己决定下一步，不擅自丢改动
        return;
      }
      contentText = newContent; // 基线随保存前移：取消编辑不会丢刚保存成功的内容
      baseHash = response.contentHash;
      editMode = 'view';
      if (previewKind) renderPreview();
      else cmInstance.setOption('readOnly', 'nocursor');
      syncEditButtons();
    });
  }

  function mountCodeMirror(mime) {
    const holder = documentRef.createElement('div');
    holder.className = 'cm-ccm-viewer';
    dom.fileBrowseBody.appendChild(holder);
    cmInstance = CodeMirror(holder, {
      value: contentText,
      mode: mime,
      readOnly: 'nocursor',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity,
    });
  }

  // 按扩展名决定预览器。html/htm → 沙箱 iframe；md 系列 → 渲染后的 markdown。
  function previewableKind(name) {
    const dot = String(name || '').lastIndexOf('.');
    const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
    if (ext === 'drawio' || ext === 'dio') return 'drawio';
    return null;
  }

  function renderPreview() {
    if (previewKind === 'html') renderHtmlPreview();
    else if (previewKind === 'mermaid') renderMermaidPreview();
    else if (previewKind === 'drawio') renderDrawioPreview();
    else renderMarkdownPreview();
  }

  function loadMermaid() {
    if (typeof globalThis.mermaid !== 'undefined') return Promise.resolve(globalThis.mermaid);
    if (!mermaidLoad) {
      const version = new URL(import.meta.url).searchParams.get('v');
      mermaidLoad = new Promise((resolve, reject) => {
        const script = documentRef.createElement('script');
        script.async = false;
        script.onload = resolve;
        script.onerror = reject;
        script.src = `/vendor/mermaid.min.js${version ? `?v=${version}` : ''}`;
        documentRef.head.appendChild(script);
      }).then(() => globalThis.mermaid || null, () => { mermaidLoad = null; return null; });
    }
    return mermaidLoad;
  }

  // .mmd / .mermaid 渲染成 SVG。securityLevel 'strict' 是 mermaid 自己的净化，输出再经注入的
  // sanitizeHtml 洗一遍；没注入就回源码（fail closed），绝不直接插未净化的 SVG。
  async function renderMermaidPreview() {
    // 快照：await 之后任何一项变了（换文件 / 进编辑 / 打开 drawio 编辑器），这次渲染都必须作废——
    // 否则迟到的渲染会清掉用户正在看的编辑器或另一个文件的预览。
    const gen = contentReadGen;
    const source = contentText;
    const cancelled = () => gen !== contentReadGen || mode !== 'content' || previewKind !== 'mermaid'
      || editMode !== 'view' || drawioEditing;
    previewPending = true;
    showMessage(t('加载中…'));
    syncEditButtons();
    const mermaid = await loadMermaid();
    if (cancelled()) return;
    previewPending = false;
    if (!mermaid || typeof sanitizeHtml !== 'function') {
      renderSourceFallback(t('渲染失败，已显示源码'));
      return;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: documentRef.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'default',
    });
    try {
      const { svg } = await mermaid.render(`ccm-mermaid-${++mermaidSeq}`, source);
      if (cancelled()) return;
      const holder = documentRef.createElement('div');
      holder.className = 'p-4 overflow-auto';
      holder.innerHTML = sanitizeHtml(svg);
      dom.fileBrowseBody.innerHTML = '';
      cmInstance = null;
      dom.fileBrowseBody.appendChild(holder);
      previewPending = false;
      syncEditButtons();
    } catch (err) {
      if (cancelled()) return;
      renderSourceFallback(`${t('渲染失败，已显示源码')}：${String(err?.message || err).slice(0, 80)}`);
    }
  }

  function loadDrawioViewer() {
    if (typeof globalThis.GraphViewer !== 'undefined') return Promise.resolve(globalThis.GraphViewer);
    if (!drawioViewerLoad) {
      const version = new URL(import.meta.url).searchParams.get('v');
      drawioViewerLoad = new Promise((resolve, reject) => {
        const script = documentRef.createElement('script');
        script.async = false;
        script.onload = resolve;
        script.onerror = reject;
        script.src = `/vendor/drawio/viewer-static.min.js${version ? `?v=${version}` : ''}`;
        documentRef.head.appendChild(script);
      }).then(() => globalThis.GraphViewer || null, () => { drawioViewerLoad = null; return null; });
    }
    return drawioViewerLoad;
  }

  // .drawio / .dio：只读渲染成 SVG。viewer 自己处理压缩态 <diagram> 与 html=1 label；
  // 脚本被主编排页的 CSP 拦住，图里的 HTML 只作展示。
  async function renderDrawioPreview() {
    const gen = contentReadGen;
    const cancelled = () => gen !== contentReadGen || mode !== 'content' || previewKind !== 'drawio'
      || editMode !== 'view' || drawioEditing;
    previewPending = true;
    showMessage(t('加载中…'));
    syncEditButtons();
    const viewer = await loadDrawioViewer();
    if (cancelled()) return;
    previewPending = false;
    if (!viewer) { renderSourceFallback(t('渲染失败，已显示源码')); return; }
    dom.fileBrowseBody.innerHTML = '';
    cmInstance = null;
    const holder = documentRef.createElement('div');
    holder.className = 'mxgraph p-2';
    holder.setAttribute('data-testid', 'file-preview-drawio');
    holder.setAttribute('data-mxgraph', drawioEmbedJson(contentText));
    dom.fileBrowseBody.appendChild(holder);
    previewPending = false;
    syncEditButtons();
    try {
      viewer.processElements();
      hardenDrawioDom(holder);
    } catch (err) {
      if (cancelled()) return;
      renderSourceFallback(`${t('渲染失败，已显示源码')}：${String(err?.message || err).slice(0, 80)}`);
    }
  }

  // 预览失败时的统一退路：一行原因 + 源码。绝不留空白面板。
  function renderSourceFallback(reason) {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    cmInstance = null;
    previewKind = null;
    previewPending = false;
    const notice = documentRef.createElement('div');
    notice.className = 'px-4 py-1.5 text-[10px] text-ink-faint border-b border-line-soft';
    notice.setAttribute('data-testid', 'file-preview-fallback');
    notice.textContent = reason;
    const pre = documentRef.createElement('pre');
    pre.className = 'p-4 text-[11px] leading-relaxed font-mono text-ink whitespace-pre-wrap break-words';
    pre.textContent = contentText;
    dom.fileBrowseBody.append(notice, pre);
    editOnDemand = Boolean(baseHash) && typeof CodeMirror !== 'undefined';
    syncEditButtons();
  }

  // HTML 只进 iframe 的 srcdoc，绝不进父页 innerHTML。sandbox 留空 = 无 allow-scripts、无 allow-same-origin：
  // 脚本被拦，且它读不到 CCM 的 localStorage（token 在那里）。样式照常生效，相对图片/外链会被 CSP 拦。
  function renderHtmlPreview() {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    cmInstance = null;
    const notice = documentRef.createElement('div');
    notice.className = 'px-4 py-1.5 text-[10px] text-ink-faint border-b border-line-soft';
    notice.textContent = t('预览已禁用脚本与外链图片；要改就点「编辑」');
    const frame = documentRef.createElement('iframe');
    frame.className = 'w-full h-full border-0 bg-white';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('data-testid', 'file-preview-html');
    frame.srcdoc = contentText;
    dom.fileBrowseBody.append(notice, frame);
  }

  // contentText 已经过注入的 renderMarkdown（marked + DOMPurify，含消息链路那套禁 label/form/style 的配置），
  // 直接 innerHTML 是安全的。
  function renderMarkdownPreview() {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    cmInstance = null;
    const article = documentRef.createElement('div');
    article.className = 'msg-body p-4'; // 复用消息正文的排版：serif 阅读字体、标题/列表/表格/代码块样式
    article.innerHTML = renderMarkdown(contentText);
    dom.fileBrowseBody.appendChild(article);
  }

  // 目标行放到视口上方三分之一处，上文也看得到
  function scrollBodyTo(windowY) {
    const body = dom.fileBrowseBody;
    body.scrollTop += windowY - body.getBoundingClientRect().top - body.clientHeight / 3;
  }

  function renderContent(truncated, totalSize, contentHash) {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    cmInstance = null;
    previewKind = null;
    previewPending = false;
    editMode = 'view';
    editOnDemand = false;
    baseHash = contentHash || null;
    // CM 只接管「一次性读全」的小文件：分页续读过的文件（>256KB 或用户点过加载更多）全程留在 pre，
    // 避免重建编辑器丢滚动位置；CM 脚本未加载时静默回退，不是错误态。没有对应高亮 mode 的扩展名（.txt、
    // Makefile、.env 等）照样挂 CM、用纯文本 mode——行号与编辑不该取决于有没有语法高亮。但超过
    // PLAIN_CM_MAX_LINES 行的仍回 pre：viewportMargin: Infinity 会逐行建 DOM，换行密集的日志能拖死手机。
    // 但能不能编辑只看 baseHash：这类文件「编辑」照给，点了才挂 CM——那时的逐行建 DOM 是用户要编辑才付的，
    // 而只是看一眼的不付（验收 O103：几 KB 的 .txt 因行多不能编辑，256KB 的 .js 却能）。
    const highlighted = cmModeForFileName(fileName);
    // markdown / html 一次性读全时直接渲染（读文档不该看源码）；带行号的链接定位、截断/分页仍走源码视图，
    // 前者要按行滚动，后者渲染半篇没有意义。点「编辑」才挂 CM 显示源码，取消/保存后回到预览。
    const kind = previewableKind(fileName);
    if (kind && !targetLine && !usedPagination && !truncated
      && (kind !== 'markdown' || typeof renderMarkdown === 'function')) {
      previewKind = kind;
      editOnDemand = Boolean(baseHash) && typeof CodeMirror !== 'undefined';
      renderPreview();
      syncEditButtons();
      return;
    }
    const plainOk = !highlighted && contentText.split('\n').length <= PLAIN_CM_MAX_LINES;
    const mime = !usedPagination && !truncated ? (highlighted || (plainOk ? 'text/plain' : null)) : null;
    if (mime && typeof CodeMirror !== 'undefined') {
      mountCodeMirror(mime);
      if (targetLine) {
        const line = Math.min(targetLine, cmInstance.lineCount()) - 1;
        cmInstance.addLineClass(line, 'background', 'file-target-line');
        scrollBodyTo(cmInstance.charCoords({ line, ch: 0 }, 'window').top);
        targetLine = null;
      }
      syncEditButtons();
      return;
    }
    editOnDemand = !highlighted && !plainOk && !usedPagination && !truncated && typeof CodeMirror !== 'undefined';
    syncEditButtons();
    const pre = documentRef.createElement('pre');
    pre.className = 'p-4 text-[11px] leading-relaxed font-mono text-ink whitespace-pre-wrap break-words';
    const span = targetLine ? lineSpan(contentText, targetLine) : null;
    if (span) {
      const mark = documentRef.createElement('span');
      mark.className = 'file-target-line';
      mark.textContent = contentText.slice(span.start, span.end);
      pre.append(contentText.slice(0, span.start), mark, contentText.slice(span.end));
      dom.fileBrowseBody.appendChild(pre);
      scrollBodyTo(mark.getBoundingClientRect().top);
      targetLine = null;
    } else {
      pre.textContent = contentText;
      dom.fileBrowseBody.appendChild(pre);
    }
    if (truncated) {
      const more = createElement('<button class="w-full p-3 text-center text-[11px] text-accent hover:bg-sunk/30 active:opacity-70 border-t border-line-soft"></button>');
      more.textContent = `${t('加载更多（已显示')} ${formatFileSize(contentOffset)}/${formatFileSize(totalSize)}）`;
      const loadMore = () => {
        usedPagination = true; // 哪怕这一页恰好读完全文（truncated 转 false），后续也不再切 CM
        fetchContentPage(segments.concat(fileName).join('/'), contentOffset);
      };
      more.onclick = () => {
        haptic('tap');
        loadMore();
      };
      dom.fileBrowseBody.appendChild(more);
      if (targetLine && autoPages < MAX_AUTO_PAGES) {
        autoPages += 1;
        loadMore();
      }
    }
  }

  // 离开 content 视图（回列表 / 换 cwd 重开）：清掉编辑三态与 CM 实例引用，隐藏编辑按钮组——
  // 否则上一个文件的「编辑」按钮会残留可见在列表视图里，或误挂着已失效的 baseHash。
  function resetEditState() {
    getDrawioEditor()?.close?.();
    drawioEditing = false;
    cmInstance = null;
    previewKind = null;
    editMode = 'view';
    editOnDemand = false;
    baseHash = null;
    hideSaveError();
    syncEditButtons();
  }

  // 编辑态下未保存改动才拦；view 态/无改动直接放行，不多问一句。
  async function confirmLeaveIfEditing() {
    if (editMode !== 'editing' && !drawioEditing) return true;
    return confirmDiscardEdit();
  }

  async function back() {
    if (mode === 'content' && !(await confirmLeaveIfEditing())) return;
    haptic('tap');
    if (mode === 'content') {
      fileName = null;
      mode = 'list';
      resetEditState();
      renderHeader();
      if (listEntries.length) renderList();
      else loadList(); // 从文件链接直接进来的，这一层的列表还没拉过
    } else if (segments.length > 0) {
      segments.pop();
      loadList();
    }
  }

  // 进入文件 tab 并从根目录重新载入。**不负责开合 sheet**——外壳（#workspaceModal）的开关与 tab
  // 切换归 createWorkspacePanel 统一持有，本控制器只管自己那半边的数据与渲染。
  function open(nextCwd) {
    contentReadGen++;
    cwd = nextCwd;
    segments = [];
    mode = 'list';
    fileName = null;
    sortKey = 'name';
    sortDir = 'asc';
    resetEditState();
    loadList();
  }

  // 打开消息里的文件链接。mode 先按内容页算：定位失败时「返回」也能回到根目录列表。
  function openTarget(nextCwd, { path, line }) {
    const gen = ++contentReadGen;
    cwd = nextCwd;
    segments = [];
    listEntries = [];
    fileName = null;
    mode = 'content';
    resetEditState();
    renderHeader();
    showMessage(t('加载中…'));
    requestFile(path, opened => {
      if (gen !== contentReadGen || mode !== 'content') return;
      if (!opened?.ok) {
        showMessage(`${t('无法打开：')}${opened?.error || t('未知错误')}`, 'text-danger');
        return;
      }
      cwd = opened.root;
      const parts = opened.relPath.split('/').filter(Boolean);
      if (opened.kind === 'dir') {
        segments = parts;
        loadList();
        return;
      }
      segments = parts.slice(0, -1);
      fileName = parts.at(-1);
      if (opened.media) {
        renderHeader();
        renderBinary(opened);
      } else {
        loadContent(fileName, line);
      }
    });
  }

  if (dom.fileBrowseSortKey) {
    dom.fileBrowseSortKey.onchange = () => {
      sortKey = dom.fileBrowseSortKey.value;
      haptic('tap');
      renderList();
    };
  }
  if (dom.fileBrowseSortDir) {
    dom.fileBrowseSortDir.onclick = () => {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      haptic('tap');
      syncSortControls();
      renderList();
    };
  }
  if (dom.fileBrowseBack) dom.fileBrowseBack.onclick = back;
  if (dom.fileBrowseDownload) dom.fileBrowseDownload.onclick = download;
  if (dom.fileBrowseEdit) dom.fileBrowseEdit.onclick = enterEditMode;
  if (dom.fileBrowseSave) dom.fileBrowseSave.onclick = saveEdit;
  if (dom.fileBrowseCancelEdit) dom.fileBrowseCancelEdit.onclick = exitEditMode;

  // confirmLeaveIfEditing 外露：关闭面板与**切到「改动」tab**都要先过这道未保存确认，
  // 否则切个 tab 就把用户没保存的编辑静默丢了。
  // drawio 编辑器的保存/退出回执（由 app.js 注入的桥回调）。
  function applyDrawioSave(xml, contentHash) {
    if (!drawioEditing) return;
    drawioEditing = false;
    contentText = xml;
    baseHash = contentHash || baseHash;
    editMode = 'view';
    hideSaveError();
    renderPreview();
    syncEditButtons();
  }
  function applyDrawioExit() {
    if (!drawioEditing) return;
    drawioEditing = false;
    editMode = 'view';
    renderPreview();
    showPreviewNotice(t('已放弃未保存的修改'), 'drawio-edit-exit');
    syncEditButtons();
  }

  return { back, open, openTarget, confirmLeaveIfEditing, stopMedia, applyDrawioSave, applyDrawioExit };
}
