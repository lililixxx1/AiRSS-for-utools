<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onUpdated, ref, watch } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { saveReadPosition, loadReadPositions } from "../stores/theme";
import { I } from "./icons";
import AiSummaryCard from "./AiSummaryCard.vue";
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
function collectParas(): { el: HTMLElement; idx: number; head: string; text: string }[] {
  const root = contentEl.value;
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")) as HTMLElement[];
  const out: { el: HTMLElement; idx: number; head: string; text: string }[] = [];
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
  const blocks = collectParas();
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
  const paras = collectParas().map(({ el, ...rest }) => rest);
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

/** 全文提取接线（PLAN-V1.3 A）：源开 fullText 才请求；先出摘要不阻塞，
 *  hit/fetched 替换正文并重跑图片懒加载；替换后不重放滚动恢复（onUpdated 按新
 *  比例继续保存）；各失败态安静保留原摘要（无 toast）。 */
async function maybeExtractFull(id: string) {
  if (!feed.value?.fullText) return;
  const r = await window.airss.article.ensureFull(id);
  if (ui.readerItemId !== id) return; // 快速切文守卫：迟到的旧文正文不得覆盖新文
  if ((r.status === "hit" || r.status === "fetched") && r.content) {
    html.value = r.content;
    // 旧译文已被 preload 侧连带失效（T-09 同族），按钮回「翻译」态，可按新全文重译
    resetTrans();
    await nextTick();
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
    if (oldId && scrollEl.value) {
      window.airss.ai.abort(); // 切换/关闭：中断进行中的流（aborted 不记 error）
      // 切走前立即落盘旧文进度（此刻 DOM 仍是旧文，比例有效；reader 常驻的切换场景）
      saveReadPosition(oldId, ratioOf());
    }
    resetAiStream();
    resetTrans();
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
    <!-- 顶栏 -->
    <header class="reader-top">
      <button v-if="!ui.detached" class="btn btn-ghost btn-sm" @click="ui.closeReader()">
        <I.arrowLeft />返回<span class="kbd">⌫</span>
      </button>
      <div class="flex1"></div>
      <button
        v-if="translatable"
        class="btn btn-ghost btn-sm"
        :class="{ 'is-on': trShown }"
        :disabled="trState === 'loading'"
        :title="trState === 'error' ? '上次翻译失败，点击重试' : 'AI 段落翻译'"
        @click="onTransBtn"
      >
        <I.languages />
        <span v-if="trState === 'loading'" class="num">翻译中 {{ trProgress.done }}/{{ trProgress.total }}</span>
        <span v-else-if="trState === 'done'">{{ trShown ? "收起译文" : "显示译文" }}</span>
        <span v-else>翻译</span>
      </button>
      <button class="btn btn-ghost btn-sm" :class="{ 'is-on': settings.serif }" @click="settings.set('serif', !settings.serif)">衬线</button>
      <div class="font-step" role="group" aria-label="正文字号">
        <button class="fs-btn" :disabled="settings.fontLevel === 0" aria-label="减小字号" @click="settings.set('fontLevel', settings.fontLevel - 1 as 1)">A−</button>
        <span class="num fs-cur">{{ fontLabels[settings.fontLevel] }}</span>
        <button class="fs-btn" :disabled="settings.fontLevel === 3" aria-label="增大字号" @click="settings.set('fontLevel', settings.fontLevel + 1 as 2)">A+</button>
      </div>
    </header>

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
          <button v-if="showAiBtn" class="btn btn-ghost btn-sm" @click="runEnrich()"><I.sparkle />AI 摘要</button>
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

    <!-- 底部操作条 -->
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
.flex1 { flex: 1; }

.font-step { display: flex; align-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-md); overflow: hidden; }
.fs-btn {
  height: 28px; padding: 0 10px; border: none; background: transparent;
  font-family: inherit; font-size: 12px; color: var(--text-2); cursor: pointer;
}
.fs-btn:hover:not(:disabled) { background: var(--bg-card-hover); }
.fs-btn:disabled { color: var(--text-disabled); cursor: default; }
.fs-cur { font-size: 12px; color: var(--text-3); padding: 0 2px; }

.reader-scroll { flex: 1; min-height: 0; overflow-y: auto; }
/* 流式行宽：块级元素天然不超容器宽（窄面板自然收窄），仅设 75em 上限；
   em 基准=阅读字号（§533）。勿写 min(100% - …)：Chromium 对 max-width 内 min() 的百分比分支解析异常 */
.reader-article { font-size: var(--reading-fs, 16px); max-width: 75em; margin-inline: auto; padding: 24px 24px 48px; }
.serif { font-family: var(--font-serif); }

.ra-title { font-size: 22px; font-weight: 700; line-height: 1.35; color: var(--text-1); }
html[data-theme="dark"] .ra-title { font-size: 22px; }
.ai-mark {
  display: inline-block; vertical-align: 4px; margin-left: 8px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
  color: var(--accent-deep); border: 1px solid var(--accent-deep);
  border-radius: var(--r-sm); padding: 0 4px; line-height: 16px; opacity: 0.85;
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
  height: 52px; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; border-top: 1px solid var(--border);
}
</style>
