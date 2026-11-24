# PLAN-ENHANCE — v1.2 五项增强（2026-09）

> 需求原文（用户 2026-09-05）：
> 1. "噱头标题客观化、英文标题中文化"改为"AI优化标题、英文标题中文化"。
> 2. 增加AI翻译功能，翻译显示在每段文字之后。
> 3. AI摘要功能，可选择自动往下AI摘要几篇文章。
> 4. 如果关闭自动AI摘要功能，每篇文章会显示ai功能按钮。
> 5. 加强插件的内容搜索功能。
>
> 执行纪律：本方案先经 plan-code-reviewer 审核通过后执行；每阶段完成后再送审，
> 审核通过才进入下一阶段。涉及的安全基线（PLAN-PHASE1 §7）与数据纪律（§4）不变。
>
> 2026-09-05 首轮方案审核：有条件通过 → 4 项必改已并入正文（阶段0 认领 index.js 映射与
> mock 文案；=0 模式"有摘要"判定改 `ai.summary` 非空；预取/runEnrich 前置 abort；
> App/Sidebar 归入阶段 D 并统一走 setSearch）。7 条建议全部采纳（=0 摘要卡初始化与
> 总开关联动、翻译解析防 `[` 截断、搜索扫描代际、存量标题口径明示、mock 归属去歧义、
> C 阶段回归高亮、翻译进度快照流降级）。

## 0. 现状基线（探索结论）

- 标题改写已存在：`ai.js` enrich/batch 两处 prompt 产出 `titleZh`（英文→中文）与
  `titleNorm`（仅"噱头/标题党"才改写），回写 `item.titleDisplay`（titleNorm>titleZh>原题），
  设置开关 `aiTitle`。需求 1 是**语义放宽 + 命名更新**，不是新功能。
- 摘要现状：开启 AI 后打开文章即 enrich（流式、手动池 120/日）；刷新后另有轻量批
  （仅标题/标签，后台池 30/日）。没有"连续摘要"与"手动按钮"概念。
- 搜索现状：`data.filtered` 只匹配 `title + summaryText`（toLowerCase includes），不搜正文；
  itemfull（消毒 HTML ≤100KB/篇）只在打开文章时单篇 get。
- 渲染层正文渲染：`ReaderPanel` v-html 唯一信任源是 preload `sanitizeContent` 产物；
  渲染层禁止注入原始 HTML（可用 createElement+textContent 插入纯文本节点）。
- 已知坑沿用：preload 与渲染层同进程，重循环须 sleep0 分片；utools IPC 结构化克隆
  （入库前 plainClone 已兜底）；原生 select/datalist 禁用（C17 组件替代）。

## 1. 需求拆解与总体设计

### 需求 1 — AI优化标题、英文标题中文化（阶段 A）

`titleNorm` 语义从"噱头客观化"放宽为 **AI 优化标题**：原标题若冗长、含糊、标题党、
营销腔、堆砌关键词 → 输出清晰、客观、信息完整的中文标题（≤24 字、无感叹号、
不保留悬念）；原标题本身已清晰则留空（不硬改）。`titleZh`（英文标题中文化）语义不变。
展示优先级 titleNorm > titleZh > 原 title 不变。

改动点：
- `ai.js` `buildEnrichMessages` / `buildBatchMessages` prompt 文案改写（标记名
  `【titleNorm】` 不变，解析器零改动）；`pickDisplayTitle` 注释与长度上限（30 字符截断）不变。
- **缓存键升版**：`ai:enrich:{hash}:{hash}` → `ai:enrich:v2:{...}`、`ai:cls:{hash}` →
  `ai:cls:v2:{hash}`（prompt 语义变了，旧缓存产物是旧口径；前缀升版让下次调用重新生成。
  旧前缀缓存文档留给 LRU 自然淘汰）。item 层命中（aiStatus=done）不失效——内容没变，
  旧产物仍有效，用户点"重新生成"即按新 prompt 重出（T-09 纪律不破坏）。
