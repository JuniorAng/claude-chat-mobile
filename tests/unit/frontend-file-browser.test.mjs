// tests/unit/frontend-file-browser.test.mjs —— 文件 tab 控制器（app/public/js/app/file-browser.js）对迟到回执的处置
//
// browse:read 的回执是异步的：慢网下打开文件、返回、再打开同一个文件，两次请求的回执都会到。
// 两次请求的路径相同，只比路径的话两份正文都被接上，正文变成两遍；而 baseHash 仍是磁盘上那份的合法哈希，
// 点「编辑 → 保存」会把两遍的正文写回磁盘，服务端的冲突检查认不出来。
// CodeMirror 脚本是第一次打开文件时才按需拉的，正文到了还要等它，这段等待是同一类窗口。
// DOM 用最小桩（同 frontend-drawer.test.mjs 的做法），CodeMirror 用一个只记 value 的替身；
// 脚本加载是网络边界，用例自己决定什么时候触发 onload。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createFileBrowser } from '../../app/public/js/app/file-browser.js';

function fakeEl(tag = 'div') {
  const classes = new Set();
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    onclick: null,
    textContent: '',
    className: '',
    disabled: false,
    html: '',
    children: [],
    appendChild(child) { el.children.push(child); return child; },
    append(...nodes) { nodes.forEach(n => el.children.push(n)); },
    prepend(node) { el.children.unshift(node); return node; },
    setAttribute(name, value) { attrs.set(name, String(value)); if (name === 'class') el.className = String(value); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    querySelector(sel) {
      const m = /^\[data-testid="(.+)"\]$/.exec(sel || '');
      if (!m) return null;
      const walk = node => {
        for (const child of node.children || []) {
          if (child.getAttribute?.('data-testid') === m[1]) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
    querySelectorAll() { return []; },
    set innerHTML(_v) { el.html = _v; el.children = []; },
    get innerHTML() { return el.html; },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: c => classes.has(c),
    },
  };
  return el;
}

function harness(options = {}) {
  const dom = {
    fileBrowseBody: fakeEl(), fileBrowseBack: fakeEl(), fileBrowsePath: fakeEl(),
    fileBrowseEdit: fakeEl(), fileBrowseSave: fakeEl(), fileBrowseCancelEdit: fakeEl(), fileBrowseSaveError: fakeEl(),
    fileBrowseDownload: fakeEl(),
    fileBrowseSortGroup: fakeEl(), fileBrowseSortKey: fakeEl(), fileBrowseSortDir: fakeEl(),
  };
  const head = fakeEl(); // 按需插入的 CodeMirror <script> 落在这里
  const context = createAppContext({ dom, dependencies: { document: { createElement: tag => fakeEl(tag), head } } });
  const sent = []; // { event, payload, ack }：回执由用例决定何时、按什么顺序放行
  const emit = (event, payload, ack) => sent.push({ event, payload, ack });
  context.setSocket({
    emit,
    // socket.timeout(ms).emit 的回执多一个 err 位；超时这条路由 E2E 的真 socket.io 覆盖
    timeout: () => ({ emit: (event, payload, ack) => emit(event, payload, response => ack(null, response)) }),
  });
  const ctl = createFileBrowser(context, { createElement: () => fakeEl(), ...options });
  const pending = event => sent.filter(s => s.event === event);
  const rowNamed = name => dom.fileBrowseBody.children.find(row => row.children?.[1]?.textContent === name);
  return { ctl, dom, head, pending, rowNamed };
}

function fakeCodeMirror(editors) {
  return (_holder, opts) => {
    const cm = { mode: opts.mode, value: opts.value, getValue: () => cm.value, setValue: v => { cm.value = v; }, setOption() {}, focus() {} };
    editors.push(cm);
    return cm;
  };
}

test('#473 同名相对目录的旧回执不得覆盖新 worktree', () => {
  const { ctl, pending, rowNamed } = harness();
  ctl.open('/old');
  ctl.open('/new');
  const requests = pending('browse:list');
  requests[1].ack({ ok: true, entries: [{ name: 'NEW_CODE', kind: 'file', size: 1 }], truncated: false, totalCount: 1 });
  requests[0].ack({ ok: true, entries: [{ name: 'OLD_CODE', kind: 'file', size: 1 }], truncated: false, totalCount: 1 });
  assert.ok(rowNamed('NEW_CODE'));
  assert.equal(rowNamed('OLD_CODE'), undefined);
});

test('打开文件、返回、再打开同一个文件：两次读请求的回执都到了，正文和保存出去的内容都只有一份', async t => {
  const editors = [];
  t.after(() => { delete globalThis.CodeMirror; });

  const { ctl, dom, head, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, entries: [{ name: 'a.js', kind: 'file', size: 6 }], truncated: false, totalCount: 1 });
  rowNamed('a.js').onclick();          // 第一次打开，回执还在路上
  globalThis.CodeMirror = fakeCodeMirror(editors); // 按需加载的 CM 先拉完
  for (const script of head.children) script.onload();
  await new Promise(setImmediate);
  await ctl.back();                    // 返回列表
  rowNamed('a.js').onclick();          // 再打开同一个文件
  const reads = pending('browse:read');
  assert.equal(reads.length, 2, '两次打开应发出两次读请求');
  const reply = { ok: true, content: 'hello\n', bytesRead: 6, truncated: false, totalSize: 6, contentHash: 'h-disk' };
  reads[0].ack(reply);                 // 第一次的回执迟到
  reads[1].ack(reply);
  await new Promise(setImmediate);     // 第一次打开等过 CM 加载，它的渲染排在微任务里

  assert.equal(editors.at(-1).getValue(), 'hello\n', '同一个文件的正文被接了两遍');
  dom.fileBrowseEdit.onclick();
  dom.fileBrowseSave.onclick();
  const write = pending('files:write')[0];
  assert.ok(write, '可编辑的小文件点「保存」应发出 files:write');
  assert.equal(write.payload.content, 'hello\n', '保存把重复的正文带着合法的 baseHash 写回了磁盘');
});

test('CodeMirror 还在加载时换到另一个文件：先到的旧正文不得接进新文件，再随新文件的 baseHash 保存出去', async t => {
  const { ctl, dom, head, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({
    ok: true, truncated: false, totalCount: 2,
    entries: [{ name: 'a.js', kind: 'file', size: 2 }, { name: 'b.js', kind: 'file', size: 2 }],
  });
  rowNamed('a.js').onclick();          // 第一次打开文件，CodeMirror 开始按需加载
  pending('browse:read')[0].ack({ ok: true, content: 'A\n', bytesRead: 2, truncated: false, totalSize: 2, contentHash: 'h-a' });
  await ctl.back();                    // 正文到了、CM 还没拉完，用户返回
  rowNamed('b.js').onclick();          // 打开另一个文件
  pending('browse:read')[1].ack({ ok: true, content: 'B\n', bytesRead: 2, truncated: false, totalSize: 2, contentHash: 'h-b' });

  const editors = [];
  globalThis.CodeMirror = fakeCodeMirror(editors); // CM 脚本这时才拉完
  t.after(() => { delete globalThis.CodeMirror; });
  assert.ok(head.children.length > 0, '第一次打开文件没有插入 CodeMirror 脚本');
  for (const script of head.children) script.onload();
  await new Promise(setImmediate);

  assert.equal(editors.at(-1)?.getValue(), 'B\n', 'a.js 的正文被接进了 b.js 的视图');
  dom.fileBrowseEdit.onclick();
  dom.fileBrowseSave.onclick();
  const write = pending('files:write')[0];
  assert.ok(write, '可编辑的小文件点「保存」应发出 files:write');
  assert.deepEqual([write.payload.relPath, write.payload.content, write.payload.baseHash], ['b.js', 'B\n', 'h-b'],
    '保存把 a.js 的正文带着 b.js 的 baseHash 写进了 b.js');
});

// 核心脚本先执行、9 个 mode 随后：核心的全局在不等于整包就绪
test('CodeMirror 核心到了、某个语言 mode 没拉到：下次打开文件要重拉', async t => {
  const { ctl, head, pending, rowNamed } = harness();
  t.after(() => { delete globalThis.CodeMirror; });
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, entries: [{ name: 'a.py', kind: 'file', size: 2 }], truncated: false, totalCount: 1 });
  rowNamed('a.py').onclick();
  const firstBatch = [...head.children];
  const failed = firstBatch.find(script => script.src.includes('/mode-python.'));
  globalThis.CodeMirror = fakeCodeMirror([]);
  for (const script of firstBatch) (script === failed ? script.onerror() : script.onload());
  await new Promise(setImmediate);

  await ctl.back();
  rowNamed('a.py').onclick();
  assert.equal(head.children.filter(script => script.src === failed.src).length, 2,
    'python mode 那次没拉到，再打开文件也不重拉：刷新页面前 .py 一直没有高亮');
});

