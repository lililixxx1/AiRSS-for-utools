# PLAN-V1.3 — 全文提取 / 关键词过滤 / 标签文件夹 / 组织补齐 实施方案

> 需求来源：`PLAN-NEXT.md`（2026-09-05 盘点产出的路线文档）确定的四条主线：
> P0 全文提取（Readability）、P1a 关键词过滤、P1b 标签智能文件夹、P2 组织补齐三小件。
> P3（搜索规模化）并入阶段 E 作测量项执行；P4（稍后读）待定不纳入本期。
>
> 执行纪律：本方案先经 plan-code-reviewer 审核通过后执行；每阶段完成后再送审，
> 审核通过才进入下一阶段。安全基线（PLAN-PHASE1 §7）与数据纪律（§4）不变。
> 路线依据与「明确不做清单」见 PLAN-NEXT.md §7，本文不再重复。
>
> 2026-09-05 首轮方案审核：**有条件通过 → 3 项必改已并入正文**——
> B1 阶段0 共享面未铺满（types/mock 被 A/B/D 交叉触碰，"A 与 B 不相交"声明不实）→
> §3 阶段0 扩为全量共享面清单，铺完后 A/B 并行方成立；
> B2 check-preload-mapping.js 服务表不含新 extract 模块，阶段0 验收假绿 → 变更清单
> 补入该脚本（services 表增 extractSvc）；
> B3 「全文替换后译文可恢复展示」按 head 严格匹配机制不可达成 → 改为**提取落库时
> 连带失效 item.aiTrans**（T-09 同族语义），验收同步改写。
> 11 条建议全部采纳（spike 依赖归属/GBK 页/NOT_FOUND 守卫/滚动行为/测试确定性/
> tag 收窄注明/hlTerms 上限文档化/折叠态/D2 措辞/P3 口径/降级去 toast）。
>
> 2026-09-05 阶段A+B 执行审核（两个 plan-code-reviewer 并行）：
> **均判有条件通过 → 必改已修**——
> A 轮必改：翻译与全文提取并发竞态（在飞 translateItem 的 applyTrans 会复活已被提取
> 清理的旧译文且按钮死锁）→ ai.js 增 `supersededByExtract` 弃写守卫（CONTENT_CHANGED）
> + ReaderPanel 安静分支与 done 态全失配强制重译兜底 + test-ai 并发回归用例；
> A 轮建议全采纳：spike 合成源固定（数值字节级稳定）/FETCH_TOO_LARGE 截断判败/
> error 串截 40 字符/env.d.ts 注释同步/错误码补文档。
> B 轮必改：filtered 的 oldest 比较器笔误（`a.pubTs-a.pubTs` 恒 0）/静音词文案与
> 「计数不剔除」口径矛盾 → 均已修；建议采纳：静音清空视图的空态专用提示
> （muted-empty，不谎称「全部读完」）、词条保留原始大小写。
>
> 2026-09-05 阶段C 执行审核：**通过**（无必改；建议 3 条——tag 空态文案中性化
> 已在阶段E 落地、tag 名归一职责归 ai.js 产出口记录在案、tag 大小写敏感系方案原文
> 语义保持）。阶段D 执行审核：**有条件通过 → 必修已修**——「默认」分类删除为空操作
> 且文案矛盾（菜单项隐藏 + reassignCategory from===to 守卫）；建议采纳：重命名撞名
> 提示引导走「合并到…」。
>
> 阶段E P3 测量结论（2026-09-05，`node scripts/bench-search.js`）：12000 篇
> itemfull+itemfullx 各半（~1KB/篇）灌水下，searchContent 1.5s 预算仅扫 ~2450 篇
> （约 20%）即 truncated，全扫推算 ~7s+ —— **维持预算截断降级（UI 已示「部分扫描」），
> 不开发倒排索引**；实机 IPC 开销另测（README 待验证项）。

## 0. 现状基线（探索结论，均已对照代码核实）

- **正文链路**：`db.js` 文档形态 `itemfull:{item._id}`（feed 自带 contentHtml 的消毒产物，
  ≤100KB）；渲染层 `ReaderPanel` 打开文章时 `db.getItemFull(id)` 单篇 get，无正文则降级
  summaryText 拼一段 `<p>`（`ReaderPanel.vue` watch 内）。