- `SettingsView` 文案：设置项名"显示 AI 优化标题"，说明"AI优化标题（清晰客观改写）、
  英文标题中文化；关闭则一律显示原标题"。顺带修正隐私说明里过期的"约 4000 字"→"约 2000 字"。
- `types/index.ts` `ArticleAi.titleNorm` 注释同步；mock 层假产物文案同步。

### 需求 2 — AI 段落翻译（阶段 B）

**形态**：阅读面板顶栏新增"翻译"按钮（`I.languages` 图标，新增）。点击后 AI 整篇批量翻译，
译文以浅色引用块**插在每个原文段落之后**；再次点击收起/展开；重新打开文章时若已有译文
（`item.aiTrans`）自动展示。中文为主的正文不出按钮（渲染层预估 CJK 占比），
preload 侧再硬门控一次（不耗额度）。

**段落对齐协议（关键设计）**：段落切分在**渲染层**做（有真 DOM）——对 `contentEl`
`querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")` 按文档序取文本长度 ≥10 的块，
取前 ≤10 块、总字符 ≤4000（截断即"翻译前 N 段"）；把纯文本数组发给 preload。
preload 不碰 HTML，只发 AI、存纯文本译文 → **段落错位风险归零**，安全基线不破。

**preload `ai.translateItem(itemId, paras, opts)`**（新导出，挂 `window.airss.ai`）：
- `paras: {idx:number, head:string, text:string}[]`（head=原文前 20 字，校验用）。
- CJK 门控：全文 CJK 占比 > 0.5 → `{ok:false, error:"NO_NEED"}`，不调引擎不耗额度。
- 缓存：`ai:trans:v2:{sha12(itemId + ‖ + paras 拼接)}`，item 层已有 `aiTrans` 且未 bypass
  直接返回（cached）。
- 额度：手动池；调用/计数/abort 纪律与 enrich 完全一致（F4 已产出计入、H2 原子性）。
- Prompt：编号标记协议——user 内容为 `[[0]]原文\n[[1]]原文…`，system 要求逐段输出
  `[[n]]译文`，中文译文不加解释。解析 `/\[\[(\d+)\]\]([\s\S]*?)(?=\[\[\d+\]\]|$)/g`
  （切段边界=下一个标记或文本尾，译文含 `[` 不截断），缺失段跳过（按段隔离）。
- 流式：`opts.onDelta` 透传，渲染层累计后数已闭合的 `[[n]]` 标记显示进度"翻译中 3/8"。
  快照式流（宿主给累计全文的兼容路径）下进度计数可能停在 0/n，等待感由 loading 态兜底。
- 回写：`applyTrans(itemDoc, paras, transTexts)`——get() 复验（H4 同款），写
  `item.aiTrans = { paras:[{idx,head,text}], at, model }`（纯文本，无 HTML），putRetry 入库。
- `ingestFeed` 内容更新分支：`delete existing.ai` 处同步 `delete existing.aiTrans`（T-09 同源纪律）。

**渲染层（ReaderPanel）**：
- 状态机 `trState: idle|loading|done|error`（与摘要独立）；按钮文案 翻译 / 翻译中 n/m / 显示译文|收起译文。
- 译文插入：`document.createElement("div")` + `textContent = 译文`，`el.after(div)`；
  class `ra-trans`（浅色、左侧细 accent 缘、0.92em、text-2 色，与 blockquote 同族更弱）。
  **绝不用 innerHTML**（安全基线：渲染层不注入原始 HTML）。
- 收起：移除 contentEl 内全部 `.ra-trans`；展开：按 `aiTrans.paras` 重新插入
  （以 head 前 20 字与当前段落文本前 20 字比对防错位，不匹配段跳过）。
- 切换文章/关面板：复用现有 abort 纪律（`window.airss.ai.abort()`），产物按 H2 丢弃。

### 需求 3+4 — 连续摘要 N 篇 / 关闭时逐篇 AI 按钮（阶段 C）

