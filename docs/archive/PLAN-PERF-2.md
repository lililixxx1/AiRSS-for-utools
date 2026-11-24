# PLAN-PERF-2 — 第二轮性能优化 + 轮盘出现动效打磨（2026-09-09）

用户诉求：①「出现轮盘的动作也要优化一下」；②「再优化一下插件的性能」。

范围纪律：**只动渲染层**（preload 上轮已优化且无新瓶颈证据）；无数据模型、无安全边界变化。
§1-§2 为性能，§3 为动效（同批实施）。

## 0 现状盘点（本轮不做的，及原因）

- 列表虚拟化（useVirtualList 可变高 + ResizeObserver 回填）、卡片/正文图片 `loading="lazy"` 已有。
- data.ts getters 已单遍化（categories/stats/unreadTopTitles）；搜索 300ms 防抖 + 异步正文检索已有。
- useVirtualList 的 `measured.set` 连续回填：Vue computed 惰性求值天然同 tick 合并（多次 set 只把 offsets 标脏一次），**无需批量回填改造**（曾列候选，盘点后撤销）。
- AI 流式 80ms 节流、进度保存 800ms 合并 + posCache 已有（上轮）。
- `.ra-content` 长文 `content-visibility: auto`：不做，两重理由——① 滚动高度随子树实际化
  抖动会破坏「按比例恢复阅读位置」语义；② collectParasAll/jumpTo/markCurrentSection 的
  innerText/rect 全量枚举会把跳过渲染的子树强制实化，收益归零还叠加高度抖动（审核 M-3 补强，
  防下轮翻案）。

## 1 ReaderPanel：段落枚举缓存 + 目录元信息惰性化

### 1.1 段落枚举缓存（innerText 是隐藏 reflow 大头）

`collectParas`（翻译口径，10 段/4000 字上限）与 `collectParasAll`（目录口径，全文）每次调用都
`querySelectorAll` + 逐元素 `innerText`（每段一次布局读取，长文几百段 ≈ 数十 ms）。调用点全是
用户可感路径：开目录面板（markCurrentSection）、目录跳转（jumpTo）、生成目录（runToc）、
译文插入/重译（insertTranslations/runTranslate）。

改法：setup 作用域缓存（`<script setup>` 顶层 `let` 编译进 setup() 体=每实例一份；App.vue 两处 v-if 互斥保证全局单 ReaderPanel 实例，当前与模块级等价——2026-09-11 审核更正，未来引入分栏等第二实例时保持每实例语义勿照字面升模块级），以 `html.value` 为 key（v-html 只换 innerHTML、`contentEl` 元素恒同一个，
html 相同 ⇒ 枚举结果相同；译文块 `.ra-trans` 是 div 不进选择器，插入不改枚举结果）：

```ts
let parasCache = { html: "", paras: [] as ..., all: [] as ... };
function parasAllCached() { ... 同现逻辑 ... }   // collectParasAll 改名/转发
function parasCached() { ... 同现逻辑 ... }       // collectParas 改名/转发
```

两个口径**各自独立缓存**（idx 序列不同：collectParasAll 豁免短标题、collectParas 不豁免，
不能互相派生）。切文/全文提取替换 html.value ⇒ key 变化自动失效，无手工失效点（低错配风险）。

**缓存命中守卫（审核 B-2）**：跨源同文（feed 联播同文跨源复用是真实场景）会让 html key
逐字节相同，但 v-html 已重建 DOM——命中缓存的 el 是脱节死引用（jumpTo 校验能过但
scrollIntoView 无效、译文插到脱节点、rect 全 0）。命中后一行连接性校验：

```ts
if (parasCache.all.length && !contentEl.value.contains(parasCache.all[0].el)) {
  parasCache = { html: "", paras: [], all: [] };
}
```

**纪律（审核 B-2 附）**：任何 collect\* 不得在 `html.value` 赋值与 DOM patch 之间被同步调用
（当前调用图满足——枚举入口全是用户事件或宏任务时点的预热，Vue patch 是微任务必先完成；
此句防未来新增调用点破坏前提）。

### 1.2 refreshTocMeta 惰性化（省打开长文主路径）

现状：切文 watch 内 `refreshTocMeta()` 在 `nextTick` 后立即跑一次 collectParasAll——打开长文
（300+ 段）的首次 innerText 全量扫描（≈30-50ms 强制布局）落在打开动画同帧，是可感卡顿源。

