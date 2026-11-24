# PLAN-ESC-BACKSPACE — Esc 全线换 ⌫（Backspace）

2026-09-12 用户裁决：**Esc 与 uTools 冲突（主窗 Esc 直接隐藏插件），页内所有返回/关闭键统一为 Backspace，Esc 分支整体移除**（含分离窗——旧决策「Esc 分支保留给分离窗」造成两窗口行为不一致：分离窗 Esc 能返回、主窗 Esc 把插件藏掉，习惯互相打架）。

> 2026-09-12 实施完成：plan-code-reviewer 实现复核**通过**（无 P0/P1；P2-1 表述歧义、P2-2 既有文档重复行均已随手修）。vue-tsc 绿 + 浏览器 mock 合成事件回归 48/48 绿（A backLadder 全梯/Esc 零响应/repeat 守卫，B 轮盘与面板含 Ctrl+F 守卫场景，C 下拉/可输入下拉/轨内搜索/文内搜索空值关与非空编辑，D 分离窗语义与 kbd 提示）。

## 统一规则

1. **⌫ = 唯一页内返回/关闭键**；所有组件级 Esc 处理改为 ⌫；页内不再响应 Esc（Esc 语义完全交给宿主）。
2. **输入态守卫**：焦点在 INPUT/TEXTAREA/SELECT/contentEditable 时 ⌫ 是编辑键——文本**非空 → 纯编辑不拦**；文本**为空 → 关闭当前浮层**（下拉/建议列表/搜索浮层）。非输入目标（按钮/body）→ 开态 ⌫ 直接关。
3. 已处理的键保持 `preventDefault + stopPropagation`，不进全局键盘流（backLadder 不连跳两级）。
4. **禁用 Vue `.prevent`/`.stop` 修饰符做条件关闭**（如 `@keydown.backspace.prevent="q===''&&close()"`）——修饰符无条件生效，会把非空态的编辑 ⌫ 一并拦掉；必须走处理函数内判。

## 文件级变更

> 2026-09-12 plan-code-reviewer 审核闭环：P1-1/2/3(a) 与 P2-1/2/3/4/5/6 已并入。

### 1. `src/App.vue`
- 全局 `onKeydown`：**删除 `e.key === "Escape"` 整个分支**；注释更新为裁决记录（2026-09-05 实机验证宿主消费在先；2026-09-12 用户裁决 Esc 分支整体移除，含分离窗）。
- **删除 backLadder 的「退出输入态」死分支（P1-1）**：Esc 分支删除后唯一调用点守卫 `!typing` 与该分支条件同式，永不进入。阶梯注释改为「弹层 → sbDrawer → 文内搜索 → 关阅读 → 退设置 → 清搜索」。
- **Backspace 分支加 `e.repeat` 过滤（P2-4）**：⌫ 成唯一返回键后，长按连跳整条阶梯（模态→抽屉→搜索→关阅读→退设置→清搜索）。

### 2. `src/components/AiWheel.vue`
- `onDocKey`（document 捕获）：Escape → Backspace，**加输入态守卫**（target 为可编辑元素直接 return：hover 展开时焦点可能仍留在别处输入框，⌫ 是编辑键不该收轮盘）。关后焦点回球（原 Esc 语义不变）。
- 注释 L11/L30/L93 的 Esc 字样改 ⌫。

### 3. `src/components/AiToolsPanel.vue`
- `onKeydown`（document 捕获）：Escape → Backspace，同加输入态守卫（**真实场景（审核修正）**：面板开着按 Ctrl+F 开文内搜索，无 mousedown 面板不关、焦点落在搜索框——无守卫的 ⌫ 会连带关掉面板）。
- 注释更新。面板+轮盘同开时 ⌫ 一次双闭的约定不变（两捕获监听独立执行）。

### 4. `src/components/DropdownSelect.vue`
- `onKeydown` 的 Escape 分支 → Backspace 分支。触发钮是 button 非输入，**无需空值守卫**：开态 ⌫ 关列表不动焦点，preventDefault + stopPropagation（防穿到 backLadder 关掉整个模态）。
- 注释 L9/L10 更新。

### 5. `src/components/ComboboxInput.vue`
- `onKeydown` 的 Escape 分支 → Backspace 分支 + **输入框空才关**（非空 = 编辑键；关时不动焦点）。
- 注释 L8 更新。

