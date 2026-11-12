# 设计：消息时间戳、文件修改时间与排序、HTML/Mermaid/draw.io 预览与编辑

日期：2026-11-12 · 分支：`feat/file-viewers`（基于 `dev`）

## 1. 意图

1. 每条 assistant 消息末尾知道它是什么时候发的。
2. 文件浏览器能看出目录/文件的新旧。
3. 文件列表可按名称 / 修改时间 / 大小排序，可升降序。
4. `.html` / `.mmd` / `.drawio` 能直接看渲染结果，而不是源码。
5. 小改一行不必向 agent 描述：`.html` / `.mmd` / `.drawio` 都能编辑并保存。

成功的标准：五件事都能在手机窄屏上使用，且没有一处渲染出破碎的 UI。

## 2. 现状（已核实）

- `message-timeline.js` 给气泡打 `data-ts`，但 `appendCopyAction` 拿不到时间戳。
- 服务端 `listDir` 已返回 `mtime`（`app/src/files/file-browse.js`），前端是死字段。
- `#fileBrowseTools` 目前只有返回/路径/编辑/保存/下载。
- markdown 预览已在工作区未提交改动里（`renderContent` 的 `markdownPreview` 分支）。
- 全局 CSP 很紧（`app/src/server/http.js`）：`script-src 'self'`、`frame-ancestors 'none'`。
- `app/public/vendor/` 没有 mermaid / drawio；`THIRD-PARTY-NOTICES.md` 被 About 页逐字节读取。
- FILE-04：`.html` / `.svg` 只能下载，绝不从 CCM 的源内联。

## 3. 可行性实测（真 Chromium）

| 项 | 结论 |
|---|---|
| mermaid 11.12 在 `script-src 'self'` 下渲染 | 可以，bundle 内零 `eval` / `new Function` |
| HTML 走 `<iframe sandbox srcdoc>` | 可以；脚本被拦、父页不可达、内联样式生效 |
| HTML 作为 `<img>` | 不行，图片解码器不接受 HTML |
| draw.io viewer（4.9MB / 1.1MB gzip） | 可以，`.mxgraph` + `data-mxgraph` 渲染 SVG，压缩态 `.drawio` 可读，390px 宽不破版 |
| draw.io 编辑器（app.min.js 10.8MB + shapes/stencils/extensions） | 可以离线加载；`?embed=1&proto=json` 实测 `configure → init → load → save/export` 全通 |
| 编辑器放 `sandbox="allow-scripts"`（opaque origin） | 可以；需要该路由 `Access-Control-Allow-Origin` |
| 编辑器 CSP 需要放宽什么 | 只需 `unsafe-eval`，**不需要** `unsafe-inline` |

## 4. 设计

### 4.1 消息时间戳

- 复用 `normalizeMessageTs` / `formatCalendarDayLabel` / `formatClockHm`。
- `appendCopyAction(container, getText, align, anchorUuid, ts)`：`ts` 由五个调用点传入（流式取 `ev.ts`、历史取 `msg.timestamp`、用户气泡取 `ev.ts`）。
- 紧凑显示 `MM-DD HH:mm`（跨年 `YYYY-MM-DD HH:mm`），完整值进 `title` + `aria-label`；无有效 `ts` 不渲染。
- 不新开时间分隔行：分隔行是稀疏事件，每消息时间是属性。

### 4.2 文件列表：修改时间 + 排序

| 排序模式 | 显示列 | 顺序 |
|---|---|---|
| 名称（默认） | 文件显示大小；目录不显示 | 服务端字典序（现状不变） |
| 修改时间 | 都显示时间 | 目录在前，按 mtime |
| 大小 | 文件显示大小；目录显示 `—` | 目录在前，文件按 size |

- 排序是纯前端（`logic/file-sort.js`），服务端 `listDir` 与分页游标不动。
- `shortcut:` 排序只作用于已加载条目；跨页不保证全局最优。
- 时间文案与消息时间同源：`formatBrowseTime(ms, { now })`，日期粒度（今天带时分）。

### 4.3 HTML 预览

- `<iframe sandbox srcdoc>`，**sandbox 留空**（无 `allow-scripts`、无 `allow-same-origin`）。
- 文件正文只进 `srcdoc`，绝不进父页 `innerHTML`。
- 分页/截断/带行号 → 源码视图。
- 顶部一行说明：脚本与外链图片被禁用。

### 4.4 Mermaid 预览

