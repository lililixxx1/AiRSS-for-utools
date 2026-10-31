# PLAN-DISCOVER-FAST —— 发现管线提速 + 原始 HTML 边界收口（2026-10-31）

承接 PLAN-FIX-UNREAD-REDISCOVER：该轮修掉了「同页二次抓取」，复核时确认两个残留问题——
① `fetchFeed` 的 `html` 字段经 `airss.feed.fetch` 暴露给渲染层，与「preload 是唯一 HTML 生产方」的
安全基线相悖；② 子路径博客（如 `/blog/`）声明源不可达（feedburner 被墙）时仍要等 8s 探测超时，
且根路径候选对子路径站点必然 404——阮一峰博客首页实测 14.4s 落 `found:false`。

## 改动

### 1. 原始 HTML 只留 preload（安全边界）

- `feed.js` 新增 `fetchFeedPublic(url, cond)`：调 `fetchFeed` 后剥掉 `html` 字段再返回；`fetchFeed`
  内部（含 `discoverFeed`）保持带 html 复用。
- `preload/index.js`：`feed.fetch` 由 `feedSvc.fetchFeed` 改为 `feedSvc.fetchFeedPublic`。
- `src/env.d.ts`：`feed.fetch` 返回类型显式化（不再 `any`），标明无 html。
- 渲染层当前无任何 `airss.feed.fetch` 调用方；本次只收口 API 面，不改行为。

### 2. 发现管线：页面相对候选 + 声明优先窗口 + 有界并发

`feed.js`：

- `pathFeedCandidates(pageUrl)`：`/blog/` → `/blog/feed|rss|atom.xml|feed.xml|index.xml|rss.xml`；
  无尾斜杠且末段无扩展名的 `/blog` 也按目录展开；根路径返回 `[]`（避免与 origin 候选重复）。
- **重定向落地地址参与候选**：`fetchFeed` 对 `NOT_FEED_XML` 额外回传内部 `finalUrl`（nodeFetch 跟随
  重定向后的最终地址）；`discoverFeed` 按落地路径解析 `<link>` 相对 href 并生成页面相对候选
  （裸域 → `/blog/` 这类站点跳到目录页后，仍能找到 `/blog/feed`）。
- `probeFirst(entries, timeout=5s, limit=3)`：按顺序启动、有界并发、首个成功即返回；全失败返回按
  完成顺序的 tried 记录（根路径失败上限从 6×5s=30s 降到约 10s）。
- `discoverFeed` 探测顺序：直连 → `<link>` 声明 → 页面相对 → 站点根。
  - 声明源保留 8s 超时（慢源兼容），但只给 **300ms 优先窗口**：窗口内没有应答且存在页面相对候选
    时并行探测本地候选，任一先成功即返回。
  - 声明源在窗口后才失败 → 立即启动页面相对探测；声明源仍挂起 → 等其 8s 终态再继续。
  - 页面相对候选优先于站点根候选（子路径博客的 feed 通常挂在自己目录下）。
- 安全：`html` / `finalUrl` 仍只在 preload 内使用，不入日志/不入库；公开 API 已剥离两者。

## 验证（2026-10-31）

- `node scripts/smoke-preload.js` → **95 项**（88 + 7：公开 fetch 无 html、页面相对候选、声明不可达
  回退、重定向落地路径、无声明页面相对、挂起声明并行胜出、声明可达优先）；`--no-experimental-require-module` 同 95。
  - 挂起声明源用例实测 305ms 返回本地候选（未优化时等 8s）。
- `node scripts/test-db-mock.js` 74 / `node scripts/test-ai.js` 129 / mapping / theme / typecheck / build / make-release 全绿。
- **uTools 8.0.2 实机（dev-bridge）**：
  - `airss.feed.fetch("https://www.ruanyifeng.com/blog/")` → `{status:"error",error:"NOT_FEED_XML"}`，
    **无 html / finalUrl 字段**；
  - `airss.feed.discover("https://www.ruanyifeng.com/blog/")` → `found:true`、
    `candidates[0].url=https://www.ruanyifeng.com/blog/index.xml`、**2097ms**（优化前 14400ms 失败）；
  - Solidot 首页 470ms（声明源 `<link>` 路径未变）；阮一峰 atom 直连 482ms。
  - 清理：`dev_cleanup` 还原 kv（装载埋点）；无 db 写。
- 已知不覆盖：`https://www.ruanyifeng.com/`（裸域、非 /blog/ 落地）仍失败——该站根页没有重定向到
  `/blog/`，声明源指向不可达 feedburner，且根路径常见候选全 404；这不属于本次「同页二抓/子路径候选」
  的修复范围（用户输入带 `/blog/` 或直链 atom 均正常）。

## 边界与已知取舍

- **背景请求不取消**：声明源在窗口后未应答时先返回本地候选，声明源的请求会在后台跑到 8s 超时。
  这是 async I/O，不阻塞 UI；Node 侧无句柄泄漏（http.js 超时定时器在 settle 时清理）。
- **同组候选取最快应答**：路径组内并发 3，若多个候选同时可用，返回最先响应的等价 feed（实测阮一峰
  `/blog/atom.xml` 与 `/blog/index.xml` 都可用时取到后者，均为站点有效源）；声明源在 300ms 内应答时
  仍严格优先。
- **无新增 IPC / 无 db 写**；发现结果结构不变（`found/candidates/tried`），AddFeedModal 无需改动。
- 回滚：`feed.js`（helpers/discover）、`index.js`（一行映射）、`env.d.ts`、`smoke-preload.js` 用例段与
  计数、本文档。

## 影响面

| 文件 | 改动 |
|---|---|
| `preload/services/feed.js` | `fetchFeedPublic`、`pathFeedCandidates`、`probeFirst`、`discoverFeed` 重构 |
| `preload/index.js` | `feed.fetch` → `fetchFeedPublic` |
| `src/env.d.ts` | `feed.fetch` 返回类型收窄 |
| `scripts/smoke-preload.js` | 6 项发现/边界断言（94 项） |
| `AGENTS.md` / `README.md` | 计数与发现管线纪律 |
