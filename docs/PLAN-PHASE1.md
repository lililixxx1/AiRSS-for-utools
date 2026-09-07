# AiRSS 一期实施计划（核心阅读器）v2

> 2026-09-04 · 依据 [airss-design.md v0.4](C:\Users\Administrator\.openclaw-autoclaw\workspace\auto-designer\airss-design.md)（三审通过）+ 用户 grill 共识（4 问定稿）+ [utools-api-doc.md](C:\Users\Administrator\Desktop\ccc\ccc\utools-api-doc.md) 实文核准
> 一期 = 核心阅读器，AI 全管线/云同步合并矩阵/全文提取留二期（数据模型一期建全，AI 字段空值兼容）
> **v2 = v1 过 plan-code-reviewer 审核（裁决：修改后通过），修复 P0-1/2/3、P1-1/2/3/4，吸收 P2 全部适用项**

## 0. grill 定稿决策

| # | 决策 | 结论 |
|---|------|------|
| G1 | 交付范围 | 分期：一期核心阅读器（订阅增删/刷新/双视图/阅读/OPML/主题） |
| G2 | 主视图 | 卡片视图默认 + 紧凑列表切换，均虚拟滚动（推翻设计文档 D5"V1 仅列表"） |
| G3 | 深色模式 | 一期做，浅/深/跟随三态，深色暖炭底独立调校 |
| G4 | 工程设定 | 文件夹 `ccc\ccc\airss\`；Vue3+TS+Vite+Pinia；数据模型按 v0.4 §4 建全；logo 自绘 |

## 1. 对设计文档的三处修订（依据官方文档实文）

| # | 设计文档原文 | 修订 | 依据 |
|---|--------------|------|------|
| R1 | §1/§2 preload "esbuild 预打包单文件" | **改为源码直供**：preload 用可读多文件 JS（JSDoc 类型注释），同级 `package.json` + `node_modules` 原样随包 | 官方 L29/L644-650："不能进行打包/压缩/混淆…源码清晰可读"；L716-757 npm 安装规范路线（审核确认：此路线是 uTools 标准用法，esbuild 打包反会在上架审核被拒） |
| R2 | §7.1 冷色令牌（#F6F7F9 底/#2F6FED 强调） | **整套替换为参考图暖橙令牌**（§6 设计令牌表） | 用户指令"参考图片配色"；参考图视觉分析报告 |
| R3 | §5.1 preload fetch | **自写 nodeFetch**（http/https 模块：重定向≤3 跳、12s 超时、**gzip/deflate/br 解压**、解压后 5MB 截断、可配 UA），不依赖运行时 fetch | uTools 内嵌 Node 16（官方 L655），fetch 非 stable；主流 CDN 对 RSS 响应近乎必然 gzip，不解压则解析全败（审核 P0-2） |

其余（数据模型/判重/刷新管线/安全基线/五态设计）按 v0.4 执行。

## 2. 目录结构

```
airss/
├─ plugin.json               # §3
├─ logo.png                  # 自绘：橙底圆角 + "Ai" 白字 + rss 波纹角标（PIL 生成）
├─ preload/                  # 源码直供（R1），CommonJS + JSDoc，Node16 兼容
│  ├─ package.json           # { "type": "commonjs", dependencies... }（锁版本 + package-lock.json）
│  ├─ index.js               # 挂 window.airss = { db, feed, article, opml, scheduler, sys }
│  └─ services/
│     ├─ http.js             # nodeFetch(url,{headers,timeout,maxBytes}) → {status,headers,body(Buffer)}
│     │                      #   请求带 Accept-Encoding: gzip, deflate, br；
│     │                      #   按 content-encoding 用 zlib gunzip/inflate/brotliDecompress 解压；
│     │                      #   maxBytes 以解压后字节计；解压失败记 lastError 跳过该源
│     ├─ db.js               # 全量快照/前缀查询/批量写(带_rev,冲突退避3次)/unreadCount对账/保留清理/分层存取
│     ├─ feed.js             # 发现管线(校验→RSS直判→link探测→常见路径) + 抓取解析(ETag/编码兜底/rss-parser)
│     ├─ article.js          # 摘要提取(≤300字)/封面提取/正文 sanitize+截断(≤100KB)/阅读时长估算
│     ├─ opml.js             # 导入(fast-xml-parser→feed列表) / 导出(OPML 1.0 生成)
│     └─ scheduler.js        # p-limit(3) 并发 + 12s 请求超时 + 90s 单轮预算 + 分片让出(每2源yield) + abort()
├─ src/                      # 渲染层 Vue3+TS+Vite+Pinia
│  ├─ App.vue                # 视图状态机 main|reader|settings + addFeed 弹层 + 全局键盘
│  ├─ components/
│  │  ├─ AppShell.vue        # 双栏(小窗)/三栏(detached) grid 切换
│  │  ├─ Sidebar.vue         # 品牌区/搜索框/统计三卡/订阅源(右键/悬浮⋯菜单:编辑/删除)/分类/折叠手柄/底部按钮
│  │  ├─ ArticleFlow.vue     # 工具栏(标题/刷新/全部已读/视图切换/排序) + 虚拟滚动容器
│  │  ├─ ArticleCard.vue     # 卡片视图行：横幅图/标签/标题/摘要/元信息/收藏/分享
│  │  ├─ ArticleRow.vue      # 列表视图行：高密度单行
│  │  ├─ ReaderPanel.vue     # 阅读面板：标题/元信息/正文(v-html sanitize 产物)/操作条
│  │  ├─ AddFeedModal.vue    # 校验→发现→确认 三步弹层（含"编辑订阅"复用：改名/改分类/改刷新频率）
│  │  ├─ SettingsView.vue    # 5 组：外观/AI(占位说明)/通知/数据/关于
│  │  ├─ EmptyState.vue      # 首用引导/分类无文章/全部读完 三态
│  │  └─ icons.ts            # 内联 SVG 图标组件（不用 emoji，不引图标库）
│  ├─ stores/                # feeds/items/reader/settings/ui 五个 Pinia store
│  ├─ composables/           # useVirtualList(可变高+高度缓存)/useTheme/useHotkeys/useUtools
│  ├─ types/                 # Feed/Item/ItemFull/Settings 类型（与 preload JSDoc 对齐）
│  └─ styles/tokens.css      # §6 设计令牌 + 浅/深两套
├─ vite.config.ts            # base:'./'，outDir dist
├─ dist/                     # 构建产物，plugin.json main 指向 dist/index.html
├─ scripts/make-logo.py      # PIL 生成 logo.png
└─ docs/PLAN-PHASE1.md       # 本文档
```

## 3. plugin.json

```jsonc
{
  "main": "dist/index.html",
  "preload": "preload/index.js",
  "logo": "logo.png",
  "pluginSetting": { "single": true, "height": 620 },
  "features": [
    { "code": "airss", "explain": "AiRSS 智能订阅阅读器",
      "mainPush": true,
      "cmds": ["AiRSS", "rss", "订阅", "阅读"] },
    { "code": "add_feed", "explain": "订阅到 AiRSS",
      "cmds": [{ "type": "regex", "label": "订阅到 AiRSS",
                 "match": "/^https?:\\/\\/[^\\s/$.?#][^\\s]*$|^[a-z0-9][-a-z0-9]{0,62}(\\.[a-z0-9][-a-z0-9]{0,62}){1,10}(:[0-9]{1,5})?(\\/[^\s#?]*)?$/i" }] }
  ]
}
```

- 正则收紧（审核 P2）：URL 分支排除 `/$.?#` 开头路径（对齐官方 L223 示例）；裸域名分支路径限定 `[^\s#?]`。两分支均非"任意匹配"，符合官方 L222 警告。
- add_feed 进入（type=regex, payload=URL）→ 打开 AddFeedModal 预填并自动跑发现管线（§5.2）。
- mainPush：onMainPush 回调返回 `[{icon:'logo.png', title:'AiRSS', text:'N 篇未读 · 最新3条标题以 · 拼接,每条JS侧截断≤30字,总≤100字'}]`（宿主渲染无 CSS 控制，JS 截断），onSelect 返回 true 进入。
- 特性检测：启动时 `getAppVersion()` 记录，`typeof utools.ai === 'function'` 探测结果写入设置页"AI 功能二期开放（当前环境 ready/unready）"。

