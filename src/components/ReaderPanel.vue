<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onUpdated, ref, watch } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { useReaderScroll } from "../composables/useReaderScroll";
import { useReaderContent } from "../composables/useReaderContent";
import { useReaderAi } from "../composables/useReaderAi";
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

const scrollEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const wheelRef = ref<InstanceType<typeof AiWheel> | null>(null);
const wheelBall = computed(() => wheelRef.value?.ballEl ?? null);

const scroll = useReaderScroll(scrollEl, () => ui.readerItemId);

let afterExtractedHook: ((status: "hit" | "fetched") => Promise<void> | void) | null = null;
const content = useReaderContent({
  item,
  feed,
  contentEl,
  getReaderItemId: () => ui.readerItemId,
  onExtracted: async (status) => {
    await afterExtractedHook?.(status);
  },
});
const { html, loadedTrans, loadedToc, applyImgAttrs, loadArticle, maybeExtractFull } = content;

const ai = useReaderAi({
  item,
  html,
  scrollEl,
  contentEl,
  loadedTrans,
  loadedToc,
  closeWheel: () => wheelRef.value?.close(),
});

afterExtractedHook = async (status) => {
  ai.resetTrans();
  ai.resetToc();
  await nextTick();
  ai.scheduleTocWarmup();
  if (status === "hit" && item.value) {
    ai.tocState.value = loadedToc.value?.sections?.length ? "done" : "idle";
    if (settings.aiEnabled && loadedTrans.value?.paras?.length) {
      ai.trState.value = "done";
      ai.insertTranslations(loadedTrans.value.paras);
    }
  }
};

const {
  aiState,
  aiText,
  aiError,
  showAiBtn,
  aiBusyDot,
  hasSummary,
  runEnrich,
  trState,
  trProgress,
  trShown,
  translatable,
  onTransBtn,
  tocState,
  tocEntries,
  tocFromHtml,
  tocAiEligible,
  tocCoverPercent,
  tocCurrentIdx,
  aiPanelOpen,
  runToc,
  jumpTo,
  onWheelSummary,
  onWheelTrans,
  onWheelToc,
  onWheelFind,
} = ai;
const { schedulePosSave } = scroll;

const readingMin = computed(() =>
  Math.max(1, Math.round((html.value || item.value?.summaryText || "").replace(/<[^>]+>/g, "").length / 400))
);
const displayTitle = computed(() => (settings.aiTitle ? item.value?.titleDisplay || item.value?.title : item.value?.title) || "");
const titleRewritten = computed(() => !!item.value && displayTitle.value !== item.value.title);

watch(
  () => ui.readerItemId,
  async (id, oldId) => {
    scroll.cancelPosSave();
    ai.cancelTocWarmup();
    if (oldId && scrollEl.value) {
      window.airss.ai.abort();
      scroll.saveNow(oldId);
    }
    ai.resetAiStream();
    ai.resetTrans();
    ai.resetToc();
    ui.readerFind = false;
    ui.railSearch = false;
    if (!id) return;
    scroll.setLastReaderId(id);

    const loaded = await loadArticle(id);
    if (!loaded || ui.readerItemId !== id) return;

    if (settings.aiEnabled) {
      if (item.value?.ai?.summary) {
        aiState.value = "done";
        aiText.value = item.value.ai.summary;
        if (settings.aiAutoCount > 1) void ai.prefetchNext(id, settings.aiAutoCount - 1);
      } else if (settings.aiAutoCount >= 1) {
        void runEnrich();
      } else {
        aiState.value = "idle";
      }
    }

    await nextTick();
    applyImgAttrs();
    ai.scheduleTocWarmup();
    tocState.value = loadedToc.value?.sections?.length ? "done" : "idle";
    if (settings.aiEnabled && loadedTrans.value?.paras?.length) {
      trState.value = "done";
      ai.insertTranslations(loadedTrans.value.paras);
    }
    scroll.restoreRatio(loaded.savedRatio);
    void maybeExtractFull(id);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  window.airss.ai.abort();
  ai.cancelTocWarmup();
  ai.resetToc();
  ui.readerFind = false;
  scroll.flushOnUnmount();
});

onUpdated(() => schedulePosSave());

function onContentClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (a && a.href) {
    e.preventDefault();
    window.airss.sys.openExternal(a.href);
  }
}

function onContentImgError(e: Event) {
  const t = e.target as HTMLElement;
  if (t && t.tagName === "IMG") t.style.display = "none";
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
        <!-- v-html 唯一信任源：preload article.sanitizeContent 产物（PLAN §7）；
             @error.capture 隐藏加载失败的正文图片（F4） -->
        <div class="ra-content" ref="contentEl" @click="onContentClick" @error.capture="onContentImgError" v-html="html"></div>
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
/* 正文内 h1（源文自带大标题，如橘鸦「AI 早报 日期」）：白名单放行但原先无规则，落 UA 默认 2em 粗体压过 h2 与顶部文章标题，统一收进正文标题阶 */
.ra-content :deep(h1) { font-size: 1.3em; font-weight: 700; margin: 1em 0 0.5em; }
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
