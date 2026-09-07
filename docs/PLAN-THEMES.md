# PLAN-THEMES — 多套主题配色

> 状态：已过审（plan-code-reviewer 2026-09-07：必改后通过；B1/B2 与 S1–S7 已全部并入本文）
> 需求：为 AiRSS 增加多套主题配色（用户 2026-09-07 提出「多准备几套主题配色」）。
> 原则：默认视觉零变化（warm 为缺省配色，现有两块逐字节不动，由校验脚本硬守）；新增配色全部通过设计系统 §3.3 对比度纪律（口径见 §1.4，含 text-3 豁免），落一个可重复运行的校验脚本作守门。

## 0. 架构决策

**配色（palette）与明暗（mode）正交**：

- `html[data-theme]` **保留现有语义**：值仍只有 `light` / `dark`（即"明暗模式"）。组件级 `html[data-theme="dark"]` 覆盖共 **11 个文件 12 条选择器**（App.vue ×2、EditFeedModal ×2、AddFeedModal、ComboboxInput、DropdownSelect、ArticleFlow、Sidebar、AiSummaryCard、SettingsView、ArticleCard，另 ReaderPanel.vue:536 一条为 font-size 覆盖，非色彩）**零改动**即在新配色下继续生效。
- 新增 `html[data-palette]`：配色 id（`warm|sepia|sage|indigo`）。tokens.css 中现有 `html[data-theme="light"]` / `html[data-theme="dark"]` 两块继续充当 **warm 缺省**（选择器特异性 0,1,1），新配色块写成 `html[data-palette="sepia"][data-theme="light"]`（0,2,1，必胜；且新块位于文件后部，同层同源双保险）。`data-palette="warm"` 时不命中任何配色块 → 走 warm 缺省。
- 明暗三档（浅色/深色/跟随系统）与 `matchMedia` 逻辑不变；每个新配色提供 **light + dark 两组完整令牌**，任意组合（palette × mode）都成立。
- 首帧时序：`settings.load()`（App.vue:213）先于 `theme.init()`（:215）→ apply() 首帧前同时写 data-theme 与 data-palette，无 FOUC；auto 模式 matchMedia 回调复用 apply()，palette 保持。

否决的备选：`data-theme="sepia-light"` 组合值方案（需同步改 12 条组件覆盖选择器，扩散面大）；每套配色只做单一明暗（丢失 auto 跟随系统能力）。

## 1. 配色规格（4 套）

| id | 名称 | 定位 | 强调色系 |
|---|---|---|---|
| `warm` | 暖米白（默认，现状） | 品牌基准 | 橙 |
| `sepia` | 羊皮纸 | 复古纸感长文阅读 | 赭陶 |
| `sage` | 护眼绿 | 低饱和绿灰护眼 | 叶绿 |
| `indigo` | 靛蓝 | 冷静冷色调 | 靛蓝 |

### 1.1 sepia 羊皮纸

**light**（面板 #FAF4E8 / 侧栏 #F3EBDD / 选中 #F1E3C8）：

| 令牌 | 值 |
|---|---|
| --bg-app / --bg-panel / --bg-hover / --bg-card-hover | #F3EBDD / #FAF4E8 / #EADFCB / #F6EFE1 |
| --bg-active / --bg-btn-muted / --bg-btn-muted-hover / --bg-selected | #E2D5BE / #EFE7D7 / #E6DBC6 / #F1E3C8 |
| --text-1 / --text-2 / --text-3 / --text-disabled | #35291C / #63523D / #7E6B52 / #A79779 |
| --accent / --accent-hover / --accent-active | #CE6E35 / #DA7E48 / #C46228 |
| --accent-strong / --accent-deep / --accent-soft / --accent-ink | #A65317 / #8C3D0F / #F1E3C8 / #240B02 |
| --border / --border-strong / --border-input / --focus-ring | #E5DAC6 / #D3C4A8 / #8A7A60 / #A65317 |
| --danger / --danger-text / --danger-soft | #DC2626 / **#C21F1F** / #FDE8E8 |
| --scrim / --skel-a / --skel-b | rgba(53,41,28,.42) / #EDE3D0 / #F7F0E2 |
| --shadow-1/2/3 | rgba(53,41,28,.05) / (53,41,28,.07) / (53,41,28,.14)+(53,41,28,.08)（alpha 沿 warm 结构） |

**dark**（烛光深褐；面板 #1A150E / 侧栏 #131009 / 浮层 #221B11 / 选中 #332511）：