## 4. 数据模型（v0.4 §4 全量照搬，一期不建的文档省略）

| 文档 | _id | 一期写入字段 |
|------|-----|--------------|
| 订阅源 | `feed:{uuid}` | url, siteUrl, desc, title, titleEn?, category(默认"默认"), etag, lastModified, lastFetchedAt, refreshMin(默认30), unreadCount(派生), lastError, notify(true), createdAt |
| 文章 | `item:{feedId}:{hash12}` | guid, link, title, titleDisplay, author, pubTs(13位ms,未来值clamp), fetchedAt, contentHash(全文SHA-256前12), summaryText(≤300字), cover, read, starred, aiStatus:'none'（二期字段占位） |
| 正文 | `itemfull:{item的_id}` | content（sanitize HTML，≤100KB UTF-8 字节截断） |
| 设置 | dbStorage KV | theme('auto'|'light'|'dark'), fontLevel(0-3), viewMode('card'|'list'), sidebarCollapsed, readPositions(LRU), schemaVersion:2, 杂项（notify开关/保留篇数/全局refreshMin/排序）。注：dbStorage 随 uTools 云同步，主题等设置多端共享 |

- hash12 = SHA-256(`guid ‖ link ‖ title`，guid 存在仅取 guid) 前 12 hex；写前 get() 判重（**顺带取 _rev**，官方 L3128 更新不可省），碰撞追加 `-2` 重试。
- 更新策略：contentHash 变化才覆盖 content/title/summaryText；read/starred 恒保留。
- 写序：items bulkDocs 全成功 → put feed（etag/lastFetchedAt/重算 unreadCount）；任一失败不推进 etag。**全部判重命中（无新文）也 put feed 推进 lastFetchedAt**，否则下次打开重复全量抓。冲突带退避重试 3 次。
- 保留策略：每源最近 500 篇 + 星标豁免；**触发时机=打开刷新完成后**；清理分片（每批 50 条，批间 yield）连带删 itemfull；**删除前 get() 复查 starred**（防清理批与星标操作交错误删）。
- onDbPull（简版，二期做完整合并矩阵）：回调 → **300ms 防抖** → 全量重载 + unreadCount 对账（同步落地期间 UI 抖动一次可接受）。
- schemaVersion 纪律（审核 P1-2）：一期写 `schemaVersion:2` + aiStatus:'none' 占位；**二期补 ai.* 等字段时 bump v3 并写迁移函数**（旧数据缺失字段按 undefined 读取），不在 v2 内静默改语义。

