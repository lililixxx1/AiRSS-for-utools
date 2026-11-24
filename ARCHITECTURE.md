# AiRSS 架构总览（v2.1 · uTools 8.0+）

AiRSS 采用 **渲染层（Vue 3 + TS + Pinia） + Preload 层（Node CommonJS 领域编排）** 的双层架构，仅面向 **uTools 8.0+**（Electron 34 / Chromium 132 / Node 20.19.1）。`dist/` 是开发模式与发布打包的单一插件目录。

## 1. 目录职责

```text
AiRSS-for-utools/
├─ public/
│  ├─ plugin.json          # uTools 清单模板（main: index.html, preload: preload/index.js）
│  └─ logo.png             # 插件图标（256x256）
├─ preload/                # Node CJS 服务层（直供不打包，npm run gen:types 单向派生类型）
│  ├─ index.js             # 挂载 window.airss 并调用 lifecycle.register()
│  ├─ lifecycle.js         # 7 项 uTools 生命周期钩子唯一注册点 + mainPush / 动态 feature
│  ├─ core/                # 领域编排与本地分层存储
│  │  ├─ utils.js          # 路径、哈希、原子写、putRetry/bulkSharded
│  │  ├─ events.js         # preload -> renderer 轻量事件总线（on/off/emit）
│  │  ├─ storage.js        # 同步意图库 + airss-data 本地目录持久化
│  │  ├─ searchIndex.js    # MiniSearch 倒排索引（CJK 2-gram + 英文词元）
│  │  ├─ migrate.js        # v1.x -> v2.0 两阶段无损迁移
│  │  ├─ readService.js    # 冷启动快照、mainPush Top4、同步全文检索
│  │  ├─ refreshService.js # 刷新编排、保留清理、汇总通知与 requestSchedule
│  │  └─ laterService.js   # 「存入稍后读」抓文提取管线（mainHide + URL 正则）
│  └─ services/            # 基础设施（http/feed/article/adapters/extract/opml/scheduler/logger/db）
│     └─ ai/               # AI 增强模块（config/quota/cache/prompts, engines/, pipelines/）
├─ src/                    # Vue 3 + Pinia 渲染层
│  ├─ types/generated/     # npm run gen:types 自动产物（勿手改）
│  ├─ stores/              # settings / theme / ui / data (shallowRef)
│  ├─ composables/         # useReaderScroll / useReaderContent / useReaderAi / useFeedDrag / useCategoryMenu
│  └─ components/          # UI 视图（无 vue-router，靠 ui.view 切换）
└─ dist/                   # vite build + build-dist.js 产物（直接导入 uTools 开发者工具或上架）
```

## 2. 存储分层：同步意图库 vs 本机内容目录

uTools 云同步库仅承载体积可控、跨端必需的**用户意图数据**；一切可重新抓取或体积较大的正文与缓存全部下沉至本机目录 `<utools.getPluginLocalDataPath()>/airss-data/`。

| 数据类别 | 存储位置 | Key / 文件形式 | 说明 |
| --- | --- | --- | --- |
| 订阅配置 | `utools.db` | `feed:{id}` | 含 `feed:__later__` 稍后读虚拟源；剥除 `etag/lastModified/lastFetchedAt/lastError` |
| 阅读状态 / 星标 / 进度 | `utools.db` | `state:{itemKey}` | 仅当用户读/星标/产生进度时**懒创建**；超过 180 天未星标/未置位状态可按策略回收 |
| 星标与稍后读轻量快照 | `utools.db` | `star:{itemKey}` / `later:{itemKey}` | 新设备尚未拉取 feed 正文时，列表仍可立即可见标题/链接/摘要，不产生空白占位 |
| 协议版本标记 | `utools.db` | `meta:schema` | 标识 `version: 2` |
| 源传输状态 | `airss-data/` | `feed-state.json` | 每源条件请求 `etag` / `lastModified` / `lastFetchedAt` / `lastError` |
| 条目元数据分片 | `airss-data/feeds/` | `{feedHash12}.json` | 按源聚合的轻量条目列表（原子写：`tmp + renameSync`） |
| 正文与提取全文 | `airss-data/bodies/{feedHash12}/` | `{itemKey}.html.gz` / `{itemKey}.x.html.gz` | 仅包含 `sanitize-html` 消毒后 HTML，gzip 压缩存盘 |
| AI 产物 / 缓存 / 额度 | `airss-data/ai/` | `{itemKey}.json`, `cache.json`, `quota.json` | 译文 `aiTrans`、目录 `aiToc` 侧载按需读取 |
| 全文索引 | `airss-data/search/` | `minisearch.json` | 中文 2-gram + 英文词元倒排索引，3s 防抖原子落盘 |
| 诊断日志 | `airss-data/logs/` | `airss-YYYYMMDD.log` | 内存 500 条环形缓冲 + 按天滚动追加，保留 7 天 |

