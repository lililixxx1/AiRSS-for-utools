# AiRSS — uTools 智能订阅阅读器

一期（核心阅读器）。暖米白 + 单一橙色强调的设计语言，参考 `docs/design-system.md`。

## 目录

```
airss/
├─ plugin.json          # uTools 插件清单（main→dist/index.html, preload→preload/index.js）
├─ logo.png             # 插件图标（scripts/make-logo.py 生成）
├─ preload/             # Node 服务层（uTools 规范：源码直供不打包，node_modules 随包）
│  ├─ index.js          # 挂 window.airss = { db, feed, article, opml, scheduler, sys }
│  └─ services/         # http(解压/超时/限流) / db(判重/写序/保留) / feed(发现/解析) / article(sanitize) / opml / scheduler
├─ src/                 # 渲染层 Vue3 + TS + Pinia（无 router，状态机切视图）
├─ dist/                # vite 构建产物（打包/调试用）
├─ docs/
│  ├─ PLAN-PHASE1.md    # 一期实施计划（v2，过 plan-code-reviewer）
│  ├─ design-system.md  # 设计系统（令牌/组件/交互/可达性，含对比度计算）
│  └─ preview.html      # 设计像素基准（浅/深双主题）
└─ scripts/             # make-logo.py / smoke-preload.js
```

## 开发

```bash
npm install               # 渲染层依赖
cd preload && npm install # preload 依赖（版本锁定 Node16/CJS 兼容）
cd ..
npm run dev               # 浏览器开发（mock 层兜底，无需 uTools）
npm run build             # 构建 dist
npm run typecheck         # vue-tsc
node scripts/smoke-preload.js      # preload 冒烟测试（30 项：XSS/GBK/解析/OPML/真实抓取）
node scripts/test-db-mock.js       # 数据层+端到端管线测试（26 项：判重/写序/保留清理/级联删除/真实刷新入库）
node scripts/check-theme-contrast.js  # 多主题配色守门（warm 快照 + 令牌完整 + 4 配色 × 明暗对比度矩阵）
python scripts/make-logo.py     # 重新生成 logo
```

浏览器 dev 直达状态（mock 专用）：`?view=reader` / `?view=settings` / `?view=addfeed`。

## 接入 uTools（开发者模式）

1. `npm run build` 确保 dist 为最新；preload 依赖已 `npm install`。
2. uTools → 设置 → 高级 → 本地插件 / 开发者插件 → 导入 plugin.json：
   `C:\Users\Administrator\Desktop\ccc\ccc\airss\plugin.json`
3. 指令：`AiRSS` / `rss` / `订阅` / `阅读` 打开主界面；复制任意 URL 后呼出 uTools →「订阅到 AiRSS」一键订阅。

> **打包注意（v1.3）**：plugin.json 无排除机制，发布打包前删除 `scripts/spike-tmp/`（~17MB 的
> Readability 选型 spike 依赖，jsdom 等败者不随包发布；复现可 `npm install` 重建，见
> docs/PLAN-V1.3.md 附录）。

## 一期功能清单

- 订阅增删改（发现管线：直连 → `<link rel=alternate>` → 常见路径探测，失败给 RSSHub 文案）
- 打开即增量刷新：ETag / If-Modified-Since、12s 请求超时、90s 单轮预算、并发 3、gzip/deflate/br 解压、GBK 编码兜底
- 判重与更新：`guid‖link‖title` SHA-256 前 12 位为 id；contentHash 变化才覆盖内容；read/starred 恒保留；写序（items 全成功才推进 feed）
- 卡片（默认）/列表双视图 + 可变高虚拟滚动；阅读面板（sanitize 正文、4 档字号、衬线开关、行宽 42em、阅读进度记忆）
- 已读/星标/全部已读；键盘流 j/k/Enter/m/s/Shift+A/Ctrl+F/Esc
- SubInput 搜索 + 侧栏搜索同源；mainPush 未读建议位；新文章系统通知（按源）
- OPML 导入（file input，分批+进度）/ 导出（showSaveDialog）
- 浅/深/跟随三态主题（matchMedia 实时）；分离窗三栏（detach 自动切换）；侧栏折叠
- 保留策略：每源 N 篇（默认 200）+ 星标豁免；删除前复查星标防竞态
- 安全：sanitize-html 白名单（双道信任模型：preload 是唯一 HTML 生产方）、CSP img-src、no-referrer、外链 shellOpenExternal

