<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { findMatches, normalizeFindText, type FindMatch } from "../lib/find";
import { I } from "./icons";

/** 文内搜索浮层（PLAN-READER-FIND；2026-09-12 悬浮化改版）：锚 .reader-body 右上（顶栏之下）的
 *  absolute 浮层卡——不占 flex 行高，正文滚动区尺寸恒定（用户裁决，推翻 v2 的 flex 子项方案 B2）。
 *  遮挡风险由跳转补偿消化：目标块顶对齐「面板底沿 + 8」（与正文列横向相交才补偿，见 jump）。
 *  常驻挂载 + v-show：开关走 watch（已开再 Ctrl+F 重聚焦全选、关再开保留本篇 query）。 */
const props = defineProps<{
  open: boolean;
  root: HTMLElement | null;
  htmlKey: string; // html.value：v-html 换 innerHTML 的重算信号
  seed: string; // 列表搜索词：面板打开时空 query 直接复用（轨内面板/宿主子输入框的词，S10①）
  focusAt: number; // 重聚焦令牌（PLAN-WHEEL-FIND §2.5）：入口每次触发自增——已开态同值赋 open 不触发 watch，靠它驱动重聚焦+全选
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const query = ref("");
const matches = ref<FindMatch[]>([]);
const total = ref(0);
const truncated = ref(false);
const cur = ref(0);

// flash 生命周期（审核 B3）：类与定时器成对管理——单句柄只 clear 不移类 = 永久残留高亮
let flashEl: HTMLElement | null = null;
let flashTimer = 0;
let debounceTimer = 0;

function clearFlash() {
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = 0;
  }
  if (flashEl) {
    flashEl.classList.remove("find-flash");
    flashEl = null;
  }
}

function recompute() {
  const r = findMatches(props.root, query.value);
  matches.value = r.matches;
  total.value = r.total;
  truncated.value = r.truncated;
  if (cur.value >= r.matches.length) cur.value = 0;
}

/** 跳转：目标块顶对齐「面板底沿 + 8」——悬浮卡盖住滚动区顶且与正文列横向相交时补偿遮挡
 *  （宽列正文列与右侧面板不相交则退化为经典顶对齐）。rect 差算 y 免 offsetParent 歧义
 *  （同 markCurrentSection）。prefers-reduced-motion 每次调用时读——系统设置可运行中变化（同 jumpTo 口径，S9）。 */
function jump(i: number) {
  const m = matches.value[i];
  if (!m) return;
  cur.value = i;
  clearFlash();
  const sc = props.root?.closest<HTMLElement>(".reader-scroll");
  if (sc) {
    const scRect = sc.getBoundingClientRect();
    const top = m.el.getBoundingClientRect().top - scRect.top + sc.scrollTop;
    let offset = 0;
    const pRect = panelEl.value?.getBoundingClientRect();
    const col = props.root?.getBoundingClientRect(); // props.root 即正文列 .ra-content
    if (pRect && col && pRect.bottom > scRect.top && pRect.left < col.right && pRect.right > col.left) {
      offset = pRect.bottom - scRect.top + 8;
    }
    sc.scrollTo({
      top: Math.max(0, top - offset),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }
  flashEl = m.el;
  m.el.classList.add("find-flash");
  flashTimer = window.setTimeout(clearFlash, 1200);
  // 当前行跟随：block:"nearest" 只滚列表面板容器（面板在 reader-scroll 之外不带动正文，S8①）
  nextTick(() => {
    listEl.value?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });
}

function step(dir: 1 | -1) {
  if (!matches.value.length) return;
  jump((cur.value + dir + matches.value.length) % matches.value.length);
}

function onRowClick(i: number) {
  jump(i);
  inputEl.value?.focus(); // 焦点交还输入框：点行后 j/k 不误切文（浏览器 Ctrl+F 同款，S8②）
}

function close() {
  clearFlash();
  emit("close");
}

/** 输入框 ⌫：空时关面板，非空是编辑键（2026-09-12 Esc 全线换 ⌫，勿用 .prevent 修饰符——无条件生效会拦掉编辑态；
 *  焦点不在输入框时走全局 backLadder 关闭，既有路径不变） */
function onInputKey(e: KeyboardEvent) {
  if (e.key !== "Backspace" || query.value !== "") return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

// query 路（审核 B4）：防抖重算 + 回第一处（浏览器 Ctrl+F 同款即时反馈）
watch(query, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!props.open) return;
  if (!normalizeFindText(q)) {
    recompute();
    return;
  }
  debounceTimer = window.setTimeout(() => {
    recompute();
    if (matches.value.length) jump(0);
  }, 150);
});

// htmlKey 路（审核 B4）：换文/全文提取替换——重算 + cur 钳制、绝不滚动（提取落地时用户可能正读在别处，
// 自动跳回第一处会把阅读位置记忆一并改写）。旧 matches.el 已随 innerHTML 失效：重算先行，此后才允许 jump/flash。
// flush:"post" 显式化「v-html patch 先完成」（PERF-2 纪律：html.value 赋值与 DOM patch 之间不得枚举）。
watch(
  () => props.htmlKey,
  () => {
    clearFlash();
    if (!props.open) {
      query.value = "";
      matches.value = [];
      total.value = 0;
      truncated.value = false;
      cur.value = 0;
      return;
    }
    recompute();
  },
  { flush: "post" }
);

/** 聚焦输入框并全选（nextTick：v-show 关→开的 patch 前元素不可聚焦，rAF 在节流窗格会被冻结） */
function focusInput() {
  nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
}

// 开关路：开 = 种子带入（空 query 才用）+ 聚焦全选（首开时入口同步自增 focusAt 会再触发一次下方
// watcher，幂等无害）；关 = 清 flash 与防抖
watch(
  () => props.open,
  (open) => {
    if (open) {
      if (!query.value && normalizeFindText(props.seed)) query.value = props.seed; // query watcher 接力防抖搜索
      focusInput();
    } else {
      clearFlash();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = 0;
      }
    }
  }
);