- **`itemKey` 算法**：`sha12(feedUrlKey + "‖" + (guid || link || title))`，保证同一篇订阅文章在不同设备上的同步状态主键一致；同一源内保留历史 `_id` 派生以兼容现有交互。
- **目录隔离**：`clearAll()` 仅删除 `airss-data/`，严禁清理同级目录（如 `utools-dev-bridge` 使用的 `devbridge-spill/`）。
- **两阶段迁移（v1.x → v2）**：阶段一检测旧前缀并等待 `replicateStateFromCloud() === 1`（最多 3s）后无损导入本机并生成 `state:`/`star:`，**不删旧同步文档**以兼容未升级设备；阶段二需用户从设置页手动触发清理，且强制拒绝在云同步进行中执行。

## 3. 领域编排与生命周期单点注册

`preload/lifecycle.js` 一次性注册全部 7 项 uTools 生命周期回调：

1. `onPluginReady` → 初始化本地存储，执行迁移阶段一，加载 MiniSearch 索引。
2. `onPluginEnter` → 处理 `save_later`（若来自主搜索框先 `hideMainWindow()` 后后台提取入 `feed:__later__` 与 `later:{itemKey}`，汇总通知）、`add_feed`、`mainPush` 选中项直达（`open-item`），并触发非阻塞增量刷新。
3. `onPluginOut(isKill)` → 仅 `isKill` 时硬中止刷新与 AI 流，随后统一 `flush()` 本地缓冲与索引。
4. `onPluginDetach` → 发出 `detached` 事件，渲染层切换三栏自适应窄幅布局并移除子输入框。
5. `onDbPull(docs)` → 增量合并云端下发的 `feed:` / `state:` / `star:` / `later:` 文档并派发精确事件，不再全量重载。
6. `onScheduleTrigger` → 调用 `refreshService.runScheduled()`（默认 `scheduleAiBatch = false`，不自动触发 AI 批；多源更新合并为单条通知）。
7. `onMainPush` → 主入口 `airss` 返回「1 条未读总览 + 最多 4 篇最新未读文章」；可选动态 feature `airss_search`（默认关闭，使用 `over` 规则触发实时正文检索直达）。

## 4. 信任边界与渲染层性能契约

- **双道信任模型**：`sanitize-html` 仅运行在 preload；渲染层 `ReaderPanel` 仅消费 preload 消毒后的 HTML（`v-html`），译文与高亮均使用纯文本节点/分段。
- **单向类型合同**：`preload/index.js` 是 `window.airss` 暴露面的唯一真源，通过 `npm run gen:types` 生成 `src/types/generated/` 供 `vue-tsc` 消费；`src/lib/mock.ts` 仅作纯浏览器无宿主开发兜底。
- **大数据列表零 Proxy 开销**：`data.ts` 使用 `shallowRef<Item[]>` 承载列表，阅读详情通过 `db.getItemDetail(id)` 懒加载正文、提取版全文、AI 译文、AI 目录与阅读进度。
