<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import Sidebar from "./components/Sidebar.vue";
import ArticleFlow from "./components/ArticleFlow.vue";
import ReaderPanel from "./components/ReaderPanel.vue";
import SettingsView from "./components/SettingsView.vue";
import RecommendView from "./components/RecommendView.vue";
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

let initPromise: Promise<void> | null = null;
let lastSubInputText = "";
let unsubs: Array<() => void> = [];

/** 初始化数据（单飞锁防重复加载；云同步与 7 项宿主事件统一由 preload/lifecycle.js 协调） */
async function initData() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await data.loadAll();
  })();
  try {
    await initPromise;
  } finally {
    if (!data.loaded) initPromise = null;
  }
}

/** 正文字号 4 档（tokens.css 的 --reading-fs 只有 16px 兜底，档位切换必须在此驱动） */
const FONT_STEPS = ["14px", "16px", "18px", "22px"];
watchEffect(() => {
  document.documentElement.style.setProperty("--reading-fs", FONT_STEPS[settings.fontLevel] ?? "16px");
});

// ---- 分离窗窄幅自适应 ----
const SB_NARROW_AT = 1080;
function onWinResize() {
  ui.winNarrow = window.innerWidth < SB_NARROW_AT;
}
const sbAuto = computed(() => ui.narrowDetached);
const sbCollapsedEff = computed(() => settings.sidebarCollapsed || sbAuto.value);

function wireSubInput() {
  try {
    utools.setSubInput((details: { text?: string } | string) => {
      const text = typeof details === "string" ? details : String(details?.text ?? "");
      lastSubInputText = text;
      if (data.search !== text) data.setSearch(text);
    }, "搜索文章…");
  } catch {
    /* 浏览器或分离窗无子输入框时忽略 */
  }
}

async function handleLifecycleAction(type: string, payload: any) {
  if (type === "detached") {
    ui.detached = true;
    onWinResize();
    try {
      utools.removeSubInput?.();
    } catch {
      /* noop */
    }
    return;
  }
  if (type === "open-add-feed") {
    ui.modal = { type: "addFeed", presetUrl: String(payload?.presetUrl || "") };
    return;
  }
  if (type === "open-item") {
    await initData();
    const id = String(payload?.itemId || "");
    const it = id ? data.items.find((x) => x._id === id) : null;
    if (it) {
      void data.markRead(it, true);
      ui.openReader(it._id);
    }
    return;
  }
  if (type === "switch-filter" && payload?.kind) {
    await initData();
    data.filter = { kind: payload.kind, value: payload.value };
    ui.cursor = 0;
    ui.view = "main";
  }
}

function wirePreloadLifecycle() {
  if (typeof window.airss?.on === "function") {
    unsubs.push(window.airss.on("open-add-feed", (p) => void handleLifecycleAction("open-add-feed", p)));
    unsubs.push(window.airss.on("open-item", (p) => void handleLifecycleAction("open-item", p)));
    unsubs.push(window.airss.on("switch-filter", (p) => void handleLifecycleAction("switch-filter", p)));
    unsubs.push(window.airss.on("detached", (p) => void handleLifecycleAction("detached", p)));
  }
}

// 侧栏搜索 / ⌫ 清空时反向同步主窗子输入框，避免顶部残留旧搜索词
watch(
  () => data.search,
  (val) => {
    if (val === lastSubInputText) return;
    lastSubInputText = val;
    if (ui.detached) return;
    try {
      utools.setSubInputValue?.(val);
    } catch {
      /* 分离窗或 mock 环境忽略 */
    }
  }
);