| 令牌 | 值 |
|---|---|
| --bg-app / --bg-panel / --bg-elevated / --bg-hover / --bg-card-hover | #131009 / #1A150E / #221B11 / #241D12 / #1F1911 |
| --bg-btn-muted / --bg-btn-muted-hover / --bg-selected / --bg-active | #241E13 / #2C2417 / #332511 / #2E2618 |
| --text-1 / --text-2 / --text-3 / --text-disabled | #EFE5D2 / #B5A78D / #93856B / #6E604A |
| --accent / --accent-hover / --accent-active | #E8A75C / #F2BE7E / #DC9440 |
| --accent-strong / --accent-deep / --accent-soft / --accent-ink | #E8A75C / #F2BE7E / #332511 / #240B02 |
| --border / --border-strong / --border-input / --focus-ring | #2C251A / #40362A / #75664C / #E8A75C |
| --danger / --danger-text / --danger-soft | #DC2626 / #F87171 / #3A2420 |
| --scrim / --skel-a / --skel-b | rgba(8,6,3,.6) / #231C11 / #2D2415 |
| --shadow-1/2/3 | rgba(0,0,0,.45) / (0,0,0,.5) / (0,0,0,.6)+(0,0,0,.5) |

### 1.2 sage 护眼绿

**light**（面板 #F6F9F2 / 侧栏 #EBF0E6 / 选中 #E0ECD6）：

| 令牌 | 值 |
|---|---|
| --bg-app / --bg-panel / --bg-hover / --bg-card-hover | #EBF0E6 / #F6F9F2 / #DFE8D8 / #F1F6EC |
| --bg-active / --bg-btn-muted / --bg-btn-muted-hover / --bg-selected | #D5E0CC / #ECF1E7 / #E2EADB / #E0ECD6 |
| --text-1 / --text-2 / --text-3 / --text-disabled | #1F2A1B / #4C5A45 / #63735A / #9BAA90 |
| --accent / --accent-hover / --accent-active | #5CA04E / #6BAD5D / #528F41 |
| --accent-strong / --accent-deep / --accent-soft / --accent-ink | #3F7A2F / #2F6422 / #E0ECD6 / #061402 |
| --border / --border-strong / --border-input / --focus-ring | #DFE6D8 / #C9D4BF / #7E8B74 / #3F7A2F |
| --danger / --danger-text / --danger-soft | #DC2626 / **#C21F1F** / #FDE8E8 |
| --scrim / --skel-a / --skel-b | rgba(31,42,27,.42) / #E8EEE2 / #F2F7EE |
| --shadow-1/2/3 | rgba(31,42,27,.05) / (.07) / (.14)+(.08) |

**dark**（墨绿；面板 #131A11 / 侧栏 #0D120C / 浮层 #1A2416 / 选中 #21331B）：

| 令牌 | 值 |
|---|---|
| --bg-app / --bg-panel / --bg-elevated / --bg-hover / --bg-card-hover | #0D120C / #131A11 / #1A2416 / #1B2415 / #172012 |
| --bg-btn-muted / --bg-btn-muted-hover / --bg-selected / --bg-active | #1B2314 / #232D1B / #21331B / #202B18 |
| --text-1 / --text-2 / --text-3 / --text-disabled | #E7EEE0 / #AEBFA3 / #8C9D80 / #66755B |
| --accent / --accent-hover / --accent-active | #8FC97C / #A5D993 / #7FBA6B |
| --accent-strong / --accent-deep / --accent-soft / --accent-ink | #8FC97C / #A5D993 / #21331B / #061402 |
| --border / --border-strong / --border-input / --focus-ring | #232C1D / #37422E / #5F6B54 / #8FC97C |
| --danger / --danger-text / --danger-soft | #DC2626 / #F87171 / #3A2420 |
| --scrim / --skel-a / --skel-b | rgba(4,8,3,.6) / #161F12 / #1E2917 |
| --shadow-1/2/3 | rgba(0,0,0,.45) / (0,0,0,.5) / (0,0,0,.6)+(0,0,0,.5) |

### 1.3 indigo 靛蓝

**light**（面板 #F7F9FD / 侧栏 #EDF0F8 / 选中 #E2E9FA）：

