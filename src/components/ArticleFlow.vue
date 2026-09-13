<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { useVirtualList } from "../composables/useVirtualList";
import ArticleCard from "./ArticleCard.vue";
import ArticleRow from "./ArticleRow.vue";
import EmptyState from "./EmptyState.vue";
import { I } from "./icons";
import type { Item } from "../types";

const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();

/** 当前过滤视图标题（工具栏左侧） */
const viewTitle = computed(() => {
  const f = data.filter;
  if (f.kind === "all") return "所有文章";
  if (f.kind === "unread") return "未读";
  if (f.kind === "starred") return "收藏";
  if (f.kind === "feed") return data.feedMap.get(f.value!)?.title || "订阅源";
  if (f.kind === "tag") return "#" + (f.value || "");
  return f.value || "分类";
});

const items = computed(() => data.filtered);
const isCard = computed(() => settings.viewMode === "card");

const vl = useVirtualList<Item>({
  items,
  keyOf: (it) => it._id,
  estimate: (it) => (isCard.value ? (it.cover ? 312 : 178) : 40),
  gap: isCard.value ? 14 : 2,
  overscan: 5,
});

const window_ = computed(() => {
  const { start, end } = vl.range.value;
  const arr: { item: Item; index: number }[] = [];
  for (let i = start; i < end; i++) arr.push({ item: items.value[i], index: i });
  return arr;
});

// j/k 移动光标时滚动跟随（键盘流在 App.vue 全局处理，此处只负责跟随）
watch(
  () => ui.cursor,
  (i) => {
    if (i >= 0 && i < items.value.length) vl.scrollToIndex(i);
  }
);
watch(items, (list) => {
  if (ui.cursor >= list.length) ui.cursor = Math.max(0, list.length - 1);
});

/** aria-activedescendant 指向当前项（design-system §8.2）：虚拟列表窗外短暂缺节点无害，
 *  游标 watch 会 scrollToIndex 让它随即进入窗口 */
const cursorDomId = computed(() => {
  const it = items.value[ui.cursor];
  return it ? "af-item-" + it._id : undefined;
});

const sortOpen = ref(false);
const SORTS: { key: "newest" | "oldest" | "unread"; label: string }[] = [
  { key: "newest", label: "最新发布" },
  { key: "oldest", label: "最旧发布" },
  { key: "unread", label: "未读优先" },
];
const sortLabel = computed(() => SORTS.find((s) => s.key === settings.orderBy)?.label || "最新发布");

/** 分离窗列表列 260–400px（窄幅自适应，App.vue .sb-auto）：工具栏降为图标态（文字进 title/aria-label），防挤压折行 */
const compact = computed(() => ui.detached);

/** 空态判定（muted-empty 先于 all-read：静音清空视图时不得谎称"全部读完"） */
const emptyKind = computed<null | "first-run" | "no-result" | "all-empty" | "category-empty" | "all-read" | "muted-empty" | null>(() => {
  if (!data.loaded) return null;
  if (items.value.length) return null;
  if (!data.feeds.length) return "first-run";
  if (data.search.trim()) return "no-result";
  if (data.mutedInView > 0) return "muted-empty";
  if (data.filter.kind === "unread") return "all-read";
  if (data.filter.kind === "all") return "all-empty";
  if (data.filter.kind === "category") return "category-empty";
  if (data.filter.kind === "starred") return "category-empty";
  return "category-empty";
});
</script>

