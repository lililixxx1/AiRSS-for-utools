# PLAN-FIX-UNREAD-REDISCOVER —— 徽标回退 / 发现二次抓取 / 文档计数（2026-10-31）

三问题均经主会话复核实锤（证据见各节）。已送 plan-code-reviewer 审核（2026-10-31）：**裁决可实施，无阻塞**；建议 ①②（测试细则）与 ③（internal-only 注释）已并入本文；备案：data.ts:352 实为 deleteFeed 的 loadAll（addFeed=343），refreshOne 成功路径还读 items/meta/etag（错误分支只读 error，html 无害结论不变）；updateFeed/reassignCategory 等 saveFeed 路径会顺带把内存实算值写回 db，是良性第三自愈点。

## F1 各源未读徽标回退 → loadAll 实算覆写

### 根因（复核实证）
- `db.js:210-215 setRead` 只写 item，不更新 feed.unreadCount；`markManyRead`（db.js:225）同病。
- `data.ts:366 markRead` 仅内存乐观推 ±1；`data.ts:214-220 loadAll` 按 db feed 文档旧底数整体覆盖 → 重启 / 新增订阅等任何 loadAll 触发（addFeed=343、deleteFeed=352、updateFeed=360、refreshAll/refreshOne 等）后徽标回退。
- 对账函数 `recalcUnread`（db.js:235）唯一调用点 = 云同步 onDbPull（App.vue:111）；启动路径无对账。另一自愈点仅「该源下次刷新」（ingestFeed:200）。
- 顶部总数不受影响：`stats.unread`（data.ts:108-114）扫 items 实态。

### 修法（渲染层实算，零新增 IPC）
`data.ts loadAll` 在 items 排序后追加单遍实算（符合性能纪律④「getters 单遍扫描」同口径）：

```ts
// F1：feed.unreadCount 以 items 实态实算覆写（db 底数在 setRead/markManyRead 后陈旧，
// getFeeds 唯一消费方就是 loadAll——覆写后陈旧值不再上屏；db 侧仍由下次刷新
// ingestFeed / 云同步 recalcUnread 对齐，无需为高频单篇阅读加重算落库）
const unreadBy = new Map<string, number>();
for (const it of items) if (!it.read) unreadBy.set(it.feedKey, (unreadBy.get(it.feedKey) || 0) + 1);
for (const f of this.feeds) f.unreadCount = unreadBy.get(f._id) || 0;
```

- `item.feedKey === feed._id`（feedMap:80 以 `_id` 建 key，markRead:365 以 `feedKey` 查，同源约定）。
- **不改 preload**：setRead 保持高频轻量（单篇阅读不绑定全源前缀 allDocs 重算）。
- `markAllRead` 内存实算（data.ts:417-429）与覆写同口径，互不冲突；「读 N 篇后 addFeed→loadAll」路径同样被修正。
- 同步更新 data.ts:419-421 注释中「陈旧窗口与现状一致且自愈」的口径（loadAll 覆写后陈旧值不上屏，窗口语义变化要写明，防后人按旧注释误判）。
- **mock.ts 不动**：loadAll 在 store 层，mock/实机同路径。

### 边界与已知竞态（不扩大）
loadAll 的 `Promise.all([getFeeds, snapshotItems])` 与并发 markRead 之间存在既有快照竞态（setRead 落库晚于 snapshotItems 时，替换后的 items 不含该翻转）——覆写前后 equally 存在，本改动不引入不扩大。

## F2 首页发现二次抓取 → fetchFeed 保留 body 复用

### 根因（复核实证）
`feed.js:174-179 fetchFeed` 下载并解码完整 body，判非 feed 时返回 `{error:'NOT_FEED_XML'}` **丢弃 body**；`discoverFeed:220` 随即对同一 URL 再 `nodeFetch`。阮一峰首页实测：首抓成功（判非 feed）→ 二抓被限流 8s 超时，发现流程 15.9s 才落失败态。

