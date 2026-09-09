# PLAN-AI-WHEEL — AI 悬浮轮盘（v1.4 增补）

> 状态：已审（4 必改 + 7 建议 + 2 遗漏已并入正文，见 §7）→ 待实施。
> 前置：PLAN-AI-TOC.md（v1.4 AI 目录 + AiToolsPanel 三区）已落地。
> 范围：**纯渲染层改造**（src/components/），不动 preload / AI 管线 / 数据模型 / mock / env.d.ts。

## §0 背景与共识

v1.4 的 AI 入口是阅读顶栏「AI」sparkle 按钮 → AiToolsPanel 浮层面板（目录/摘要/翻译三区）。
本次将入口升级为**悬浮轮盘**（radial menu）：阅读区右下角常驻悬浮球，鼠标移上后功能项沿圆弧展开，点击直达动作。四项决策（2026-09-09 用户确认）：

1. **轮盘替代顶栏按钮**：撤掉顶栏 AI sparkle 按钮，悬浮轮盘成为唯一快捷入口；目录列表/进度等详情仍打开 AiToolsPanel 呈现。
2. **三项**：摘要 / 翻译 / 目录（与面板三区对齐，不新增功能项）。
3. **点击直接执行**：摘要=立即生成（已有则滚到摘要卡）；翻译=立即开始（翻译中再点=取消）；目录=已有则打开目录列表、无且可生成则直接生成（完成后自动打开列表）。
4. **hover 展开 + 移开收起**；点击功能项执行后收起。

## §1 交互设计

### 1.1 悬浮球

- 位置：`.reader` 内 `position: absolute; right: 20px; bottom: 64px; z-index: var(--z-sticky)`（阅读上下文内粘性阶，design-system §3.8；footer 52px 上方 12px，不遮底部操作条按钮）。
  不放进 `.reader-scroll`（不随正文滚动）；`.reader` 非 detached 时 `position:absolute`、detached 时 `position:relative`（flex:1），两种模式下 absolute 球都成立（历史坑 §已知坑 detached 高度链不受影响——球不参与布局流）。
- 尺寸 44px 圆钮，`I.sparkle` 图标；任一 AI 任务在飞时显示呼吸点（`aiBusyDot` 口径不变；`.ai-dot` 样式**迁入 AiWheel 并适配球内绝对定位**——原样式是顶栏按钮 inline 流式 margin-left，不可照搬）。
- 常态视觉低调（`--bg-panel` + border + shadow-1，opacity 0.92），hover/展开时加深（bg-card-hover）；不引入私有 hex，全部走令牌。
- 球本身可聚焦（`<button>`），`aria-haspopup="menu"` + `aria-expanded`（配套 role 见 §1.3）；**点击 = toggle 展开/收起，且若 AiToolsPanel 正开着先关面板再 toggle**——面板的 onDocDown 豁免 triggerEl（球）内 mousedown，若不显式处理，点球会出现「面板不关 + 轮盘被面板盖住」的双浮层叠加（审核 B4）。
- AI 总开关关闭（`aiEnabled=false`）时球仍显示（同现顶栏按钮恒显），点击展开后三项置灰，点任意项 toast「未开启 AI 增强（设置 → AI）」。

### 1.2 hover 展开/收起（热区模型）

核心问题：容器若占展开后的包围盒会挡正文（点击/文本选择）；若只包球，鼠标从球移向轮盘项会触发 mouseleave 误收起。定案：

- **容器 `pointer-events: none`**（不挡正文），球与三个轮盘项 `pointer-events: auto`。
- 展开：球 `mouseenter`（或 focus / click toggle）→ `open=true`，同时挂两类 document 级监听：
  - `mousemove`（passive）：坐标在**联合热区矩形**内则保持展开，否则收起并卸载监听。矩形 = 球 rect 向左/上各扩 120px（覆盖轮盘全部圆心 + 项半径 + 缓冲，常量由 §1.3 几何推出：左扩 ≥100px、上扩 ≥101px，取 120）。鼠标球→项的任何直线路径都在矩形内，天然连续保活，无间隙误收起。`clientX/Y` 与 `getBoundingClientRect()` 同属视口坐标系，多显示器/负坐标场景一致，无需换算。
  - `keydown`（**捕获阶段**，同 AiToolsPanel/DropdownSelect 惯例——hover 展开时焦点可能在 body/正文，容器级监听收不到 Esc）：`Esc` → 收起轮盘。**双开约定**：AiToolsPanel 与轮盘同开时按 Esc，两组件的 document 捕获监听各自独立执行关闭（同节点同阶段 `stopPropagation` 互拦不住，正好实现一次 Esc 双闭清场，无需顺序协调）。
