<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onUpdated, ref, watch } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { saveReadPosition, loadReadPositions } from "../stores/theme";
import { I } from "./icons";
import AiSummaryCard from "./AiSummaryCard.vue";
import AiToolsPanel from "./AiToolsPanel.vue";
import AiWheel from "./AiWheel.vue";
import ReaderFind from "./ReaderFind.vue";
import { timeAgo } from "../lib/format";

const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();

const item = computed(() => data.items.find((x) => x._id === ui.readerItemId) || null);
const feed = computed(() => (item.value ? data.feedMap.get(item.value.feedKey) : undefined));

const html = ref("");
const scrollEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);

const readingMin = computed(() => Math.max(1, Math.round(((html.value || item.value?.summaryText || "").replace(/<[^>]+>/g, "").length) / 400)));

// ---- AI 摘要（二期）：打开即 enrich，流式渲染；切换/离开 abort（H2 丢弃中间产物） ----
const aiState = ref<"idle" | "loading" | "done" | "error">("idle");
const aiText = ref("");
const aiError = ref("");
let aiSeq = 0; // 过期响应守卫（快速切换文章时旧流不再落 UI）
let aiPending = ""; // 流式增量缓冲
let aiFlushTimer: number | null = null;

// ---- 连续摘要预取（v1.2）：当前文摘要完成后，按过滤列表向下静默预取 N-1 篇 ----
let prefetchSeq = 0;

/** 预取队列：每步先 abort（single-handle 与用户新调用互斥）；切文/组件级重置/失败即停 */
async function prefetchNext(fromId: string, count: number) {
  const seq = ++prefetchSeq;
  const list = data.filtered;
  const me = data.items.find((x) => x._id === fromId);
  if (!me) return;
  let start = list.findIndex((x) => x._id === fromId) + 1;
  if (start === 0) {
    // 当前文已被标记已读、从过滤视图消失（未读视图打开即读）：按排序口径定位其后继
    // newest/未读优先均 pubTs 降序 → 后继 = pubTs ≤ 当前文；oldest 升序 → 后继 = pubTs > 当前文
    start = list.findIndex((x) => (settings.orderBy === "oldest" ? x.pubTs > me.pubTs : x.pubTs <= me.pubTs));
  }
  if (start < 0) return; // 边界文章无后继（读序已到底）：不回绕顶部反向预取
  let sent = 0;
  for (let i = start; i < list.length && sent < count; i++) {
    if (seq !== prefetchSeq || ui.readerItemId !== fromId) return; // 切文/新预取/关面板
    const cand = list[i];
    // 有 enrich 产物或已失败的跳过（轻量批空摘要 aiSource=batch 视为无摘要，会被补实）
    if (!cand || cand.ai?.aiSource === "enrich" || cand.aiStatus === "error") continue;
    sent += 1;
    window.airss.ai.abort();
    const r = await window.airss.ai.enrich(cand._id, {});
    if (seq !== prefetchSeq || ui.readerItemId !== fromId) return;
    if (!r.ok) break; // 中断（用户新调用抢占）/额度尽/引擎错：不空转
    if (r.item) {
      const j = data.items.findIndex((x) => x._id === r.item!._id);
      if (j >= 0) data.items[j] = r.item;
    }
  }
}

/** 流式增量 80ms 批量落 UI：个别引擎按 token 逐字回调，逐次响应式更新会冻住渲染线程 */
function onDeltaThrottled(seq: number, t: string) {
  if (seq !== aiSeq) return;
  aiPending += t;
  if (aiPending.length > 4000) aiPending = aiPending.slice(-4000); // 异常流的防御上限
  if (aiFlushTimer == null) {
    aiFlushTimer = window.setTimeout(() => {
      aiFlushTimer = null;
      if (seq !== aiSeq) return;
      aiText.value = (aiText.value + aiPending).slice(-4000);
      aiPending = "";
    }, 80);
  }
}

function resetAiStream() {
  aiSeq += 1; // 旧流回调与未落盘的缓冲全部作废
  prefetchSeq += 1; // 进行中的预取队列一并作废（切文/关面板）
  if (aiFlushTimer != null) {
    clearTimeout(aiFlushTimer);
    aiFlushTimer = null;
  }
  aiPending = "";
  aiState.value = "idle";
  aiText.value = "";
  aiError.value = "";
}

async function runEnrich(bypass = false) {
  const it = item.value;
  if (!it) return;
  if (!settings.aiEnabled) {
    aiState.value = "idle";
    return;
  }
  window.airss.ai.abort(); // single-handle 纪律：发起前回收在飞调用（翻译流/进行中的摘要）
  const seq = ++aiSeq;
  aiState.value = "loading";
  aiText.value = it.ai?.summary || ""; // 缓存/旧产物先行，流式增量续在其后
  aiPending = "";
  aiError.value = "";
  try {
    const res = await window.airss.ai.enrich(it._id, {
      bypass,
      onDelta: (t: string) => onDeltaThrottled(seq, t),
    });
    if (seq !== aiSeq) return; // 已切到别的文章
    if (aiFlushTimer != null) {
      clearTimeout(aiFlushTimer); // 收尾前把缓冲立即落地
      aiFlushTimer = null;
    }
    if (aiPending) {
      aiText.value = (aiText.value + aiPending).slice(-4000);
      aiPending = "";
    }
    if (res.ok && res.ai) {
      it.ai = res.ai;
      it.aiStatus = "done";
      const disp = res.ai.titleNorm || res.ai.titleZh;
      if (disp && disp !== it.title) it.titleDisplay = disp; // preload 已写库，此处同步内存
      aiText.value = res.ai.summary || aiText.value;
      aiState.value = "done";
      // 摘要产物落地后连带生成目录（PLAN-AI-TOC §13）：仅无结构长文且尚无目录（结构文前端
      // 秒出零增量成本）。必须 await 且先于预取——runToc 入口与 prefetchNext 每步都按单飞
      // 纪律 abort()，并行起飞互杀；catch 隔离防未来 runToc 抛错把已成功摘要翻成 error 态
      ensureTocMeta();
      if (!tocFromHtml.value && tocAiEligible.value && !it.aiToc) await runToc().catch(() => {});
      if (seq !== aiSeq) return; // 目录生成期间切文：预取随 resetAiStream 作废，不再发起
      if (settings.aiAutoCount > 1) prefetchNext(it._id, settings.aiAutoCount - 1); // 连续摘要：当前完成后向下预取
    } else if (res.aborted || res.error === "ABORTED") {
      // 离开面板的正常中断：有旧产物显示旧产物，否则收起卡片
      aiState.value = it.ai?.summary ? "done" : "idle";
    } else {
      aiError.value = res.error || "AI_FAILED";
      aiState.value = "error";
    }
  } catch (e: any) {
    if (seq === aiSeq) {
      aiError.value = String(e?.message || e);
      aiState.value = "error";
    }
  }
}

