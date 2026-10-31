/**
 * useVirtualList — 可变高虚拟滚动（卡片视图高度不一：有图/无图；列表视图恒高走同一实现）
 *
 * 原理：预估高度起步 → 渲染后由 ResizeObserver 实测回填 → 前缀和偏移 + 二分定位可视窗口。
 * DOM 只挂可视区 ±overscan 行，万级数据滚动成本与总量无关。
 *
 * 性能纪律（2026-10-31 重构，改回必卡）：
 *  - **测量不进响应式**：高度存普通 Map，另用 `version` 计数器当唯一依赖；一帧内 N 次测量只
 *    重算一次前缀和（rAF 合并）。旧实现把每次测量写进 reactive Map，每行都触发全量偏移表重算
 *    与整表重渲染，滚进新区域/切源时是「测量风暴」。
 *  - **不用行内同步布局读取**：高度由 ResizeObserver 回调给出（浏览器已在布局后批量派发），
 *    不再在 patch 阶段读 offsetHeight —— 那是每次 patch 一次强制重排，行数越多越慢。
 *  - **ref 回调必须稳定**：`:ref` 传内联箭头函数时每次 patch 都会「旧 ref 置 null + 新 ref 挂载」，
 *    等于每帧对每行重跑一次挂载逻辑；这里按 key 记忆化，同一个 key 永远同一个函数。
 */
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export interface VirtualListOptions<T> {
  items: Ref<T[]>;
  keyOf: (item: T) => string;
  estimate: (item: T) => number;
  gap?: number;
  overscan?: number;
}

export function useVirtualList<T>(opts: VirtualListOptions<T>) {
  const gap = opts.gap ?? 0;
  const overscan = opts.overscan ?? 5;

  const containerRef = ref<HTMLElement | null>(null);
  const scrollTop = ref(0);
  const viewportH = ref(600);

  /** 实测高度：普通 Map（非响应式）。唯一作用是给 offsets 当数据源，改动由 version 通知 */
  const heights = new Map<string, number>();
  /** 响应式触发器：每帧最多自增一次（rAF 合并），offsets 只认它 */
  const version = ref(0);
  let bumpScheduled = false;
  function bumpVersion() {
    if (bumpScheduled) return;
    bumpScheduled = true;
    requestAnimationFrame(() => {
      bumpScheduled = false;
      version.value += 1;
    });
  }

  let rowRO: ResizeObserver | null = null;
  const keyByEl = new WeakMap<Element, string>();
  const elByKey = new Map<string, Element>();
  const refFns = new Map<string, (el: unknown) => void>();

  /** 实测回填（仅供无 ResizeObserver 的兜底路径调用；正常路径走 RO 批量回调，避免强制重排） */
  function applyMeasured(el: Element, key: string) {
    const entryH = (el as HTMLElement).getBoundingClientRect().height;
    if (entryH > 0 && heights.get(key) !== entryH) {
      heights.set(key, entryH);
      bumpVersion();
    }
  }

  /**
   * 每行稳定的 ref 回调（同一 key 复用同一函数，避免 patch 期反复「置空再挂载」）。
   * 用 ref 而非指令，是因为 v-for 里唯一能拿到 el 的官方途径就是 ref 回调。
   */
  function rowRef(key: string): (el: unknown) => void {
    let fn = refFns.get(key);
    if (!fn) {
      fn = (el: unknown) => {
        const prev = elByKey.get(key) || null;
        const next = el && typeof el === "object" && "getBoundingClientRect" in el ? (el as Element) : null;
        if (prev && prev !== next) {
          rowRO?.unobserve(prev);
          keyByEl.delete(prev);
          if (!next) elByKey.delete(key);
        }
        if (next) {
          elByKey.set(key, next);
          keyByEl.set(next, key);
          if (rowRO) {
            // RO 会在本帧布局后派发首测（含 initial observation），无需在 patch 期同步读数
            rowRO.observe(next);
          } else {
            requestAnimationFrame(() => {
              if (next.isConnected) applyMeasured(next, key);
            });
          }
        } else {
          elByKey.delete(key);
        }
      };
      refFns.set(key, fn);
    }
    return fn;
  }

  const offsets = computed(() => {
    void version.value; // 唯一响应式依赖：一帧内多次测量只重算一次
    const arr: number[] = [0];
    const list = opts.items.value;
    for (let i = 0; i < list.length; i++) {
      const k = opts.keyOf(list[i]);
      const h = (heights.has(k) ? heights.get(k)! : opts.estimate(list[i])) + gap;
      arr.push(arr[i] + h);
    }
    return arr;
  });

  const total = computed(() => offsets.value[opts.items.value.length] || 0);

  /** 二分：最后一个 start <= pos 的索引 */
  function findIndex(pos: number): number {
    const a = offsets.value;
    let lo = 0,
      hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const range = computed(() => {
    const list = opts.items.value;
    if (!list.length) return { start: 0, end: 0 };
    let start = findIndex(scrollTop.value);
    let end = start;
    const bottom = scrollTop.value + viewportH.value;
    const a = offsets.value;
    while (end < list.length && a[end] < bottom) end += 1;
    start = Math.max(0, start - overscan);
    end = Math.min(list.length, end + overscan);
    return { start, end };
  });

  const offsetOf = (i: number) => offsets.value[i] || 0;

  function onScroll() {
    if (containerRef.value) scrollTop.value = containerRef.value.scrollTop;
  }

  onMounted(() => {
    if (!containerRef.value) return;
    viewportH.value = containerRef.value.clientHeight;
    // 行测量：RO 回调在布局后批量派发，这里只写普通 Map + 合并一次版本自增
    rowRO = new ResizeObserver((entries) => {
      let dirty = false;
      for (const e of entries) {
        const key = keyByEl.get(e.target);
        if (!key) continue;
        const box = (e as ResizeObserverEntry).borderBoxSize;
        const h = Array.isArray(box) && box[0] ? box[0].blockSize : (e.target as HTMLElement).getBoundingClientRect().height;
        if (h > 0 && heights.get(key) !== h) {
          heights.set(key, h);
          dirty = true;
        }
      }
      if (dirty) bumpVersion();
    });
    // 容器尺寸（窗口缩放 / 分离窗切换）：只维护视口高，与行测量分离
    containerRO = new ResizeObserver(() => {
      const h = containerRef.value?.clientHeight || 0;
      if (h > 0 && h !== viewportH.value) viewportH.value = h;
    });
    containerRO.observe(containerRef.value);
  });

  let containerRO: ResizeObserver | null = null;
  onBeforeUnmount(() => {
    rowRO?.disconnect();
    containerRO?.disconnect();
    rowRO = null;
    containerRO = null;
    refFns.clear();
    elByKey.clear();
  });

  function scrollToIndex(i: number) {
    const c = containerRef.value;
    if (!c) return;
    const top = offsetOf(i);
    const h = (offsets.value[i + 1] || total.value) - top;
    if (top < c.scrollTop) c.scrollTop = top;
    else if (top + h > c.scrollTop + viewportH.value) c.scrollTop = top + h - viewportH.value;
    scrollTop.value = c.scrollTop;
  }

  return { containerRef, onScroll, range, total, offsetOf, rowRef, scrollToIndex, viewportH };
}
