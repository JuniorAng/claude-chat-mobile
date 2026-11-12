# File Viewers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-message timestamp, a last-modified column plus sorting in the file browser, and HTML / Mermaid / draw.io previews (including an inline draw.io editor) to CCM's file panel.

**Architecture:** Six independent slices over one state machine. `app/public/js/app/file-browser.js` already has a `view` / `editing` machine; this plan widens it with `previewKind` (`null | 'markdown' | 'html' | 'mermaid' | 'drawio'`). Every preview degrades to the existing source view on any failure. Sorting is a pure front-end function over already-loaded entries; `browse:list` already returns `mtime`, so its contract does not change. Vendored viewers are lazy-loaded the way CodeMirror already is. The only server-side addition is one route prefix (`/drawio-editor/`) with a route-scoped `unsafe-eval` CSP and CORS.

**Tech Stack:** Node ≥20, ESM, express 5, socket.io, no build step, `node --test`, Playwright. Vendored: mermaid 11.12.0 (MIT), draw.io v32.6.10 (`viewer-static.min.js`, and the editor web app, Apache-2.0).

**Spec:** `docs/superpowers/specs/2026-11-12-file-viewers-design.md`. Executors read both.

## Global Constraints

- Work in the worktree `/home/ubuntu/ccm-file-viewers`, branch `feat/file-viewers` (based on `origin/dev`). PRs target `--base dev`.
- **No new npm dependency, no build step.** Everything vendored under `app/public/vendor/` + registered in `THIRD-PARTY-NOTICES.md`.
- Pure front-end logic goes in `app/public/js/logic/*` (no DOM/window/socket; only `../i18n.js` allowed) and is re-exported from `app/public/js/logic.js`.
- **The global CSP must never gain `unsafe-eval` or `unsafe-inline`.** Any relaxation is scoped to `/drawio-editor/`.
- **FILE-04 stays green:** `.html` / `.svg` are never served as `text/html` / `image/svg+xml` from CCM's origin. `tests/invariants/server/file-ticket-route.test.mjs` stays untouched.
- User-visible strings go through `t()` and get an `EN_DICT` entry.
- Failure direction: every preview falls back to the source view plus one plain sentence. Never a blank panel, never invented data.
- Dynamic values use `textContent`; `innerHTML` only for output already passed through `renderMarkdown` / DOMPurify.

## Review Focus

1. **A malicious file's content reaching the parent page.** `.html` must never be interpolated into CCM's DOM as HTML; `.drawio` labels support `html=1`. Covered by Task 3 (`srcdoc` + sandbox with no `allow-scripts`) and Task 6 (main-page CSP test).
2. **Paging + sorting disagree.** Sorting only reorders loaded entries; the tie-break and folder-first rule must stay stable. Task 2 pins it and carries a `shortcut:` comment.
3. **A stale `browse:read` ack landing on another file.** New preview branches keep the existing `contentReadGen` guard and reset `previewKind` on every file (Task 3 sets it at the top of `renderContent` and in `resetEditState`).
4. **Editing a previewed file.** Save updates `contentText` and re-renders; cancel restores without inventing content; a conflict stays in edit mode and shows the existing error. Task 3 pins the save/cancel round trip; Task 7 pins the drawio save conflict.
5. **Pathological files.** Paginated/truncated files and line-anchored links go to the source view. mermaid render failure degrades. Task 4 pins failure degradation.

---

### Task 0: Register the design and plan docs

**Files:**
- Create: `docs/superpowers/specs/2026-11-12-file-viewers-design.md`
- Create: `docs/superpowers/plans/2026-11-12-file-viewers.md`
- Modify: `tests/gates/repo-inventory.js` (`ROOT_FILES`)

**Interfaces:** Produces a clean `npm run check` baseline; no runtime surface.

- [ ] **Step 1: Copy the approved design** into `docs/superpowers/specs/2026-11-12-file-viewers-design.md` (the text approved in conversation; it must keep §4.1–§4.6 and §6–§9).
- [ ] **Step 2: Copy this plan** into `docs/superpowers/plans/2026-11-12-file-viewers.md`.
- [ ] **Step 3: Register both in `ROOT_FILES`:**

```js
['docs/superpowers/plans/2026-11-12-file-viewers.md', 'Documentation'],
['docs/superpowers/specs/2026-11-12-file-viewers-design.md', 'Documentation'],
```