| 令牌 | 值 |
|---|---|
| --bg-app / --bg-panel / --bg-hover / --bg-card-hover | #EDF0F8 / #F7F9FD / #E1E6F1 / #F2F5FB |
| --bg-active / --bg-btn-muted / --bg-btn-muted-hover / --bg-selected | #D6DCEA / #EBEFF7 / #E0E6F1 / #E2E9FA |
| --text-1 / --text-2 / --text-3 / --text-disabled | #1C2233 / #48506A / #666F8C / #98A0B8 |
| --accent / --accent-hover / --accent-active | #647CF2 / #7B90F5 / #5870EE |
| --accent-strong / --accent-deep / --accent-soft / --accent-ink | #3E53D6 / #3547C2 / #E2E9FA / #03061C |
| --border / --border-strong / --border-input / --focus-ring | #E0E5EF / #CBD3E4 / #7C86A0 / #3E53D6 |
| --danger / --danger-text / --danger-soft | #DC2626 / **#C21F1F** / #FDE8E8 |
| --scrim / --skel-a / --skel-b | rgba(28,34,51,.42) / #ECF0F8 / #F5F8FD |
| --shadow-1/2/3 | rgba(28,34,51,.05) / (.07) / (.14)+(.08) |

**dark**（深空蓝；面板 #131722 / 侧栏 #0D1017 / 浮层 #1A2030 / 选中 #202B4A）：

| 令牌 | 值 |
|---|---|
| --bg-app / --bg-panel / --bg-elevated / --bg-hover / --bg-card-hover | #0D1017 / #131722 / #1A2030 / #1A1F2D / #171C29 |
| --bg-btn-muted / --bg-btn-muted-hover / --bg-selected / --bg-active | #1A1F2B / #222839 / #202B4A / #232C44 |
| --text-1 / --text-2 / --text-3 / --text-disabled | #E8EBF5 / #AFB5CC / #8B92AC / #636A85 |
| --accent / --accent-hover / --accent-active | #93A7FF / #A9BCFF / #8296F2 |
| --accent-strong / --accent-deep / --accent-soft / --accent-ink | #93A7FF / #B4C4FF / #202B4A / #03061C |
| --border / --border-strong / --border-input / --focus-ring | #222839 / #36405C / #5D6784 / #93A7FF |
| --danger / --danger-text / --danger-soft | #DC2626 / #F87171 / #3A2420 |
| --scrim / --skel-a / --skel-b | rgba(4,6,12,.6) / #171C2B / #1F2536 |
| --shadow-1/2/3 | rgba(0,0,0,.45) / (0,0,0,.5) / (0,0,0,.6)+(0,0,0,.5) |

### 1.4 对比度契约（校验脚本照此实现；数字以脚本输出为准）

**豁免口径（与 warm 现状对齐）**：`--text-3` 是"白底/panel 专用"令牌（design-system §3.1 原注），在染色面（hover/app/selected/accent-soft）上 warm 本就 <4.5（实测 t3/hover 4.11、t3/app 4.45），故矩阵中 text-3 **仅对 bg-panel 校验**；其余 text 令牌对全部常用底校验。

完整校验对矩阵（前景 × 底色 × 阈值）：

| 组 | 前景 | 底色 | 阈值 |
|---|---|---|---|
| 正文 | text-1 | bg-panel, bg-app | 4.5 |
| 次要 | text-2 | bg-panel, bg-app, bg-hover, bg-card-hover, bg-btn-muted, bg-selected | 4.5 |
| 弱化 | text-3 | **仅 bg-panel** | 4.5 |
| 强调文字 | accent-deep | bg-panel, bg-app, bg-selected, bg-card-hover, bg-btn-muted, accent-soft（hl 高亮组合） | 4.5 |
| 非文本强调 | accent-strong, focus-ring | bg-panel, bg-app | 3 |
| 输入边界 | border-input | bg-panel | 3 |
| 主按钮 | accent-ink | accent, accent-hover, accent-active | 4.5 |
| 危险 | danger-text | **仅 bg-panel**（实施期定：warm 原值在 bg-app 上 4.48，§3.1 本就只承诺白底 4.83；错误文字实际只出现在 panel/modal/toast 底上，与 text-3 同类的现状对齐豁免，warm 零 diff 优先） | 4.5 |
| 危险按钮 | #FFFFFF | danger | 4.5 |

（dark 模式的底色集额外含 bg-elevated；text-2/text-3/accent-deep/accent-strong 均须覆盖。）

