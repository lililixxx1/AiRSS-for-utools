<script setup lang="ts">
// 添加订阅三步管线：输入 → 发现（spinner+探测日志）→ 候选确认 → 完成（入库即首抓）
// 失败态：已试路径 + 手动粘贴 + RSSHub 文案提示（不自动请求）
import { computed, reactive, ref, watch } from "vue";
import { useDataStore } from "../stores/data";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import ComboboxInput from "./ComboboxInput.vue";
import DropdownSelect from "./DropdownSelect.vue";
import type { FeedCandidate, TriedPath } from "../types";

const ui = useUiStore();
const data = useDataStore();

const step = ref<"input" | "discovering" | "candidates" | "confirm" | "failed">("input");
const url = ref("");
const candidates = ref<FeedCandidate[]>([]);
const tried = ref<TriedPath[]>([]);
const chosen = ref(0);
const errorText = ref("");

const form = reactive({ title: "", category: "默认", refreshMin: 0, fullText: false });

/** 发现期启发式信号（null = 无信号，如 mock；true = 摘要型源 → 预开抓取全文；false = 全文型 → 保持关） */
const fullTextSuggest = ref<boolean | null>(null);

const props = defineProps<{ presetUrl?: string }>();

watch(
  () => props.presetUrl,
  (u) => {
    if (u) {
      url.value = u;
      discover();
    }
  },
  { immediate: true }
);

async function discover() {
  const input = url.value.trim();
  if (!input) return;
  url.value = input;
  step.value = "discovering";
  tried.value = [];
  const res = await window.airss.feed
    .discover(input)
    .catch(() => null); // preload 对非法地址会抛（new URL 等）：任何 rejection 都落失败态，不卡在发现中转圈
  if (!res) {
    errorText.value = "探测失败，请检查地址是否正确";
    step.value = "failed";
    return;
  }
  if (res.found && res.candidates.length) {
    candidates.value = res.candidates;
    tried.value = res.tried;
    chosen.value = 0;
    form.title = res.candidates[0].title;
    fullTextSuggest.value = res.candidates[0].summaryOnly ?? null;
    form.fullText = fullTextSuggest.value === true; // 摘要型源智能预开；全文型/未知默认关，用户可在确认步改
    step.value = "candidates";
  } else {
    tried.value = res.tried;
    errorText.value = "未在该地址发现 Feed";
    step.value = "failed";
  }
}

function pick() {
  const c = candidates.value[chosen.value];
  if (!c) return;
  form.title = c.title;
  // 按实际选中候选重算（当前 discoverFeed 恒单候选，此为多候选 future-proof；confirm 步
  // 无「上一步」，不存在用户改过开关再 pick 的覆盖窗口）
  fullTextSuggest.value = c.summaryOnly ?? null;
  form.fullText = fullTextSuggest.value === true;
  step.value = "confirm";
}

const catOptions = computed(() => [...new Set(["默认", ...data.feeds.map((f) => f.category || "默认")])]);

