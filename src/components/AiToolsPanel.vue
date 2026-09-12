<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { I } from "./icons";

/**
 * AI 工具面板（v1.4，PLAN-AI-TOC · C17）：悬浮轮盘目录项的浮层面板，收纳目录/摘要/翻译三区。
 * 纯展示组件——状态与回调全部由 ReaderPanel 透传，自有状态仅定位。
 * Teleport 到 body + fixed（同 DropdownSelect 模式：原生弹层在 uTools 无边框窗内定位错位；
 * 面板不随 reader 卸载，切文/全文替换由调用方 resetToc 强关）。
 * 触发钮是右下悬浮球（v1.5 轮盘）→ place() 向上翻转；上方空间足的未来触发点仍走向下分支。
 */
const props = defineProps<{
  open: boolean;
  triggerEl: HTMLElement | null;
  aiEnabled: boolean;
  tocEntries: { title: string; idx: number; head: string; level?: 1 | 2 | 3; kind: "html" | "ai" }[];
  tocFromHtml: boolean;
  tocAiEligible: boolean;
  tocCoverPercent: number;
  tocState: "idle" | "loading" | "done";
  tocCurrentIdx: number;
  aiState: "idle" | "loading" | "done" | "error";
  hasSummary: boolean;
  showSummaryBtn: boolean;
  translatable: boolean;
  trState: "idle" | "loading" | "done" | "error";
  trProgress: { done: number; total: number };
  trShown: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "generateToc"): void;
  (e: "jump", idx: number, head: string): void;
  (e: "runEnrich", bypass: boolean): void;
  (e: "transBtn"): void;
}>();

const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

const PANEL_W = 300;

/** 右对齐触发钮展开，视口内钳制；下方空间不足（悬浮球在视口底部）向上翻转，高度受限于上方空间 */
function place() {
  const el = props.triggerEl;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - PANEL_W), Math.max(8, window.innerWidth - PANEL_W - 8));
  const below = window.innerHeight - r.bottom - 12;
  if (below >= 200) {
    panelStyle.value = {
      left: left + "px",
      top: r.bottom + 6 + "px",
      width: PANEL_W + "px",
      maxHeight: Math.max(180, Math.min(440, below)) + "px",
    };
  } else {
    // 向上翻转：面板底边贴触发钮顶 6px（panelStyle 每次全量替换，无 top 残留）
    panelStyle.value = {
      left: left + "px",
      bottom: window.innerHeight - r.top + 6 + "px",
      width: PANEL_W + "px",
      maxHeight: Math.max(180, Math.min(440, r.top - 12)) + "px",
    };
  }
}

function onDocDown(e: MouseEvent) {
  const t = e.target as Node;
  if (panelRef.value?.contains(t) || props.triggerEl?.contains(t)) return;
  emit("close");
}
function onWinScroll(e: Event) {
  // 只对「面板外」滚动关闭（fixed 面板不随正文滚动移动）；面板自身列表滚动（长目录滚轮）不关——
  // scroll 不冒泡但 window 捕获监听收得到任何元素的滚动，不判 target 长目录一滚即被关（2026-09 实测）
  if (e.target instanceof Node && panelRef.value?.contains(e.target)) return;
  emit("close");
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Backspace" || !props.open) return;
  const t = e.target as HTMLElement;
  // 输入态守卫：面板开着 Ctrl+F 开文内搜索（无 mousedown 面板不关）时焦点落在搜索框——⌫ 是编辑键，不连带关面板
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
  e.preventDefault();
  e.stopPropagation(); // 已处理的键不进全局键盘流（⌫ 逐级返回）
  emit("close");
}
watch(
  () => props.open,
  (v) => {
    if (v) nextTick(place);
    if (v) {
      document.addEventListener("mousedown", onDocDown, true);
      window.addEventListener("scroll", onWinScroll, true);
      window.addEventListener("resize", onWinScroll);
      document.addEventListener("keydown", onKeydown, true);
    } else {
      document.removeEventListener("mousedown", onDocDown, true);
      window.removeEventListener("scroll", onWinScroll, true);
      window.removeEventListener("resize", onWinScroll);
      document.removeEventListener("keydown", onKeydown, true);
    }
  }
);
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocDown, true);
  window.removeEventListener("scroll", onWinScroll, true);
  window.removeEventListener("resize", onWinScroll);
  document.removeEventListener("keydown", onKeydown, true);
});