- **净化与抓取基建已齐**：`article.js` `sanitizeContent/htmlToText`（白名单+100KB 截断）；
  `http.js` `nodeFetch(url,{timeout,maxBytes})`（重定向≤3、gzip/deflate/br 解压、整体超时）；
  `feed.js` `decodeBuffer(buf, contentType)`（Content-Type charset→声明→utf-8 兜底，iconv-lite
  GBK 支持）已导出可复用。
- **AI 正文输入**：`ai.js` enrich 取 `dbSvc.getItemFull(itemId)` 后截 24KB→2000 字纯文本
  （`TRUNC_CHARS=2000`），复合缓存键含截断正文哈希。
- **过滤/标签现状**：`data.ts` `ListFilter` 只有 `all/unread/starred/feed/category` 五种；
  `Item.ai.tags[]` 已持续产出，在 `AiSummaryCard`（前 2 个）与 `ArticleCard`（列表卡）
  均有展示，但**无任何消费出口**（不可点、不过滤）。
- **组织现状**：feeds 按 `createdAt` 排序（`loadAll`）；`Feed.category` 扁平字符串、由源隐式
  聚合（`categories` getter），无重命名/合并入口；`EditFeedModal` 无 URL 字段。
- **搜索**：`searchContent` 只扫 `itemfull:` 单前缀（`allDocs("itemfull:")`），多词 AND、
  1500ms 预算截断。
- **preload 依赖约束**：`preload/package.json` `type:commonjs`，锁定 Node16/CJS 兼容
  （rss-parser@3 / p-limit@3 同理）；node_modules 原样随包，**新增依赖必须 CJS require
  可用且包体可控**。
- 已知坑沿用：渲染层对象过 IPC 前 `plainClone`（putRetry/bulkSharded 已兜底）；原生
  select 禁用（C17）；grid/布局变化禁过渡；preload URL 跨 realm 一律传字符串。

## 1. 总体设计

### 1.1 阶段 A（P0）— 全文提取

**形态**：摘要型源（feed 只有摘要/短正文）打开文章时，preload 抓取原文页面 →
Readability 提取 → `sanitizeContent` 消毒 → 独立缓存 → 渲染层替换正文。
每源开关 `Feed.fullText`（默认 false），失败**安静降级**回原摘要（不出 toast——
失败源每次打开都弹提示是打扰，静默换回摘要即可；此为对 PLAN-NEXT §1 文案的
收窄，特此注明）。

**新 preload 服务 `preload/services/extract.js`**，唯一导出 `ensureFull(itemId)`：

```
返回 { status, content, error }
  status: 'off'     源未开全文（feed.fullText 缺失/false，硬门控）；item/feed 文档缺失亦归此（删除/保留清理竞态下安静退出）
        | 'hit'     itemfullx 缓存命中
        | 'rich'    feed 自带正文已达标（≥FULLTEXT_MIN_CHARS），无需提取
        | 'fetched' 本次提取成功并已落库
        | 'error'   失败码（NO_LINK / FETCH_*〔TIMEOUT/HTTP_*/EMPTY_BODY/TOO_LARGE…〕/ EXTRACT_FAILED / EXTRACT_TOO_SHORT / NOT_FOUND / STORE_FAILED；
                   全部安静降级回原摘要，无 toast）
  content: 'hit'/'fetched' 时为消毒后 HTML，其余 null
```

流程（全部 preload 侧，渲染层零逻辑）：

1. **并发去重**：模块级 `Map<itemId, Promise>`，同 item 并发调用合流（快速切文再切回
   不重复抓）。
2. `get(itemId)` 取 item，`get(item.feedKey)` 取 feed；**任一为 null → `{status:'error',
   error:'NOT_FOUND'}`**（渲染层按安静分支处理，不弹错）。
3. `!feed.fullText` → `'off'`。
4. `get("itemfullx:"+itemId)` 命中 → `'hit'`。
5. `getItemFull(itemId)` 存在且 `htmlToText(full).length >= FULLTEXT_MIN_CHARS`（600，
   常量）→ `'rich'`。
6. `item.link` 为空 → error `NO_LINK`；否则 `nodeFetch(item.link, { timeout: 12000,
   maxBytes: 3*1024*1024 })`（**URL 传字符串**，realm 坑）。
7. `decodeBuffer(res.body, res.headers["content-type"])` 解码（GBK 页面沿 feed 管线同款
   兜底；HTML meta charset 不另解析，Content-Type 兜 utf-8——已知残留：无 Content-Type
   charset 的 GBK 老页可能乱码，spike 页面集**含 ≥1 个 GBK 中文页**实测乱码率并记录
   结论，必要时后续版本再补 meta 探测）。
