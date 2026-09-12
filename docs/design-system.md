# AiRSS 设计系统 v1.0

> 2026-09-04 · 一期（核心阅读器）· 配套像素基准：[preview.html](preview.html)（同目录，浅/深双主题可交互预览）
> 本文档是 `src/styles/tokens.css` 与全部组件实现的唯一视觉规范，**取代** [PLAN-PHASE1.md](PLAN-PHASE1.md) §6 的临时令牌表（该表 hex 为参考图目测值，本文档完成 WCAG 调校）。
> 技术前提：Vue3 + CSS 变量令牌，无 UI 库，图标内联 SVG；uTools 小窗 800×620 主形态，分离窗 1200×800 三栏。

---

## 0. 记忆点（不许丢的东西）

1. **暖米白 + 单一橙**：侧栏 #F9F6F1 暖米白，内容区纯白，全站唯一强调色橙。不引入第二个彩色（红只作危险/错误语义，绿不使用）。
2. **卡片流**：单列大横幅卡片、12px 圆角、卡片之间靠间距分隔（阴影近无）。
3. **宽松但不空**：侧栏信息密度高于内容区，形成"导航密、阅读疏"的对比。
4. **克制的橙**：橙出现在固定的一组位置（徽章 / 统计数字 / "+" / 选中底 / 当前视图 / 进度条 / 未读点），除此以外一律中性色。橙色越多，越不值钱。

## 1. 设计原则

- **AA 是底线不是上限**：正文 ≥4.5:1，大字与非文本 ≥3:1；所有结论给出计算值，见 §3.3。
- **双通道编码**：状态从不靠颜色单独表达（未读 = 颜色 + 字重；错误 = 红点 + 图标 + 文案）。
- **键盘优先**：j/k/Enter/m/s/Shift+A/Ctrl+F/⌫ 全覆盖，鼠标只是捷径。主窗口 Esc 被宿主优先消费（实机验证），页内返回用 ⌫。
- **动效只做一件事**：确认操作已发生。120–200ms，ease-out，绝不循环装饰动画（骨架 shimmer 除外；悬浮球 idle 漂浮为第二个豁免例外——静态锚点的存在感提示，展开即暂停、reduced-motion 全局瞬切冻结，见 C19）。
- **中文排版**：不使用斜体（CJK 斜体是伪斜）；引用用左边框 + 缩进表达；数字/时间用 `font-variant-numeric: tabular-nums` 防跳动。

---

## 2. 画布、栅格与断点

| 形态 | 尺寸 | 布局 |
|---|---|---|
| uTools 小窗（主） | 800×620 | 两栏：侧栏 280 + 内容 520 |
| 小窗·侧栏折叠 | 800×620 | 图标轨 64 + 内容 736 |
| 分离独立窗口 | 1200×800（用户可自由缩放） | 三栏：侧栏 280 + 列表 400（360–400 弹性）+ 阅读 ≥440 |
| 分离窗·窄幅 <1080 | — | 侧栏自动降图标轨 64（不写设置）+ 列表 300–400 + 阅读 ≥340 |
| 分离窗·极窄 ≤704 | — | 图标轨 64 + 列表 260–360 + 阅读 ≥280（地板 604，更窄无解、接受裁切） |

- 基准网格 4px；所有间距、行高、圆角均为 4 的倍数（圆角 6 例外，用于 12px 高微型元素）。
- 内容区内边距 16px；卡片流为单列（卡片视图）或满宽行（列表视图），无多列网格。
- 800px 以下（防御分离窗极窄）：走「极窄 ≤704」档（图标轨 + 260/280 下限），三栏恒可见；阅读栏底栏放不下时换行两行（h52→~77）。
- 字号不做响应式缩放；密度由视图切换（卡片↔列表）承担。

---

## 3. 设计令牌

### 3.1 色彩 · 浅色（默认）

> oklch 为校准参考（≈），实现以 hex 为准。对比度列 = 与最常用相邻底色的计算值。

