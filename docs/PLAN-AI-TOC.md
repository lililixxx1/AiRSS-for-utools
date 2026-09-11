# PLAN-AI-TOC — AI 目录与 AI 工具面板

> 2026-09-09 grilling 共识落地方案。前置阅读：AGENTS.md「AI 管线要点」、docs/PLAN-ENHANCE.md（v1.2 翻译/缓存/额度惯例——本方案大量照抄其骨架）。

## 0. 目标（共识备忘）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 目录来源 | 混合：正文自带结构标题 ≥2 → 前端秒出；否则长文走 AI 生成分段目录 |
| 2 | 触发与额度 | 前端提取无条件自动；AI 生成手动触发，手动池（120/日，BYOK 豁免） |
| 3 | 展示形态 | 顶栏撤翻译按钮换「AI」sparkle 按钮（带任务态点）→ AI 浮层面板（Teleport+fixed，C17 纪律），三区：目录 / 摘要 / 翻译 |
| 4 | 跳转交互 | 点条目平滑滚动锚段（reduced-motion 瞬时）→ 面板收起；重开面板按滚动位置高亮当前章（打开时算一次） |
| 5 | AI 输入口径 | 全量段落列表，每段截 200 字、总量 10000 字上限，超出面板标「仅覆盖前 X%」；锚定 `{idx + head 前 20 字}` |
| 6 | 存储与缓存 | `item.aiToc` 可选字段（schemaVersion 仍 3）+ 纯内容缓存键；contentHash 变化 / itemfullx 全文替换连带清空；前端目录不落库 |
| 7 | 出现门槛 | 目录区 = 结构标题 ≥2 或正文 ≥1500 字；「AI 生成」按钮 = 结构标题 <2 且 ≥1500 字；数字常量收口 |

**对共识备忘 #6 的一处修正（自查发现）**：缓存键不用 `{contentHashTrunc}:{paraCount}`，改照 `ai:trans` 的**纯内容键** `ai:toc:v1:{sha12(joined)}`。理由：extract.js 全文替换**不更新 item.contentHash**（只删 aiTrans，extract.js:135-141），挂 contentHash 的键在替换后会命中旧目录缓存并写入 head 全失配的死 aiToc；纯内容键下新正文新段落新键，天然免疫，且保住「联播同文跨源复用」的共识收益。

**非目标**：不做常驻侧挂目录栏、不做滚动持续高亮跟踪、不做用户可配门槛、前端目录不落库、AiSummaryCard 仍在正文原位（面板只收动作与状态，不搬视觉主角）、列表侧（ArticleRow/ArticleCard）的手动摘要按钮不动。

## 1. 数据模型（db.js ↔ src/types/index.ts 双侧同步）

```ts
/** AI 目录产物（纯数据，无 HTML）：sections 与全文段落按 idx+head 对位（同 aiTrans 口径） */
export interface ArticleAiToc {
  sections: { title: string; idx: number; head: string }[]; // title ≤24 字（preload 裁）；head 由 preload 从输入段落补全，AI 不回写（防编造）
  at: number;
  model: string;
}
```

- `Item` 增加可选字段 `aiToc?: ArticleAiToc`（旧文档缺失按 undefined 读，schemaVersion 留 v3 桶，v1.2/v1.3 同惯例）。
- 覆盖率不入库：由渲染层用「sections 末条 idx ÷ 当前全量段落数」现算（正文变了 head 校验也会拦，存了反而陈旧）。
- **失效联动（T-09 族，两处内嵌字段删除）**：
  - `preload/services/db.js` ingest contentHash 变化分支（db.js:152 `delete existing.aiTrans` 旁）：`delete existing.aiToc;`
  - `preload/services/extract.js` 落库 2（extract.js:138 `delete fresh.aiTrans` 旁）：`delete fresh.aiToc;`
  - retentionClean / deleteFeedCascade 按 `_id` 删文档，内嵌 aiToc 随文档消失，无需改（与 aiTrans 同）。

## 2. preload/services/ai.js — `generateToc(itemId, paras, opts)`

骨架完全照 `translateItem`（ai.js:742-841），差异点如下：

