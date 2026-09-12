# AGENTS.md — AiRSS（uTools 智能订阅阅读器）

一期核心阅读器 + 二期 AI 增强管线：Vue3 渲染层 + Node preload 服务层，运行于 uTools 宿主。设计语言为暖米白 + 单一橙色强调。

## 常用命令

```bash
npm install                         # 渲染层依赖（根目录）
cd preload && npm install           # preload 依赖（独立的第二个 package.json，勿合并）
cd .. && npm run dev                # 纯浏览器开发（mock 层兜底，无需 uTools）
npm run build                       # vite 构建 → dist/
npm run typecheck                   # vue-tsc --noEmit（仅覆盖 src/，preload 是纯 JS）
node scripts/smoke-preload.js       # preload 冒烟（37 项：XSS/GBK/解析/OPML/提取消毒/真实抓取）
node scripts/test-db-mock.js        # 数据层+端到端管线（66 项：判重/写序/保留/级联/双前缀搜索/ensureFull 状态机）
node scripts/test-ai.js             # AI 管线（85 项：enrich/缓存/额度/abort/轻量批/翻译/T-09/翻译×提取并发）
node scripts/check-preload-mapping.js  # preload/index.js 服务映射静态核对（防拼错实机炸）
node scripts/check-theme-contrast.js   # 多主题配色守门（warm 快照+令牌完整+对比度矩阵；改 tokens.css 配色必跑）
node scripts/bench-search.js [N]    # P3 内容搜索万级测量（itemfull+itemfullx 灌水，默认 12000）
python scripts/make-logo.py         # 重新生成 logo.png
```

浏览器 dev 直达状态：`?view=reader` / `?view=settings` / `?view=addfeed`。

## 架构边界（改代码前必读）

- **双包结构**：根 `package.json`（渲染层，vite/ESM）与 `preload/package.json`（Node16/CJS 锁定，如 p-limit@3）相互独立。preload 源码直供、不打包，node_modules 原样随包。
- **preload = 唯一数据/网络通道**：`preload/index.js` 挂 `window.airss = { db, feed, article, opml, scheduler, ai, log, sys }`。渲染层（src/）只能经 `window.airss` / `window.utools` 访问数据与网络，不得直接 fetch 或读写 utools db。
- **双道信任模型（安全基线）**：preload 是唯一 HTML 生产方（sanitize-html 白名单）。渲染层任何组件不得注入原始 HTML；正文一律走 preload sanitize 后的产物。
- **AI 密钥边界**：BYOK 密钥只存 `utools.dbCryptoStorage`、只在 preload/services/ai.js 内读取，**永不出 preload**（渲染层只能 `hasByokKey()` 探测）。BYOK 请求强制 https（http 需显式配置确认）且拒绝重定向。
- **无 router**：视图由状态机切换（stores/ui.ts），不要引入 vue-router。
- **mock 层**：纯浏览器 dev 时 `main.ts` 检测无 `window.airss/utools` 则装 `src/lib/mock.ts`（localStorage 存储，不做真实网络）。uTools 内 mock 完全不生效。注意：mock.ts 注释提到的 `api.ts` 并不存在，stores 直接调 `window.airss`。

## 数据模型约定（src/types/index.ts ↔ preload/services/db.js 一一对应）

