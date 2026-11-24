# PLAN-READER-FIND：阅读文内搜索（命中列表 + 点击跳转）

> 2026-09-12 用户反馈：「折叠侧栏情况下，在具体文章界面，使用搜索功能后，应该要可以搜索文章内的内容，有哪些地方，点击可以并自动跳到对应的位置。」
> v2：并入 plan-code-reviewer 审核必改 B1-B6 与采纳建议 S1-S10（裁决记录见文末 §9）。

## 0. 背景与问题

- 现状：搜索（侧栏搜索框 / 折叠轨浮层面板 / Ctrl+F / 宿主子输入框）全部落到 `data.search` → 过滤**文章列表**。阅读一篇文章时（非分离窗阅读层盖住列表、或窄幅分离窗注意力在右栏），输入搜索词对「正在读的这篇文章」毫无作用——用户看到的就是「搜索没用」。
- 期望（阅读态）：搜索 → 命中当前文章正文 → 列出命中位置（上下文）→ 点击跳转到对应位置。

## 1. 目标 / 非目标

**目标**

1. 阅读态（`ui.view === 'reader' && ui.readerItemId` 非空）下，搜索入口改道为**文内搜索栏**：
   - Ctrl+F（App.vue onKeydown）；
   - 折叠轨搜索钮（Sidebar.toggleRailSearch——用户反馈的具体入口）。
2. 面板行为：输入即搜（150ms 防抖）；命中列表（每处一行上下文片段，命中词用既有 `mark.hl` 语汇高亮，C18 同族）；点击行 / Enter / 上一处下一处 → 滚动到对应块并闪烁标记；`n 处 · 当前 i` 计数；关闭钮 / Esc（分离窗）/ ⌫（逐级返回）关闭。
3. 搜索对象 = **渲染后正文 DOM**（`.ra-content`，含全文提取替换后的版本）；大小写不敏感；每块命中 ≤10 行、总上限 200 行（截断时计数显示「200+」并提示）。
4. 打开面板时空输入则以列表搜索词 `data.search` 为初值（轨内面板/宿主子输入框已输入的词直接复用，S10①）。

**非目标（v1 明确不做，写清而非留白）**

- 列表全文检索管线（data.search）一字不动；展开态侧栏搜索框、宿主子输入框在阅读态**仍过滤列表**——非分离窗阅读层盖住列表时表现为「无反馈」，⌫ 关阅读即见结果（已知局限，后续可把子输入框也接进来）。
- 不做大小写敏感开关 / 正则 / 整词匹配。
- 不做命中词在**正文内**的逐字高亮（mark 包裹要改写 sanitize 产物 DOM；v1 用块级闪烁 + 面板行内 mark.hl）。
- **搜索范围 = `.ra-content` 正文**：标题（.ra-title）、AI 摘要卡、元信息行不参与；空态文案写「正文内无命中」防「屏幕上明明有」的误解（S3）。
- **译文块（ra-trans）不参与**：翻译插拔不改 htmlKey，纳入会让 matches 与译文态失同步（S4 裁决；后续要做需把 trShown 加入 watch 源）。
- 阅读位置记忆会被搜索跳转覆盖（@scroll → 800ms 合并写盘）：浏览器 Ctrl+F 同款行为，**有意识接受**，不在关闭时恢复（R3 裁决）。

## 2. 状态与入口改道

- `src/stores/ui.ts`：state 加 `readerFind: false`（文内搜索栏开）。放 store：App 的 backLadder 与 Sidebar 轨内钮都要驱动，组件局部够不着。
- 入口改道（阅读态判定 `ui.view === 'reader' && ui.readerItemId`）：
  - **App.vue Ctrl+F 分支**：阅读态 → `ui.readerFind = true`（面板已开则重聚焦+全选输入框，S8③）；否则 `sidebarRef.focusSearch()` 原样。
  - **Sidebar.vue toggleRailSearch**：阅读态 → `ui.railSearch = false; ui.readerFind = true`（防两面板并存，S2）；否则原逻辑。`focusSearch()` 不动（展开态搜索框语义保留）。