改法（审核 B-1 定稿：**key 幂等，弃布尔 dirty**——dirty 布尔会在 `html="" → await getItemFull
空窗`被 rIC 预热清脏，之后正文落地无人再置脏，整篇会话目录元信息恒空且静默）：

```ts
let tocMetaKey: string | null = null;
function ensureTocMeta() {
  if (tocMetaKey === html.value) return;  // key 幂等：吸收一切时序错位，html 落地后下次 ensure 自愈
  tocMetaKey = html.value;
  refreshTocMeta();                        // 内部走 parasAllCached()
}
```

- 切文/全文替换处只排**预热**（不再同步算）：`requestIdleCallback`（无 rIC 环境如 IAB 用
  `setTimeout 800ms` fallback），句柄存 setup 作用域变量（每实例一份，同 §1.1 缓存口径），切文入口与 `onBeforeUnmount` 取消（审核 S-7：
  晚到的预热对已换文/卸载组件跑空扫描，虽无害但脏且叠跑）；
- 消费入口全量先 `ensureTocMeta()`：`openAiPanel` / `onWheelToc` / `runToc` / `jumpTo`
  （runToc/jumpTo 的枚举走 §1.1 缓存，ensure 保证缓存已热）。

**行为红线**：`onWheelToc` 的分支判定依赖 `tocEntries/tocAiEligible`——入口必须先
`ensureTocMeta()`，否则元信息未算期 `tocAiEligible=false` 会把「无结构长文 AI 直达生成」
误降级为「开面板」（行为回归）。

**已知微窗（审核 S-4 处置：接受，不加接口耦合）**：resetToc 清零后、预热完成前（IAB 最长
800ms），轮盘目录项 title 可能短暂显示「生成 / 打开目录」而非「打开目录列表」——title 要
hover 到项上才显示，用户从球移到项的时长 ≥ 预热窗口，实际不可感；为压缩它给 AiWheel 加
hover 事件回传不值得（纯 UI 组件接口污染）。

## 2 data.ts：两条刷新/批量路径 IPC 削减

### 2.1 markAllRead 免 loadAll

现状：`markManyRead` 落库后 `await this.loadAll()`——万级条目时全量快照 IPC（结构化克隆 +
reactive 重建）阻塞主线程几十至几百 ms，而全部已读恰恰常用在条目最多时。

改法：markManyRead 返回标记数后，内存同步即终态，不 loadAll：
- `ids` 建 Set，一遍扫 `this.items` 按**成员判定** `if (idSet.has(x._id)) x.read = true`
  （ids 来自 filtered 视图，绝不能全量置——审核 S-5）；
- 侧栏源行读 `f.unreadCount`（feed 文档字段）：按 feedKey 归并被标记数，本地推
  `feed.unreadCount = max(0, unreadCount - n)`（统计三卡走 items 实算自动对）。

安全性论证：渲染层不存在直写 item 文档的路径（setRead/setStarred/enrich 回写均 preload 侧
get-fresh-再写，内存 `_rev` 过期无影响）；feed.unreadCount 本就是派生缓存字段（recalcUnread
对账口径），本地推与单篇 markRead 的现有做法（L355）同族。

**明示（审核 M-4）**：内存推 ≠ 落库——markManyRead 不写 feed 文档，db 侧 unreadCount 仍由
ingestFeed/recalcUnread 在下次刷新/云同步对账，陈旧窗口与现状一致、自愈；且此改顺带修掉
现状一个旧瑕疵——loadAll 会把 db 陈旧 unreadCount 拉回来覆盖单篇 markRead 的本地推。

### 2.2 retentionClean 按需调用

现状：`refreshDue` 收尾对**全部** feeds 串行 `await retentionClean(f, keep)`——每源一次前缀
`allDocs("item:{feedId}:")`，30 源 = 30 次全量前缀读，而常态（keep≥条目数）doomed 恒空。

改法：渲染层先按内存 items 预筛——`!starred` 计数 > keep 的源才调 preload（preload 侧逐条
get 复查 starred 的真相逻辑不动）。常态 30 次 IPC → 0 次；溢出源行为不变。
内存偏差方向只会「漏调」（下轮刷新补上），preload 复查挡「误删」，无正确性风险。