/** 逐级返回阶梯（⌫；2026-09-12 起 Esc 分支整体移除，含分离窗）：弹层 → sbDrawer → 文内搜索 → 关阅读 → 退设置 → 清搜索；返回是否消费 */
function backLadder(): boolean {
  if (ui.modal) {
    ui.modal = null;
    return true;
  }
  if (ui.sbDrawer) {
    ui.sbDrawer = false; // 窄幅侧栏抽屉：先于关阅读收抽屉
    return true;
  }
  if (ui.readerFind) {
    ui.readerFind = false; // 阅读文内搜索栏：先于关阅读（PLAN-READER-FIND 审核B6）
    return true;
  }
  if (ui.view === "reader" && !ui.detached) {
    ui.closeReader();
    return true;
  }
  if (ui.view === "recommend") {
    ui.view = "main"; // 推荐页返回列表（与设置页同级覆盖层，⌫ 一级退出）
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

  if (e.key === "Backspace" && !typing) {
    // ⌫ = 页内唯一返回/关闭键：主窗 Esc 被宿主优先消费（直接隐藏插件，页面拦不住，2026-09-05
    // 实机验证），2026-09-12 用户裁决 Esc 分支整体移除（含分离窗）统一 ⌫。输入态下 ⌫ 是编辑键，不参与返回。
    if (e.repeat) return; // 长按只走一级，防连跳整条阶梯
    if (backLadder()) e.preventDefault();
    return;
  }

  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    // 阅读态开文内搜索（PLAN-WHEEL-FIND：入口=Ctrl+F / AI 轮盘搜索项，轨内搜索钮已回归纯列表搜索）；
    // 顺关轨内面板防两搜索面并存，focusAt 自增驱动已开态重聚焦+全选（PLAN-WHEEL-FIND §2.5）
    if (ui.view === "reader" && ui.readerItemId) {
      ui.railSearch = false;
      ui.readerFind = true;
      ui.readerFindFocus++;
    } else {
      sidebarRef.value?.focusSearch();
    }
    return;
  }
  if (typing || ui.modal) return;

  // 推荐页是整幅覆盖层：列表导航键（j/k/Enter/m/s）不能穿透到背后的列表（设置页行为保持原样）
  if (ui.view === "recommend") return;

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

onMounted(async () => {
  settings.load();
  theme.init();
  wireSubInput();
  wirePreloadLifecycle();
  document.addEventListener("keydown", onKeydown);
  onWinResize();
  window.addEventListener("resize", onWinResize);

  const pending = window.airss.lifecycle?.consumePendingActions?.();
  if (pending?.detached) await handleLifecycleAction("detached", { detached: true });
  await initData();
  if (pending?.actions?.length) {
    for (const act of pending.actions) {
      await handleLifecycleAction(act.type, act.payload);
    }
  }

  // dev only：mock 层状态直达事件（uTools 内不会触发）
  window.addEventListener("airss-mock-view", (e) => {
    const v = (e as CustomEvent).detail;
    if (v === "settings") ui.view = "settings";
    else if (v === "recommend") ui.view = "recommend";
    else if (v === "addfeed") ui.modal = { type: "addFeed" };
    else if (v === "reader" && data.filtered[0]) {
      const it = data.filtered[0];
      void data.markRead(it, true);
      ui.openReader(it._id);
    }
  });
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWinResize);
  for (const off of unsubs) off();
  unsubs = [];
});
</script>

