# PLAN-POLISH — 全站打磨：动效统一 · 交互态补齐 · 渲染性能 · 视觉一致性

> 2026-09-12 · v1.8 候选 · 依据：全组件动效审计（18 文件逐行）+ uTools 官方文档核对 + design-system.md §9/§6/C11/C17 规范差集
> 性质：纯渲染层（src/）UI 打磨，**不动 preload / 数据管线 / AI 管线 / 布局结构**。
> 审核闭环：2026-09-12 plan-code-reviewer 审核通过（4 必改 + 9 建议已全部并入正文；B1-B4 为审核必改项）。

---

## 0. 背景与审计结论

用户诉求：参照 uTools 官方文档，整体优化插件的性能、流畅度、动画效果与整体统一性。

### 0.1 uTools 官方文档核对结论（developer docs @ u-tools.cn）

| 核对项 | 结论 |
|---|---|
| 动画/性能指南 | 官方文档无专门章节；按 Chromium/Electron 最佳实践执行（合成器属性、被动监听）——即本方案批次 A/C |
| `findInPage`/`stopFindInPage` | 宿主内置页内搜索存在，但无样式控制、无法跨配色/集成 ⌫；自研 ReaderFind（C20）保留，不改道 |
| `onPluginResize` | **官方无此事件**——现有 window resize 监听方案（App.vue onWinResize）正确，不改 |
| `setExpendHeight` / `createBrowserWindow` / `getWindowType` | 与现有形态不匹配（固定视口插件），不引入 |
| `onPluginEnter/Out(isKill)/Detach/onDbPull` | 已正确使用（wireUtools），不动 |

### 0.2 组件审计主要发现（18 文件）

1. **浮层动效体系残缺**：设计文档 C11（「scrim 160ms 淡入；面板 200ms scale 0.98→1 + 淡入；关闭反向 160ms」）与 §9（toast「2.6s 后 160ms 淡出」）**均未实现**——modal 族（AddFeedModal/EditFeedModal/confirm/prompt）、dropdown 族（DropdownSelect/ComboboxInput/排序菜单/⋯ 菜单/轨内搜索/AiToolsPanel/ReaderFind）全部 v-if 瞬现瞬灭；toast 只有入场。（C11 的「焦点圈禁 + 返回焦点」同属欠账，**不在本方案范围**，留待后续方案——见 §6 第 12 条。）
2. **按下态（:active）大面积缺口**：§6 交互态矩阵要求每个可点元素有 active 态，实测侧栏全部自绘类、卡片、列表行、菜单项、chip、轮盘球/项等约 20 类缺失；**base.css 三变体（.btn-secondary/.btn-ghost/.btn-danger-outline）也无 active**（仅 primary 有）。
3. **动画走布局属性**：刷新进度条 keyframes 动画 `left`（ArticleFlow:200）、OPML 进度条过渡 `width`（App.vue:417）。全库仅此两处（审核复核确认）。
4. **spinner 同一动画 4 处 3 种时长**（0.8/0.9/1.0s）+ `reader-in` keyframes 双份重复定义。
5. **`transition: all`** 一处（EmptyState chip）。
6. **跨配色硬编码**：ArticleCard 已读标题 `#44403c` 仅 dark 分支覆盖为令牌——sepia/sage/indigo 浅色模式下不跟随配色。
7. **游离字号/尺寸**：12.5px 约 10 处；ai-mark 徽标三处三规格（9/10/10px）；轮盘球图标 18px vs 项 17px；卡片 meta-act 15px vs 列表行 act 14px。
8. **私有 hex**：4 处 #fff（红底白字/开关白点/死回退）；焦点环 box-shadow 七处手写未令牌化。
9. 模板内 `highlightSegments()` 直调（每次重渲染重跑切词，Card/Row 各一处）。
10. **`--bg-active` 在 warm 深色块缺失**（审核 B1 发现）：tokens.css 8 块中仅 warm dark 没有——`base.css:59` 的 `.icon-btn:active` 在默认深色下今天就已失效；本方案批次 B 会把暴露面放大 20 倍，必须先补令牌。

---

## 1. 批次 A：浮层动效体系统一（补齐 C11/§9 实现欠账）

### A0 `src/styles/base.css` 新增全局动效基建

