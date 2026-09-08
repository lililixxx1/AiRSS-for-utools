<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import Sidebar from "./components/Sidebar.vue";
import ArticleFlow from "./components/ArticleFlow.vue";
import ReaderPanel from "./components/ReaderPanel.vue";
import SettingsView from "./components/SettingsView.vue";
import AddFeedModal from "./components/AddFeedModal.vue";
import ComboboxInput from "./components/ComboboxInput.vue";
import { I } from "./components/icons";
import { useDataStore } from "./stores/data";
import { useSettingsStore } from "./stores/settings";
import { useThemeStore } from "./stores/theme";
import { useUiStore } from "./stores/ui";

const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();
const theme = useThemeStore();

const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);

// ---- prompt 弹窗（PLAN-V1.3 D1：分类重命名/合并的输入层）----
const promptValue = ref("");
watch(
  () => ui.modal,
  (m) => {
    if (m && m.type === "prompt") promptValue.value = m.initial || "";
  }
);
function submitPrompt() {
  const m = ui.modal;
  const v = promptValue.value.trim();
  if (m && m.type === "prompt" && v) {
    m.onOk(v);
    ui.modal = null;
  }
}

let dbPullTimer: number | undefined;

/** 初始化数据 + 云同步状态处理（PLAN §5.1：replicateStateFromCloud 三态） */
async function initData() {
  let state: 0 | 1 | null = null;
  try {
    state = utools.db.replicateStateFromCloud();
  } catch {
    state = null;
  }
  if (state === 1) {
    // 同步中：等待 onDbPull 落地（带 1.5s 兜底），期间保持骨架
    await new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, 1500);
      (window as any).__resolveDbSync = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
  await data.loadAll();
  data.refreshDue(); // 打开即增量刷新，渲染不等刷新完成
}

/** 正文字号 4 档（tokens.css 的 --reading-fs 只有 16px 兜底，档位切换必须在此驱动） */
const FONT_STEPS = ["14px", "16px", "18px", "22px"];
watchEffect(() => {
  document.documentElement.style.setProperty("--reading-fs", FONT_STEPS[settings.fontLevel] ?? "16px");
});

function wireUtools() {
  utools.onPluginEnter(({ code, payload }) => {
    if (!data.loaded) initData();
    if (code === "add_feed" && payload) {
      ui.modal = { type: "addFeed", presetUrl: String(payload) };
    }
  });

  utools.onPluginOut((isKill) => {
    // 中断纪律：仅进程被杀才硬中断；隐藏后台静默完成本批（PLAN §5.1）
    if (isKill) {
      window.airss.scheduler.abort();
      window.airss.ai.abort(); // 进行中的 AI 流调用一并中止
    }
  });

  utools.onPluginDetach(() => {
    ui.detached = true;
    try {
      utools.removeSubInput(); // 分离窗无宿主子输入框
    } catch {
      /* noop */
    }
  });

  utools.onDbPull(() => {
    // 云同步落地：防抖全量重载 + unreadCount 对账（简版，二期做完整合并矩阵）
    clearTimeout(dbPullTimer);
    dbPullTimer = window.setTimeout(async () => {
      await data.loadAll();
      for (const f of data.feeds) await window.airss.db.recalcUnread(f);
      await data.loadAll();
      const r = (window as any).__resolveDbSync;
      if (r) r();
    }, 300);
  });

  utools.setSubInput((text: string) => {
    data.setSearch(text); // 与侧栏搜索框同源（统一走 setSearch：防抖 + 正文检索）
  }, "搜索文章…");

  utools.onMainPush(
    () => {
      const n = data.stats.unread;
      const titles = data.unreadTopTitles
        .map((t) => (t.length > 30 ? t.slice(0, 30) + "…" : t))
        .join(" · ");
      return [{ icon: "logo.png", title: "AiRSS", text: titles ? `${n} 篇未读 · ${titles}`.slice(0, 100) : "没有未读文章" }];
    },
    () => true
  );
}

/** 逐级返回阶梯（⌫/Esc 共用）：弹层 → 退出输入态 → 关阅读 → 退设置 → 清搜索；返回是否消费 */
function backLadder(target: HTMLElement): boolean {
  if (ui.modal) {
    ui.modal = null;
    return true;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) {
    target.blur();
    return true;
  }
  if (ui.view === "reader" && !ui.detached) {
    ui.closeReader();
    return true;
  }
  if (ui.view === "settings") {
    ui.view = "main";
    return true;
  }
  if (data.search) {
    data.setSearch(""); // 统一入口：连带清空正文命中与扫描态
    return true;
  }
  return false;
}