### 6. `src/components/Sidebar.vue`（折叠轨搜索浮层）
- `@keydown.esc.stop.prevent="ui.railSearch = false"` → 处理函数：⌫ 且 `data.search` 为空才关（非空编辑）。按总则 4 不用修饰符。
- kbd 提示 `<span class="kbd">Esc</span>` → `⌫`。

### 7. `src/components/ReaderFind.vue`
- `@keydown.esc.stop.prevent="close()"` → 处理函数：⌫ 且 `query` 为空才 close()（非空编辑；焦点不在输入框时走 backLadder 关闭，既有路径不变）。

### 8. `src/stores/ui.ts`
- `sbDrawer` 注释 Esc→⌫；**删除死状态 `dropdown`**（全仓 grep 零读写，注释引用的是从未接线的「Esc 逐级返回」）。

### 9. `docs/design-system.md`
Esc 字样全面改 ⌫ 口径（按内容定位，勿按分节号——P2-1）：§0 键盘优先总则、§4.3 分离窗「Esc 语义」重写为 ⌫ 逐级返回且不关阅读、§4.6 模态「⌫=取消」、C17（空⌫关建议列表 + 键盘纪律键列表）、C19（⌫ 收轮盘/一次双闭）、C20 文内搜索（空⌫关面板）、**窄幅自适应 bullet「选中订阅/背板/Esc/拖宽即关」（P1-2，AGENTS.md 同句孪生）**、§8.1 表行（补裁决：2026-09-12 Esc 分支整体移除，含分离窗）、§8.1 表后段落、§8.2 下拉 bullet。

### 10. `AGENTS.md` + `README.md` + `docs/preview.html`（P1-2/P2-2）
- AGENTS.md：sb-auto bullet「选中订阅/背板/Esc…即关」→ ⌫；v1.6 bullet ⑤：「主窗 Esc 被宿主消费…关面板靠 × 钮 / 焦点不在输入框时 ⌫」→ 更新为 Esc 已全线移除（2026-09-12 用户裁决），⌫ 唯一返回键（输入框空时组件自关）。
- README.md：键盘流行「Esc」→「⌫」；实机待验证项「Esc 分支保留，分离窗内仍生效」改为已验证陈述并**新增 ⌫ 复验条目**（主窗/分离窗）。
- docs/preview.html（像素基准已漂移：实现早是 ⌫，预览稿仍写 Esc）：返回钮 kbd、图例「Esc 逐级返回」、演示脚本 Esc 处理同步改 ⌫ 口径。

## 已知限制（记录不修）

- **模态输入框聚焦时 ⌫ 恒为编辑键（P1-3 选安全侧 a）**：addFeed/editFeed/prompt 弹层输入框空值后继续 ⌫ 也不关模态——若做「空值放行进阶梯」会一次误按丢整张表单，安全侧不取；关闭走 ×/取消钮，或焦点在非输入控件时 ⌫（阶梯首分支关模态，既有）。输入态失焦路径（原 blur 一级）随死分支删除一并消失，离开输入框走 Tab/点击。
- **下拉开但焦点不在触发钮（列表项按钮上等非输入控件）时 ⌫ 穿透阶梯关整个模态**（DropdownSelect 的 ⌫ 处理只挂触发钮）——既有行为；同族还有 ArticleFlow 排序浮层、Sidebar 订阅 ⋯ 菜单（本就无键盘关闭路径，P2-3）。后续如做「顶层浮层登记」机制统一收口。
- 分离窗失去 Esc 三面（P1-3/审核点6）：①模态键盘取消 ②输入态失焦 ③Esc 逐级返回；①② 记录在案，③及其余浮层关闭已由 ⌫ 接续。如需恢复按本方案 revert Esc 分支。

## 验证

- `npm run typecheck`。
- 浏览器 mock 回归（evaluate 合成 KeyboardEvent，**必须派发到具体元素**——派发到 document 时 target.tagName 为 undefined，输入态守卫与元素级处理器覆盖不到，P2-5）：①backLadder 全梯 modal→sbDrawer→readerFind→关阅读→退设置→清搜索（非输入焦点派发 document/body）②轮盘开 ⌫ 收+焦点回球 ③AI 面板开 ⌫ 关 ④DropdownSelect ⌫ 关 / ComboboxInput 空⌫关、非空不拦 ⑤轨内搜索空⌫关、非空编辑 ⑥ReaderFind 空⌫关 ⑦全站 Esc 零响应。分离窗路径 `pinia._s.get('ui').detached = true` 强制激活（AGENTS 既有教训）。
- 实机项：README「实机待验证」新增主窗/分离窗 ⌫ 复验条目。