实测关键值（4 配色 × 2 模式全对通过；列示最低值）：text-1/panel 12.91–15.03；text-2 全底 6.09–8.54；text-3/panel 4.66–4.96；accent-deep/panel 6.66–10.94、on accent-soft（hl）5.78–8.80；ink on accent 三态浅色 5.26–7.00、深色（active 最紧）sepia 7.43 / sage 8.24 / indigo 7.26；focus/app 最低 4.49；border-input/panel 3.39–3.81；#fff on danger 恒 4.83。

设计说明：三套浅色的 `--danger-text` 从 #DC2626 降为 **#C21F1F**（红字在微黄/微绿/微蓝底 4.08–4.44 不达标，降档后 5.05–5.68；`--danger` 按钮底恒 #DC2626 配白字 4.83 不变）。warm 原值在白/米白底达标不动。

## 2. 文件级改动清单

### 2.1 `src/types/index.ts`
- 新增 `export type PaletteId = "warm" | "sepia" | "sage" | "indigo";`
- `Settings` 增 `palette: PaletteId;`；`DEFAULT_SETTINGS` 增 `palette: "warm"`。
- 旧数据无 `palette` 键 → settings store 按 DEFAULT 键集序列化自动 merge → warm，视觉零变化。

### 2.2 `src/stores/theme.ts`
- `apply()` 末尾追加一行：`document.documentElement.setAttribute("data-palette", settings.palette);`
- 明暗推导逻辑不动。

### 2.3 `src/styles/tokens.css`
- 顶部注释更新（多配色说明）。
- 现有 light/dark 两块**逐字节不动**（warm 缺省；由校验脚本内嵌快照硬守，见 2.7）。
- 追加 6 块：`html[data-palette="sepia"][data-theme="light"]`、`[data-theme="dark"]`、sage×2、indigo×2，内容 = §1 表格（含 `--bg-active`；shadow/scrim alpha 沿 warm 结构定值）。
- 追加 4 个 swatch 小块（**非模式维度**，浅色版取色）：
  ```css
  html[data-palette="warm"]  { --p-sw-panel: #FFFFFF; --p-sw-accent: #F97316; }
  html[data-palette="sepia"] { --p-sw-panel: #FAF4E8; --p-sw-accent: #CE6E35; }
  html[data-palette="sage"]  { --p-sw-panel: #F6F9F2; --p-sw-accent: #5CA04E; }
  html[data-palette="indigo"]{ --p-sw-panel: #F7F9FD; --p-sw-accent: #647CF2; }
  ```

### 2.4 `src/components/SettingsView.vue`
- 「外观」区「主题」行**上方**加「配色」行：seg 按钮组（role=radiogroup），4 项 = 12px 双色圆点（`background: linear-gradient(135deg, var(--p-sw-panel) 50%, var(--p-sw-accent) 50%)`，**只读 CSS 变量，零私有 hex**）+ 名称（暖米白/羊皮纸/护眼绿/靛蓝）；描边为**全模式** `inset 0 0 0 1px var(--border-strong)`（实施期修正：warm 浅色 swatch 左半是 #FFFFFF，落在白色 panel 底上，无描边半圆会隐形；inset 内描边两种明暗同形同效，优于原方案"仅深色加 box-shadow"措辞）。
- `setPalette(v)`：`settings.set("palette", v); theme.apply();`（与 setTheme 同型；set 走 `set<K extends keyof Settings>` 类型路径成立）。
- 顺带令牌化：`html[data-theme="dark"] .switch { background: #474036 }` → `var(--border-strong)`（warm-dark 下同值 #474036，零视觉差）。

### 2.5 `src/components/EditFeedModal.vue`
- 同上 switch 令牌化（唯一改动）。

### 2.6 `src/components/AiSummaryCard.vue`
- `html[data-theme="dark"] .ai-card { background: #26201A }` → `var(--bg-elevated)`（warm-dark #282219，Δ≈2 色阶单位，不可感知）。
- `html[data-theme="dark"] .ai-tag { background: #201C19 }` → `var(--bg-panel)`（warm-dark 同值，零差）。