- **App.vue backLadder**：`sbDrawer` 分支之后、INPUT 失焦分支之前插 `if (ui.readerFind) { ui.readerFind = false; return true; }`。副作用知悉：焦点在别的输入框时 Esc/⌫ 先收搜索栏再谈失焦（弹层语义，接受）。
- **键盘矩阵（B6 修正）**：
  - 分离窗：Esc 可关（输入框聚焦时 `@keydown.esc.stop.prevent` 自关；焦点在别处时走 backLadder）；⌫ 同路。
  - **主窗：Esc 被宿主优先消费直接隐藏插件（既有宿主行为，页面拦不住，非本功能回归）**；关闭 = 面板 ×钮 / 焦点不在输入框时 ⌫（backLadder 新分支）。输入框内 ⌫ 是编辑键不关面板（backLadder Backspace 分支 `!typing` 守卫既有）。
  - AiToolsPanel 同开时它挂 document capture 键盘/滚动监听：Esc 先关 AI 面板、正文滚动会关它——既有行为，验收不当新 bug（R2）。
- 输入框内 Enter/Shift+Enter=下一处/上一处（App.onKeydown 的 typing 守卫在 j/k/Enter 分支之前，不会误触全局键）。

## 3. 纯函数库 `src/lib/find.ts`（新，S7/R7：可脚本化验证）

```ts
export const FIND_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,code,td,th,a,strong,em";
export interface FindMatch { el: HTMLElement; idx: number; pre: string; hit: string; post: string; }
export function normalizeFindText(s: string): string   // /\s+/g→" " + trim + toLowerCase
export function findMatches(root: HTMLElement, q: string): { matches: FindMatch[]; truncated: boolean }
```

- 选择器从 sanitize 白名单推导（白名单 = p,br,h1-h6,ul,ol,li,blockquote,pre,code,img,a,table,thead,tbody,tr,td,th,strong,em；**无 figure/figcaption**）。**不含 table/thead/tbody/tr**：td/th 直挂其下，含 tr 会让嵌套去重守卫误杀 td（tr.closest(sel) 命中自身）。
- 嵌套去重守卫（同 collectParasAll 口径）：`el.parentElement?.closest(FIND_SELECTOR)` 命中即跳过——p>a / pre>code / 外层 li>嵌套 li 均归到外层块（textContent 天然包含，不漏报、跳转粒度变粗而已）。直接子元素（root=a/strong/em/code）parentElement=.ra-content 不命中选择器，正常收录（B5：sanitize `disallowedTagsMode:"discard"` 会把 div/figure 剥成裸文本/顶层内联节点）。
- **root 直挂裸文本节点兜底**（B5 主洞）：遍历 root.childNodes，连续非空白 Text 节点聚合为一个 pseudo-block（el=root，闪烁降级为整篇底色）；与选择器枚举合并入序。
- 查询侧同口径归一（S6）：`q.replace(/\s+/g," ").trim().toLowerCase()`，空串直接空结果。
- 文本读取用 `textContent`（非 innerText，不强制 layout）；匹配 = 归一小写 indexOf 循环，每处命中记录 el/块序/前后各 24 字符片段；**每块 ≤10 行**（防「的/the」吃满列表，S7），**总 ≤200 行** + truncated 标记。
- query 与去重共用同一 `FIND_SELECTOR` 常量（S9，防两处口径漂移）。

## 4. 新组件 `src/components/ReaderFind.vue`

**挂载形态（2026-09-12 悬浮化改版：.reader-body 右上 absolute 浮层卡；v2 曾采 flex 子项，因挤压正文观感差被用户裁决推翻，见 §9）**：ReaderPanel 模板 `.reader-body` 内、`<header class="reader-top">` 与 `.reader-scroll` 之间（absolute 定位不占 flex 行高，DOM 位置只影响绘制序）：

```html
<ReaderFind :open="ui.readerFind" :root="contentEl" :html-key="html" :seed="data.search" @close="ui.readerFind = false" />
```