## 5. 一期核心流程

### 5.1 打开刷新（onPluginEnter, code=airss）
```
立即用内存/缓存渲染 → replicateStateFromCloud()===1 则显示"同步中"骨架
→ 收集 now − lastFetchedAt > refreshMin×60000 的源（null 视为到期）
→ scheduler.refreshDueFeeds(onProgress)：并发3、请求12s超时、单轮90s预算、每2源yield
→ 逐源入库（判重→更新策略→bulkDocs→put feed（含无新文推进）→重算unreadCount）
→ 新文章：源级通知 showNotification('{feed.title}：N 篇新文章', 'airss')（设置可关）+ mainPush 校准
→ 全部源完成后触发保留清理（分片）
```
**中断策略（审核 P1-4）**：`onPluginOut(isKill)` 仅 `isKill===true` 硬中断（scheduler.abort()）；`isKill=false`（隐藏后台，进程存活）不中断，后台静默完成本批——写序已保证 etag 推进不重复拉取。

### 5.2 添加订阅管线（AddFeedModal / add_feed 指令共用）
```
输入 URL → nodeFetch(12s) →
  RSS/Atom（Content-Type 或 <?xml + <rss|<feed 判定）→ 直接解析确认
  HTML → 解析 <link rel="alternate" type="application/rss+xml|atom+xml">（取全部候选）
  → 无则探测 /feed /rss /atom.xml /feed.xml /index.xml（逐个 5s）
  → 候选列表供用户确认（展示标题/条数）→ 入库 → 入库即首抓（复用 5.1 单源路径）
```
失败态：列出已试候选 + "粘贴 feed 直链"手动输入框 + RSSHub 建议（`https://rsshub.app/{域名}` 文案提示，不自动请求）。
AddFeedModal 复用为**编辑订阅**（改名/分类/刷新频率/通知开关，不带发现管线）。

### 5.3 删除订阅（审核 P0-3 补）
```
订阅源条目 ⋯ 菜单 → "删除订阅"二次确认（含该源文章数提示）→
  删除 feed 文档 → allDocs('item:{feedId}:') 分片删除（≤50/批，批间yield，连带删 itemfull:{id}，
  星标文章同样删除——已在确认文案明示）→ 重算全局统计 + mainPush 校准 → 若当前视图指向该源则回落"全部"
```
分类管理（重命名/删除分类）一期不做，设置页放置占位说明；分类仅通过添加/编辑订阅设置。

### 5.4 阅读流
列表点卡片 → itemsStore 标记 read（乐观翻转）→ ReaderPanel 加载 `itemfull:{id}`（无则回退 summaryText + "原文"按钮）→ 外链 `utools.shellOpenExternal`。分离窗下 ReaderPanel 常驻第三栏。