8. DOM 解析 + `new Readability(document).parse()`；null / 空 content → error
   `EXTRACT_FAILED`。DOM 库选型（linkedom vs jsdom）由**阶段 0 spike** 定（见 §3）。
9. **相对 URL 绝对化**：在 DOM 层把提取结果内 `img[src]/a[href]` 的相对地址以
   `item.link` 为基址补全（否则 sanitize 的 http(s) scheme 白名单会把相对地址全剥）。
10. `sanitizeContent(art.content)`（Readability 输出按**不可信输入**处理，100KB 上限自动
    截断）；`htmlToText(clean).length < 600` → error `EXTRACT_TOO_SHORT`，**不落库**
    （下次打开可重试）。
11. 落库两件事（一次成功路径内完成）：
    - `putRetry({ _id: "itemfullx:"+itemId, content: clean, at: Date.now(), src: "readability" })`；
    - **连带失效旧译文**：`get(item)` 复验后若 `item.aiTrans` 存在 → `delete item.aiTrans`
      + `putRetry(item)`。译文是对「替换前正文」（摘要合成段）生成的，全文替换后必然
      head 失配无法重插（`insertTranslations` 按段首 20 字严格匹配）；与其留着一段永不
      匹配的死数据，首次提取落库时一并清掉（T-09「内容变则 AI 产物失效」同族语义，
      仅清 aiTrans——`ai.summary/tags` 基于摘要文本生成，仍成立，保留）。
12. 日志埋点只记 `{ itemId, status, 耗时 }`——**原文 URL 不入日志（T-11 同纪律）**。

**存储与联动（改 `db.js` 四处 + ai.js 一处）**：

- `itemfullx:{item._id}` 独立前缀，**不写回 itemfull**：itemfull 是 ingest 写序的一环
  （bulk 前取 `_rev`，冲突即 BULK_FAILED、etag 不推进），覆盖会与刷新管线互踩；
  独立前缀让提取层与判重层（contentHash/T-09）解耦。
- `ingestFeed` 内容更新分支（existing 分支，delete `ai`/`aiTrans` 处）：同步
  `db().remove("itemfullx:" + _id)`（remove 不存在文档已被现有 itemfull 同款调用容忍）。
- `retentionClean` / `deleteFeedCascade`：逐条补 `db().remove("itemfullx:" + d._id)`。
- `searchContent`：扩扫双前缀——`allDocs("itemfull:")` + `allDocs("itemfullx:")` 合并遍历
  （id 截前缀按各自前缀长度切），**同一 itemId 两前缀都命中需 Set 去重**后再输出；
  预算/分片逻辑不变。
- 新增 `getItemFullBest(itemId)`：优先 itemfullx、退化 itemfull；`ai.js` enrich 的正文
  获取（现 `dbSvc.getItemFull` 调用处）改用之——提取版正文更完整，摘要质量受益。缓存键
  含截断正文哈希，提取版出现后自然换键生成；item 层 `aiStatus=done` 短路保留旧产物
  （与 v1.2 prompt 升版同一先例口径，不做存量刷新）。

**渲染层（ReaderPanel 集成）**：

- watch 流程不变：先 `getItemFull` → 无则摘要兜底 → 立即渲染（**先出摘要，不阻塞**）。
- 渲染完成后若 `feed?.fullText` 为真：`window.airss.article.ensureFull(id).then(...)`，
  回包守卫 `ui.readerItemId === id`（迟到的旧文正文不得覆盖新文，同现有 getItemFull
  守卫）；`status` 为 `hit/fetched` 且 content 非空 → `html.value = r.content` →
  `await nextTick()` **重跑图片 lazy/no-referrer 处理** + `resetTrans()`（译文态回
  idle——旧译文已被 preload 侧失效，按钮回到「翻译」，用户可按新全文重译）。
- **滚动与阅读进度行为（明确定义）**：替换后**不重放**打开时的滚动恢复；`onUpdated`
  按替换后的当前比例继续保存进度（正文变长导致的进度比例变化属预期，文档化不改码）。
- 顶部不加新按钮（懒抓自动，开关在源上）；`readingMin` 随 html 自动更新；失败各态
  （NOT_FOUND/EXTRACT_*）一律安静保留原摘要，无 toast。

