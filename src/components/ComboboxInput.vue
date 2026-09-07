<script setup lang="ts">
import { computed, nextTick, ref, watch, onBeforeUnmount } from "vue";
import { I } from "./icons";

/**
 * 可输入下拉（C17）：替代 input[datalist]（原生建议弹层在 uTools 无边框窗内定位错位）。
 * 自由文本 + 既有分类建议：聚焦/输入即过滤，↑↓ 高亮、Enter 取高亮项（无高亮则保留键入文本）、
 * Esc 关闭不移动焦点。已处理的键 stopPropagation，防止全局 Enter 开篇 / Esc 返回吃掉面板按键。
 */
const props = defineProps<{
  modelValue: string;
  suggestions: string[];
  ariaLabel?: string;
  placeholder?: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const open = ref(false);
const hoverIdx = ref(-1); // -1 = 无高亮，Enter 保留键入文本
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

const filtered = computed(() => {
  const q = props.modelValue.trim().toLowerCase();
  const list = q ? props.suggestions.filter((s) => s.toLowerCase().includes(q)) : props.suggestions;
  return list.slice(0, 12);
});

function place() {
  const el = inputRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const maxH = 232;
  const flip = r.bottom + maxH > window.innerHeight && r.top - maxH > 0;
  panelStyle.value = {
    left: Math.max(8, r.left) + "px",
    top: flip ? r.top - 4 + "px" : r.bottom + 4 + "px",
    minWidth: r.width + "px",
    transform: flip ? "translateY(-100%)" : "none",
  };
}

function openList() {
  if (open.value) return;
  hoverIdx.value = -1;
  open.value = true;
  nextTick(place);
}
function close() {
  open.value = false;
  hoverIdx.value = -1;
}
function onInput() {
  openList();
  hoverIdx.value = filtered.value.length ? 0 : -1;
}
function accept(s: string) {
  emit("update:modelValue", s);
  close();
}
function hoverScroll() {
  if (hoverIdx.value < 0) return;
  panelRef.value?.querySelector(`[data-idx="${hoverIdx.value}"]`)?.scrollIntoView({ block: "nearest" });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open.value) {
      openList();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const n = filtered.value.length;
    if (!n) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    hoverIdx.value = hoverIdx.value < 0 ? (dir > 0 ? 0 : n - 1) : (hoverIdx.value + dir + n) % n;
    hoverScroll();
  } else if (e.key === "Enter" && open.value) {
    e.preventDefault();
    e.stopPropagation();
    if (hoverIdx.value >= 0 && filtered.value[hoverIdx.value]) accept(filtered.value[hoverIdx.value]);
    else close();
  } else if (e.key === "Escape" && open.value) {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

function onDocDown(e: MouseEvent) {
  const t = e.target as Node;
  if (inputRef.value?.contains(t) || panelRef.value?.contains(t)) return;
  close();
}
function onWinScroll() {
  close();
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
  <div class="combo">
    <input
      ref="inputRef"
      class="input combo-input"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      autocomplete="off"
      spellcheck="false"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value); onInput()"
      @focus="openList"
      @keydown="onKeydown"
    />
    <button type="button" class="combo-chev" :aria-expanded="open" aria-haspopup="listbox" :aria-label="ariaLabel + '建议'" tabindex="-1" @click="open ? close() : openList()">
      <I.chevronDown :class="{ open }" />
    </button>

    <Teleport to="body">
      <div v-if="open && filtered.length" ref="panelRef" class="combo-panel" :style="panelStyle" role="listbox" :aria-label="ariaLabel">
        <button
          v-for="(s, i) in filtered"
          :key="s"
          class="combo-item"
          :data-idx="i"
          type="button"
          role="option"
          :aria-selected="s === modelValue"
          :class="{ hover: i === hoverIdx }"
          @mousedown.prevent="accept(s)"
          @mousemove="hoverIdx = i"
        >
          <span class="combo-item-label">{{ s }}</span>
          <I.check v-if="s === modelValue" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.combo { position: relative; width: 100%; }
.combo-input { padding-right: 32px; }
.combo-chev {
  position: absolute; right: 1px; top: 1px; bottom: 1px; width: 30px;
  border: none; background: transparent; color: var(--text-3); cursor: pointer;
  display: flex; align-items: center; justify-content: center; border-radius: 0 var(--r-md) var(--r-md) 0;
}
.combo-chev:hover { color: var(--text-1); background: var(--bg-hover); }
.combo-chev svg { transition: transform var(--t-fast) var(--ease-out); }
.combo-chev svg.open { transform: rotate(180deg); }

.combo-panel {
  position: fixed; z-index: var(--z-toast); /* 高于弹层（z-modal 600） */
  max-height: 232px; overflow-y: auto;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); padding: 4px;
}
html[data-theme="dark"] .combo-panel { background: var(--bg-elevated); }
.combo-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
  height: 32px; padding: 0 10px; border: none; background: transparent; border-radius: var(--r-sm);
  font-family: inherit; font-size: 12.5px; color: var(--text-1); cursor: pointer; text-align: left;
}
.combo-item:hover, .combo-item.hover { background: var(--bg-hover); }
.combo-item[aria-selected="true"] { color: var(--accent-deep); font-weight: 600; }
.combo-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
