# AGENTS.md — AiRSS（uTools 8.0+）

> 详细架构与存储设计见 [ARCHITECTURE.md](ARCHITECTURE.md)；uTools 宿主开发参考见 [.agents/skills/utools-plugin-dev/SKILL.md](.agents/skills/utools-plugin-dev/SKILL.md)；重要决策归档在 `docs/adr/`。

## 常用命令

```bash
npm install                               # 安装渲染层依赖
cd preload && npm install && cd ..        # 安装 preload CJS 依赖（请勿与根依赖合并）
npm run dev                               # 纯浏览器开发（src/lib/mock.ts 兜底，支持 ?view=reader|settings|addfeed|recommend）
npm run gen:types                         # 从 preload/index.js JSDoc 派生 src/types/generated/
npm run typecheck                         # vue-tsc --noEmit（含自动生成的 window.airss 契约检查）
npm run build                             # vite build + scripts/build-dist.js → 产出单一可运行目录 dist/
node scripts/check-theme-contrast.js      # 4 配色 × 明暗主题对比度与令牌守门（改 tokens.css 必跑）
node scripts/check-preload-mapping.js     # preload/index.js 与 core/services/d.ts 映射一致性核对
node scripts/smoke-preload.js --offline   # preload 冒烟（加 --offline 跳过外网抓取）
node scripts/test-db-mock.js --offline    # 数据层与抓取/提取状态机测试
node scripts/test-ai.js                   # AI 管线、reasoningEffort 与 BYOK 两级存储测试
node scripts/test-v2-core.js              # v2 存储分层、MiniSearch、迁移、生命周期与定时任务测试
node scripts/test-dev-bridge.js           # utools-dev-bridge 实机端到端验证（需 UTOOLS_MCP_KEY）
```

## 核心开发纪律（改代码前必读）

1. **纯净 uTools 8.0+ 与单一目录 `dist/`**：不写 uTools 7.x / Node 16 兼容分支；插件清单模板在 `public/plugin.json`，最终运行与打包目录统一为 `dist/`；`preload/` 与其 `node_modules` 直供不打包，依赖锁定 CJS 兼容版本（更新依赖后务必通过 `build-dist.js` 的 `--no-experimental-require-module` 自检）。
2. **同步意图库 vs 本机数据边界**：
   - 仅 `feed:*`、`state:{itemKey}`（懒写）、`star:{itemKey}`、`later:{itemKey}`、`meta:schema` 可进 `utools.db`。
   - 严禁把 `item:*`、`itemfull:*`、`itemfullx:*`、`ai:*`、传输态或诊断日志写回 `utools.db` 或 `dbStorage`；本机数据一律存放在 `<utools.getPluginLocalDataPath()>/airss-data/`，清库只能删除 `airss-data/`（保护同级目录）。
3. **生命周期单点注册**：所有 7 项 `utools.onPluginReady / Enter / Out / Detach / DbPull / ScheduleTrigger / MainPush` 仅允许在 `preload/lifecycle.js` 注册一次；渲染层通过 `window.airss.on(...)` 与 `consumePendingActions()` 同步状态，绝不在 `.vue` 中重复注册宿主钩子。
4. **双道安全边界与 BYOK 存储**：
   - `sanitize-html` 仅在 preload 执行；原始 HTML 与 `fetchFeed.html` 不出 preload；渲染层 `v-html` 只允许消费 preload 消毒结果。
   - BYOK 密钥优先写 `utools.dbCryptoStorage`，不可用时降级至 `<airss-data>/byok.local` 并在设置页显式告警，密钥与接口地址、文章完整正文严禁写入日志。
5. **跨 IPC 与性能优化契约**：
   - 写入 `utools.db` / `utools.dbStorage` 前必须经过 `plainClone` 或展开为纯字面量（Vue reactive Proxy 不可结构化克隆）。
   - `data.items` 使用 `shallowRef` 承载轻量条目；正文与 `aiTrans`/`aiToc` 通过 `db.getItemDetail(id)` 按需加载。
   - 勿对 `tokens.css` 与 `base.css` 破坏对比度或给 `grid-template-columns` 加 CSS 过渡；页内返回统一使用 `Backspace`（不抢占宿主 `Escape`）；无 `<select>`/`<datalist>` 原生弹层。
6. **类型单一真源**：修改 `preload/index.js` 或服务导出签名后，必须执行 `npm run gen:types && npm run typecheck && node scripts/check-preload-mapping.js`；禁止手写第二份 `AirssServices` 接口。