// 重聚焦路（PLAN-WHEEL-FIND §2.5）：已开态再点轮盘搜索项/再 Ctrl+F——open 同值赋值不触发上面的
// watch，入口自增 focusAt 走这里重聚焦+全选（浏览器 Ctrl+F 同款「面板已开再按 = 抢回焦点」）
watch(
  () => props.focusAt,
  () => {
    if (props.open) focusInput();
  }
);

onBeforeUnmount(() => {
  clearFlash();
  if (debounceTimer) clearTimeout(debounceTimer);
});

const hasQuery = computed(() => !!normalizeFindText(query.value));
const countText = computed(() => {
  if (!hasQuery.value) return "";
  if (!total.value) return "0 处";
  const n = truncated.value ? `${matches.value.length}+` : `${total.value}`;
  return matches.value.length ? `${n} 处 · 当前 ${cur.value + 1}` : `${n} 处`;
});
</script>

<template>
  <div class="reader-find" ref="panelEl" v-show="open" role="search" aria-label="文内搜索">
    <div class="rf-bar">
      <span class="rf-ico"><I.search /></span>
      <input
        ref="inputEl"
        class="rf-input"
        type="text"
        placeholder="搜索正文…"
        v-model="query"
        @keydown.enter.prevent="step($event.shiftKey ? -1 : 1)"
        @keydown="onInputKey"
        aria-label="搜索正文"
      />
      <span class="rf-count num" v-if="countText">{{ countText }}</span>
      <button class="icon-btn rf-nav" aria-label="上一处" :disabled="!matches.length" @click="step(-1)"><span class="rf-flip"><I.chevronDown /></span></button>
      <button class="icon-btn rf-nav" aria-label="下一处" :disabled="!matches.length" @click="step(1)"><I.chevronDown /></button>
      <button class="icon-btn" aria-label="关闭搜索" title="关闭" @click="close()"><I.close /></button>
    </div>
    <div class="rf-list" ref="listEl" v-if="matches.length || hasQuery">
      <button
        v-for="(m, i) in matches"
        :key="i"
        class="rf-row"
        :class="{ on: i === cur }"
        :data-i="i"
        :aria-label="`第 ${i + 1} 处`"
        @click="onRowClick(i)"
      >
        <span class="rf-ctx"><span>{{ m.pre }}</span><mark class="hl">{{ m.hit }}</mark><span>{{ m.post }}</span></span>
      </button>
      <div class="rf-empty" v-if="hasQuery && !matches.length">正文内无命中</div>
      <div class="rf-more" v-if="truncated">命中过多，仅显示前 {{ matches.length }} 处</div>
    </div>
  </div>
</template>

<style scoped>
/* 悬浮卡（2026-09-12 用户裁决：不再 flex 插行挤占正文——absolute 浮层，正文滚动区尺寸恒定）。
   锚 .reader-body（position:relative 定高容器）：top 60 = reader-top h56 + 4，不盖顶栏按钮 */
.reader-find {
  position: absolute;
  top: 60px;
  right: 12px;
  z-index: var(--z-reader); /* 300：盖正文与右下轮盘(200)，低于 dropdown(400)/scrim/modal */
  width: calc(100% - 24px);
  max-width: 420px;
  /* 高度上限必须挂在本元素（2026-09-12 教训，AGENTS ⑦）：calc 百分比参照锚容器 .reader-body
     （flex:1+min-height:0 定高链）可解析；列表上限另用纯定值双保险——max-* 里 min(…, 百分比)
     的百分比分支有 Chromium 不生效怪癖（max-width 同款实锤），一律不叠 min() */
  max-height: calc(100% - 72px);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-3);
  background: var(--bg-panel);
}
html[data-theme="dark"] .reader-find { background: var(--bg-elevated); }

.rf-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; } /* 窄阅读列（280px）输入框与按钮组自动换行 */
.rf-ico { color: var(--text-3); display: flex; font-size: 14px; }
.rf-input {
  flex: 1 1 160px; min-width: 0; height: 30px;
  border: 1px solid var(--border-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-1); font-family: inherit; font-size: 13px;
  padding: 0 8px; outline: none;
}
.rf-input:focus { border-color: transparent; box-shadow: 0 0 0 2px var(--focus-ring); }
.rf-count { font-size: 12px; color: var(--text-3); white-space: nowrap; }
.rf-nav { width: 26px; height: 26px; }
.rf-flip { display: flex; transform: rotate(180deg); } /* chevronUp 不在图标集，旋转复用 */

.rf-list { flex: 1; min-height: 0; max-height: 288px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.rf-row {
  display: flex; align-items: center;
  min-height: 30px; padding: 2px 8px; border: none; border-radius: var(--r-sm);
  background: transparent; font-family: inherit; font-size: 12.5px; color: var(--text-1);
  cursor: pointer; text-align: left;
}
.rf-row:hover { background: var(--bg-hover); }
.rf-row.on { background: var(--bg-selected); }
.rf-ctx { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 命中词高亮：C18 mark.hl 同族语汇（列表搜索高亮一致） */
.hl { background: var(--accent-soft); color: var(--accent-deep); border-radius: 2px; padding: 0 1px; }
.rf-empty,
.rf-more { font-size: 12px; color: var(--text-3); padding: 4px 8px; }
</style>