test('CodeMirror 核心已执行、语言 mode 还在路上时打开文件：等整包到齐再挂 CM', async t => {
  const { ctl, head, pending, rowNamed } = harness();
  t.after(() => { delete globalThis.CodeMirror; });
  ctl.open('/w');
  pending('browse:list')[0].ack({
    ok: true, truncated: false, totalCount: 2,
    entries: [{ name: 'a.js', kind: 'file', size: 2 }, { name: 'b.js', kind: 'file', size: 2 }],
  });
  rowNamed('a.js').onclick();
  const editors = [];
  globalThis.CodeMirror = fakeCodeMirror(editors);
  const core = head.children.find(script => script.src.includes('/codemirror.min.js'));
  core.onload();                       // 核心执行完，mode 还没到
  await ctl.back();
  rowNamed('b.js').onclick();
  pending('browse:read')[1].ack({ ok: true, content: 'B\n', bytesRead: 2, truncated: false, totalSize: 2, contentHash: 'h-b' });
  assert.equal(editors.length, 0, 'mode 还没执行就给 b.js 挂上了 CM：这个文件整场没有语法高亮');

  for (const script of head.children) if (script !== core) script.onload();
  await new Promise(setImmediate);
  assert.equal(editors.at(-1)?.getValue(), 'B\n', '整包到齐后 b.js 没挂上 CM');
});

