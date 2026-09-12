<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { I } from "./icons";

/**
 * AI 悬浮轮盘（v1.5，PLAN-AI-WHEEL）：阅读区右下悬浮球，hover 后四项（摘要/翻译/目录/文内搜索）
 * 沿左上弧展开，点击直达动作；目录列表/进度等详情仍由 AiToolsPanel 呈现。
 * 纯 UI 组件——状态与回调由 ReaderPanel 透传，自有状态仅开合与监听管理。
 * 热区模型：容器 pointer-events:none 不挡正文；open 期间挂 document mousemove
 * （坐标在「球 rect 左/上扩 140px」联合矩形内保活——连续区域，球→项路径无缝）与
 * keydown 捕获（⌫ 收起，输入态豁免；hover 展开时焦点可能在 body，容器级监听收不到）。
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
  (e: "summary" | "translate" | "toc" | "find" | "closePanel"): void;
}>();

const open = ref(false);
const pinned = ref(false); // 点击展开=锁定：移出热区不收，再点球/⌫/点功能项/切文才收（2026-09-09 用户改定；hover 预览仍移开即收）
const rootRef = ref<HTMLElement | null>(null);
const ballRef = ref<HTMLButtonElement | null>(null);

/** 几何常量（PLAN-WHEEL-FIND §1.2）：R=110、项径 44、角度 -90/-120/-150/-180（以球心为原点，-90°=正上，
 *  朝左上防出画）——四项 30° 等距四分之一弧，相邻弦长 2·110·sin15°≈57px 无重叠 */
const R = 110;
function itemVars(deg: number, delayMs: number) {  const rad = (deg * Math.PI) / 180;
  return {
    "--tx": Math.round(Math.cos(rad) * R) + "px",
    "--ty": Math.round(Math.sin(rad) * R) + "px",
    "--d": delayMs + "ms",
  } as Record<string, string>;
}

/** 轮盘项清单：顺序 = 展开弧从上到左（摘要/翻译/目录/文内搜索）；loading 外圈环、done 角标、dim 置灰。
 *  文内搜索项非 AI 功能（v1.7，PLAN-WHEEL-FIND）：不受 aiEnabled 门控恒可用，无 loading/done 态 */
const items = computed(() => [
  {
    key: "summary" as const,
    icon: I.sparkle,
    label: "AI 摘要",
    vars: itemVars(-90, 0),
    loading: props.summaryState === "loading",
    done: props.hasSummary,
    dim: !props.aiEnabled,
    title: props.summaryState === "loading" ? "摘要生成中…" : props.hasSummary ? "查看摘要（滚动到顶部摘要卡）" : "AI 摘要",
  },
  {
    key: "translate" as const,
    icon: I.languages,
    label: "翻译",
    vars: itemVars(-120, 45),
    loading: props.trState === "loading",
    done: props.trState === "done",
    dim: !props.aiEnabled || !props.translatable,
    title: props.trState === "loading" ? "翻译中，点击取消" : props.trState === "done" ? "显示 / 收起译文" : "AI 段落翻译",
  },
  {
    key: "toc" as const,
    icon: I.list,
    label: "目录",
    vars: itemVars(-150, 90),
    loading: props.tocState === "loading",
    done: props.hasToc,
    dim: !props.aiEnabled,
    title: props.tocState === "loading" ? "目录生成中…" : props.hasToc ? "打开目录列表" : "生成 / 打开目录",
  },
  {
    key: "find" as const,
    icon: I.search,
    label: "文内搜索",
    vars: itemVars(-180, 135),
    loading: false,
    done: false,
    dim: false,
    title: "文内搜索（Ctrl+F）",
  },
]);

/** 联合热区矩形判定：球 rect 向左/上扩 140px（R110+项半径22+缓冲，PLAN-WHEEL-FIND §1.2），鼠标球→项任何直线路径都在内。
 *  rect 在 openWheel 时缓存（PLAN-PERF-2 §3.3）：球 absolute 于 .reader 不随正文滚动移动，
 *  open 期间恒定——mousemove 逐次 getBoundingClientRect 在 AI 流式渲染（布局反复脏）下是强制 reflow 源 */