- 点击功能项：emit 动作 + 收起（卸载监听）。
- 键盘：球 focus 展开；容器 `focusout` 时 `relatedTarget` 不在容器内则收起；`Esc`（document 捕获）收起并焦点回球（stopPropagation，不进全局 Esc 键盘流）。
- `resize` → 收起（球 rect 失效，重 hover 即重算，成本为零）；滚动**不**收起（球 absolute 于 .reader 不随滚动位移，无需处理；AiToolsPanel 的滚动即关逻辑不变）。
- 组件卸载：onBeforeUnmount 兜底卸载两类监听（历史坑「父级 v-if 同周期卸载的 watcher 被跳过」不影响卸载钩子，ReaderPanel.vue:542 同款先例）。
- 知悉：`.reader` 的 200ms `reader-in` 入场动画期间 hover 球，取到的 rect 偏移 ≤16px（translateX），概率与影响极低，不处理。

### 1.3 轮盘几何与动画

球贴阅读区右下角，轮盘只能朝**左上四分之一扇区**展开（朝右/朝下会出画）。三项沿弧均布：

| 项 | 角度（以球心为原点，-90°=正上） | 偏移（R=92px） | 图标 |
|---|---|---|---|
| 摘要 | -100° | (-17, -91) | `I.sparkle` |
| 翻译 | -135° | (-65, -65) | `I.languages` |
| 目录 | -170° | (-90, -16) | `I.list` |

几何核算（审核通过）：球心距右缘 42px，摘要项右缘距右缘 37px、目录项左伸距右缘 154px、摘要顶缘距底 199px（分离窗第三栏弹性 ≥440 下限，不出画）；相邻弦长 2·92·sin17.5°≈55.3px > 44px 无重叠；目录项底缘距底 80px > footer 52px 不遮操作条。

- 项径 44px 圆钮，与球同族视觉（bg-panel/border/shadow-1）；hover 项高亮 `bg-hover`；`title` 原生 tooltip + `aria-label`（44px 放不下文字标签，不造文字层）。
- 展开动画：项常驻 DOM（`v-show` 不用，靠 class 切换保 transition）。收起态 `transform: translate(-50%,-50%) scale(.35); opacity: 0; visibility: hidden`；展开态 `transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(1); opacity: 1; visibility: visible`，`--tx/--ty` 为上表偏移。`transition: transform var(--t-med) var(--ease-out), opacity var(--t-fast), visibility 0s linear`（展开即显；收起时 `transition-delay: var(--t-med)` 待动画播完再切 hidden）。
  - **`visibility: hidden` 必须有**（审核 B2）：`opacity:0 + pointer-events:none` 不把 button 移出 Tab 序，收起态按 Tab 会聚焦三个不可见项（配合球 focusout 收起，焦点落在视觉全盲元素上）。
  - **只 transition transform/opacity/visibility**（合成器属性，不碰布局轨道——避开 `grid-template-columns` 类渲染线程坑）；reduced-motion 下 base.css 全局 `transition-property: none !important` 自动瞬切（visibility 的 0s delay 延迟也随之失效，立即隐藏），天然合规，无需组件内特判。
- 展开态项 `pointer-events: auto`；收起态 `none`（隐形不挡点击、不可聚焦）。
- aria 配套（审核建议 7）：容器 `role="menu"`、项 `role="menuitem"`（与球 `aria-haspopup="menu"` 成套）。

### 1.4 项状态与点击语义

状态视觉（AiWheel 收 props 展示，语义判定在 ReaderPanel）：