### 修法
1. `feed.js:179`：`return { status: "error", error: "NOT_FEED_XML", html: xml };`（**建议③**：同行注释注明 html 仅供 discoverFeed 内部复用，T-11 不入日志/渲染层——fetchFeed 经 preload/index.js:41 暴露为 `airss.feed.fetch`，注释把纪律落成代码）
2. `discoverFeed` 第 2 步：直连失败且 `error==='NOT_FEED_XML' && direct.html` 时直接复用，跳过 `nodeFetch`；否则走原抓取（超时/HTTP 错误无 body 可复用，路径不变）。tried 记录口径不变（复用成功时不 push「页面抓取」，与现行 page.ok 路径逐字节一致；AddFeedModal 只做 path→result 泛型渲染，兼容）。
3. 其他 fetchFeed 调用方（refreshOne/scheduler）错误分支只读 error，多余 html 字段无害。

### 安全
html 仅在 preload 内 regex 提取 `<link rel="alternate">`，不进渲染层、不入库、不入日志（T-11）。

## F3 文档计数漂移

实跑核实：smoke 85（文档写 83）、test-ai 129（写 116）、test-db-mock 74（无漂移）。
- AGENTS.md 常用命令：smoke/test-ai 计数改为**实施后最终实跑值**（F2 会新增用例）。
- README.md:32 同步 smoke 计数。
- 历史方案文档（PLAN-TOC-LEVEL.md 等）是当时快照，不动。

## 新增测试（smoke-preload.js）

F2 用例段（本地 server，node 内置 http，无新依赖）。**审核建议② 生命周期纪律**（实证依据：smoke 成功路径无 process.exit(0)，漏关 server 会「绿字后永久挂住」）：
- 收尾必须 `server.closeAllConnections(); server.close();`（Node ≥18.2；防 keep-alive 空闲连接拖住事件循环）；
- 绑定与请求一律用 **`127.0.0.1` 字面量**（`localhost` 在 Windows 常解析 ::1，与 `listen(0,'127.0.0.1')` 分叉会 ECONNREFUSED）。

用例：
- `/` 返回含 `<link rel="alternate" type="application/rss+xml" href="/feed.xml">` 的 HTML + 请求计数器；`/feed.xml` 返回最小合法 RSS。
- 断言① `fetchFeed('/')` → `error==='NOT_FEED_XML'` 且 `html` 含页面标记文本；
- 断言②（**审核建议① 计数口径**）：断言①后**复位计数器**，`discoverFeed('/')` → `found===true`（走 <link> 探测成功）且 discover 期间 `/` 命中数 === 1（首抓复用，未二次请求；未修复时为 2）。

F1 无渲染层测试基建，验证 = 实施后浏览器 dev 手动回归（审核建议写死步骤）+ 代码审查。

**2026-10-31 回归实跑（mock 环境，evaluate 驱动 store）**：`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('data')`（dev 未挂 window.pinia）。步骤：文章置已读 → `airss.db.saveFeed({...feed, unreadCount:99})` 人为落陈旧底数（模拟"上次刷新后读完"，getFeeds 复核 db=99）→ `loadAll()` → **徽标 0**（修复前此处回退 99）；反向 markRead(false)+loadAll → **徽标 1**（不信任底数）；收尾恢复 0。四项断言全中，F1 验证通过。

## 验证清单（2026-10-31 实施后全绿）

- [x] `node scripts/smoke-preload.js` → **88 项**（85+3 新增发现复用用例）
- [x] `node --no-experimental-require-module scripts/smoke-preload.js` → 88 项（feed.js 动了 preload 源码，7.x loader 纪律）
- [x] `node scripts/test-ai.js` → 129 全绿
- [x] `node scripts/test-db-mock.js` → 74 全绿
- [x] `npm run typecheck` 零错误
- [x] `node scripts/check-preload-mapping.js` → ALL MAPPINGS OK
- [x] F3 已以最终实跑计数回填：AGENTS.md / README.md smoke 88（含「发现复用」）、AGENTS.md test-ai 129

## 影响面

| 文件 | 改动 |
|---|---|
| src/stores/data.ts | loadAll 实算覆写 + 419-421 注释口径更新 |
| preload/services/feed.js | fetchFeed NOT_FEED_XML 带 html；discoverFeed 复用 |
| scripts/smoke-preload.js | F2 本地 server 用例段 |
| AGENTS.md / README.md | 计数回填 |