- [ ] **Step 4: Run the gate:** `node tests/gates/repo-inventory.js` → `repository inventory OK`.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers tests/gates/repo-inventory.js
git commit -m "docs(file-viewers): approved design and implementation plan"
```

---

### Task 1: Message timestamp in the action bar

**Files:**
- Modify: `app/public/js/logic/message-time.js` (add `formatActionBarTs`)
- Modify: `app/public/js/logic.js` (re-export)
- Create: `app/public/js/app/message-actions.js`
- Modify: `app/public/js/app.js` (~2908, ~2932, ~3189, ~6342, ~6853)
- Modify: `app/public/css/app.css` (after `.msg-action-bar`, ~576)
- Modify: `app/public/js/i18n.js`
- Test: `tests/unit/logic-message-time.test.mjs` (extend), `tests/unit/frontend-message-actions.test.mjs` (new)

**Interfaces:**
- Consumes from `logic/message-time.js`: `normalizeMessageTs`, `formatCalendarDayLabel`, `formatClockHm`, `pad2` (module-local).
- Produces: `formatActionBarTs(ts, { now = Date.now() } = {}) => string`. `'MM-DD HH:mm'` in the same local year as `now`, `'YYYY-MM-DD HH:mm'` otherwise, `''` for invalid input.
- Produces: `createMessageActions(context, deps)` returning `{ appendCopyAction(container, getText, align, anchorUuid, ts) }`; `ts` is raw (epoch ms / ISO / Date / null).

- [ ] **Step 1: Write the failing formatter test** — append to `tests/unit/logic-message-time.test.mjs`:

```js
test('formatActionBarTs：同年省略年份，跨年带年份，非法时间空串', () => {
  const now = at(2026, 11, 12, 12, 0);
  assert.equal(formatActionBarTs(at(2026, 11, 12, 9, 5), { now }), '11-12 09:05');
  assert.equal(formatActionBarTs(at(2025, 12, 31, 23, 59), { now }), '2025-12-31 23:59');
  for (const bad of [null, 'not-a-date', 0, -1, NaN, {}]) assert.equal(formatActionBarTs(bad, { now }), '');
});
```

Add `formatActionBarTs` to the import list at the top of that file.

- [ ] **Step 2: Run it, watch it fail:** `node --import ./tests/setup/preload-env.mjs --test tests/unit/logic-message-time.test.mjs` → FAIL.

- [ ] **Step 3: Implement in `logic/message-time.js`** (after `formatMessageTimeMarker`), and re-export from `logic.js`:

```js
// 操作栏末尾的紧凑时间戳。完整值进 title（手机没有 hover），这里只保证一行放得下。
export function formatActionBarTs(ts, { now = Date.now() } = {}) {
  const ms = normalizeMessageTs(ts);
  if (ms == null) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const ymd = `${sameYear ? '' : `${d.getFullYear()}-`}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${ymd} ${formatClockHm(ms)}`;
}
```

- [ ] **Step 4: Write the failing DOM test** — `tests/unit/frontend-message-actions.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageActions } from '../../app/public/js/app/message-actions.js';

const el = html => ({ html, className: '', textContent: '', title: '', children: [],
  appendChild(c) { this.children.push(c); return c; } });