- 文章 id = `guid‖link‖title` 的 SHA-256 前 12 位；contentHash 变化才覆盖内容；`read`/`starred` 恒保留；items 全部写入成功才推进 feed 元数据（写序）。
- 改文档结构必须双侧同步：先改 db.js 文档形态，再同步 `src/types/index.ts`。
- **schemaVersion = 3**（二期已落地，v1.2 增补字段同属 v3 桶）：item 增加 `ai: { summary, tags[], titleZh, titleNorm, aiSource: 'batch'|'enrich' }` 与 `aiTrans: { paras:[{idx,head,text}], at, model }`（段落翻译纯文本，可选，旧文档缺失按 undefined 读）；`aiStatus: 'none'|'done'|'error'`（pending 仅存在于调用方内存）。contentHash 变化时 ingest 会清空 ai 与 aiTrans 并复位 aiStatus/titleDisplay（T-09）。
- **titleDisplay 语义**：AI 改写标题的展示位（titleNorm > titleZh > 原 title；与原标题相同则等于 title）。titleNorm 口径 v1.2 起为"AI优化标题"（冗长/含糊/标题党→清晰客观中文，≤24 字）。
- **AI 缓存文档**：`ai:enrich:v2:{contentHashTrunc}:{titleHash}`（复合键，正文截 2000 字哈希；v2 = AI优化标题口径）、`ai:cls:v2:{titleHash}`、`ai:trans:v2:{sha12(joined)}`（纯内容键，feed 联播同文跨源复用），LRU 上限 5000；额度分池手动 120/日、后台 30/日（BYOK 豁免）存 dbStorage。
- **渲染层设置新增字段**（如 `aiAutoCount` 0/1/3/5，默认 0=关闭自动、逐篇手动 AI 按钮，2026-09 由 1 改 0；v1.3 的 `muteWords/highlightWords: string[]` 默认 []）：只动 `src/types/index.ts` 的 Settings/DEFAULT_SETTINGS（settings.ts 按 DEFAULT 键集序列化，旧数据自动 merge 默认值）。
- **v1.3 增量（全部可选字段，schemaVersion 仍为 3）**：`itemfullx:{item._id}` = 全文提取版（Readability 产物消毒 HTML，独立前缀**不写回 itemfull**——与 ingest 写序/contentHash 判重解耦；ingest 内容变化、retentionClean、deleteFeedCascade 均连带删它，T-09 同族）；`Feed.fullText?: boolean`（每源全文开关，默认关）；`Feed.order?: number`（拖拽排序：首次拖拽 initOrderOnce 批量赋值，此后新增源无 order 排末尾）；`ListFilter` kind 含 `'tag'`（定义在 data.ts）。searchContent 扫 itemfull+itemfullx 双前缀（同 id 去重）。
- **v1.4 增量（AI 目录 + AI 工具面板，PLAN-AI-TOC；可选字段，schemaVersion 仍 3）**：`item.aiToc: { sections:[{title,idx,head,level?}], at, model }`（AI 目录纯数据；head 由 preload `tocAnchorSections` 从**当前输入段落**按 idx 查表补全，AI 与缓存都不回写 head；level=目录层级 1-3，PLAN-TOC-LEVEL，旧数据缺失按 1 平铺读）；缓存 `ai:toc:v2:{sha12(joined)}` **纯内容键**（v2=两级层级协议，载荷 {title,idx,level} 不含 head）——extract 全文替换不更新 contentHash，挂它会命中旧目录写入 head 全失配死数据（送审确认）；失效联动 T-09 族三处（db.js ingest / extract.js 落库2 / ReaderPanel maybeExtractFull 清内存并 resetToc，Teleport 面板不随 reader 卸载必须强关）；前端结构目录（h2-h4 ≥2 个）不落库打开现算，**层级=实际出现的标签秩排序后序号映射 1..n（纯 h3/h4 归一为 1/2，防全缩进；PLAN-TOC-LEVEL）**；**v1.5 AI 入口=阅读区右下悬浮轮盘（PLAN-AI-WHEEL，设计系统 C19：hover 预览移开即收、点击展开锁定再点才收，摘要/翻译/目录三项左上弧排、点击直达动作；顶栏「AI」按钮已撤）**，AiToolsPanel 三区（目录/摘要/翻译；翻译按钮已从顶栏撤入面板，AiSummaryCard 仍在正文原位）由轮盘目录项打开、底部触发 place() 向上翻转；轮盘热区=容器 pointer-events:none + document mousemove 联合矩形保活，键盘焦点转移必须 nextTick（rAF 在节流/后台窗格被冻结会滞留球上，2026-09 回归实测）。

## AI 管线要点（改 preload/services/ai.js 前必读）