```css
/* ---- 全局浮层进出场（design-system §9 补遗；组件勿再自造浮层动画） ---- */
/* pop：菜单/小面板族——从触发点方向轻移入（-4px 下滑入），120ms */
.pop-enter-active, .pop-leave-active { transition: opacity var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(-4px); }
.pop-leave-active { pointer-events: none; } /* 离场尾巴不可点 */

/* fade：fixed 定位面板族（DropdownSelect/ComboboxInput 的 place() inline transform 冲突，故纯 opacity）与 scrim */
.fade-enter-active, .fade-leave-active { transition: opacity var(--t-med) var(--ease-out); }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.fade-leave-active { pointer-events: none; }

/* modal：scrim 淡入 + 面板 scale 0.98→1（C11 精神的时长对齐版：入场根/子同 200ms、退场同 160ms——
   Vue 的 enter/leave 结束判定只看根元素 computed transition 时长，根短子长会把子面板过渡截断在
   96% 处（审核建议 5），同值消除截断；scrim 入场由 160→200ms 差异不可感） */
.modal-enter-active { transition: opacity var(--t-slow) var(--ease-out); }
.modal-leave-active { transition: opacity var(--t-med) var(--ease-out); pointer-events: none; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-active .modal, .modal-enter-active .confirm { transition: transform var(--t-slow) var(--ease-out), opacity var(--t-slow) var(--ease-out); }
.modal-enter-from .modal, .modal-enter-from .confirm { transform: scale(0.98); opacity: 0; }
.modal-leave-active .modal, .modal-leave-active .confirm { transition: transform var(--t-med) var(--ease-out), opacity var(--t-med) var(--ease-out); }
.modal-leave-to .modal, .modal-leave-to .confirm { transform: scale(0.98); opacity: 0; }

/* toast：入场 4px 上移淡入；出场同款反向；多条时平滑补位。
   离场项【不】脱流（审核 B2：.toasts 是 bottom 锚定 flex column，position:absolute 会让离场项
   瞬移到容器顶且被视口裁切——实测单条下跳 31px、两条重叠）；留在流内 = 原位淡出，
   .toast-move 覆盖「新项入列顶起旧项」的补位动画 */
.toast-enter-active, .toast-leave-active { transition: opacity var(--t-med) var(--ease-out), transform var(--t-med) var(--ease-out); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(4px); }
.toast-move { transition: transform var(--t-med) var(--ease-out); }

/* ---- spinner 全局统一（原 4 处 0.8/0.9/1.0s 归一 0.9s；审核 B3：两种 DOM 形态都要覆盖） ---- */
@keyframes spin-360 { to { transform: rotate(360deg); } }
.spin svg, svg.spin { animation: spin-360 0.9s linear infinite; } /* .spin 是祖先类 / class 直接落在 svg 组件上 */
```

reduced-motion 全局 `transition-property: none`（base.css 现有块）自动覆盖以上全部——瞬切合规。

### A1 `src/App.vue`

- confirm / prompt 两个 `.scrim` v-if → 外包 `<Transition name="modal">`。
- `<AddFeedModal v-if=...>` → 外包 `<Transition name="modal">`（组件根即 .scrim，内层面板 .modal）。
- toast 列表 `v-for` → 外包 `<TransitionGroup name="toast">`；删局部 `@keyframes toast-in` 与 `.toast` 上的 animation。
- ⌫/取消关闭即 `ui.modal = null` → v-if 卸载由 Transition 延后，期间 `pointer-events:none` 防尾点；backLadder 语义不变（动画纯视觉尾巴）。

### A2 `src/components/Sidebar.vue`

- `.fi-menu`（源 ⋯ 菜单）、`.cat-menu`（分类 ⋯ 菜单）、`.rail-search-panel`（轨内搜索浮层）三个 v-if → 包 `<Transition name="pop">`。
- `.sb-drawer-scrim`（窄幅抽屉背板）v-if → 包 `<Transition name="fade">`。
- `<EditFeedModal v-if="editingFeed">` → 包 `<Transition name="modal">`（根为 .scrim，与 AddFeedModal 同构，审核已核实 EditFeedModal.vue:68-69）。

### A3 `src/components/DropdownSelect.vue` / `ComboboxInput.vue`

