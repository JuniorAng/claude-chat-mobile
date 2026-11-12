// tests/unit/frontend-drawio-editor.test.mjs —— drawio 内联编辑器的 postMessage 桥。
// 只测协议与写回语义；编辑器本身是 vendored 第三方代码，由 E2E 在真实浏览器里覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDrawioEditorBridge } from '../../app/public/js/app/drawio-editor.js';
import { setLang } from '../../app/public/js/i18n.js';

function fakeDoc() {
  const listeners = [];
  return {
    createElement: tag => {
      const el = {
        tagName: String(tag).toUpperCase(), className: '', title: '', src: '', children: [],
        attrs: new Map(),
        setAttribute(k, v) { el.attrs.set(k, String(v)); if (k === 'src') el.src = String(v); },
        getAttribute(k) { return el.attrs.has(k) ? el.attrs.get(k) : null; },
        appendChild(c) { el.children.push(c); return c; },
        remove() { el.removed = true; },
      };
      if (el.tagName === 'IFRAME') {
        el.contentWindow = { postMessage: s => { (el.__posts || (el.__posts = [])).push(JSON.parse(s)); } };
      }
      return el;
    },
    defaultView: { addEventListener: (_t, fn) => listeners.push(fn), removeEventListener: () => {} },
    _listeners: listeners,
  };
}

// postMessage 的调用记录挂在 frame 上的 contentWindow 里
function postsTo(frame) {
  return frame.__posts || (frame.__posts = []);
}

test('桥：configure → configure，init → load，save → files:write，exit → onExit', async () => {
  const documentRef = fakeDoc();
  const writes = [];
  let saved = null, exited = 0;
  const bridge = createDrawioEditorBridge({
    documentRef,
    socket: { emit: (event, payload, cb) => { writes.push(payload); cb({ ok: true, contentHash: 'h2' }); } },
    addBar: () => {},
    widthCheck: () => true,
    onSaved: (xml, hash) => { saved = { xml, hash }; },
    onExit: () => { exited += 1; },
  });
  const host = documentRef.createElement('div');
  bridge.open({ host, xml: '<mxfile/>', name: 'a.drawio', baseHash: 'h', cwd: '/w', relPath: 'a.drawio' });
  const frame = host.children.at(-1);
  const send = data => documentRef._listeners.at(-1)({ data: JSON.stringify(data), source: frame.contentWindow });
  const lastPost = () => postsTo(frame).at(-1);

  send({ event: 'configure' });
  assert.deepEqual(lastPost(), { action: 'configure', config: {} });

  send({ event: 'init' });
  assert.deepEqual(lastPost(), { action: 'load', xml: '<mxfile/>', title: 'a.drawio', autosave: 0, saveAndExit: 1 });

  send({ event: 'save', xml: '<mxfile><d/></mxfile>' });
  await new Promise(setImmediate);
  assert.deepEqual(writes, [{ cwd: '/w', relPath: 'a.drawio', content: '<mxfile><d/></mxfile>', baseHash: 'h' }]);
  assert.deepEqual(saved, { xml: '<mxfile><d/></mxfile>', hash: 'h2' });

  bridge.open({ host, xml: '<mxfile/>', name: 'b.drawio', baseHash: 'h9', cwd: '/w', relPath: 'b.drawio' });
  const frame2 = host.children.at(-1);
  documentRef._listeners.at(-1)({ data: JSON.stringify({ event: 'exit' }), source: frame2.contentWindow });
  assert.equal(exited, 1);
});

test('桥：保存冲突不回 onSaved、编辑器保持打开并报错', async () => {
  const documentRef = fakeDoc();
  let saved = 0, exited = 0;
  const errors = [];
  const bridge = createDrawioEditorBridge({
    documentRef,
    socket: { emit: (_e, _p, cb) => cb({ ok: false, error: '文件已被修改' }) },
    addBar: text => errors.push(text),
    widthCheck: () => true,
    onSaved: () => { saved += 1; },
    onExit: () => { exited += 1; },
  });
  const host = documentRef.createElement('div');
  bridge.open({ host, xml: '<mxfile/>', name: 'a.drawio', baseHash: 'h', cwd: '/w', relPath: 'a.drawio' });
  const frame = host.children.at(-1);
  documentRef._listeners.at(-1)({ data: JSON.stringify({ event: 'save', xml: '<mxfile/>' }), source: frame.contentWindow });
  await new Promise(setImmediate);
  assert.equal(saved, 0);
  assert.equal(exited, 0);
  assert.deepEqual(errors, ['文件已被修改']);
  assert.equal(bridge.isOpen(), true);
});

test('桥：来自别的 window 的消息、非 JSON、未知 event 一律忽略', () => {
  const documentRef = fakeDoc();
  const bridge = createDrawioEditorBridge({ documentRef, socket: { emit() { throw new Error('不该写盘'); } }, addBar: () => {} });
  const host = documentRef.createElement('div');
  bridge.open({ host, xml: '<mxfile/>', name: 'a.drawio', baseHash: 'h', cwd: '/w', relPath: 'a.drawio' });
  const frame = host.children.at(-1);
  const listener = documentRef._listeners.at(-1);
  listener({ data: 'not json', source: frame.contentWindow });
  listener({ data: JSON.stringify({ event: 'unknown' }), source: frame.contentWindow });
  listener({ data: JSON.stringify({ event: 'save', xml: '<x/>' }), source: { other: true } });
  assert.equal(bridge.isOpen(), true);
});

test('编辑器 iframe 的 title 走 i18n（英文界面不残留中文）', () => {
  setLang('en');
  try {
    const documentRef = fakeDoc();
    const bridge = createDrawioEditorBridge({ documentRef, socket: { emit() {} } });
    const host = documentRef.createElement('div');
    bridge.open({ host, xml: '<mxfile/>', name: 'a.drawio', baseHash: 'h', cwd: '/w', relPath: 'a.drawio' });
    assert.equal(host.children.at(-1).title, 'draw.io editor');
  } finally { setLang('zh'); }
});