<template>
  <section class="content">
    <!-- 刷新进度条（不确定态位移） -->
    <div class="content-progress" v-if="data.refreshing" role="status" aria-label="刷新中"></div>

    <header class="toolbar" :class="{ compact }">
      <div class="tb-left">
        <h1 class="tb-title ellipsis" id="af-title">{{ viewTitle }}</h1>
        <button class="icon-btn lg" :class="{ spin: data.refreshing }" aria-label="刷新" :disabled="data.refreshing" @click="data.refreshDue(true)">
          <I.refresh />
        </button>
        <button
          class="btn btn-ghost btn-sm"
          :aria-label="compact ? '全部已读' : undefined"
          :title="compact ? '全部已读' : undefined"
          @click="data.markAllRead()"
        >
          <I.doneAll /><span v-show="!compact">全部已读</span>
        </button>
        <span class="tb-progress num" v-if="data.refreshing && data.progress.total">{{ data.progress.done }}/{{ data.progress.total }}</span>
      </div>
      <div class="tb-right">
        <!-- 搜索态：结果计数 / 正文扫描中 / 预算截断提示（title 悬浮给全文说明） -->
        <span v-if="data.search.trim() && !data.searchScanning" class="tb-progress num">{{ items.length }} 个结果</span>
        <span v-if="data.searchScanning" class="tb-progress num">正文中检索…</span>
        <span v-else-if="data.searchTruncated && data.search.trim()" class="tb-progress num" :title="`内容较多，仅扫描了前 ${data.searchScanned} 篇正文`">部分扫描</span>
        <!-- 静音透视（PLAN-V1.3 B）：被静音篇数可暂停查看；计数不受静音影响 -->
        <button
          v-if="data.mutedInView > 0"
          class="btn btn-ghost btn-sm"
          :class="{ 'is-on': data.mutePaused }"
          :title="data.mutePaused ? '静音过滤已暂停，点击恢复' : '点击暂停静音过滤（临时查看被静音的文章）'"
          @click="data.mutePaused = !data.mutePaused"
        >
          <I.volumeX />
          <span class="num" v-if="compact">{{ data.mutedInView }}</span>
          <span class="num" v-else>{{ data.mutePaused ? `过滤已暂停 ${data.mutedInView}` : `已静音 ${data.mutedInView} 篇` }}</span>
        </button>
        <!-- 视图切换 -->
        <div class="view-switch" role="group" aria-label="视图切换">
          <button class="icon-btn vs-btn" :class="{ on: !isCard }" aria-label="列表视图" @click="settings.set('viewMode', 'list')"><I.list /></button>
          <button class="icon-btn vs-btn" :class="{ on: isCard }" aria-label="卡片视图" @click="settings.set('viewMode', 'card')"><I.grid /></button>
        </div>
        <!-- 排序下拉 -->
        <div class="sort-dd">
          <button
            class="dd-btn"
            :aria-expanded="sortOpen"
            :aria-label="compact ? `排序：${sortLabel}` : undefined"
            :title="compact ? `排序：${sortLabel}` : undefined"
            @click="sortOpen = !sortOpen"
          >
            <I.sort /><span v-show="!compact">{{ sortLabel }}</span><I.chevronDown />
          </button>
          <Transition name="pop">
            <div class="dd-menu" v-if="sortOpen" role="listbox">
              <button
                v-for="s in SORTS"
                :key="s.key"
                class="dd-item"
                role="option"
                :aria-selected="settings.orderBy === s.key"
                @click="settings.set('orderBy', s.key); sortOpen = false"
              >
                <span>{{ s.label }}</span>
                <I.check v-if="settings.orderBy === s.key" />
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </header>

    <!-- 列表 / 卡片流 -->
    <div class="feed-scroll" :ref="(el: any) => (vl.containerRef.value = el)" @scroll.passive="vl.onScroll">
      <!-- 骨架（冷启动） -->
      <div class="skeletons" v-if="!data.loaded" aria-busy="true">
        <div class="skel-card" v-for="n in 3" :key="n">
          <div class="skel skel-banner"></div>
          <div class="skel" style="width: 38%; height: 14px; margin: 12px 14px 8px"></div>
          <div class="skel" style="width: 92%; height: 10px; margin: 0 14px 6px"></div>
          <div class="skel" style="width: 65%; height: 10px; margin: 0 14px 14px"></div>
        </div>
      </div>

      <EmptyState
        v-else-if="emptyKind"
        :kind="emptyKind"
        :query="data.search"
        :category="data.filter.kind === 'category' ? data.filter.value : data.filter.kind === 'starred' ? '收藏' : viewTitle"
      />

      <!-- role=feed + roving tabindex（design-system §8.2/8.3）：容器持焦，aria-activedescendant 指向
           当前项；仅当前项 tabindex=0 其余 -1（Tab 路径 = 容器 → 当前项）；posinset/setsize 按数据集计（虚拟滚动） -->
      <div
        class="vl-inner"
        v-else
        :style="{ height: vl.total.value + 'px' }"
        role="feed"
        aria-labelledby="af-title"
        tabindex="0"
        :aria-activedescendant="cursorDomId"
      >
        <div
          v-for="w in window_"
          :key="w.item._id"
          class="vl-row"
          :style="{ transform: `translateY(${vl.offsetOf(w.index)}px)` }"
          :ref="(el: any) => vl.measureRow(el, w.item._id)"
        >
          <ArticleCard
            v-if="isCard"
            :item="w.item"
            :feed="data.feedMap.get(w.item.feedKey)"
            :is-cursor="w.index === ui.cursor"
            :id="'af-item-' + w.item._id"
            :aria-posinset="w.index + 1"
            :aria-setsize="items.length"
          />
          <ArticleRow
            v-else
            :item="w.item"
            :feed="data.feedMap.get(w.item.feedKey)"
            :is-cursor="w.index === ui.cursor"
            :id="'af-item-' + w.item._id"
            :aria-posinset="w.index + 1"
            :aria-setsize="items.length"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.content { position: relative; height: 100%; display: flex; flex-direction: column; background: var(--bg-panel); min-width: 0; }