test('appendCopyAction：给了 ts 就出时间戳，没给就不出，title 是完整日期', () => {
  const made = [];
  const ctx = { dom: {}, dependencies: { document: { createElement: () => { const n = el(''); made.push(n); return n; } } } };
  const actions = createMessageActions(ctx, {
    el, t: s => s, copyText: async () => true, addBar: () => {}, haptic: () => {},
    now: () => new Date(2026, 10, 12, 12, 0).getTime(),
  });
  const bar = el('');
  actions.appendCopyAction(bar, () => 'text', 'left', null, new Date(2026, 10, 12, 9, 5).getTime());
  const stamp = bar.children.find(c => c.className === 'msg-action-ts');
  assert.ok(stamp, '有 ts 时没有时间戳节点');
  assert.equal(stamp.textContent, '11-12 09:05');
  assert.equal(stamp.title, '11月12日 09:05');

  const bar2 = el('');
  actions.appendCopyAction(bar2, () => 'text', 'left', null, undefined);
  assert.equal(bar2.children.some(c => c.className === 'msg-action-ts'), false, '没有 ts 却挂了时间戳');
});
```

Fixed assertions: compact text is exactly `11-12 09:05`; `title` is exactly `11月12日 09:05`. Build `ts` with local-time construction (`new Date(2026, 10, 12, 9, 5).getTime()`), never a UTC ISO literal, or the assertion becomes timezone-dependent.

- [ ] **Step 5: Run it, watch it fail:** same command → FAIL (`Cannot find module`).

- [ ] **Step 6: Create `app/public/js/app/message-actions.js`.** Move `appendCopyAction`, `speakIdleHtml`, `resetSpeakBtn`, `wireCopyFeedback` out of `app.js` **verbatim**, changing only:

```js
export function createMessageActions(context, {
  el, haptic = () => {}, t = s => s, copyText = async () => false, addBar = () => {},
  getInputEl = () => null, requestSessionFork = () => {},
  getActiveSpeechBtn = () => null, setActiveSpeechBtn = () => {},
  scrollBottom = () => {}, now = () => Date.now(),
} = {}) {
  // ... existing bodies, with inputEl -> getInputEl(), activeSpeechBtn -> get/setActiveSpeechBtn()
  function appendStamp(row, raw) {
    const text = formatActionBarTs(raw, { now: now() });
    if (!text) return;
    const ms = normalizeMessageTs(raw);
    const stamp = el(`<span class="msg-action-ts" data-testid="msg-action-ts"></span>`);
    stamp.textContent = text;
    stamp.title = `${formatCalendarDayLabel(ms, now())} ${formatClockHm(ms)}`; // 完整日期+时分
    stamp.setAttribute('aria-label', stamp.title);
    row.appendChild(stamp);
  }
  // appendCopyAction(..., ts) calls appendStamp(bar|row, ts) as its last act, both alignments.
  return { appendCopyAction };
}
```

In `app.js`, replace the four helpers with `const { appendCopyAction } = createMessageActions(appContext, { el, haptic, t, copyText, addBar, getInputEl: () => inputEl, requestSessionFork, scrollBottom, getActiveSpeechBtn: () => activeSpeechBtn, setActiveSpeechBtn: v => { activeSpeechBtn = v; } });` (place it next to `messageRenderer`; the existing `activeSpeechBtn` variable stays).

- [ ] **Step 7: Pass `ts` at the five call sites**

- `getStream(id, ts)`: add `ts` to the stream entry (`s = { el: wrap, raw: '', done: false, ts }`).
- `finalizeStreams`: `appendCopyAction(s.el, () => s.raw, 'left', null, s.ts)`.
- `user_message` new bubble: `appendCopyAction(bubble, () => p.text, 'right', null, ev?.ts)`.
- `user_message` matched placeholder: same with `ev?.ts`.
- History: `appendCopyAction(bubble, () => msg.content || '', isUser ? 'right' : 'left', msg.uuid, msg.timestamp)`.

- [ ] **Step 8: Style** — after `.msg-action-bar` in `app.css`:

```css
/* 操作栏末尾的时间戳：10px、ink-faint、不可选中；margin-left:auto 推进栏尾。 */
.msg-action-ts {
  margin-left: auto;
  padding-left: 0.5rem;
  font-size: 10px;
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
}
```

- [ ] **Step 9: Run:** `node --import ./tests/setup/preload-env.mjs --test tests/unit/logic-message-time.test.mjs tests/unit/frontend-message-actions.test.mjs` → PASS.
- [ ] **Step 10: Commit**

```bash
git add app/public/js/app.js app/public/js/app/message-actions.js app/public/js/logic/message-time.js app/public/js/logic.js app/public/css/app.css tests/unit
git commit -m "feat(messages): show the message time in the action bar"
```

---

### Task 2: File list — last-modified column and sorting

**Files:**
- Create: `app/public/js/logic/file-sort.js`
- Modify: `app/public/js/logic.js`, `app/public/js/logic/message-time.js` (`formatBrowseTime`)
- Modify: `app/public/js/app/file-browser.js` (`renderList` ~153, `open()` ~526)
- Modify: `app/public/index.html` (~542), `app/public/js/app.js` (~379, ~704), `app/public/css/app.css`
- Test: `tests/unit/logic-file-sort.test.mjs` (new), `tests/unit/frontend-file-browser.test.mjs` (extend)

**Interfaces:**
- Produces: `sortBrowseEntries(entries, { key = 'name', dir = 'asc' } = {}) => Entry[]`. `key ∈ name|mtime|size`, `dir ∈ asc|desc`. `name` mode returns `entries.slice()` **in server order** (default behaviour unchanged). Other modes put `kind === 'dir'` first, then sort by key (missing/NaN sorted last in `asc`, first in `desc`), tie-break `name.localeCompare` **ascending in both directions** so paging stays monotone. Unknown key/dir → behaves like name mode.
- Produces: `formatBrowseTime(ms, { now }) => '' | '今天 HH:mm' | '昨天' | '3月1日' | '2025年12月31日'` — date granularity, clock only for "today".

- [ ] **Step 1: Write failing sort tests** — `tests/unit/logic-file-sort.test.mjs` (import from `../../app/public/js/logic.js`):

```js
const E = (name, kind, size, mtime) => ({ name, kind, size, mtime });
test('name 模式：原样返回服务端顺序（分页游标语义不变）', () => {
  const input = [E('b', 'file', 9, 100), E('a', 'dir', 0, 300), E('c', 'file', 1, 200)];
  assert.deepEqual(sortBrowseEntries(input, { key: 'name', dir: 'desc' }).map(e => e.name), ['b', 'a', 'c']);
});
test('mtime 模式：目录永远最前，组内按时间，同时间按名字', () => {
  const input = [E('b', 'file', 9, 100), E('a', 'dir', 0, 50), E('c', 'file', 1, 300), E('d', 'file', 2, 300)];
  assert.deepEqual(sortBrowseEntries(input, { key: 'mtime', dir: 'desc' }).map(e => e.name), ['a', 'c', 'd', 'b']);
  assert.deepEqual(sortBrowseEntries(input, { key: 'mtime', dir: 'asc' }).map(e => e.name), ['a', 'b', 'c', 'd']);
});
test('size 模式：目录统一最前，文件按大小', () => {
  const input = [E('big', 'file', 900, 1), E('dir', 'dir', 0, 2), E('small', 'file', 1, 3)];
  assert.deepEqual(sortBrowseEntries(input, { key: 'size', dir: 'desc' }).map(e => e.name), ['dir', 'big', 'small']);
});
test('mtime 缺失：回落名字，不产生 NaN、不丢条目', () => {
  const input = [E('a', 'file', 1, undefined), E('b', 'file', 1, 100)];
  assert.deepEqual(sortBrowseEntries(input, { key: 'mtime', dir: 'desc' }).map(e => e.name), ['b', 'a']);
});
```

Append to `tests/unit/logic-message-time.test.mjs`:

```js
test('formatBrowseTime：今天/昨天/更早，非法值空串', () => {
  const now = at(2026, 11, 12, 12, 0);
  assert.equal(formatBrowseTime(at(2026, 11, 12, 9, 30), { now }), '今天 09:30');
  assert.equal(formatBrowseTime(at(2026, 11, 11, 22, 0), { now }), '昨天');
  assert.equal(formatBrowseTime(at(2026, 3, 1, 0, 0), { now }), '3月1日');
  for (const bad of [NaN, undefined, null, 0]) assert.equal(formatBrowseTime(bad, { now }), '');
});
```

- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.** `file-sort.js` starts with:

```js
// shortcut: 排序只作用于【已加载】条目。点「加载更多」跨页后顺序不是全局最优；
// 要全局排序得改成服务端排序（会改写分页 offset 的语义）。
```

`formatBrowseTime` uses `normalizeMessageTs` + `isSameLocalDay` / `formatCalendarDayLabel` (same module, no second calendar implementation).
- [ ] **Step 4: Run, watch pass.**

- [ ] **Step 5: Write the failing renderer tests** — extend `tests/unit/frontend-file-browser.test.mjs`:

```js
test('name 模式目录不显示时间；mtime 模式两行都显示，且目录在前', () => {
  const { ctl, dom, pending } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 2,
    entries: [{ name: 'zz.js', kind: 'file', size: 10, mtime: 1_700_000_000_000 },
              { name: 'src', kind: 'dir', size: 0, mtime: 1_700_000_100_000 }] });
  const rows = dom.fileBrowseBody.children;
  assert.equal(rows[0].children.length, 2, 'name 模式目录多了时间列');
  dom.fileBrowseSortKey.onchange();   // harness: value 先设成 'mtime'
  const first = dom.fileBrowseBody.children[0];
  assert.equal(first.children[1].textContent, 'src', 'mtime 模式目录没排最前');
  assert.equal(first.children.length, 3, 'mtime 模式目录没有时间列');
  assert.match(first.children[2].textContent, /今天|昨天|\d{4}?年?\d{1,2}月\d{1,2}日/);
});
```

(The harness must set `dom.fileBrowseSortKey.value = 'mtime'` before firing `onchange`; the fixed assertion set is: order folders-first, a third child on both rows, non-empty time text.)
- [ ] **Step 6: Run, watch fail.**
- [ ] **Step 7: Implement controls + renderer.** `index.html` — `#fileBrowseTools` gains `justify-between`; after the edit/save/download group:

