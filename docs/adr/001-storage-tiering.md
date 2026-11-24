# ADR-001：存储分层（同步意图库 vs 本机内容目录）

- **状态**：已采纳（v2.1）

## 背景
v1.x 将所有文章条目、HTML 全文缓存、Readability 提取正文、AI 复合缓存与诊断日志均写入 `utools.db` / `dbStorage`。订阅增长到数千篇后，跨端同步包与渲染层全量 IPC 克隆负担急剧上升，且内容搜索不得不扫描 `itemfull:` / `itemfullx:` 并引入 1500ms 预算截断降级。

## 决策
- **同步意图层（`utools.db`）**：仅保留 `feed:*`（剥除本机传输态）、懒写的 `state:{itemKey}`（已读/星标/阅读进度）、`star:{itemKey}` 轻量星标快照、`later:{itemKey}` 轻量稍后读快照与 `meta:schema`。
- **本机内容层（`<PluginLocalDataPath>/airss-data/`）**：存储 `feed-state.json`、每源轻量分片 `feeds/{feedHash12}.json`、gzip 压缩正文 `bodies/{feedHash12}/{itemKey}.html.gz` 与 `.x.html.gz`、AI 侧载/缓存/额度 `ai/`、MiniSearch 索引 `search/minisearch.json` 与按天滚动日志 `logs/`。
- 所有本地 JSON 与二进制文件统一经临时文件写入并 `renameSync` 原子替换；损坏分片捕获自愈。
- 通过 `minisearch`（CJK 2-gram + alphanumeric 分词）实现 `<50ms` 毫秒级本地倒排检索。
- v1 → v2 采用两阶段迁移：阶段一自动无损导入且保留旧同步文档以兼容未升级终端；阶段二仅在 `replicateStateFromCloud() !== 1` 时由用户主动确认清理。

## 后果
- 同步数据量下降一个数量级，新设备即使仅完成同步拉取也能从 `star:`/`later:` 快照立即看到重要收藏。
- 本地缓存可独立重建索引与按需清理，不影响任何订阅与已读状态。