两项合并为**一个设置**：`settings.aiAutoCount: 0 | 1 | 3 | 5`（默认 1 = 现行为，升级无感）。
- **≥1（自动）**：打开文章 → 现行 enrich 照跑（含缓存命中）；完成后在**当前过滤列表**
  （`data.filtered` 顺序）中向下取接下来 `aiAutoCount-1` 篇"无摘要"文章（判定
  `aiSource!=="enrich"`，即 `aiStatus==="none"` 或轻量批空摘要皆算无摘要），
  逐篇串行 enrich（无 onDelta，静默预取）。语义：翻到下一篇时摘要已是缓存命中，秒出。
  **中断纪律（审核必改 3）**：预取循环每步发起前先 `window.airss.ai.abort()`（保持
  single-handle 语义，绝不出现两个并发引擎调用）；`runEnrich` 入口（含 bypass 重新生成）
  统一先 `abort()` 再发起。这样任何新调用都会先回收旧句柄，无失去可中断性的路径；
  代际 token（readerItemId 变化/组件卸载）作为第二道保险。额度走手动池。
- **=0（关闭自动）**：打开文章**不再自动 enrich**。"有摘要"判定 = `item.ai?.summary`
  非空（审核必改 2：轻量批产物 `summary:""` 且 `aiStatus:"done"`，按 done 判定会出
  空白卡死路）——有摘要的文章打开时 `aiState` 直接初始化为 done 显示缓存摘要（不重算、
  不耗额度，"重新生成"在摘要卡上已有）；无摘要（含 batch 空摘要）的文章在
  ①阅读面板 meta 行显示"AI 摘要"按钮（sparkle 图标）②列表卡片/行的悬浮操作区显示
  AI 按钮（ArticleCard.meta-acts、ArticleRow.row-acts）→ `data.summarizeItem(item)`
  （手动 enrich + 同步 store 内存 + busy 态防重复点击）。
  AI 按钮整体受 `settings.aiEnabled` 总开关门控（总开关关 → 按钮不显示，与
  `ai.js` 的 AI_DISABLED 硬门控一致）。
- 设置页 AI 组新增行「自动摘要」：DropdownSelect（C17 组件），
  选项 `0 关闭（手动按钮）/ 1 仅当前 / 3 连续 3 篇 / 5 连续 5 篇`。
- 轻量批（刷新后补标题/标签）不受此设置影响（它不做摘要，且是后台池）。
- `settings.ts` `Settings` 增加 `aiAutoCount`，`DEFAULT_SETTINGS` 默认 1
  （dbStorage 旧数据按 DEFAULT merge，无迁移成本）。

### 需求 5 — 内容搜索加强（阶段 D）

- **preload `db.searchContent(query)`**（新导出）：
  - query 归一：trim + toLowerCase + 按空白拆多词（**多词 AND**）。
  - `allDocs("itemfull:")` 后逐篇 `content.toLowerCase()` 判 `terms.every(includes)`；
    **分片让出**（每 25 篇 `await sleep0()`）+ **时间预算 1500ms**，超预算即停并
    `truncated:true`（正文不跨 IPC，只回 id 列表）。
  - 返回 `{ ids, scanned, truncated, ms }`；ids 为去前缀后的 itemId。
  - 风险登记：`allDocs` 万级耗时是 README 未验证 spike；本功能接受 1.5s 预算截断的降级体验。
- **渲染层（data store，阶段 D 含 App.vue/Sidebar.vue 接线）**：
  - `setSearch(q)` action（审核必改 4：Sidebar 输入框 `@input`、utools 子输入框回调、
    ⌫ 清搜索三处统一改走它；`setSearch("")` 必须同步清空 `contentHits` 与扫描态）：
    写 `search` + 300ms 防抖后清空 `contentHits` 并调 `searchContent`（仅 q 非空且
    词项确实变化才发）；期间 `searchScanning=true`。
  - `contentHits: Set<string>`；`filtered` getter：q 非空时 = (title/summaryText 多词 AND 命中)
    ∪ (contentHits 含 id)；排序逻辑不变。防抖期间先出标题/摘要结果（渐进呈现）。
  - **扫描代际**（审核建议 3）：`scanSeq` 自增 token，防抖触发扫描时 `seq=++scanSeq`，
    回包 `seq!==scanSeq` 即丢弃（并发输入不叠跑两次 1.5s 预算扫描）。
