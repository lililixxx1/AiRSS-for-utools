<script setup lang="ts">
import { reactive } from "vue";
import type { Feed } from "../types";
import { useDataStore } from "../stores/data";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import ComboboxInput from "./ComboboxInput.vue";
import DropdownSelect from "./DropdownSelect.vue";

const props = defineProps<{ feed: Feed }>();
const emit = defineEmits<{ (e: "close"): void }>();

const data = useDataStore();
const ui = useUiStore();

const form = reactive({
  title: props.feed.title,
  url: props.feed.url, // D3：订阅地址可改（换源不换 feedKey，已读/星标/AI 产物全保留）
  category: props.feed.category || "默认",
  refreshMin: props.feed.refreshMin, // 0 = 跟随全局
  notify: props.feed.notify,
  fullText: !!props.feed.fullText, // 摘要型源打开文章时自动抓原文（PLAN-V1.3 A，默认关）
});

const cats = () => [...new Set(["默认", ...data.feeds.map((f) => f.category || "默认")])];

const refreshOptions = [
  { value: 0, label: "跟随全局" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
  { value: 360, label: "6 小时" },
];

async function save() {
  if (!form.title.trim()) {
    ui.toast("名称不能为空", "error");
    return;
  }
  // D3：URL 变化 = 换源——条件请求缓存（etag/lastModified）作废重抓；已知代价：新旧源内容
  // 重叠期同一文章因 link/guid 判重为两篇（换域场景旧源通常已停更，影响小，方案明示接受）
  const url = window.airss.feed.normalizeUrl(form.url.trim());
  if (!/^https?:\/\/./i.test(url)) {
    ui.toast("订阅地址无效", "error");
    return;
  }
  const urlChanged = url !== props.feed.url;
  const patch: Record<string, unknown> = {
    title: form.title.trim(),
    category: form.category.trim() || "默认",
    refreshMin: Number(form.refreshMin) || 0,
    notify: form.notify,
    fullText: form.fullText,
  };
  if (urlChanged) Object.assign(patch, { url, etag: "", lastModified: "", lastError: "", lastFetchedAt: null });
  await data.updateFeed(props.feed, patch as any);
  ui.toast("已保存");
  emit("close");
  if (urlChanged) {
    const r = await window.airss.scheduler.refreshOne(props.feed);
    await data.loadAll();
    ui.toast(r.ok ? "已切换地址并完成首次抓取" : `新地址抓取失败：${r.error}`, r.ok ? "info" : "error");
  }
}
</script>

<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="编辑订阅">
      <div class="modal-head">
        <h3>编辑订阅</h3>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')"><I.close /></button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">名称</span>
          <input class="input" v-model="form.title" />
        </label>
        <label class="field">
          <span class="field-label">订阅地址</span>
          <input class="input" v-model="form.url" placeholder="https://example.com/feed" spellcheck="false" />
        </label>
        <div class="field">
          <span class="field-label">分类</span>
          <ComboboxInput v-model="form.category" :suggestions="cats()" aria-label="分类" placeholder="选择或输入新分类" />
        </div>
        <div class="field">
          <span class="field-label">刷新频率</span>
          <DropdownSelect :model-value="form.refreshMin" :options="refreshOptions" aria-label="刷新频率" @update:model-value="form.refreshMin = Number($event)" />
        </div>
        <div class="field row-switch">
          <span class="field-label">新文章通知</span>
          <button class="switch" :class="{ on: form.notify }" role="switch" :aria-checked="form.notify" @click="form.notify = !form.notify">
            <span class="dot"></span>
          </button>
        </div>
        <div class="field row-switch">
          <span class="field-label">
            抓取全文
            <span class="field-hint">摘要型源打开文章时自动抓取原文（需站点可访问）</span>
          </span>
          <button class="switch" :class="{ on: form.fullText }" role="switch" :aria-checked="form.fullText" @click="form.fullText = !form.fullText">
            <span class="dot"></span>
          </button>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" @click="emit('close')">取消</button>
        <button class="btn btn-primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 400px; max-width: 92vw; max-height: 80vh; overflow-y: auto;
  background: var(--bg-panel); border-radius: var(--r-lg);
  box-shadow: var(--shadow-3); border: 1px solid var(--border);
}
html[data-theme="dark"] .modal { background: var(--bg-elevated); border-color: var(--border-strong); }
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px 0;
}
.modal-head h3 { font-size: 16px; font-weight: 650; }
.modal-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-2); }
.field-hint { display: block; font-size: 11px; font-weight: 400; color: var(--text-3); margin-top: 2px; max-width: 280px; line-height: 1.5; }
.row-switch { flex-direction: row; align-items: center; justify-content: space-between; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 16px 14px; }
/* .switch 全局类在 base.css（PLAN-POLISH D3 提取） */
</style>
