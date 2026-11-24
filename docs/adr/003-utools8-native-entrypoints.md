# ADR-003：uTools 8.0+ 原生入口与能力边界选型

- **状态**：已采纳（v2.1）

## 背景
uTools 8.0+ 引入了系统级 `requestSchedule` / `onScheduleTrigger` 后台定时任务、`setFeature` 动态指令、`mainHide` 无窗后台匹配，以及支持 `reasoning_effort` 的新版 AI 模型能力。

## 决策
1. **纯净 8.0+ 基线**：放弃 uTools 7.x / Node 16 分支与版本号猜测，将 `reasoningEffort`（`none`/`low`/`medium` 默认 `none`）作为一等配置项并展示模型 `cost`。
2. **明确纳入的原生产物**：
   - `requestSchedule` 定时后台刷新（默认关闭、支持 Cron 选择、授权拒绝与执行统计透明可见，`scheduleAiBatch` 独立默认关闭）；
   - 默认主入口 1+4 直达未读（`mainPush`），以及设置页显式开启的全局实时文章搜索（动态注册 `airss_search` `over` feature，默认关闭）；
   - 隐藏背景入口 `save_later`（`mainHide: true` + URL 正则）一键将网页提取并存入 `feed:__later__`。
3. **BYOK 两级密钥存储**：优先 `utools.dbCryptoStorage`，不可用或未来下线时显式降级至 `<airss-data>/byok.local` 并在设置页告警，不阻塞自定义模型用户。
4. **明确不做的边界**：不引入 MCP/Agent `tools`、全库 RAG 对话或按源动态注册海量 feature，保持轻量离线 RSS 阅读器定位。
5. **构建目录收敛**：`public/plugin.json` 与 `scripts/build-dist.js` 将 `dist/` 统一为开发与上架的唯一完整目录。

## 后果
- 充分利用 uTools 8.0 的桌面快捷入口与无感后台刷新，同时保持主搜索框与 AI 额度的完全可控与克制。