/** 全局键盘流（design-system §8.1） */
function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;

  // Esc：2026-09-05 实机验证——主窗口 Esc 被宿主优先消费（直接隐藏插件，页面拦不住），
  // 页内逐级返回由 ⌫ Backspace 承担；Esc 分支保留，分离窗内无宿主拦截仍生效。
  if (e.key === "Escape") {
    if (backLadder(target)) e.preventDefault();
    return; // 顶层放行宿主（PLAN §10 兜底）
  }
  if (e.key === "Backspace" && !typing) {
    // 输入态下 ⌫ 是编辑键，不参与返回
    if (backLadder(target)) e.preventDefault();
    return;
  }

  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sidebarRef.value?.focusSearch();
    return;
  }
  if (typing || ui.modal) return;

  const list = data.filtered;
  if (!list.length) return;

  if (e.key === "j" || e.key === "k") {
    e.preventDefault();
    const dir = e.key === "j" ? 1 : -1;
    let next = ui.cursor + dir;
    if (next < 0) next = 0;
    if (next >= list.length) next = list.length - 1;
    ui.cursor = next;
    if (ui.view === "reader") {
      // 阅读面板内 j/k = 翻篇
      const it = list[next];
      data.markRead(it, true);
      ui.openReader(it._id);
    }
    return;
  }
  if (e.key === "Enter" && ui.view !== "settings") {
    e.preventDefault();
    const it = list[ui.cursor];
    if (it) {
      data.markRead(it, true);
      ui.openReader(it._id);
    }
    return;
  }

  const it = list[ui.cursor];
  if (!it) return;
  if (e.key === "m") {
    e.preventDefault();
    data.markRead(it, !it.read);
  } else if (e.key === "s") {
    e.preventDefault();
    data.toggleStar(it);
  } else if (e.key === "A" && e.shiftKey) {
    e.preventDefault();
    data.markAllRead();
  }
}

