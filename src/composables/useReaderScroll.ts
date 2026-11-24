import { type Ref } from "vue";
import { saveReadPosition } from "../stores/theme";

/**
 * 阅读滚动进度防抖持久化与恢复（不触发响应式重渲染）
 */
export function useReaderScroll(scrollEl: Ref<HTMLElement | null>, getActiveId: () => string | null) {
  let lastReaderId: string | null = null;
  let posSaveTimer: number | null = null;

  function ratioOf(): number {
    const el = scrollEl.value;
    if (!el) return 0;
    return el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
  }

  function schedulePosSave() {
    if (posSaveTimer != null || !getActiveId() || !scrollEl.value) return;
    posSaveTimer = window.setTimeout(() => {
      posSaveTimer = null;
      const id = getActiveId();
      if (id && scrollEl.value) saveReadPosition(id, ratioOf());
    }, 800);
  }

  function cancelPosSave() {
    if (posSaveTimer != null) {
      clearTimeout(posSaveTimer);
      posSaveTimer = null;
    }
  }

  function saveNow(id: string | null) {
    if (id && scrollEl.value) saveReadPosition(id, ratioOf());
  }

  function restoreRatio(ratio: number) {
    const el = scrollEl.value;
    if (!el) return;
    el.scrollTop = ratio > 0 ? ratio * (el.scrollHeight - el.clientHeight) : 0;
  }

  function setLastReaderId(id: string | null) {
    lastReaderId = id;
  }

  function flushOnUnmount() {
    cancelPosSave();
    if (lastReaderId && scrollEl.value) saveReadPosition(lastReaderId, ratioOf());
    lastReaderId = null;
  }

  return {
    ratioOf,
    schedulePosSave,
    cancelPosSave,
    saveNow,
    restoreRatio,
    setLastReaderId,
    flushOnUnmount,
  };
}