### 2.7 `scripts/check-theme-contrast.js`（新增，正式校验脚本）
- 解析 `src/styles/tokens.css`：按选择器抽块（`data-theme` 单独块 = warm；`data-palette="X"][data-theme="Y"` = 对应组合），抽 `--xxx: #RRGGBB`。
- **fail-loud**：块内出现非 6 位 hex / 命名色 / 解析失败的值 → 直接报错退出，不静默跳过。
- **完整性检查**：每块必须包含 warm 对应模式的全部颜色令牌集（缺一令牌 = 静默回落 warm 造成混色，恰是脚本最该抓的），swatch 块校验 4 块齐全。
- **warm 快照守卫**：脚本内嵌 warm light/dark 两块的完整令牌快照（值即现状），解析结果与快照不一致即失败——"warm 逐字节不动"从口头约定变成自动门禁（未来有意改 warm 需同步快照，属显式动作）。
- 跑 §1.4 完整矩阵（4 配色 × 2 模式），任一不过 → 非零退出并列出全部失败对。
- 纳入 README 命令清单。
- 设计期草稿 `scripts/spike-tmp/theme-contrast-draft.js` 在正式脚本落地后删除。

### 2.8 `docs/design-system.md`
- 新增 §3.3a「多配色体系」（实施期定：紧邻 §3.3 对比度纪律落位，编号 §3.3a 而非原拟 §3.9）：架构（palette×mode 正交、data-palette 选择器约定与特异性）、3 套配色表（同 §1，含对比度列）、使用纪律（各配色 accent 角色规则沿 §3.3；text-3 白底专用豁免；danger 三令牌跨配色约定；**禁止组件私有 hex，swatch 类展示色一律走 `--p-sw-*` 令牌**）。
- §10 落地注记第一条补 `data-palette` 说明；顺手更正 §10 中记载但代码不存在的 `.banner-dusk/.banner-sunrise` 工具类描述（现状为 `<img class="banner">` + var 兜底）。

### 2.9 `AGENTS.md`
- 「设计规则」区补一行：多配色体系与 `scripts/check-theme-contrast.js` 守门；改配色必须过脚本。

## 3. 明确不改的项（含理由）

| 项 | 理由 |
|---|---|
| 12 条 `html[data-theme="dark"]` 组件覆盖选择器 | data-theme 语义未变（明暗），新配色下自动生效 |
| `src/main.ts` fatalHost 错误页暖色 | 仅 preload 挂载失败的兜底页，此刻谈不上主题；现状深色用户同样先见浅色闪帧，非本次回归 |
| `ArticleCard.vue:110` 已读标题 `#44403c` | 近中性深灰，四套浅底上对比 ≥10，换 var 会改变 warm 基准像素 |
| `.switch .dot` / `.toast.error` / `base.css:47 .btn-danger` 的 `#fff` | 白字/白点落在 `--danger`（4.83 恒）与 accent-strong 上；浅色 accent-strong ≥3 达标，深色新配色约 1.94–2.28——**与 warm-dark 现况（2.26）同档，沿用现状、非新增回归**，不在本次扩面 |
| `Sidebar.vue:391` `var(--bg-panel, #fff)` | 仅回退值，data-theme 命中后永不触发 |
| `docs/preview.html` | 像素基准只锚 warm 缺省；warm 逐字节未动 |
| mock 层 / preload | 主题纯渲染层，settings 新键走既有 merge 路径；不动 preload → 不跑三套 preload 测试（不涉依赖变动） |

## 4. 风险与守卫

- **warm 视觉回归**：现有两块零 diff + 新块仅在 `data-palette≠warm` 命中 + 脚本 warm 快照硬守；浏览器切回 warm 目检。
- **warm-dark 缺 `--bg-active` 的口径**：新配色 dark 块补该令牌（顺带修复新配色下 `base.css .icon-btn:active` 深色 undefined → transparent 的隐患）；warm-dark 维持原样（避免无谓 diff）。
- **设置页 seg 宽度**：4 按钮 ≈324px + label，实测同级行余量充足，800px 窗不换行；如挤则改 DropdownSelect（C17）。
- **校验脚本解析器**：只认 `#RRGGBB`，遇其他色值格式 fail-loud；scrim/shadow 的 rgba 不参与矩阵但须能完整解析。

## 5. 验证计划（实现完成的定义）

1. `node scripts/check-theme-contrast.js` 全绿（4 配色 × 2 模式全对 + warm 快照一致 + 令牌完整）。
2. `npm run typecheck` 通过。
3. 浏览器（dev 已在 5173）逐一切换 4 配色 × 2 明暗：主列表/侧栏/设置页/阅读面板（含 AI 摘要卡、开关、下拉、toast、危险确认弹层）目检无穿帮、无未定义变量导致的透明底；warm 切回与改造前一致。
4. 每阶段完成按项目惯例送 plan-code-reviewer 复审。
