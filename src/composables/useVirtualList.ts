/**
 * useVirtualList — 可变高虚拟滚动（卡片视图高度不一：有图/无图；列表视图恒高走同一实现）
 *
 * 原理：预估高度起步 → 渲染后实测回填（ResizeObserver 观察行元素）→ 前缀和偏移 + 二分定位可视窗口。
 * DOM 只挂可视区 ±overscan 行，万级数据滚动成本与总量无关。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, type Ref, watch } from "vue";

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
  const measured = reactive(new Map<string, number>()); // 实测高度缓存

  let ro: ResizeObserver | null = null;

  const offsets = computed(() => {
    const arr: number[] = [0];
    const list = opts.items.value;
    for (let i = 0; i < list.length; i++) {
      const k = opts.keyOf(list[i]);
      const h = (measured.has(k) ? measured.get(k)! : opts.estimate(list[i])) + gap;
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

  /** 行元素挂载后回填实测高度（组件模板 :ref 调用） */
  function measureRow(el: unknown, key: string) {
    if (!el || typeof el !== "object" || !("offsetHeight" in el)) return;
    const h = (el as HTMLElement).offsetHeight;
    if (h > 0 && measured.get(key) !== h) measured.set(key, h);
  }

  function onScroll() {
    if (containerRef.value) scrollTop.value = containerRef.value.scrollTop;
  }

  onMounted(() => {
    if (!containerRef.value) return;
    viewportH.value = containerRef.value.clientHeight;
    ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === containerRef.value) viewportH.value = e.contentRect.height;
      }
    });
    ro.observe(containerRef.value);
  });
  onBeforeUnmount(() => ro?.disconnect());

  // 数据集收缩后滚动位置可能越界，watch 拉回
  watch(total, (t) => {
    if (containerRef.value && containerRef.value.scrollTop > t) {
      containerRef.value.scrollTop = Math.max(0, t - viewportH.value);
      scrollTop.value = containerRef.value.scrollTop;
    }
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

  return { containerRef, onScroll, range, total, offsetOf, measureRow, scrollToIndex, viewportH };
}