// markdown 一次性读全走渲染视图；编辑看源码，取消后回到渲染视图
test('README.md 渲染成 HTML：点「编辑」挂 markdown 源码，取消后回到预览', async t => {
  const editors = [];
  t.after(() => { delete globalThis.CodeMirror; });
  const { ctl, dom, head, pending, rowNamed } = harness({ renderMarkdown: raw => `<h1>${raw.trim()}</h1>` });
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, entries: [{ name: 'README.md', kind: 'file', size: 5 }], truncated: false, totalCount: 1 });
  rowNamed('README.md').onclick();
  globalThis.CodeMirror = fakeCodeMirror(editors);
  for (const script of head.children) script.onload();
  await new Promise(setImmediate);
  pending('browse:read')[0].ack({ ok: true, content: '# Hi\n', bytesRead: 5, truncated: false, totalSize: 5, contentHash: 'h-md' });
  await new Promise(setImmediate);

  const article = dom.fileBrowseBody.children.at(-1);
  assert.equal(article.className, 'msg-body p-4');
  assert.equal(article.html, '<h1># Hi</h1>');
  assert.equal(editors.length, 0, '预览态不该挂 CodeMirror');
  assert.equal(dom.fileBrowseEdit.classList.contains('hidden'), false, '有 contentHash 的 markdown 应可编辑');

  dom.fileBrowseEdit.onclick();
  assert.equal(editors.at(-1).mode, 'text/markdown', '编辑 markdown 要看源码，不是纯文本 mode');
  assert.equal(editors.at(-1).getValue(), '# Hi\n');

  dom.fileBrowseCancelEdit.onclick();
  assert.equal(dom.fileBrowseBody.children.at(-1).className, 'msg-body p-4', '取消编辑后回到渲染视图');
});

const OPENED_FILE = { ok: true, root: '/w', relPath: 'link.txt', kind: 'file', name: 'link.txt', size: 1, media: null, url: '/f/ticket' };
const LIST_WITH_OTHER = { ok: true, entries: [{ name: 'other.txt', kind: 'file', size: 1 }], truncated: false, totalCount: 1 };

test('点了文件链接、回执没到就按返回：迟到的回执不得把列表换回那个文件', async () => {
  const { ctl, pending, rowNamed } = harness();
  ctl.openTarget('/w', { path: 'link.txt', line: null });
  await ctl.back();
  pending('browse:list')[0].ack(LIST_WITH_OTHER);

  pending('file:open')[0].ack(OPENED_FILE);

  assert.ok(rowNamed('other.txt'));
  assert.equal(pending('browse:read').length, 0);
});

test('点了文件链接、回执没到就返回并打开别的文件：迟到的回执不得换掉正在打开的文件', async () => {
  const { ctl, pending, rowNamed } = harness();
  ctl.openTarget('/w', { path: 'link.txt', line: null });
  await ctl.back();
  pending('browse:list')[0].ack(LIST_WITH_OTHER);
  rowNamed('other.txt').onclick();

  pending('file:open')[0].ack(OPENED_FILE);

  assert.deepEqual(pending('browse:read').map(request => request.payload.relPath), ['other.txt']);
});