- **常量**（收口于 ai.js 顶部，渲染层镜像常量见 §3）：`TOC_MAX_PARAS = 200`、`TOC_PARA_CHARS = 200`、`TOC_MAX_CHARS = 10000`。
- **入口序**：`const claim = ++callClaim; const startedAt = Date.now();`（单飞纪律：渲染层发起前 `airss.ai.abort()`；claimGate 封双飞窗口）。
- **门控**：`!cfg.enabled → AI_DISABLED`；item 不存在 → `NOT_FOUND`；`!opts.bypass && item.aiToc?.sections?.length` → item 层命中直返 `{ok, aiToc, cached:true}`。
- **输入限幅**：过滤非法段后，逐段 `text.slice(0, TOC_PARA_CHARS)`、累计至 `TOC_MAX_CHARS` break；`joined = 段文本拼接`（缓存键原料）。截断覆盖率不入契约：面板统一由「sections 末条 idx+1 ÷ 当前全量段数」现算（§4），避免 covered 双口径漂移。
- **缓存**：`ai:toc:v1:{sha12(joined)}`（纯内容键，LRU 5000 via cachePut/cacheTrim）。缓存载荷形状固定 `{ sections: [{ title, idx }], model }`——**head 一律不入缓存**，命中后必经 `applyToc` 从当前输入 paras 重新补 head（跨源同文 DOM 差异由此免疫）；命中路径先 `supersededByExtract(itemId, startedAt)` 查 B-1，再 applyToc 回写。
- **额度**：`quotaCheck("manual", cfg)`，失败返回 `q.error`；成功路径 `countCall("manual")`，abort/失败但 `produced` 也计（F4 同款）。引擎调用 `callEngine(messages, { cfg, claim, stream: true })`——照翻译走流式但 onDelta 不透传（目录无流式 UI，只为沿用已充分验证的 abort/超时语义）。
- **prompt**（`buildTocMessages(list)`）：正文段落列表以 `<<< >>>` 栅栏包裹（T-58），逐行 `[[idx]] 段落文本`；指令要求按语义把文章划分为 3~10 个章节，每章输出一行 `[[起始段idx]] 章节标题`（≤24 字、客观中文、不带序号 emoji）。协议与翻译 `[[n]]` 行协议同构，抗流式噪声。
- **解析**（`parseTocOutput(text)`，仿 parseTransOutput ai.js:697-708）：正则 `/\[\[(\d+)\]\](.+)/g` 逐行取；`title` 截 24 字、去首尾空白；idx 数字校验；输出**按 idx 去重（同 idx 保首条）并升序**（防 AI 重复输出导致目录条目重复与覆盖率失真）；`count===0 → BAD_TOC_OUTPUT` 整体降级。
- **回写**（`applyToc(itemDoc, paras, parsed, model)`，仿 applyTrans ai.js:710-723）：
  - `db().get(_id)` H4 复验存在；
  - sections 的 `head` **从输入 paras 按 idx 补全**（`paras[idx].head`），idx 越界或 head 缺失的条目丢弃（渲染层 head 校验口径一致）；
  - `fresh.aiToc = { sections, at: Date.now(), model }` → `putRetry`（内置 plainClone，IPC 消毒）。
- **原子性与守卫**（照抄翻译）：H2——仅 `call.ok` 且 parse 成功才 `cachePut + applyToc`；abort 全弃；调用后再次 `supersededByExtract`（B-1，额度已计口径同 ai.js:831-835）；`cacheTrim()` 收尾。
- **日志**：`logger.info/warn("ai.toc", …)` 埋点全程，字段仅 `{itemId, engine, paras, inputChars, covered, ms, error}`（T-11：正文不入日志）。
- **导出**：`module.exports` 增 `generateToc`；`__test` 增 `buildTocMessages, parseTocOutput, applyToc` 与三个常量。
- **preload/index.js**：`ai:` 挂载对象（index.js:66）增 `generateToc: ai.generateToc` → 必跑 `node scripts/check-preload-mapping.js`。

返回值形状：`{ ok, aborted?, aiToc: object|null, cached: boolean, error: string|null }`。

## 3. 渲染层 — src/components/ReaderPanel.vue