- **默认关闭**：`settings.aiEnabled`（渲染层）与 ai 配置 `enabled`（preload 侧硬门控）均默认 false；设置页开关经 `setAiEnabled` 双写保持同步，勿只改一侧。
- **诊断日志**：`preload/services/logger.js`（环形 500 条，dbStorage 持久，console 镜像）；ai.js/scheduler.js 已埋点，设置页「诊断日志」可复制/导出/清空。**纪律：BYOK 密钥/接口地址、完整正文一律不入日志（T-11）**。
- **流式兼容防御**（2026-09 AI 摘要截断问题加）：① resolve 后 150ms 宽限取更长者（防提前 resolve 竞态）；② 快照式流回调（给累计全文）自动检测切覆盖累计；③ 元信息各段允许跨行。改 callUtools 时勿删这三处。
- **卡死防御**（2026-09 实机假死问题加）：① 引擎调用 60s 硬超时（`engineTimeoutMs`，永不 resolve 也能退出）；② 渲染层流式 UI 80ms 节流（token 风暴会冻死渲染线程）；③ `main.ts` 宿主内 `window.airss` 缺失时显示致命错误页（preload 挂载失败不再白屏假死）；④ 全局 error/unhandledrejection 落日志。logger 落盘 1s 防抖（逐条写 dbStorage 是同步 IPC）。
- 双引擎：`utools.ai`（默认，流式，宿主 ≥7.0，特性检测 `typeof utools.ai === 'function'`）与 BYOK（OpenAI 兼容 `/chat/completions`，SSE 流式解析在 http.js `postJson`）。
- **enrich 合并调用**（打开文章，手动池）：一次产出 titleZh/titleNorm/tags/summary，头部元信息 `【titleZh】…【titleNorm】…【tags】…` 解析失败整体降级纯摘要；**流式原子性（H2）**——产物仅完整结束才写缓存与 item，abort/失败全丢弃，abort 已产出文本仍计额度（F4）。
- **轻量批**（刷新完成后 data.ts 自动触发，后台池，≤20 篇/批；**aiAutoCount=0 时不跑——2026-09-10 门控，用户关「自动摘要」= 不发任何自动 AI，勿按旧注释当 bug 修回**）：只发标题+首句，严格 JSON 回写；**回写前 get() 复验存在（H4），batch 永不覆盖 enrich 产物（T-21）**，按篇隔离失败。
- prompt 正文用 `<<< >>>` 栅栏包裹（T-58，正文内指令样文本不构成指令）。
- **AI 目录（v1.4；PLAN-TOC-LEVEL 层级化）**：`generateToc` 手动池，输入全量段落（每段截 200 字、总量 10000 字，超出面板标「仅覆盖前 X%」= 末章 idx+1÷全文段数）；`[[idx|level]]标题` 两级行协议解析（level 1=章 2=子章，缺省 1、越界 clamp 1-3 不丢行、标题剥 `#` 前缀；同 idx 去重保首 + 升序）；**输入行 h1-h6 段带 markdown `#` 前缀（`[[idx]]## 标题`，paras.tag 透传——generateToc 限幅循环重建对象必须随传 tag，漏传则标记静默失效）**；渲染层门槛常量 `TOC_MIN_HEADINGS=2`/`TOC_MIN_CHARS=1500` 在 ReaderPanel——**collectParasAll 里 h1-h6 不受段落 ≥10 字文本门槛限制**（2026-09 回归实测：短标题被滤光导致前端目录整体为空）。**摘要连带目录（2026-09-10，PLAN-AI-TOC §13）**：runEnrich 成功分支对「无结构长文且无 aiToc」自动 runToc——必须 await 且先于 prefetchNext（runToc 入口与预取每步都按单飞纪律 abort，并行互杀），await 后补 seq 守卫；结构文/短文/已有目录零增量；列表卡片 summarizeItem 与「打开已有摘要」分支（含被预取补实后打开）不连带，仍走面板/轮盘手动。
- **v1.3 全文提取联动（extract.js，改它前必读 PLAN-V1.3 §1.1）**：enrich 正文获取走 `getItemFullBest`（优先 itemfullx 提取版）；Readability 输出按不可信输入处理、一律过 sanitizeContent，相对 URL 先在 DOM 层绝对化（否则 scheme 白名单剥光）；**翻译/提取并发弃写守卫**——translateItem 写回前查 `itemfullx.at > t0` 则弃（CONTENT_CHANGED，防复活已被提取层清理的旧译文，渲染层安静回「翻译」态）；空 body（bot 挑战 202+0 字节）/截断 TOO_LARGE/短于 600 字各有独立错误码，渲染层统一安静降级无 toast；日志只记 {itemId,status,ms,error}（URL/正文不入，T-11）。

## 设计规则（改 UI 前必读 docs/design-system.md）