/** 摘要区动作：手动模式出按钮；已有摘要出重新生成；自动模式交给打开时的 enrich */
const summaryAction = computed(() => {
  if (props.aiState === "loading") return "loading" as const;
  if (props.showSummaryBtn) return "run" as const;
  if (props.aiState === "error") return "retry" as const;
  if (props.hasSummary) return "regen" as const;
  return "auto" as const;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="panelRef" class="ai-panel" :style="panelStyle" role="dialog" aria-label="AI 工具">
      <!-- 目录：有结构前端秒出；无结构长文 AI 生成（手动）；短文静态文案 -->
      <section class="ai-sec" aria-label="目录">
        <h3 class="ai-sec-t">目录</h3>
        <template v-if="tocEntries.length">
          <div class="ai-toc-list">
            <button
              v-for="s in tocEntries"
              :key="s.kind + ':' + s.idx"
              type="button"
              class="ai-toc-item"
              :class="['lv' + (s.level ?? 1), { cur: s.idx === tocCurrentIdx }]"
              :title="s.title"
              @click="emit('jump', s.idx, s.head)"
            >
              {{ s.title }}
            </button>
          </div>
          <p v-if="!tocFromHtml && tocCoverPercent < 100" class="ai-note">仅覆盖前 {{ tocCoverPercent }}%（长文输入截断）</p>
        </template>
        <p v-else-if="tocState === 'loading'" class="ai-note"><I.sparkle class="ai-spin" />目录生成中…</p>
        <template v-else-if="tocAiEligible">
          <button v-if="aiEnabled" type="button" class="ai-act" @click="emit('generateToc')"><I.sparkle />AI 生成目录</button>
          <p v-else class="ai-note">开启 AI 增强后可生成目录（设置 → AI）</p>
        </template>
        <p v-else class="ai-note">文章较短，无目录</p>
      </section>

      <!-- 摘要：动作与状态在此，流式文本仍在正文摘要卡（视觉主角不搬） -->
      <section class="ai-sec" aria-label="摘要">
        <h3 class="ai-sec-t">摘要</h3>
        <p v-if="!aiEnabled" class="ai-note">未开启 AI 增强（设置 → AI）</p>
        <template v-else>
          <p v-if="summaryAction === 'loading'" class="ai-note"><I.sparkle class="ai-spin" />摘要生成中…</p>
          <button v-else-if="summaryAction === 'run'" type="button" class="ai-act" @click="emit('runEnrich', false)"><I.sparkle />AI 摘要</button>
          <button v-else-if="summaryAction === 'retry'" type="button" class="ai-act" @click="emit('runEnrich', true)"><I.sparkle />重试摘要</button>
          <button v-else-if="summaryAction === 'regen'" type="button" class="ai-act" @click="emit('runEnrich', true)"><I.sparkle />重新生成</button>
          <p v-else class="ai-note">自动摘要进行中</p>
        </template>
      </section>

      <!-- 翻译：原顶栏按钮四态完整迁入（收起/显示/进度/重试） -->
      <section v-if="translatable" class="ai-sec" aria-label="翻译">
        <h3 class="ai-sec-t">翻译</h3>
        <button
          type="button"
          class="ai-act"
          :disabled="trState === 'loading'"
          :title="trState === 'error' ? '上次翻译失败，点击重试' : 'AI 段落翻译'"
          @click="emit('transBtn')"
        >
          <I.languages />
          <span v-if="trState === 'loading'" class="num">翻译中 {{ trProgress.done }}/{{ trProgress.total }}</span>
          <span v-else-if="trState === 'done'">{{ trShown ? "收起译文" : "显示译文" }}</span>
          <span v-else-if="trState === 'error'">重试翻译</span>
          <span v-else>翻译</span>
        </button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 视觉与 DropdownSelect 面板同族（C17）：bg-panel/border/shadow-2，暗色升一档底 */
.ai-panel {
  position: fixed; z-index: var(--z-toast); /* 可能出现在弹层（z-modal 600）内，必须高于弹层 */
  overflow-y: auto; overscroll-behavior: contain; /* 滚到底不再穿透正文（穿透会滚正文触发关闭） */
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); padding: 4px;
}
html[data-theme="dark"] .ai-panel { background: var(--bg-elevated); }
.ai-sec { padding: 8px 10px; }
.ai-sec + .ai-sec { border-top: 1px solid var(--border); }
.ai-sec-t { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--text-3); letter-spacing: 0.06em; }
.ai-toc-list { display: flex; flex-direction: column; gap: 2px; }
.ai-toc-item {
  display: block; width: 100%; border: none; background: transparent; border-radius: var(--r-sm);
  font-family: inherit; font-size: 12.5px; color: var(--text-1); text-align: left; cursor: pointer;
  padding: 5px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 分级缩进（PLAN-TOC-LEVEL）：lv 规则必须在基础 .ai-toc-item 之后、.cur 之前——
   前者同为 0-1-0 靠源序覆盖 base 档，后者同为 0-2-0 靠源序保证 cur 高亮覆盖 lv 档 */
.ai-toc-item.lv1 { font-weight: 600; }
.ai-toc-item.lv1:not(:first-child) { margin-top: 5px; } /* 章级组间分隔 */
.ai-toc-item.lv2 { padding-left: 22px; font-size: 12px; font-weight: 400; color: var(--text-2); }
.ai-toc-item.lv3 { padding-left: 36px; color: var(--text-3); }
.ai-toc-item:hover { background: var(--bg-hover); }
.ai-toc-item.cur {
  color: var(--accent-deep); font-weight: 600;
  background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent-strong); /* C16 语言：accent-soft 底 + 左缘 accent-strong */
}
.ai-note { margin: 2px 0; font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 6px; }
.ai-act {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px;
  border: none; background: transparent; border-radius: var(--r-sm);
  font-family: inherit; font-size: 12.5px; color: var(--text-1); cursor: pointer; text-align: left;
}
.ai-act:hover:not(:disabled) { background: var(--bg-hover); }
.ai-act:disabled { color: var(--text-disabled); cursor: default; }
.num { font-variant-numeric: tabular-nums; }
.ai-spin { animation: ai-rot 1s linear infinite; }
@keyframes ai-rot { to { transform: rotate(360deg); } }
</style>