```html
<div id="fileBrowseSortGroup" class="hidden items-center gap-1 shrink-0">
  <select id="fileBrowseSortKey" class="text-[11px] rounded-lg border border-line bg-surface text-ink-soft px-1.5 py-1" aria-label="排序方式">
    <option value="name">名称</option><option value="mtime">修改时间</option><option value="size">大小</option>
  </select>
  <button id="fileBrowseSortDir" type="button" class="w-7 h-7 rounded-lg flex items-center justify-center text-ink-soft hover:bg-sunk active:scale-95 text-sm shrink-0" aria-label="升序">↑</button>
</div>
```

`file-browser.js`: `let sortKey = 'name', sortDir = 'asc'`; reset in `open()`. `renderList()` sorts via `sortBrowseEntries(...)`, captures `const now = nowFn()` once, then per entry:

```js
const meta = entry.kind === 'dir'
  ? (sortKey === 'mtime' ? formatBrowseTime(entry.mtime, { now }) : '')
  : [formatFileSize(entry.size), sortKey === 'mtime' ? formatBrowseTime(entry.mtime, { now }) : '']
      .filter(Boolean).join(' · ');
if (meta) { const cell = createElement('<span class="shrink-0 text-[10px] text-ink-faint"></span>'); cell.textContent = meta; row.appendChild(cell); }
```

`syncSortControls()`: group visible only in list mode. `onchange`/`onclick` update state, flip `sortDir` and set the button text/`aria-label` to `↑ 升序` / `↓ 降序`, then `renderList()`.
- [ ] **Step 8: Wire refs** in `app.js`: `fileBrowseSortGroup`, `fileBrowseSortKey`, `fileBrowseSortDir` into the `$` block (~379) and the `dom` payload (~704).
- [ ] **Step 9: Run** `node --import ./tests/setup/preload-env.mjs --test tests/unit/frontend-file-browser.test.mjs tests/unit/logic-file-sort.test.mjs` → PASS.
- [ ] **Step 10: Commit**

```bash
git add app/public/js/logic app/public/js/app/file-browser.js app/public/index.html app/public/js/app.js app/public/css/app.css tests/unit
git commit -m "feat(files): last-modified column and sorting"
```

---

### Task 3: HTML preview

**Files:** Modify `app/public/js/app/file-browser.js`, `app/public/js/app.js` (inject `nowFn` if not already, and `sanitizeHtml` in Task 4), `app/public/js/i18n.js`; test `tests/unit/frontend-file-browser.test.mjs`.

