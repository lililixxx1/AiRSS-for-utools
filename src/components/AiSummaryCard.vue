<script setup lang="ts">
/**
 * AiSummaryCard — AI 摘要卡（阅读面板唯一视觉主角，design-system §6）
 *
 * 三态：loading（流式渐显 + 呼吸点）/ done（摘要 + tags + 重新生成）/ error（错误 + 重试）。
 * AIGC 标识（T-13）：恒显「AI 生成」徽章；正文发送行为在设置页有隐私说明。
 */
import { computed } from "vue";
import { I } from "./icons";

const props = defineProps<{
  state: "loading" | "done" | "error";
  text: string;
  tags: string[];
  error?: string;
}>();

const emit = defineEmits<{ regenerate: []; tag: [t: string] }>();

const shownTags = computed(() => props.tags.slice(0, 2));
</script>

<template>
  <section class="ai-card" :class="state" role="complementary" aria-label="AI 摘要">
    <header class="ai-head">
      <I.sparkle class="ai-ico" />
      <span class="ai-title">AI 摘要</span>
      <span class="badge badge-muted ai-badge">AI 生成</span>
      <span class="flex1"></span>
      <button v-if="state === 'done'" class="btn btn-ghost btn-sm" @click="emit('regenerate')">
        <I.refresh />重新生成
      </button>
    </header>

    <p class="ai-text" :class="{ streaming: state === 'loading' }">
      <template v-if="text">{{ text }}</template>
      <template v-else-if="state === 'loading'">正在生成…</template>
      <template v-else-if="state === 'error'">这篇的摘要没能生成。</template>
    </p>

    <div v-if="shownTags.length && state !== 'error'" class="ai-tags">
      <!-- 可点标签（PLAN-V1.3 C）：点击即按该标签过滤列表 -->
      <button v-for="t in shownTags" :key="t" class="ai-tag ai-tag-btn" :title="'按标签「' + t + '」过滤'" @click="emit('tag', t)">{{ t }}</button>
    </div>

    <div v-if="state === 'error'" class="ai-err">
      <span class="ai-err-msg">{{ error || "生成失败" }}</span>
      <button class="btn btn-ghost btn-sm" @click="emit('regenerate')"><I.refresh />重试</button>
    </div>
  </section>
</template>

<style scoped>
/* 克制的橙：软底 + 细边 + 一条 accent 左缘（与 blockquote 同族），不做大面积色块 */
.ai-card {
  position: relative;
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent-strong);
  border-radius: var(--r-md);
  padding: 12px 14px;
  margin: 0 0 20px;
}
html[data-theme="dark"] .ai-card { background: var(--bg-elevated); }

.ai-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ai-ico { font-size: 15px; color: var(--accent-deep); flex-shrink: 0; }
.ai-title { font-size: 12.5px; font-weight: 650; color: var(--text-1); }
.ai-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--r-full); }
.flex1 { flex: 1; }

.ai-text { font-size: 14px; line-height: 1.7; color: var(--text-1); margin: 0; user-select: text; }
.ai-text.streaming::after {
  content: "▍";
  color: var(--accent-deep);
  animation: ai-caret 1s steps(1) infinite;
}
@keyframes ai-caret { 50% { opacity: 0; } }

.ai-tags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.ai-tag {
  font-size: 11px; font-weight: 600; color: var(--accent-deep);
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: var(--r-full); padding: 1px 8px;
}
html[data-theme="dark"] .ai-tag { background: var(--bg-panel); }
.ai-tag-btn { font-family: inherit; cursor: pointer; }
.ai-tag-btn:hover { border-color: var(--accent-strong); color: var(--accent-deep); background: var(--bg-hover); }

.ai-err { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ai-err-msg { font-size: 12px; color: var(--text-3); }
</style>
