# PLAN-TOC-LEVEL — 目录层级化（前端结构目录 + AI 目录双路径）

> 2026-09-10 用户反馈：「AI 目录没有层次，看着有点乱，类似 https://daily.juya.uk/rss.xml，结构本身是很明显的」。

## 0. 根因（实测数据）

抓取 daily.juya.uk/rss.xml（10 篇）实测：每篇 = `h1×1`（文章大标题）+ `h2×3~8`（概览/…）+ `h3×6~34`（要闻/模型发布/产品应用/行业动态/…），sanitize 白名单完整保留 h1-h6（article.js allowedTags）。

1. **主因：前端结构目录丢弃层级**。`ReaderPanel.refreshTocMeta` 收集 `H[234]` 时只产出 `{title, idx, head}`，h3「要闻」与 h2「概览」在 `AiToolsPanel` 中平铺同级展示——25~40 条无差别列表 = 「乱」。此类文章根本不花 AI（h2-h4 ≥2 走前端秒出路径）。
2. **次因：AI 目录协议无层级**。`ai.js buildTocMessages` 的 prompt 只要求「3~10 个连续章节」单层；行协议 `[[idx]]标题` 无层级字段，`parseTocOutput` 只解析 `{title, idx}`。

## 1. 方案总览

目录条目统一增加 `level: 1|2|3`（章→节→小节），两条路径各自产生层级、同一展示端按级缩进：

| 路径 | 层级来源 |
|---|---|
| 前端结构目录（h2-h4） | DOM 标签映射 h2→1 / h3→2 / h4→3，并对实际出现标签做**最小秩平移归一**（纯 h3/h4 文章 → 1/2，防「全部缩进无顶级」） |
| AI 目录（手动池） | 行协议升级 `[[idx\|level]]标题`，level 1=章 2=子章（prompt 限两级求稳；解析端 clamp 1-3 兼容） |

## 2. 文件级改动

### 2.1 `src/types/index.ts`
- `ArticleAiToc.sections[]` 增 `level?: 1 | 2 | 3`（可选字段惯例：旧 aiToc 缺失按 undefined 读，展示端 `?? 1` 回退平铺；schemaVersion 仍 3）。

### 2.2 `preload/services/ai.js`
- `buildTocMessages`：
  - system prompt 升级两级协议：「划分 3~10 个连续章节；章内若有明显可区分的子话题，可为该章再分 1~4 个子章。每行 `[[起始段编号|层级]]`，层级 1=章、2=子章；无明显子结构时全部用 1。标题不带 # 前缀。子章行紧跟其章行」（审核 S-7：防 AI 乱序输出撞同 idx 去重留孤儿）。
  - 输入行格式钉死 `[[idx]]## 标题文本`（锚点在前，markdown `#` 前缀按 tag 数量），prompt 一句「# 前缀是原文标题标记，参考其层级归属」——对「标题在 DOM 是 h5/h6/零星 h 标签、不满足前端目录门槛」的边界文章，AI 层级判断零猜测。注：`#` 标记不计入 TOC 限幅与缓存键 joined，prompt 实际略长于 TOC_MAX_CHARS，无害。
- **`generateToc` 的 filter（ai.js:928）与限幅循环（ai.js:933-939）透传 `tag`**（审核必改-1：限幅循环重建对象，漏传则 buildTocMessages 拿不到标记，静默失效且单测全绿）；JSDoc paras 签名同步。
- `parseTocOutput`：正则改 `\[\[(\d+)(?:\|(\d+))?\]\](.+)`，**解析端 JS clamp 1-3**（越界如 `|4`/`|0` clamp 到界内而非丢行——审核必改-2：`[1-3]` 字符类会让越界行整章静默丢失）；level 缺省 1；title 处理顺序钉死 **trim → 剥 `^#{1,6}\s*` → slice(0,24)**（审核 S-1：先 slice 后剥会让 `# ` 吃掉 24 字额度）；同 idx 去重保首 + idx 升序逻辑不变。
- `tocAnchorSections`：透传 level（`Number(s.level)` 非法/越界 → 1）。
- **缓存键 `ai:toc:v1:` → `ai:toc:v2:`**：旧 v1 产物无 level，命中即平铺 = 用户感知「没修」；prompt 已变，同内容产物语义不同。缓存载荷 `{title, idx, level}`（仍不含 head，命中路径重补的口径不变）。
- `applyToc` / JSDoc 注释同步。
- 联播跨源语义知情项（审核确认）：v2 仍纯内容键，同文跨源命中时 level 复用他源文本下的 AI 判断（本源 DOM 标签可能不同）——纯内容键既有取舍的自然延伸，与 head 重补同口径，可接受。