**每源开关**：`Feed.fullText?: boolean`（可选，undefined 按关）；`EditFeedModal` 增
「抓取全文」switch 行，说明文案「摘要型源打开文章时自动抓取原文（需站点可访问）」；
`preload/index.js` `sys.createFeed` 不设该字段（默认关）；mock 同形。

### 1.2 阶段 B（P1a）— 关键词过滤

**数据**：`Settings` 增 `muteWords: string[]` / `highlightWords: string[]`（默认 `[]`，
dbStorage 随 settings 序列化，**preload 零改动**）。

**语义（与搜索的 AND 刻意不同，文档化）**：静音/高亮均为**多词 OR**——任一词命中即
生效；静音是排雷，宁多勿漏。匹配面与搜索口径一致：`titleDisplay || title` +
`summaryText`，小写 includes。

**行为**：

- `data.filtered`：在现有 过滤→搜索 之后、排序之前追加静音剔除（`mutePaused` 为 true
  时跳过）。`mutePaused` 是 store 内存态（**不持久化**：暂停是临时检查动作，每次启动
  过滤默认生效）。
- **计数不剔除**：统计三卡 / 侧栏未读数基于全量 `items`，与 `filtered` 无关——计数是
  事实、列表是视图，混算会让用户怀疑丢文章。
- **可透视（必有）**：新增 getter `mutedInView`（当前过滤+搜索口径下被静音篇数）；
  `ArticleFlow` 工具栏（搜索状态提示旁）当 `mutedInView > 0` 显示「已静音 N 篇」按钮，
  点击切换 `mutePaused`，暂停时按钮高亮为「过滤已暂停」。
- 高亮词：`ArticleCard/ArticleRow` 现有 `hlTerms`（搜索词切高亮）扩展为
  `搜索词 + settings.highlightWords` 合并，复用 `highlightSegments`，零新机制。
  **上限口径文档化**：`highlightSegments` 保留 3 词上限（性能与视觉噪音考量，不改）；
  合并时搜索词在前——**搜索词 ≥3 时高亮词不显示属预期行为**，设置页文案不承诺
  「高亮词恒可见」。
- **markAllRead 影响明示**：全部已读基于 `filtered`——静音生效时静音项不被标已读，
  符合「所见即所标」直觉，属预期行为。

**设置页**：`SettingsView` 新增「过滤」组（通知组之前）：两个多行文本域（静音词/高亮
词，每行一个词），blur 时解析为非空数组 `settings.set`。

**不做**（v1 边界）：正则、按源词表、命中自动动作（自动已读/星标）、训练流。

### 1.3 阶段 C（P1b）— 标签智能文件夹

- `ListFilter`（定义在 `src/stores/data.ts`）kind 增 `'tag'`；`filtered` 增分支
  `x.ai?.tags?.includes(f.value)`。
- **入口一（摘要卡可点）**：`AiSummaryCard` tag 芯片改 `<button>`，emit `tag` 事件；
  `ReaderPanel` 绑定 → `data.filter = { kind:'tag', value }` + `ui.cursor = 0`（阅读面板
  保持打开，返回即见结果列表）。
- **入口二（侧栏标签区）**：`data` 新 getter `topTags`——`items` 扁平化 `ai.tags` 计数
  降序取前 8；侧栏「分类」区下新增「标签」区（芯片样式同 ai-tag），**无任何 tags 时
  整区不渲染**（AI 关闭用户不见空白，不制造「坏了」错觉）；折叠态与分类区一致
  （`v-if="!collapsed"`）不渲染。
- `ArticleFlow.viewTitle` 增 tag 分支（`# + value`）；空态走现有兜底分支不改。
- **范围收窄注明**：PLAN-NEXT §3 曾设想「摘要卡**与列表**上的 tag 均可点」；本期只做
  摘要卡 + 侧栏两个入口，`ArticleCard` 列表卡上的 tag 芯片**保持纯展示**（虚拟列表内
  嵌套过滤入口的价值待入口一/二验证后再议，特此注明偏离）。
- 持久化智能文件夹（命名文件夹 = tags/words 复合过滤）**本期不做**：先验证「点标签」
  的真实使用频率，v2 再议（PLAN-NEXT §3 已列）。

### 1.4 阶段 D（P2）— 组织补齐三小件

**D1 分类管理（重命名/合并/删除）**：