- **进行中**（该项 loading）：外圈 2px accent 旋转环（CSS animation，reduced-motion 下全局 0.01ms 瞬切，同 `.ai-spin` 惯例）。
- **已有产物**（有摘要/有译文/有目录）：项右上角 5px `--accent-strong` 实心点。
- **不可用**（`aiEnabled=false`；翻译项 `translatable=false` 即中文为主文章）：整项 opacity .45 + `cursor: default`，点击由 ReaderPanel 拦截 toast / 面板文案，不执行动作。

点击语义（ReaderPanel 实现，见 §2.2）：

| 项 | 条件分支 |
|---|---|
| 摘要 | aiEnabled=false → toast；loading → 无操作（已在生成）；error → `runEnrich(true)` 重试；有摘要 → 滚动到摘要卡（`scrollEl.scrollTo({top:0})`，摘要卡在正文顶部；reduced-motion 用 auto）；无 → `runEnrich()` |
| 翻译 | aiEnabled=false → toast；loading → **取消**（`window.airss.ai.abort()`，runTranslate 的 ABORTED 分支自动恢复旧译文/idle，安静无 toast；loading 态项 `title` 写「翻译中，点击取消」，让取消可发现——审核建议 5）；其余 → `onTransBtn()`（现成四态：idle 翻译 / done 显隐译文 / error 重试） |
| 目录 | 已有 entries 或生成中 → `openAiPanel()`（markCurrentSection + 打开 AiToolsPanel）；无 entries 且 `tocAiEligible` **且 `aiEnabled`** → `await runToc()`，成功（`tocState==="done" && it.aiToc && it._id === ui.readerItemId`——补当前文判定防跨文残留，审核建议 2）→ `openAiPanel()` 自动展示列表；短文 / AI 关 → `openAiPanel()`（面板显示「文章较短，无目录」/「开启 AI 增强后可生成目录」文案；**AI 关不得进 runToc 分支**——`tocAiEligible` 不含 aiEnabled、runToc 无前置守卫，照旧会撞 preload 硬门控弹假错，审核 B1） |

单飞纪律不变：`runEnrich`/`runTranslate`/`runToc` 内部已有「发起前 `window.airss.ai.abort()`」与发起序守卫，轮盘只是新触发点，不复制管线逻辑。

## §2 组件与接线

### 2.1 新增 `src/components/AiWheel.vue`（约 220 行）

纯 UI 组件（同 AiToolsPanel 模式：状态与回调全由 ReaderPanel 透传，自有状态仅开合与监听管理）。

```ts
props: {
  aiEnabled: boolean;
  summaryState: "idle" | "loading" | "done" | "error";   // = aiState
  hasSummary: boolean;
  translatable: boolean;
  trState: "idle" | "loading" | "done" | "error";
  tocState: "idle" | "loading" | "done";
  hasToc: boolean;       // tocEntries.length > 0
  busy: boolean;         // aiBusyDot（呼吸点）
}
emits: { (e: "summary"): void; (e: "translate"): void; (e: "toc"): void }
defineExpose({ ballEl, close })  // 球元素（AiToolsPanel triggerEl 定位）+ 外部收起通道
```

内部：`open` ref；球 ref；`openWheel()`（挂 document mousemove + keydown 捕获）/ `closeWheel()`（卸载两类监听）；`inHotRect(x,y)`（球 rect + 常量扩展矩形判定）；focusout / resize / onBeforeUnmount 清理（全走 closeWheel）。三项按钮 `@click="emit('summary'); closeWheel()"` 等。

`close()`（审核建议 1）：键盘快捷键切文时鼠标可停在热区内，轮盘跨切文残留（props 已是新文状态，loading 环错挂）；由 ReaderPanel 在 `resetToc()`（切文 watcher / maybeExtractFull / onBeforeUnmount 三路径共用）里调用。

模板：容器 `.ai-wheel`（absolute 于 .reader，由**父级插槽位置**决定——组件根元素即定位锚，ReaderPanel 把 `<AiWheel>` 放 `.reader` 直下；`role="menu"`）> 球 button + 三个项 button（常驻 DOM，`role="menuitem"`）。

### 2.2 改 `src/components/ReaderPanel.vue`

