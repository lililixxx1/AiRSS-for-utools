<script setup lang="ts">
// 推荐订阅页（v1.9，覆盖内容列，与设置页同层级 z300）：清单来自 lib/recommend.ts，
// 点「订阅」只开 addFeed 弹窗预填 URL —— 仍走发现确认（不自动入库，用户可改名/分类/全文开关）
import { computed } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import { RECOMMEND_GROUPS, RECOMMEND_ALL, isSubscribed, findSubscribedFeed, type RecommendSource } from "../lib/recommend";

const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();

const subscribedCount = computed(() => RECOMMEND_ALL.filter((s) => isSubscribed(s, data.feeds)).length);

function isDone(s: RecommendSource): boolean {
  return isSubscribed(s, data.feeds);
}

/**
 * 行点击：未订阅 → 开发现确认弹窗（补齐标题/分类/全文开关，与侧栏「+」同一条链路）；
 * 已订阅 → 回到列表并选中该源（重复订阅只会造出重复的 feed 文档，没有第二个用处）。
 */
function activate(s: RecommendSource) {
  const feed = findSubscribedFeed(s, data.feeds);
  if (feed) {
    data.filter = { kind: "feed", value: feed._id };
    ui.cursor = 0;
    ui.view = "main";
    return;
  }
  ui.modal = { type: "addFeed", presetUrl: s.url };
}

function back() {
  ui.view = "main";
}
</script>

<template>
  <section class="rec" role="region" aria-label="推荐订阅">
    <header class="rec-top">
      <button class="btn btn-ghost btn-sm" @click="back"><I.arrowLeft />返回</button>
      <h1>推荐订阅</h1>
      <span class="rec-stat num" :class="{ some: subscribedCount > 0 }">已订 {{ subscribedCount }} / {{ RECOMMEND_ALL.length }}</span>
    </header>

    <div class="rec-scroll">
      <p class="rec-intro">精选 {{ RECOMMEND_ALL.length }} 个连得上、更新勤的中文源。点「订阅」先走发现确认，可改名、选分类、决定是否抓取全文；不想要入口了，可在设置里关掉。</p>

      <div class="rec-group" v-for="g in RECOMMEND_GROUPS" :key="g.name">
        <h3>{{ g.name }}</h3>
        <button
          v-for="s in g.items"
          :key="s.url"
          class="rec-item"
          :class="{ done: isDone(s) }"
          :aria-label="(isDone(s) ? '已订阅，跳到该源：' : '订阅：') + s.title"
          @click="activate(s)"
        >
          <div class="rec-body">
            <div class="rec-line">
              <span class="rec-title ellipsis">{{ s.title }}</span>
              <span v-if="isDone(s)" class="rec-done"><I.check />已订阅</span>
            </div>
            <p class="rec-desc clamp-2">{{ s.desc }}</p>
            <span class="rec-host ellipsis">{{ s.url }}</span>
          </div>
          <span class="rec-act" :class="{ done: isDone(s) }">{{ isDone(s) ? "查看" : "订阅" }}</span>
        </button>
      </div>

      <p class="rec-foot">{{ settings.recommendEnabled ? "在「设置 · 外观」可关闭本入口。" : "提示：本入口已在设置中关闭，当前可继续浏览。" }}</p>
    </div>
  </section>
</template>

<style scoped>
/* 结构与设置页（§4.5）一致：绝对定位覆盖内容列、顶部 52px 标题栏 + 滚动区，z=--z-reader */
.rec { position: absolute; inset: 0; z-index: var(--z-reader); background: var(--bg-panel); display: flex; flex-direction: column; animation: reader-in var(--t-slow) var(--ease-out); }
@keyframes reader-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }

.rec-top { height: 52px; flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid var(--border); }
.rec-top h1 { font-size: 16px; font-weight: 650; }
.rec-stat { margin-left: auto; font-size: 12px; color: var(--text-3); }
.rec-stat.some { color: var(--accent-deep); }

.rec-scroll { flex: 1; overflow-y: auto; padding: 16px; }
.rec-intro { max-width: 620px; margin: 0 auto 12px; font-size: 12px; line-height: 1.6; color: var(--text-3); }

.rec-group {
  max-width: 620px; margin: 0 auto 12px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-1); padding: 4px 16px 8px;
}
.rec-group h3 { font-size: 13px; font-weight: 650; color: var(--text-2); padding: 12px 0 4px; }

/* 整行可点（点击即开确认弹窗）：还原成按钮语义但排版按卡片行，:active 排 :hover 之后（源序纪律） */
.rec-item {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 10px 0; border: none; border-top: 1px solid var(--border);
  background: transparent; font-family: inherit; cursor: pointer; border-radius: var(--r-md);
}
.rec-item:first-of-type { border-top: none; }
.rec-item:hover { background: var(--bg-card-hover); }
.rec-item:active { background: var(--bg-active); }
.rec-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.rec-item.done { opacity: 0.72; }

.rec-body { flex: 1; min-width: 0; }
.rec-line { display: flex; align-items: center; gap: 8px; }
.rec-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.rec-done { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font-size: 11px; font-weight: 600; color: var(--accent-deep); }
.rec-done svg { font-size: 12px; }
.rec-desc { font-size: 12px; line-height: 1.6; color: var(--text-2); margin-top: 3px; }
.rec-host { display: block; font-size: 11px; color: var(--text-3); margin-top: 3px; }
/* 行内动作只做视觉（整行已是按钮）：胶囊外形让「订阅」读得懂是动作而不是标签 */
.rec-act {
  flex-shrink: 0; pointer-events: none;
  display: inline-flex; align-items: center; justify-content: center;
  height: 26px; padding: 0 12px; border-radius: var(--r-full);
  border: 1px solid var(--border-strong); background: transparent;
  font-size: 12px; font-weight: 600; color: var(--text-2);
  transition: border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out);
}
.rec-item:hover .rec-act { border-color: var(--accent-strong); color: var(--accent-deep); background: var(--accent-soft); }
.rec-item.done .rec-act { border-style: dashed; color: var(--text-3); }
.rec-item.done:hover .rec-act { border-color: var(--accent-strong); color: var(--accent-deep); }

.rec-foot { max-width: 620px; margin: 4px auto 24px; font-size: 11px; color: var(--text-3); text-align: center; }
</style>