- **UI**：
  - 工具栏（ArticleFlow）搜索态：右侧显示「N 个结果」，扫描中加转点与「正文中检索…」，
    truncated 时附「已扫描前 M 篇」提示（title 属性即可）。
  - **标题高亮**：ArticleCard/ArticleRow 标题按词项安全高亮——`highlightSegments(title, terms)`
  纯函数切 `{t, hit}[]` 段（上限 3 个词、每词首个匹配、总段数封顶），模板 v-for 渲染
  `<mark class="hl">`（文本节点插值，非 innerHTML；虚拟列表无额外开销）。
  - ⌫ 清搜索、Ctrl F 聚焦等现有键盘流不变。

## 2. 数据模型与接口面变更（双侧同步清单）

| 位置 | 变更 |
|---|---|
| `src/types/index.ts` | `Item.aiTrans?: { paras: {idx:number; head:string; text:string}[]; at:number; model:string }`；`ArticleAi.titleNorm` 注释改"AI 优化标题"；`Settings.aiAutoCount: 0|1|3|5`（默认 1） |
| `preload/services/db.js` | `ingestFeed` 内容更新分支加 `delete existing.aiTrans`；新增 `searchContent(query)` |
| `preload/services/ai.js` | prompt 改写 + 缓存键升 v2；新增 `translateItem(itemId, paras, opts)` 与 `applyTrans`；`__test` 暴露 `parseTransOutput`/`applyTrans` |
| `preload/index.js` | `db.searchContent`、`ai.translateItem` 两个映射（过 check-preload-mapping） |
| `src/env.d.ts` | AirssServices 补 `db.searchContent`、`ai.translateItem` 签名 |
| `src/lib/mock.ts` | 同形补：`db.searchContent`（扫 mock fulls）、`ai.translateItem`（假流式+假译文）、mock enrich 假 titleNorm 文案、设置默认值联动（browser dev 的 aiAutoCount 存 settings store，mock 无需额外） |
| `scripts/test-ai.js` | 新增：翻译标记解析 / CJK 门控 / 翻译缓存与额度 / abort 丢弃 / aiTrans 回写 get 复验；缓存键 v2 断言 |
| `scripts/test-db-mock.js` | 新增：searchContent 命中·多词 AND·预算截断；ingest 内容变化清 aiTrans |

schemaVersion 维持 3（新增字段全部可选、旧文档不改写，符合 §4 迁移纪律）。

**实施偏差登记（2026-09-05，阶段B 终裁注明）**：`ai:trans:v2:` 缓存键实作为
`sha12(joined)` 纯内容键（规格原文含 itemId）——feed 联播场景同文跨源命中，同 DOM
结构下 idx/head 天然对齐，插入侧 head 比对为第二道防线。CJK 门控在缓存查找之前，
共享键不会让中文正文绕过 NO_NEED。

## 3. 阶段划分与并行策略