### 2.3 `src/components/ReaderPanel.vue`
- `refreshTocMeta`：`tocHeadings` 增 level——收集到的 heads 取 **unique tagRank 排序后做序号映射 1..n**（审核 S-3：纯 min 平移下 h2+h4 混合得 1/3 出现「无父级 lv3」缩进孤儿，序号映射压缩缺口；heads 空时短路防 `Math.min(...[])`=Infinity）；h1 仍不收（文章大标题，无导航意义）。
- `tocHeadings` ref 显式类型增 `level: 1 | 2 | 3`（审核 S-4）；`runToc` 的 paras 增 `tag`（`/^H[1-6]$/` → lowercase，其余 undefined；纯字面量数组，IPC 安全，undefined 属性结构化克隆无碍）。
- `tocEntries`：html 条目自带 level；ai 条目 `{...s}` 透传（展示端 `?? 1`）。`markCurrentSection` 签名 `{idx}` 不变。
- `src/env.d.ts` 的 generateToc paras 类型同步增 `tag?: string`（审核 S-4：typecheck 不挡的文档债，最容易漏）。

### 2.4 `src/components/AiToolsPanel.vue`
- prop `tocEntries` 类型增 `level?: 1 | 2 | 3`；模板 class 绑定 `lv`。
- CSS 按级缩进（300px 面板宽、440px maxHeight 滚动容器内）：
  - `lv1`：font-weight 600（章级视觉锚点）；`:not(:first-child)` 加 `margin-top: 5px` 组间分隔。
  - `lv2`：`padding-left: 22px`、12px 字号、`--text-2`。
  - `lv3`：`padding-left: 36px`、`--text-3`。
  - **落位（审核 S-6）：lv 规则置于基础 `.ai-toc-item` 之后、`.cur` 规则之前**——前者同为 0-1-0 靠源序覆盖 base 的 padding/font-size/color，后者同为 0-2-0 靠源序保证 cur 高亮的 color/weight 覆盖 lv 档。
  - 当前节高亮（accent-soft 底 + 左缘 accent-strong）与 nowrap ellipsis 不回归。

### 2.5 `src/lib/mock.ts`
- mock `generateToc`：章 level 1，第 2 章后插一条 level 2 子章——**候选 idx 取首个未被任何章占用且更大的 idx，不存在则不插**（审核必改-3：paras 3~5 段时 step=1 三章占连续 idx，「更大的下一段」会撞 `kind+':'+idx` key）；paras 类型增 `tag?: string`。

### 2.6 `scripts/test-ai.js`
- `parseTocOutput` 基础串改含 level 混合；新增断言：`|2` 解析、无 `|` 缺省 1、title 剥 `#` 前缀、`tocAnchorSections` 保留 level。
- 缓存断言 `ai:toc:v1:` → `ai:toc:v2:`；缓存载荷含 level、不含 head 保持。

### 2.7 文档
- `docs/PLAN-AI-TOC.md` 增变更记录，**显式点名 v2 载荷增 level**（§47 的载荷形状 `{sections:[{title,idx}],model}` 已过时，防后人按字面校验）；`AGENTS.md` v1.4 增补段同步（v2 键 + level 字段 + 前端目录层级归一口径）。

## 3. 不做清单

- **不做目录折叠/展开交互**：密度靠面板自身滚动；条目数最多 40 级别，折叠收益不抵交互成本。
- **不收 h1 进目录**。
- **AI 输出限两级**（prompt 1/2；解析端 clamp 1-3 只为容错防丢行）：三级归属 AI 判断不稳，前端结构目录才有真实三级。
- **不主动清理存量 `ai:toc:v1:*` 缓存文档**：cacheTrim LRU 自然淘汰，主动清理 = 多一次全前缀扫描，收益小。
- **不迁移存量 item.aiToc、不加「重新生成」入口**（审核必改-4 修正）：`runToc` 的 bypass=true 无任何调用点，叠加 item 层命中优先，**存量无 level 的 aiToc 会一直平铺到正文变更（T-09 清空）为止——现状如此，非本方案引入**。v1.4 落地于 2026-09-09，存量仅用户测试所生的个位数文档，代价可忽略；重生成按钮超出最小面，不做。