/** 手动 AI 摘要按钮（自动摘要关闭时）：无摘要、不在生成中、列表侧也没在跑才出现 */
const showAiBtn = computed(() => settings.aiEnabled && settings.aiAutoCount === 0 && aiState.value === "idle" && !item.value?.ai?.summary && !data.aiBusy.has(item.value?._id || ""));

/** 列表/阅读共用展示标题：AI 改写（titleNorm>titleZh）优先，可在设置关闭 */
const displayTitle = computed(() => (settings.aiTitle ? item.value?.titleDisplay || item.value?.title : item.value?.title) || "");
const titleRewritten = computed(() => !!item.value && displayTitle.value !== item.value.title);

// ---- AI 段落翻译（v1.2）：按钮触发，译文以纯文本块插在各段之后；切文重置 ----
const trState = ref<"idle" | "loading" | "done" | "error">("idle");
const trProgress = ref({ done: 0, total: 0 });
const trShown = ref(false); // 译文当前是否插在 DOM 中
let trSeq = 0; // 过期响应守卫（同 aiSeq）

/** 译文按钮可见性：正文样本 CJK 占比 ≤0.5 才出（中文为主整篇不译，与 preload 门控同口径） */
const translatable = computed(() => {
  if (!settings.aiEnabled) return false;
  if (trState.value !== "idle" || item.value?.aiTrans?.paras?.length) return true;
  const sample = html.value.replace(/<[^>]+>/g, "").slice(0, 600).trim();
  if (!sample) return false;
  return ((sample.match(/[\u4e00-\u9fff]/g) || []).length / sample.length) <= 0.5;
});

/** 正文文本块切分：文档序 p/h1-h6/li/blockquote、文本 ≥10 字；容器块整体取、嵌套块不重复计 */
type ParaBlock = { el: HTMLElement; idx: number; head: string; text: string };

/** 段落枚举缓存（PLAN-PERF-2 §1.1）：以 html.value 为 key——v-html 只换 innerHTML、contentEl
 *  恒同一元素，html 相同 ⇒ 枚举相同（.ra-trans 是 div 不进选择器，译文插入不改枚举）。
 *  命中守卫（审核 B-2）：跨源同文 key 逐字节相同但 DOM 已重建，缓存 el 会是脱节死引用
 *  （jumpTo 校验能过但 scrollIntoView 无效、rect 全 0），contains 校验兜底重算。
 *  纪律：不得在 html.value 赋值与 DOM patch 之间同步调用 collect*（现有调用点全是
 *  用户事件或宏任务时点预热，Vue patch 微任务必先完成；新增调用点须保持此前提）。 */
let parasCache: { html: string; paras: ParaBlock[]; all: ParaBlock[] } = { html: "", paras: [], all: [] };
function parasCacheValid() {
  if (parasCache.html !== html.value) return false;
  if (!parasCache.all.length) return true; // 空枚举：同 key 即有效（all ⊇ paras）
  return !!contentEl.value?.contains(parasCache.all[0].el);
}
function collectParasAllCached(): ParaBlock[] {
  if (parasCacheValid()) return parasCache.all;
  parasCache = { html: html.value, paras: collectParas(), all: collectParasAll() };
  return parasCache.all;
}
function collectParasCached(): ParaBlock[] {
  collectParasAllCached(); // 两个口径同一次 DOM 扫描时机一起填充
  return parasCache.paras;
}