Teleport 内 v-if 面板 → 包 `<Transition name="fade">`（纯 opacity：place() 的 flip 分支用 inline style 写 `transform: translateY(-100%)`（DropdownSelect.vue:38、ComboboxInput.vue:40），pop 的 transform 会与其冲突，inline 优先级高会互相打架）。chevron 旋转反馈已有，保留。

### A4 `src/components/ArticleFlow.vue`

排序 `.dd-menu` v-if → 包 `<Transition name="pop">`。

### A5 `src/components/AiToolsPanel.vue`

Teleport 内 `.ai-panel` v-if → 包 `<Transition name="fade">`（place() 写 left/top/bottom 不写 transform，但面板从球上方展开、方向随翻转分支变化，纯淡入最稳）。enter 类 opacity:0 不影响 place() 的 getBoundingClientRect 测量（opacity 不改变布局）。

### A6 `src/components/ReaderFind.vue`

**Transition 包在该组件内部根 div 上**（ReaderFind.vue:192 自带 `v-show="open"`；ReaderPanel.vue:746 是常驻挂载无 v-if/v-show——包在使用处永不触发，审核建议 9①）。`<Transition name="pop">` 包 v-show 根：Vue 原生支持（enter 前解 display，leave 后复 display），`focusInput()` 的 nextTick 聚焦与 ⌫/watcher/onBeforeUnmount 复位路径均不受影响（审核已核实）。

### A7 spinner 统一（4 处 → 全局，逐条改法；审核 B3）

| 站点 | 现状 | 改法 |
|---|---|---|
| ArticleFlow.vue:216-217 | 局部 `@keyframes spin` + `.spin svg` 0.9s | 删局部 keyframes 与规则，命中全局 `.spin svg`（DOM：`.spin` 在 button 祖先，svg 后代）✓ |
| AddFeedModal.vue:128,224-229 | `.spinner` span（border 圆环，无 svg）`spin 0.8s` | `.spinner` 的 animation 改引用全局名 `animation: spin-360 0.9s linear infinite;`（引用 base.css 全局 keyframes 名；scoped 块只重写本块内声明的 keyframes，引用全局名安全，**勿改全局 keyframes 名去迁就局部**） |
| AiToolsPanel.vue:144,157,224-225 | `<I.sparkle class="ai-spin">`（class 落在 svg 自身）`ai-rot 1s` | 模板 class 改 `spin`（命中全局 `svg.spin`），删局部 `ai-rot` keyframes |
| AiWheel.vue:307-312,318 | `.ai-witem.busy::before`（伪元素圆环，无 svg 无类可挂）`ai-rot 0.9s` | 伪元素 animation 改引用全局名 `spin-360 0.9s linear infinite`，删局部 `ai-rot` |

---

## 2. 批次 B：交互按下态补齐（§6 矩阵实现欠账）

### B0 前置（审核 B1 必改）：`--bg-active` 补进 warm 深色块

- `src/styles/tokens.css` `html[data-theme="dark"]` 块加 `--bg-active: #332C24;`（比 bg-hover `#2A241E` 亮一档，与 sepia/sage/indigo 深色块「active 比 hover 亮」的规律一致；值与 `--bg-btn-muted-hover` 相同属正常复用）。
- **同步三处**：① `scripts/check-theme-contrast.js` WARM_SNAPSHOT.dark 加 `bg-active` 键（双向 diff 门禁的显式动作）；② `docs/design-system.md` §3.2 深色表补行；③ 其余 6 个配色块已有该键（完整性校验自动纳入）。
- 未补此令牌时，批次 B 全部 `background: var(--bg-active)` 在默认深色下按 unset 处理（透明），按下无反馈、橙底按钮（.add-btn）按下背景被抹掉。

### B1 源序纪律（审核 B4.3 必改）

**所有新增 `:active` 规则必须排在同元素 `.on` / `.cursor` / `[aria-selected="true"]` / `:hover` 规则之后**（同特异度按源序），否则按已选项/悬停项无按下反馈。涉及 `.stat.on`、`.feed-item.on`、`.cat-item.on`、`.cloud-tag.on`、`.dd-item[aria-selected]`、`.ddsel-item[aria-selected]`、`.combo-item[aria-selected]`、`.cand[aria-selected]`、`.ai-toc-item.cur`、`.rf-row.on`、`.seg button.on`、`.row.cursor` 全族。