- `ui.ts` `ModalState` 增通用型 `{ type:'prompt', title, label?, initial?, suggestions?,
  onOk:(v:string)=>void }`；`src/App.vue` 渲染小型输入弹窗（有 `suggestions` 时用
  `ComboboxInput`，无则普通 input；样式复用 confirm 弹窗骨架）。
- 侧栏分类项加 ⋯ 菜单（复用 `fi-menu` 模式）：重命名（prompt，initial=现名）/
  合并到…（prompt + suggestions=其余分类）/ 删除分类（confirm 危险态，成员归「默认」）。
- `data.ts` 单一 action `reassignCategory(from, to)`：遍历 `category===from` 的 feeds 逐
  个 `saveFeed({...f, category: to})`（putRetry 自带冲突重试；feed 数量级小，逐个写无
  压力）→ `loadAll()`；当前 `filter` 命中该分类时同步改 value 或复位 all。删除分类 =
  `reassignCategory(name, "默认")`。
- 无 schema 变更（category 本就是字符串字段）。

**D2 手动排序（拖拽）**：

- `Feed.order?: number`（可选）；`loadAll` 排序改 `(order ?? Infinity) 升序` 兜底
  `createdAt`。
- **排序语义（口径修正）**：首次拖拽**前**全员保持 createdAt 序；首次 dragstart 触发
  `initOrderOnce()` 给当前全部 feeds 按现序赋 `order = index`（只此一次批量落库），
  此后全员显式排序；**之后新增的源（无 order）排在末尾**（`(order ?? Infinity)` 的
  自然结果）。拖拽仅改受影响项的 order 再持久化，避免「拖一个、全体重写」。
- 侧栏 `feed-item` 加 `draggable`（**折叠态禁用**——折叠态是首字徽标，无拖拽语义）；
  HTML5 DnD（dragstart/dragover/drop + dropzone 视觉线）；**重排禁一切布局过渡**
  （已知坑：grid/位移过渡拖死渲染线程，瞬时切换）。
- OPML 导出顺序随 `data.feeds`（loadAll 已按 order 排）自动生效，`opml.js` 零改动
  （opml 按 category 分组、组内按数组序，已核实）。

**D3 订阅 URL 可改**：

- `EditFeedModal` 增 URL 字段（initial=feed.url，保存时 `feed.normalizeUrl` 规整）。
- URL 变化时 `updateFeed` patch 扩为 `{ url, etag:'', lastModified:'', lastError:'',
  lastFetchedAt: null }`（`Object.assign` 覆盖，条件请求缓存作废）→ 保存后立即
  `scheduler.refreshOne(feed)` + `loadAll` + 结果 toast。
- `feedKey` 不变 → 已读/星标/AI 产物/阅读进度全保留。**已知代价（明示接受）**：新旧
  URL 内容重叠期同一文章因 link/guid 不同判重为两篇——换域场景旧源通常已停更，影响
  小。

## 2. 数据模型与接口面变更（双侧同步清单）