const refreshOptions = [
  { value: 0, label: "跟随全局" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
];

const fullTextHint = computed(() => {
  // 文案随 (判定信号, 开关实际状态) 双轴变化——用户手动改开关后不再显示与状态矛盾的「已自动开启」
  if (fullTextSuggest.value === true)
    return form.fullText ? "检测到该源仅提供摘要，已自动开启（打开文章时抓取原文）" : "检测到该源仅提供摘要，建议开启抓取全文";
  if (fullTextSuggest.value === false)
    return form.fullText ? "该源已在 Feed 内提供全文；已手动开启抓取" : "该源已在 Feed 内提供全文，无需抓取";
  return "摘要型源打开文章时自动抓取原文（需站点可访问）";
});

async function add() {
  const c = candidates.value[chosen.value];
  if (!c) return;
  if (!form.title.trim()) {
    ui.toast("名称不能为空", "error");
    return;
  }
  const { doc, result } = await data.addFeed({
    url: c.url,
    title: form.title.trim(),
    category: form.category.trim() || "默认",
    fullText: form.fullText,
    refreshMin: form.refreshMin,
  });
  ui.toast(`已添加「${doc.title}」${result.ok && result.newCount ? ` · 抓到 ${result.newCount} 篇文章` : " · 正在抓取首批文章"}`);
  ui.modal = null;
}

function close() {
  ui.modal = null;
}
</script>

<template>
  <div class="scrim" @click.self="close">
    <div class="modal" role="dialog" aria-modal="true" aria-label="添加订阅">
      <div class="modal-head">
        <h3>添加订阅</h3>
        <button class="icon-btn" aria-label="关闭" @click="close"><I.close /></button>
      </div>

      <!-- 步骤指示 -->
      <div class="steps" v-if="step !== 'input'">
        <span class="st" :class="{ act: step === 'discovering', done: step !== 'discovering' }"><i></i>发现</span>
        <span class="st" :class="{ act: step === 'candidates', done: step === 'confirm' }"><i></i>确认</span>
        <span class="st" :class="{ act: step === 'confirm' }"><i></i>完成</span>
      </div>

      <div class="modal-body">
        <!-- 1 输入 -->
        <template v-if="step === 'input'">
          <label class="field">
            <span class="field-label">站点或 Feed 地址</span>
            <input
              class="input"
              v-model="url"
              placeholder="example.com 或 https://example.com/feed"
              autofocus
              @keydown.enter="discover"
            />
          </label>
          <p class="hint">支持站点首页（自动发现 Feed）、RSS/Atom 直链</p>
        </template>

        <!-- 2 发现中 -->
        <template v-else-if="step === 'discovering'">
          <div class="discovering">
            <span class="spinner"></span>
            <span>正在探测 Feed…</span>
          </div>
          <div class="probe-log">
            <div v-for="(t, i) in tried" :key="i" class="log-line num">{{ t.path }} → {{ t.result }}</div>
          </div>
        </template>

        <!-- 3 候选 -->
        <template v-else-if="step === 'candidates'">
          <div class="cand-list" role="listbox" aria-label="发现结果">
            <button
              v-for="(c, i) in candidates"
              :key="c.url"
              class="cand"
              role="option"
              :aria-selected="chosen === i"
              @click="chosen = i"
            >
              <I.radioChecked v-if="chosen === i" /><I.radio v-else />
              <span class="cand-main">
                <span class="cand-title">{{ c.title }}</span>
                <span class="cand-url num ellipsis">{{ c.url }}</span>
              </span>
              <span class="cand-count num">{{ c.itemCount }} 篇</span>
            </button>
          </div>
        </template>

        <!-- 4 确认 -->
        <template v-else-if="step === 'confirm'">
          <label class="field">
            <span class="field-label">名称</span>
            <input class="input" v-model="form.title" />
          </label>
          <div class="field">
            <span class="field-label">分类</span>
            <ComboboxInput v-model="form.category" :suggestions="catOptions" aria-label="分类" placeholder="选择或输入新分类" />
          </div>
          <div class="field">
            <span class="field-label">刷新频率</span>
            <DropdownSelect :model-value="form.refreshMin" :options="refreshOptions" aria-label="刷新频率" @update:model-value="form.refreshMin = Number($event)" />
          </div>
          <div class="field row-switch">
            <span class="field-label">
              抓取全文
              <span class="field-hint">{{ fullTextHint }}</span>
            </span>
            <button class="switch" :class="{ on: form.fullText }" role="switch" :aria-checked="form.fullText" @click="form.fullText = !form.fullText">
              <span class="dot"></span>
            </button>
          </div>
        </template>

        <!-- 失败态 -->
        <template v-else>
          <div class="fail">
            <span class="fail-ico"><I.alertTriangle /></span>
            <b>{{ errorText }}</b>
          </div>
          <div class="probe-log">
            <div v-for="(t, i) in tried" :key="i" class="log-line num">{{ t.path }} → {{ t.result }}</div>
          </div>
          <label class="field">
            <span class="field-label">手动粘贴 Feed 直链</span>
            <input class="input" v-model="url" placeholder="https://example.com/feed.xml" @keydown.enter="discover" />
          </label>
          <p class="hint">也可试试 RSSHub：https://rsshub.app/{域名}（仅提示，不会自动请求）</p>
        </template>
      </div>

      <div class="modal-foot">
        <button v-if="step === 'candidates'" class="btn btn-ghost" @click="step = 'input'">上一步</button>
        <button v-if="step === 'failed'" class="btn btn-secondary" @click="discover"><I.refresh />重试</button>
        <button v-if="step === 'failed'" class="btn btn-ghost" @click="close">关闭</button>
        <button v-if="step !== 'candidates' && step !== 'failed' && step !== 'discovering'" class="btn btn-ghost" @click="close">取消</button>
        <button v-if="step === 'input'" class="btn btn-primary" @click="discover">探测</button>
        <button v-if="step === 'candidates'" class="btn btn-primary" @click="pick">继续</button>
        <button v-if="step === 'confirm'" class="btn btn-primary" @click="add">添加</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: var(--z-modal); background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.modal { width: 420px; max-width: 92vw; max-height: 80vh; overflow-y: auto; background: var(--bg-panel); border-radius: var(--r-lg); box-shadow: var(--shadow-3); border: 1px solid var(--border); }
html[data-theme="dark"] .modal { background: var(--bg-elevated); border-color: var(--border-strong); }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 0; }
.modal-head h3 { font-size: 16px; font-weight: 650; }
.modal-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 16px 14px; }

.steps { display: flex; gap: 16px; padding: 12px 16px 0; }
.st { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); }
.st i { width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); }
.st.act { color: var(--accent-deep); font-weight: 600; }
.st.act i { background: var(--accent-strong); }
.st.done i { background: var(--accent-strong); }

.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-2); }
.field-hint { display: block; font-size: 11px; font-weight: 400; color: var(--text-3); margin-top: 2px; max-width: 280px; line-height: 1.5; }
.row-switch { flex-direction: row; align-items: center; justify-content: space-between; }
.hint { font-size: 12px; color: var(--text-3); line-height: 1.5; }

.discovering { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); padding: 4px 0; }
.spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--bg-hover); border-top-color: var(--accent-strong);
  animation: spin-360 0.9s linear infinite; /* 全局 keyframes（base.css，PLAN-POLISH A7） */
}

.probe-log {
  background: var(--bg-hover); border-radius: var(--r-md); padding: 8px 10px;
  font-family: var(--font-mono); font-size: 12px; color: var(--text-2);
  max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
}

.cand-list { display: flex; flex-direction: column; gap: 6px; }
.cand {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: transparent; font-family: inherit; text-align: left; cursor: pointer; width: 100%;
}
.cand:hover { background: var(--bg-card-hover); }
.cand:active { background: var(--bg-active); }
.cand[aria-selected="true"] { background: var(--bg-selected); border-color: transparent; color: var(--accent-deep); }
.cand-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cand-title { font-size: 13px; font-weight: 500; }
.cand-url { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.cand-count { font-size: 12px; color: var(--text-3); }

.fail { display: flex; align-items: center; gap: 10px; }
.fail-ico {
  width: 36px; height: 36px; border-radius: 50%; background: var(--danger-soft);
  color: var(--danger-text); display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0;
}
.fail b { font-size: 14px; color: var(--text-1); }
</style>
