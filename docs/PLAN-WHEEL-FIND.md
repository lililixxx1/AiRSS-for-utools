# PLAN-WHEEL-FIND — 文内搜索入口迁入 AI 轮盘（第四项），与侧栏搜索钮分离

2026-09-12 用户需求：「把文章页面内的搜索功能的按钮做到 ai 按钮中，把它从侧栏的搜索按钮中分离出来」。方案经 plan-code-reviewer 审核，P0-1/P1-1/P1-2 已并入正文。

## 0. 背景与目标

- 现状（v1.6 PLAN-READER-FIND）：阅读态下 Ctrl+F 与折叠轨搜索钮（`Sidebar.toggleRailSearch` 的改道分支）两入口都开 `ui.readerFind` 文内搜索栏。
- 目标：
  1. AI 轮盘加第四项「文内搜索」，点击直达——与摘要/翻译/目录同列，阅读区内一站式；
  2. 轨内搜索钮回归**纯列表搜索**语义（撤改道）：侧栏=列表搜索、轮盘/Ctrl+F=文内搜索，两个入口族彻底分离。
- 非目标：ReaderFind 面板本体、find.ts 搜索管线、backLadder 顺序、列表搜索管线均不动；阅读态 Ctrl+F 仍直达文内搜索（浏览器惯例，保留）。

## 1. AiWheel 第四项

### 1.1 项定义

- `key: "find"`、`icon: I.search`（已有）、`label: "文内搜索"`、`title: "文内搜索（Ctrl+F）"`。
- loading/done/dim 恒 false：非 AI 功能，**不受 aiEnabled 门控**——AI 关时三项 AI 置灰、搜索项仍可点。
- 弧序：摘要→翻译→目录→搜索（上→左）；items 数组序 = 弧序 = 方向键环形导航序（onBallKeydown/onItemKeydown 均按 `items.length` 泛化，无需改）。

### 1.2 几何（R 增幅维持密度）

44px 项、相邻弦长 = 2R·sin(θ/2)。现状三项 R=92、35° 间距、弦长 55.3px。四项取 **30° 等距四分之一弧、R=110**：

| 项 | 角度 | 偏移（R=110，Math.round 后） | 错峰 delay |
|---|---|---|---|
| 摘要 | -90° | (0, -110) | 0ms |
| 翻译 | -120° | (-55, -95) | 45ms |
| 目录 | -150° | (-95, -55) | 90ms |
| 搜索 | -180° | (-110, 0) | 135ms |

- 相邻弦长 2·110·sin15° ≈ **56.9px**（≥现状 55.3px，无重叠、密度不降）。满展开时长 330→375ms，观感可接受（审核 P2-6）。
- 出画核算：球 right:20/bottom:12 锚 `.reader-body`（overflow 可见，现项已溢出容器无碍）；-90° 项顶缘 = 球 rect 顶 -110px（需 reader-body 高 ≥166px，宿主异常视口 244-52=192 亦满足）、-180° 项左缘 = 球 rect 左 -110px（需宽 ≥174px，窄分离窗地板 280 满足）。
- **热区 120→140**：inHotRect「球 rect 向左/上扩 120px」改 140（R110+项半径22+缓冲8=140；从球心量 162 ≥ 132 含 30px 余量）。140 只多盖右下角正文空白，无命中面副作用。

### 1.3 其余不动 + 注释清单

双层分段动效/两档展开语义（hover 预览、点击锁定）/menu a11y/⌫ 捕获与输入态守卫全维持；项点击 `emit(it.key); closeWheel()` 与三项共用；emit 类型加 `"find"`。

改注释/aria 按 grep 清单（勿描述性列举漏点，审核 P1-1）：AiWheel.vue 内 `三项`（头注释 L6、键盘注释 L131、模板注释 L169）与 `120`（头注释 L11、inHotRect L78-85）、几何常量注释 L34、items 注释 L44、容器 `role="menu"` aria-label L168、球 aria-label/title L195-196、CSS 注释 L270（错峰 --d 0/45/90）。容器菜单名与球统一为「AI 工具（摘要 / 翻译 / 目录 / 搜索）」。

## 2. 入口改动

### 2.1 ReaderPanel.vue

- 新增 `onWheelFind()`：`ui.railSearch = false; ui.readerFind = true; ui.readerFindFocus++;`（顺关轨内面板防两搜索面并存——S2 同族纪律）。
- 模板 `<AiWheel @find="onWheelFind" ...>`。