```
阶段0（串行，体量最小）共享面铺垫 —— types / env.d.ts / mock.ts（含 mock titleNorm 文案，
        建议5）/ preload/index.js 双映射（db.searchContent + ai.translateItem，必改1，
        铺完即过 check-preload-mapping.js；映射指向的函数体随后续阶段实现，
        故阶段0先在 db.js/ai.js 落两个最小占位导出，mapping 校验才有真实目标）
        一次把多阶段共享文件的新增面全铺好，之后各阶段互不碰这些文件。
阶段A（智能体甲=主）AI优化标题：ai.js prompt+缓存v2 / SettingsView 文案 / test-ai
阶段D（智能体乙=general-purpose）内容搜索：db.searchContent 实现 / data.ts(setSearch+代际) /
        App.vue+Sidebar.vue 接线 / ArticleFlow 计数与扫描态 / Card/Row 高亮 / test-db-mock
                                        ← A 与 D 文件集不相交，并行执行
  └─ A+D 完成后：两个 plan-code-reviewer 并行审核（含阶段0共享面对账：占位导出真实存在、
     mapping 校验通过、mock 与 preload 同形），全部通过才进 B
阶段B（主）段落翻译：ai.translateItem 实现 / applyTrans / ReaderPanel 插入与开关 /
        languages 图标 / db.js ingestFeed 删 aiTrans（必改1）/ test-ai
  └─ 完成后送审，通过进 C
阶段C（主）连续摘要：settings.aiAutoCount 使用面 / ReaderPanel 预取+前置 abort+手动按钮 /
        Card/Row AI 按钮 / SettingsView 自动摘要行 / data.summarizeItem
  └─ 完成后送审，通过进 E
阶段E（主）文档同步 + 全量验证
```

审核口径（给 plan-code-reviewer 的固定输入）：方案阶段条目 + 涉及文件清单 + 安全基线
（§7：渲染层不注入 HTML、密钥不出 preload、正文消毒唯一产源）+ 数据纪律（§4：写序、
T-09 内容失效、H2/H4 原子回写、F4 额度）+ 本文档 §1 的对应小节。裁决通过才放行下一阶段。

## 4. 每阶段验收

- 阶段A：`node scripts/test-ai.js` 全绿（含新增 v2/解析断言）；grep 无"噱头"残留
  （docs 历史档除外）；设置页文案截图核对。
- 阶段D：`node scripts/test-db-mock.js` 全绿；浏览器 dev：多词搜索命中正文-only 文章、
  结果计数/扫描态/高亮正确、清搜索恢复。
- 阶段B：test-ai 翻译块全绿；浏览器 dev（mock 假流式）：按钮态机、逐段插入位置、
  收起/展开、重进自动展示、中文文章无按钮。
- 阶段C：typecheck 全绿；浏览器 dev：autoCount=1 现行为不变；=3 预取下一篇命中缓存；
  =0 打开不自动出摘要、列表与阅读面板出 AI 按钮、点击后摘要落库；**轻量批空摘要文章
  在 =0 模式显示 AI 按钮而非空白卡**（必改 2 验收）；搜索态下按钮与标题高亮共存（建议 6）；
  "重新生成"点击时预取立即中断（必改 3 验收，日志无双调用重叠）。
- 阶段E：`npm run typecheck` + 三套 node 测试 + `node scripts/check-preload-mapping.js`
  + `npm run build` + 浏览器四视图回归；README/design-system/AGENTS 增量写齐。

## 5. 风险与不做的事

- **不做**：标题字段改名（titleNorm→titleOpt 之类，schema 无谓翻动）；翻译逐段多次调用
  （额度爆炸）；搜索结果正文摘要预览（跨 IPC 传正文，成本高，v1 不做）；
  全文索引引擎（万级以下线性扫 + 预算截断够用，allDocs spike 结论落地后再议）。
- **存量文章口径（产品决策，审核建议 4）**：需求 1 的 prompt 升 v2 只影响新调用；
  已 done 的文章靠 item 层短路保留旧口径标题，用户点"重新生成"即按新 prompt 重出。
  本期不做存量懒刷新。
- **中英混排口径**：翻译按钮以整篇 CJK 占比 >0.5 判定"无需翻译"，中文为主夹英文段落的
  文章不出按钮（整篇判定的自然结果，不做逐段语言识别）。
- **风险**：① searchContent 的 allDocs 万级耗时/内存 → 1.5s 预算 + 分片让出 + 降级提示；
  ② 翻译长文一次调用输出长（4000 字入 → 译文 4000+ 字出），deepseek 系实测可能 20s+，
  按段上限 10 块/4000 字控制，进度计数缓解等待焦虑；③ 预取串行 enrich 在慢模型下占用
  手动池（120/日），设置项文案明示"连续 5 篇 = 每次预取最多 4 次调用"；
  ④ mock 与实机行为差异（已知坑清单），新增接口面在阶段0一次性铺完并过 mapping 校验。