- **collectParasAll()**：复制 `collectParas`（ReaderPanel.vue:167-182）去掉 `10 段 / 4000 字` 双上限（保留文档序、嵌套去重、≥10 字文本门槛），供目录锚点全量枚举。翻译继续用原 collectParas（前 10 段口径不动）。
- **collectHeadings()**：在 collectParasAll 结果上过滤 `h2,h3,h4` 元素（这些标签本就在选择器集合内，天然带 idx），返回 `{title, idx}`。结构标题数 = 其长度。
- **门槛常量**：`TOC_MIN_HEADINGS = 2`、`TOC_MIN_CHARS = 1500`（口径 = collectParasAll 文本总长）定义在 ReaderPanel 顶部，面板判定与按钮显示共用，防两处口径漂移。
- **runToc(bypass=false)**：若 `aiState==='loading'` 先 toast「已中断摘要生成」（单飞纪律会杀掉在飞的 enrich，先打招呼不让用户莫名看摘要半截消失）→ `window.airss.ai.abort()` → item 层有 aiToc 且非 bypass 直用 → `collectParasAll()` 映射 `{idx, head, text: 全文截 200}`（纯字面量数组，IPC 安全）→ `await window.airss.ai.generateToc(id, paras, { bypass })` → 成功后**按 `_id` 在 `data.items` findIndex 定位回写 `aiToc`**（await 之后定位，防 refreshAll 重建数组吃掉预捕获下标；同 summarizeItem data.ts:375 口径）。失败分支：`res.aborted || error==='ABORTED'` → **安静回 idle（有旧 aiToc 维持 done）**——被其他发起点的 abort 打断是正常节流，不弹假错（翻译同构，ReaderPanel.vue:244-247）；`QUOTA_EXHAUSTED`→「今日 AI 额度已用完」；`CONTENT_CHANGED`→安静回 idle；`NO_PARAS`→toast「没有可生成目录的段落」；其余→「目录生成失败：{error}」。状态机 `tocState: 'idle'|'loading'|'done'`。
- **jumpTo(idx, head)**：重枚举 collectParasAll → `blocks[idx]` 存在且 `head` 匹配 → `el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })` → 关面板。**失配分支**（正文已被提取替换/内容更新）：清 `item.aiToc` + resetToc 回「AI 生成目录」态 + toast「正文已更新，目录已失效」——杜绝「点了没反应」的死按钮（ReaderPanel.vue:274 同哲学）。锚段防顶栏遮挡：`.ra-content h2,h3,h4 { scroll-margin-top: 12px }`（数值以设计系统间距令牌为准）。
- **当前章高亮（打开时算一次）**：面板 open 时遍历 sections，取「块 offsetTop ≤ scrollTop+视口高×0.3 的最后一段」所在章。
- **生命周期清理（送审必改 2/3）**：① readerItemId watcher（切文路径）增 `resetToc()`——复位 tocState/tocSections 并**强制关闭 AI 面板**（面板 Teleport 到 body 不随 reader 卸载，不清即展示旧文状态、jumpTo 滚错文）；② `onBeforeUnmount` 同步兜底（「父级 v-if 同周期卸载的 watcher 被调度器跳过」已知教训，关闭路径必须自清）；③ `maybeExtractFull` 的 hit/fetched 替换正文分支同步 `item.aiToc = undefined` + resetToc——preload extract 只删库里的字段，渲染层内存不清则面板照列死目录、runToc item 层假命中（翻译靠 head 失配兜底存活，目录同样要显式清）。
- **顶栏改造**（ReaderPanel.vue:439-451）：删翻译按钮，原位换「AI」按钮（`I.sparkle`，`aiState==='loading' || trState==='loading' || tocState==='loading'` 时加 `.is-on` 呼吸点），点击 toggle AI 面板。
- **meta 行**（ReaderPanel.vue:472）：`showAiBtn` 的「AI 摘要」按钮撤走（收进面板摘要区）；`AiSummaryCard` 不动。
- **翻译状态机整体保留在 ReaderPanel**（runTranslate/insertTranslations 等不动），面板翻译区仅展示状态 + 转发点击——不搬逻辑只搬入口。

## 4. 新组件 src/components/AiToolsPanel.vue