### 2.2 Sidebar.vue — toggleRailSearch 撤改道（审核 P0-1：双向互斥）

- 删 `if (ui.view === "reader" && ui.readerItemId)` 改道分支，恒 `ui.railSearch = !ui.railSearch`（开即聚焦不变）。
- **开面板分支加 `ui.readerFind = false`**：反向并存封死——「文内搜索开着 → 点轨内搜索钮」也必须关文内搜索，两搜索面恒不并存（单向只关一半，审核定必改）。
- 注释更新：轨内搜索钮 = 折叠态**列表搜索**入口（v1.7 起不再改道文内搜索，文内搜索入口=轮盘第四项 / Ctrl+F）。
- 已知局限（按窗口分叉写，勿写死「无反馈」；审核 P2-3/P2-4）：
  - **非分离窗**阅读态：列表被阅读层盖住，轨内面板输入=过滤无视觉反馈，⌫ 关阅读即见结果（与展开态侧栏搜索框 C20 既有局限同款）；
  - **分离窗**：列表列可见，过滤有正常反馈，语义完整；
  - 两窗共通：`data.search` 无命中时 `filtered` 为空，App.vue 全局键盘流早退——阅读态 j/k（翻篇）/Enter/m/s/Shift+A 静默失效，清词即恢复。

### 2.3 App.vue — Ctrl+F

- 阅读态分支改 `ui.railSearch = false; ui.readerFind = true; ui.readerFindFocus++;`（防并存 + 重聚焦令牌，见 2.5）。列表态路径（focusSearch）不动。

### 2.4 ui.ts

- `readerFind` 注释：开 = Ctrl+F / 轮盘搜索项（v1.7 撤轨内搜索钮改道）；切文/卸载强关不变。
- 新增 `readerFindFocus: 0`（number 计数器，见 2.5）。

### 2.5 已开再触发重聚焦（审核 P1-2，v1.6 遗留缺陷一并修）

- 现状：`ui.readerFind` 已 true 时同值赋值不触发 ReaderFind 的 `watch(open)`，C20/PLAN-READER-FIND 声称的「面板已开再 Ctrl+F = 重聚焦 + 全选」实际不成立；轮盘搜索项会成为第二个放大该缺陷的入口（已开态点它无任何可见反应）。
- 修法（令牌）：ui store 加 `readerFindFocus: 0`；两个入口（Ctrl+F / onWheelFind）置 `readerFind = true` 后 `readerFindFocus++`；ReaderPanel 透传 `:focus-at="ui.readerFindFocus"`；ReaderFind 新 `watch(() => props.focusAt, () => { if (props.open) focusInput(); })`——`focusInput` 抽出既有 nextTick focus+select（open watcher 复用之，行为不变）。首开双触发（open watcher + focusAt watcher）幂等无害。

## 3. 文档同步（审核 P1-1 点位清单）

- `docs/design-system.md`：
  - **L441 C19 几何条**整条重写：四项表（上表角度/偏移/错峰 0/45/90/135ms）、弦长 ≈57；顺手清同条陈旧口径（「错峰 0/20/40ms」→ 0/45/90/135、「scale(.35)」→ 实码 rotate(-50deg) scale(0.2)）；
  - **L442 C19 热区条**：「左/上各扩 120px」→ 140px（新推导 110+22+8）；
  - C19 项状态语汇补「搜索项非 AI 功能，不受 aiEnabled 置灰」；点击语义补「搜索 = 开文内搜索栏（恒可用）」；
  - **L567 动效表**：错峰 0/45/90ms → 0/45/90/135ms；
  - **L533 §8.1 Ctrl+F 行**：补「阅读态开文内搜索栏（v1.6 起）」；
  - **L275**：「（Ctrl+F 同路）」限定为列表态；
  - **L492 图标表**：`search` 行用途补「AI 轮盘文内搜索项」；
  - **C20**：定位条入口改「Ctrl+F 与 AI 轮盘搜索项（v1.7 起轨内搜索钮回归纯列表搜索，开轨内面板顺关文内搜索）」；「已开再 Ctrl+F = 重聚焦 + 全选」声明经 2.5 修复后为真；已知局限补「短窗（reader-body 高 <约 430px）文内搜索面板 max-height 封顶会盖住右下轮盘，⌫/× 关闭即让位」（审核 P2-2）。