onMounted(() => {
  settings.load();
  theme.init();
  wireUtools();
  initData();
  document.addEventListener("keydown", onKeydown);

  // dev only：mock 层状态直达事件（uTools 内不会触发）
  window.addEventListener("airss-mock-view", (e) => {
    const v = (e as CustomEvent).detail;
    if (v === "settings") ui.view = "settings";
    else if (v === "addfeed") ui.modal = { type: "addFeed" };
    else if (v === "reader" && data.filtered[0]) {
      const it = data.filtered[0];
      data.markRead(it, true);
      ui.openReader(it._id);
    }
  });
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="app" :class="{ detached: ui.detached, 'sb-collapsed': settings.sidebarCollapsed }">
    <Sidebar ref="sidebarRef" />

    <!-- 内容列（小窗：唯一主列，覆盖层承载阅读/设置） -->
    <div class="main-col">
      <ArticleFlow />
      <ReaderPanel v-if="ui.view === 'reader' && !ui.detached" />
      <SettingsView v-if="ui.view === 'settings' && !ui.detached" />
    </div>

    <!-- 分离窗第三栏：阅读常驻 -->
    <div class="reader-col" v-if="ui.detached">
      <ReaderPanel v-if="ui.view === 'reader'" />
      <div class="reader-placeholder" v-else>
        <I.bookmark />
        <p>选择一篇文章开始阅读</p>
      </div>
    </div>
    <SettingsView v-if="ui.view === 'settings' && ui.detached" />
  </div>

  <!-- 添加订阅弹层 -->
  <AddFeedModal v-if="ui.modal && ui.modal.type === 'addFeed'" :preset-url="ui.modal.presetUrl" />

  <!-- 确认弹层（删除订阅/清空数据共用） -->
  <div class="scrim" v-if="ui.modal && ui.modal.type === 'confirm'" @click.self="ui.modal = null">
    <div class="confirm" role="alertdialog" aria-modal="true" :aria-label="ui.modal.title">
      <div class="cf-ico" :class="{ danger: ui.modal.danger }"><I.alertTriangle /></div>
      <h3>{{ ui.modal.title }}</h3>
      <p class="cf-body">{{ ui.modal.body }}</p>
      <div class="cf-foot">
        <button class="btn btn-ghost" @click="ui.modal = null">取消</button>
        <button
          class="btn"
          :class="ui.modal.danger ? 'btn-danger' : 'btn-primary'"
          @click="ui.modal && ui.modal.type === 'confirm' && (ui.modal.onOk(), (ui.modal = null))"
        >
          确认{{ ui.modal.danger ? "删除" : "" }}
        </button>
      </div>
    </div>
  </div>

  <!-- 输入弹层（D1：分类重命名/合并；样式复用 confirm 骨架，suggestions 走 ComboboxInput 防 C17 弹层错位） -->
  <div class="scrim" v-if="ui.modal && ui.modal.type === 'prompt'" @click.self="ui.modal = null">
    <div class="confirm" role="dialog" aria-modal="true" :aria-label="ui.modal.title">
      <h3>{{ ui.modal.title }}</h3>
      <p v-if="ui.modal.label" class="cf-body">{{ ui.modal.label }}</p>
      <ComboboxInput
        v-if="ui.modal.suggestions?.length"
        v-model="promptValue"
        :suggestions="ui.modal.suggestions"
        aria-label="输入"
        class="prompt-field"
        @keydown.enter="submitPrompt"
      />
      <input v-else class="input prompt-field" v-model="promptValue" @keydown.enter="submitPrompt" />
      <div class="cf-foot">
        <button class="btn btn-ghost" @click="ui.modal = null">取消</button>
        <button class="btn btn-primary" :disabled="!promptValue.trim()" @click="submitPrompt">确定</button>
      </div>
    </div>
  </div>

  <!-- OPML 导入进度条 -->
  <div class="opml-progress" v-if="data.opmlImporting" role="status">
    <span>正在导入订阅 {{ data.opmlImporting.done }}/{{ data.opmlImporting.total }}…</span>
    <div class="opml-bar"><div class="opml-fill" :style="{ width: (100 * data.opmlImporting.done) / Math.max(1, data.opmlImporting.total) + '%' }"></div></div>
  </div>

  <!-- toast -->
  <div class="toasts" aria-live="polite">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="{ error: t.kind === 'error' }" role="status">
      <I.alertTriangle v-if="t.kind === 'error'" />
      {{ t.text }}
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: grid;
  /* 行轨道显式定高：不写则隐式 auto 行在部分 Chromium（uTools 宿主）下被内容顶穿——
     2026-09-08 实机：宿主最大化后视口被压到 244px，auto 行随侧栏内容长到 8167px，
     footer 与 ⋯ 按钮全部出画（纯浏览器 Chromium 不复现）。minmax(0,1fr) 保证行高
     恒等于容器高、侧栏内部滚动，不依赖 auto 行的解析差异 */
  grid-template-rows: minmax(0, 1fr);
  /* 轨道跟随侧栏折叠状态（否则内容列停在 280px 处，中间露出空白）。
     注意：不要给 grid-template-columns 加 transition——逐帧轨道重排会拖死渲染线程 */
  grid-template-columns: 280px 1fr;
  overflow: hidden;
}
.app.sb-collapsed {
  grid-template-columns: 64px 1fr;
}
.app.detached {
  grid-template-columns: 280px minmax(360px, 400px) 1fr;
}
.app.detached.sb-collapsed {
  grid-template-columns: 64px minmax(360px, 400px) 1fr;
}
/* grid 子项不写 height:100%：靠默认 align-self:stretch 填满 minmax(0,1fr) 定高轨道。
   2026-09-08 实机：宿主 Chromium 对 grid 子项百分比高度的解析会回落 auto（内容高），
   正文滚动容器被撑成整文高度、永不溢出 → 滚轮无效；stretch 对内容免疫，勿改回百分比 */
.main-col { position: relative; min-width: 0; overflow: hidden; }
.reader-col { position: relative; min-width: 440px; background: var(--bg-panel); display: flex; flex-direction: column; }

.reader-placeholder {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  color: var(--text-3); font-size: 26px;
}
.reader-placeholder p { font-size: 13px; }

.scrim { position: fixed; inset: 0; z-index: var(--z-modal); background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.confirm {
  width: 360px; max-width: 90vw; background: var(--bg-panel); border-radius: var(--r-lg);
  border: 1px solid var(--border); box-shadow: var(--shadow-3); padding: 20px;
}
html[data-theme="dark"] .confirm { background: var(--bg-elevated); border-color: var(--border-strong); }
.cf-ico {
  width: 40px; height: 40px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent-deep);
  display: flex; align-items: center; justify-content: center; font-size: 20px; margin-bottom: 12px;
}
.cf-ico.danger { background: var(--danger-soft); color: var(--danger-text); }
.confirm h3 { font-size: 16px; font-weight: 650; margin-bottom: 6px; }
.cf-body { font-size: 13px; color: var(--text-2); line-height: 1.6; margin-bottom: 16px; user-select: text; }
.cf-foot { display: flex; justify-content: flex-end; gap: 8px; }
.prompt-field { width: 100%; }

.opml-progress {
  position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: var(--z-toast);
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); padding: 10px 14px; font-size: 12.5px; color: var(--text-1);
  display: flex; flex-direction: column; gap: 8px; min-width: 240px;
}
html[data-theme="dark"] .opml-progress { background: var(--bg-elevated); }
.opml-bar { height: 4px; border-radius: var(--r-full); background: var(--bg-hover); overflow: hidden; }
.opml-fill { height: 100%; background: var(--accent-strong); transition: width var(--t-med) var(--ease-out); }

.toasts {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: var(--z-toast);
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
}
.toast {
  background: var(--text-1); color: var(--bg-app);
  border-radius: var(--r-full); padding: 8px 14px; font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-2); display: flex; align-items: center; gap: 6px;
  animation: toast-in var(--t-med) var(--ease-out);
}
.toast.error { background: var(--danger); color: #fff; }
@keyframes toast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
</style>
