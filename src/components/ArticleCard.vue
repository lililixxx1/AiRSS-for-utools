<script setup lang="ts">
import { computed, ref } from "vue";
import type { Item, Feed } from "../types";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import { timeAgo } from "../lib/format";
import { highlightSegments } from "../lib/highlight";

const props = defineProps<{ item: Item; feed?: Feed }>();
const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();

const readingMin = computed(() => Math.max(1, Math.round((props.item.summaryText?.length || 0) / 400) + 1));

// 词项（小写、去空）= 搜索词 + 高亮词（搜索词在前；highlightSegments 内部去重且 3 词上限——
// 搜索词 ≥3 时高亮词不显示属预期，PLAN-V1.3 B 口径）
const hlTerms = computed(() => [
  ...data.search.trim().toLowerCase().split(/\s+/).filter(Boolean),
  ...settings.highlightWords.map((w) => w.trim().toLowerCase()).filter(Boolean),
]);

// AI 改写标题（titleNorm>titleZh，设置可关）；tags 与改写标记仅在 AI 开启时展示
const displayTitle = computed(() => (settings.aiTitle ? props.item.titleDisplay || props.item.title : props.item.title));
const titleRewritten = computed(() => settings.aiTitle && displayTitle.value !== props.item.title);
// 高亮切段缓存（PLAN-POLISH C3：模板直调会每次重渲染重跑切词，computed 后仅依赖变化才重算）
const titleSegs = computed(() => highlightSegments(displayTitle.value, hlTerms.value));
const aiTags = computed(() => (settings.aiEnabled ? props.item.ai?.tags?.slice(0, 2) || [] : []));
// 手动 AI 摘要按钮（v1.2：自动摘要关闭时逐篇出现；有摘要/生成中不出现）
const showAiBtn = computed(() => settings.aiEnabled && settings.aiAutoCount === 0 && !props.item.ai?.summary && !data.aiBusy.has(props.item._id));

// 封面门控：抓到的首图常是头像/小图标/窄长截图，拉伸成 148px 通栏极难看；
// 加载后按自然尺寸裁决，不合格整块不渲染（卡片回退为纯文字形态）
const bannerOk = ref(true);
function onBannerLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  if (img.naturalWidth < 480 || img.naturalHeight < 100 || img.naturalHeight > img.naturalWidth * 2) {
    bannerOk.value = false;
  }
}

function open() {
  data.markRead(props.item, true);
  ui.openReader(props.item._id);
}

function share() {
  if (!props.item.link) return;
  utools.copyText(props.item.link);
  ui.toast("已复制链接");
}
</script>

<template>
  <article class="card" :class="{ unread: !item.read }" role="article" tabindex="0" @click="open" @keydown.enter="open">
    <img v-if="item.cover && bannerOk" class="banner" :src="item.cover" loading="lazy" alt="" referrerpolicy="no-referrer" @load="onBannerLoad" @error="bannerOk = false" />
    <div class="card-body">
      <div class="tag-row">
        <span class="tag">{{ feed?.category || "默认" }}</span>
        <span v-for="t in aiTags" :key="t" class="tag ai-tag">{{ t }}</span>
      </div>
      <h2 class="title clamp-2" :title="item.title">
        <template v-for="(seg, si) in titleSegs" :key="si"><mark v-if="seg.hit" class="hl">{{ seg.t }}</mark><template v-else>{{ seg.t }}</template></template><span v-if="titleRewritten" class="ai-mark">AI</span>
      </h2>
      <p class="summary clamp-2" v-if="item.summaryText">{{ item.summaryText }}</p>
      <div class="meta">
        <span class="meta-item">{{ timeAgo(item.pubTs) }}</span>
        <span class="meta-dot">·</span>
        <span class="meta-item min"><I.clock />{{ readingMin }} 分钟</span>
        <span class="flex1"></span>
        <button v-if="showAiBtn" class="icon-btn meta-act" aria-label="AI 摘要" title="AI 摘要" @click.stop="data.summarizeItem(item)"><I.sparkle /></button>
        <button
          class="icon-btn meta-act"
          :class="{ on: item.starred }"
          :aria-label="item.starred ? '取消收藏' : '收藏'"
          @click.stop="data.toggleStar(item)"
        >
          <I.bookmarkFilled v-if="item.starred" /><I.bookmark v-else />
        </button>
        <button class="icon-btn meta-act" aria-label="复制链接" @click.stop="share"><I.share /></button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.card {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-1); cursor: pointer; overflow: hidden;
  transition: background var(--t-fast) var(--ease-out);
}
.card:hover { background: var(--bg-card-hover); }
.card:active { background: var(--bg-active); }
.card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

.banner { display: block; width: 100%; height: 148px; object-fit: cover; background: var(--bg-hover); }

.card-body { padding: 12px 14px 14px; }

.tag-row { display: flex; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.tag { font-size: 11px; font-weight: 600; color: var(--text-3); }
.ai-tag { color: var(--accent-deep); }
.ai-mark {
  display: inline-block; vertical-align: 2px; margin-left: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.5px; line-height: 14px;
  color: var(--accent-deep); border: 1px solid var(--accent-deep);
  border-radius: var(--r-sm); padding: 0 3px; opacity: 0.85;
}

.title { font-size: 16px; font-weight: 600; line-height: 1.4; color: var(--text-1); }
.card:not(.unread) .title { color: var(--text-read); font-weight: 550; }
/* .hl 全局类在 base.css（PLAN-POLISH D2 提取） */

.summary { font-size: 14px; line-height: 1.6; margin-top: 6px; color: var(--text-2); }
.card:not(.unread) .summary { color: var(--text-3); }

.meta { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.meta-item { font-size: 12px; color: var(--text-3); display: inline-flex; align-items: center; gap: 4px; }
.meta-item.min svg { font-size: 13px; }
.meta-dot { color: var(--text-3); font-size: 11px; }
.flex1 { flex: 1; }
.meta-act { width: 28px; height: 24px; font-size: 14px; color: var(--text-3); }
.meta-act:hover { color: var(--text-1); }
.meta-act.on { color: var(--accent-deep); }
</style>