- **定位**：照 DropdownSelect 模式（DropdownSelect.vue:8/95/131/168 注释与实现）——Teleport to body + fixed，开合时按触发钮 getBoundingClientRect 重算，外层滚动即关闭，`z-index: var(--z-toast)`（高于弹层）。宽度 ~300px、右侧对齐触发钮（左溢出钳制 ≥8px）。
- **props**：`open: boolean`、`anchor: DOMRect | null`、以及 ReaderPanel 透传的三区状态（`tocState/tocSections/tocCovered`、`aiState`、`trState/trProgress/trShown/translatable`、`showAiBtn`、`headings/longEnough`）与回调（`onGenerateToc/onJump/onRunEnrich/onTransBtn`）。组件纯展示 + 事件上抛，无自有业务状态。
- **目录区**：
  - `headings.length >= 2`：直列前端目录条目（点按 onJump）；
  - 否则正文 ≥1500 字：`item.aiToc` 有 sections → 列条目 + 末尾「仅覆盖前 X%」（X = `Math.round((末条 idx+1)/总段数*100)`，covered<0 即全量则不显示）；无 → 「AI 生成目录」按钮（`tocState==='loading'` 时转圈禁用；`aiEnabled===false` 时按钮显示但点击 toast「未开启 AI」）；
  - 都不满足：静态文案「文章较短，无目录」。
- **摘要区**：`aiEnabled===false` → 「未开启 AI 增强」（去设置的链接文案）；`showAiBtn`（=aiEnabled 且 aiAutoCount===0 且无摘要不忙）→ 「AI 摘要」按钮；已有摘要 → 「重新生成」；`aiState==='loading'` → 「摘要生成中…」（流式文本本体仍在正文 AiSummaryCard，不进面板）。
- **翻译区**：`!translatable` 隐藏整区；其余完整承接原按钮四态（翻译/翻译中 n/m/显示译文/收起译文/失败重试 title）。
- **视觉**：popover 惯例样式，区标题用小号 muted 文案，当前章条目 accent 左缘 3px（同 C16 语言），无私有 hex；不动 tokens.css（预计 check-theme-contrast.js 无需跑，若最终动了令牌则必跑）。

## 5. mock 层 src/lib/mock.ts

- `airss.ai.generateToc`：mock 实现按传入 paras 均分 3~5 节，标题「第 N 部分 · mock 目录」，head 取对应段前 20 字，600ms 延时返回 `{ok:true, aiToc, cached:false, error:null}`；**与 translateItem 同形回写 `it.aiToc` 并落 localStorage**（mock.ts:273-275 口径，防浏览器 dev 刷新即丢、与实机行为不同形）；`bypass` 时重新均分。

## 6. 测试与回归