| 令牌 | 值 | oklch ≈ | 用途 | 对比度 |
|---|---|---|---|---|
| `--bg-app` | `#F9F6F1` | 0.97 0.009 95 | 侧栏底（暖米白） | — |
| `--bg-panel` | `#FFFFFF` | 1 0 0 | 内容区 / 卡片 / 弹层底 | — |
| `--bg-hover` | `#F1EDE5` | 0.94 0.008 92 | 侧栏条目 hover | — |
| `--bg-card-hover` | `#FAF8F3` | 0.965 0.007 92 | 白底卡片/列表行 hover | — |
| `--bg-active` | `#ECE7DD` | 0.92 0.010 90 | 按下态底 | — |
| `--bg-btn-muted` | `#F1EFE9` | 0.94 0.007 90 | 侧栏底部灰按钮底 | — |
| `--bg-btn-muted-hover` | `#E9E5DC` | 0.91 0.009 91 | 同上 hover | — |
| `--bg-selected` | `#FCEFE3` | 0.95 0.028 80 | 导航选中底 / 当前列表行 / 视图切换选中 | — |
| `--text-1` | `#292524` | 0.27 0.007 34 | 标题、正文主色 | 15.37 (白) / 14.07 (米白) |
| `--text-2` | `#57534E` | 0.44 0.011 74 | 摘要、次要说明、meta | 7.63 / 7.08 |
| `--text-3` | `#78716C` | 0.55 0.013 58 | 仅白底上的标签、时间戳 | 4.80 (白) |
| `--text-disabled` | `#A8A29E` | 0.64 0.014 59 | 禁用态（对比豁免） | — |
| `--accent` | `#F97316` | 0.70 0.191 49 | 品牌橙：徽章/主按钮底/进度渐变/装饰填充 | 2.80 (白) → **仅装饰填充，永不单独承载信息** |
| `--accent-hover` | `#FB8438` | 0.73 0.177 58 | 主按钮 hover | 配 ink 6.31 |
| `--accent-active` | `#F2650C` | 0.66 0.205 46 | 主按钮按下 | 配 ink 4.95 |
| `--accent-strong` | `#EA580C` | 0.65 0.222 41 | 非文本橙：图标/圆点/边框/进度条/开关 on | 3.56 (白) / 3.30 (米白) ≥3 |
| `--accent-deep` | `#C2410C` | 0.55 0.195 38 | **橙作为文字**：统计数字/选中行文字/链接强调 | 5.18 (白) / 4.80 (米白) / 4.58 (选中底) |
| `--accent-soft` | `#FCEFE3` | 0.95 0.028 80 | 选中底（同 `--bg-selected`，语义别名） | — |
| `--accent-ink` | `#431407` | 0.27 0.077 31 | 橙底上的文字/图标（主按钮字色） | 5.58 (on #F97316) |
| `--border` | `#E8E5DF` | 0.92 0.006 95 | 卡片/分隔线（装饰性） | — |
| `--border-strong` | `#D6D1C8` | 0.86 0.008 95 | 输入框静止边（装饰强化） | — |
| `--border-input` | `#8F8A80` | 0.60 0.012 85 | 输入框/下拉边界（承载识别，≥3:1） | 3.43 (白) |
| `--focus-ring` | `#EA580C` | 0.65 0.222 41 | `:focus-visible` 焦点环 | 3.56 / 3.30 ≥3 |
| `--danger` | `#DC2626` | 0.58 0.245 27 | 危险按钮底 / 错误红点 | 配白字 4.83 |
| `--danger-text` | `#DC2626` | — | 危险文字（浅色） | 4.83 (白) |
| `--danger-soft` | `#FDE8E8` | — | 危险确认弹窗图标底 | — |
| `--scrim` | `rgba(41,37,36,0.42)` | — | 弹层遮罩 | — |
| `--skel-a / --skel-b` | `#F0EDE6 / #F9F6F0` | — | 骨架基色/高光 | — |

### 3.2 色彩 · 深色（暖炭独立调校，非反色）

| 令牌 | 值 | oklch ≈ | 用途 | 对比度 |
|---|---|---|---|---|
| `--bg-app` | `#171412` | 0.21 0.005 70 | 侧栏底（暖炭） | — |
| `--bg-panel` | `#201C19` | 0.23 0.006 75 | 内容区底 | — |
| `--bg-elevated` | `#282219` | 0.25 0.010 75 | 弹层/菜单/tooltip 浮层底 | — |
| `--bg-hover` | `#2A241E` | 0.24 0.008 75 | 侧栏条目 hover | — |
| `--bg-card-hover` | `#26211C` | 0.23 0.008 78 | 列表行 hover | — |
| `--bg-btn-muted` | `#2A251F` | — | 灰按钮底 | — |
| `--bg-selected` | `#35261A` | 0.27 0.030 60 | 选中底（暖橙注入的炭） | — |
| `--text-1` | `#F2EDE4` | 0.93 0.012 90 | 标题、正文 | 14.51 (panel) / 15.73 (侧栏) |
| `--text-2` | `#B8B0A4` | 0.78 0.014 90 | 摘要、meta | 7.88 / 8.54 / 7.34 (浮层) |
| `--text-3` | `#928A7D` | 0.63 0.014 85 | 标签、时间戳 | 4.96 / 5.37 / 4.62 |
| `--text-disabled` | `#6B6459` | — | 禁用 | — |
| `--accent` | `#FB923C` | 0.75 0.183 56 | 品牌橙（提亮）：文字强调/图标/徽章底 | 7.47 (panel) / 8.10 (侧栏) / 6.43 (选中底) |
| `--accent-hover` | `#FDBA74` | 0.79 0.150 70 | 主按钮 hover | 配 ink 9.28 |
| `--accent-active` | `#F08633` | 0.73 0.166 58 | 主按钮按下 | 配 ink 6.09 |
| `--accent-strong` | `#FB923C` | — | 非文本橙（深色下与 accent 同值即达标） | ≥6.4 |
| `--accent-deep` | `#FDBA74` | — | **橙作为文字**（深色下"加深"改为"提亮"） | ≥9.2 |
| `--accent-soft` | `#35261A` | — | 选中底 | — |
| `--accent-ink` | `#431407` | — | 橙底上的文字 | 6.92 (on #FB923C) |
| `--border` | `#332C25` | — | 分隔线 | — |
| `--border-strong` | `#474036` | — | 强化边 | — |
| `--border-input` | `#746C5B` | — | 输入框边界 | 3.25 (panel) ≥3 |
| `--focus-ring` | `#FB923C` | — | 焦点环 | ≥6.4 |
| `--danger` | `#DC2626` | — | 危险按钮底（白字不变） | 配白字 4.83 |
| `--danger-text` | `#F87171` | 0.70 0.191 22 | 危险文字 | 6.11 (panel) / 6.63 (侧栏) |
| `--danger-soft` | `#3A211E` | — | 危险图标底 | — |
| `--scrim` | `rgba(10,8,6,0.6)` | — | 遮罩 | — |
| `--skel-a / --skel-b` | `#2B2620 / #352E26` | — | 骨架 | — |

### 3.3 对比度验证结论（含被否决方案）

计算方法：WCAG 2.x 相对亮度公式，比值保留两位。

**主按钮最终方案（任务留给设计师的定夺）**：主按钮 = `#F97316` 底 + `#431407` 字（600 字重）= **5.58:1**，全状态达标（hover 6.31 / active 4.95）。既保住品牌橙的鲜艳，又通过 AA。

被否决的方案及原因：

| 方案 | 对比度 | 结论 |
|---|---|---|
| `#7C2D12` 字 on `#F97316` 底（PLAN §6 建议） | 3.34 | 否决：按钮字号 14px，不满足 4.5:1 |
| 白字 on `#F97316`（参考图直觉做法） | 2.80 | 否决：连大字 3:1 都不达，任何字号不可用 |
| 白字 on `#EA580C` | 3.56 | 否决：仅大字勉强，14px 按钮不可用 |
| 白字 on `#C2410C` | 4.88 | 备选保留（若未来需要"白色系主按钮"），但视觉偏砖红，一期不用 |
| `#9CA3AF` 作 meta 文字（参考图目测值） | 2.54 | 否决：降级为 `--text-disabled` 专用；meta 改 `--text-2` |
| `#6B7280` on `#F9F6F1`（参考图摘要色直放侧栏） | 4.49 | 否决：差 0.01 不达标；统一改 `#57534E`（7.08） |

**橙色使用纪律**（这是本系统最重要的一条规则）：

- 橙**作为文字**：浅色必须 `--accent-deep #C2410C`（≥4.58），深色用 `#FB923C/#FDBA74`（≥6.4）。
- 橙**作为图标/圆点/边框**（非文本，≥3:1）：浅色用 `--accent-strong #EA580C`（≥3.30），`#F97316` 禁止单独出现在白色上承载含义。
- 橙**作为大面积填充**（徽章、主按钮底、进度渐变）：用 `#F97316`，其上文字必须 `#431407`。
- 焦点环 `--focus-ring`：浅 `#EA580C`（≥3.30）/ 深 `#FB923C`（≥6.4），对两种底色均 ≥3:1，满足 1.4.11。

### 3.3a 多配色体系（v1.4，PLAN-THEMES）

配色（`data-palette`）与明暗（`data-theme`）**正交**：

- 4 套配色：`warm` 暖米白（品牌缺省，即 §3.1/§3.2 两块，**逐字节锁定**，快照守门见 `scripts/check-theme-contrast.js`）、`sepia` 羊皮纸（赭陶）、`sage` 护眼绿（叶绿）、`indigo` 靛蓝（靛蓝）。
- 选择器约定：`html[data-palette="X"][data-theme="Y"]`（特异性 0,2,1）必胜 warm 缺省块（0,1,1）；`data-palette="warm"` 不命中配色块、回落缺省。每个配色提供 light + dark 两组完整令牌，明暗三档（auto/light/dark）逻辑不变。
- 完整令牌值与对比度实测见 `docs/PLAN-THEMES.md` §1；**改配色必须过 `node scripts/check-theme-contrast.js`**（含 warm 快照、令牌完整性、§3.3 纪律矩阵）。
- 配色纪律：每套配色的 accent 家族沿 §3.3 角色规则（作为文字用 accent-deep ≥4.5；图标/边框用 accent-strong ≥3；大面积填充用 accent + accent-ink ≥4.5）。跨配色恒定项：`--danger` 恒 `#DC2626` 配白字 4.83；浅色非 warm 配色的 `--danger-text` 降档 `#C21F1F`（染色底上达标）。豁免口径（与 warm 现状对齐）：`--text-3` 白底/panel 专用；`--danger-text` 面板底专用。
- 设置页配色选择器的 swatch 取色走 `--p-sw-panel/--p-sw-accent` 令牌（tokens.css `html[data-palette]` 块），**组件不得引入私有 hex**。

### 3.4 字体阶

| 级 | 值 | 字重/行高 | 用途 |
|---|---|---|---|
| display | 22px | 700 / 1.35 | 阅读面板标题（22，小窗）；分离窗可用 24 |
| h1 | 18px | 650 / 1.3 | 工具栏视图标题（"所有文章"） |
| h2 | 16px | 600 / 1.4 | 卡片标题 |
| body | 14px | 400 / 1.6 | 卡片摘要、设置行正文 |
| ui | 13px | 400–600 / 1.5 | 按钮、列表行、侧栏条目主行 |
| meta | 12px | 500 / 1.4 | 元信息行、时间、计数 |
| micro | 11px | 600 / 1.2 | 徽章、标签、统计卡 label（字距 +0.02em） |

阅读正文字号 4 档（`--reading-fs`，由设置 fontLevel 0–3 驱动）：**14 / 16（默认）/ 18 / 22**，行高恒 1.75，段距 0.75em，行宽流式（em 基准=阅读字号）：窄面板自然收窄，侧栏折叠/窗口变宽时正文随之变宽，上限 75em（经典舒适行宽上界，16px 档≈1200px）居中。

字体栈：

```css
--font-ui: -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC",
           "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif;
--font-serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif; /* 阅读衬线，可选开关 */
--font-mono: "Cascadia Code", Consolas, "SF Mono", monospace;          /* URL、feed 路径 */
```

### 3.5 间距 / 圆角 / 描边

- 间距阶：`--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 20 · `--s6` 24 · `--s8` 32 · `--s10` 40 · `--s12` 48
- 圆角：`--r-lg` 12（卡片、弹层、横幅）/ `--r-md` 8（按钮、输入框、选中条目、菜单）/ `--r-sm` 6（芯片、缩略图）/ `--r-full` 999（徽章、toast、圆点）
- 描边：1px `--border` 为主；输入框 1px `--border-strong`，聚焦时替换为 2px `--focus-ring`（用 box-shadow 实现，不改变布局）

### 3.6 阴影与海拔（克制）

| 令牌 | 值（浅） | 用途 |
|---|---|---|
| `--shadow-1` | `0 1px 2px rgba(41,37,36,.05)` | 卡片（近无） |
| `--shadow-2` | `0 2px 8px rgba(41,37,36,.07)` | 下拉菜单、tooltip、悬浮卡片 |
| `--shadow-3` | `0 12px 32px rgba(41,37,36,.14), 0 2px 8px rgba(41,37,36,.08)` | 弹层、确认框 |

深色模式阴影加深一档（rgba 黑 .45/.5/.6），另给弹层加 1px `--border-strong` 内描边补偿层次。海拔靠"底色变浅一档 + 边框 + 阴影"三件套，不靠大阴影。

### 3.7 动效令牌

| 令牌 | 值 | 用途 |
|---|---|---|
| `--t-fast` | 120ms | hover/颜色/选中底过渡 |
| `--t-med` | 160ms | 下拉、开关、分段控件、骨架显隐 |
| `--t-slow` | 200ms | 阅读面板滑入、侧栏折叠、弹层进出场 |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | 全站基础缓动 |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性 back-out（轻微过冲回弹）：悬浮轮盘项张开/球图标放大（C19），勿用于位移动画 |
| `--t-skel` | 1.4s linear infinite | 骨架 shimmer |
| `--t-progress` | 1.6s ease-in-out infinite alternate | 刷新进度条（不确定态） |

`prefers-reduced-motion: reduce` 时：所有过渡/动画 → `0.01ms`（骨架变静止双色块，进度条变 30% 不透明度脉动），见 §9。

### 3.8 z-index 阶

`100` 内容顶部进度条 · `200` 粘性工具栏/阅读栏 · `300` 小窗阅读覆盖层 · `400` 下拉菜单 · `500` 遮罩 · `600` 弹层/确认框 · `700` toast · `800` tooltip

---

## 4. 布局规格

### 4.1 主界面（小窗 800×620，两栏）

```
┌──────────┬──────────────────────────────┐
│ 侧栏 280 │ 内容 520                      │
│ (米白)   │ (纯白)                        │
│          │ ┌──────────────────────────┐ │
│ 品牌区    │ │ 工具栏 h56               │ │
│ 搜索 h36 │ ├──────────────────────────┤ │
│ 统计三卡  │ │                          │ │
│          │ │  卡片流（滚动）            │ │
│ 订阅源    │ │  padding 16 / gap 14     │ │
│ 分类      │ │                          │ │
│──────────│ │                          │ │
│ 底部按钮  │ └──────────────────────────┘ │
└──────────┴──────────────────────────────┘
```

**侧栏（280px，可滚动，底部固定）**

- 内边距：左右 16，上 16；`.sb-scroll` 与 `.sb-footer` 为 flex 上下结构，footer 恒在底部（高 56，含 padding 12）。
- 品牌区（高约 56）：`AiRSS` 20px/700 + 右侧 pill 徽章 `AI 驱动`（11px/600，底 `--accent` 字 `--accent-ink`，全圆角，padding 3 8）；下一行副标题 `智能 RSS 阅读器` 12px `--text-3`。
- 搜索框（h36，r8）：白底、`--border-strong` 边、内嵌搜索图标 16px + input 13px + 右侧 `Ctrl F` kbd 提示芯片。聚焦：边框转 2px 焦点环。
- 统计三卡（三等分，gap 8，高 56，r8，白底 + `--border` + `--shadow-1`）：数字 20px/700 `--accent-deep`（AA 4.8），label 11px `--text-3`。数字变化时 120ms 淡入。
- 订阅源小节：小节标题 12px/600 `--text-2` + 右侧 "+" 图标按钮（28×28，r8，底 `--accent`，图标 `--accent-ink`，hover `--accent-hover`）。
  - 条目（h44，r8，两行纯文字）：主行 13px/500（源中文名），副行 11px `--text-3`（英文域名）；右缘未读计数 12px/600 `--text-2`。
  - hover：底 `--bg-hover`，右缘浮出 `⋯`（more-vertical，28×28）→ 菜单：编辑订阅 / 删除订阅（红字）。
  - 选中：底 `--bg-selected`，文字与计数 `--accent-deep`（4.58）。
  - 错误态：见 §4.8。
- 分类小节：条目 h32 单行（13px/500）+ 右侧未读数；选中态同上。
- 底部（h56，gap 8）：`导入 OPML`、`设置` 两个灰按钮（h32，r8，底 `--bg-btn-muted` 字 `--text-2`，hover 底加深）+ 末位折叠图标按钮（32×32 固定宽，同 muted 样式，`‹` 图标，无文字）。小窗宽度下两文字按钮 12px。
- 折叠切换：底部工具行末位的图标按钮（中性灰，不占橙色配额）；折叠态移至图标轨底部（28×28 图标按钮，`›`）。点击切换 280↔64。grid 轨道随状态瞬时切换（`.app.sb-collapsed { grid-template-columns: 64px … }`），内容列全程贴合侧栏右缘、无中间空白；**禁止给 `grid-template-columns` 加 transition**——逐帧轨道重排会拖死渲染线程（2026-09 实测卡死）。
- 折叠态（64px 图标轨）：品牌字缩为 28×28 橙底 `A` 字块；搜索变 28×28 图标按钮；订阅源变源名首字方块（24×24，r-sm，底 `--bg-selected` 字 `--accent-deep`，右下角 8px 未读徽点）；底部只留三个图标（含展开按钮 `›`）。悬停显示 tooltip（源全名）。

**内容区（520px）**

- 工具栏 h56，padding 0 16，底边 1px `--border`：
  - 左：视图标题 16px/650 + 刷新图标按钮（32×32，hover 底 `--bg-card-hover`；刷新中图标旋转 0.9s linear infinite）+ `全部已读` 幽灵按钮（13px，done-all 图标 + 文字，hover 底 `--bg-card-hover`）。
  - 右：视图切换组（两枚 32×28 图标按钮拼合，r8，共享 1px 边；当前视图底 `--bg-selected` 图标 `--accent-deep`，另一枚图标 `--text-2`）+ 排序下拉（h32 r8，边 `--border-strong`，内容 `sort` 图标 + 当前排序 13px + chevron-down；菜单 4 项：相关性（默认）/ 最新发布 / 最旧发布 / 未读优先，选中项 `--accent-deep` + check 图标）。
- 卡片流：padding 16，卡片间 gap 14；虚拟滚动（可变高 + 高度缓存，见 PLAN §9）。
- 顶部进度条：内容区顶缘 h2 全宽，`--accent-strong → --accent` 渐变，不确定态左右位移（1.6s）；仅刷新中显示。

### 4.2 列表视图（同数据紧凑形态）

- 行高 40px，padding 0 12，hover 底 `--bg-card-hover`，当前键盘位（j/k）底 `--bg-selected`。
- 结构：`[未读点 7px] [标题 13px 单行截断 flex-1] [源名 12px --text-3] [时间 12px --text-3] [缩略图 56×40 r-sm（可选，有图才显示）]`，标题与源名间自动 margin。
- 未读：**7px 圆点 `--accent-strong`（3.35–3.56 ≥3:1）+ 标题 600 `--text-1`**；已读：无点，标题 400 `--text-2`。
- **列表视图引入圆点的理由**（卡片视图不用，忠实参考图）：卡片视图靠标题字重 + 摘要明暗双通道区分，卡片高度大、留白多，扫读节奏慢；列表 40px 行高、13px 单行标题，仅靠字重区分在快速 j/k 扫读与低视力场景下不可靠，7px 圆点提供预注意（pre-attentive）定位线索，且位置（标题左）与卡片视图标题起点对齐，跨视图心智一致。圆点仅列表视图使用，卡片视图保持参考图的"无点"记忆点（侧栏未读数字承担汇总）。
- 星标文章：标题前以 12px 实心星标（`--accent-deep`）替代圆点位置显示（已读且星标 → 星标；未读 → 圆点，星标移到行尾图标区，避免双前缀）。
- 行尾 hover 浮出：书签 / 分享 两个 28×24 图标钮（触达 ≥24×24）。

### 4.3 阅读面板

**小窗 = 覆盖内容列（绝对定位 inset:0，z300，200ms ease-out 从 translateX(16px)+淡入）**

- 顶栏 h52（粘性，白底 + 底边框）：`返回`（arrow-left + 文字 + kbd ⌫ 提示，幽灵按钮）｜右：`衬线` 切换（文字按钮，激活态底 `--bg-selected` 字 `--accent-deep`）+ 字号步进器（`A−` / 当前 px / `A+`，三段拼合 r8，边界档 `aria-disabled` 并降透明）。（v1.2 顶栏翻译按钮、v1.4 顶栏 AI 按钮先后迁出：AI 入口 = 阅读区右下悬浮轮盘，见 C19。）
- 正文区滚动，文章容器 `font-size: var(--reading-fs, 16px); max-width: 75em; margin-inline: auto; padding: 24 24 48`（流式行宽，块级不超容器宽，仅设上限）：
  - 标题 22px/700/1.35 `--text-1`；
  - 元信息行（h32，与标题间距 12）：源名 13px/600 `--accent-deep` + `·` + 时间 12px `--text-3` + `·` + clock 图标 + 阅读时长 12px；行尾 `AI 摘要`（sparkle，v1.2：自动摘要关闭且无摘要时）+ `原文` 幽灵小按钮（external-link 图标，shellOpenExternal 打开）。
  - 正文 `--reading-fs`（14/16/18/22）· 行高 1.75 · 段距 0.75em · `--text-1`；`h2` 18px/650 上下 1em；`blockquote` 左边框 3px `--accent-strong` + padding-left 14 + 色 `--text-2`（**不用斜体**）；`img` 圆角 8 + `max-height 60vh`；`a` 色 `--accent-deep` 下划线；`code` 底 `--bg-hover` r-sm padding 2 6 mono 0.9em。
- 底部操作条 h52（粘性，白底 + 顶边框，gap 8）：`已读`切换（check 图标，已读态按钮底 `--bg-selected` 字 `--accent-deep`）/ `收藏`（bookmark，激活实心橙）｜弹簧｜`复制链接`（copy）/ `浏览器打开`（external-link）。全部 ≥28×32 触达。

**分离窗 = 第三栏（弹性 ≥440，常驻，不滑入）**：同结构，标题升 24px，无"返回"按钮（列表与阅读并排，Esc 语义改为"焦点回列表"）。窄面板下行宽按 `100% − 48px` 自然收窄，不做居中留白。

### 4.4 分离窗口三栏（1200×800）

- 侧栏 280（同 4.1）+ 列表栏 400（固定列表视图，含自己的精简工具栏 h48：视图名 + 计数 + 刷新）+ 阅读栏 flex ≥440。
- 列表栏与阅读栏之间 1px `--border`；阅读栏底 `--bg-panel`，列表栏底 `--bg-panel`，侧栏底 `--bg-app`。
- detach 时 `removeSubInput()`（分离窗无宿主子输入框），侧栏搜索框成为唯一搜索入口。
- detach 时 `removeSubInput()`（分离窗无宿主子输入框），侧栏搜索框成为唯一搜索入口；侧栏折叠（手动/窄幅自动）时由图标轨的搜索钮唤出浮层输入兜底（Ctrl+F 同路）。
- 窄幅自适应（2026-09-11）：window resize 监听维护 `ui.winNarrow`（<1080），`ui.narrowDetached` getter 驱动 `.app.detached.sb-auto`——侧栏自动降图标轨 64 + 列表/阅读最低宽下调（≤704 再压一档），三栏在 604px 地板内恒可见，不写 `sidebarCollapsed` 设置。AI 悬浮球锚定正文区容器 `.reader-body`（不含底栏），底距 12px 随底栏换行高度自然让位。

### 4.5 设置页（覆盖内容列，同阅读面板层级 z300）

- 顶栏 h52：`返回` + 标题 `设置` 16px/650。
- 内容 max-width 560 居中，5 组卡片流（r12，白底，1px `--border`，`--shadow-1`，间距 12，组内行 h48）：
  1. **外观**：主题 三态分段（浅色/深色/跟随系统，sun/moon/monitor 图标 + 文字，默认跟随系统）· 正文字号 四档分段（小 14/标准 16/大 18/特大 22）· 默认视图 二段（卡片/列表）。
  2. **AI 功能**：总开关「AI 摘要与标题增强」（默认关）·「显示 AI 优化标题」开关 ·「自动摘要」下拉（关闭（手动按钮）/仅当前/连续 3 篇/连续 5 篇，v1.2，C17 DropdownSelect）· AI 引擎分段（uTools AI / 自定义 BYOK）+ 模型下拉 + 今日额度只读行（BYOK：接口地址/模型名/API 密钥/允许 http 开关）。
  3. **通知**：`新文章通知` 开关（role=switch，on 底 `--accent-strong` 白点）+ 副文案"仅在该源未读 ≥10 时提醒"。
  4. **数据**：刷新频率 下拉（手动/15 分钟/30 分钟（默认）/1 小时/6 小时）· 每源保留 下拉（50/100/200（默认）/500 篇）· 按钮行 `导入 OPML`（upload）/`导出 OPML`（download）· 分隔线后危险区：`清空所有数据…`（红描边按钮：边 `--danger` 字 `--danger-text`，hover 底 `--danger-soft`）→ 二次确认弹层（§5 C15）：alert 图标（`--danger-soft` 底圆 + `--danger` 图标）、标题"清空所有数据？"、正文"将删除 128 篇文章与 6 个订阅源，此操作不可恢复。"、按钮 `取消` / `确认清空`（danger 实底白字）。删除订阅确认复用同一弹层模式。
  5. **关于**：版本 `1.0.0` · `检查更新` · 开源说明"MIT · 查看源码"（external-link）。
- 所有设置行标签 13px/500 `--text-1` 左，控件右，行间 1px `--border` 分隔（组内）。

### 4.6 添加订阅弹层（模态 400×自适应，居中，z600，scrim）

三步 + 失败态，顶部步进指示（1 发现 → 2 确认 → 3 完成，当前步 `--accent-strong` 圆点 + 12px 标签，已完成步 check）：

1. **校验中**：spinner（16px，`--accent-strong` 旋转弧）+ `正在探测 Feed…` + 已试路径清单实时滚动（mono 12px：`✓ /feed · 200` / `· /rss.xml …`）。
2. **发现候选**（单选列表）：每项 = radio + 源标题 13px/500 + 类型徽章（RSS/Atom/JSON Feed，11px）+ `最近 30 篇` 12px `--text-3` + url mono 11px；默认选第一个。底部 `上一步`（幽灵）/ `继续`（主按钮）。
3. **确认**：名称输入框（预填发现标题）· 分类选择（现有分类芯片 + `+ 新建`，选中芯片底 `--bg-selected` 字 `--accent-deep`）· 刷新频率下拉（默认跟随全局 30 分钟）。底部 `取消` / `添加`（主按钮，点击后 toast `已添加 · 正在抓取首批文章`）。
- **失败态**：alert 图标 + `未在该地址发现 Feed` + 已试路径列表（mono：`/feed → 404`、`/rss.xml → 404`、`/atom.xml → 超时`）+ 手动输入框（占位 `粘贴 Feed 直链…`）+ 提示文字 `也可试试 RSSHub：https://rsshub.app/{域名}（仅提示，不自动请求）` + `重试` 按钮。
- 交互：role=dialog + aria-modal，Tab 圈禁，Esc = 取消，初始焦点 = 首个输入框/默认选项，关闭后焦点回触发钮。

### 4.7 空态（三态，占据整个内容列）

1. **首用引导**：72px 橙色圆内白色 rss 图标（底 `--accent-soft`，图标 `--accent-deep`）→ 标题 18px/650 `从第一个订阅源开始` → 副文 13px `--text-2` `粘贴一个站点地址，AiRSS 会自动发现它的 Feed` → URL 输入行（flex：输入框 + `添加` 主按钮）→ `导入 OPML` 幽灵按钮 → 分隔 `或从这些源开始` 12px `--text-3` → 三个推荐芯片（阮一峰的网络日志 / 少数派 / V2EX，芯片 r-full 边 `--border-strong` hover 底 `--bg-selected`）。
2. **分类无文章**：40px 图标（folder，`--text-3`）+ `「技术」分类还没有文章` 16px/600 + `切换到全部，或检查订阅源是否正常同步` 13px `--text-2` + `查看全部文章` 幽灵按钮。
3. **全部读完（庆祝式）**：64px 圆底 `--accent-soft` 内 check 图标 `--accent-deep` 24px + 外围 4 颗 4px 橙点装饰（静态，不动画）→ `全部读完了` 18px/650 → `128 篇已读清零，去散散步吧` 13px `--text-2` → `查看收藏（6）` 幽灵按钮。Shift+A 触发时同屏 + toast。

### 4.8 微状态

- **加载骨架**（首屏/切换视图/同步中）：卡片骨架 = 横幅块（148px）+ 标题条（60% 宽 h14）+ 两条摘要条（h10）+ meta 条（40% 宽 h10）；列表骨架 = 行条 h40。双色 shimmer（`--skel-a` 基 + `--skel-b` 高光 1.4s 位移）。`aria-busy="true"`。
- **源错误**：订阅源条目主行右缘、未读数左侧 8px `--danger` 实心圆点（带 2px `--bg-app` 环，保证任何底色上 ≥3:1）；hover/focus 出 tooltip（z800，`--text-1` 反色底或 `--bg-elevated`）：alert 图标 + `同步失败：DNS 解析错误` + `上次成功：3 天前` + `重试` 文字按钮。错误源条目本身不置灰（数据仍可读）。
- **刷新进度条**：见 4.1。完成即隐藏（无淡出），结果走 toast。
- **toast**：底部居中 16px，r-full，padding 8 14，浅色 = `--text-1` 底 `--bg-app` 字 / 深色 = `--text-1` 反转；13px/500，`--shadow-2`，2.6s 自动消失，role=status aria-live=polite；错误 toast 前置 alert 图标 + `--danger-text` 图标色，role=alert。
- **tooltip**：r8，`--bg-elevated`，1px `--border-strong`，12px `--text-2`，padding 8 10，max-width 240，出现 120ms 淡入。悬停 400ms 延迟触发。

### 4.9 横幅占位图（无图数据 / 离线封面）

预览稿用纯 CSS 渐变模拟编辑风封面（后续可沿用为无封面文章的生成封面）：

- **dusk（周刊类）**：`radial-gradient(120% 90% at 80% 10%, #FDBA74 0%, transparent 55%), radial-gradient(90% 120% at 15% 90%, #7C2D12 0%, transparent 60%), linear-gradient(118deg, #F97316 0%, #EA580C 45%, #9A3412 100%)`，左上 kicker（11px/600 字距 0.08em `#FFF7ED`），右下衬线大数字（Georgia 56px/700 `#FFF7ED`）。
- **sunrise（资讯类）**：`radial-gradient(60% 60% at 50% 115%, #FDBA74 0%, #F97316 35%, transparent 70%), linear-gradient(180deg, #C2410C, #7C2D12)`，中央偏下标签文字。
- 渐变内文字为装饰性（豁免对比度），但实际 ≥4.5。深浅主题同图（按图像处理，不随主题反色）。

---

## 5. 组件规格

### C1 按钮（四变体 × 五态）

| 变体 | 规格 | hover | active | 禁用 |
|---|---|---|---|---|
| primary 主 | h32 r8 底`--accent` 字`--accent-ink` 13px/600 | 底 `--accent-hover` | 底 `--accent-active` | 底 `--bg-btn-muted` 字 `--text-disabled` |
| secondary 次 | h32 r8 白底 1px `--border-strong` 字 `--text-2` | 底 `--bg-card-hover` | 底 `--bg-active` | 同上降透明 |
| ghost 幽灵 | h32 r8 透明底 字 `--text-2` | 底 `--bg-card-hover` | 底 `--bg-active` | 字 `--text-disabled` |
| danger 危险 | h32 r8 底`--danger` 白字（实底）/ 或描边版：1px `--danger` 字 `--danger-text` | 描边版底 `--danger-soft` | 加深 5% | 降透明 |

- `:focus-visible` 一律：`outline: 2px solid var(--focus-ring); outline-offset: 2px`（主按钮上环落在白底相邻区，≥3:1 成立）。
- 图标按钮：默认 28×28（工具栏 32×32），图标 16px，无文字，`aria-label` 必填；主操作 "+" 按钮为 primary 变体的方形版。
- 全部触达 ≥24×24（视觉小于 24 的必须用透明 padding 扩展命中区）。

### C2 输入框 / 搜索框

- h36（弹层内 h32）r8，白底（深色 `--bg-elevated`），1px `--border-strong`，13px `--text-1`，placeholder `--text-3`；左侧内嵌图标 16px（搜索）时 padding-left 36。
- 聚焦：border 透明 + `box-shadow: 0 0 0 2px var(--focus-ring)`（2px 环，不改布局）；失焦 120ms 过渡。
- 错误：环转 `--danger` + 下方 12px `--danger-text` 错误文案。
- 右侧可挂 kbd 提示芯片（`Ctrl F`：h18 r-sm 底 `--bg-hover` 11px mono `--text-2`）或清除按钮。

### C3 文章卡片（卡片视图）

- r12，白底，1px `--border`，`--shadow-1`；整卡可聚焦（tabindex 参与 roving）。
- 横幅（可选）：高 148，全宽，r 12 12 0 0，`object-fit: cover`，lazy-load；无图卡片无此层。封面门控（双层）：入库时 `extractCover` 跳过图标/头像类 URL 与显式小尺寸 img；渲染时 `@load` 复查自然尺寸，宽 <480 / 高 <100 / 高 > 宽×2（窄长截图）一律不渲染横幅，卡片回退纯文字形态——拉伸小图当通栏是被禁止的。
- 内容 padding 12 14 14：
  - 标签行：分类 tag（11px/600 `--text-3`，可带 4px 圆点分类色？**否**——单彩色原则，纯文字）。
  - 标题：16px/600 `--text-1`（未读）/ `#44403C`·550（已读），最多 2 行截断。
  - 摘要：14px `--text-2`（未读）/ `--text-3`（已读，白底 4.8 达标），2 行截断，行高 1.6。
  - meta 行（margin-top 10）：源名 12px/600 `--text-2` · 时间 12px `--text-3` · `clock 14px + 9 分钟` `--text-3`；右缘书签 + 分享图标钮（28×24 线性 `--text-3`，hover `--text-1` + 底 `--bg-hover`；书签激活 = 实心 `--accent-deep`）。
- hover：底 `--bg-card-hover`（banner 不变色），120ms；卡片无 transform（克制）。
- 未读表达（**无圆点**，忠实参考图）：标题字重 + 摘要明暗双通道 + 侧栏/工具栏数字。
- 键盘当前位：卡片外框 2px `--focus-ring`（同 focus-visible 样式，由 roving tabindex 驱动）。

### C4 列表行：见 §4.2。

### C5 统计卡：见 §4.1（数字 20px/700 `--accent-deep`，label 11px）。

### C6 导航项（订阅源 / 分类）

- 订阅源 h44 两行 / 分类 h32 单行，r8，padding 8 10。
- 默认：文字 `--text-1`（主行）/ `--text-3`（副行、计数）；hover 底 `--bg-hover` + 浮出 ⋯；选中底 `--bg-selected` + 全部文字 `--accent-deep`。
- ⋯ 菜单（z400，r8，min-width 128，`--shadow-2`）：`编辑订阅` / `删除订阅`（`--danger-text`），项 h36 padding 0 12，hover 底 `--bg-hover`。

### C7 徽章 / 标签

- `AI 驱动` 品牌徽章：r-full，底 `--accent`，字 `--accent-ink` 11px/600，padding 3 8。
- 中性标签（类型/分类）：r-full，底 `--bg-hover`，字 `--text-2` 11px/600。
- 二期徽章：底 `--bg-selected` 字 `--accent-deep`。

### C8 工具栏 / 视图切换 / 排序下拉：见 §4.1。下拉菜单项 h36，选中项 `--accent-deep` + 右缘 check 16px。

### C9 开关（role=switch）

- 轨 36×20 r-full；off：轨 `--bg-active`（浅）/ `#474036`（深）点白；on：轨 `--accent-strong` 点白（白点对橙轨 3.56 ≥3）。点 16px，位移 16px，160ms `--ease-out`。禁用降透明 0.5。标签在左，控件在右，整行可点（h48 行，触达充足）。

### C10 分段控件（radiogroup）

- 容器 r8 内拼合，项 h32 padding 0 12 13px/500；选中底 `--bg-selected` 字 `--accent-deep`；未选中字 `--text-2` hover 底 `--bg-hover`；容器 1px `--border-strong`。主题三段带 16px 图标。

### C11 弹层 / 确认框

- r12，白底（深 `--bg-elevated` + 内描边），`--shadow-3`，min-width 360（确认框 340），max-height 80% 内滚。
- 头部：标题 16px/650 + 关闭钮（28×28）；底部：按钮右对齐 gap 8，主按钮在最右。
- 进出场：scrim 160ms 淡入；面板 200ms scale 0.98→1 + 淡入；关闭反向 160ms。焦点圈禁 + 返回焦点。

### C12 单选行（发现候选）：h52，radio 20px（未选：1.5px `--border-input` 圈；选中：圈 `--accent-strong` + 中心 8px 实心），选中行底 `--bg-selected`。

### C13 骨架 / 进度条 / toast / tooltip：见 §4.8。

### C14 推荐芯片：h28 r-full 1px `--border-strong` 13px `--text-2` padding 0 12；hover 底 `--bg-selected` 字 `--accent-deep`。

### C15 焦点环（全局）

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: var(--r-sm, 6px); /* 不裁剪环 */
}
```

### C16 AI 摘要卡（AiSummaryCard，二期，阅读面板唯一视觉主角）

- 位置：阅读面板元信息行与正文之间，`margin: 0 0 20px`，仍在正文限宽内。
- 形态：`--accent-soft` 底（深色 `#26201A`）+ 1px `--border` + **左缘 3px `--accent-strong`**（与 blockquote 同族的强调语汇，不做大面积色块）；r-md；padding 12 14。
- 头行（h≈24）：sparkle 图标 15px `--accent-deep` + 「AI 摘要」12.5px/650 `--text-1` + `AI 生成` badge-muted 10px r-full（AIGC 标识恒显）｜弹簧｜`重新生成` 幽灵小按钮（仅 done 态）。
- 摘要文本：14px/1.7 `--text-1`，user-select:text；流式 loading 态尾部 `▍` 呼吸光标（`--accent-deep`，1s steps 闪烁），无文本时占位「正在生成…」。
- tags：11px/600 `--accent-deep`，`--bg-panel` 底 + 1px `--border` r-full chip，≤2 个，margin-top 8。
- error 态：降级为一句中性说明 + 错误码 12px `--text-3` + `重试` 幽灵小按钮；**失败不阻塞阅读**（AI 关闭/不可用/未触发时整卡不渲染）。
- 列表侧 AI 表达（克制）：卡片标签行可加 ≤2 个 AI tag（同 chip 样式、`--accent-deep` 字）；标题被改写时（titleNorm > titleZh 优先于原题）尾部 `AI` 微标（10px/700 描边章 `--accent-deep`，r-sm，opacity 0.85）；阅读面板标题下「原标题：…」12.5px `--text-3` 对照行。全部受设置「显示 AI 改写标题」开关门控。

---

### C17 下拉组件（DropdownSelect / ComboboxInput，2026-09 增补）

- **背景**：原生 `<select>`/`<datalist>` 弹层由 OS 绘制，在 uTools 无边框/透明窗内定位错位（实机：添加订阅选分类时弹层偏移）。全站替换为自定义组件。
- **DropdownSelect**（单选）：触发钮视觉与 `.input`（C2）同族（36h / border-strong / r-md / bg-panel），右端 chevronDown（开合旋转 180°）；面板 Teleport 到 body + `position: fixed` 按触发钮 rect 定位（避开弹窗 `overflow` 裁剪），下方空间不足翻转到上方；`max-height 264` 滚动；项高 32，当前项 `--accent-deep`/600 + check 图标，hover `--bg-hover`。深色面板 `--bg-elevated`。z 取 `--z-toast`（面板会在 z-modal 弹层内使用，必须更高）。
- **ComboboxInput**（可输入下拉，分类选择）：输入框本体复用 `.input`，右侧 chevron 开合；聚焦/输入即出建议（不区分大小写 includes，≤12 条），`↑↓` 高亮、Enter 取高亮项（无高亮保留键入文本，支持新建分类）、Esc 关闭不移动焦点。
- **键盘纪律**：组件内已处理的键（↑↓/Enter/Space/Esc）一律 `stopPropagation`——全局键盘流（Enter 开篇/⌫ 返回）不得穿透面板。滚动/resize 即关面板（fixed 面板不随滚动移动）。输入态 ⌫ 仍为编辑键。
- **已部署位置**：设置页（刷新频率/每源保留/AI 模型/自动摘要）、添加订阅与编辑订阅弹窗（分类 Combobox + 刷新频率）。

---

### C18 AI 译文块 / 手动 AI 按钮 / 搜索高亮与计数（v1.2 增补）

- **AI 译文块（阅读面板，`.ra-trans`）**：插在原文各段之后；左边框 2px `--accent-strong` + padding-left 12、0.92em、行高 1.7、色 `--text-2`、opacity 0.82——与 blockquote 同族但更弱的"译文语汇"，不与原文抢视觉。纯文本节点插入（createElement+textContent，安全基线：渲染层不注入 HTML）；收起=移除节点，重进文章自动恢复展示（item.aiTrans 缓存）。
- **手动 AI 摘要按钮（自动摘要=0 时）**：阅读面板元信息行尾（sparkle + 「AI 摘要」，幽灵小按钮）；列表卡片 meta 悬浮区与列表行悬浮区首位（icon-btn，aria「AI 摘要」）。生成中隐藏（busy 集），有摘要后永久隐藏（摘要卡接管）。
- **搜索高亮（mark.hl）**：卡片/列表行标题内，`--accent-soft` 底 + `--accent-deep` 字，r2，padding 0 1；≤3 词、每词首个匹配；由 `highlightSegments` 纯函数切段后模板文本插值渲染（非 innerHTML）。
- **搜索状态（工具栏右侧）**：`N 个结果`（12px num `--text-3`）；正文扫描中「正文中检索…」；超预算截断显「部分扫描」（title 悬浮说明已扫描篇数）。

---

### C19 AI 悬浮轮盘（AiWheel，v1.5 增补）

- **背景**：AI 入口从阅读顶栏按钮（v1.4 AiToolsPanel 触发钮）迁为阅读区右下悬浮轮盘——hover 即达、点击直达动作，不打断阅读动线；顶栏 AI 按钮撤除。
- **悬浮球**：44px 圆钮 absolute 于 `.reader`（right 20 / bottom 64，footer 上方不遮操作条），z 取 `--z-sticky`；`--bg-panel` + border-strong + shadow-1、sparkle 18px `--text-2`、常态 opacity 0.92，hover/展开加深（bg-card-hover + `--accent-deep` 字）；任一 AI 任务在飞显呼吸点（6px `--accent-strong`，1.1s 脉动，绝对定位球内右上）。不随正文滚动（不在 .reader-scroll 内）；detached 分离窗两种定位模式下均成立。
- **轮盘几何**：三项 44px 圆钮沿**左上四分之一弧**展开（球贴右下角，朝右/朝下会出画）：摘要 -100°（-17,-91）/ 翻译 -135°（-65,-65）/ 目录 -170°（-90,-16），R=92px；相邻弦长 ≈55px 无重叠。展开动画只 transition transform/opacity（收起态聚球心 scale(.35) → 圆周 scale(1)，`--t-med` ease-out，错峰 0/20/40ms）；reduced-motion 全局瞬切天然合规，不碰布局轨道。
- **热区模型**：容器 `pointer-events:none` 不挡正文（点击/选择穿透），仅球与展开态项 auto；open 期间挂 document mousemove——坐标在「球 rect 左/上各扩 120px」联合矩形内保活（连续区域，球→项任何直线路径无缝，无间隙误收起），移出即收；keydown 捕获 Esc 收起 + 焦点回球（hover 展开时焦点可能在 body，容器级监听收不到）。**两档展开语义（2026-09-09 定）**：hover = 预览（移开即收）；**点击球 = 展开并锁定**（pinned，移开热区不收，再次点球 / 点功能项 / Esc / 切文才收）。
- **动效（双层分段时序，2026-09-09 三次打磨定稿）**：项为双层结构——外层 `.ai-witem` 管 translate（球心 → 弧位，`--t-med` ease-out，错峰 --d 0/45/90ms），内层 `.ai-witem-in` 管 rotate(-50deg)+scale(0.2) 弹性张开（`--t-slow --ease-spring`，delay = --d+40ms）——位移先到位、旋转缩放后收口，合成「甩出 → 张开」的弧感（单层同缓动是直线插值，观感死板的根因）。展开时球外圈一次性涟漪（::after，scale 1→1.9 / opacity .45→0 / 420ms；**基础态必须 opacity:0**——播完与 reduced-motion 瞬切都回落基础态）+ 球体 shadow-1→shadow-2 抬升（transform 已被 idle 漂浮占用，本体不做缩放）；收起 = t-fast 快速收拢（内外层都显式 t-fast，无弹性不拖沓）；球 idle 轻漂浮（translateY ±3px / 3.2s，展开时暂停）；图标层 hover/展开弹性放大微转（与球的 float 分层不抢 transform）；展开态项 hover 回弹 = 内层 scale 1.12 + 外层 shadow-2（transform 分量归内层管）。busy 旋转环/done 角标挂外层不随入场旋转。全部走 transform/opacity 合成器属性，reduced-motion 全局瞬切天然合规。
- **键盘（menu-button 惯例）**：球聚焦**不**自动展开（避免 mousedown-focus 与 click toggle 互搏），方向键/Enter/click 展开；容器 `role="menu"`、项 `role="menuitem"`、方向键环形导航；**收起态 `visibility:hidden` + `tabindex=-1` 双保险**——opacity+pointer-events 不把 button 移出 Tab 序，会留键盘盲焦点。焦点转移到项用 nextTick（微任务）：rAF 在后台/节流窗格被冻结，焦点会滞留球上（2026-09 回归实测修复）。
- **项状态语汇**：进行中 = 外圈 2px accent 旋转环（inset -4）；已有产物 = 右上 6px `--accent-strong` 实心点；不可用（AI 关 / 中文正文翻译项）= opacity .45 + cursor:default。title 原生 tooltip（翻译 loading 态写「翻译中，点击取消」，让取消可发现）。
- **点击语义**（直达动作，PLAN-AI-WHEEL §1.4）：摘要=生成 / 重试 / 已有则滚顶；翻译=开始 / loading 再点=取消（abort，runTranslate 的 ABORTED 分支自愈）/ 显隐译文；目录=开列表 / 无且可生成则生成后自动开面板 / AI 关与短文只开面板出文案（**AI 关不得触发生成**——tocAiEligible 不含 aiEnabled，撞 preload 硬门控会弹假错）。面板开着点球=先关面板再展开（AiToolsPanel onDocDown 豁免触发钮，须显式互斥）；面板+轮盘同开时 Esc 一次双闭。
- **AiToolsPanel 联动**：triggerEl 换绑球元素；place() 增**向上翻转**（below<200 → bottom 定位，面板底贴球顶 6px，高度受限于上方空间）——球在视口底部，恒走翻转分支。


## 6. 交互态矩阵

| 组件 | hover | active（按下） | focus-visible | selected / on | disabled |
|---|---|---|---|---|---|
| 主按钮 | 底 `--accent-hover` | 底 `--accent-active` | 2px 环 | — | 底灰字 `--text-disabled` |
| 次按钮 | 底 `--bg-card-hover` | 底 `--bg-active` | 2px 环 | — | 降透明 + 禁用色 |
| 幽灵按钮 | 底 `--bg-card-hover` | 底 `--bg-active` | 2px 环 | 激活态底 `--bg-selected` 字 `--accent-deep` | 禁用色 |
| 危险按钮（描边） | 底 `--danger-soft` | 加深 | 2px 环（全局统一 `--focus-ring`） | — | 降透明 |
| 图标按钮 | 底 `--bg-card-hover`（侧栏 `--bg-hover`），图标 `--text-1` | 底 `--bg-active` | 2px 环 | 书签等激活 = 实心 `--accent-deep` | 图标 `--text-disabled` |
| 输入框 | 边 `--border-input` | — | 2px 环（box-shadow） | — | 降透明 + 禁止输入 |
| 下拉按钮 | 底 `--bg-card-hover` | 底 `--bg-active` | 2px 环 | 展开态边 `--accent-strong` | 禁用色 |
| 下拉菜单项 | 底 `--bg-hover` | 底 `--bg-active` | 2px 环 | 字 `--accent-deep` + check | 隐藏 |
| 开关 | 轨加深 5% | 点缩放 0.92 | 2px 环 | on 轨 `--accent-strong` | 透明 0.5 |
| 分段控件项 | 底 `--bg-hover` | 底 `--bg-active` | 2px 环 | 底 `--bg-selected` 字 `--accent-deep` | 降透明 |
| 导航项（源/分类） | 底 `--bg-hover` + ⋯ 浮出 | 底 `--bg-active` | 2px 环 | 底 `--bg-selected` 字 `--accent-deep` | — |
| 卡片 | 底 `--bg-card-hover` | 底 `--bg-active` | 2px 环 + 键盘当前位同款 | — | — |
| 列表行 | 底 `--bg-card-hover` | 底 `--bg-active` | 2px 环 | 当前位底 `--bg-selected` | — |
| 单选行 | 底 `--bg-hover` | 底 `--bg-active` | 2px 环 | radio 实心 + 底 `--bg-selected` | 降透明 |
| 芯片 | 底 `--bg-selected` 字 `--accent-deep` | 底 `--bg-active` | 2px 环 | 同 hover 持续 | — |
| 折叠按钮 | 同灰按钮：底 `--bg-btn-muted-hover` 字 `--text-1` | 同灰按钮按下 | 2px 环 | 展开态 `‹` / 折叠态 `›` | — |
| 弹层 | — | — | 首元素聚焦 + 圈禁 | — | — |
| 链接（正文内） | 下划线加粗 | — | 2px 环 | — | — |

---

## 7. 图标清单（24 viewBox · stroke 2 · round cap/join · currentColor）

| 名称 | 用途 | 常规渲染尺寸 |
|---|---|---|
| `refresh` | 工具栏刷新；刷新中旋转 | 16/18 |
| `done-all` | 全部已读 | 16 |
| `list` / `grid` | 视图切换 | 16 |
| `sort` | 排序下拉（chevrons 上下） | 16 |
| `search` | 搜索框 | 16 |
| `plus` | 添加订阅源 | 16/18 |
| `settings` | 设置（sliders 三线样式，避免与 sun 混淆） | 16 |
| `upload` / `download` | OPML 导入 / 导出 | 16 |
| `star` / `star-filled` | 星标（列表行） | 12/16 |
| `bookmark` / `bookmark-filled` | 收藏（卡片 meta / 阅读底栏） | 16/18 |
| `share` | 分享 | 16 |
| `external-link` | 原文 / 浏览器打开 / 关于链接 | 14/16 |
| `clock` | 阅读时长 | 14 |
| `arrow-left` | 阅读面板/设置返回 | 16 |
| `close` | 弹层/输入清除/菜单关闭 | 16 |
| `alert-triangle` | 错误提示 / 危险确认 | 16/20 |
| `check` | 下拉选中项 / 已读切换 / 全部读完 | 14/16/24 |
| `radio` / `radio-checked` | 发现候选单选 | 20 |
| `chevron-left` / `chevron-right` / `chevron-down` | 侧栏折叠按钮 / 下拉箭头 | 16 |
| `trash` | 清空数据 / 删除订阅 | 16 |
| `edit` | 编辑订阅 | 16 |
| `more-vertical` | 订阅源 ⋯ 菜单 | 16 |
| **以下为本套补充**（任务清单外，实现必需） | | |
| `rss` | 空态首用引导 / 品牌辅助 | 24/32 |
| `copy` | 复制链接 | 16 |
| `sun` / `moon` / `monitor` | 主题三态 | 16 |
| `folder` | 分类空态 | 20/40 |
| `inbox` | 首用空态备选 / 通知组 | 16/20 |
| `languages` | AI 轮盘翻译项（顶栏翻译按钮 v1.2→面板 v1.4→轮盘 v1.5） | 16 |

> 图标全部内联 SVG（`src/components/icons.ts` 组件化），不引图标库、不用 emoji。线性 2px；`star-filled`、`bookmark-filled`、`radio-checked` 中心为 fill。

---

## 8. 键盘焦点与可达性

### 8.1 快捷键（全局，useHotkeys）

| 键 | 行为 | 细节 |
|---|---|---|
| `j` / `k` | 下/上一篇 | roving tabindex；列表滚动跟随（scrollIntoView block:nearest）；循环 |
| `Enter` | 打开阅读面板 | 小窗=覆盖层，分离窗=第三栏刷新 |
| `m` | 切换当前篇已读 | 乐观翻转 + 180ms 淡出（§9） |
| `s` | 切换星标 | 星标图标 160ms 缩放反馈 |
| `Shift+A` | 全部标记已读 | 直接执行 + toast；未读数动画归零 |
| `Ctrl+F` | 聚焦搜索框 | preventDefault；与 uTools SubInput 同源（store.search） |
| `⌫ Backspace` | 逐级返回（主键位） | 弹层/下拉开→关闭 → 阅读面板→返回列表 → 退设置 → 清搜索 → 顶层无操作。2026-09-05 实机验证：主窗口 Esc 被宿主优先消费（直接隐藏插件，页面拦不住），故 ⌫ 承担页内返回；Esc 分支保留，分离窗内无宿主拦截仍生效 |

阅读面板内：`j/k` 翻篇（上一篇/下一篇），`⌫` 返回；弹层内：Tab 圈禁 + `⌫`/Esc 取消（输入态 ⌫ 仍为编辑键）。

### 8.2 焦点管理

- 文章列表 roving tabindex：容器 `tabindex=0`，仅当前项 `tabindex=0` 其余 `-1`；`aria-activedescendant` 指向当前项。
- 弹层打开：焦点移入首个控件；关闭：焦点还原触发元素。`role="dialog" aria-modal="true" aria-labelledby`。
- 下拉：`aria-expanded` + `role="listbox"/option` + `aria-selected`；方向键导航，Esc 关闭不移动焦点。**禁用原生 `<select>`/`<datalist>`**——其弹层是 OS 原生弹窗，uTools 无边框窗内定位错位（2026-09 实机），一律用 C17 组件。
- 开关 `role="switch" aria-checked`；分段控件 `role="radiogroup"` + `radio`；视图切换 `role="group"` + `aria-pressed`。
- 侧栏折叠按钮 `aria-expanded` + `aria-label="折叠侧栏/展开侧栏"`。

### 8.3 语义与通告

- 卡片流 `role="feed"` + 每卡 `role="article"` + `aria-posinset/setsize`（虚拟滚动下按数据集计）。
- toast `role="status"`（错误 `role="alert"`）；刷新完成、全部已读、添加订阅成功均走 toast。
- 骨架容器 `aria-busy="true"`；图片 `alt`（无则 `alt=""`）；装饰 SVG `aria-hidden="true"`。
- 对比度：全量结论见 §3.3；禁用态对比豁免但仍可辨。
- 触达：全部交互 ≥24×24（本项目视觉最小控件 28×24）。
- 中文无斜体；`prefers-reduced-motion` 见 §9；`prefers-contrast: more` 预留：边框升 `--border-input`。

---

## 9. 动效规范

| 场景 | 规格 |
|---|---|
| hover / 颜色 / 选中底 | 120ms `--ease-out` |
| 下拉/开关/分段/星标反馈 | 160ms `--ease-out`；星标 scale 1→1.15→1 |
| **已读淡出** | 180ms `--ease-out`：透明度 1→0；随后高度折叠 160ms（margin+height）；期间 `pointer-events:none`。列表行同样式。批量（全部已读）逐行 30ms 级联错峰 |
| 阅读面板（小窗） | 200ms 滑入 `translateX(16px)→0` + 淡入；返回反向 160ms |
| 侧栏折叠 | width 280↔64，200ms `--ease-out`；文字 opacity 先行 120ms |
| 弹层 | scrim 160ms；面板 200ms scale 0.98→1 + 淡入 |
| 悬浮轮盘展开（C19） | 外层 translate `--t-med --ease-out` 错峰 0/45/90ms；内层 rotate/scale `--t-slow --ease-spring`（delay = --d+40ms）；球 idle 漂浮 3.2s（§21 豁免例外，展开时暂停） |
| 骨架 shimmer | 1.4s linear infinite，`--skel-b` 高光带 -25%→125% |
| 刷新进度条 | 1.6s ease-in-out infinite alternate（位移渐变）；刷新中图标 0.9s 旋转 |
| 统计数字变化 | 120ms 淡入（旧值即逝，不做计数动画） |
| toast | 进入 160ms 上移 4px + 淡入；2.6s 后 160ms 淡出 |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  /* 骨架变静态双色块；进度条改 30% 透明度脉动（0.01ms 规则下等效静止）；已读淡出改为瞬时移除 */
}
```

---

## 10. Vue3 落地注记

- `src/styles/tokens.css`：配色（`html[data-palette="warm|sepia|sage|indigo"]`）与明暗（`html[data-theme="light|dark"]`）正交——`html[data-theme="light"]{…}` / `html[data-theme="dark"]{…}` 两块为 warm 缺省（逐字节锁定），新配色块 `[data-palette][data-theme]` 特异性必胜；`--p-sw-*` 供设置页 swatch。主题三态：`auto` 时由 `useTheme` 监听 `matchMedia('(prefers-color-scheme: dark)')` 实时落到 `data-theme`，`isDarkColors()` 仅初始兜底；配色经 `settings.palette` 落 `data-palette`。守门：`node scripts/check-theme-contrast.js`。（store 实名为 `useThemeStore`，theme.ts）
- 阅读字号：`.reader-article { font-size: var(--reading-fs, 16px); }`，四档由 settings.fontLevel 切换，CSS 变量驱动、无 JS 重排。
- 选中态一律 `--bg-selected` + `--accent-deep` 文字；hover 一律令牌底色，禁止组件私有 hex。
- banner 渐变占位（§4.9）现状为 `<img class="banner">` + `var(--bg-hover)` 兜底（原 §10 记载的 `.banner-dusk/.banner-sunrise` 工具类未落地，本文更正），随配色自适应。
- 本文档 §3 令牌即 `tokens.css` 的验收清单；preview.html 为像素基准，偏差 >2px 视为实现缺陷。

---

## 附：与 PLAN-PHASE1.md 的令牌衔接

| PLAN §6 临时值 | 本系统定值 | 原因 |
|---|---|---|
| text-1 `#1F2937` | `#292524` | 暖灰更贴米白底；对比度 15.37 更充裕 |
| text-2 `#6B7280` | `#57534E` | 原值在米白侧栏 4.49:1，差 0.01 不达 AA |
| text-3 `#9CA3AF` | `#78716C`（白底专用） | 原值 2.54:1 不可用作 meta |
| accent-soft 深色 `#3A2E22` | `#35261A` | 与 `#FB923C` 配对 6.43:1，更稳 |
| danger `#C24545/#E06C6C` | `#DC2626`（按钮底/红点）/ `#F87171`（深色文字） | 白字 4.83 达标；深色文字 6.11 |
| 主按钮 `#7C2D12` 字 | 改 `#431407` 字 | `#7C2D12` on `#F97316` = 3.34:1 不达标（§3.3） |