function collectParas(): ParaBlock[] {
  const root = contentEl.value;
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")) as HTMLElement[];
  const out: ParaBlock[] = [];
  let total = 0;
  for (const el of nodes) {
    if (el.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote")) continue;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length < 10) continue;
    if (out.length >= 10 || total >= 4000) break; // 段数/字符双上限（与 preload 兜底一致）
    out.push({ el, idx: out.length, head: text.slice(0, 20), text: text.slice(0, Math.min(400, 4000 - total)) });
    total += out[out.length - 1].text.length;
  }
  return out;
}

const TRANS_CLASS = "ra-trans";

/** 译文插入：createElement+textContent（纯文本节点，绝不 innerHTML——安全基线）；head 不匹配段跳过防错位 */
function insertTranslations(paras: { idx: number; head: string; text: string }[]) {
  removeTranslations();
  const blocks = collectParasCached();
  let inserted = 0;
  for (const p of paras) {
    const b = blocks[p.idx];
    if (!b || b.head !== p.head) continue;
    const div = document.createElement("div");
    div.className = TRANS_CLASS;
    div.textContent = p.text;
    b.el.after(div);
    inserted += 1;
  }
  trShown.value = inserted > 0; // 全部失配（正文已变）不算已展示
}

function removeTranslations() {
  contentEl.value?.querySelectorAll("." + TRANS_CLASS).forEach((n) => n.remove());
  trShown.value = false;
}

async function runTranslate(bypass = false) {
  const it = item.value;
  if (!it || !settings.aiEnabled) return;
  window.airss.ai.abort(); // single-handle 纪律：先回收在飞调用（摘要流/预取）
  const seq = ++trSeq;
  trProgress.value = { done: 0, total: 0 };
  if (!bypass && it.aiTrans?.paras?.length) {
    trState.value = "done";
    insertTranslations(it.aiTrans.paras);
    return;
  }
  const paras = collectParasCached().map(({ el, ...rest }) => rest);
  if (!paras.length) {
    ui.toast("没有可翻译的段落");
    return;
  }
  trState.value = "loading";
  trProgress.value = { done: 0, total: paras.length };
  let maxIdx = -1; // 流式进度：取已见最大段号（快照式流重复回调也不会重计）
  try {
    const res = await window.airss.ai.translateItem(it._id, paras, {
      bypass,
      onDelta: (t: string) => {
        if (seq !== trSeq) return;
        for (const m of t.match(/\[\[(\d+)\]\]/g) || []) {
          const n = parseInt(m.slice(2, -2), 10);
          if (n > maxIdx) maxIdx = n;
        }
        trProgress.value = { done: Math.min(Math.max(maxIdx, 0), paras.length), total: paras.length };
      },
    });
    if (seq !== trSeq) return;
    if (res.ok && res.aiTrans) {
      it.aiTrans = res.aiTrans;
      trState.value = "done";
      insertTranslations(res.aiTrans.paras);
    } else if (res.aborted || res.error === "ABORTED") {
      // 切文/离场的正常中断：有旧译文恢复展示，否则回 idle
      trState.value = it.aiTrans?.paras?.length ? "done" : "idle";
      if (it.aiTrans?.paras?.length) insertTranslations(it.aiTrans.paras);
    } else if (res.error === "CONTENT_CHANGED") {
      // 全文提取在翻译期间替换了正文（B-1 竞态守卫）：产物已被 preload 弃写，
      // 回 idle 待用户按新正文重译（安静，不出错——正文读者已见）
      trState.value = "idle";
    } else {
      trState.value = "error";
      const why = res.error === "NO_NEED" ? "正文以中文为主，无需翻译" : res.error === "QUOTA_EXHAUSTED" ? "今日 AI 额度已用完" : res.error || "AI_FAILED";
      ui.toast("翻译失败：" + why, "error");
    }
  } catch (e: any) {
    if (seq === trSeq) {
      trState.value = "error";
      ui.toast("翻译失败：" + String(e?.message || e), "error");
    }
  }
}

function onTransBtn() {
  if (trState.value === "loading") return;
  if (trState.value === "done") {
    if (trShown.value) {
      removeTranslations();
      return;
    }
    insertTranslations(item.value?.aiTrans?.paras || []);
    if (trShown.value) return;
    // 旧译文 head 全失配（正文已被全文替换等）：强制重译，不留「点了没反应」的死按钮
    runTranslate(true);
    return;
  }
  runTranslate();
}

function resetTrans() {
  trSeq += 1; // 旧流回调作废；v-html 换文时插入节点随 innerHTML 重置消失
  trState.value = "idle";
  trProgress.value = { done: 0, total: 0 };
  trShown.value = false;
}

// ---- AI 目录与 AI 工具面板（v1.4，PLAN-AI-TOC）：结构标题 ≥2 前端秒出；无结构长文 AI 手动生成 ----
const TOC_MIN_HEADINGS = 2; // 结构标题达到此数走前端目录（不花额度）
const TOC_MIN_CHARS = 1500; // 无结构正文达到此长度才提供 AI 生成

const tocState = ref<"idle" | "loading" | "done">("idle"); // 失败由 toast 承担，不留挂死按钮态
const tocHeadings = ref<{ title: string; idx: number; head: string; level: 1 | 2 | 3 }[]>([]); // 前端结构目录（h2-h4，level=层级归一）
const tocParasCount = ref(0); // 全文段落数（AI 目录覆盖率分母）
const tocFullChars = ref(0); // 全文段落总字数（AI 门槛口径）
const tocCurrentIdx = ref(-1); // 当前章（面板打开时算一次，不做持续跟踪）
const aiPanelOpen = ref(false);
const wheelRef = ref<InstanceType<typeof AiWheel> | null>(null);
/** AiToolsPanel 触发钮：悬浮球元素（顶栏 AI 按钮已撤，轮盘是唯一快捷入口） */
const wheelBall = computed(() => wheelRef.value?.ballEl ?? null);
let tocSeq = 0; // 过期响应守卫（同 aiSeq/trSeq）

/** 全文段落枚举（目录锚点口径）：同 collectParas 切分，去掉 10 段/4000 字双上限——目录要覆盖全文 */
function collectParasAll(): ParaBlock[] {
  const root = contentEl.value;
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")) as HTMLElement[];
  const out: ParaBlock[] = [];
  for (const el of nodes) {
    if (el.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote")) continue;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    // 结构标题（h1-h6）不限字数——目录锚点必须收录短标题；其余文本块沿用翻译的 ≥10 字门槛
    if (text.length < 10 && !/^H[1-6]$/.test(el.tagName)) continue;
    out.push({ el, idx: out.length, head: text.slice(0, 20), text });
  }
  return out;
}

/** 目录元信息惰性化（PLAN-PERF-2 §1.2，审核 B-1）：key 幂等——tocMetaKey === html 即短路，
 *  吸收一切时序错位（html="" → await getItemFull 空窗内预热跑空也无害：正文落地后 key 必变，
 *  下次 ensure 自愈；布尔 dirty 会在空窗被清脏导致整篇恒空，勿改回）。 */
let tocMetaKey: string | null = null;
let tocWarmup: { ric: number; timer: number } = { ric: 0, timer: 0 };

function ensureTocMeta() {
  if (tocMetaKey === html.value) return;
  tocMetaKey = html.value;
  refreshTocMeta();
}
/** 空闲预热：rIC 带 800ms timeout（空闲不调也强制调）；无 rIC 环境（IAB 等）退 setTimeout。
 *  句柄存模块变量，切文/卸载取消（审核 S-7：晚到预热对已换文组件跑空扫描，脏且叠跑）。 */
function scheduleTocWarmup() {
  cancelTocWarmup();
  const run = () => {
    tocWarmup.ric = 0;
    tocWarmup.timer = 0;
    ensureTocMeta();
  };
  if (typeof requestIdleCallback === "function") {
    tocWarmup.ric = requestIdleCallback(run, { timeout: 800 });
  } else {
    tocWarmup.timer = window.setTimeout(run, 800);
  }
}
function cancelTocWarmup() {
  if (tocWarmup.ric) cancelIdleCallback(tocWarmup.ric);
  if (tocWarmup.timer) clearTimeout(tocWarmup.timer);
  tocWarmup = { ric: 0, timer: 0 };
}

/** 目录元信息刷新（正文 DOM 就绪后调用）：结构标题 + 段落数/字数（门槛与覆盖率口径） */
const TAG_RANK: Record<string, number> = { H2: 0, H3: 1, H4: 2 }; // h1 不收（文章大标题，无导航意义）
function refreshTocMeta() {
  const all = collectParasAllCached();
  tocParasCount.value = all.length;
  tocFullChars.value = all.reduce((n, b) => n + b.text.length, 0);
  // 层级归一（PLAN-TOC-LEVEL 审核S-3）：实际出现的标签秩排序后做序号映射 1..n——
  // 纯 min 平移下 h2+h4 混合（无 h3）会产生「无父级的 lv3」缩进孤儿，序号映射压缩缺口
  const heads = all.filter((b) => TAG_RANK[b.el.tagName] !== undefined);
  const lvOf: Record<number, 1 | 2 | 3> = {};
  [...new Set(heads.map((b) => TAG_RANK[b.el.tagName]))]
    .sort((a, b) => a - b)
    .forEach((r, i) => (lvOf[r] = (i + 1) as 1 | 2 | 3));
  tocHeadings.value = heads.map((b) => ({
    title: b.text.slice(0, 60),
    idx: b.idx,
    head: b.head,
    level: lvOf[TAG_RANK[b.el.tagName]] ?? 1,
  }));
}

const tocFromHtml = computed(() => tocHeadings.value.length >= TOC_MIN_HEADINGS);
/** 目录条目：结构标题足够 → 前端秒出；否则用 AI 目录（item.aiToc）；均无 → 面板出生成按钮或短文文案 */
const tocEntries = computed(() => {
  if (tocFromHtml.value) return tocHeadings.value.map((h) => ({ ...h, kind: "html" as const }));
  return (item.value?.aiToc?.sections || []).map((s) => ({ ...s, kind: "ai" as const }));
});
const tocAiEligible = computed(() => !tocFromHtml.value && tocFullChars.value >= TOC_MIN_CHARS);
/** AI 目录覆盖标注：末章 idx+1 ÷ 全文段数（输入截断时 <100；前端目录/全覆盖恒 100 不显示） */
const tocCoverPercent = computed(() => {
  const s = item.value?.aiToc?.sections;
  if (tocFromHtml.value || !s?.length || !tocParasCount.value) return 100;
  return Math.min(100, Math.round(((s[s.length - 1].idx + 1) / tocParasCount.value) * 100));
});
const aiBusyDot = computed(() => aiState.value === "loading" || trState.value === "loading" || tocState.value === "loading");
const hasSummary = computed(() => !!item.value?.ai?.summary);

/** 面板打开：定位当前章（原顶栏按钮 toggleAiPanel 拆出；轮盘目录项与面板路径共用） */
function openAiPanel() {
  ensureTocMeta(); // 惰性元信息兜底（IAB 节流下预热可能未跑，审核 M-1 路径）
  aiPanelOpen.value = true;
  markCurrentSection(tocEntries.value);
}

/** ---- 悬浮轮盘点击语义（v1.5，PLAN-AI-WHEEL §1.4）：点击直达动作，详情态开面板 ---- */
function onWheelSummary() {
  if (!settings.aiEnabled) {
    ui.toast("未开启 AI 增强（设置 → AI）");
    return;
  }
  if (aiState.value === "loading") return;
  if (aiState.value === "error") {
    runEnrich(true);
    return;
  }
  if (item.value?.ai?.summary) {
    scrollEl.value?.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return;
  }
  runEnrich();
}

function onWheelTrans() {
  if (!settings.aiEnabled) {
    ui.toast("未开启 AI 增强（设置 → AI）");
    return;
  }
  if (trState.value === "loading") {
    window.airss.ai.abort(); // 取消：runTranslate 的 ABORTED 分支自动恢复旧译文/回 idle（安静）
    return;
  }
  onTransBtn();
}

async function onWheelToc() {
  ensureTocMeta(); // 分支判定依赖 tocEntries/tocAiEligible：先兜底，防「AI 直达生成」误降级为开面板
  // AI 关/短文/已有/生成中一律开面板（文案、列表、进度各自呈现）；B1：AI 关不得进 runToc（tocAiEligible 不含 aiEnabled）
  if (tocEntries.value.length || tocState.value === "loading" || !tocAiEligible.value || !settings.aiEnabled) {
    openAiPanel();
    return;
  }
  const it = item.value;
  if (!it) return;
  await runToc();
  // 成功判定补当前文（tocSeq 已封切文竞态，此处口径显式化防跨文残留）
  if (tocState.value === "done" && it.aiToc && it._id === ui.readerItemId) openAiPanel();
}

/** 轮盘文内搜索项（PLAN-WHEEL-FIND）：非 AI 功能恒可达；顺关轨内面板防两搜索面并存（S2 纪律），
 *  focusAt 自增驱动「已开态再点 = 重聚焦+全选」（同值赋 readerFind 不触发面板 watch） */
function onWheelFind() {
  ui.railSearch = false;
  ui.readerFind = true;
  ui.readerFindFocus++;
}

/** 当前章：段落顶越过「滚动位置+30% 视口」锚线的最后一章（entries 升序，rect 差算 y 免 offsetParent 歧义） */
function markCurrentSection(sections: { idx: number }[]) {
  const sc = scrollEl.value;
  if (!sc || !sections.length) return;
  const scTop = sc.getBoundingClientRect().top;
  const anchorLine = sc.scrollTop + sc.clientHeight * 0.3;
  const blocks = collectParasAllCached();
  let cur = -1;
  for (const s of sections) {
    const b = blocks[s.idx];
    if (b && b.el.getBoundingClientRect().top - scTop + sc.scrollTop <= anchorLine) cur = s.idx;
  }
  tocCurrentIdx.value = cur;
}

/** AI 目录生成（手动池；单飞纪律：发起前回收在飞调用，杀掉在飞的摘要先打招呼） */
async function runToc(bypass = false) {
  const it = item.value;
  if (!it) return;
  if (aiState.value === "loading") ui.toast("已中断摘要生成");
  window.airss.ai.abort();
  const seq = ++tocSeq;
  tocState.value = "loading";
  ensureTocMeta(); // 段落枚举走缓存：先对齐 key（正文落地即算过则零成本）
  const paras = collectParasAllCached().map((b) => ({
    idx: b.idx,
    head: b.head,
    text: b.text.slice(0, 200),
    tag: /^H[1-6]$/.test(b.el.tagName) ? b.el.tagName.toLowerCase() : undefined, // h1-h6 结构标记（PLAN-TOC-LEVEL）：AI 输入行 # 前缀
  })); // 纯字面量数组，IPC 安全
  try {
    const res = await window.airss.ai.generateToc(it._id, paras, { bypass });
    if (seq !== tocSeq) return; // 已切文/重开
    if (res.ok && res.aiToc) {
      it.aiToc = res.aiToc;
      tocState.value = "done";
      const i = data.items.findIndex((x) => x._id === it._id); // await 后按 _id 定位（refreshAll 可能重建数组）
      if (i >= 0) data.items[i] = it;
      return;
    }
    const back = it.aiToc?.sections?.length ? "done" : "idle";
    tocState.value = back;
    if (res.aborted || res.error === "ABORTED") return; // 被其他发起打断：正常节流，不弹假错（同翻译）
    if (res.error === "QUOTA_EXHAUSTED") ui.toast("今日 AI 额度已用完", "error");
    else if (res.error === "NO_PARAS") ui.toast("没有可生成目录的段落");
    else if (res.error === "CONTENT_CHANGED") return; // 全文提取替换了正文：安静回生成态
    else ui.toast("目录生成失败：" + (res.error || "AI_FAILED"), "error");
  } catch (e: any) {
    if (seq === tocSeq) {
      tocState.value = it.aiToc?.sections?.length ? "done" : "idle";
      ui.toast("目录生成失败：" + String(e?.message || e), "error");
    }
  }
}

/** 目录跳转：head 严格校验（同译文对位口径）；失配=正文已更新 → 失效提示回生成态，不留死按钮 */
function jumpTo(idx: number, head: string) {
  const b = collectParasAllCached()[idx];
  if (!b || b.head !== head) {
    if (item.value) item.value.aiToc = undefined;
    tocState.value = "idle";
    ui.toast("正文已更新，目录已失效");
    return;
  }
  aiPanelOpen.value = false;
  b.el.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

/** 目录状态复位（切文/卸载/全文替换三路径共用；面板 Teleport 到 body 不随 reader 卸载，必须强关） */
function resetToc() {
  tocSeq += 1;
  tocMetaKey = null; // 元信息 key 与 refs 同步复位：同文重进（A→B→A，html 字符串相同）时
  // key 命中短路会让已清空的 tocHeadings 恒空（2026-09-09 回归实锤：面板误报「文章较短」）
  tocState.value = "idle";
  tocHeadings.value = [];
  tocParasCount.value = 0;
  tocFullChars.value = 0;
  tocCurrentIdx.value = -1;
  aiPanelOpen.value = false;
  wheelRef.value?.close(); // 轮盘同收：键盘切文时鼠标可停在热区不动（无 mousemove），防跨文残留（R11）
}

/** 全文提取接线（PLAN-V1.3 A）：源开 fullText 才请求；先出摘要不阻塞，
 *  hit/fetched 替换正文并重跑图片懒加载；替换后不重放滚动恢复（onUpdated 按新
 *  比例继续保存）；各失败态安静保留原摘要（无 toast）。 */
async function maybeExtractFull(id: string) {
  if (!feed.value?.fullText) return;
  const r = await window.airss.article.ensureFull(id);
  if (ui.readerItemId !== id) return; // 快速切文守卫：迟到的旧文正文不得覆盖新文
  if ((r.status === "hit" || r.status === "fetched") && r.content) {
    html.value = r.content;
    // 旧译文/旧目录已被 preload 侧连带失效（T-09 同族），内存同步清理、回初始态，
    // 可按新全文重译/重生成（渲染层不清则面板照列死目录、item 层假命中——送审必改）
    if (item.value) item.value.aiToc = undefined;
    resetTrans();
    resetToc();
    await nextTick();
    scheduleTocWarmup(); // 新全文的元信息：惰性重算（key 已随 html 变化）
    contentEl.value?.querySelectorAll("img").forEach((img) => {
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
    });
  }
}

/** ---- 阅读进度保存（性能纪律 + 两条实测坑）----
 *  1) 纯滚动不触发任何重渲染——没有滚动监听时读到底也不存进度；
 *  2) 关闭阅读时 readerItemId 已被置 null 且组件随父级 v-if 同周期卸载，
 *     watcher 会被调度器跳过，必须用 lastReaderId 在卸载钩子里兜底冲刷；
 *  3) 保存统一走 800ms 合并定时器（AI 流式期间 80ms 一帧的重渲染 +
 *     连续滚动事件流，逐次全量 dbStorage 写 IPC 会拖垮渲染线程）。
 *  声明必须位于下方 watch 注册之前：immediate 回调在 setup 执行期同步运行，
 *  放在后面会撞 TDZ（posSaveTimer 未初始化，watch 整条链路静默死亡）。 */
let lastReaderId: string | null = null;
let posSaveTimer: number | null = null;

const ratioOf = () =>
  scrollEl.value ? scrollEl.value.scrollTop / Math.max(1, scrollEl.value.scrollHeight - scrollEl.value.clientHeight) : 0;

function schedulePosSave() {
  if (posSaveTimer != null || !ui.readerItemId || !scrollEl.value) return;
  posSaveTimer = window.setTimeout(() => {
    posSaveTimer = null;
    const id = ui.readerItemId;
    if (id && scrollEl.value) saveReadPosition(id, ratioOf());
  }, 800);
}

function cancelPosSave() {
  if (posSaveTimer != null) {
    clearTimeout(posSaveTimer);
    posSaveTimer = null;
  }
}

watch(
  () => ui.readerItemId,
  async (id, oldId) => {
    cancelPosSave();
    cancelTocWarmup(); // 旧文的空闲预热作废（晚到会对新文跑空扫描，审核 S-7）
    if (oldId && scrollEl.value) {
      window.airss.ai.abort(); // 切换/关闭：中断进行中的流（aborted 不记 error）
      // 切走前立即落盘旧文进度（此刻 DOM 仍是旧文，比例有效；reader 常驻的切换场景）
      saveReadPosition(oldId, ratioOf());
    }
    resetAiStream();
    resetTrans();
    resetToc();
    // 文内搜索栏强关（PLAN-READER-FIND 审核B1：不放 resetToc——maybeExtractFull 也调它，写进去等于
    // 全文提取落地强关面板）；railSearch 同关防「列表态开着轨内面板→Enter 进文」两面板并存（S2）
    ui.readerFind = false;
    ui.railSearch = false;
    if (!id) return;
    lastReaderId = id;
    // 位置快照必须先于 html="" ——重渲染链条上的 onUpdated 节流保存会在空正文阶段
    // 把 0 比例写回存储（否则重开恢复读到的已是 0，位置记忆失效）
    const savedRatio = loadReadPositions()[id] || 0;
    html.value = "";
    let content = await window.airss.db.getItemFull(id);
    if (ui.readerItemId !== id) return; // 快速切文守卫：迟到的旧文正文不得覆盖新文
    if (!content) content = item.value?.summaryText ? `<p>${item.value.summaryText}</p>` : "<p>（无正文摘要，请打开原文查看）</p>";
    html.value = content;
    // AI 摘要启动策略（v1.2）：有缓存摘要直接展示；无摘要且自动模式(≥1)才 enrich；=0 留给手动按钮
    if (settings.aiEnabled) {
      if (item.value?.ai?.summary) {
        aiState.value = "done";
        aiText.value = item.value.ai.summary;
        if (settings.aiAutoCount > 1) prefetchNext(id, settings.aiAutoCount - 1);
      } else if (settings.aiAutoCount >= 1) {
        runEnrich(); // 不 await：正文渲染与 AI 并行
      } else {
        aiState.value = "idle"; // 手动模式：meta 行出「AI 摘要」按钮
      }
    }
    await nextTick();
    // 正文图片懒加载 + 进度恢复
    contentEl.value?.querySelectorAll("img").forEach((img) => {
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
    });
    // 目录：惰性元信息（空闲预热，消费入口 ensureTocMeta 兜底）+ item 层已有 AI 目录直接进 done 态
    scheduleTocWarmup();
    tocState.value = item.value?.aiToc?.sections?.length ? "done" : "idle";
    // 已有缓存的译文直接展示（v1.2：翻过的文章重进即见，不耗额度；随 AI 总开关门控）
    if (settings.aiEnabled && item.value?.aiTrans?.paras?.length) {
      trState.value = "done";
      insertTranslations(item.value.aiTrans.paras);
    }
    if (scrollEl.value && savedRatio > 0) {
      scrollEl.value.scrollTop = savedRatio * (scrollEl.value.scrollHeight - scrollEl.value.clientHeight);
    } else if (scrollEl.value) {
      scrollEl.value.scrollTop = 0;
    }
    // 全文提取：摘要先行的懒替换（fire-and-forget，回包守卫在 maybeExtractFull 内）
    void maybeExtractFull(id);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  window.airss.ai.abort();
  cancelTocWarmup(); // 卸载兜底：父级 v-if 同周期卸载的 watcher 会被跳过，目录状态与预热句柄必须自清
  resetToc(); // 卸载兜底：父级 v-if 同周期卸载的 watcher 会被跳过，面板与目录状态必须自清
  ui.readerFind = false; // 同上：文内搜索栏随阅读面板卸载强关（PLAN-READER-FIND 审核B1）
  cancelPosSave();
  // 卸载兜底：此刻 ui.readerItemId 可能已被置 null（关闭路径），用 lastReaderId
  if (lastReaderId && scrollEl.value) saveReadPosition(lastReaderId, ratioOf());
  lastReaderId = null;
});

onUpdated(() => schedulePosSave());

/** 正文内点击：外链交给宿主打开（CSP 拦不了 click，统一走 shellOpenExternal） */
function onContentClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (a && a.href) {
    e.preventDefault();
    window.airss.sys.openExternal(a.href);
  }
}

function openOriginal() {
  if (item.value?.link) window.airss.sys.openExternal(item.value.link);
}

function copyLink() {
  if (item.value?.link) {
    utools.copyText(item.value.link);
    ui.toast("已复制链接");
  }
}

/** 摘要卡 tag 点击（PLAN-V1.3 C）：切标签过滤，阅读面板保持打开，返回即见结果列表 */
function onTagFilter(t: string) {
  data.filter = { kind: "tag", value: t };
  ui.cursor = 0;
}

const fontLabels = ["14", "16", "18", "22"];
</script>

<template>
  <section class="reader" :class="{ detached: ui.detached }" role="region" aria-label="阅读面板">
    <!-- 正文区（顶栏+滚动区）：相对定位容器，AI 悬浮球锚于此——底栏换行变高（窄阅读列 52→77px）时球自然上移，无需 JS 测高 -->
    <div class="reader-body">
    <!-- 顶栏 -->
    <header class="reader-top">
      <button v-if="!ui.detached" class="btn btn-ghost btn-sm" @click="ui.closeReader()">
        <I.arrowLeft />返回<span class="kbd">⌫</span>
      </button>
      <div class="flex1"></div>
      <!-- AI 入口已迁悬浮轮盘（v1.5，PLAN-AI-WHEEL）：顶栏按钮撤除 -->
      <button class="btn btn-ghost btn-sm" :class="{ 'is-on': settings.serif }" @click="settings.set('serif', !settings.serif)">衬线</button>
      <div class="font-step" role="group" aria-label="正文字号">
        <button class="fs-btn" :disabled="settings.fontLevel === 0" aria-label="减小字号" @click="settings.set('fontLevel', settings.fontLevel - 1 as 1)">A−</button>
        <span class="num fs-cur">{{ fontLabels[settings.fontLevel] }}</span>
        <button class="fs-btn" :disabled="settings.fontLevel === 3" aria-label="增大字号" @click="settings.set('fontLevel', settings.fontLevel + 1 as 2)">A+</button>
      </div>
    </header>

    <!-- 文内搜索（PLAN-READER-FIND）：.reader-body 右上 absolute 悬浮卡（2026-09-12 悬浮化，不占 flex 行高、
         正文滚动区尺寸恒定；跳转补偿遮挡见 ReaderFind.jump）；常驻挂载 + open 控制（已开再 Ctrl+F 重聚焦全选），
         切文在 readerItemId watcher 强关 -->
    <ReaderFind :open="ui.readerFind" :root="contentEl" :html-key="html" :seed="data.search" :focus-at="ui.readerFindFocus" @close="ui.readerFind = false" />

    <!-- 正文 -->
    <div class="reader-scroll" ref="scrollEl" v-if="item" @scroll.passive="schedulePosSave">
      <article class="reader-article" :class="{ serif: settings.serif }">
        <h1 class="ra-title">{{ displayTitle }}<span v-if="titleRewritten" class="ai-mark" title="AI 改写标题">AI</span></h1>
        <div v-if="titleRewritten" class="ra-orig">原标题：{{ item.title }}</div>
        <div class="ra-meta">
          <span class="ra-feed">{{ feed?.title }}</span>
          <span>·</span>
          <span>{{ timeAgo(item.pubTs) }}</span>
          <span>·</span>
          <span class="ra-min"><I.clock />{{ readingMin }} 分钟</span>
          <span class="flex1"></span>
          <button v-if="item.link" class="btn btn-ghost btn-sm" @click="openOriginal"><I.externalLink />原文</button>
        </div>
        <!-- AI 摘要卡：唯一视觉主角（design-system §6），失败降级不阻塞阅读 -->
        <AiSummaryCard
          v-if="aiState !== 'idle' && item"
          :state="aiState === 'loading' ? 'loading' : aiState"
          :text="aiText"
          :tags="item.ai?.tags || []"
          :error="aiError"
          @regenerate="runEnrich(true)"
          @tag="onTagFilter"
        />
        <!-- v-html 唯一信任源：preload article.sanitizeContent 产物（PLAN §7） -->
        <div class="ra-content" ref="contentEl" @click="onContentClick" v-html="html"></div>
      </article>
    </div>

    <!-- AI 悬浮轮盘（v1.5；v1.7 加文内搜索项）：右下悬浮球，hover 展开摘要/翻译/目录/文内搜索，点击直达；详情态开下方面板。
         锚定 .reader-body（底栏之外），bottom:12 恒在底栏上缘之上 -->
    <AiWheel
      v-if="item"
      ref="wheelRef"
      :ai-enabled="settings.aiEnabled"
      :summary-state="aiState"
      :has-summary="hasSummary"
      :translatable="translatable"
      :tr-state="trState"
      :toc-state="tocState"
      :has-toc="tocEntries.length > 0"
      :busy="aiBusyDot"
      :panel-open="aiPanelOpen"
      @summary="onWheelSummary"
      @translate="onWheelTrans"
      @toc="onWheelToc"
      @find="onWheelFind"
      @close-panel="aiPanelOpen = false"
    />
    </div>

    <!-- 底部操作条（wrap 仅窄阅读列生效，正文区高度自动让位） -->
    <footer class="reader-bar" v-if="item">
      <button class="btn btn-ghost btn-sm" :class="{ 'is-on': item.read }" @click="data.markRead(item, !item.read)">
        <I.check />{{ item.read ? "已读" : "标为已读" }}
      </button>
      <button class="btn btn-ghost btn-sm" :class="{ 'is-on': item.starred }" @click="data.toggleStar(item)">
        <I.bookmarkFilled v-if="item.starred" /><I.bookmark v-else />{{ item.starred ? "已收藏" : "收藏" }}
      </button>
      <div class="flex1"></div>
      <button class="btn btn-ghost btn-sm" @click="copyLink"><I.copy />复制链接</button>
      <button class="btn btn-ghost btn-sm" @click="openOriginal"><I.externalLink />浏览器打开</button>
    </footer>

    <!-- AI 工具面板：目录/摘要/翻译三区（Teleport 到 body，状态全由本组件透传；由轮盘目录项打开，底部触发向上翻转） -->
    <AiToolsPanel
      :open="aiPanelOpen"
      :trigger-el="wheelBall"
      :ai-enabled="settings.aiEnabled"
      :toc-entries="tocEntries"
      :toc-from-html="tocFromHtml"
      :toc-ai-eligible="tocAiEligible"
      :toc-cover-percent="tocCoverPercent"
      :toc-state="tocState"
      :toc-current-idx="tocCurrentIdx"
      :ai-state="aiState"
      :has-summary="hasSummary"
      :show-summary-btn="showAiBtn"
      :translatable="translatable"
      :tr-state="trState"
      :tr-progress="trProgress"
      :tr-shown="trShown"
      @close="aiPanelOpen = false"
      @generate-toc="runToc()"
      @jump="jumpTo"
      @run-enrich="runEnrich"
      @trans-btn="onTransBtn"
    />
  </section>
</template>

<style scoped>
.reader {
  position: absolute; inset: 0; z-index: var(--z-reader);
  background: var(--bg-panel); display: flex; flex-direction: column;
  animation: reader-in var(--t-slow) var(--ease-out);
}
.reader.detached { position: relative; z-index: auto; animation: none; border-left: 1px solid var(--border); flex: 1; min-height: 0; }
@keyframes reader-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }

.reader-top {
  height: 52px; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; border-bottom: 1px solid var(--border);
}
/* 正文区容器（顶栏+滚动区）：AI 悬浮球的定位锚——与底栏互斥，底栏窄阅读列换行变高时球自然上移 */
.reader-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.flex1 { flex: 1; }

.font-step { display: flex; align-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-md); overflow: hidden; }
.fs-btn {
  height: 28px; padding: 0 10px; border: none; background: transparent;
  font-family: inherit; font-size: 12px; color: var(--text-2); cursor: pointer;
}
.fs-btn:hover:not(:disabled) { background: var(--bg-card-hover); }
.fs-btn:active:not(:disabled) { background: var(--bg-active); }
.fs-btn:disabled { color: var(--text-disabled); cursor: default; }
/* AI 任务呼吸点已随顶栏按钮迁入 AiWheel 悬浮球（绝对定位版） */
/* 目录跳转锚段：滚动定位时避开顶部区域（h2-h4 即前端目录条目所属块） */
.ra-content :deep(h2), .ra-content :deep(h3), .ra-content :deep(h4) { scroll-margin-top: 12px; }
/* 文内搜索闪烁标记（PLAN-READER-FIND）：瞬时背景切换不走动画——reduced-motion 下仍可见；
   作用在 .ra-content 子树（含 root 自身的裸文本 pseudo-block），只能落 ReaderPanel 的 :deep */
