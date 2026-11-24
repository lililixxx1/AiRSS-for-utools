import { nextTick, ref, type ComputedRef, type Ref } from "vue";
import { getReadPosition, setReadPositionCache } from "../stores/theme";
import type { ArticleAiToc, ArticleAiTrans, Feed, Item } from "../types";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 文章正文、提取全文、本机 AI 译文/目录侧载按需加载与全文提取替换
 */
export function useReaderContent(opts: {
  item: ComputedRef<Item | null>;
  feed: ComputedRef<Feed | undefined>;
  contentEl: Ref<HTMLElement | null>;
  getReaderItemId: () => string | null;
  onExtracted?: (status: "hit" | "fetched") => Promise<void> | void;
}) {
  const html = ref("");
  const loadedTrans = ref<ArticleAiTrans | null>(null);
  const loadedToc = ref<ArticleAiToc | null>(null);

  function applyImgAttrs() {
    opts.contentEl.value?.querySelectorAll("img").forEach((img) => {
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
    });
  }

  async function loadArticle(id: string): Promise<{ savedRatio: number } | null> {
    html.value = "";
    loadedTrans.value = null;
    loadedToc.value = null;

    const detail = await window.airss.db.getItemDetail(id);
    if (opts.getReaderItemId() !== id) return null;

    loadedTrans.value = detail?.aiTrans || null;
    loadedToc.value = detail?.aiToc || null;
    if (detail?.ai && opts.item.value && !opts.item.value.ai) {
      opts.item.value.ai = detail.ai;
    }

    let savedRatio = 0;
    if (typeof detail?.readPos === "number") {
      savedRatio = detail.readPos;
      setReadPositionCache(id, savedRatio);
    } else {
      savedRatio = await getReadPosition(id);
      if (opts.getReaderItemId() !== id) return null;
    }

    let content: string | null = detail?.fullxContent || detail?.content || null;
    if (!content) {
      const sum = opts.item.value?.summaryText;
      content = sum ? `<p>${escapeHtml(sum)}</p>` : "<p>（无正文摘要，请打开原文查看）</p>";
    }
    html.value = content;
    return { savedRatio };
  }

  async function maybeExtractFull(id: string) {
    if (!opts.feed.value?.fullText) return;
    const r = await window.airss.article.ensureFull(id);
    if (opts.getReaderItemId() !== id) return;
    if ((r.status === "hit" || r.status === "fetched") && r.content) {
      html.value = r.content;
      if (r.status === "fetched") {
        loadedTrans.value = null;
        loadedToc.value = null;
        if (opts.item.value) {
          opts.item.value.hasAiTrans = false;
          opts.item.value.hasAiToc = false;
        }
      }
      await opts.onExtracted?.(r.status);
      await nextTick();
      applyImgAttrs();
    }
  }

  return {
    html,
    loadedTrans,
    loadedToc,
    applyImgAttrs,
    loadArticle,
    maybeExtractFull,
  };
}