<template>
  <div class="app" :class="{ detached: ui.detached, 'sb-collapsed': sbCollapsedEff, 'sb-auto': sbAuto }">
    <Sidebar ref="sidebarRef" />

    <!-- 内容列（小窗：唯一主列，覆盖层承载阅读/设置） -->
    <div class="main-col">
      <ArticleFlow />
      <ReaderPanel v-if="ui.view === 'reader' && !ui.detached" />
      <SettingsView v-if="ui.view === 'settings' && !ui.detached" />
      <RecommendView v-if="ui.view === 'recommend' && !ui.detached" />
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
    <RecommendView v-if="ui.view === 'recommend' && ui.detached" />
  </div>

  <!-- 添加订阅弹层（进出场走全局 modal Transition 类，PLAN-POLISH A1） -->
  <Transition name="modal">
    <AddFeedModal v-if="ui.modal && ui.modal.type === 'addFeed'" :preset-url="ui.modal.presetUrl" />
  </Transition>

  <!-- 确认弹层（删除订阅/清空数据共用） -->
  <Transition name="modal">
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
          {{ ui.modal.okLabel || (ui.modal.danger ? "确认删除" : "确认") }}
        </button>
      </div>
    </div>
    </div>
  </Transition>

  <!-- 输入弹层（D1：分类重命名/合并；样式复用 confirm 骨架，suggestions 走 ComboboxInput 防 C17 弹层错位） -->
  <Transition name="modal">
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
      <input v-else class="input prompt-field" v-model="promptValue" :placeholder="ui.modal.placeholder" @keydown.enter="submitPrompt" />
      <div class="cf-foot">
        <button class="btn btn-ghost" @click="ui.modal = null">取消</button>
        <button class="btn btn-primary" :disabled="!promptValue.trim()" @click="submitPrompt">确定</button>
      </div>
    </div>
    </div>
  </Transition>

  <!-- OPML 导入进度条（fill 走 scaleX 合成器属性，PLAN-POLISH C2；width 过渡是逐帧布局） -->
  <div class="opml-progress" v-if="data.opmlImporting" role="status">
    <span>正在导入订阅 {{ data.opmlImporting.done }}/{{ data.opmlImporting.total }}…</span>
    <div class="opml-bar"><div class="opml-fill" :style="{ transform: 'scaleX(' + data.opmlImporting.done / Math.max(1, data.opmlImporting.total) + ')' }"></div></div>
  </div>

  <!-- toast（进出场/补位走全局 toast Transition 类，PLAN-POLISH A1） -->
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="{ error: t.kind === 'error' }" role="status">
        <I.alertTriangle v-if="t.kind === 'error'" />
        {{ t.text }}
      </div>
    </TransitionGroup>
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
/* 分离窗窄幅（视口 <1080）：三栏最小宽 280+360+440=1080 装不下，阅读列被 overflow:hidden
   裁出画（2026-09-11 实机：最大化三列正常，调回默认尺寸只剩两列）。侧栏自动降 64px 图标轨、
   列表/阅读列最低宽下调，三栏恒可见。同特异度按源序覆盖，规则必须排在 .sb-collapsed 之后；
   .reader-col 的 min-width 必须同步下调（track 定长 min 不吃 item min-width，二者不一致会溢出轨道） */
.app.detached.sb-auto {
  grid-template-columns: 64px minmax(300px, 400px) minmax(340px, 1fr);
}
.app.detached.sb-auto .reader-col { min-width: 340px; }
@media (max-width: 704px) {
  /* 极窄（≤704）：上一档地板 64+300+340=704 装不下时再压一档（地板 64+260+280=604；
     列表列下限取 260 非 240：240 在搜索态+静音透视+长标题组合下 compact 工具栏仍溢出 8px） */
  .app.detached.sb-auto { grid-template-columns: 64px minmax(260px, 360px) minmax(280px, 1fr); }
  .app.detached.sb-auto .reader-col { min-width: 280px; }
}
/* grid 子项不写 height:100%：靠默认 align-self:stretch 填满 minmax(0,1fr) 定高轨道。
   2026-09-08 实机：宿主 Chromium 对 grid 子项百分比高度的解析会回落 auto（内容高），
   正文滚动容器被撑成整文高度、永不溢出 → 滚轮无效；stretch 对内容免疫，勿改回百分比 */
.main-col { position: relative; min-width: 0; overflow: hidden; }
/* 分离窗三栏显式钉列：窄幅抽屉打开时 .sidebar 变 fixed 脱离网格流，若靠自动排布
   main-col/reader-col 会被重排进第 1 轨（64px），钉住后 64px 轨留空、被抽屉覆盖 */
.app.detached .main-col { grid-column: 2; }
.app.detached .reader-col { grid-column: 3; }
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
  box-shadow: var(--shadow-2); padding: 10px 14px; font-size: 12px; color: var(--text-1);
  display: flex; flex-direction: column; gap: 8px; min-width: 240px;
}
html[data-theme="dark"] .opml-progress { background: var(--bg-elevated); }
.opml-bar { height: 4px; border-radius: var(--r-full); background: var(--bg-hover); overflow: hidden; }
.opml-fill { height: 100%; width: 100%; background: var(--accent-strong); transform-origin: left; transition: transform var(--t-med) var(--ease-out); }

.toasts {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: var(--z-toast);
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
}
.toast {
  background: var(--text-1); color: var(--bg-app);
  border-radius: var(--r-full); padding: 8px 14px; font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-2); display: flex; align-items: center; gap: 6px;
}
.toast.error { background: var(--danger); color: #fff; }
/* 白 #fff 为跨配色恒定色豁免（红底白字，design-system 危险按钮规范） */
</style>