**等价性注释两边互指（审核 S-6）**：预筛判据与 preload 口径互为充要——preload 是
`filter(!starred) → sort(pubTs desc) → slice(keep)`，doomed 长度恰为
`max(0, cnt(!starred) - keep)`；此推导落在 data.ts 与 db.js retentionClean 两处注释互指，
防后人单侧改动（如 preload 改成全量 sort 后再豁免星标）让判据漂移成常态漏调。

## 3 AiWheel：出现动效打磨 + rect 缓存（与 PLAN-AI-WHEEL §7 变更记录 3 对应）

### 3.1 双层嵌套分段时序（"甩出 → 张开"的弧感）

现状：三项单层 transform（translate+rotate+scale 同缓动同时长）从球心直线弹出——轨迹是
直线插值，"死板"感来源。

改法：模板 button 内加一层 `span.ai-witem-in`（图标移入），两层拆分量：
- 外层 `.ai-witem`：translate（球心 → 弧位）+ opacity/visibility，`--t-med --ease-out` +
  delay `var(--d)`——快速滑出；
- 内层 `.ai-witem-in`：rotate(-50°→0) + scale(0.2→1)，`--t-slow --ease-spring` +
  delay `calc(var(--d) + 40ms)`——滑出途中弹性张开后回弹。

位移先到位、旋转/缩放后收口，合成近似弧线的"甩出-张开"。B2 语义不变（visibility/tabindex
仍在外层 button）；hover 回弹 `scale(1.12)` 迁到内层（transform 分量已归内层管）。

### 3.2 涟漪 + 球体抬升

- `.ai-wheel.open .ai-ball::after`：一次性涟漪，420ms ease-out。**基础态 `opacity: 0`**
  （审核 S-1：reduced-motion 瞬切与正常播完都回落基础态，基础态若非 0 会残留半透明圆片）；
  keyframes `0% { opacity: .45; transform: scale(1); } 100% { opacity: 0; transform: scale(1.9); }`，
  不依赖 fill-mode。class 摘除再添加即重播。::after 绘制序在图标层之后会短暂罩住图标
  （半透明、420ms，可接受；不用 z-index:-1 垫底——该招依赖球恒有 ai-float 动画创建的
  stacking context，删 float 动画即失效沉底，注释注明）。
- 球体 transform 已被 ai-float 占用（paused 停帧），不做本体缩放；改为 open 时
  `box-shadow: var(--shadow-2)` 抬升 + 现有 icon 层弹性，足够。
- 收起方向保持 t-fast 快速收拢（用户预期快速消失），不追加错峰。**内层收起态 transition
  必须显式 t-fast**（审核 S-2：仅 `.open` 下覆写为 slow+spring+40ms，否则收拢时旋转缩放按慢
  弹簧走与外层位移错拍）；旧的单层 `.ai-wheel.open .ai-witem:hover` transform 覆写规则
  整条删除，hover 回弹写进内层，不留打架规则。

### 3.3 视觉语义确认（审核 S-3）

双层拆分后：圆形气泡本体入场只 translate+淡入（不再缩放），弹性「张开」发生在图标层；
busy 旋转环 ::before 与 done 角标 ::after 留在外层 button——不随入场旋转、不随 hover 放大
（环更稳、角标不歪）。这与旧「整钮弹性扇开」是两种观感，属预期目标「甩出→张开」；
验证单加目验对照项，实机 reduce-off 环境最终目验。

### 3.3 rect 缓存（顺带性能）

`inHotRect` 每次 mousemove 调 `getBoundingClientRect`——AI 流式 80ms 一帧重渲染期间布局
反复脏，每次读都强制 reflow。改：openWheel 时缓存 rect，mousemove 读缓存（球 absolute 于
.reader 不随正文滚动移动，rect 在 open 期间恒定；resize 极端场景接受陈旧值，重开即新）。

## 4 验证计划

- `npm run typecheck` / `npm run build` / `node scripts/check-theme-contrast.js`。
- 浏览器回归（mock）：
  - 目录三态（结构文秒出 / 短文文案 / 长文 AI 生成入口）在**切文后不预热也正确**（ensureTocMeta
    兜底）——**临时屏蔽 `window.requestIdleCallback` 强制走 setTimeout fallback 分支再测一遍**
    （审核 M-1：浏览器恒有 rIC，fallback 分支 mock 里走不到，必须显式屏蔽）；预热后面板零等待；
  - 译文插入/重译/切文残留（缓存 key 正确性）、目录跳转锚定不回归；
  - 全部已读：前置 filter=all、无搜索、无静音命中（审核 S-5），三卡归零 + 侧栏源未读徽标归零 +
    未读视图全读后列表收缩与 cursor 钳制 + 重开插件数据一致（内存推 = 库实态）；
  - 刷新路径：mock 抓取后列表/计数正常（retentionClean 按需不误伤）；
  - 轮盘：点击展开（双层动效类接线、涟漪元素存在、涟漪基础态 opacity 0 无残影）、hover 项回弹
    （内层规则）、Esc/再点收起（B2/B3 不回退）、键盘焦点链、热区移开收起（rect 缓存后行为等价）；
  - **reduced-motion 专项**（审核 M-2）：本机 prefers-reduced-motion=true 天然覆盖——轮盘展开
    瞬时终态、涟漪不可见、无半透明残影。