- vendor `mermaid.min.js` 11.12.0（MIT），按需加载。
- `securityLevel: 'strict'`，输出再经 DOMPurify（注入的 `sanitizeHtml`）；未注入时回源码（fail closed）。
- 主题跟随 `data-theme`；渲染失败 → 源码 + 一行原因。
- 不做 markdown 内 ` ```mermaid ` 代码块（会动消息净化配置，明确非目标）。

### 4.5 draw.io 预览与编辑器

**预览**：vendor `viewer-static.min.js`（v32.6.10，Apache-2.0），`<div class="mxgraph" data-mxgraph>` + `GraphViewer.processElements()`。这是 drawio 的公开嵌入协议。

**编辑器**：
- vendor 完整 webapp 到 `app/public/vendor/drawio/editor/`，**在 `/drawio-editor/` 路由下提供**（带尾斜杠，drawio 用文档目录推导 `DRAWIO_SERVER_URL`）。
- 该路由单独设 `script-src 'self' 'unsafe-eval'` + `frame-src 'self'` + `X-Frame-Options: SAMEORIGIN`；**主页面 CSP 永不放宽**。
- 该路由加 `Access-Control-Allow-Origin: *`（opaque-origin iframe 的 XHR 需要）。
- iframe `sandbox="allow-scripts"`，**没有 `allow-same-origin`** → 读不到 CCM 的 `auth_token` / `device_token`。
- postMessage 协议：`configure → action:configure`、`init → action:load{xml,title,autosave:0,saveAndExit:1}`、`save → files:write(baseHash)`、`exit → 放弃`。
- 窄屏（`< 768px`）不打开编辑器：给一句「需要更宽的屏幕」+ 保留 CodeMirror XML 编辑退路。
- `vendor/drawio/editor/` 可整目录删除：只失去内联编辑器，预览与其余功能不受影响。

**最终 vendor 体积**（实测）：`mermaid.min.js` 2.7MB · `drawio/viewer-static.min.js` 8.5MB（release war 版）· `drawio/editor/` 21MB；`vendor/` 合计 32MB。编辑器文件清单以真实浏览器 404 为准（Task 8），没有预先塞入 `img/`、`images/`、`math4/`。

**已知风险（接受）**：`.drawio` 的 `html=1` label 可以画任意非脚本 HTML；脚本被主页面 CSP 拦住。不额外净化 viewer 的 SVG 输出——那会破坏正常的 label。编辑器侧由 opaque-origin sandbox + 独立 CSP 路由兜住。

### 4.6 统一状态机

`previewKind ∈ null | 'markdown' | 'html' | 'mermaid' | 'drawio'`；`编辑` 进入 CodeMirror（drawio 宽屏例外），保存/取消回到对应预览；分页/截断/行号一律走源码。

## 5. 接口与契约

| 位置 | 变更 |
|---|---|
| `browse:list` / `browse:read` / `files:write` | 不变（`mtime` 本来就有） |
| `logic/message-time.js` | 新增 `formatActionBarTs`、`formatBrowseTime` |
| `logic/file-sort.js` | 新增 `sortBrowseEntries` |
| `app/public/vendor/` | mermaid、drawio viewer、drawio editor |
| `app/src/server/http.js` | 新增 `/drawio-editor/` 路由（独立 CSP + CORS） |
| `THIRD-PARTY-NOTICES.md` | mermaid（MIT）、drawio（Apache-2.0） |

## 6. 风险

| 风险 | 处置 |
|---|---|
| 恶意 `.drawio` 的 `html=1` label | 脚本被 CSP 拦；**接受「非脚本 HTML 会被画出来」**，登记为已知风险，不额外净化 viewer 输出 |
| mermaid / viewer 加载失败 | 回源码 + 一行说明 |
| 保存冲突 | 留编辑态 + 现有错误文案 |
| 编辑器读到 token | opaque-origin sandbox 阻断（实测） |
| `unsafe-eval` 误伤主页面 | 单路由设置；单测钉住主页面 CSP |
| vendor 体积（约 38MB） | 启动链零增加；按需加载；编辑器目录可整棵删除 |

## 7. 验证

- `tests/unit/logic-*.test.mjs`：时间格式、排序、mtime 缺失。
- `tests/unit/frontend-file-browser.test.mjs`：预览分支、sandbox 属性、切文件复位。
- `tests/unit/frontend-drawio-editor.test.mjs`：协议、来源校验、保存冲突。
- `tests/unit/server-http.test.mjs`：主页面无 `unsafe-eval`；编辑器路由有；CORS 只给该前缀。
- `tests/invariants/server/file-ticket-route.test.mjs`：FILE-04 保持全绿（不动）。
- E2E：三种预览、窄屏编辑器提示、桌面保存回环。

## 8. 明确不做

- markdown 内 mermaid 代码块渲染。
- `.drawio` 的 SVG 导出嵌进 markdown。
- 新建/删除文件。
- 服务端渲染。
