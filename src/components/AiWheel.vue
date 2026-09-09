<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { I } from "./icons";

/**
 * AI 悬浮轮盘（v1.5，PLAN-AI-WHEEL）：阅读区右下悬浮球，hover 后三项（摘要/翻译/目录）
 * 沿左上弧展开，点击直达动作；目录列表/进度等详情仍由 AiToolsPanel 呈现。
 * 纯 UI 组件——状态与回调由 ReaderPanel 透传，自有状态仅开合与监听管理。
 * 热区模型：容器 pointer-events:none 不挡正文；open 期间挂 document mousemove
 * （坐标在「球 rect 左/上扩 120px」联合矩形内保活——连续区域，球→项路径无缝）与
 * keydown 捕获（Esc；hover 展开时焦点可能在 body，容器级监听收不到）。
 * 收起态 visibility:hidden：opacity+pointer-events 不移出 Tab 序，会留键盘盲焦点（审核 B2）。
 */
const props = defineProps<{
  aiEnabled: boolean;
  summaryState: "idle" | "loading" | "done" | "error";
  hasSummary: boolean;
  translatable: boolean;
  trState: "idle" | "loading" | "done" | "error";
  tocState: "idle" | "loading" | "done";
  hasToc: boolean;
  busy: boolean;
  panelOpen: boolean;
}>();
const emit = defineEmits<{
  (e: "summary" | "translate" | "toc" | "closePanel"): void;
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const ballRef = ref<HTMLButtonElement | null>(null);

/** 几何常量（方案 §1.3）：R=92、项径 44、角度 -100/-135/-170（以球心为原点，-90°=正上，朝左上防出画） */
const R = 92;
function itemVars(deg: number, delayMs: number) {
  const rad = (deg * Math.PI) / 180;
  return {
    "--tx": Math.round(Math.cos(rad) * R) + "px",
    "--ty": Math.round(Math.sin(rad) * R) + "px",
    "--d": delayMs + "ms",
  } as Record<string, string>;
}

/** 轮盘项清单：顺序 = 展开弧从上到左（摘要/翻译/目录）；loading 外圈环、done 角标、dim 置灰 */
const items = computed(() => [
  {
    key: "summary" as const,
    icon: I.sparkle,
    label: "AI 摘要",
    vars: itemVars(-100, 0),
    loading: props.summaryState === "loading",
    done: props.hasSummary,
    dim: !props.aiEnabled,
    title: props.summaryState === "loading" ? "摘要生成中…" : props.hasSummary ? "查看摘要（滚动到顶部摘要卡）" : "AI 摘要",
  },
  {
    key: "translate" as const,
    icon: I.languages,
    label: "翻译",
    vars: itemVars(-135, 20),
    loading: props.trState === "loading",
    done: props.trState === "done",
    dim: !props.aiEnabled || !props.translatable,
    title: props.trState === "loading" ? "翻译中，点击取消" : props.trState === "done" ? "显示 / 收起译文" : "AI 段落翻译",
  },
  {
    key: "toc" as const,
    icon: I.list,
    label: "目录",
    vars: itemVars(-170, 40),
    loading: props.tocState === "loading",
    done: props.hasToc,
    dim: !props.aiEnabled,
    title: props.tocState === "loading" ? "目录生成中…" : props.hasToc ? "打开目录列表" : "生成 / 打开目录",
  },
]);

/** 联合热区矩形判定：球 rect 向左/上扩 120px（R+项半径+缓冲），鼠标球→项任何直线路径都在内 */
function inHotRect(x: number, y: number) {
  const r = ballRef.value?.getBoundingClientRect();
  if (!r) return false;
  return x >= r.left - 120 && x <= r.right + 8 && y >= r.top - 120 && y <= r.bottom + 8;
}
function onDocMove(e: MouseEvent) {
  if (!inHotRect(e.clientX, e.clientY)) closeWheel();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !open.value) return;
  e.preventDefault();
  e.stopPropagation(); // 不进全局键盘流（Esc 返回）；面板同开时两监听独立执行 = 双闭（方案 §1.2 约定）
  closeWheel();
  ballRef.value?.focus();
}

function openWheel() {
  if (open.value) return;
  open.value = true;
  document.addEventListener("mousemove", onDocMove, { passive: true });
  document.addEventListener("keydown", onDocKey, true);
}
function closeWheel() {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener("mousemove", onDocMove);
  document.removeEventListener("keydown", onDocKey, true);
}
function toggleWheel() {
  if (open.value) {
    closeWheel();
    return;
  }
  if (props.panelOpen) emit("closePanel"); // 面板开着点球：先关面板再展开（AiToolsPanel onDocDown 豁免触发钮，审核 B4）
  openWheel();
}

/** 键盘路径：焦点离开容器（球+项）即收起；方向键在三项间环形移动（menu role 配套） */
function onFocusOut(e: FocusEvent) {
  const t = e.relatedTarget as Node | null;
  if (t && (t instanceof Element && t.closest(".ai-wheel"))) return;
  closeWheel();
}
/** 键盘路径（menu-button 惯例）：球聚焦不自动展开（避免 mousedown-focus 与 click toggle 互搏），方向键/Enter/click 展开 */
function onBallKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft") {
    e.preventDefault();
    e.stopPropagation();
    if (!open.value) openWheel();
    const idx = e.key === "ArrowDown" || e.key === "ArrowLeft" ? items.value.length - 1 : 0;
    nextFrameFocus(idx);
  }
}
function onItemKeydown(e: KeyboardEvent, i: number) {
  const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  e.stopPropagation();
  nextFrameFocus((i + dir + items.value.length) % items.value.length);
}
/** 项聚焦：open class 渲染后 visibility 立即 visible（展开侧 transition 0s），nextTick（微任务）
 *  即可 focus——rAF/setTimeout 在后台/节流窗格会被冻结，焦点会滞留球上 */