test('下载时取票据失败：错误显示在工具行下，不动正在看的内容', () => {
  const { ctl, dom, pending } = harness();
  ctl.openTarget('/w', { path: 'link.txt', line: null });
  pending('file:open')[0].ack(OPENED_FILE);
  pending('browse:read')[0].ack({ ok: true, content: '', totalSize: 1, bytesRead: 0, truncated: false, binary: true });
  pending('file:open')[1].ack(OPENED_FILE);
  const shown = dom.fileBrowseBody.children.slice();

  dom.fileBrowseDownload.onclick();
  pending('file:open')[2].ack({ ok: false, error: '文件不存在' });

  assert.equal(dom.fileBrowseSaveError.textContent, '无法下载：文件不存在');
  assert.equal(dom.fileBrowseSaveError.classList.contains('hidden'), false);
  assert.deepEqual(dom.fileBrowseBody.children, shown);
});

test('name 模式目录不显示时间；mtime 模式两行都显示，且目录在最前', () => {
  const { ctl, dom, pending } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 2, entries: [
    { name: 'zz.js', kind: 'file', size: 10, mtime: 1_700_000_000_000 },
    { name: 'src', kind: 'dir', size: 0, mtime: 1_700_000_100_000 },
  ] });
  const rows = () => dom.fileBrowseBody.children.filter(r => r.children.length > 1);
  const srcRow = () => rows().find(r => r.children[1].textContent === 'src');
  assert.equal(srcRow().children.length, 2, 'name 模式目录不该有时间列');

  dom.fileBrowseSortKey.value = 'mtime';
  dom.fileBrowseSortKey.onchange();
  assert.equal(rows()[0].children[1].textContent, 'src', 'mtime 模式目录没有排最前');
  for (const row of rows()) {
    assert.equal(row.children.length, 3, `${row.children[1].textContent} 缺少时间列`);
    assert.match(row.children[2].textContent, /年|月/);
  }

  dom.fileBrowseSortDir.onclick();  // 升序 → 降序
  assert.equal(dom.fileBrowseSortDir.textContent, '↓');
  assert.equal(dom.fileBrowseSortKey.value, 'mtime');
});

test('排序状态在重新打开面板时复位为名称升序', () => {
  const { ctl, dom, pending } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1, entries: [{ name: 'a.js', kind: 'file', size: 1, mtime: 1 }] });
  dom.fileBrowseSortKey.value = 'size';
  dom.fileBrowseSortKey.onchange();
  ctl.open('/w');
  assert.equal(dom.fileBrowseSortKey.value, 'name');
  assert.equal(dom.fileBrowseSortDir.textContent, '↑');
});

test('index.html 走 iframe 预览：sandbox 空值，正文不进父页 DOM', async () => {
  const { ctl, dom, head, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1,
    entries: [{ name: 'index.html', kind: 'file', size: 26, mtime: 1 }] });
  rowNamed('index.html').onclick();
  for (const script of head.children) script.onload();   // CodeMirror 整包到齐，正文才会渲染（预览并不需要 CM）
  pending('browse:read')[0].ack({ ok: true, content: '<script>alert(1)</script>', bytesRead: 26, truncated: false, totalSize: 26, contentHash: 'h' });
  await new Promise(setImmediate);
  const frame = dom.fileBrowseBody.children.at(-1);
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.getAttribute('sandbox'), '');
  assert.equal(frame.srcdoc, '<script>alert(1)</script>');
  assert.equal(dom.fileBrowseBody.innerHTML.includes('<script>'), false, '文件内容被写进了父页 DOM');
});

test('截断的 .html 走源码，不出 iframe', async () => {
  const { ctl, dom, head, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1,
    entries: [{ name: 'big.html', kind: 'file', size: 999, mtime: 1 }] });
  rowNamed('big.html').onclick();
  for (const script of head.children) script.onload();
  pending('browse:read')[0].ack({ ok: true, content: '<h1>x</h1>', bytesRead: 11, truncated: true, totalSize: 999 });
  await new Promise(setImmediate);
  assert.notEqual(dom.fileBrowseBody.children.at(-1).tagName, 'IFRAME');
});