### B2 全局按钮三变体补 active（审核 B4.1 必改，base.css）

```css
.btn-secondary:not(:disabled):active { background: var(--bg-active); }
.btn-ghost:not(:disabled):active { background: var(--bg-active); }
.btn-danger-outline:not(:disabled):active { background: var(--danger-soft); filter: brightness(0.96); }
```

### B3 组件级 :active 清单

统一规则：hover 已有者补 `:active`，按下底一律 `--bg-active`；不加 transform 缩放（卡片/行避免布局抖动，§6「卡片无 transform」纪律）。

| 文件 | 补 :active 的选择器 |
|---|---|
| Sidebar.vue | `.stat`、`.add-btn`、`.feed-item`、`.menu-item`、`.cat-item`、`.cloud-tag`、`.sb-btn`（底 `--bg-active`） |
| ArticleCard.vue | `.card:active { background: var(--bg-active); }` |
| ArticleRow.vue | `.row:active`（cursor 行 active 覆盖选中底，反馈明确，可接受） |
| ArticleFlow.vue | `.dd-btn`、`.dd-item` |
| DropdownSelect.vue | `.ddsel`、`.ddsel-item` |
| ComboboxInput.vue | `.combo-chev`、`.combo-item` |
| AddFeedModal.vue | `.cand` |
| AiSummaryCard.vue | `.ai-tag-btn` |
| AiToolsPanel.vue | `.ai-toc-item`、`.ai-act:not(:disabled)` |
| AiWheel.vue | `.ai-ball:active, .ai-wheel.open .ai-ball:active { background: var(--bg-active); box-shadow: var(--shadow-1); }`（**复合写法审核 B4.2 必改**：`.ai-wheel.open .ai-ball` 特异度 (0,3,0) 高于单写 `.ai-ball:active` (0,2,0)，展开态点球收起是最常见动作，必须两态都写；**不碰 transform**——本体被 idle 漂浮 animation 占用，C19 明令本体不做缩放）；`.ai-witem:active`（底 `--bg-active`；translate 在外层/rotate-scale 在内层，均不动） |
| ReaderFind.vue | `.rf-row` |
| ReaderPanel.vue | `.fs-btn` |
| SettingsView.vue | `.seg button` |
| EmptyState.vue | `.chip` |

### B4 开关 hover + active（§6「轨加深 5% / 点缩放 0.92」；审核 B4.4）

- `.switch:hover { filter: brightness(0.96); }`（on/off 通用；off 轨浅色已是 `--bg-active` 无更深令牌，brightness 最小侵入；无 transition，reduced-motion 安全）。
- `.switch:active .dot { transform: scale(0.92); }` + **`.switch.on:active .dot { transform: translateX(16px) scale(0.92); }`**（naive 写法会丢掉 on 态 16px 位移把白点弹回左侧——审核指出的复合陷阱）。
- 若 D3 已把 .switch 提全局，以上写一处。

### B5 `transition: all` 清理

EmptyState `.chip` → `transition: background-color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);`

---

## 3. 批次 C：渲染性能

### C1 刷新进度条 left → transform（ArticleFlow）

```css
.content-progress::before {
  /* left:-30% 保留为静态定位；动画只走 transform（相对自身宽：容器 130% 位移 = 30% 宽条的 433.3%） */
  left: -30%; width: 30%;
  animation: progress-move var(--t-progress);
}
@keyframes progress-move { from { transform: translateX(0); } to { transform: translateX(433.3%); } }
```

（审核复核：130%/30% = 4.3333，`.content-progress` 是定宽绝对定位父级，换算成立、视觉逐帧等价。）

### C2 OPML 进度 width → scaleX（App.vue）

- `.opml-fill` 样式改：`width: 100%; transform-origin: left; transition: transform var(--t-med) var(--ease-out);`
- 绑定改 `:style="{ transform: 'scaleX(' + done / Math.max(1, total) + ')' }"`（0→1；`.opml-bar` 有 overflow:hidden + r-full、fill 无圆角内边距，与 width 百分比逐像素等价——审核复核确认）。

### C3 highlightSegments computed 化（ArticleCard / ArticleRow）