- **撤顶栏按钮**：删 `<button ref="aiBtnRef" ...>`（AI sparkle + ai-dot）；删 `toggleAiPanel`，拆出 `openAiPanel()`（`aiPanelOpen=true; markCurrentSection(tocEntries.value)`）；`.ai-dot` 样式迁入 AiWheel（适配球内绝对定位）。
- 新增三个 handler：`onWheelSummary()` / `onWheelTrans()` / `onWheelToc()`（语义表 §1.4；`onWheelToc` 为 async，成功条件含 `it._id === ui.readerItemId`）。
- `resetToc()` 内加 `wheelRef.value?.close()`（三路径共用收轮盘）。
- 挂载：`.reader` 直下（footer 之后、AiToolsPanel 之前）：

```html
<AiWheel
  ref="wheelRef"
  :ai-enabled="settings.aiEnabled"
  :summary-state="aiState" :has-summary="hasSummary"
  :translatable="translatable" :tr-state="trState"
  :toc-state="tocState" :has-toc="tocEntries.length > 0"
  :busy="aiBusyDot"
  @summary="onWheelSummary" @translate="onWheelTrans" @toc="onWheelToc"
/>
```

- `trigger-el` 换绑：`const wheelBall = computed(() => (wheelRef.value as any)?.ballEl ?? null)`，`<AiToolsPanel :trigger-el="wheelBall" ...>`（其余 props/emits 不动）。
- 球点击关面板（B4）的接线：AiWheel 的球 click toggle 语义需要知道面板开合——不引入反向 props，**由 ReaderPanel 传一个 `panel-open` prop 进 AiWheel**，球 click handler 内 `panelOpen 时先 emit('toc'…)` 不合适——定案：AiWheel 增 prop `panelOpen: boolean`，球 click = `emit('closePanel') if panelOpen` + toggle 轮盘；ReaderPanel `@close-panel="aiPanelOpen = false"`。（避免子组件直接改父状态，保持纯 props/emits 单向流。）

### 2.3 改 `src/components/AiToolsPanel.vue`：place() 向上翻转

现状 `place()` 恒「右对齐 + 向下展开 + maxHeight 压制」。触发钮从顶栏（视口上部）换成悬浮球（视口底部）后，下方空间仅 ~52px，会被 `maxHeight` 下限 180 挤出视口。改造（DropdownSelect 同款翻转思路）：

```ts
const r = props.triggerEl.getBoundingClientRect();
const below = window.innerHeight - r.bottom - 12;
if (below >= 200) { /* 现状：top = r.bottom + 6，maxHeight = min(440, below) */ }
else {
  // 向上翻转：面板底边贴球顶 6px，高度受限于球上方空间
  bottom: window.innerHeight - r.top + 6 + "px",
  maxHeight: Math.max(180, Math.min(440, r.top - 12)) + "px",
}
```

核算（审核通过）：球触发时 below ≈ 52 恒走翻转；面板顶距视口底约 294px，620 高小窗充裕；`panelStyle` 每次全量替换，翻转分支不含 `top` 无残留；左定位（右对齐 + 视口钳制）不变。该改造对未来任何触发点通用（上方空间足则维持向下）。

## §3 撤除清单

- ReaderPanel 顶栏 AI sparkle 按钮（含 `.ai-dot` 样式与 `aiBusyDot` 在按钮上的用法——呼吸点迁至悬浮球）。
- `toggleAiPanel()`（被 `openAiPanel()` + AiToolsPanel 既有 `@close` 取代）。
- 无 Settings / preload / mock / env.d.ts 改动。

## §4 风险与守卫