| 层 | 动作 |
|----|------|
| scripts/test-ai.js | 增 ~15 项：parseTocOutput（正常/空/非法 idx/超长标题截断/多余文本行容错/**重复 idx 去重保首+升序**）、applyToc（head 按 idx 补全、**idx 查表非数组下标取**、越界条目丢弃、H4 复验、**缓存命中路径重补 head**）、generateToc（item 层命中、缓存纯内容键跨源命中、AI_DISABLED/NOT_FOUND/NO_PARAS、BAD_TOC_OUTPUT 降级、F4 abort 已产出计额、CONTENT_CHANGED 弃写、**TOC_MAX_CHARS 截断后 sections 末条 idx 反映覆盖范围**、bypass 跳缓存） |
| scripts/check-preload-mapping.js | index.js 挂载后必跑 |
| npm run typecheck | aiToc 类型双侧同步后跑 |
| 三套测试 + `--no-experimental-require-module` | preload 依赖未动，理论不需要；若 npm install 过则加前缀跑（AGENTS 纪律） |
| 浏览器回归 | `?view=reader`：AI 面板开合/三区状态/前端目录跳转/mock 目录生成/翻译迁移后四态可用/短文文案/**面板开着切文与关面板的状态清理/生成中被切文打断不弹假错/提取替换后死目录清理**；**detached 强制激活**（`pinia._s.get('ui').detached=true`，AGENTS 教训）复验面板 fixed 定位与跳转；reduced-motion 模式跳转瞬时 |
| check-theme-contrast.js | 仅当实际改了 tokens.css 配色时跑 |

## 7. 守卫对照表（实现时逐条自检）

| 编号 | 守卫 | 落点 |
|------|------|------|
| H2 | 流式原子性：仅完整成功才写缓存与 item | generateToc 成功分支 |
| F4 | abort 已产出计额度 | produced 标志 + countCall |
| T-58 | 正文 `<<< >>>` 栅栏 | buildTocMessages |
| T-11 | 日志不含正文/密钥/地址 | logger ai.toc 埋点字段白名单 |
| B-1 | 提取竞态弃写 | supersededByExtract（缓存命中后 + 调用后两查） |
| 切文/卸载清理 | resetToc + 强制关面板（watcher 与 onBeforeUnmount 双路径，v-if 卸载 watcher 被跳过教训） | §3 生命周期清理 |
| 提取替换（渲染层） | maybeExtractFull 同步清内存 aiToc + resetToc | §3 生命周期清理 |
| 死按钮防御 | jumpTo 失配 → 失效提示 + 回生成态；NO_PARAS 有文案 | §3 jumpTo / runToc |
| T-09 族 | 内容变化连带失效 | db.js ingest + extract.js 落库 2 |
| 单飞 | 发起前 abort + claimGate | 渲染层 runToc 入口 + ai.js claim |
| IPC 消毒 | 入参纯字面量、写库 plainClone | runToc 映射新对象；putRetry |
| C17 | 无原生弹层 | AiToolsPanel Teleport+fixed |
| reduced-motion | 跳转瞬时、无过渡依赖 | jumpTo + matchMedia |

## 8. 文件清单

| 文件 | 改动 |
|------|------|
| `preload/services/ai.js` | 增 generateToc/applyToc/buildTocMessages/parseTocOutput + 3 常量 + 导出与 __test |
| `preload/services/db.js` | ingest T-09 分支增 `delete existing.aiToc`（1 行） |
| `preload/services/extract.js` | 落库 2 增 `delete fresh.aiToc`（1 行） |
| `preload/index.js` | ai 挂载增 generateToc（1 行） |
| `src/types/index.ts` | ArticleAiToc + Item.aiToc |
| `src/components/ReaderPanel.vue` | collectParasAll/collectHeadings/runToc/jumpTo/当前章计算；顶栏与 meta 行按钮迁移；scroll-margin-top |
| `src/components/AiToolsPanel.vue` | 新建（~200 行） |
| `src/lib/mock.ts` | mock generateToc |
| `scripts/test-ai.js` | 增目录用例 |
| `AGENTS.md` | 落地后补 aiToc 记载（数据模型约定 + AI 管线要点一句） |

## 9. 交付阶段

- **A（preload）**：§1 §2 + test-ai.js + check-preload-mapping —— 独立可测。
- **B（渲染层）**：§3 §4 —— 依赖 A 的接口，mock/浏览器回归。
- **C（收尾）**：§5 mock、AGENTS.md 记载、全量回归。

## 10. 审核记录

2026-09-09 plan-code-reviewer：结论「需修改 → 修后可执行」。事实核对全部通过（方案引用的 ai.js/db.js/extract.js/ReaderPanel/DropdownSelect/index.js/data.ts 锚点无一错位；缓存键改纯内容键的推断——extract.js 落库不更新 contentHash——被验证成立且必要）。**4 项必改已并入正文**：① runToc 增 ABORTED 安静分支（防单飞互杀弹假错，§3）；② 切文/卸载/提取替换三路径的 resetToc 生命周期清理（Teleport 面板不随 reader 卸载，§3 生命周期清理 + §7 表）；③ maybeExtractFull 替换正文同步清内存 aiToc（§3 同条）；④ jumpTo 失配分支——失效提示+回生成态，杜绝死按钮（§3）。建议项 1-7（`_id` 定位回写 / parse 去重升序 / 缓存载荷形状（head 不入缓存）/ 覆盖率口径统一为 sections 末条 idx / mock 同形落库 / 门槛常量落点 / stream:true）亦已并入；建议项 8（中断在飞摘要的提示）以轻量 toast 实现并入 §3。

## 11. 实施与回归记录（2026-09-09）

三阶段全部落地。**测试**：test-ai 109 项（+24 目录用例）、test-db-mock 66、smoke 37、check-preload-mapping、typecheck、vite build 全绿。**浏览器回归（IAB + mock）**：结构文前端目录 4 条直出、跳转收起重开高亮当前章；无结构长文「AI 生成目录」→ mock 生成 3 节 → 跳转；「仅覆盖前 75%」覆盖标注；AI 关闭门控（条目仍列 + 摘要区「未开启」）；短文「文章较短，无目录」；面板开着切文强关；翻译迁移（顶栏已撤、面板四态、缓存译文自动展示 + 显示/收起往返 10 段）；detached 强制激活（fixed 定位 + 从顶跳末章 0→934=maxScroll）。

**回归发现并修复 1 个真 bug**：collectParasAll 初版沿用翻译的段落 ≥10 字文本门槛，h2/h3 标题文本天然短（如「背景与问题」5 字）被整体滤光 → 前端目录恒空。修复：h1-h6 不受字数门槛限制（其余文本块保留），AGENTS.md「AI 管线要点」已记。回归测试脚本的教训：打开面板后必须等一拍再查 DOM（Vue 异步渲染，同步 querySelector 拿到空列表是测试时序问题，非产品 bug）；IAB 面板被遮挡时定时器整族节流，mock 流式翻译不可作为等待对象（译文往返改用预置 aiTrans 缓存验证）。

## 12. 变更记录（2026-09-10，PLAN-TOC-LEVEL 目录层级化）

用户反馈「目录没有层次」（例 daily.juya.uk/rss.xml：h2/h3 结构清晰却平铺）。方案与审核闭环见 `docs/PLAN-TOC-LEVEL.md`，本文档只记协议级变更：

- **行协议升级 `[[idx|level]]标题`**：level 1=章 2=子章（prompt 限两级求稳），解析 `\|(\d+)` + JS clamp 1-3（越界 clamp 不丢行）、缺省 1；标题剥 `#` 前缀。
- **§47 载荷形状已过时**：缓存键 `ai:toc:v1:` → **`ai:toc:v2:`**，v2 载荷为 `{sections:[{title,idx,level}], model}`（仍不含 head，命中路径重补口径不变）。v1 存量由 cacheTrim LRU 自然淘汰。
- **输入行增结构标记**：段落带 `tag`（h1-h6，渲染层 runToc 透传，generateToc 限幅循环必须随重建对象透传）时行首加 markdown `#` 前缀（`[[idx]]## 标题`），prompt 声明其为原文标题标记。
- **前端结构目录层级**：tocHeadings 增 `level`，实际出现的 h2/h3/h4 标签秩排序后序号映射 1..n（纯 h3/h4 文章归一为 1/2，防全缩进与「无父级 lv3」孤儿）。
- **展示**：AiToolsPanel 目录条目按级缩进（lv1 加粗+组间距、lv2 缩进 22px、lv3 缩进 36px）；lv 规则置于 base 之后、.cur 之前（同特异度靠源序）。
- **兼容**：旧 item.aiToc（无 level）展示回退平铺（=现状），无手动重生成入口（runToc bypass=true 无调用点，现状如此），存量到 T-09 清空为止自然换新。

## 13. 变更记录（2026-09-10）：摘要成功后连带生成目录

**用户反馈**：「AI 摘要生成后，AI 目录列表怎么没有一并生成」。现状是 v1.4 访谈决策 2 的「目录手动触发」——enrich 与 generateToc 两条独立管线。用户期望目录搭乘摘要顺风车：摘要动作本身已是显式 opt-in（手动按钮或 aiAutoCount≥1），连带不算新增自动行为，不引入新设置项。

**改动**：`ReaderPanel.runEnrich` 成功分支（`res.ok && res.ai`）末尾，`prefetchNext` 之前：

```ts
ensureTocMeta();
if (!tocFromHtml.value && tocAiEligible.value && !it.aiToc) await runToc();
if (seq !== aiSeq) return; // 目录生成期间切文：预取随 resetAiStream 作废，不再发起
if (settings.aiAutoCount > 1) prefetchNext(...); // 原有行后移
```

**关键决策**：

1. **门控**：仅「无结构长文」（h2-h4 <2 且 ≥1500 字）且 `!it.aiToc` 才连带——结构文前端秒出目录零增量成本（juya 类文章摘要后不多花 1 次调用）；已有目录（含此前缓存命中/连带失败后 regen 摘要重试）不重跑。每次连带 = 手动池 +1。
2. **必须 await 且先于 prefetchNext**：`runToc` 入口与 `prefetchNext` 每步都按单飞纪律先 `window.airss.ai.abort()`——若目录与预取同时起飞互掐（后起飞者杀前者）。串行链：enrich → 目录 → 预取，代价是 aiAutoCount=3/5 档的预取延迟一次目录生成时长。runEnrich 的调用方均不 await（fire-and-forget），内部 await 无外溢。
3. **await 后补 seq 守卫**：原 prefetchNext 行是同步执行，await runToc 期间切文时 aiSeq 已变——必须 return（预取链随 resetAiStream 的 prefetchSeq+1 自然作废）。
4. **失败安静度沿用 runToc 现有口径**：额度尽弹「今日 AI 额度已用完」、引擎失败弹 toast——连带场景保留（用户在等目录，静默会让「摘要成功目录没出」再次成疑）。
5. **不连带的边界（明示）**：列表卡片「AI 摘要」按钮（summarizeItem，文章未打开无 DOM 段落）与「打开已有摘要的文章」分支（631 行，无 enrich 动作，**含 aiAutoCount≥2 被预取补实摘要后打开的文章——用户原始投诉路径在该档位仍会重现，属已知边界非遗漏**）不触发——这些文章目录仍走面板/轮盘手动生成。另有一处**内存中间态**（2026-09-11 审核补记）：jumpTo 的 head 严格校验失配会把 `item.aiToc` 置 undefined（530 行，只清内存不落库）——此后同会话内任何再次 enrich 都视作「无 aiToc」连带重跑一次目录（手动池 +1，用户未显式要求）。影响面小（需 head 失配与再次 enrich 同时成立），不做查库补判（成本不划算），按已知边界记录。
6. **并发防线（审核必改 1 更正）**：enrich **没有** CONTENT_CHANGED 弃写语义（applyAi 只做 H4 复验 + T-21，无 supersededByExtract；extract 落库也只清 aiTrans/aiToc 不清 ai）——fullText 源下 extract 与 enrich 并发时 enrich 照常 ok:true、连带照常发起；实际安全由 runToc 自己的 B-1 兜住（extract 在 runToc startedAt 之后落库 → 弃写返 CONTENT_CHANGED 安静回 idle；之前落库 → 目录对新正文生成，行为正确）+ maybeExtractFull 的 resetToc 兜底，无需新增防线。
7. **`await runToc().catch(() => {})` 一行隔离**（审核建议 4）：runToc 现全捕获不抛，但未来若改抛，runEnrich 的 catch 会把已成功的摘要翻成 error 态并跳过预取——隔离封死这层耦合。

**回归清单（审核建议 2/3 并入）**：mock 下①打开无结构长文（aiAutoCount=1）→ 目录自动生成——**等待方式用轮询 aiToc 出现（放宽超时），不可等待 enrich 流式完成事件**（mock enrich 是 sleep(24)×22 假流式，IAB 面板遮挡时定时器整族节流，§11 已实证）；②aiAutoCount=3 → 目录完成后预取仍执行（后续文章 aiStatus 变 done）；③结构文摘要后不发起目录调用（monkey-patch generateToc 计数）；④目录生成期间切文——**断言口径限 UI 态（tocState 回 idle、面板强关）**，mock 的 abort 是空操作、切文后旧文在 mock 下仍会拿到 aiToc（与实机 abort 全弃不同形，不断言数据面）；⑤已有目录文章 regen 摘要不重跑目录。落地后 AGENTS.md「AI 管线要点」补连带门控与串行链一句（审核建议 6）。

**实施与回归记录（2026-09-10）**：ReaderPanel runEnrich 成功分支落地（连带判定 + await 串行 + seq 守卫 + catch 隔离）。typecheck/build 绿。浏览器回归 5 项全过：①无结构长文摘要完成后目录自动生成（generateToc 计数 1、层级 1/1/2/1/1 两级）；②aiAutoCount=3 下目录回写 0.5ms 后预取链恢复（日志铁证 tocF enrich 发起并完成）；③结构文摘要不连带（计数 0）；④目录在飞时切文——面板强关、轮盘收起、新文自动摘要正常接力；⑤已有目录文章 regen 摘要不重跑（enrich 日志 4 行=两轮完整、计数保持 2）。回归环境备注：?view=reader 直达早于 ReaderPanel 挂载会被非 immediate 的 readerItemId watcher 错过（enrich 不自动跑）——回归必须用 j/k 键盘或 UI 真实路径开文；IAB 节流下 mock enrich 假流式单次可达 8s，轮询等待放宽 30s+；mock enrich 返回值不带 item 字段致 store 不回写（预取断言以诊断日志为准，mock 保真度既有缺口非本次引入）。