### 5.5 OPML
- 导入入口（审核 P2 补）：设置页"数据"组按钮 + 首用空态引导按钮 → `utools.showOpenDialog`（官方 L1296）选 .xml/.opml → Node fs 读文件 → fast-xml-parser 解析 `<outline>` 树 → folder/text→title/xmlUrl 映射（多级 folder 拼 `a/b`）→ 分批 50 源/批入库（已存在跳过并计数）→ 批间 yield + 进度条 → 批量首抓入队 scheduler。
- 导出：feeds 生成 OPML 1.0 字符串 → `utools.showSaveDialog`（官方 L1320）→ Node fs 写文件。

## 6. 设计令牌（R2：参考图暖橙系，auto-designer 出完整规范）

| 令牌 | 浅色 | 深色（暖炭独立调校） |
|------|------|------|
| --bg（侧栏底） | #F9F6F1 暖米白 | #171412 暖炭 |
| --surface（内容区/卡片） | #FFFFFF | #201C19 |
| --text-1 / --text-2 / --text-3 | #1F2937 / #6B7280 / #9CA3AF | #ECE7E1 / #A89F95 / #6E665E |
| --accent | #F97316（橙，未读/选中/主按钮） | #FB923C |
| --accent-soft（选中底） | #FCEFE3 | #3A2E22 |
| --border | #E8E5DF | #2E2823 |
| --danger | #C24545 | #E06C6C |

布局按参考图：侧栏 ~280px（品牌区+搜索+统计三卡+订阅源+分类+底部按钮，右缘橙色折叠手柄）；内容区工具栏（视图名/刷新/全部已读 | 视图切换/排序下拉）；卡片 12px 圆角、横幅图 lazy-load、未读用**数字+accent 字重双通道**（参考图无圆点）；列表行紧凑 40px。深浅遵循 `matchMedia('(prefers-color-scheme: dark)')` 实时切换，`isDarkColors()` 仅作初始兜底。
对比度注意（审核 P2）：#F97316 上白字约 3:1，主按钮用深橙字 #7C2D12 或 ≥16px 加粗白字，交 auto-designer 规范化达 WCAG AA。

## 7. 安全基线（v0.4 §8 照搬）
- sanitize-html 白名单：标签 `p br h1-h6 ul ol li blockquote pre code img a table thead tbody tr td th strong em`；img 仅 `src(https)/alt/width/height`，a 仅 `href(http(s))/title` + rel=noopener；FORBID svg/math/form/input/iframe/style/link/meta。渲染层不做二次 v-html 信任（preload 是唯一 HTML 生产方）。
- `<meta name="referrer" content="no-referrer">` + CSP `img-src https: data:`；外链一律 shellOpenExternal。
- 抓取：单源 5MB 上限（解压后计）、fast-xml-parser 关实体扩展（`processEntities:false`）、默认仿浏览器 UA。

## 8. 依赖清单（版本经 npm registry engines 实测复核）

| 层 | 依赖 | 版本约束 | 理由 |
|----|------|----------|------|
| preload | rss-parser | ^3.13（锁 v3） | CJS、无 engines 限制，RSS/Atom 方言兼容 |
| preload | fast-xml-parser | ^4.3（锁 v4，**禁升 5.x**：v5 已转 ESM-only，preload 为 CJS 无法 require） | OPML + HTML link 探测解析 |
| preload | sanitize-html | **~2.11.0 精确锁**（2.17.7 engines 要求 node≥22.12，^2 会漂移） | 正文消毒；随 package-lock.json 提交 |
| preload | iconv-lite | ^0.6 | GBK 等编码兜底（Content-Type charset → XML declaration → UTF-8） |
| preload | p-limit | ^3.1（锁 v3；**真实原因是 v4+ 为 ESM-only**） | 并发控制 |
| 渲染层 | vue / pinia / vite / typescript | ^3.4 / ^2.1 / ^5 / ^5 | D2；虚拟滚动自研（composable，可变高+高度缓存） |

preload 不用 esbuild/打包（R1）；图标内联 SVG 不引库。

## 9. 数据加载策略（审核 P0-1 重设计）

官方 `allDocs(idStartsWith?)` **无任何分页/limit 参数**（L3423-3445），"前缀分页续载"机制不存在。采用**方案 A：全量快照**：