模板 `v-for="(seg, si) in highlightSegments(displayTitle, hlTerms)"` → 各加 `const titleSegs = computed(() => highlightSegments(displayTitle.value, hlTerms.value))`，v-for 改走 titleSegs。重渲染从「重跑切词」变「读缓存」，仅 search/highlightWords/item 变化时重算。**验证归浏览器回归**（test-db-mock 是数据层用例，覆盖不到 .vue computed）。

---

## 4. 批次 D：视觉统一

### D1 全局滚动条（base.css，跨 8 配色零新令牌）

```css
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--r-full); }
::-webkit-scrollbar-thumb:hover { background: var(--text-disabled); }
```

- thumb 取 `--border-strong`（浅 #D6D1C8 / 深 #474036，各配色自动跟随），对底约 1.5-1.7:1，与 Chromium 默认滚动条（约 1.6:1）持平不退化；hover `--text-disabled`：**浅色加深（2.5:1）、深色提亮（2.9:1）**——暗色 UI 的悬停惯例即提亮（审核建议 8 订正原文案）。
- 不写 `scrollbar-width/scrollbar-color`（Chromium 121+ 一旦设了标准属性就忽略 `::-webkit-scrollbar` 定制，造成不一致——方案原判断经审核确认）。

### D2 `.hl` 搜索高亮提全局（base.css）

三处定义逐字节相同（审核核实），合并为全局类；r2 为内联小元素特调保留字面值（C18 已背书）。ArticleCard/ArticleRow/ReaderFind 删局部。

### D3 `.switch` 提全局（base.css）

两份唯一差异是 SettingsView 多 `flex-shrink: 0`（审核核实）——合并进全局类（对 EditFeedModal 无副作用），两处删局部。

### D4 12.5px 游离字号清理（审核建议 2 枚举定案）

| 站点 | 现值 | 定案 | 依据 |
|---|---|---|---|
| `.ddsel-item` / `.dd-item` / `.combo-item` / `.menu-item`（Sidebar）/ `.ai-toc-item` | 12.5px | **13px** | 菜单/面板行统一 ui 档 |
| `.seg button`（SettingsView:423） | 12.5px | **13px** | C10 明文「13px/500」（现状即偏差） |
| `.ai-act`（AiToolsPanel:219） | 12.5px | **13px** | 审核指出的漏项 |
| `.opml-progress`（App.vue） | 12.5px | **12px** | meta 文案档 |
| `.rf-row` / `.st-value` / `.st-note`（AddFeedModal 步进指示） | 12.5px | **12px** | meta 档 |
| `.ai-title`（AiSummaryCard:68） | 12.5px | **保留 12.5px** | C16 明文钉死，不动 |
| `.ra-orig`（ReaderPanel:885） | 12.5px | **保留 12.5px** | C18 明文钉死，不动 |

### D5 ai-mark「AI」徽标统一（三处 → ArticleCard 版规格）

`font-size: 10px; line-height: 14px; padding: 0 3px; margin-left: 6px;`——ArticleRow（9px/12px/0 2px/5px）与 ReaderPanel（10px/16px/0 4px/8px）归一。

### D6 图标尺寸统一

- AiWheel：`.ai-witem` font-size 17→**18px**（与球 sparkle 18 一致）。
- ArticleCard：`.meta-act` 15→**14px**（与 ArticleRow `.act` 一致，紧凑图标钮档）。

### D7 `--text-read` 令牌（修跨配色已读标题）

- tokens.css 8 块各加 `--text-read`（浅色=各配色 text-1 与 text-2 之间一档；深色=各配色 text-2 同值）：
  - warm：light `#44403C` / dark `#B8B0A4`
  - sepia：light `#4F412D` / dark `#B5A78D`
  - sage：light `#3B4934` / dark `#AEBFA3`
  - indigo：light `#38405A` / dark `#AFB5CC`
- ArticleCard：`.card:not(.unread) .title { color: var(--text-read); font-weight: 550; }`，删 dark 覆盖行。warm 两模式视觉**零变化**（审核逐字节核实：#44403c 与 warm dark text-2 #B8B0A4 同值）。
- `scripts/check-theme-contrast.js`：① WARM_SNAPSHOT light/dark 两块加 `text-read` 键；② 对比度矩阵加一行 `["text-read", ["bg-panel", "bg-card-hover"], 4.5]`（审核核算 8 值全部 ≥7.6，加门禁防未来配色漂移）。