function nextFrameFocus(i: number) {
  void nextTick(() => {
    rootRef.value?.querySelectorAll<HTMLButtonElement>(".ai-witem")[i]?.focus();
  });
}

onBeforeUnmount(closeWheel); // document 监听兜底卸载（切文走 resetToc→close()，此处兜底组件卸载）

defineExpose({ ballEl: ballRef, close: closeWheel });
</script>

<template>
  <div ref="rootRef" class="ai-wheel" :class="{ open }" role="menu" aria-label="AI 工具" @focusout="onFocusOut">
    <!-- 三项：常驻 DOM（class 切换保 transition），收起态聚在球心且 visibility:hidden 不可聚焦 -->
    <button
      v-for="(it, i) in items"
      :key="it.key"
      type="button"
      class="ai-witem"
      :class="{ busy: it.loading, dot: it.done, dim: it.dim }"
      :style="it.vars"
      role="menuitem"
      :aria-label="it.label"
      :title="it.title"
      :tabindex="open ? 0 : -1"
      @click="emit(it.key); closeWheel()"
      @keydown="onItemKeydown($event, i)"
    >
      <component :is="it.icon" />
    </button>

    <!-- 悬浮球：唯一常显锚点，hover/focus/click 展开 -->
    <button
      ref="ballRef"
      type="button"
      class="ai-ball"
      :aria-expanded="open"
      aria-haspopup="menu"
      aria-label="AI 工具（摘要 / 翻译 / 目录）"
      title="AI 工具（摘要 / 翻译 / 目录）"
      @mouseenter="openWheel()"
      @click="toggleWheel"
      @keydown="onBallKeydown"
    >
      <I.sparkle />
      <span v-if="busy" class="ai-dot" aria-hidden="true"></span>
    </button>
  </div>
</template>

<style scoped>
/* 容器：pointer-events:none 不挡正文，仅球与展开态项可交互；absolute 于 .reader（detached 同成立） */
.ai-wheel {
  position: absolute; right: 20px; bottom: 64px; width: 44px; height: 44px;
  z-index: var(--z-sticky); pointer-events: none;
}

.ai-ball {
  pointer-events: auto;
  width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: var(--bg-panel); color: var(--text-2);
  box-shadow: var(--shadow-1); font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; position: relative;
  opacity: 0.92;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), opacity var(--t-fast) var(--ease-out);
}
.ai-ball:hover, .ai-wheel.open .ai-ball { background: var(--bg-card-hover); color: var(--accent-deep); opacity: 1; }
.ai-ball:focus-visible, .ai-witem:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus-ring); }

/* 呼吸点（aiBusyDot 任一在飞）：绝对定位球内右上（迁自顶栏按钮，适配非 inline 流式，审核建议 6） */
.ai-dot {
  position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: var(--r-sm);
  background: var(--accent-strong); animation: ai-dot-pulse 1.1s var(--ease-out) infinite;
}
@keyframes ai-dot-pulse { 50% { opacity: 0.3; } }

/* 轮盘项：收起态聚在球心（--tx/--ty 不生效于 base transform）；visibility 必须参与——
   opacity+pointer-events 不移出 Tab 序（B2）；收起时 visibility 延迟到 transform/opacity 播完 */
.ai-witem {
  pointer-events: none; /* 收起态；展开态下方 .open 覆写 */
  position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: var(--bg-panel); color: var(--text-2);
  box-shadow: var(--shadow-1); font-size: 17px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  visibility: hidden; opacity: 0; transform: translate(-50%, -50%) scale(0.35);
  transition:
    transform var(--t-med) var(--ease-out),
    opacity var(--t-fast) var(--ease-out),
    visibility 0s linear var(--t-med);
}
.ai-wheel.open .ai-witem {
  pointer-events: auto; visibility: visible; opacity: 1;
  transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(1);
  transition:
    transform var(--t-med) var(--ease-out) var(--d, 0s),
    opacity var(--t-fast) var(--ease-out) var(--d, 0s),
    visibility 0s;
}
.ai-witem:hover { background: var(--bg-card-hover); color: var(--accent-deep); }
.ai-witem.dim { opacity: 0.45; cursor: default; }
.ai-wheel.open .ai-witem.dim { opacity: 0.45; }

/* 进行中：外圈 accent 旋转环（reduced-motion 全局 0.01ms 瞬切，同 .ai-spin 惯例） */
.ai-witem.busy::before {
  content: ""; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid transparent; border-top-color: var(--accent-strong);
  animation: ai-rot 0.9s linear infinite;
}
/* 已有产物：右上角实心点 */
.ai-witem.dot::after {
  content: ""; position: absolute; top: -2px; right: -2px; width: 6px; height: 6px;
  border-radius: 50%; background: var(--accent-strong);
}
@keyframes ai-rot { to { transform: rotate(360deg); } }
</style>