.content-progress {
  position: absolute; top: 0; left: 0; right: 0; height: 2px; z-index: var(--z-progress);
  overflow: hidden; pointer-events: none;
}
.content-progress::before {
  content: ""; position: absolute; top: 0; bottom: 0; left: -30%; width: 30%;
  background: linear-gradient(90deg, transparent, var(--accent-strong), var(--accent), transparent);
  /* 动画只走 transform（PLAN-POLISH C1：left 逐帧布局 → 合成器属性；
     位移 = 容器 130% 宽 = 30% 宽条的 433.3%（translateX 百分比以自身宽为基准） */
  animation: progress-move var(--t-progress);
}
@keyframes progress-move { from { transform: translateX(0); } to { transform: translateX(433.3%); } }

.toolbar {
  height: 56px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
  padding: 0 16px; border-bottom: 1px solid var(--border); gap: 8px;
}
.tb-left, .tb-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 分离窗窄列：间距收紧 2px，给标题腾出完整显示宽度 */
.toolbar.compact { gap: 6px; }
.toolbar.compact .tb-left, .toolbar.compact .tb-right { gap: 6px; }
.tb-title { font-size: 16px; font-weight: 650; max-width: 200px; }
/* 极窄档（≤704，列表列 260–360px）标题进一步收紧给图标钮腾位；宽分离窗保留 200px 勿截断 */
@media (max-width: 704px) {
  .toolbar.compact .tb-title { max-width: 120px; }
}
.tb-progress { font-size: 12px; color: var(--text-3); }
/* spinner 走 base.css 全局 .spin（spin-360 0.9s，PLAN-POLISH A7） */

.view-switch {
  display: flex; border: 1px solid var(--border-strong); border-radius: var(--r-md); overflow: hidden;
}
.vs-btn { width: 32px; height: 28px; border-radius: 0; }
.vs-btn.on { background: var(--bg-selected); color: var(--accent-deep); }

.sort-dd { position: relative; }
.dd-btn {
  height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-md);
  background: var(--bg-panel); color: var(--text-2); font-family: inherit; font-size: 13px;
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap;
}
.dd-btn:hover { background: var(--bg-card-hover); color: var(--text-1); }
.dd-btn:active { background: var(--bg-active); }
.dd-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: var(--z-dropdown);
  min-width: 128px; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: var(--r-md); box-shadow: var(--shadow-2); padding: 4px;
}
html[data-theme="dark"] .dd-menu { background: var(--bg-elevated); }
.dd-item {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  height: 32px; padding: 0 10px; border: none; background: transparent; border-radius: var(--r-sm);
  font-family: inherit; font-size: 13px; color: var(--text-1); cursor: pointer;
}
.dd-item:hover { background: var(--bg-hover); }
.dd-item:active { background: var(--bg-active); }
.dd-item[aria-selected="true"] { color: var(--accent-deep); font-weight: 600; }

.feed-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 16px; }
.skeletons { display: flex; flex-direction: column; gap: 14px; }
.skel-card { border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; }
.skel-banner { height: 120px; border-radius: 0; }

.vl-inner { position: relative; }
.vl-row { position: absolute; left: 0; right: 0; will-change: transform; }
/* 容器持焦不画轮廓：当前位置由游标行底色（aria-activedescendant 目标）承担（§8.2 惯例） */
.vl-inner:focus { outline: none; }
</style>