## 变更记录（2026-09-10）：轻量批纳入 aiAutoCount=0 门控

**实机反馈**：用户已将设置「自动摘要」选为关闭（`aiAutoCount=0`），刷新完成后仍发起轻量批（日志 `[ai.batch] 批量调用失败 {"pending":20,"error":"ENGINE_TIMEOUT"}`）。根因：`data.ts queueAiBatch()` 只门控 `settings.aiEnabled`（AI 总开关），不看 `aiAutoCount`；设置页「自动摘要」开关绑定的是 aiAutoCount——用户理解的「关闭」覆盖一切自动 AI，实际后台批另走一路。附带的 ENGINE_TIMEOUT（60s 硬超时 chunks=0）属已知宿主节流线程（utools.ai 空输出），0 chunks 不计额度，防御本身正常——门控修复后该自动调用不再发起，症状自然消失。

**改动（最小面；审核必改 1 + 建议 1/2/3 已并入）**：

1. `src/stores/data.ts queueAiBatch()`：入口条件 `!settings.aiEnabled` → `!settings.aiEnabled || settings.aiAutoCount === 0`。语义定稿：**aiAutoCount=0（关闭）= 不发任何自动 AI**（阅读预取 prefetchNext 本就不跑 + 后台轻量批也不跑）；≥1 = 用户 opt-in 自动，轻量批恢复。两个调用点（refreshDue 完成后 / addFeed 首抓后）共用此入口，一处即覆盖（审核确认：importOpml 走 refreshDue 间接覆盖，无其他绕过路径）。
2. `src/components/SettingsView.vue` 两处文案：
   - 自动摘要 note 补半句：「关闭后刷新/新订阅也不再自动补标题/标签」（用轻量批实际产物措辞，不用含糊的"处理"）。
   - **总开关 note（审核必改 1）**：原「开启后打开文章自动生成中文摘要与标签，刷新后自动为新文章补标题」在默认组合（aiEnabled 开 + aiAutoCount=0）下两个承诺都不成立——改为条件化表述，自动行为统一挂「自动摘要」档位前提。
3. `AGENTS.md` AI 管线要点轻量批条目补门控前提（审核建议 1：「aiAutoCount=0 时不跑，2026-09-10 门控」，防后人按旧注释当 bug 修回去）。
4. **不改**：preload `batchEnrich` 的 `cfg.enabled` 硬门控（门控层级保持：渲染层管用户语义、preload 管引擎开关；审核确认 aiAutoCount 是渲染层概念，preload 配置面本就不含它，与 enrich/prefetch 门控同层一致）；ENGINE_TIMEOUT 超时/计额逻辑（审核确认批是非流式 countCall 在成功后才调、0 chunks 失败不计额，与 F4 不矛盾）；**用户切到 0 时在途批次（≤60s）不中止、产物照常落库**——勿改成切 0 调 abort：单句柄架构 currentAbort 唯一，会误杀用户正在看的流式摘要（审核建议 2 明示为不做）。

**审核确认的降级面**（aiAutoCount=0 下无一功能破坏）：ai.tags 消费方（ArticleCard 徽章/侧栏标签云/标签过滤入口）全为空态静默不渲染或不可达，标签云本就按空数组整区隐藏；搜索快路径 titleDisplay||title 兜底；手动按钮条件对无批产物文章恒真照常出现。

**回归检查单（长期）**：浏览器 mock 下 aiAutoCount=0 + aiEnabled=true 时触发 refreshDue/addFeed 不发起 batchEnrich（包装计数断言 0 次）；aiAutoCount=3 恢复 ≥1 次。test-ai / test-db-mock / typecheck / build 复跑（preload 无改动，防手滑 + 与三套测试惯例对齐）。
