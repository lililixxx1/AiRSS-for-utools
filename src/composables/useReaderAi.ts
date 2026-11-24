import { computed, ref, type ComputedRef, type Ref } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import type { ArticleAiToc, ArticleAiTrans, Item } from "../types";

export type ParaBlock = { el: HTMLElement; idx: number; head: string; text: string };

const TRANS_CLASS = "ra-trans";
const TOC_MIN_HEADINGS = 2;
const TOC_MIN_CHARS = 1500;
const TAG_RANK: Record<string, number> = { H2: 0, H3: 1, H4: 2 };

/**
 * 阅读面板 AI 编排：流式摘要/连续预取、段落翻译、结构/AI 目录与轮盘快捷键分发
 */
export function useReaderAi(opts: {
  item: ComputedRef<Item | null>;
  html: Ref<string>;
  scrollEl: Ref<HTMLElement | null>;
  contentEl: Ref<HTMLElement | null>;
  loadedTrans: Ref<ArticleAiTrans | null>;
  loadedToc: Ref<ArticleAiToc | null>;
  closeWheel: () => void;
}) {
  const data = useDataStore();
  const settings = useSettingsStore();
  const ui = useUiStore();

  // ---- 流式 AI 摘要 & 连续预取 ----
  const aiState = ref<"idle" | "loading" | "done" | "error">("idle");
  const aiText = ref("");
  const aiError = ref("");
  let aiSeq = 0;
  let aiPending = "";
  let aiFlushTimer: number | null = null;
  let prefetchSeq = 0;

  async function prefetchNext(fromId: string, count: number) {
    const seq = ++prefetchSeq;
    const list = data.filtered;
    const me = data.items.find((x) => x._id === fromId);
    if (!me) return;
    let start = list.findIndex((x) => x._id === fromId) + 1;
    if (start === 0) {
      start = list.findIndex((x) => (settings.orderBy === "oldest" ? x.pubTs > me.pubTs : x.pubTs <= me.pubTs));
    }
    if (start < 0) return;
    let sent = 0;
    for (let i = start; i < list.length && sent < count; i++) {
      if (seq !== prefetchSeq || ui.readerItemId !== fromId) return;
      const cand = list[i];
      if (!cand || cand.ai?.aiSource === "enrich" || cand.aiStatus === "error") continue;
      sent += 1;
      window.airss.ai.abort();
      const r = await window.airss.ai.enrich(cand._id, {});
      if (seq !== prefetchSeq || ui.readerItemId !== fromId) return;
      if (!r.ok) break;
      if (r.item) data.replaceItemInPlace(r.item);
    }
  }

  function onDeltaThrottled(seq: number, t: string) {
    if (seq !== aiSeq) return;
    aiPending += t;
    if (aiPending.length > 4000) aiPending = aiPending.slice(-4000);
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
    aiSeq += 1;
    prefetchSeq += 1;
    if (aiFlushTimer != null) {
      clearTimeout(aiFlushTimer);
      aiFlushTimer = null;
    }
    aiPending = "";
    aiState.value = "idle";
    aiText.value = "";
    aiError.value = "";
  }

  // ---- 段落切分与缓存（翻译 + 目录共用）----
  let parasCache: { html: string; paras: ParaBlock[]; all: ParaBlock[] } = { html: "", paras: [], all: [] };

  function parasCacheValid(): boolean {
    if (parasCache.html !== opts.html.value) return false;
    if (!parasCache.all.length) return true;
    return !!opts.contentEl.value?.contains(parasCache.all[0].el);
  }

  function collectParas(): ParaBlock[] {
    const root = opts.contentEl.value;
    if (!root) return [];
    const nodes = Array.from(root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")) as HTMLElement[];
    const out: ParaBlock[] = [];
    let total = 0;
    for (const el of nodes) {
      if (el.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote")) continue;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length < 10) continue;
      if (out.length >= 10 || total >= 4000) break;
      out.push({ el, idx: out.length, head: text.slice(0, 20), text: text.slice(0, Math.min(400, 4000 - total)) });
      total += out[out.length - 1].text.length;
    }
    return out;
  }

  function collectParasAll(): ParaBlock[] {
    const root = opts.contentEl.value;
    if (!root) return [];
    const nodes = Array.from(root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")) as HTMLElement[];
    const out: ParaBlock[] = [];
    for (const el of nodes) {
      if (el.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote")) continue;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length < 10 && !/^H[1-6]$/.test(el.tagName)) continue;
      out.push({ el, idx: out.length, head: text.slice(0, 20), text });
    }
    return out;
  }

  function collectParasAllCached(): ParaBlock[] {
    if (parasCacheValid()) return parasCache.all;
    parasCache = { html: opts.html.value, paras: collectParas(), all: collectParasAll() };
    return parasCache.all;
  }

  function collectParasCached(): ParaBlock[] {
    collectParasAllCached();
    return parasCache.paras;
  }

  // ---- AI 目录与面板 ----
  const tocState = ref<"idle" | "loading" | "done">("idle");
  const tocHeadings = ref<{ title: string; idx: number; head: string; level: 1 | 2 | 3 }[]>([]);
  const tocParasCount = ref(0);
  const tocFullChars = ref(0);
  const tocCurrentIdx = ref(-1);
  const aiPanelOpen = ref(false);
  let tocSeq = 0;
  let tocMetaKey: string | null = null;
  let tocWarmup: { ric: number; timer: number } = { ric: 0, timer: 0 };

  function refreshTocMeta() {
    const all = collectParasAllCached();
    tocParasCount.value = all.length;
    tocFullChars.value = all.reduce((n, b) => n + b.text.length, 0);
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

  function ensureTocMeta() {
    if (tocMetaKey === opts.html.value) return;
    tocMetaKey = opts.html.value;
    refreshTocMeta();
  }

  function cancelTocWarmup() {
    if (tocWarmup.ric) cancelIdleCallback(tocWarmup.ric);
    if (tocWarmup.timer) clearTimeout(tocWarmup.timer);
    tocWarmup = { ric: 0, timer: 0 };
  }

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

  const tocFromHtml = computed(() => tocHeadings.value.length >= TOC_MIN_HEADINGS);
  const tocEntries = computed(() => {
    if (tocFromHtml.value) return tocHeadings.value.map((h) => ({ ...h, kind: "html" as const }));
    return (opts.loadedToc.value?.sections || []).map((s) => ({ ...s, kind: "ai" as const }));
  });
  const tocAiEligible = computed(() => !tocFromHtml.value && tocFullChars.value >= TOC_MIN_CHARS);
  const tocCoverPercent = computed(() => {
    const s = opts.loadedToc.value?.sections;
    if (tocFromHtml.value || !s?.length || !tocParasCount.value) return 100;
    return Math.min(100, Math.round(((s[s.length - 1].idx + 1) / tocParasCount.value) * 100));
  });

  function markCurrentSection(sections: { idx: number }[]) {
    const sc = opts.scrollEl.value;
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

  function openAiPanel() {
    ensureTocMeta();
    aiPanelOpen.value = true;
    markCurrentSection(tocEntries.value);
  }

  async function runToc(bypass = false) {
    const it = opts.item.value;
    if (!it) return;
    if (aiState.value === "loading") ui.toast("已中断摘要生成");
    window.airss.ai.abort();
    const seq = ++tocSeq;
    tocState.value = "loading";
    ensureTocMeta();
    const paras = collectParasAllCached().map((b) => ({
      idx: b.idx,
      head: b.head,
      text: b.text.slice(0, 200),
      tag: /^H[1-6]$/.test(b.el.tagName) ? b.el.tagName.toLowerCase() : undefined,
    }));
    try {
      const res = await window.airss.ai.generateToc(it._id, paras, { bypass });
      if (seq !== tocSeq) return;
      if (res.ok && res.aiToc) {
        opts.loadedToc.value = res.aiToc;
        it.hasAiToc = true;
        tocState.value = "done";
        return;
      }
      tocState.value = opts.loadedToc.value?.sections?.length ? "done" : "idle";
      if (res.aborted || res.error === "ABORTED") return;
      if (res.error === "QUOTA_EXHAUSTED") ui.toast("今日 AI 额度已用完", "error");
      else if (res.error === "NO_PARAS") ui.toast("没有可生成目录的段落");
      else if (res.error === "CONTENT_CHANGED") return;
      else ui.toast("目录生成失败：" + (res.error || "AI_FAILED"), "error");
    } catch (e: any) {
      if (seq === tocSeq) {
        tocState.value = opts.loadedToc.value?.sections?.length ? "done" : "idle";
        ui.toast("目录生成失败：" + String(e?.message || e), "error");
      }
    }
  }

  function jumpTo(idx: number, head: string) {
    const b = collectParasAllCached()[idx];
    if (!b || b.head !== head) {
      opts.loadedToc.value = null;
      if (opts.item.value) opts.item.value.hasAiToc = false;
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

  function resetToc() {
    tocSeq += 1;
    tocMetaKey = null;
    tocState.value = "idle";
    tocHeadings.value = [];
    tocParasCount.value = 0;
    tocFullChars.value = 0;
    tocCurrentIdx.value = -1;
    aiPanelOpen.value = false;
    opts.closeWheel();
  }

  // ---- AI 段落翻译 ----
  const trState = ref<"idle" | "loading" | "done" | "error">("idle");
  const trProgress = ref({ done: 0, total: 0 });
  const trShown = ref(false);
  let trSeq = 0;

  const translatable = computed(() => {
    if (!settings.aiEnabled) return false;
    if (trState.value !== "idle" || opts.loadedTrans.value?.paras?.length) return true;
    const sample = opts.html.value.replace(/<[^>]+>/g, "").slice(0, 600).trim();
    if (!sample) return false;
    return (sample.match(/[\u4e00-\u9fff]/g) || []).length / sample.length <= 0.5;
  });

  function removeTranslations() {
    opts.contentEl.value?.querySelectorAll("." + TRANS_CLASS).forEach((n) => n.remove());
    trShown.value = false;
  }

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
    trShown.value = inserted > 0;
  }

  async function runTranslate(bypass = false) {
    const it = opts.item.value;
    if (!it || !settings.aiEnabled) return;
    window.airss.ai.abort();
    const seq = ++trSeq;
    trProgress.value = { done: 0, total: 0 };
    if (!bypass && opts.loadedTrans.value?.paras?.length) {
      trState.value = "done";
      insertTranslations(opts.loadedTrans.value.paras);
      return;
    }
    const paras = collectParasCached().map(({ el, ...rest }) => rest);
    if (!paras.length) {
      ui.toast("没有可翻译的段落");
      return;
    }
    trState.value = "loading";
    trProgress.value = { done: 0, total: paras.length };
    let maxIdx = -1;
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
        opts.loadedTrans.value = res.aiTrans;
        it.hasAiTrans = true;
        trState.value = "done";
        insertTranslations(res.aiTrans.paras);
      } else if (res.aborted || res.error === "ABORTED") {
        trState.value = opts.loadedTrans.value?.paras?.length ? "done" : "idle";
        if (opts.loadedTrans.value?.paras?.length) insertTranslations(opts.loadedTrans.value.paras);
      } else if (res.error === "CONTENT_CHANGED") {
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
      insertTranslations(opts.loadedTrans.value?.paras || []);
      if (trShown.value) return;
      void runTranslate(true);
      return;
    }
    void runTranslate();
  }

  function resetTrans() {
    trSeq += 1;
    trState.value = "idle";
    trProgress.value = { done: 0, total: 0 };
    trShown.value = false;
  }

  // ---- 主摘要 ----
  async function runEnrich(bypass = false) {
    const it = opts.item.value;
    if (!it) return;
    if (!settings.aiEnabled) {
      aiState.value = "idle";
      return;
    }
    window.airss.ai.abort();
    const seq = ++aiSeq;
    aiState.value = "loading";
    aiText.value = it.ai?.summary || "";
    aiPending = "";
    aiError.value = "";
    try {
      const res = await window.airss.ai.enrich(it._id, {
        bypass,
        onDelta: (t: string) => onDeltaThrottled(seq, t),
      });
      if (seq !== aiSeq) return;
      if (aiFlushTimer != null) {
        clearTimeout(aiFlushTimer);
        aiFlushTimer = null;
      }
      if (aiPending) {
        aiText.value = (aiText.value + aiPending).slice(-4000);
        aiPending = "";
      }
      if (res.ok && res.ai) {
        if (res.item) {
          data.replaceItemInPlace(res.item);
        } else {
          it.ai = res.ai;
          it.aiStatus = "done";
          const disp = res.ai.titleNorm || res.ai.titleZh;
          if (disp && disp !== it.title) it.titleDisplay = disp;
          data.replaceItemInPlace(it);
        }
        aiText.value = res.ai.summary || aiText.value;
        aiState.value = "done";
        ensureTocMeta();
        if (!tocFromHtml.value && tocAiEligible.value && !opts.loadedToc.value) {
          await runToc().catch(() => {});
        }
        if (seq !== aiSeq) return;
        if (settings.aiAutoCount > 1) void prefetchNext(it._id, settings.aiAutoCount - 1);
      } else if (res.aborted || res.error === "ABORTED") {
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

  const showAiBtn = computed(
    () => settings.aiEnabled && settings.aiAutoCount === 0 && aiState.value === "idle" && !opts.item.value?.ai?.summary && !data.aiBusy.has(opts.item.value?._id || "")
  );
  const aiBusyDot = computed(() => aiState.value === "loading" || trState.value === "loading" || tocState.value === "loading");
  const hasSummary = computed(() => !!opts.item.value?.ai?.summary);

  function onWheelSummary() {
    if (!settings.aiEnabled) {
      ui.toast("未开启 AI 增强（设置 → AI）");
      return;
    }
    if (aiState.value === "loading") return;
    if (aiState.value === "error") {
      void runEnrich(true);
      return;
    }
    if (opts.item.value?.ai?.summary) {
      opts.scrollEl.value?.scrollTo({
        top: 0,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      return;
    }
    void runEnrich();
  }

  function onWheelTrans() {
    if (!settings.aiEnabled) {
      ui.toast("未开启 AI 增强（设置 → AI）");
      return;
    }
    if (trState.value === "loading") {
      window.airss.ai.abort();
      return;
    }
    onTransBtn();
  }

  async function onWheelToc() {
    ensureTocMeta();
    if (tocEntries.value.length || tocState.value === "loading" || !tocAiEligible.value || !settings.aiEnabled) {
      openAiPanel();
      return;
    }
    const it = opts.item.value;
    if (!it) return;
    await runToc();
    if (tocState.value === "done" && opts.loadedToc.value && it._id === ui.readerItemId) openAiPanel();
  }

  function onWheelFind() {
    ui.railSearch = false;
    ui.readerFind = true;
    ui.readerFindFocus++;
  }

  return {
    aiState,
    aiText,
    aiError,
    showAiBtn,
    aiBusyDot,
    hasSummary,
    runEnrich,
    prefetchNext,
    resetAiStream,
    trState,
    trProgress,
    trShown,
    translatable,
    insertTranslations,
    onTransBtn,
    resetTrans,
    tocState,
    tocEntries,
    tocFromHtml,
    tocAiEligible,
    tocCoverPercent,
    tocCurrentIdx,
    aiPanelOpen,
    ensureTocMeta,
    scheduleTocWarmup,
    cancelTocWarmup,
    runToc,
    jumpTo,
    resetToc,
    openAiPanel,
    onWheelSummary,
    onWheelTrans,
    onWheelToc,
    onWheelFind,
  };
}