test('预览 A 之后切到 B：previewKind 复位，B 不被 A 的预览器接住', async () => {
  const { ctl, dom, head, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 2, entries: [
    { name: 'a.html', kind: 'file', size: 12, mtime: 1 }, { name: 'b.js', kind: 'file', size: 4, mtime: 2 },
  ] });
  rowNamed('a.html').onclick();
  for (const script of head.children) script.onload();
  pending('browse:read')[0].ack({ ok: true, content: '<h1>a</h1>', bytesRead: 12, truncated: false, totalSize: 12, contentHash: 'h' });
  await new Promise(setImmediate);
  assert.equal(dom.fileBrowseBody.children.at(-1).tagName, 'IFRAME');
  await ctl.back();
  rowNamed('b.js').onclick();
  pending('browse:read')[1].ack({ ok: true, content: 'x=1\n', bytesRead: 4, truncated: false, totalSize: 4, contentHash: 'h2' });
  await new Promise(setImmediate);
  assert.equal(dom.fileBrowseBody.children.some(c => c.tagName === 'IFRAME'), false,
    '切到 .js 后仍挂着上一个文件的 HTML 预览');
});

test('notes.mmd 渲染成 SVG；渲染失败回源码并说明原因', async () => {
  const { ctl, dom, head, pending, rowNamed } = harness({ sanitizeHtml: html => html });
  globalThis.mermaid = {
    initialize() {},
    async render(_id, src) { if (src.includes('BOOM')) throw new Error('Parse error'); return { svg: `<svg data-testid="mermaid-svg">${src}</svg>` }; },
  };
  try {
    ctl.open('/w');
    pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1,
      entries: [{ name: 'notes.mmd', kind: 'file', size: 16, mtime: 1 }] });
    rowNamed('notes.mmd').onclick();
    for (const script of head.children) script.onload();
    pending('browse:read')[0].ack({ ok: true, content: 'graph TD; A-->B', bytesRead: 16, truncated: false, totalSize: 16, contentHash: 'h' });
    await new Promise(setImmediate);
    assert.match(dom.fileBrowseBody.children.at(-1).html, /mermaid-svg/, '成功路径没有渲染 SVG');

    globalThis.mermaid.render = async () => { throw new Error('Parse error'); };
    await ctl.back();
    rowNamed('notes.mmd').onclick();
    pending('browse:read')[1].ack({ ok: true, content: 'BOOM', bytesRead: 4, truncated: false, totalSize: 4, contentHash: 'h2' });
    await new Promise(setImmediate);
    assert.ok(dom.fileBrowseBody.querySelector('[data-testid="file-preview-fallback"]'), '失败路径没有回源码');
  } finally { delete globalThis.mermaid; }
});

test('.drawio 走 mxgraph 数据属性预览；GraphViewer 抛错时回源码', async () => {
  const xml = '<mxfile><diagram id="d"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
  globalThis.GraphViewer = { processElements() {} };
  try {
    const { ctl, dom, head, pending, rowNamed } = harness({ sanitizeHtml: html => html });
    ctl.open('/w');
    pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1,
      entries: [{ name: 'flow.drawio', kind: 'file', size: xml.length, mtime: 1 }] });
    rowNamed('flow.drawio').onclick();
    for (const script of head.children) script.onload();
    pending('browse:read')[0].ack({ ok: true, content: xml, bytesRead: xml.length, truncated: false, totalSize: xml.length, contentHash: 'h' });
    await new Promise(setImmediate);
    const holder = dom.fileBrowseBody.querySelector('[data-testid="file-preview-drawio"]');
    assert.ok(holder, '没有挂 mxgraph 容器');
    assert.deepEqual(JSON.parse(holder.getAttribute('data-mxgraph')),
      { xml, toolbar: '', nav: false, resize: true });

    globalThis.GraphViewer.processElements = () => { throw new Error('boom'); };
    await ctl.back();
    rowNamed('flow.drawio').onclick();
    pending('browse:read')[1].ack({ ok: true, content: xml, bytesRead: xml.length, truncated: false, totalSize: xml.length, contentHash: 'h2' });
    await new Promise(setImmediate);
    assert.ok(dom.fileBrowseBody.querySelector('[data-testid="file-preview-fallback"]'), '渲染抛错没有回源码');
  } finally { delete globalThis.GraphViewer; }
});

test('drawioEmbedJson：编码后的 JSON 可解码回原 XML', async () => {
  const { drawioEmbedJson } = await import('../../app/public/js/app/file-browser.js');
  const xml = '<mxfile><diagram id="d"/></mxfile>';
  assert.deepEqual(JSON.parse(drawioEmbedJson(xml)),
    { xml, toolbar: '', nav: false, resize: true });
});