| 位置 | 变更 |
|---|---|
| `src/types/index.ts` | `Feed.fullText?: boolean`、`Feed.order?: number`；`Settings.muteWords/highlightWords: string[]`（默认 `[]`）（注：`ListFilter` 定义在 data.ts 不在此文件） |
| `src/stores/data.ts` | `ListFilter` kind 增 `'tag'`；`filtered` 增 tag 分支 + 静音剔除；`mutePaused` 态 + `mutedInView`/`topTags` getter；`reassignCategory`/拖拽持久化 action；`loadAll` order 排序；`updateFeed` URL 重置分支 |
| `preload/services/extract.js` | **新文件**：`ensureFull(itemId)`（含 NOT_FOUND 守卫、fetched 落库连带清 `item.aiTrans`）+ `__test` 暴露（thin 判定/绝对化/错误码/nodeFetch 注入点）；DOM 库依赖由阶段 0 定 |
| `preload/services/db.js` | 新增 `getItemFullBest`；`ingestFeed` existing 分支删 itemfullx；`retentionClean`/`deleteFeedCascade` 连带删 itemfullx；`searchContent` 双前缀 + Set 去重 |
| `preload/services/ai.js` | enrich 正文获取改 `getItemFullBest`（单点改动，流式/额度/缓存纪律零触碰） |
| `preload/index.js` | `article.ensureFull = extractSvc.ensureFull` 一个映射（新增 `require("./services/extract.js")`） |
| `scripts/check-preload-mapping.js` | **services 常量表增 `extractSvc: "extract"`**——否则新服务的映射拼错本地全绿、实机必炸（已知坑的事故形态），阶段0 验收依赖本校验必须先补表 |
| `src/env.d.ts` | `AirssServices.article` 补 `ensureFull` 签名与 status 枚举 |
| `src/lib/mock.ts` | 同形补：`article.ensureFull`（mock itemfullx 表：一篇模拟 fetch 延迟产出提取版、其余 rich/off）；Feed.fullText/order、Settings 新字段的 mock 读写 |
| `src/stores/ui.ts` | `ModalState` 增 `prompt` 型 |
| `src/App.vue` | 渲染 prompt 型弹窗（路径在 src/ 根，不在 components/） |
| `src/components/` | ReaderPanel（ensureFull 接线/resetTrans/不重放滚动）、EditFeedModal（全文开关+URL）、SettingsView（过滤组）、ArticleFlow（静音指示/viewTitle tag）、Sidebar（标签区/分类菜单/拖拽）、AiSummaryCard（tag 可点）、ArticleCard/Row（hlTerms 扩展；Card 的 tag 芯片保持纯展示） |
| `scripts/` | 新增 `spike-readability.js`（阶段 0）；`smoke-preload.js`（提取消毒/XSS 用例）；`test-db-mock.js`（searchContent 双前缀去重、itemfullx 级联/失效、ensureFull 全状态机——**用 fixture HTML + stub nodeFetch**，不走真实网络，保证 off/hit/rich/fetched/error 五态确定性） |

schemaVersion 维持 3（新增字段全部可选、旧文档不改写，§4 迁移纪律）。

## 3. 阶段划分与并行策略

```
阶段0（串行，先行）spike + 全量共享面铺垫
   ├─ spike-readability.js：3~5 个真实摘要型页面（HTML 落 scripts/fixtures 缓存，
   │   其中 ≥1 个 GBK 中文页验证乱码率），linkedom 与 jsdom 双跑：
   │   ① CJS require 可用性（preload Node16 环境）② 包体增量
   │   ③ 提取长度/标题正确性 ④ 含 XSS payload 页面消毒后无脚本残留。
   │   四项全过取包体小者；linkedom 质量不过则 jsdom（包体代价接受并记录）。
   │   结论写入本文档附录。
   │   【依赖安装归属】spike 候选依赖装在临时目录（scripts/spike-tmp，不入
   │   preload/package.json）；选定后仅胜者写入 dependencies，败者不随包发布。
   └─ 铺全量共享面（A/B/C/D 都要碰的文件一次铺完，之后各阶段互不碰这些文件）：
      types/index.ts（Feed.fullText/order + Settings.muteWords/highlightWords 全部就位）
      src/lib/mock.ts（ensureFull 占位 + Feed/Settings 新字段 mock 读写）
      src/env.d.ts（ensureFull 签名）
      preload/index.js（article.ensureFull 映射 + require extract.js）
      preload/services/extract.js（最小占位导出，映射校验有真实目标）
      scripts/check-preload-mapping.js（services 表先补 extractSvc，映射校验真实生效）
      铺完即跑 node scripts/check-preload-mapping.js + npm run typecheck。
阶段A（智能体甲=主）P0 全文提取：extract.js 实现 / db.js 四联动 / ai.js 单点 /
        ReaderPanel / EditFeedModal 开关 / mock 完整化 / smoke+test 用例
阶段B（智能体乙）P1a 关键词过滤：SettingsView 过滤组 / data.filtered 静音 /
        ArticleFlow / Card+Row hlTerms
        ← 阶段0 已铺平 types/mock 共享面，A 与 B 此后文件集不相交，并行
  └─ A+B 完成后：两个 plan-code-reviewer 并行审核（含阶段0共享面对账），通过才进 C
阶段C（主）P1b 标签：ListFilter tag / Sidebar 标签区 / AiSummaryCard 可点 / viewTitle
  └─ 完成后送审，通过进 D
阶段D（主）P2 组织：prompt 弹窗 / reassignCategory / 拖拽排序 / URL 可改
  └─ 完成后送审，通过进 E
阶段E（主）文档同步 + 全量验证 + P3 测量项（见 §4）
```

data.ts 被 B/C/D 共享，三阶段按序串行；A 全程不碰 data.ts（阶段0 已把 A 所需的
types/mock 面铺完）。