.reader-article :deep(.find-flash) { background: var(--accent-soft); border-radius: var(--r-sm); }
.fs-cur { font-size: 12px; color: var(--text-3); padding: 0 2px; }

.reader-scroll { flex: 1; min-height: 0; overflow-y: auto; }
/* 流式行宽：块级元素天然不超容器宽（窄面板自然收窄），仅设 75em 上限；
   em 基准=阅读字号（§533）。勿写 min(100% - …)：Chromium 对 max-width 内 min() 的百分比分支解析异常 */
.reader-article { font-size: var(--reading-fs, 16px); max-width: 75em; margin-inline: auto; padding: 24px 24px 48px; }
.serif { font-family: var(--font-serif); }

.ra-title { font-size: 22px; font-weight: 700; line-height: 1.35; color: var(--text-1); }
html[data-theme="dark"] .ra-title { font-size: 22px; }
.ai-mark {
  display: inline-block; vertical-align: 4px; margin-left: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
  color: var(--accent-deep); border: 1px solid var(--accent-deep);
  border-radius: var(--r-sm); padding: 0 3px; line-height: 14px; opacity: 0.85;
}
.ra-orig { margin-top: 6px; font-size: 12.5px; color: var(--text-3); line-height: 1.5; }
.ra-meta { display: flex; align-items: center; gap: 6px; margin: 12px 0 20px; font-size: 12px; color: var(--text-3); flex-wrap: wrap; }
.ra-feed { font-size: 13px; font-weight: 600; color: var(--accent-deep); }
.ra-min { display: inline-flex; align-items: center; gap: 4px; }