### D8 `--ring` 焦点环令牌（:root）

`--ring: 0 0 0 2px var(--focus-ring);`——替换 7 处手写（base.css `.input:focus`、DropdownSelect `.ddsel:focus-visible`、Sidebar 搜索框×2、ReaderFind 输入框、AiWheel 球 focus-visible）。解析链审核确认：`:root` 即 html，`--focus-ring` 在 html 主题块上，切换主题时 `--ring` 随之重算继承。**不动** Sidebar.vue:500 的 `.err-dot` 挖孔环（`box-shadow: 0 0 0 2px var(--bg-app)`，非焦点环）。

### D9 杂项

- Sidebar `var(--bg-panel, #fff)` 死回退删除。
- EmptyState `urlInput` computed（DOM 查询无响应依赖，审核指出模式风险）→ 改为 handler 内 `document.getElementById` 直取（防未来 setup 期读到 null）。
- 白 `#fff` 四处**保留**（恒定色豁免，见 §6 第 7 条）：App.vue:429 错误 toast、base.css:47 危险按钮、SettingsView:442 与 EditFeedModal:148 开关白点——四处列名写进 design-system 豁免口径。

---

## 5. 批次 E：文档同步

- `docs/design-system.md`：
  - §3.1/§3.2 令牌表补 `--text-read` 行 + **§3.2 补 `--bg-active` 行**（审核 B1：文档与代码同步缺）；§3.5 增 `--ring`；§3.7 动效令牌表补 `spin-360` 0.9s 与 pop/fade 两个新场景名。
  - §9 动效表增行：菜单/面板族 pop 120ms（-4px 淡入淡出）、fixed 面板/scrim fade 160ms、modal 族（scrim+scale，进/出根子同值 200/160ms）、toast 出场 160ms（离场不脱流）、spinner 统一 0.9s。
  - 滚动条规格（8px / thumb=border-strong / hover=text-disabled）。
  - C3 已读标题改「`--text-read`（warm 浅 #44403C）·550」；C6/C17 菜单项字号 13px；C10 分段钮 13px（现状 12.5 是偏差）。
  - **§9 末尾 reduced-motion 示例代码块更新**为 `transition-property: none !important` 定型版（现文仍是 transition-duration 旧方案，与 base.css 实现矛盾——审核发现的文档债）。
  - 白恒定色豁免口径（四处列名）。
- `AGENTS.md`「设计规则」节补一行：浮层进出场统一走 base.css 全局 Transition 类（pop/fade/modal/toast），组件勿自造浮层动画；滚动条已全局令牌化勿组件私改。
- `README`「实机待验证项」：modal/dropdown 进出场流畅度、滚动条样式（主窗+分离窗）、4 配色已读卡片标题色、深色按下态。

---

## 6. 明确排除项（评估后不做，防「顺手劣化」）

1. **AiWheel 特调时序**（涟漪 420ms/错峰 45/90/135ms/内层 +40ms/idle 3.2s/呼吸 1.1s）——C19 三次打磨定稿的规范值，令牌化无收益，不动。
2. **box-shadow 过渡**（轮盘抬升、焦点环渐入）——规范行为，小元素 repaint 可忽略。
3. **findInPage 改道**——自研 ReaderFind（C20）保留，理由见 §0.1。
4. **content-visibility: auto 阅读正文优化**——与 find 跳转 rect 测量/阅读位置记忆冲突风险高，不引入。
5. **j/k scrollIntoView smooth**——键盘连打会晕，保持瞬时。
6. **字重 550/650、头部 56/52、下拉触发钮 32/36**——设计文档规范值/场景差异，非缺陷。
7. **白 #fff 恒定色**——红底白字（danger 4.83 规范）、开关白点跨配色恒白，写豁免口径不令牌化（审核确认四处列名见 D9）。
8. **mousemove hoverIdx 守卫**——Vue3 ref 同值赋值已短路，零收益。（EmptyState computed DOM 查询**已升级为 D9 小改**，不在排除列。）
9. **菜单行六族提取公共类**——Teleport/scoped 上下文各异，只统一数值（D4），提取改造成本＞收益。
10. **`.row-acts` display 切换保持现状**——常驻占位（visibility 方案）会恒定吃掉 56px 标题宽度；现状 hover 时标题被挤窄、ellipsis 重截有一帧文字跳动，属可接受代价（标题宽度优先）。理由经审核订正：非「行高装不下」（按钮 24px 行高 40px 装得下），是标题宽度问题。
11. **transition: grid-template-columns / 侧栏折叠过渡**——既有禁令（拖死渲染线程），不动。
12. **§9「已读淡出 180ms + 高度折叠 160ms」不实现**（审核建议 6 补录的同等欠账）——`.vl-row` 高度由 useVirtualList 的 measureRow 一次性回填进 measured 缓存做前缀和，行高动画会污染 offsets/滚动定位；40px 行的纯透明度淡出几乎不可感。留待未来虚拟列表支持离场动画时一并考虑。
13. **C11「焦点圈禁 + 返回焦点」不在本方案**（审核建议 7）——本方案只补 C11 的进出场动效；焦点管理欠账留待后续独立方案。