审核口径（给 plan-code-reviewer 的固定输入）：方案阶段条目 + 涉及文件清单 + 安全基线
（§7：渲染层不注入 HTML、密钥不出 preload、正文消毒唯一产源——**Readability 输出同样
过 sanitizeContent**）+ 数据纪律（§4：写序、T-09 内容失效连带 itemfullx/aiTrans、
putRetry plainClone）+ AGENTS.md 已知坑清单 + 本文档 §1 对应小节。

## 4. 每阶段验收

- **阶段0**：spike 报告四项结论齐（含 GBK 页乱码率与 XSS fixture 消毒后无脚本残留
  断言）；`check-preload-mapping.js`（含新 extractSvc）通过；typecheck 全绿；胜者依赖
  已入 preload/package.json、败者未残留。
- **阶段A**：smoke（提取消毒用例）+ test-db-mock（fixture+stub：searchContent 双前缀
  同一篇双命中只回一次、ingest 内容变化清 itemfullx、retention/deleteFeed 级联无残留、
  ensureFull off/hit/rich/fetched/error/NOT_FOUND 状态机、fetched 连带清 aiTrans）全绿；
  浏览器 dev（mock）：开关关闭无任何行为变化、开启后摘要型文章先出摘要再替换全文、
  二次打开 hit 秒出、**已有译文的文章在全文替换后：译文被失效清理、翻译按钮回到
  「翻译」态、重译按新全文生成且段落对位正确**（不承诺旧译文恢复展示）、图片
  lazy/no-referrer 不回退、替换后滚动位置不被重放。
- **阶段B**：typecheck 全绿；浏览器 dev：静音词命中即隐且三卡计数不变、「已静音 N
  篇」透视与暂停可用、高亮词与搜索高亮共存（搜索词 ≥3 时高亮词不显示属预期）、
  全部已读不含静音项。
- **阶段C**：浏览器 dev：点摘要卡标签/侧栏标签过滤正确、AI 关闭时标签区不渲染
  （折叠态同不渲染）、tag 过滤与搜索/静音叠加符合交集直觉、列表卡 tag 纯展示不可点。
- **阶段D**：浏览器 dev：分类重命名/合并/删除后侧栏与过滤正确、首次拖拽前保持时间序、
  拖拽后排序持久化（重进不变）、此后新增源排末尾、URL 修改后条件缓存重置并立即首抓、
  已读/星标保留。
- **阶段E**：`npm run typecheck` + 三套 node 测试 + `check-preload-mapping.js` +
  `npm run build` + 浏览器四视图回归；README 功能清单/AGENTS 数据模型要点增量写齐；
  **P3 测量项**：构造 **itemfull + itemfullx 合计** ≥1 万篇存量（脚本灌水数据），实测
  `双前缀 allDocs + 扫描`耗时，>500ms 则在 README 待验证项记录结论并按 PLAN-NEXT §5
  决策树处置（默认维持预算截断降级，不开发索引）。

## 5. 风险与不做的事

- **不做**：刷新期 eager 全量回抓（带宽/预算爆炸，懒抓已覆盖真实阅读路径）；paywall/
  反爬对抗（失败即安静降级）；提取版覆盖 itemfull（见 §1.1 存储设计）；按源词表/正则
  规则/自动动作；嵌套文件夹；持久化智能文件夹（v2）；稍后读（P4 待定另立项）；倒排
  索引（P3 决策树后手）。
- **风险登记**：
  ① linkedom 提取质量/兼容性（部分站点 DOM 怪癖）→ 阶段 0 spike 用真实页面双跑对比，
    jsdom 为兜底选项，包体增量 ~10MB 可接受但需记录；
  ② spike 候选依赖误入 preload/package.json 随包发布 → 临时目录安装纪律（§3 阶段0），
    阶段0 验收含依赖清单核对；
  ③ 相对 URL 被 sanitize scheme 白名单剥除 → §1.1 第 9 步 DOM 层绝对化，smoke 加断言；
  ④ itemfullx 与 itemfull 同 id 双命中 → searchContent Set 去重（阶段 A 用例覆盖）；
  ⑤ 慢站 12s 提取期间用户切文 → 渲染层 seq 守卫 + preload Map 合流，最坏浪费一次抓取
    无正确性问题；
  ⑥ ensureFull 回包替换 html 的连带面（译文/懒加载/滚动/进度）→ §1.1 渲染层集成点
    逐项定义（resetTrans、重跑 lazy、不重放滚动），阶段 A 验收逐项覆盖；
  ⑦ 分类批量重写与编辑弹窗并发写同一 feed → putRetry 冲突重试已兜底（3 次退避）；
  ⑧ 拖拽重排触发布局过渡卡死 → 禁过渡铁律，DnD 视觉仅用边框色/指示线；
  ⑨ 无 Content-Type charset 的 GBK HTML 页解码乱码 → spike 实测记录，必要时后续补
    meta charset 探测（本期不做）。