.ra-content { font-size: var(--reading-fs); line-height: 1.75; color: var(--text-1); user-select: text; }
/* AI 译文块（v1.2）：浅色弱化，与 blockquote 同族但更轻，紧贴原段之后 */
.ra-content :deep(.ra-trans) {
  margin: -0.3em 0 0.75em;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--accent-strong);
  opacity: 0.82;
  font-size: 0.92em;
  line-height: 1.7;
  color: var(--text-2);
  user-select: text;
}
.ra-content :deep(p) { margin-bottom: 0.75em; }
.ra-content :deep(h2) { font-size: 1.15em; font-weight: 650; margin: 1em 0 0.5em; }
.ra-content :deep(h3) { font-size: 1.05em; font-weight: 650; margin: 1em 0 0.5em; }
.ra-content :deep(blockquote) { border-left: 3px solid var(--accent-strong); padding-left: 14px; color: var(--text-2); margin: 0.75em 0; }
.ra-content :deep(img) { max-width: 100%; max-height: 60vh; border-radius: var(--r-md); margin: 0.5em 0; }
.ra-content :deep(a) { color: var(--accent-deep); text-decoration: underline; }
.ra-content :deep(code) { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-hover); border-radius: var(--r-sm); padding: 2px 6px; }
.ra-content :deep(pre) { background: var(--bg-hover); border-radius: var(--r-md); padding: 12px 14px; overflow-x: auto; margin: 0.75em 0; }
.ra-content :deep(pre code) { background: transparent; padding: 0; }
.ra-content :deep(table) { border-collapse: collapse; margin: 0.75em 0; }
.ra-content :deep(td), .ra-content :deep(th) { border: 1px solid var(--border); padding: 6px 10px; }

.reader-bar {
  /* wrap 仅在窄阅读列（分离窗窄幅 340/280px，四枚文字钮 ~400px 装不下）时生效，
     正常宽度单行不变；高度随之让 auto，min-height 保住正常态 52px 视觉 */
  min-height: 52px; flex-shrink: 0; flex-wrap: wrap; align-content: center;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-top: 1px solid var(--border);
}
</style>