test('drawio 编辑：宽屏打开内联编辑器，窄屏给提示并退回 CodeMirror', async () => {
  const xml = '<mxfile><diagram id="d"/></mxfile>';
  globalThis.GraphViewer = { processElements() {} };
  try {
    const opened = [];
    const wide = harness({ sanitizeHtml: html => html, getDrawioEditor: () => ({ widthCheck: () => true, open: args => opened.push(args), close() {} }) });
    wide.ctl.open('/w');
    wide.pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1, entries: [{ name: 'd.drawio', kind: 'file', size: xml.length, mtime: 1 }] });
    wide.rowNamed('d.drawio').onclick();
    for (const script of wide.head.children) script.onload();
    wide.pending('browse:read')[0].ack({ ok: true, content: xml, bytesRead: xml.length, truncated: false, totalSize: xml.length, contentHash: 'h' });
    await new Promise(setImmediate);
    wide.dom.fileBrowseEdit.onclick();
    assert.equal(opened.length, 1, '宽屏没有打开 drawio 编辑器');
    assert.equal(opened[0].xml, xml);
    assert.equal(opened[0].host, wide.dom.fileBrowseBody);

    const narrow = harness({ sanitizeHtml: html => html, getDrawioEditor: () => ({ widthCheck: () => false, open: () => { throw new Error('窄屏不该打开'); }, close() {} }) });
    narrow.ctl.open('/w');
    narrow.pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1, entries: [{ name: 'd.drawio', kind: 'file', size: xml.length, mtime: 1 }] });
    narrow.rowNamed('d.drawio').onclick();
    for (const script of narrow.head.children) script.onload();
    narrow.pending('browse:read')[0].ack({ ok: true, content: xml, bytesRead: xml.length, truncated: false, totalSize: xml.length, contentHash: 'h' });
    await new Promise(setImmediate);
    globalThis.CodeMirror = (_holder, opts) => ({ mode: opts.mode, getValue: () => opts.value, setValue() {}, setOption() {}, focus() {}, lineCount: () => 1, addLineClass() {}, charCoords: () => ({ top: 0 }) });
    narrow.dom.fileBrowseEdit.onclick();
    assert.ok(narrow.dom.fileBrowseBody.querySelector('[data-testid="drawio-needs-wide"]'), '窄屏没有提示');
  } finally { delete globalThis.GraphViewer; delete globalThis.CodeMirror; }
});

test('预览器在途：加载中不显示「编辑」；离开后迟到的渲染不得清掉新文件', async () => {
  const { ctl, dom, head, pending, rowNamed } = harness({
    sanitizeHtml: html => html,
    renderMarkdown: raw => `<p>${raw}</p>`,
  });
  let mermaidResolve = null;
  const mermaidGate = new Promise(resolve => { mermaidResolve = resolve; });
  globalThis.mermaid = { initialize() {}, render: async () => { await mermaidGate; return { svg: '<svg data-testid="mermaid-svg"></svg>' }; } };
  try {
    ctl.open('/w');
    pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 2, entries: [
      { name: 'a.mmd', kind: 'file', size: 5, mtime: 1 },
      { name: 'README.md', kind: 'file', size: 5, mtime: 2 },
    ] });
    rowNamed('a.mmd').onclick();
    for (const script of head.children) script.onload();   // CodeMirror 先到
    pending('browse:read')[0].ack({ ok: true, content: 'graph TD; A', bytesRead: 13, truncated: false, totalSize: 13, contentHash: 'h' });
    await new Promise(setImmediate);   // 此时 mermaid 渲染被 gate 挂住

    assert.match(dom.fileBrowseBody.children.at(-1).textContent, /加载中/, '异步渲染期间必须是「加载中」，不能留空白');
    assert.equal(dom.fileBrowseEdit.classList.contains('hidden'), true, '预览还没画出来就露出「编辑」，编辑会把迟到的渲染压掉');

    await ctl.back();                                   // 离开这个文件
    rowNamed('README.md').onclick();
    pending('browse:read')[1].ack({ ok: true, content: '# hi', bytesRead: 4, truncated: false, totalSize: 4, contentHash: 'h2' });
    await new Promise(setImmediate);
    mermaidResolve();                                   // 旧文件的 mermaid 渲染这时才完成
    await new Promise(setImmediate);
    await new Promise(setImmediate);

    const last = dom.fileBrowseBody.children.at(-1);
    assert.equal(last.className, 'msg-body p-4', '迟到的 mermaid 渲染把新文件的 markdown 预览清掉了');
  } finally { delete globalThis.mermaid; }
});
