<script setup lang="ts">
import { computed, nextTick, ref, watch, onBeforeUnmount } from "vue";
import { I } from "./icons";

/**
 * 自定义单选下拉（C17）：全站替代原生 <select>。
 * 原生 select 弹层在 uTools 无边框/透明窗内定位错位（2026-09 实机，添加订阅选分类触发），
 * 故面板 Teleport 到 body + fixed 定位（同时避开弹窗 overflow 裁剪），开合时按触发钮 rect 重算。
 * 键盘（design-system §8.1）：↑↓ 高亮（未开则先开）、Enter/空格 选中、Esc 关闭不移动焦点。
 * 已处理的键一律 stopPropagation——全局键盘流（Enter 开篇/Esc 返回）不得吃掉面板内按键。
 */
const props = defineProps<{
  modelValue: string | number;
  options: { value: string | number; label: string }[];
  ariaLabel?: string;
  width?: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", v: string | number): void }>();

const open = ref(false);
const hoverIdx = ref(0);
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

const currentLabel = computed(() => props.options.find((o) => o.value === props.modelValue)?.label ?? String(props.modelValue));

function place() {
  const el = triggerRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const maxH = 264; // ~8 项，超出滚动
  const flip = r.bottom + maxH > window.innerHeight && r.top - maxH > 0;
  panelStyle.value = {
    left: Math.max(8, r.left) + "px",
    top: flip ? r.top - 4 + "px" : r.bottom + 4 + "px",
    minWidth: r.width + "px",
    transform: flip ? "translateY(-100%)" : "none",
  };
}

function openMenu() {
  const idx = props.options.findIndex((o) => o.value === props.modelValue);
  hoverIdx.value = idx >= 0 ? idx : 0;
  open.value = true;
  nextTick(() => {
    place();
    hoverScroll();
  });
}
function close() {
  open.value = false;
}
function toggle() {
  open.value ? close() : openMenu();
}
function pick(i: number) {
  emit("update:modelValue", props.options[i].value);
  close();
}
function hoverScroll() {
  panelRef.value?.querySelector(`[data-idx="${hoverIdx.value}"]`)?.scrollIntoView({ block: "nearest" });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (!open.value) {
      openMenu();
      hoverIdx.value = e.key === "ArrowDown" ? 0 : props.options.length - 1;
      nextTick(hoverScroll);
      return;
    }
    const dir = e.key === "ArrowDown" ? 1 : -1;
    hoverIdx.value = (hoverIdx.value + dir + props.options.length) % props.options.length;
    hoverScroll();
  } else if ((e.key === "Enter" || e.key === " ") && open.value) {
    e.preventDefault();
    e.stopPropagation();
    pick(hoverIdx.value);
  } else if (e.key === "Escape" && open.value) {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

function onDocDown(e: MouseEvent) {
  const t = e.target as Node;
  if (triggerRef.value?.contains(t) || panelRef.value?.contains(t)) return;
  close();
}
function onWinScroll() {
  close(); // 面板 fixed 不随滚动移动；关闭比重算便宜且不突兀
}
watch(open, (v) => {
  if (v) {
    document.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("scroll", onWinScroll, true);
    window.addEventListener("resize", onWinScroll);
  } else {
    document.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("scroll", onWinScroll, true);
    window.removeEventListener("resize", onWinScroll);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocDown, true);
  window.removeEventListener("scroll", onWinScroll, true);
  window.removeEventListener("resize", onWinScroll);
});
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="ddsel"
    :style="width ? { width } : undefined"
    :aria-expanded="open"
    aria-haspopup="listbox"
    :aria-label="ariaLabel"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span class="ddsel-label" :title="currentLabel">{{ currentLabel }}</span>
    <I.chevronDown class="ddsel-chev" :class="{ open }" />
  </button>

  <Teleport to="body">
    <div v-if="open" ref="panelRef" class="ddsel-panel" :style="panelStyle" role="listbox" :aria-label="ariaLabel">
      <button
        v-for="(o, i) in options"
        :key="String(o.value)"
        class="ddsel-item"
        :data-idx="i"
        type="button"
        role="option"
        :aria-selected="o.value === modelValue"
        :class="{ hover: i === hoverIdx }"
        @click="pick(i)"
        @mousemove="hoverIdx = i"
      >
        <span class="ddsel-item-label">{{ o.label }}</span>
        <I.check v-if="o.value === modelValue" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 视觉与全局 .input（C2）同族：border-strong / bg-panel / r-md，高度对齐表单行 */
.ddsel {
  height: 36px; padding: 0 10px 0 12px; border: 1px solid var(--border-strong); border-radius: var(--r-md);
  background: var(--bg-panel); color: var(--text-1); font-family: inherit; font-size: 13px;
  display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer;
  width: 100%;
  transition: border var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out);
}
.ddsel:hover { background: var(--bg-card-hover); }
.ddsel:focus-visible { border-color: transparent; box-shadow: 0 0 0 2px var(--focus-ring); outline: none; }
.ddsel-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.ddsel-chev { flex-shrink: 0; color: var(--text-3); transition: transform var(--t-fast) var(--ease-out); }
.ddsel-chev.open { transform: rotate(180deg); }

.ddsel-panel {
  position: fixed; z-index: var(--z-toast); /* 面板会出现在弹层（z-modal 600）内，必须高于弹层 */
  max-height: 264px; overflow-y: auto;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); padding: 4px;
}
html[data-theme="dark"] .ddsel-panel { background: var(--bg-elevated); }
.ddsel-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
  height: 32px; padding: 0 10px; border: none; background: transparent; border-radius: var(--r-sm);
  font-family: inherit; font-size: 12.5px; color: var(--text-1); cursor: pointer; text-align: left;
}
.ddsel-item:hover, .ddsel-item.hover { background: var(--bg-hover); }
.ddsel-item[aria-selected="true"] { color: var(--accent-deep); font-weight: 600; }
.ddsel-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