## 二期（AI 增强，已实现）

- AI 合并调用（打开文章流式摘要 + 标题/标签）、轻量批（刷新后补 AI 优化标题）、额度双池（手动 120 · 后台 30 /日，BYOK 豁免）、BYOK 引擎（OpenAI 兼容，密钥仅存 dbCryptoStorage）
- v1.2（2026-09）：AI优化标题（冗长/含糊/标题党 → 清晰客观中文）+ 英文标题中文化；AI 段落翻译（整篇一次调用，译文以弱化引用块插在各段之后，缓存跨源同文复用）；自动连续摘要 0/1/3/5 篇可调（0 = 逐篇手动 AI 按钮）；内容搜索（正文全文多词 AND、1.5s 预算截断、标题高亮与结果计数；方案见 docs/PLAN-ENHANCE.md）

## v1.3（全文提取 / 过滤 / 组织，已实现；方案见 docs/PLAN-V1.3.md）

- **全文提取（P0）**：摘要型源打开文章时自动抓原文页 → Readability（linkedom）提取 → 消毒后替换正文；`itemfullx:` 独立前缀缓存二次秒出；每源开关「抓取全文」，失败安静回摘要（无打扰 toast）；AI 摘要自动用提取版正文（质量受益）；全文替换时旧译文连带失效（T-09 同族 + 翻译/提取并发弃写守卫）
- **关键词过滤（P1a）**：静音词（多词 OR，命中即隐，计数不剔除；工具栏「已静音 N 篇」可临时暂停）+ 高亮词（与搜索词合并 3 词上限）；设置页「过滤」组每行一词
- **标签智能文件夹（P1b）**：侧栏标签区（AI 标签计数前 8）+ 阅读摘要卡标签可点，`#标签` 过滤视图与搜索/静音交集
- **组织补齐（P2）**：分类重命名/合并/删除（⋯ 菜单）；订阅源拖拽排序（order 持久化，新增源排末尾，OPML 导出随序）；订阅地址可改（换源不换 feedKey，已读/星标/AI 产物全保留，条件缓存自动重置并首抓）
- **内容搜索升级**：扫 itemfull + itemfullx 双前缀（同 id 去重）；万级存量实测 1.5s 预算仅扫 ~20% 即截断降级（`node scripts/bench-search.js` 复现），维持预算截断不开发索引
- 仍留路线：云同步合并矩阵、卡片封面渐变生成、倒排搜索索引（万级实测已截断降级维持，见待验证项）、持久化智能文件夹（v2 视标签使用率再议）

## 实机待验证项（spike，见 PLAN §12）

- [x] Esc 拦截优先级（宿主 vs 页面）——2026-09-05 实机验证：宿主优先，主窗口内按 Esc 直接隐藏插件（页面 preventDefault 拦不住）。页内逐级返回改由 ⌫ Backspace 承担（Esc 分支保留，分离窗内仍生效）
- [ ] mainPush 建议位存续规则与 icon 相对路径表现
- [x] allDocs 万级真实耗时——v1.3 本地实测（`node scripts/bench-search.js`，12000 篇 itemfull+itemfullx 各半）：1.5s 预算仅扫 ~2450 篇（约 20%）即 truncated，全扫推算 ~7s+；**决策：维持预算截断降级（UI 已示「部分扫描」），不开发倒排索引**。实机 IPC 开销另测
- [ ] 全文提取实机（Node16 宿主内 linkedom/readability require 与运行、真实摘要型源抓取成功率、`FETCH_EMPTY_BODY`/`EXTRACT_TOO_SHORT` 实际占比）
- [ ] 拖拽排序/分类菜单/标签区在实机无边框窗内的交互（指示线定位、⋯ 菜单裁剪）
- [x] utools.ai 特性检测在当前账号环境的表现（2026-09-05 实机验证：接口可用、allAiModels 正常、流式/非流式/abort 均通过；单次生成 6~32s 为服务端耗时）

## 开源协议

本项目采用 [GPL-3.0](LICENSE) 协议发布（GPL-3.0-only）。