**Interfaces:**
- Produces: `previewKind` state and `previewableKind(name) => 'markdown'|'html'|null` (md/markdown/mdx → markdown; html/htm → html).
- Produces: `renderPreview()` dispatch; `renderHtmlPreview()`; `renderSourceFallback(reason)`.
- Consumes: the existing markdown branch (already in the worktree's uncommitted diff — **keep it**).

- [ ] **Step 1: Write the failing test:**

```js
test('index.html 走 iframe 预览：sandbox 空值，正文不进父页 DOM', () => {
  const { ctl, dom, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 1,
    entries: [{ name: 'index.html', kind: 'file', size: 26, mtime: 1 }] });
  rowNamed('index.html').onclick();
  pending('browse:read')[0].ack({ ok: true, content: '<script>alert(1)</script>', bytesRead: 26, truncated: false, totalSize: 26, contentHash: 'h' });
  const frame = dom.fileBrowseBody.children.at(-1);
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.getAttribute('sandbox'), '');
  assert.equal(frame.srcdoc, '<script>alert(1)</script>');
  assert.equal(dom.fileBrowseBody.innerHTML.includes('<script>'), false, '文件内容被写进了父页 DOM');
});

test('截断/分页/带行号的 .html 走源码，不出 iframe', () => {
  // 同夹具，ack 带 truncated:true → 断言 fileBrowseBody.children.at(-1).tagName !== 'IFRAME'
});

test('预览 A 之后切到 B：previewKind 复位，B 不被 A 的预览器接住', async () => {
  const { ctl, dom, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, truncated: false, totalCount: 2, entries: [
    { name: 'a.html', kind: 'file', size: 4, mtime: 1 }, { name: 'b.js', kind: 'file', size: 3, mtime: 2 },
  ] });
  rowNamed('a.html').onclick();
  pending('browse:read')[0].ack({ ok: true, content: '<h1>a</h1>', bytesRead: 12, truncated: false, totalSize: 12, contentHash: 'h' });
  assert.equal(dom.fileBrowseBody.children.at(-1).tagName, 'IFRAME');
  await ctl.back();
  rowNamed('b.js').onclick();
  pending('browse:read')[1].ack({ ok: true, content: 'x=1\n', bytesRead: 4, truncated: false, totalSize: 4, contentHash: 'h2' });
  await new Promise(setImmediate);
  assert.equal(dom.fileBrowseBody.querySelector('iframe'), null, '切到 .js 后仍挂着上一个文件的 HTML 预览');
});
```

- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** — in `renderContent`, replace the markdown-only branch with:

```js
const kind = previewableKind(fileName);
if (kind && !targetLine && !usedPagination && !truncated
    && (kind !== 'markdown' || typeof renderMarkdown === 'function')) {
  previewKind = kind;
  editOnDemand = Boolean(baseHash) && typeof CodeMirror !== 'undefined';
  renderPreview();
  syncEditButtons();
  return;
}
```

`renderPreview()` → `previewKind === 'markdown' ? renderMarkdownPreview() : renderHtmlPreview()`. Replace the two `if (markdownPreview) renderMarkdownPreview(); else …` sites in `exitEditMode` / `saveEdit` with `if (previewKind) renderPreview(); else …`. Set `previewKind = null` at the top of `renderContent` and in `resetEditState`.

`renderHtmlPreview()`:

```js
function renderHtmlPreview() {
  dom.fileBrowseBody.innerHTML = '';
  cmInstance = null;
  const notice = documentRef.createElement('div');
  notice.className = 'px-4 py-1.5 text-[10px] text-ink-faint border-b border-line-soft';
  notice.textContent = t('预览已禁用脚本与外链图片；要改就点「编辑」');
  const frame = documentRef.createElement('iframe');
  frame.className = 'w-full h-full border-0 bg-white';
  frame.setAttribute('sandbox', '');        // 刻意不给 allow-scripts / allow-same-origin
  frame.setAttribute('data-testid', 'file-preview-html');
  frame.srcdoc = contentText;
  dom.fileBrowseBody.append(notice, frame);
}
```

`renderSourceFallback(reason)` renders a `<div data-testid="file-preview-fallback">` with `reason`, then the same `<pre>` the non-preview path uses. (Task 4/5 reuse it.)

- [ ] **Step 4: Extend the harness** (`fakeEl`): `tagName`, `attrs` Map, `setAttribute`/`getAttribute`, `append(...nodes)`, and `innerHTML` must serialise children so the "file content in parent DOM" assertion is meaningful.
- [ ] **Step 5: i18n key** `'预览已禁用脚本与外链图片；要改就点「编辑」'`.
- [ ] **Step 6: Run → PASS; commit**

```bash
git add app/public/js/app/file-browser.js app/public/js/i18n.js tests/unit/frontend-file-browser.test.mjs
git commit -m "feat(files): sandboxed HTML preview"
```

---

### Task 4: Mermaid preview

**Files:** Create `app/public/vendor/mermaid.min.js`; modify `THIRD-PARTY-NOTICES.md`, `file-browser.js`, `app.js` (inject `sanitizeHtml`), `i18n.js`; test `frontend-file-browser.test.mjs`.

**Interfaces:**
- Produces: `previewableKind` adds `'mermaid'` (`.mmd`, `.mermaid`); `loadMermaid()` singleton (returns `window.mermaid` or `null`); `renderMermaidPreview()` async.
- Consumes: `sanitizeHtml` injected from `app.js` (`html => DOMPurify.sanitize(html, { FORBID_TAGS: ['script'], FORBID_ATTR: ['onerror','onload'] })`). If not injected → fall back to source (fail closed).

- [ ] **Step 1: Vendor**

```bash
curl -sL https://registry.npmjs.org/mermaid/-/mermaid-11.12.0.tgz -o /tmp/mermaid-11.12.0.tgz
tar -xzf /tmp/mermaid-11.12.0.tgz -C /tmp package/dist/mermaid.min.js
cp /tmp/package/dist/mermaid.min.js app/public/vendor/mermaid.min.js
sha256sum app/public/vendor/mermaid.min.js   # 期望 07e37dfa97b337ccc85365d57eddf99b9706f09db3b59b260d0333b23b343c4b
```

- [ ] **Step 2: Notices entry** (exact block):

```md
## mermaid — `mermaid.min.js`

- 版本 / Version: 11.12.0 · 许可 / License: MIT
- 版权 / Copyright: © 2014–2025 Knut Sveidqvist and contributors
- 来源 / Source: https://github.com/mermaid-js/mermaid（npm 包 `mermaid@11.12.0` 的 `dist/mermaid.min.js`）
- 说明 / Notes: 仅在打开 `.mmd` / `.mermaid` 时按需加载；`securityLevel: 'strict'`，输出再经 DOMPurify。
```

- [ ] **Step 3: Failing test** (stub `globalThis.mermaid` with `initialize` + `render`; assert an SVG child on success and `[data-testid="file-preview-fallback"]` when `render` rejects with `BOOM`).
- [ ] **Step 4: Implement** `loadMermaid()` mirroring `loadCodeMirror()` (version stamp from `import.meta.url`, `onerror` clears the singleton). `renderMermaidPreview()`:

```js
const mermaid = await loadMermaid();
if (!mermaid || mode !== 'content' || previewKind !== 'mermaid') return;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict',
  theme: documentRef.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'default' });
try {
  const { svg } = await mermaid.render(`ccm-mermaid-${++mermaidSeq}`, contentText);
  if (mode !== 'content' || previewKind !== 'mermaid') return;   // 渲染在途时用户切走了
  const holder = documentRef.createElement('div');
  holder.className = 'p-4 overflow-auto';
  holder.innerHTML = sanitizeHtml(svg);   // 未注入 sanitizeHtml → renderSourceFallback
  dom.fileBrowseBody.innerHTML = ''; cmInstance = null;
  dom.fileBrowseBody.appendChild(holder);
} catch (err) {
  renderSourceFallback(`${t('渲染失败，已显示源码')}：${String(err?.message || err).slice(0, 80)}`);
}
```

- [ ] **Step 5: Harness `querySelector`/`querySelectorAll`** for `data-testid` walking; add i18n key `'渲染失败，已显示源码'`.
- [ ] **Step 6: Run → PASS; commit**

```bash
git add app/public/vendor/mermaid.min.js app/public/vendor/THIRD-PARTY-NOTICES.md app/public/js/app/file-browser.js app/public/js/app.js app/public/js/i18n.js tests/unit
git commit -m "feat(files): mermaid preview"
```

---

### Task 5: draw.io read-only preview

**Files:** Create `app/public/vendor/drawio/viewer-static.min.js`; modify notices, `file-browser.js`; test `frontend-file-browser.test.mjs`.

**Interfaces:**
- Produces: `previewableKind` adds `'drawio'` (`.drawio`, `.dio`); `loadDrawioViewer()`; `renderDrawioPreview()`; `drawioEmbedJson(xml)` (exported, pure) → `encodeURIComponent(JSON.stringify({ xml, toolbar: '', nav: false, resize: true }))`; the holder is `<div class="mxgraph" data-mxgraph="<encoded>" data-testid="file-preview-drawio">`.

- [ ] **Step 1: Vendor**

```bash
mkdir -p app/public/vendor/drawio
curl -sL https://raw.githubusercontent.com/jgraph/drawio/v32.6.10/src/main/webapp/js/viewer-static.min.js \
  -o app/public/vendor/drawio/viewer-static.min.js
sha256sum app/public/vendor/drawio/viewer-static.min.js   # 期望 dfa1cfb4ef24320b67131405da88511e7baba48621ddd5260eea8ec5f6425928
```

- [ ] **Step 2: Notices entry** — version v32.6.10 (release tag, not `dev`), Apache-2.0, source = GitHub release `draw.war`; note `drawio/editor/` is separable and deletable.
- [ ] **Step 3: Failing test** — stub `globalThis.GraphViewer.processElements` to throw; assert `data-mxgraph` decodes to `{xml, toolbar:'', nav:false, resize:true}` **and** that a `[data-testid="file-preview-fallback"]` appears after the thrown render.
- [ ] **Step 4: Implement** — load script, build holder, `try { GraphViewer.processElements() } catch { renderSourceFallback(...) }`; also guard `mode/previewKind` after the await.
- [ ] **Step 5: Run → PASS; commit**

```bash
git add app/public/vendor/drawio/viewer-static.min.js app/public/vendor/THIRD-PARTY-NOTICES.md app/public/js/app/file-browser.js tests/unit
git commit -m "feat(files): draw.io read-only preview"
```

---

### Task 6: draw.io editor — vendor files, route, and CSP

**Files:**
- Create: `app/public/vendor/drawio/editor/` (from `draw.war`; shape below)
- Modify: `app/src/server/http.js` (`configureHttpShell`)
- Test: `tests/unit/server-http.test.mjs`

**Interfaces:**
- Produces: the whole `app/public/vendor/drawio/editor/` tree is served at **`/drawio-editor/`** (trailing slash matters: drawio derives `DRAWIO_SERVER_URL` from the page directory).
- Produces: CSP for that prefix only: same directives as the global policy except `script-src 'self' 'unsafe-eval'`; `style-src 'self' 'unsafe-inline'`; `frame-src 'self'`; `X-Frame-Options: SAMEORIGIN` (the page is framed by CCM itself, unlike the global `DENY`).
- Produces: `Access-Control-Allow-Origin: *` on `/drawio-editor/` only (the sandboxed iframe is an opaque origin, so its XHR needs CORS).
- Consumes: `setSecurityHeaders` — refactor its directive list into a helper so the editor list cannot drift.

- [ ] **Step 1: Copy the editor tree** (run from `/tmp/drawio-spike` after `unzip -q draw.war -d war`):

```bash
# 在 worktree 根执行；war 是解包后的 draw.war
cd /home/ubuntu/ccm-file-viewers
ED=app/public/vendor/drawio/editor
mkdir -p "$ED"/{js,styles,mxgraph/css,resources}
cp /tmp/drawio-spike/war/index.html "$ED/index.html"
cp /tmp/drawio-spike/war/js/bootstrap.js /tmp/drawio-spike/war/js/main.js /tmp/drawio-spike/war/js/PreConfig.js \
   /tmp/drawio-spike/war/js/PostConfig.js /tmp/drawio-spike/war/js/app.min.js "$ED/js/"
cp /tmp/drawio-spike/war/js/shapes-14-6-5.min.js /tmp/drawio-spike/war/js/stencils.min.js \
   /tmp/drawio-spike/war/js/extensions.min.js "$ED/js/"
cp -r /tmp/drawio-spike/war/js/{spin,deflate,sanitizer,jquery} "$ED/js/"
cp /tmp/drawio-spike/war/styles/grapheditor.css "$ED/styles/"
cp /tmp/drawio-spike/war/mxgraph/css/common.css "$ED/mxgraph/css/"
cp /tmp/drawio-spike/war/resources/dia.txt "$ED/resources/"
```

**Do not copy** `js/mermaid`, `js/plantuml`, `js/elk`, `img/`, `images/`, `math4/`, `templates/` yet. Task 8 adds only the files that really 404 in a browser.

Then edit `$ED/index.html`: remove the external `canonical`/`manifest`/`apple-touch-icon` links, the slim `geSplash` block stays, and add `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">` (already present). Keep `<script src="js/bootstrap.js">`; `js/main.js` is loaded by `bootstrap.js` itself — keep it on disk.

- [ ] **Step 2: Failing CSP test** — add to `tests/unit/server-http.test.mjs`, using the file's existing server-boot helper:

```js
test('drawio 编辑器：只有它有 unsafe-eval，主页面永无；CORS 只给它', async () => {
  const main = await get('/', {});
  assert.doesNotMatch(main.headers['content-security-policy'], /unsafe-eval/);
  const editor = await get('/drawio-editor/');
  assert.match(editor.headers['content-security-policy'], /script-src 'self' 'unsafe-eval'/);
  assert.doesNotMatch(editor.headers['content-security-policy'], /unsafe-inline/); // 实测不需要
  assert.equal(editor.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(editor.headers['access-control-allow-origin'], '*');
  const appJs = await get('/js/app.js');
  assert.equal(appJs.headers['access-control-allow-origin'], undefined, 'CORS 溢出了编辑器前缀');
});
```

- [ ] **Step 3: Run, watch fail.**
- [ ] **Step 4: Implement** in `configureHttpShell`:

```js
const cspDirectives = (host, { editor = false } = {}) => [
  "default-src 'self'",
  `script-src 'self'${editor ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self'${sameOriginWs(host)}`,
  "font-src 'self' data:",
  "frame-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
];
```

`setSecurityHeaders` becomes `res.setHeader('Content-Security-Policy', cspDirectives(hostHeader).join('; '))`. Then, **after** the global header middleware and **before** `express.static`:

```js
// drawio 编辑器：唯一放宽 eval 的前缀。只服务这个独立页面，主页面策略不受影响。
// 页面挂在 /drawio-editor/（带尾斜杠）：drawio 用文档目录推 DRAWIO_SERVER_URL，少了斜杠会去请求 /js/app.min.js。
app.use('/drawio-editor', (req, res, next) => {
  res.setHeader('Content-Security-Policy', cspDirectives(req.headers?.host, { editor: true }).join('; '));
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Access-Control-Allow-Origin', '*'); // sandbox iframe 是 opaque origin，XHR 要 CORS
  res.setHeader('Cache-Control', 'no-cache');
  next();
}, express.static(join(publicDir, 'vendor', 'drawio', 'editor')));
```

- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit**

```bash
git add app/public/vendor/drawio/editor app/src/server/http.js tests/unit/server-http.test.mjs
git commit -m "feat(drawio): vendor editor behind its own CSP route"
```

---

### Task 7: draw.io editor bridge

**Files:** Create `app/public/js/app/drawio-editor.js`; modify `file-browser.js`, `app.js` (inject the bridge + `widthCheck`), `i18n.js`; test `tests/unit/frontend-drawio-editor.test.mjs`.

**Interfaces:**
- Produces: `createDrawioEditorBridge({ el, documentRef, socket, haptic, onSaved, onExit, widthCheck = () => true, addBar })` → `{ open({ xml, name, baseHash, cwd, relPath }), close(), _handle(messageEvent) }`（`messageEvent` 是 DOM `message` 事件，测试直接喂 `{data, source}` 形状）。
- Protocol: `configure → {action:'configure', config:{}}`; `init → {action:'load', xml, title, autosave:0, saveAndExit:1}`; `save → onSaved(xml)`; `exit → onExit()`. Any other event is ignored. **`source !== frame.contentWindow` → ignore.** Parse failures → ignore.
- Save path: `files:write` with the open-time `baseHash`; on `ok` call `onSaved(xml, response.contentHash)`; on failure keep the editor open and `addBar(error)`.

- [ ] **Step 1: Failing tests** (three cases, exact assertions):
  1. `configure` → last post is `{action:'configure', config:{}}`.
  2. `init` → last post is `{action:'load', xml:'<mxfile/>', title:'a.drawio', autosave:0, saveAndExit:1}`.
  3. `save` → the `files:write` emit payload is `{relPath:'d.drawio', content:'<mxfile><d/></mxfile>', baseHash:'h'}`; ack `{ok:false,error:'文件已被修改'}` → editor stays open and `addBar` got that text; ack `{ok:true,contentHash:'h2'}` → `onSaved` got `(xml,'h2')` and `close()` ran.
  4. a `message` from a **different** `source` never triggers a post.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.** `open()` appends the iframe:

```js
const frame = documentRef.createElement('iframe');
frame.title = 'draw.io 编辑器';
frame.className = 'w-full h-full border-0 bg-white';
frame.setAttribute('sandbox', 'allow-scripts');            // 没有 allow-same-origin → 读不到 CCM 的 localStorage
frame.src = '/drawio-editor/?embed=1&proto=json&configure=1&pwa=1';
```

Listener is `documentRef.defaultView.addEventListener('message', handle)` (or `window` when a real doc); `_handle` is exported on the returned object for unit tests. `close()` removes the listener and the frame.
- [ ] **Step 4: Wire into `enterEditMode()`:**

```js
if (previewKind === 'drawio' && drawioEditor) {
  if (!drawioEditor.widthCheck()) { showPanelMessage(dom.fileBrowseBody, t('这个编辑器需要更宽的屏幕；横屏后再试，或点「编辑」改源码'), 'text-ink-faint'); return; }
  haptic('tap');
  hideSaveError();
  drawioEditor.open({ xml: contentText, name: fileName, baseHash, cwd, relPath: segments.concat(fileName).join('/') });
  return;   // 不挂 CodeMirror
}
```

`onSaved`: `contentText = xml; baseHash = hash; editMode = 'view'; renderPreview(); syncEditButtons();`
`onExit`: `showSaveError(t('已放弃未保存的修改'))` (info tone) and `renderPreview()`.
`app.js` injects `drawioEditor: createDrawioEditorBridge({... , widthCheck: () => window.matchMedia('(min-width: 768px)').matches, onSaved, onExit })` — the two callbacks are defined inside `createFileBrowser`'s call site? **No**: inject via callbacks the file browser passes back:

```js
// in app.js
drawioEditor: createDrawioEditorBridge({ el, documentRef: document, socket, haptic, addBar,
  widthCheck: () => window.matchMedia('(min-width: 768px)').matches,
  onSaved: (xml, hash) => fileBrowser.applyDrawioSave(xml, hash),
  onExit: () => fileBrowser.applyDrawioExit(),
})
```

and `createFileBrowser` returns `applyDrawioSave`, `applyDrawioExit` (both just set state + re-render).

- [ ] **Step 5: i18n keys** `'这个编辑器需要更宽的屏幕；横屏后再试，或点「编辑」改源码'`, `'已放弃未保存的修改'`.
- [ ] **Step 6: Run** `node --import ./tests/setup/preload-env.mjs --test tests/unit/frontend-drawio-editor.test.mjs tests/unit/frontend-file-browser.test.mjs` → PASS.
- [ ] **Step 7: Commit**

```bash
git add app/public/js/app/drawio-editor.js app/public/js/app/file-browser.js app/public/js/app.js app/public/js/i18n.js tests/unit
git commit -m "feat(drawio): inline editor bridge with save via files:write"
```

---

### Task 8: E2E proof and the vendor trim

**Files:** Modify `tests/e2e/mock/server.js`, `tests/e2e/specs/file-browser.spec.ts`, `app/public/vendor/drawio/editor/` (add only the 404s).

- [ ] **Step 1: Fixtures** in the mock demo workdir: `report.html` (`<h1>REPORT</h1>`), `flow.mmd` (`graph TD; A-->B`), `diagram.drawio` (two-node mxfile).
- [ ] **Step 2: Spec** (one test, four assertions fixed): html → iframe visible and `sandbox` not matching `allow-scripts`; mermaid → `#fileBrowseBody svg` visible; drawio → `[data-testid="file-preview-drawio"] svg` visible; after `setViewportSize({width:390,height:844})` and clicking `#fileBrowseEdit`, the wide-screen notice is visible and `iframe[title="draw.io 编辑器"]` has count 0.
- [ ] **Step 3: Run** `NO_PROXY=127.0.0.1,localhost npm run test:e2e -- tests/e2e/specs/file-browser.spec.ts`. Collect every 404 from the trace, copy the exact file from `/tmp/drawio-spike/war` (preserving its relative path inside `vendor/drawio/editor/`), rerun. Repeat until no 404s. **This is the only place files are added beyond Step 1 of Task 6.**
- [ ] **Step 4: Desktop editor smoke** (same spec, second test): at 1280×800 open `diagram.drawio` → `编辑` → editor iframe appears → click `Save` inside it → preview re-renders. (Playwright can reach the iframe because it is same-origin; the sandbox only removes same-origin *document access*, not frame navigation.)
- [ ] **Step 5: FILE-04 untouched**

```bash
npm run docker:build
npm run test:docker:file -- tests/invariants/server/file-ticket-route.test.mjs
```

Expected PASS — html/svg still `application/octet-stream` + `attachment`.
- [ ] **Step 6: Commit**

```bash
git add tests/e2e app/public/vendor/drawio/editor
git commit -m "test(e2e): previews, narrow-screen editor guard, FILE-04 intact"
```

---

### Task 9: Full gates

- [ ] **Step 1:** `npm run lint && npm run check && npm run test:unit && npm run test:invariants`
- [ ] **Step 2:** `NO_PROXY=127.0.0.1,localhost npm run test:e2e`
- [ ] **Step 3 (worktree rule — do not run combined `test:docker`):** `npm run test:docker:invariants && npm run test:docker:integration`
- [ ] **Step 4:** Update the design doc §4.5 vendor list from `du -sh`, commit, push, open the PR with `--base dev`.
- [ ] **Step 5:** Report which files were added in Task 8 and the final vendor size in the PR body.

---

## Self-review notes

- **Do not invent a second calendar formatter.** `formatBrowseTime` and `formatActionBarTs` both live in `logic/message-time.js` and reuse `isSameLocalDay` / `formatCalendarDayLabel`.
- **The drawio label risk is accepted, not mitigated.** Do not sanitize the viewer's SVG output (`html=1` labels are legitimate). The editor is contained by the opaque-origin sandbox + route-scoped CSP; Task 6's test pins that the main page never gains `unsafe-eval`.
- **`vendor/drawio/editor/` is deletable whole.** No other task imports from it; deleting it only removes the inline editor (the viewer keeps working).
- **Keep the worktree's existing markdown-preview diff.** It is the `markdown` half of `previewKind`; the plan assumes it is present and only generalizes it.