- 设计令牌在 `src/styles/tokens.css`；深色主题独立调校（非浅色反色），对比度结论见设计系统 §3.3。
- **多配色体系（v1.4，PLAN-THEMES）**：配色（`data-palette`：warm/sepia/sage/indigo）与明暗（`data-theme`）正交；warm 缺省两块逐字节锁定（改 warm 必须同步 `scripts/check-theme-contrast.js` 内嵌快照）；**改任何配色/加新配色必须过 `node scripts/check-theme-contrast.js`**；组件不得引入私有 hex（swatch 取色走 `--p-sw-*`）。
- `docs/preview.html` 是像素基准；z-index 阶、动效令牌、间距圆角均以设计系统文档为准。
- AI 视觉：AiSummaryCard 规范见设计系统 **C16**（accent-soft 底 + 左缘 3px accent-strong，AIGC 徽章恒显，失败降级不阻塞阅读）。

## 已知坑

- **ai.js 单飞纪律（2026-09 v1.2）**：引擎调用必须经 `callEngine`——其 `claimGate` 在起飞前比对发起序 `callClaim`（abort()/enrich/translateItem/batchEnrich 入口都自增），序号落后即自弃，封死"前奏中被 abort、注册时反而覆盖新调用句柄"的双飞窗口。绕开 callEngine 直调 `utools.ai`/postJson 会重现该窗口；渲染层发起任何 AI 调用（enrich/翻译/手动摘要/预取每步）前先 `window.airss.ai.abort()`。
- **preload 里 Node API 与渲染层对象 realm 不匹配**：preload 的 `new URL()` 产出的是网页平台 URL 对象，不是 Node realm 实例；把它传给 `http(s).get(urlObj, options, cb)` 会错位成 `(options, cb)`，报 "The listener argument must be of type function"。凡传给 Node 内置 API 的 URL 一律用**字符串**（2026-09 已在 http.js 修过）。同理警惕其他 `instanceof` 跨 realm 判定。
- **preload 服务映射拼错本地全绿、实机必炸**（retentionClean 拼错事故）：改 preload/index.js 挂载后必跑 `node scripts/check-preload-mapping.js`。
- **原生 `<select>`/`<datalist>` 弹层在 uTools 无边框窗内定位错位**（2026-09 实机：添加订阅选分类触发）：OS 原生弹窗坐标在 Electron 无边框窗里算错，页面 CSS 救不了。全站禁用，一律用 `DropdownSelect`/`ComboboxInput`（面板 Teleport+fixed，见 design-system C17）。
- **渲染层对象是 Vue reactive Proxy，utools IPC 结构化克隆不支持**：store 里的 feed/item 文档原样传给 preload 再进 `utools.db.put/bulkDocs` 会抛 "An object could not be cloned."（2026-09 实机日志定位：refreshOne/recalcUnread 全灭，而先 `db.get` 再写的 setRead/applyAi 正常——mock 层无 IPC 感知不到）。已修：db.js 的 `putRetry`/`bulkSharded` 入库前统一 `plainClone`；新增把渲染层对象送进 utools.* 调用的代码时，必须先克隆或只传原始值。**同族第二例（2026-09-07 实机）**：`settings.ts` 的 `set()` 曾把 `out[k]=this[k]` 直接送 `utools.dbStorage.setItem`——`muteWords/highlightWords` 是 reactive 数组，宿主内**每次设置写入都抛错**，且异常吞掉调用方后续语句（AI 开关的 preload 双写从未执行、浏览器 mock 不做克隆所以全绿）；已修为 `Array.isArray(v) ? [...v] : v`。任何 `dbStorage.setItem` 的对象载荷都要按此纪律消毒（theme.ts posCache 是模块级普通对象，安全）。
- **`transition: grid-template-columns` 会拖死渲染线程**（2026-09 实测 MCP 浏览器卡死）：侧栏折叠的 grid 轨道只能瞬时切换，禁止加过渡。
- **`.app` 必须显式 `grid-template-rows: minmax(0, 1fr)`；grid 子项不写 `height:100%`（靠默认 stretch）；分离窗 `.reader` 必须有 flex 高度链（2026-09-08 实机三连修）**：uTools 宿主最大化后曾出现 BrowserView 视口被压成 244px 窄条的宿主 bounds 异常，暴露出三处布局弱点——① 不写行轨道时隐式 auto 行被侧栏内容顶穿到 8167px（footer「设置/折叠」与 ⋯ 出画），`minmax(0,1fr)` 定高行轨道修复；② grid 子项 `height:100%` 改为默认 `align-self: stretch`（.sidebar/.main-col/.reader-col，stretch 对内容免疫）；③ **分离窗（detached）的 `.reader` 是 `position:relative` 且曾无任何高度约束**——`.reader-col` 是普通块容器，子元素 `height:auto` 被正文撑成整文高度（实机探针 clientH==scrollH==10012，永不溢出→滚轮无效），修法：`.reader-col{display:flex;flex-direction:column}` + `.reader.detached{flex:1;min-height:0}` + `.reader-scroll{min-height:0}`。**教训：detached 模式浏览器 mock 走不到（onPluginDetach 仅宿主触发），回归时用 `pinia._s.get('ui').detached=true` 强制激活**；非分离模式的 `absolute inset:0` 路径测过了不代表分离窗没问题。
- **分离窗三栏最小宽 1080（280+360+440），窗口窄于此阅读列被 overflow:hidden 裁出画、肉眼只剩两列**（2026-09-11 实机：最大化三列正常，调回默认尺寸 ~800px 变两列）：修法是窄幅自适应——`ui.winNarrow`（App.vue 挂 resize 监听，<1080 置位，onPluginDetach 内也重算一次防宿主不派发 resize）+ getter `ui.narrowDetached`（App/Sidebar 单一来源，勿各自合取分叉）驱动 `.app.detached.sb-auto`：侧栏自动降 64px 图标轨 + 列表/阅读列最低宽下调（≤704 media 再压一档至 260/280，地板 604），三栏恒可见；自动折叠**不写 `sidebarCollapsed` 设置**（有效折叠 = 用户设置 ∪ 窄幅，Sidebar 的展开钮在窄幅下同步隐藏防死键；折叠轨配搜索钮唤起浮层搜索面板 `ui.railSearch`，Ctrl+F 同路——分离窗侧栏搜索框是唯一搜索入口，勿再引入静默失搜）。纪律：`.sb-auto` 规则必须排在 `.sb-collapsed` 之后（同特异度按源序覆盖）；`.reader-col` 的 min-width 必须与轨道 min 同步下调（track 定长 min 不吃 item min-width，不一致会溢出轨道）；`.reader-bar` 已改 wrap 降级（窄阅读列四枚文字钮 ~400px 装不下换行两行，正常宽度单行不变），**AiWheel 悬浮球锚定 `.reader-body`（顶栏+滚动区容器，底栏之外）底距恒 12px、随底栏高度自然让位——勿改成 JS 测高/ResizeObserver 跟随，遮挡窗格里 RO 回调随渲染帧节流会滞留旧值**。
- **prefers-reduced-motion 下布局楔死**（2026-09 浏览器全功能回归发现并修复）：base.css 的 reduced-motion 块曾只压 `transition-duration`——property 默认 all 会把 grid-template-columns 等**布局属性**也送进过渡管线，撞 Chromium 轨道过渡不刷新 bug，侧栏折叠在「减少动画」系统（Windows Server/RDP 常默认开）上楔死在 280px。现改为 `transition-property: none !important`，勿改回 duration 方案。同类教训：tokens.css 注释声称的「--reading-fs 4 档由 fontLevel 驱动」曾从未实现（驱动代码在 App.vue watchEffect，删了字号就恒 16px）；阅读位置快照必须先于 `html=""` 捕获（onUpdated 节流保存会在空正文阶段把 0 写回存储）。
- **plugin.json 内嵌正则**：JSON 里的正则反斜杠必须写双份（`\\s`、`\\/`），漏写一个会报 "Bad escaped character"（2026-09 已修过一次，位置 584）。改完用 `node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf8'))"` 验证。
- **vite `base: './'`**：保证 dist 相对路径在 uTools file:// 下可加载，勿改。
- **utools.ai 的 abort**：返回 PromiseLike 带 `abort()`；流式模式 `await` 的 resolve 值是 void，内容要靠 streamCallback 自己累积。BYOK 的 abort 走 postJson 的 `register(destroy)` 句柄。
- 实机（uTools 宿主）待验证项见 README「实机待验证项」与 PLAN-PHASE1.md §12。
- **`watch(..., { immediate: true })` 的回调在 setup 执行期同步运行**（2026-09 位置记忆实测）：回调里引用声明在 watch 注册**之后**的 `let` 会撞 TDZ（`Cannot access 'x' before initialization`）；async 回调的抛错变 unhandledrejection，UI 无任何感知但该 watch 整条链路死亡（症状：正文空白、进度不存）。setup 内被回调引用的状态/函数一律先声明、后注册 watch。
- **父级 v-if 同周期卸载的组件，其 pre-flush watcher 会被调度器跳过**（2026-09 位置记忆实测）：`closeReader()` 置 `readerItemId=null` 与父级 `v-if` 卸载发生在同一刷新周期，ReaderPanel 的 readerItemId watcher 不再触发（且此刻 `ui.readerItemId` 已是 null，钩子里按它取 id 也取不到）。切文（组件常驻）靠 watcher 冲刷旧文进度，关闭（组件卸载）必须在 `onBeforeUnmount` 里用自记的 `lastReaderId` 兜底——两条路径都要有。
- **性能纪律（2026-09 全面优化落地，改回即劣化）**：① 刷新路径 `ingestFeed` 用两次前缀 `allDocs` 预取建 Map 查既有文档（逐条 get 是 2N 次串行同步 IPC，50 条的源=100 次往返）；② http.js get/post 带 keep-alive agent（订阅周期刷新与 AI 网关同源复用 TLS，勿删）；③ `parseFeedXml` 每 5 条让出主线程（sanitize-html 对大正文是 preload 线程 CPU 尖峰，与渲染层共线程）；④ data.ts getters 全部单遍扫描（categories 原是 O(源数×条数) 双遍 filter，任意已读翻转全量重算）；⑤ 阅读进度保存走 800ms 合并定时器 + 滚动监听（纯滚动不触发重渲染，原来读到底也不存）+ theme.ts posCache 内存缓存（AI 流式期间 80ms 一帧重渲染 × 全量 dbStorage 读写是双 IPC/帧）；⑥ **第二轮（2026-09-09，PLAN-PERF-2）**：ReaderPanel 段落枚举双缓存（key=html.value + contains 守卫堵跨源同文死引用；**resetToc 必须同步清 tocMetaKey**——同文重进 key 命中短路会让已清空的目录元信息恒空，回归实锤）+ 目录元信息惰性化（切文只排 rIC(800ms timeout) 预热，消费入口 ensureTocMeta 兜底——布尔 dirty 方案会在 `html=""→await getItemFull` 空窗被预热清脏致整篇恒空，勿改回）；markAllRead 免 loadAll（内存成员判定置 read + **每源未读实算赋值**，不能「减 n」——db 侧 unreadCount 陈旧底数会让徽标残留）；retentionClean 按需预筛（!starred 计数 > keep 才调，与 db.js 口径互为充要，两边注释互指勿单侧改）；AiWheel 热区 rect 在 openWheel 缓存（mousemove 逐次 getBoundingClientRect 在流式渲染期是强制 reflow 源）。
- **preload 传递依赖 ESM 漂移：本地全绿、实机 preload 整体挂死**（2026-09-06 实机日志定位：linkedom 0.18.13 依赖 css-select@7 纯 ESM（`"type":"module"`），uTools Electron 的 CJS loader 报 `require() of ES Module ... not supported`，preload 没挂上、window.airss 缺失；本地 Node ≥22.12 默认支持 require(esm) 所以三套测试全过）。已修：linkedom 精确钉 0.18.12（0.18.9–.12 依赖 css-select ^5 纯 CJS）+ extract.js 惰性 require DOM 引擎（漂移复发只降级全文提取，阅读主链路存活）。纪律：preload 依赖任何变动后，三套测试加 `--no-experimental-require-module` 前缀跑（精确模拟实机 loader）；锁版本用精确版本号，`~`/`^` 挡不住点版本悄悄换传递依赖。

## 敏感区域前置阅读

- 改 preload 服务 / 安全基线：`docs/PLAN-PHASE1.md`（§2 职责划分、§7 安全基线）。
- 改 AI 管线：本文件「AI 管线要点」+ `docs/PLAN-ENHANCE.md`（v1.2 AI 增强方案，H1-H5/F2/F4/F5/T-09/T-11/T-21/T-58 编号引用处；编号原始出处 airss-design.md v0.4 §5.2/§6 **不在本仓库**，属外部存档，找不到属正常）。
- 功能路线盘点（非实施方案）：`docs/PLAN-NEXT.md`——每项启动前仍按惯例出独立实施方案送审。
- 改任何 UI：`docs/design-system.md`。
- 交付/打包流程：PLAN-PHASE1.md §11 与 README「接入 uTools」。