---

## 7. 回归计划

1. `npm run typecheck`
2. `node scripts/check-theme-contrast.js`（--text-read / --bg-active 新键过快照+完整性+对比度矩阵）
3. `npm run dev` 浏览器回归（preload 未动，smoke-preload/test-ai/test-db-mock 均不涉及本改动面；C3 的验证也归此处）：
   - `?view=settings` / `?view=addfeed` 直达；`?view=reader` 直达若数据未就绪（首 400ms）退化用 j/k 开文。
   - `pinia._s.get('ui').detached = true` 强制分离窗（detached mock 走不到）。
   - modal/confirm/prompt/dropdown/菜单/轨内搜索/AiToolsPanel/ReaderFind 开关动画；toast 出场与多 toast 补位（连发两条，先到期那条原位淡出不跳位）；抽屉背板。
   - 全部新 :active 按下抽查（**浅色+深色各过一遍**——B0 令牌补齐的验证点）；开关 hover/active（on 态白点不回弹）。
   - 4 配色 × 明暗：**按下态底**、已读卡片标题色、滚动条、焦点环。
   - `prefers-reduced-motion: reduce` 模拟：全部新动效瞬切、无楔死（重点：modal/dropdown 快速开关）。
   - OPML 进度条与刷新进度条动画正常（走 transform 后轨迹等价）。
   - `docs/preview.html` 像素基准抽查（侧栏/卡片/工具栏——本方案 UI 数值改动点的对照）。
4. 实机（uTools 宿主）项列入 README 待验证。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| Transition + Teleport 组合 | Transition 包在 Teleport **内层** v-if 元素上（Vue3 支持，A3/A5 已按此写；审核逐一核实包裹点） |
| 离场尾巴被点击 | 全局 `.pop/.fade/.modal-leave-active { pointer-events: none }` |
| leave 期间与全局键盘流互搏 | ui.modal=null 立即生效，Transition 只延后 DOM 卸载，backLadder 语义不变 |
| DropdownSelect place() inline transform 冲突 | 该族用纯 fade（不动 transform），pop 只给 absolute 菜单族 |
| AiToolsPanel place() 测量时机 | enter 类只含 opacity，不影响 rect；place() 在 nextTick 后 DOM 已在 |
| toast 离场脱流跳位/裁切 | **不脱流**（审核 B2 实测），原位淡出；`.toast-move` 覆盖入列补位 |
| modal 根/子时长不一致截断 | 根子同值（进 200/出 160），A0 已按对齐版写 |
| v-show + Transition（ReaderFind） | 包组件内部根 div（自带 v-show）；Vue 原生支持，聚焦/复位路径不受影响 |
| OPML scaleX 初始帧 | p=0 → scaleX(0)，与 width:0 视觉等价 |
| 进度条 433.3% 精度 | 130%/30% = 4.3333，误差不可见（审核复核） |
| warm 快照失守 | --text-read/--bg-active 同步进 check-theme-contrast.js 的 WARM_SNAPSHOT 与对比度矩阵（显式动作+注释） |
| :active 源序覆盖 .on/.cursor | B1 硬纪律：所有 :active 排在选中态/hover 之后 |
| 12.5→13px 引发行高溢出 | 菜单行高 32、13px 默认行高≈19.5px，无溢出；逐处回归确认 |
