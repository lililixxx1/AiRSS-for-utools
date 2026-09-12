<script setup lang="ts">
import { computed } from "vue";
import type { Item, Feed } from "../types";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import { timeAgo } from "../lib/format";
import { highlightSegments } from "../lib/highlight";

const props = defineProps<{ item: Item; feed?: Feed; isCursor?: boolean }>();
const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();

const displayTitle = computed(() => (settings.aiTitle ? props.item.titleDisplay || props.item.title : props.item.title));
const titleRewritten = computed(() => settings.aiTitle && displayTitle.value !== props.item.title);
// 高亮切段缓存（PLAN-POLISH C3：模板直调会每次重渲染重跑切词，computed 后仅依赖变化才重算）
const titleSegs = computed(() => highlightSegments(displayTitle.value, hlTerms.value));

// 手动 AI 摘要按钮（v1.2：自动摘要关闭时逐篇出现；有摘要/生成中不出现）
const showAiBtn = computed(() => settings.aiEnabled && settings.aiAutoCount === 0 && !props.item.ai?.summary && !data.aiBusy.has(props.item._id));

// 词项（小写、去空）= 搜索词 + 高亮词（搜索词在前；highlightSegments 内部去重且 3 词上限——
// 搜索词 ≥3 时高亮词不显示属预期，PLAN-V1.3 B 口径）
const hlTerms = computed(() => [
  ...data.search.trim().toLowerCase().split(/\s+/).filter(Boolean),
  ...settings.highlightWords.map((w) => w.trim().toLowerCase()).filter(Boolean),
]);

function open() {
  data.markRead(props.item, true);
  ui.openReader(props.item._id);
}
</script>

<template>
  <div
    class="row"
    :class="{ unread: !item.read, cursor: isCursor }"
    role="article"
    tabindex="0"
    @click="open"
    @keydown.enter="open"
  >
    <!-- 未读点 / 星标占位（design-system §4.2：圆点仅列表视图用） -->
    <span v-if="!item.read" class="dot"></span>
    <I.starFilled v-else-if="item.starred" class="star-pin" />
    <span v-else class="dot-pad"></span>

    <span class="title ellipsis" :title="item.title"><template v-for="(seg, si) in titleSegs" :key="si"><mark v-if="seg.hit" class="hl">{{ seg.t }}</mark><template v-else>{{ seg.t }}</template></template><span v-if="titleRewritten" class="ai-mark">AI</span></span>
    <span class="feed ellipsis">{{ feed?.title || "" }}</span>
    <span class="time num">{{ timeAgo(item.pubTs) }}</span>
    <img v-if="item.cover" class="thumb" :src="item.cover" loading="lazy" alt="" referrerpolicy="no-referrer" />

    <span class="row-acts">
      <button v-if="showAiBtn" class="icon-btn act" aria-label="AI 摘要" title="AI 摘要" @click.stop="data.summarizeItem(item)"><I.sparkle /></button>
      <button
        class="icon-btn act"
        :class="{ on: item.starred }"
        :aria-label="item.starred ? '取消收藏' : '收藏'"
        @click.stop="data.toggleStar(item)"
      >
        <I.starFilled v-if="item.starred" /><I.star v-else />
      </button>
    </span>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 12px; cursor: pointer;
  border-radius: var(--r-sm);
  transition: background var(--t-fast) var(--ease-out);
}
.row:hover { background: var(--bg-card-hover); }
.row.cursor { background: var(--bg-selected); }
.row:active { background: var(--bg-active); }
.row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }

.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-strong); flex-shrink: 0; }
.dot-pad { width: 7px; flex-shrink: 0; }
.star-pin { color: var(--accent-deep); font-size: 12px; width: 7px; display: inline-flex; justify-content: center; flex-shrink: 0; }

.title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text-1); }
.row:not(.unread) .title { font-weight: 400; color: var(--text-2); }
/* .hl 全局类在 base.css（PLAN-POLISH D2 提取） */
.ai-mark {
  display: inline-block; vertical-align: 1px; margin-left: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.5px; line-height: 14px;
  color: var(--accent-deep); border: 1px solid var(--accent-deep);
  border-radius: var(--r-sm); padding: 0 3px; opacity: 0.85;
}
.feed { width: 110px; font-size: 12px; color: var(--text-3); flex-shrink: 0; }
.time { font-size: 12px; color: var(--text-3); flex-shrink: 0; }
.thumb { width: 56px; height: 32px; object-fit: cover; border-radius: var(--r-sm); flex-shrink: 0; background: var(--bg-hover); }

.row-acts { display: none; }
.row:hover .row-acts { display: inline-flex; }
.act { width: 28px; height: 24px; font-size: 14px; color: var(--text-3); }
.act.on { color: var(--accent-deep); }
</style>