let ballRect: DOMRect | null = null;
function inHotRect(x: number, y: number) {
  const r = ballRect ?? ballRef.value?.getBoundingClientRect();
  if (!r) return false;
  return x >= r.left - 140 && x <= r.right + 8 && y >= r.top - 140 && y <= r.bottom + 8;
}
function onDocMove(e: MouseEvent) {
  if (!pinned.value && !inHotRect(e.clientX, e.clientY)) closeWheel(); // 锁定态不移开收（点击展开的语义）
}
function onDocKey(e: KeyboardEvent) {
  if (e.key !== "Backspace" || !open.value) return;
  const t = e.target as HTMLElement;
  // 输入态守卫：hover 展开时焦点可能仍留在别处输入框，⌫ 是编辑键不该收轮盘（事件落到全局流被 typing 守卫空转）
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
  e.preventDefault();
  e.stopPropagation(); // 不进全局键盘流（⌫ 逐级返回）；面板同开时两监听独立执行 = 双闭（方案 §1.2 约定）
  closeWheel();
  ballRef.value?.focus();
}

function openWheel() {
  if (open.value) return;
  open.value = true;
  ballRect = ballRef.value?.getBoundingClientRect() ?? null; // 热区判定基准（见 inHotRect 注释）
  document.addEventListener("mousemove", onDocMove, { passive: true });
  document.addEventListener("keydown", onDocKey, true);
}
function closeWheel() {
  if (!open.value) return;
  open.value = false;
  pinned.value = false;
  ballRect = null;
  document.removeEventListener("mousemove", onDocMove);
  document.removeEventListener("keydown", onDocKey, true);
}
function toggleWheel() {
  if (open.value && pinned.value) {
    closeWheel(); // 锁定态再点球 = 收起
    return;
  }
  if (open.value) {
    if (props.panelOpen) emit("closePanel"); // R9/B4：hover 先行路径同样先关面板——面板 z700 盖轮盘 z200，任何态点球都不得留双浮层（2026-09-11 复审必改）
    pinned.value = true; // hover 预览展开态点击 = 锁定：移球必先 mouseenter 置 open，纯 toggle 会让首击变「收起」与「点击球=展开并锁定」语义相反（2026-09-11 审核必改）
    return;
  }
  if (props.panelOpen) emit("closePanel"); // 面板开着点球：先关面板再展开（AiToolsPanel onDocDown 豁免触发钮，审核 B4）
  openWheel();
  pinned.value = true; // 点击展开=锁定，移开热区不收，再次点击球才收
}

/** 键盘路径：焦点离开容器（球+项）即收起；方向键在四项间环形移动（menu role 配套） */
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
  <div ref="rootRef" class="ai-wheel" :class="{ open }" role="menu" aria-label="AI 工具（摘要 / 翻译 / 目录 / 搜索）" @focusout="onFocusOut">
    <!-- 四项：常驻 DOM（class 切换保 transition），收起态聚在球心且 visibility:hidden 不可聚焦。
         双层结构（PLAN-PERF-2 §3.1）：外层管 translate 滑出，内层管 rotate/scale 弹性张开——合成弧感 -->
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
      <span class="ai-witem-in"><component :is="it.icon" /></span>
    </button>

    <!-- 悬浮球：唯一常显锚点，hover/focus/click 展开 -->
    <button
      ref="ballRef"
      type="button"
      class="ai-ball"
      :aria-expanded="open"
      aria-haspopup="menu"
      aria-label="AI 工具（摘要 / 翻译 / 目录 / 搜索）"
      title="AI 工具（摘要 / 翻译 / 目录 / 搜索）"
      @mouseenter="openWheel()"
      @click="toggleWheel"
      @keydown="onBallKeydown"
    >
      <span class="ai-ball-ic"><I.sparkle /></span>
      <span v-if="busy" class="ai-dot" aria-hidden="true"></span>
    </button>
  </div>
</template>

<style scoped>
/* 容器：pointer-events:none 不挡正文，仅球与展开态项可交互；absolute 于 .reader-body
   （ReaderPanel 正文区，底栏之外）——bottom:12 恒在底栏上缘之上，底栏窄列换行 52→77px 无需测高跟随 */
.ai-wheel {
  position: absolute; right: 20px; bottom: 12px; width: 44px; height: 44px;
  z-index: var(--z-sticky); pointer-events: none;
}

