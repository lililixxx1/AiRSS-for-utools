<script setup lang="ts">
import { useDataStore } from "../stores/data";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";

const props = defineProps<{ kind: "first-run" | "no-result" | "category-empty" | "all-read" | "muted-empty"; query?: string; category?: string }>();
const data = useDataStore();
const ui = useUiStore();

const RECOMMENDED = [
  { title: "橘鸦AI早报", url: "https://daily.juya.uk/rss.xml" },
  { title: "阮一峰的网络日志", url: "https://www.ruanyifeng.com/blog/atom.xml" },
  { title: "少数派", url: "https://sspai.com/feed" },
]; // 少数派等摘要型源无需手工预设 fullText：发现管线 summaryOnly 启发式会在确认步自动预开

/** 首用引导输入框的值（handler 内直取——computed DOM 查询无响应依赖，会在 setup 期读到 null 并永久缓存） */
function readUrlInput(): string {
  return (document.getElementById("empty-url-input") as HTMLInputElement | null)?.value ?? "";
}

async function addRecommended(r: { url: string }) {
  ui.modal = { type: "addFeed", presetUrl: r.url };
}
</script>

<template>
  <div class="empty">
    <!-- 首用引导 -->
    <template v-if="kind === 'first-run'">
      <div class="hero-circle"><I.rss /></div>
      <h3 class="empty-title">从第一个订阅源开始</h3>
      <p class="empty-sub">粘贴一个站点地址，AiRSS 会自动发现它的 Feed</p>
      <div class="url-row">
        <input id="empty-url-input" class="input" placeholder="example.com 或 https://example.com/feed" @keydown.enter="ui.modal = { type: 'addFeed', presetUrl: readUrlInput() }" />
        <button class="btn btn-primary" @click="ui.modal = { type: 'addFeed', presetUrl: readUrlInput() }"><I.plus />添加</button>
      </div>
      <p class="or">或从这些源开始</p>
      <div class="chips">
        <button v-for="r in RECOMMENDED" :key="r.url" class="chip" @click="addRecommended(r)">{{ r.title }}</button>
      </div>
    </template>

    <!-- 搜索无结果 -->
    <template v-else-if="kind === 'no-result'">
      <div class="hero-circle small"><I.search /></div>
      <h3 class="empty-title">没有匹配「{{ query }}」的文章</h3>
      <p class="empty-sub">换个关键词，或清空搜索查看全部</p>
      <button class="btn btn-ghost" @click="data.setSearch('')">清空搜索</button>
    </template>

    <!-- 视图无文章（分类/标签/收藏兜底；tag 视图同走此分支，文案保持中性不称"分类"） -->
    <template v-else-if="kind === 'category-empty'">
      <div class="hero-circle small"><I.folder /></div>
      <h3 class="empty-title">{{ category }}还没有文章</h3>
      <p class="empty-sub">切换到全部，或检查订阅源是否正常同步</p>
      <button class="btn btn-ghost" @click="data.filter = { kind: 'all' }">查看全部文章</button>
    </template>

    <!-- 当前列表全被静音（PLAN-V1.3 B：不让空态谎称"全部读完"）-->
    <template v-else-if="kind === 'muted-empty'">
      <div class="hero-circle small"><I.volumeX /></div>
      <h3 class="empty-title">当前视图的文章都被静音了</h3>
      <p class="empty-sub">有 {{ data.mutedInView }} 篇被静音词隐藏</p>
      <button class="btn btn-ghost" @click="data.mutePaused = true">暂停静音，查看全部</button>
    </template>

    <!-- 全部读完 -->
    <template v-else>
      <div class="hero-circle done"><I.check /></div>
      <h3 class="empty-title">全部读完了</h3>
      <p class="empty-sub">{{ data.stats.total }} 篇已读清零，去散散步吧</p>
      <button class="btn btn-ghost" v-if="data.stats.starred" @click="data.filter = { kind: 'starred' }">查看收藏（{{ data.stats.starred }}）</button>
    </template>
  </div>
</template>

<style scoped>
.empty {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px;
  padding: 24px; text-align: center;
}
.hero-circle {
  width: 72px; height: 72px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent-deep);
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; margin-bottom: 10px;
}
.hero-circle.small { width: 56px; height: 56px; font-size: 22px; }
.hero-circle.done { position: relative; }
.empty-title { font-size: 18px; font-weight: 650; color: var(--text-1); }
.empty-sub { font-size: 13px; color: var(--text-2); margin-bottom: 10px; }
.url-row { display: flex; gap: 8px; width: min(400px, 90%); margin-bottom: 8px; }
.or { font-size: 12px; color: var(--text-3); margin-top: 8px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.chip {
  height: 28px; padding: 0 12px; border-radius: var(--r-full);
  border: 1px solid var(--border-strong); background: transparent;
  font-family: inherit; font-size: 13px; color: var(--text-2); cursor: pointer;
  transition: background-color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
}
.chip:hover { background: var(--bg-selected); color: var(--accent-deep); border-color: transparent; }
.chip:active { background: var(--bg-active); }
</style>