## 5 实施与审核记录

- **2026-09-09 送审 plan-code-reviewer，裁决「必改后可实施」**：
  - 必改 B-1（tocMeta 失效判据改 html key 幂等，弃布尔 dirty——rIC 在 getItemFull 空窗清脏致
    目录元信息整篇恒空）→ 已并入 §1.2 定稿；
  - 必改 B-2（段落缓存命中加 el 连接性校验，堵跨源同文死引用）→ 已并入 §1.1；
  - 建议 S-1 涟漪基础态 opacity:0 / S-2 内层收起态显式 t-fast + 删旧 hover 规则 / S-3 视觉语义
    确认 / S-4 轮盘 title 微窗接受不加接口 / S-5 markAllRead 成员判定 + 验证前置 / S-6 等价性
    注释互指 / S-7 预热句柄生命周期 → 全部并入；
  - 遗漏 M-1 rIC 屏蔽验证 / M-2 reduce 专项 / M-3 content-visibility 撤销补强 / M-4 内存推≠落库
    明示 → 全部并入。
  - 审核同时核实：§2.1 渲染层无直写 item 路径为真；§2.2 预筛判据与 preload 口径**互为充要**
    （非保守近似）；§0 两条撤销成立。
- 实施记录（2026-09-09）：
  - 改动落地：ReaderPanel.vue（段落双缓存 + contains 守卫 + ensureTocMeta key 幂等 + rIC 800ms timeout
    预热/取消）、AiWheel.vue（双层动效/涟漪/球抬升/rect 缓存）、data.ts（markAllRead 实算推免 loadAll、
    retentionClean 按需预筛）、db.js（retentionClean 等价口径注释互指）。
  - **回归逮住 2 个真 bug（已修）**：
    1. 同文重进（A→B→A，html 字符串相同）时 resetToc 清空 tocHeadings 等 refs 但不清 tocMetaKey——
       key 命中短路使目录元信息恒空，面板误报「文章较短，无目录」。修：resetToc 同步 `tocMetaKey = null`
       （refs 与 key 必须一起复位，B-1 幂等方案的边角）。
    2. markAllRead 本地推按方案「减 n」式实现，遇 db 侧 unreadCount 陈旧虚高底数时全部已读后
       侧栏徽标残留（回归实测 4 源徽标 → 2 源仍亮）。修：改「标记后实算」——一遍统计每源未读数直接
       赋值（与 categories 同口径），彻底消除底数依赖（顺带修掉审核 M-4 提到的旧瑕疵）。
  - 回归结论全过：typecheck / build / check-theme-contrast / smoke-preload(37)；浏览器——轮盘族
    （点击锁定/hover 预览/Esc/键盘/focusout 两向对照/涟漪基础态 opacity:0/reduce 瞬时终态/双层与
    hover 回弹规则接线）；目录三态（rIC 屏蔽 fallback 兜底 4 条结构目录 / 长文 AI 直达生成 3 条 /
    短文文案 / 同文重进修复后正常 / 预热路径零等待）；译文（插入 10 块/切走清/切回缓存恢复）；
    全部已读（干净前置 unread 4→0、徽标 4→0、DOM 徽标 0）；retention 预筛（keep=3 调用 4=预期 4、
    keep=100 调用 0）。
  - 环境噪音备记（非产品问题）：IAB 宿主在 evaluate 间隙偷焦点致键盘焦点链假阴性（focusout 两向
    派发对照验证通过）；IAB 间歇重置标签页需重导航；evaluate 表达式须 IIFE 包装（裸 `({...})()` 或
    多语句在部分路径解析失败）；同步读 DOM class 早于 Vue patch flush 会假阴性（步骤间跨帧读）。