.ai-ball {
  pointer-events: auto;
  width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: var(--bg-panel); color: var(--text-2);
  box-shadow: var(--shadow-1); font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; position: relative;
  opacity: 0.92;
  animation: ai-float 3.2s ease-in-out infinite; /* idle 漂浮：悬浮球名副其实；展开时暂停 */
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), opacity var(--t-fast) var(--ease-out), box-shadow var(--t-med) var(--ease-out);
}
.ai-ball:hover, .ai-wheel.open .ai-ball { background: var(--bg-card-hover); color: var(--accent-deep); opacity: 1; }
.ai-wheel.open .ai-ball { animation-play-state: paused; box-shadow: var(--shadow-2); /* 展开抬升（transform 被 ai-float 占用，本体不做缩放） */ }
.ai-ball:focus-visible, .ai-witem:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus-ring); }
@keyframes ai-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

/* 展开涟漪：一次性扩散重播于每次 open（class 摘除再添加）。基础态 opacity:0——正常播完与
   reduced-motion 瞬切都回落基础态即隐形（勿改基础透明度，会残留半透明圆片）。
   不用 z-index:-1 垫底：该招依赖球恒有 ai-float 动画创建的 stacking context，删 float 即失效 */
.ai-ball::after {
  content: ""; position: absolute; inset: -1px; border-radius: 50%;
  border: 1.5px solid var(--accent-strong); opacity: 0; pointer-events: none;
}
.ai-wheel.open .ai-ball::after { animation: ai-ripple 420ms var(--ease-out); }
@keyframes ai-ripple {
  0% { opacity: 0.45; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.9); }
}

/* 图标层（与球的 float 分层不抢 transform）：hover/展开弹性放大微转 */
.ai-ball-ic { display: flex; transition: transform var(--t-med) var(--ease-spring); }
.ai-ball:hover .ai-ball-ic, .ai-wheel.open .ai-ball-ic { transform: scale(1.15) rotate(-12deg); }

/* 呼吸点（aiBusyDot 任一在飞）：绝对定位球内右上（迁自顶栏按钮，适配非 inline 流式，审核建议 6） */
.ai-dot {
  position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: var(--r-sm);
  background: var(--accent-strong); animation: ai-dot-pulse 1.1s var(--ease-out) infinite;
}
@keyframes ai-dot-pulse { 50% { opacity: 0.3; } }

/* 轮盘项外层：管位移+出现（visibility 必须参与——opacity+pointer-events 不移出 Tab 序（B2）；
   收起时 visibility 延迟到 transform/opacity 播完）；旋转/缩放归内层（分段时序见下） */
.ai-witem {
  pointer-events: none; /* 收起态；展开态下方 .open 覆写 */
  position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: var(--bg-panel); color: var(--text-2);
  box-shadow: var(--shadow-1); font-size: 17px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  visibility: hidden; opacity: 0;
  transform: translate(-50%, -50%);
  transition:
    transform var(--t-fast) var(--ease-out),
    opacity var(--t-fast) var(--ease-out),
    box-shadow var(--t-fast) var(--ease-out),
    visibility 0s linear var(--t-fast);
}
/* 展开外层：快速滑出到弧位（错峰 --d 0/45/90/135ms）；收起走上方 t-fast 快速收拢 */
.ai-wheel.open .ai-witem {
  pointer-events: auto; visibility: visible; opacity: 1;
  transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty)));
  transition:
    transform var(--t-med) var(--ease-out) var(--d, 0s),
    opacity var(--t-fast) var(--ease-out) var(--d, 0s),
    box-shadow var(--t-fast) var(--ease-out),
    visibility 0s;
}
.ai-witem:hover { background: var(--bg-card-hover); color: var(--accent-deep); }
.ai-wheel.open .ai-witem:hover { box-shadow: var(--shadow-2); }
.ai-witem.dim { opacity: 0.45; cursor: default; }
.ai-wheel.open .ai-witem.dim { opacity: 0.45; }

/* 轮盘项内层：旋转+缩放弹性张开（甩出→张开的弧感：位移先到位、旋转缩放后收口）。
   收起态显式 t-fast（仅 .open 覆写为 slow+spring，否则收拢时旋转按慢弹簧走与外层位移错拍） */
.ai-witem-in { display: flex; transform: rotate(-50deg) scale(0.2); transition: transform var(--t-fast) var(--ease-out); }
.ai-wheel.open .ai-witem-in {
  transform: rotate(0deg) scale(1);
  transition: transform var(--t-slow) var(--ease-spring) calc(var(--d, 0s) + 40ms);
}
/* 展开态 hover 回弹（内层 transform 分量归内层管；rotate(0) 恒等可省略） */
.ai-wheel.open .ai-witem:hover .ai-witem-in { transform: scale(1.12); }

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