- 组件**常驻挂载**（不 v-if 卸载）：根节点 `v-show="open"`，内部 watch `open` 完成聚焦/种子/清理——「面板已开再按 Ctrl+F 重聚焦+全选」（S8③）与「关闭再开保留本篇 query」都靠它。`role="search" aria-label="文内搜索"`（§8.2 a11y）。
- **absolute 悬浮卡而非 flex 插行**：锚 `.reader-body`（position:relative 定高容器）右上——top 60（reader-top h56+4，不盖顶栏按钮）、right 12、`z-index:var(--z-reader)`，`width:calc(100%-24px) max-width:420px`；不占 flex 行高、`.reader-scroll` 尺寸恒定（正文不被挤压）。B2 的遮挡担忧改由**跳转补偿**消化（见下 jump 条），不再以「结构零遮挡」换取正文收缩。高度双上限：面板 `max-height:calc(100%-72px)`（锚容器定高、百分比可解析）+ 列表 `max-height:288px` 纯定值——上限挂面板自身（**auto 高父级的子元素 max-height:% = indefinite 整体失效**，2026-09-12 实机教训）；max-* 内 min(…,百分比) 有 Chromium 百分比分支不生效怪癖，不叠 min()。
- 样式：悬浮卡词汇——`border:1px var(--border); border-radius:var(--r-lg); box-shadow:var(--shadow-3); background:var(--bg-panel)`（dark: bg-elevated），内 `flex-wrap: wrap` 两行自适应（窄列输入框与按钮组自动换行）：搜索图标 + 输入框（flex:1 1 160px, min-width:0）+ 计数 `n 处`+ 上一处/下一处/关闭 icon-btn；命中列表区 `max-height:288px; overflow-y: auto`。
- 命中行：`<button>` + `aria-label="第 i 处"`，单行 ellipsis 三段渲染 `pre + <mark class="hl">hit</mark> + post`（既有 C18 语汇，S5；模板插值非 v-html，无注入面）；hover bg-hover；当前行 bg-selected。
- **watch 拆两路（B4）**：
  - `watch(query)`（150ms 防抖）→ findMatches + `cur=0` + **跳第一处**（浏览器 Ctrl+F 同款即时反馈）；
  - `watch(htmlKey, { flush: "post" })`（显式 post：v-html 赋值与 DOM patch 之间不得枚举，PERF-2 纪律）→ findMatches + `cur=clamp(cur)`，**不滚动**；面板关闭态时连带清空 query/matches（换文不复用上一篇的词）。
- **跳转 jump(i)**（悬浮化改版）：rect 差算 y（`el.top - scRect.top + scrollTop`，免 offsetParent 歧义，同 markCurrentSection）→ `sc.scrollTo({ top: 块顶 - offset, behavior: 每次调用时读 prefers-reduced-motion ? "auto" : "smooth" })`；**offset = 面板底沿 - 滚动区顶 + 8，仅当面板与正文列（.ra-content）横向相交时补偿**——悬浮卡盖住滚动区顶的目标块顶对齐「面板底沿+8」，宽列正文列与右侧面板不相交则退化为经典顶对齐。+ 闪烁：记录 `{el, timer}` 上一处——jump 时先 `prevEl.classList.remove("find-flash"); clearTimeout(prevTimer)` 再对新 el 加类、设 1200ms 定时移除（B3：单句柄只 clear 不移类 = 永久残留高亮）。
- 当前行跟随：行 `scrollIntoView({ block: "nearest" })` 只滚列表面板容器（面板在 reader-scroll 之外，不会带动正文，S8①）；点击行后焦点交还输入框（浏览器同款，S8②）。
- **清理（B3/S9）**：open=false 与 onBeforeUnmount 双路径：移除当前 flash 类 + 清 flash 定时器 + 清 150ms 防抖定时器。
- 空态：行内「正文内无命中」（S3 文案）；`root` 为 null（正文未落地）同空态。

## 5. ReaderPanel 接线

- import ReaderFind + 模板一行（§4 挂载点）。
- **复位不放 resetToc()（B1：maybeExtractFull 也调它，写进去等于提取落地强关面板，与「保搜索连续」自相矛盾）**，改为两处显式：
  - `watch(ui.readerItemId)` 换文分支：`ui.readerFind = false; ui.railSearch = false;`（后者防「列表态开着轨内面板→Enter 进文」两面板并存，S2）；
  - `onBeforeUnmount`：`ui.readerFind = false;`（父级 v-if 同周期卸载 watcher 被跳过的已知坑，unmount 兜底必须自持）。
  - maybeExtractFull 替换 html **不**关面板：htmlKey watcher 重算 matches（旧 matches.el 已随 innerHTML 失效，重算前不 jump/flash——重算先行，天然满足）。
- `.find-flash` 样式落 ReaderPanel 的 `:deep`（它作用于 .ra-content 子树，ReaderFind 的 scoped :deep 够不着父链，S10③）：`background: var(--accent-soft); border-radius: var(--r-sm);`——瞬时切换不走 animation/transition，reduced-motion 下仍可见（§3.8 令牌，无私有 hex）。

## 6. 安全与风险