| # | 风险 | 守卫 |
|---|---|---|
| R1 | 鼠标球→项路径穿空白区触发误收起 | 联合热区矩形（连续区域）保活，不按逐元素 hit 判定；clientX/Y 与 rect 同视口系，多显示器无跨屏换算问题 |
| R2 | 轮盘项出画（右缘/底缘） | 四分之一扇区朝左上（-170°/-135°/-100°，R=92），数值核算见 §1.3 |
| R3 | AiToolsPanel 从底部触发溢出视口 | place() 向上翻转（§2.3） |
| R4 | reduced-motion 布局楔死/动画拖渲染 | 只 transition transform/opacity/visibility；全局 `transition-property:none`+`animation:0.01ms` 自动瞬切；不碰布局轨道 |
| R5 | 悬浮球/轮盘挡正文交互 | 容器 pointer-events:none，仅球与项 auto；收起态项 pointer-events:none + visibility:hidden（不可聚焦） |
| R6 | detached 模式（浏览器 mock 走不到） | 球 absolute 于 .reader，两种定位模式均成立；回归时 `pinia._s.get('ui').detached=true` 强制激活验证 |
| R7 | document 监听泄漏 | closeWheel（mousemove+keydown 统一卸载）/ onBeforeUnmount / resize 三处全走 closeWheel |
| R8 | 键盘流冲突（全局 Esc 返回） | 轮盘 Esc 挂 document 捕获 + stopPropagation（同 AiToolsPanel/DropdownSelect 纪律）；与面板双开时按约定双闭（§1.2） |
| R9 | 面板与轮盘双浮层叠加 | 目录项点击 = 先 closeWheel 再 openAiPanel；**面板开着时点球 = 先关面板再 toggle 轮盘**（AiWheel prop panelOpen + emit closePanel，§2.2；AiToolsPanel onDocDown 豁免 triggerEl 球内 mousedown，须显式关）；双开时 Esc 双闭（§1.2） |
| R10 | 翻译取消语义新增（现 loading 时按钮 no-op） | 取消=abort() 复用 runTranslate 既有 ABORTED 分支，不新增管线状态；loading 态 title「翻译中，点击取消」 |
| R11 | 切文/全文替换时轮盘残留（鼠标停在热区不动无 mousemove） | `resetToc()` 内 `wheelRef.value?.close()`，三路径（watcher / maybeExtractFull / onBeforeUnmount）全覆盖 |

## §5 测试矩阵

自动化：`npm run typecheck`、`npm run build`（纯渲染层，preload 三套测试不受影响，不改不跑）。

浏览器回归（`?view=reader`，mock 数据 + `settings.aiEnabled=true`）：

1. 顶栏无 AI 按钮；悬浮球在右下（footer 上方，不遮按钮）。
2. hover 球 → 三项沿左上弧展开（位置/间距/动画）；移出热区 → 收起；点击球 toggle。
3. 摘要：手动模式（aiAutoCount=0）无摘要 → 点击触发 enrich（mock 流式）；已有摘要 → 点击滚顶见摘要卡；生成中 → 项有旋转环、点击无操作。
4. 翻译：中文文（translatable=false）置灰；英文文点击 → 翻译进度（轮盘环 + 正文译文）；翻译中再点 → 取消回 idle/旧译文。
5. 目录：结构文（h2-h4≥2）点击 → AiToolsPanel 打开（**向上翻转**、右下对齐球）+ 当前章高亮；无结构长文点击 → 生成完成后自动开列表；短文 → 开面板显示文案；**AI 关 + 长文点目录 → 面板出开启文案，不触发生成（B1）**。
6. AI 关闭（aiEnabled=false）：三项置灰，点击 toast；球呼吸点在任一任务在飞时亮。
7. detached 强制激活：球/轮盘/面板均正常。
8. reduced-motion（本机默认开）：展开瞬切无过渡。
9. 键盘：Tab 聚焦球展开、Tab 到项、Esc 收起焦点回球；Esc 不触发全局返回；**收起态 Tab 不落入不可见项（B2）**；面板+轮盘双开时 Esc 一次双闭。

## §6 文件清单

| 文件 | 动作 |
|---|---|
| `src/components/AiWheel.vue` | 新增（~220 行） |
| `src/components/ReaderPanel.vue` | 撤顶栏按钮 + 三 handler + 挂 AiWheel + trigger-el 换球 + resetToc 收轮盘 |
| `src/components/AiToolsPanel.vue` | place() 向上翻转 |
| `docs/design-system.md` | 增补轮盘规格条目 **C19**（悬浮球位置/几何/热区/状态角标；C18 已被 v1.2 占用，顺延编号）；修订 §4.3 阅读面板顶栏描述（翻译按钮 v1.4 已撤入面板、AI 按钮 v1.5 撤除换悬浮轮盘——文档已漂移，本次一并校正） |
| `docs/PLAN-AI-WHEEL.md` | 本方案 |
| `AGENTS.md` | v1.4 bullet 增补：AI 入口 = 悬浮轮盘（顶栏按钮已撤，AiToolsPanel 由轮盘目录项打开） |

