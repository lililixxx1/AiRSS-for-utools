# AiRSS — uTools 智能订阅阅读器（v2.1）

面向 **uTools 8.0+** 的轻量、离线优先、本地加密/分层存储与 AI 增强 RSS 阅读器。设计语言为暖米白 + 单一橙色强调。

## v2.1 核心特性

- **同步/本地数据分层**：仅订阅配置（`feed:*`）、按需阅读状态（`state:*`）、星标与稍后读快照（`star:*` / `later:*`）走 `utools.db` 云同步；条目分片、gzip 压缩 HTML 正文、Readability 提取全文、AI 缓存/译文/目录与 7 天按天滚动日志全部保存在本机 `<PluginLocalDataPath>/airss-data/`。
- **毫秒级全文搜索**：基于零 WASM `minisearch` 的中英文混合（CJK 2-gram + 英文词元）本地倒排索引，万级文章 `<50ms` 无截断检索。
- **uTools 8.0 原生入口**：
  - **1+4 主搜索框直达（`mainPush`）**：首条展示未读总览，下方 4 条直达最新未读文章阅读面板；
  - **可选全局正文搜索（动态 `over` feature）**：设置页开启后直接在 uTools 主搜索框实时检索全部文章；
  - **存入稍后读（`save_later`，`mainHide: true`）**：复制或输入任意网页 URL 即可无窗抓取提取并归档至「稍后读」；
  - **后台定时刷新（`requestSchedule`）**：默认关闭，可在设置页授权 15/30/60 分钟定时抓取并汇总单条系统通知（定时后 AI 批处理受独立开关保护）。
- **AI 能力增强**：支持流式摘要与标题规范化、段落对照翻译、结构/AI 目录、悬浮轮盘快捷工具、模型费用提示与 `reasoningEffort`（极速/均衡/深度）三档调控；BYOK 兼容 OpenAI 接口，密钥优先写入 `dbCryptoStorage` 并支持本机文件显式降级。

## 目录结构

```text
AiRSS-for-utools/
├─ public/plugin.json & logo.png  # uTools 清单模板与图标
├─ preload/                       # Node CJS 服务层 + core 领域编排
├─ src/                           # Vue 3 + TypeScript + Pinia 渲染层
├─ scripts/                       # build-dist、typegen、离线测试与 dev-bridge 验机脚本
├─ docs/                          # 架构 ADR（docs/adr/）、设计系统与历史归档
└─ dist/                          # npm run build 产出的单一插件目录（可直接导入 uTools）
```

## 开发与测试

```bash
npm install
cd preload && npm install && cd ..

npm run dev                               # 浏览器 dev（mock 兜底；支持 ?view=reader|settings|addfeed|recommend）
npm run gen:types                         # 从 preload/index.js 生成 src/types/generated/
npm run typecheck                         # vue-tsc --noEmit
npm run build                             # 构建并自检单一可运行目录 dist/

# 离线与构建校验
node scripts/check-theme-contrast.js
node scripts/check-preload-mapping.js
node scripts/smoke-preload.js --offline
node scripts/test-db-mock.js --offline
node scripts/test-ai.js
node scripts/test-v2-core.js
```

> 接入 uTools 开发者工具时，请先执行 `npm run build`，然后直接导入 **`dist/plugin.json`**。如需运行端到端实机验证：配置 `UTOOLS_MCP_KEY` 后执行 `node scripts/test-dev-bridge.js`。

## 协议

GPL-3.0-only