- `AGENTS.md`：v1.5 轮盘段「三项左上弧排」→ 四项（摘要/翻译/目录/文内搜索，R=110）；v1.6 文内搜索段入口描述同步；分离窗段「Ctrl+F 同路」限定列表态。
- `docs/PLAN-AI-WHEEL.md`：追加 2026-09-12 变更记录（第四项 + 几何 R110/30° 等距 + 热区新推导 110+22+8=140，替换 §1.2 旧 120 推导口径），不重写历史正文。
- `docs/PLAN-READER-FIND.md`：追加变更记录（入口迁轮盘、轨内钮撤改道+双向互斥、focusAt 重聚焦）。
- README/preview.html 无轮盘标记，不动；README:81 ⌫ 阶梯实机复验项继续有效。

## 4. 触达文件

| 文件 | 改动 |
|---|---|
| `src/components/AiWheel.vue` | 第四项 + R/角度/错峰/热区 140 + emit 类型 + 容器与球 aria + 注释（grep 清单见 §1.3） |
| `src/components/ReaderPanel.vue` | onWheelFind + `@find` + 透传 focus-at |
| `src/components/ReaderFind.vue` | focusInput 抽取 + focusAt watcher（props 加 `focusAt: number`） |
| `src/components/Sidebar.vue` | toggleRailSearch 撤改道 + 开面板顺关 readerFind + 注释 |
| `src/App.vue` | Ctrl+F 阅读态分支顺关 railSearch + focusAt++ |
| `src/stores/ui.ts` | readerFind 注释 + readerFindFocus 字段 |
| `docs/design-system.md` | §3 点位清单（7 处） |
| `AGENTS.md` | v1.5 / v1.6 措辞 |
| `docs/PLAN-AI-WHEEL.md`、`docs/PLAN-READER-FIND.md` | 变更记录 |
| `docs/PLAN-WHEEL-FIND.md` | 本文（定稿） |

## 5. 验收

- `npm run typecheck` 过。
- 浏览器（mock）回归：
  - ① 轮盘展开**四项中心 rect 实测断言**（±1px 落点 = 表列偏移，勿目测——照抄 PLAN-AI-WHEEL §7 口径）、间距均匀无重叠、左上不出画；
  - ② 点搜索项 → 文内搜索面板开且聚焦输入框；**已开态再点搜索项/再 Ctrl+F → 重聚焦 + 全选**（P1-2 修复项）；
  - ③ 折叠侧栏 + 阅读态点轨内搜索钮 → 开轨内面板（不再开文内搜索）；
  - ④ 阅读态 Ctrl+F → 文内搜索；
  - ⑤ aiEnabled=false：三项置灰、搜索项可点可开面板；
  - ⑥ ⌫ 阶梯不变（文内搜索先于关阅读）；
  - ⑦ 方向键环形导航覆盖四项；
  - ⑧ 双向互斥：文内搜索开着 → 点轨内搜索钮 → 文内搜索关、轨内面板开；轨内面板开着 → 轮盘点搜索/Ctrl+F → 轨内面板关、文内搜索开（P0-1 修复项）。
- 纯渲染层改动（无 preload/IPC），无新增实机专属风险。

## 6. 风险与裁决记录

- **双向互斥（P0-1 裁决）**：封死而非有意共存——「左搜列表右搜正文」并存可 argued，但 S2 纪律与单搜索面心智更简，且非分离窗下轨内面板 z400 盖 reader z300 视觉打架；采纳审核修法 a（toggleRailSearch 开面板分支顺关 readerFind）。
- **重聚焦（P1-2 裁决）**：修而非改口径——令牌计数器（ui.readerFindFocus）让 C20 既有声明成真，轮盘入口不复制缺陷。
- R 增大后项缘逼近热区边界 → 热区同步 140 覆盖（最大偏移 110+22=132 < 140，球心量 162 含 30px 余量）。
- 轮盘「AI 工具」定位被非 AI 项稀释——用户明确要求搜索进 AI 按钮，aria 保留「AI 工具」前缀，接受。
- 关闭不还焦（面板/轮盘关后焦点回落 body，非 §8.2 还原触发元素）——既有行为，记为已知限制不改（审核 P2-1）。
- 错峰 0/45/90/135 维持 45ms 步进家族；满展开 375ms 目验偏拖再压（审核 P2-6，暂不动）。