- 启动/刷新后：`promises.allDocs('item:')` 一次性拉全量到内存（itemsStore），按 pubTs 排序，虚拟滚动只挂可视行（DOM 成本与总量无关）。
- **开发首日 spike**：20 源×500 篇≈1 万条全量耗时与内存实测（预期 <1s / ~15MB）；若超 500ms，降级为方案 C（列表仅展示最近 2000 篇，未读统计走 feed.unreadCount 不受影响，搜索范围=最近 2000 篇并在空态文案明示）。
- 搜索/全部已读/统计基于全量快照（不基于可见窗口）。
- 增量刷新只 merge 新文档进内存快照，不重复全量拉取。

## 10. 集成点清单
- onPluginEnter：code 分流（airss→主界面+后台刷新；add_feed→弹层预填 payload）。
- setSubInput(onChange,'搜索文章…')：与侧栏搜索框同写 store.search；200ms 防抖；匹配 title+summaryText（contains，大小写不敏感）。
- onPluginOut：仅 isKill=true 时 scheduler.abort()（§5.1）。
- onPluginDetach：uiStore.detached=true → 三栏布局；**分离窗无 SubInput，detach 时 removeSubInput()，重新进入主窗时重挂**（审核 P2）。
- onMainPush：§3；onDbPull：§4 简版（防抖 300ms）。
- 通知点击 featureCode='airss'。
- j/k 上下、Enter 阅读、m 已读、s 星标、Shift+A 全部已读、Ctrl+F 聚焦搜索、Esc 逐级返回（阅读→列表）。
- **Esc × 宿主行为（审核 P1-3，开工首个实测 spike）**：渲染层 keydown preventDefault 能否拦住宿主 Esc 未知；兜底=若不可拦截，仅保留"阅读面板内 Esc 返回列表"，最顶层放行 Esc 让宿主退出（逐级退出而非卡死）；验收加"Esc 返回层级 × 宿主退出不冲突"。

## 11. 构建与交付
1. `npm run build`（vite → dist/）+ preload `npm install`（package-lock.json 提交）。
2. logo：scripts/make-logo.py（PIL：256×256 橙 #F97316 圆角方块、白 "Ai"、右下白色 rss 波纹+圆点）。
3. 本地验收：uTools 开发者模式载入 `C:\...\airss\plugin.json`（含 preload/node_modules，原样目录）。
4. 打包上架不在一期（preload 合规性已按 R1 预留）。

## 12. 一期验收清单
- [ ] 添加订阅全管线：URL 直填/HTML 自动发现/常见路径探测/失败引导；复制 URL 一键订阅
- [ ] **删除订阅闭环：二次确认→feed/item/itemfull 级联清理无孤儿→统计校准；编辑订阅（改名/分类/频率）**
- [ ] 增量刷新：ETag、12s 请求超时、90s 总预算、并发3、guid+hash 判重、更新策略、unreadCount 对账、无新文推进时间戳
- [ ] 卡片/列表双视图虚拟滚动；阅读面板（sanitize 正文、字号4档、行宽≤42em）；已读/星标/全部已读
- [ ] 键盘流 j/k/Enter/m/s/Shift+A/Ctrl+F/Esc（**Esc 返回层级 × 宿主退出不冲突实测**）
- [ ] 搜索（SubInput+侧栏同源）；OPML 导入导出（分批/进度/断点跳过）
- [ ] 三态主题实时切换；分离窗三栏自适应（含 SubInput 摘挂）；侧栏折叠
- [ ] 新文章通知（可关）+ mainPush 建议位
- [ ] 空态三态（首用引导/分类无文/全部读完）；源错误红点+重试
- [ ] sanitize 白名单单测样本（script/iframe/svg/onerror 注入）；GBK 编码源解析；gzip 响应解压
- [ ] 保留策略清理（500/源，星标豁免，删除前复查星标）
- [ ] **首日 spike 回填**：allDocs 万级耗时（§9）；Esc 拦截（§10）

## 13. 风险与预案
| 风险 | 预案 |
|------|------|
| allDocs 万级耗时/内存 | 首日 spike（§9 方案 A→C 降级路径已定） |
| Esc 宿主/页面拦截优先级未知 | 首日实测，兜底=最顶层放行（§10） |
| rss-parser v3 对新 Atom 变体解析缺字段 | fast-xml-parser 兜底直解 + 坏源样本积累 |
| 参考图 hex 为目测值 | auto-designer 规范化调色（对比度达 WCAG AA），不逐像素复刻 |
| 分离窗尺寸未知 | onPluginDetach + ResizeObserver 自适应三栏/两栏切换 |
| dbStorage 云同步语义官方未明文 | 本机既有插件实测经验为随云同步；设置页文案按"多端共享"表述，若实测不符再改 |