## 附录（阶段 0 回填，2026-09-05）

**结论：选定 linkedom@0.18.12（精确钉）+ @mozilla/readability@~0.6.0 入 preload 依赖；jsdom 不入包。**
> 2026-09-06 实机修正：原选型 0.18.13 把依赖升到 css-select@^7——纯 ESM 包，uTools Electron 的 CJS loader 拒载（`require() of ES Module`），preload 顶层 require 整体挂死；本地 Node ≥22.12 支持 require(esm) 掩盖了它，且下表判定①只验了 linkedom 本体 main、未扫传递依赖。降回 0.18.12（css-select ^5 纯 CJS，同一 0.18 线，下表质量结论不变），extract.js 改惰性 require 引擎兜底；今后升级 linkedom 前必须 `node --no-experimental-require-module` 全图 require 验证。

| 判定项 | linkedom 0.18.13 | jsdom 22.1.0（最后支持 Node16 的版本，23+ 需 Node18） |
|---|---|---|
| ① CJS require（Node16 目标） | ✓ main=cjs/index.js，engines `>=16`，preload 内 require 实测通过 | ✓ engines `>=16` |
| ② 包体增量 | **888KB，零传递依赖** | 7808KB，58 包依赖闭包（约 8.8×） |
| ③ 提取质量（4 真实页） | 4/4 过 | 4/4 过；**全页与 linkedom 同长同题（交叉完全一致）** |
| ④ XSS fixture（Readability→绝对化→sanitize） | 零脚本/事件/js-uri/iframe/style 残留，相对 img 绝对化后存活 | 同左 |

- **真实页集**：engadget 文章页、chinanews ×2（文页 656 字 + 图集页 171 字）、paulgraham
  greatwork（66521 字，老式手写 HTML 压力测试）。图集页 171 字两库一致 → 产品路径合理归
  `EXTRACT_TOO_SHORT`（图集本就少文字），非库质量差异。
- **ars 案例**：文章页返回 HTTP 202 + Content-Length:0（bot 挑战），空 body，两库同弃 →
  产品路径归 `EXTRACT_FAILED` 安静降级；extract.js 须把空 body 一并计入失败分支。
- **GBK**：chinanews 野外已转 UTF-8 未寻得真实 GBK 页；以真实页字节转 GBK 合成 fixture
  （覆盖 decodeBuffer 同一代码路径）：声明 `charset=GBK` 乱码率 **0**；**无 charset 声明
  U+FFFD 占 6.76%**（风险⑨量化坐实——utf-8 兜底必乱码，本期不修，已知残留记录在案）。
- **已知行为差异（入 extract.js 设计）**：linkedom 遇空/碎 HTML 在访问 `document.body`
  时抛 TypeError（jsdom 优雅返回 null）→ §1.1 第 8 步整体 try/catch 兜底 `EXTRACT_FAILED`
  必须覆盖构造与 parse 全程。
- **并发补充（执行审核 B-1）**：translateItem 发起记 t0，写回前查 `itemfullx.at > t0`
  则弃写（CONTENT_CHANGED）——防在飞翻译把已被提取清理的旧译文复活（ai.js
  `supersededByExtract`）。
- **Node16 运行时口径**：本地 Node24 实测 + engines 字段/入口形态核对；实机 Node16 回归
  列入 README 待验证项。
- 复现：`node scripts/spike-readability.js`（fixtures 缓存于 scripts/fixtures，离线重跑
  确定性；spike 候选依赖在 scripts/spike-tmp，不随包发布——**打包清单须排除该目录**，
  阶段 E 核对）；完整数据 `scripts/fixtures/spike-report.json`。合成 GBK fixture 的源
  固定为缓存中文件名排序第一个 `cn-gbk-*.html`（执行审核建议1，数值字节级稳定，
  重跑恒为 6.76%）。