## 4. 风险与降级

- AI 把子章 idx 写成与章相同 → 同 idx 去重保首，子章被丢，退回平铺章列表（安全降级）。
- AI 漏 `|1` 直接输出 `[[3]]标题`（旧形态）→ 缺省 1，兼容。
- 旧 v1 缓存不再命中 → 同文重生成耗 1 次手动额度（一次性成本，换层级语义正确）。

## 5. 验证计划

1. `node --no-experimental-require-module scripts/test-ai.js` 全绿（含新增 level 断言）。
2. `npm run typecheck` + `npm run build` + `node scripts/check-theme-contrast.js`（未改 tokens，惯例守门）+ `node scripts/smoke-preload.js`。
3. 浏览器回归（注入 juya 真实数据 + mock）：h2/h3 文章目录缩进分组、纯 h3/h4 文章归一（不出现全缩进）、mock AI 目录两级、jumpTo 跳转与当前章高亮不回归、短文/生成中文案态不回归。

## 6. 审核与实施记录

### 审核（plan-code-reviewer，2026-09-10）

裁决：**必改后可实施**，全部回填后实施。已确认成立：缓存 v2 必要性与连带干净（测试断言、cacheTrim 全 `ai:` 前缀 LRU）、T-09 三处与 level 正交、现有断言零破坏（旧输入无 `|` 时新正则行为逐字节一致）、tocCoverPercent 与 level 正交、CSS 源序方案成立、IPC tag 字段安全。

- 必改-1：`generateToc` filter 与限幅循环重建对象会丢 `tag`——漏传则 prompt 标记静默失效且单测全绿（已并入 §2.2）。
- 必改-2：正则字符类 `[1-3]` 与「clamp 1-3」矛盾，越界行整章静默丢失——改 `\|(\d+)` + JS clamp（已并入 §2.2）。
- 必改-3：mock 子章 idx 在 paras 3~5 段时与章撞 key——插入前查重（已并入 §2.5）。
- 必改-4：「bypass 即得层级版」论据不实（bypass=true 无调用点）——措辞改如实记录，不加超最小面的重生成入口（已并入 §3）。
- 建议 S-1 剥 `#` 顺序、S-2 输入行格式钉死 `[[idx]]## 标题`、S-3 unique rank 序号映射压缩 h2+h4 缺口、S-4 env.d.ts/mock.ts/ref 类型同步、S-5 PLAN-AI-TOC 点名 v2 载荷、S-6 CSS 落位（base 后 cur 前）、S-7 prompt「子章行紧跟其章行」——全部并入正文。

### 实施记录（2026-09-10）

全部落地。改动：ai.js（buildTocMessages 两级协议+# 标记 / parseTocOutput `\|(\d+)` clamp / tocAnchorSections level / generateToc 限幅透传 tag / 缓存键 v2+载荷 level）、types/index.ts、env.d.ts、ReaderPanel.vue（TAG_RANK 序号映射 / runToc tag / tocHeadings 类型）、AiToolsPanel.vue（lv 分级缩进，落位 base 后 cur 前）、mock.ts（两级+子章 idx 查重）、test-ai.js。

**测试**：`node --no-experimental-require-module scripts/test-ai.js` 116 项全绿（含 5 条新断言：level 解析/clamp/剥 #、buildTocMessages 标记、全链路透传 tag 即引擎收到 `[[1]]## …`、锚点透传 level、缓存 v2 载荷含 level 不含 head）；typecheck / vite build / check-theme-contrast / smoke-preload 37 全绿。

**浏览器回归（IAB + mock，注入 juya 实测形态）**：① juya 形态（h1×1+h2×2+h3×3）：目录=「概览/深度解读」lv1（fw600、第二组 margin-top 5px）+「要闻/模型发布/争议与讨论」lv2（padLeft 22px、fw400），h1 不入目录；② 纯 h3/h4 文章归一：h3→lv1、h4→lv2，无全缩进无 lv3 孤儿，cur 高亮正确；③ 无结构长文 AI 路径：mock 生成 3 章 lv1 + 第 2 章后子章 lv2，「仅覆盖前 65%」标注正常；④ jumpTo：点条目面板关 + scrollTop 0→905.6。环境噪音：IAB screenshot capture failed（已知，布局以 DOM 计算样式定案）。

未提交改动，与上两轮（目录滚动修复、轮盘动效+第二轮性能）同批待用户指示提交。