- **双道信任模型不破**：对正文 DOM 只 querySelector / textContent 读、scrollIntoView、classList 加删一个装饰类——零结构改写、零 innerHTML 写入。
- 性能：textContent+includes O(总字数)，万段级 <10ms 量级；150ms 防抖 + 每块 10 行 + 总 200 行三重保护。
- 配色门禁：全部用既有令牌；落地后跑 `node scripts/check-theme-contrast.js`（R6）。
- IAB 与实机分叉（R1）：IAB 验形态与数据（scrollTop 读回、类名、计数），键盘矩阵与 smooth 滚动体验实机复核；IAB 常开 reduced-motion → behavior:"auto" 立即生效正好绕开节流。

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/stores/ui.ts` | state + `readerFind` |
| `src/lib/find.ts` | 新增（FIND_SELECTOR/normalize/findMatches 纯函数） |
| `src/components/ReaderFind.vue` | 新增（面板、watch 双路、跳转闪烁、清理） |
| `src/components/ReaderPanel.vue` | import + 模板 + 换文/unmount 复位两行 + :deep flash 样式 |
| `src/App.vue` | Ctrl+F 改道 + backLadder 分支 |
| `src/components/Sidebar.vue` | toggleRailSearch 改道（含关 railSearch） |
| `AGENTS.md` / `docs/design-system.md` | 纪律条目 + C20 |

## 8. 验证

- typecheck + build + check-theme-contrast。
- IAB（pinia 强制阅读态）：轨内钮/Ctrl+F 开面板（初值=列表词）→ 输入命中词 → 计数与列表正确（含 sanitize 裸文本/表格/嵌套列表口径）→ 点第二行 scrollTop 读回跳转 + find-flash 类 → Enter/Shift+Enter 循环 + 当前行跟随 → 关闭钮关 → 焦点在正文 ⌫ 走 backLadder 只关面板 → j/k 切文面板强关且重开为空 → 非阅读态轨内钮仍开轨内面板（回归）。
- 实机（用户）：主窗阅读态 Esc 预期=宿主隐藏插件（非回归）；⌫/×钮关面板；分离窗 Esc；窄幅 280px 列面板换行不溢出。

## 9. 审核裁决记录（v2 并入）

- 必改全采纳：B1 复位移出 resetToc（watcher+unmount 两处）；B2 面板改 flex 子项消遮挡；B3 flash 双句柄（类+定时器）成对清理；B4 query/htmlKey 双 watch 拆分（post flush、重算不滚动、关闭态清 query）；B5 选择器按白名单推导 + 裸文本 pseudo-block 兜底；B6 键盘矩阵按主窗/分离窗分写。
- 建议采纳：S1（非目标写清子输入框/展开框局限）、S2（railSearch 联动关）、S3（范围+空态文案）、S4（译文排除，写明理由）、S5（mark.hl 语汇）、S6（查询同口径归一）、S7（每块 10 行）、S8（焦点三则+a11y）、S9（常量/每次读 RM/双定时器清理）、S10（data.search 种子；flex 无绝对定位；flash 样式落 ReaderPanel :deep）。
- 风险知悉：R1 IAB/实机分叉、R2 AiToolsPanel capture 先手、R3 位置记忆被跳转覆盖（接受）、R4 轮盘（flex 方案下无遮挡冲突）、R7 渲染层无测试基建 → find.ts 纯函数留口子。
- **v1.6.1 悬浮化（2026-09-12 用户裁决，实施后追加）**：上线实测 flex 子项把正文压出一条可感知的收缩（15 命中时正文只剩约六成），用户明示要悬浮框形态——面板改 `.reader-body` 右上 absolute 悬浮卡，B2 的「结构零遮挡」让位于「正文布局恒定」；遮挡风险改由跳转补偿消化（§4 jump：块顶对齐面板底沿+8、与正文列横向相交才补偿）；高度双上限（面板 `calc(100%-72px)` + 列表 288px 纯定值），max-* 不叠 min()（Chromium 百分比分支怪癖）。

- **v1.7 入口迁移（2026-09-12 用户裁决，PLAN-WHEEL-FIND，实施后追加）**：文内搜索入口=Ctrl+F + AI 轮盘第四项「文内搜索」（非 AI 功能恒可用）；**撤折叠轨搜索钮改道**——Sidebar.toggleRailSearch 恒为列表搜索，§2/S2 的「开轨内面板顺关 readerFind」语义对调为**双向互斥**（轨内开→顺关 readerFind；readerFind 开→入口顺关 railSearch）。§2.1「已开再 Ctrl+F 重聚焦全选」在该版前实际不生效（同值赋 open 不触发 watch），由 `ui.readerFindFocus` 令牌修复。已知局限新增：非分离窗阅读态轨内输入=过滤无反馈（分离窗正常）；data.search 无命中时 filtered 空、阅读态 j/k/Enter/m/s 静默失效。