## §7 实施顺序与审核记录

1. AiWheel.vue 组件（含热区/键盘/清理/visibility）。
2. ReaderPanel 接线（撤按钮、handler、trigger-el、resetToc 收轮盘）。
3. AiToolsPanel 翻转。
4. typecheck + build + 浏览器回归 §5。
5. design-system.md + AGENTS.md 记载。

### 审核记录（plan-code-reviewer，2026-09-09）

裁决：**必改后通过**。4 必改 + 7 建议 + 3 遗漏，处置如下：

- **B1**（目录分支漏 `aiEnabled`，AI 关长文会撞 preload 硬门控弹假错）→ 并入 §1.4 表 + §5.5。
- **B2**（收起态 opacity+pointer-events 不移出 Tab 序，键盘盲焦点）→ 并入 §1.3（visibility:hidden + 收起延迟切换）+ §5.9。
- **B3**（Esc 容器级监听在 hover 无焦点路径收不到、穿透全局流关掉阅读页）→ 并入 §1.2（document 捕获 keydown，open 挂/close 卸）+ R7/R8。
- **B4**（面板开着点球：onDocDown 豁免 triggerEl 球，面板不关 + 轮盘被盖）→ 并入 §1.1（球 click 先关面板）+ §2.2（panelOpen prop + closePanel emit）+ R9。
- 建议 1（expose close 防切文残留）→ §2.1/§2.2 + R11；建议 2（onWheelToc 成功条件补当前文判定）→ §1.4；建议 3（design-system 入清单修漂移）→ §6（实落为 C19，C18 已被 v1.2 占用）；建议 4（z-index 令牌 --z-sticky）→ §1.1；建议 5（翻译 loading 态取消可发现 title）→ §1.4；建议 6（.ai-dot 迁移适配非照搬）→ §1.1/§3；建议 7（role=menu/menuitem 配套）→ §1.3/§2.1。全部采纳。
- 遗漏（Esc 双开双闭约定）→ §1.2 + R8/R9；遗漏（多显示器坐标）→ §1.2/R1 免疑注；遗漏（reader-in 动画期 rect 偏移 ≤16px）→ §1.2 知悉不处理。

### 实施与回归记录（2026-09-09）

- **改动**：新增 `AiWheel.vue`（~230 行）；ReaderPanel 撤顶栏 AI 按钮 + `openAiPanel` 拆分 + 三 handler + `resetToc` 收轮盘 + trigger-el 换球；AiToolsPanel `place()` 向上翻转。typecheck / build 全绿。
- **回归真 bug（已修）**：轮盘键盘焦点转移原用 `requestAnimationFrame`——后台/节流窗格（IAB 回归环境实测）rAF 整族冻结，方向键展开后焦点滞留球上。改 `nextTick`（微任务，DOM patch 后 visibility 已立即 visible 可 focus）。教训并入 design-system C19。
- **回归环境噪音（非产品，备查）**：① IAB 节流（500ms 定时器实跑 1066ms）冻慢 mock 流式——enrich/translate 的 loading 中间态可用，完成态等待不可靠，改预置数据/延迟垫片验证；② IAB 宿主偶发把标签页重置为 about:blank（两次），长 sleep cell 的断言会被打断——「生成后自动开面板」首测假阴性即此因，复测通过；③ detached 切换会卸载 .main-col 读者组件并在 .reader-col 新建实例——测试脚本持切换前元素引用会拿到 rect 全 0 的脱 DOM 节点，切换后必须重新查询。
- **§5 九项全过**：几何实测 (-16,-91)/(-65,-65)/(-91,-16)（设计值 ±1px 舍入）；面板翻转底边距球顶 -6px 精确；B1/B4/双闭/取消分支（abort 调用计数 + 延迟垫片拉长 loading 窗）均验证；detached 几何与面板一致。
