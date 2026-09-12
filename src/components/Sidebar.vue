<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import { hostOf, firstChar } from "../lib/format";
import type { Feed } from "../types";
import EditFeedModal from "./EditFeedModal.vue";

const data = useDataStore();
const settings = useSettingsStore();
const ui = useUiStore();

const searchInput = ref<HTMLInputElement | null>(null);
const railSearchInput = ref<HTMLInputElement | null>(null);
/** Ctrl+F 入口：侧栏展开直focus；折叠态（含窄幅自动折叠）唤起轨内浮层搜索，不再静默落空 */
function focusSearch() {
  if (searchInput.value) {
    searchInput.value.focus();
    return;
  }
  if (collapsed.value) {
    ui.railSearch = true;
    nextTick(() => railSearchInput.value?.focus());
  }
}
defineExpose({ focusSearch });

/** 轨内搜索钮：折叠态列表搜索唯一入口（PLAN-WHEEL-FIND v1.7 撤阅读态改道——文内搜索入口=AI 轮盘第四项/Ctrl+F，
 *  侧栏族恒为列表搜索）。开面板顺关文内搜索：两搜索面双向互斥（S2 纪律，审核 P0-1）。
 *  已知局限：非分离窗阅读态列表被阅读层盖住，输入=无反馈过滤（⌫ 关阅读即见，同展开态搜索框 C20 记载）；
 *  data.search 无命中时 filtered 为空，阅读态 j/k/Enter/m/s 静默失效，清词恢复 */
function toggleRailSearch() {
  ui.railSearch = !ui.railSearch;
  if (ui.railSearch) {
    ui.readerFind = false;
    nextTick(() => railSearchInput.value?.focus());
  }
}

/** 轨内搜索输入框 ⌫：空时关面板，非空是编辑键（2026-09-12 Esc 全线换 ⌫，勿用 .prevent 修饰符——无条件生效会拦掉编辑态） */
function onRailSearchKey(e: KeyboardEvent) {
  if (e.key !== "Backspace" || data.search !== "") return;
  e.preventDefault();
  e.stopPropagation();
  ui.railSearch = false;
}

const menuOpenId = ref<string | null>(null);
const catMenuOpen = ref<string | null>(null);
const editingFeed = ref<Feed | null>(null);
const opmlFileInput = ref<HTMLInputElement | null>(null);

// ---- DnD 手动排序（PLAN-V1.3 D2）：HTML5 拖拽；重排零过渡（布局过渡会拖死渲染线程）----
const dragFrom = ref(-1);
const dragOver = ref(-1);
function onDragStart(i: number) {
  if (collapsed.value) return; // 折叠态禁拖（首字徽标形态无拖拽语义）
  dragFrom.value = i;
}
function onDragEnter(i: number) {
  if (dragFrom.value >= 0 && dragFrom.value !== i) dragOver.value = i;
}
async function onDrop(i: number) {
  const from = dragFrom.value;
  dragFrom.value = -1;
  dragOver.value = -1;
  if (from < 0 || from === i) return;
  await data.initOrderOnce(); // 首次拖拽：先按现序批量赋 order
  await data.moveFeed(from, i);
}

function select(kind: "all" | "unread" | "starred") {
  data.filter = { kind };
  ui.cursor = 0;
  navFold();
}
function selectFeed(f: Feed) {
  data.filter = { kind: "feed", value: f._id };
  ui.cursor = 0;
  navFold();
}
function selectCategory(name: string) {
  data.filter = { kind: "category", value: name };
  ui.cursor = 0;
  navFold();
}
function selectTag(name: string) {
  data.filter = { kind: "tag", value: name };
  ui.cursor = 0;
  navFold();
}

function toggleMenu(f: Feed) {
  menuOpenId.value = menuOpenId.value === f._id ? null : f._id;
}
function closeMenu() {
  menuOpenId.value = null;
  catMenuOpen.value = null;
}

// ---- 分类管理（PLAN-V1.3 D1）：重命名 / 合并 / 删除（成员归「默认」）----
function toggleCatMenu(name: string) {
  catMenuOpen.value = catMenuOpen.value === name ? null : name;
}
function renameCategory(name: string) {
  catMenuOpen.value = null;
  ui.modal = {
    type: "prompt",
    title: "重命名分类",
    label: `将「${name}」重命名为：`,
    initial: name,
    onOk: (v) => {
      if (!v || v === name) return;
      if (data.categories.some((c) => c.name === v)) {
        ui.toast(`已存在「${v}」分类，如需合并请用「合并到…」`, "error");
        return;
      }
      data.reassignCategory(name, v);
    },
  };
}
function mergeCategory(name: string) {
  catMenuOpen.value = null;
  const others = data.categories.map((c) => c.name).filter((n) => n !== name);
  if (!others.length) {
    ui.toast("没有其他分类可合并");
    return;
  }
  ui.modal = {
    type: "prompt",
    title: "合并分类",
    label: `将「${name}」的全部订阅合并到：`,
    suggestions: others,
    onOk: (v) => {
      if (v && v !== name) data.reassignCategory(name, v);
    },
  };
}
function askDeleteCategory(name: string) {
  catMenuOpen.value = null;
  const count = data.feeds.filter((f) => (f.category || "默认") === name).length;
  ui.modal = {
    type: "confirm",
    title: "删除分类？",
    body: `「${name}」的 ${count} 个订阅将移入「默认」分类，订阅与文章不受影响。`,
    onOk: () => data.reassignCategory(name, "默认"),
  };
}

function askDelete(f: Feed) {
  closeMenu();
  const count = data.items.filter((x) => x.feedKey === f._id).length;
  ui.modal = {
    type: "confirm",
    title: "删除订阅？",
    body: `将删除「${f.title}」及其 ${count} 篇文章（含星标），此操作不可恢复。`,
    danger: true,
    onOk: () => data.deleteFeed(f),
  };
}

async function onOpmlFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const text = await file.text();
  await data.importOpml(text);
}

/** 导入 OPML：uTools 宿主用原生文件对话框（HTML file input 在宿主内不可靠）；浏览器 dev 走 file input */
function pickOpml() {
  const ut = (window as any).utools;
  const isHost = ut && typeof ut.showOpenDialog === "function" && ut.getAppVersion && ut.getAppVersion() !== "browser-mock";
  if (isHost) {
    const picked = ut.showOpenDialog({
      title: "导入 OPML",
      filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      properties: ["openFile"],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) data.importOpml(window.airss.sys.readTextFile(path));
    return; // 取消选择：安静返回
  }
  opmlFileInput.value?.click();
}

function toggleCollapse() {
  settings.set("sidebarCollapsed", !settings.sidebarCollapsed);
}

/** 轨内展开钮：宽幅=写设置真展开；窄幅=开浮层抽屉（窗口装不下展开态三栏，280+300+340>800，不能占格） */
function onExpandClick() {
  if (autoNarrow.value) {
    ui.sbDrawer = true;
    nextTick(() => searchInput.value?.focus());
  } else {
    toggleCollapse();
  }
}
/** 展开态折叠钮：抽屉态=收抽屉（不动设置）；常规=写设置 */
function onCollapseClick() {
  if (drawerOpen.value) ui.sbDrawer = false;
  else toggleCollapse();
}

const onDocClick = () => closeMenu();
onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocClick));

const btnMuted = "sb-btn";
// 折叠态 = 用户设置 ∪ 分离窗窄幅自动（App.vue onWinResize 维护 winNarrow；自动折叠不写设置，拖宽即还原）
const autoNarrow = computed(() => ui.narrowDetached);
// 窄幅抽屉：展开改 fixed 浮层盖在列表列上方（网格不动），关闭即回图标轨
const drawerOpen = computed(() => autoNarrow.value && ui.sbDrawer);
const collapsed = computed(() => (settings.sidebarCollapsed || autoNarrow.value) && !drawerOpen.value);
// 侧栏展开时搜索回到常驻输入框，浮层态复位
watch(collapsed, (c) => {
  if (!c) ui.railSearch = false;
});
// 拖宽后侧栏回到常驻形态，抽屉失去存在意义，自动关
watch(autoNarrow, (n) => {
  if (!n) ui.sbDrawer = false;
});
/** 抽屉内的导航动作（选源/分类/标签/统计/进设置）完成后收抽屉 */
function navFold() {
  if (ui.sbDrawer) ui.sbDrawer = false;
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed, drawer: drawerOpen }" aria-label="订阅导航">
    <div class="sb-scroll">
      <!-- 品牌区 -->
      <div class="brand" v-if="!collapsed">
        <div class="brand-row">
          <h1 class="brand-name">AiRSS</h1>
          <span class="badge badge-accent">AI 驱动</span>
        </div>
        <div class="brand-sub">智能 RSS 阅读器</div>
      </div>
      <div class="brand-mini" v-else>A</div>
      <!-- 折叠轨搜索钮：分离窗 removeSubInput 后侧栏搜索框是唯一搜索入口（design-system §7），
           折叠态（手动/窄幅自动）下用浮层保住该入口，Ctrl+F 同路（focusSearch） -->
      <button v-if="collapsed" class="icon-btn rail-search-btn" aria-label="搜索" title="搜索" @click="toggleRailSearch"><I.search /></button>
      <Transition name="pop">
        <div class="rail-search-panel" v-if="collapsed && ui.railSearch" role="search" aria-label="搜索文章">
          <span class="search-ico"><I.search /></span>
          <input
            ref="railSearchInput"
            class="search-input"
            type="text"
            placeholder="搜索文章..."
            :value="data.search"
            @input="data.setSearch(($event.target as HTMLInputElement).value)"
            @keydown="onRailSearchKey"
            aria-label="搜索文章"
          />
          <span class="kbd">⌫</span>
        </div>
      </Transition>

      <!-- 搜索 -->
      <div class="search-wrap" v-if="!collapsed">
        <span class="search-ico"><I.search /></span>
        <input
          ref="searchInput"
          class="search-input"
          type="text"
          placeholder="搜索文章..."
          :value="data.search"
          @input="data.setSearch(($event.target as HTMLInputElement).value)"
          aria-label="搜索文章"
        />
        <span class="kbd">Ctrl+F</span>
      </div>

      <!-- 统计三卡 -->
      <div class="stats" v-if="!collapsed">
        <button class="stat" :class="{ on: data.filter.kind === 'all' }" @click="select('all')">
          <b class="num">{{ data.stats.total }}</b><span>所有文章</span>
        </button>
        <button class="stat" :class="{ on: data.filter.kind === 'unread' }" @click="select('unread')">
          <b class="num">{{ data.stats.unread }}</b><span>未读</span>
        </button>
        <button class="stat" :class="{ on: data.filter.kind === 'starred' }" @click="select('starred')">
          <b class="num">{{ data.stats.starred }}</b><span>收藏</span>
        </button>
      </div>

      <!-- 订阅源（D2：拖拽排序；指示线只动 border，禁一切布局过渡） -->
      <div class="sec-head" v-if="!collapsed">
        <span>订阅源</span>
        <button class="icon-btn add-btn" aria-label="添加订阅" @click="ui.modal = { type: 'addFeed' }"><I.plus /></button>
      </div>
      <div class="feed-list" role="list">
        <div
          v-for="(f, i) in data.feeds"
          :key="f._id"
          class="feed-item"
          :class="{ on: data.filter.kind === 'feed' && data.filter.value === f._id, 'drop-before': dragOver === i && dragFrom < i, 'drop-after': dragOver === i && dragFrom > i, dragging: dragFrom === i }"
          role="listitem"
          tabindex="0"
          :draggable="!collapsed"
          @click="selectFeed(f)"
          @keydown.enter="selectFeed(f)"
          @dragstart="onDragStart(i)"
          @dragenter.prevent="onDragEnter(i)"
          @dragover.prevent
          @drop.prevent="onDrop(i)"
          @dragend="dragFrom = -1; dragOver = -1"
        >
          <template v-if="!collapsed">
            <div class="fi-body">
              <div class="fi-main ellipsis">{{ f.title }}</div>
              <div class="fi-sub ellipsis">{{ f.titleEn || hostOf(f.url) }}</div>
            </div>
            <span v-if="f.lastError" class="err-dot" :title="'同步失败：' + f.lastError"></span>
            <span v-if="f.unreadCount" class="fi-count num">{{ f.unreadCount }}</span>
            <Transition name="pop">
              <div class="fi-menu" v-if="menuOpenId === f._id" @click.stop>
              <button class="menu-item" @click="editingFeed = f; menuOpenId = null"><I.edit />编辑订阅</button>
              <button class="menu-item" v-if="f.lastError" @click="data.retryFeed(f); menuOpenId = null"><I.refresh />重试同步</button>
              <button class="menu-item danger" @click="askDelete(f)"><I.trash />删除订阅</button>
              </div>
            </Transition>
            <button class="fi-more icon-btn" aria-label="订阅源操作" @click.stop="toggleMenu(f)"><I.moreVertical /></button>
          </template>
          <template v-else>
            <span class="fi-badge" :class="{ unread: f.unreadCount }">{{ firstChar(f.title) }}</span>
            <span v-if="f.lastError" class="err-dot"></span>
          </template>
        </div>
      </div>

      <!-- 分类（D1：⋯ 菜单 = 重命名/合并/删除） -->
      <div class="sec-head" v-if="!collapsed"><span>分类</span></div>
      <div class="cat-list" v-if="!collapsed">
        <div v-for="c in data.categories" :key="c.name" class="cat-row">
          <button
            class="cat-item"
            :class="{ on: data.filter.kind === 'category' && data.filter.value === c.name }"
            @click="selectCategory(c.name)"
          >
            <span class="ellipsis">{{ c.name }}</span>
            <span class="num cat-count" v-if="c.unread">{{ c.unread }}</span>
          </button>
          <button class="cat-more icon-btn" aria-label="分类操作" @click.stop="toggleCatMenu(c.name)"><I.moreVertical /></button>
          <Transition name="pop">
            <div class="fi-menu cat-menu" v-if="catMenuOpen === c.name" @click.stop>
              <button class="menu-item" @click="renameCategory(c.name)"><I.edit />重命名</button>
              <button class="menu-item" @click="mergeCategory(c.name)"><I.chevronRight />合并到…</button>
              <!-- 「默认」是兜底分类，删除即空操作（D 送审必修）：不提供入口 -->
              <button v-if="c.name !== '默认'" class="menu-item danger" @click="askDeleteCategory(c.name)"><I.trash />删除分类</button>
            </div>
          </Transition>
        </div>
      </div>

      <!-- 标签（PLAN-V1.3 C）：AI 产物入口；无任何 tags 整区不渲染（AI 关闭用户不见空白）；
           折叠态与分类区一致不渲染 -->
      <template v-if="!collapsed && data.topTags.length">
        <div class="sec-head"><span>标签</span></div>
        <div class="tag-cloud">
          <button
            v-for="t in data.topTags"
            :key="t.name"
            class="cloud-tag"
            :class="{ on: data.filter.kind === 'tag' && data.filter.value === t.name }"
            :title="'按标签「' + t.name + '」过滤'"
            @click="selectTag(t.name)"
          >
            <span class="ellipsis">{{ t.name }}</span>
            <span class="num">{{ t.count }}</span>
          </button>
        </div>
      </template>
    </div>

    <!-- 底部按钮 -->
    <div class="sb-footer" :class="{ collapsed }">
      <template v-if="!collapsed">
        <button :class="btnMuted" @click="pickOpml()"><I.upload />导入OPML</button>
        <button :class="btnMuted" @click="navFold(); ui.openSettings()"><I.settings />设置</button>
        <button class="sb-btn sb-toggle" aria-label="折叠侧栏" aria-expanded="true" title="折叠侧栏" @click="onCollapseClick"><I.chevronLeft /></button>
      </template>
      <template v-else>
        <button class="icon-btn" aria-label="导入OPML" title="导入OPML" @click="pickOpml()"><I.upload /></button>
        <button class="icon-btn" aria-label="设置" title="设置" @click="ui.openSettings()"><I.settings /></button>
        <!-- 窄幅：展开=浮层抽屉（onExpandClick，不占格不写设置）；宽幅仍是设置开关 -->
        <button class="icon-btn" aria-label="展开侧栏" title="展开侧栏" @click="onExpandClick"><I.chevronRight /></button>
      </template>
      <input ref="opmlFileInput" type="file" accept=".xml,.opml,text/xml,text/x-opml" hidden @change="onOpmlFile" />
    </div>
  </aside>

  <!-- 窄幅抽屉背板：点外关闭（z 阶 §3.8：背板 --z-scrim，抽屉在其上 1 级、仍低于 modal——抽屉里发起的删除确认等弹层必须盖住抽屉） -->
  <Transition name="fade">
    <div class="sb-drawer-scrim" v-if="drawerOpen" @click="ui.sbDrawer = false"></div>
  </Transition>

  <Transition name="modal">
    <EditFeedModal v-if="editingFeed" :feed="editingFeed" @close="editingFeed = null" />
  </Transition>
</template>

<style scoped>
.sidebar {
  width: 280px;
  /* 不写 height:100%：grid 子项靠默认 align-self:stretch 填满定高轨道（App.vue .main-col 注释同源，宿主百分比解析坑） */
  background: var(--bg-app);
  display: flex;
  flex-direction: column;
  position: relative;
  border-right: 1px solid var(--border);
  overflow: hidden;
  flex-shrink: 0;
}
.sidebar.collapsed { width: 64px; }

/* 窄幅抽屉态（ui.sbDrawer，2026-09-12 实机：上一版把窄幅展开钮藏掉防死键，侧栏被永久锁死在图标轨——
   用户打不开侧栏）。侧栏脱离网格流浮起盖在列表列上方（64px 轨留空、被抽屉覆盖），关闭即回图标轨。
   前提：App.vue 已给 .main-col/.reader-col 显式 grid-column——fixed 脱流后剩余子项会被自动排进第 1 轨 */
.sidebar.drawer {
  position: fixed; left: 0; top: 0; bottom: 0;
  z-index: calc(var(--z-scrim) + 1);
  box-shadow: var(--shadow-3);
  border-right: 1px solid var(--border-strong);
  animation: sb-drawer-in var(--t-fast) var(--ease-out);
}
@keyframes sb-drawer-in {
  from { transform: translateX(-12px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
.sb-drawer-scrim { position: fixed; inset: 0; z-index: var(--z-scrim); background: var(--scrim); }

.sb-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 16px 16px 8px; }

.brand-row { display: flex; align-items: center; gap: 8px; }
.brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.brand-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.brand-mini {
  width: 28px; height: 28px; border-radius: var(--r-sm);
  background: var(--accent); color: var(--accent-ink);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 15px; margin-bottom: 12px;
}
/* 折叠轨搜索钮：与 brand-mini 同宽轨内排布 */
.rail-search-btn { margin-bottom: 12px; }
/* 轨内浮层搜索面板：fixed 逃脱侧栏 overflow:hidden（C17 弹层纪律，原生层不参与）；
   紧贴轨右侧、与搜索钮（16 顶距 + 28 logo + 12 间距 = 56）对齐 */
.rail-search-panel {
  position: fixed; top: 56px; left: 72px; z-index: var(--z-dropdown);
  width: min(240px, calc(100vw - 80px));
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); height: 36px;
  display: flex; align-items: center; gap: 8px; padding: 0 8px 0 10px;
}
html[data-theme="dark"] .rail-search-panel { background: var(--bg-elevated); }
.rail-search-panel:focus-within { border-color: transparent; box-shadow: var(--ring); }

.search-wrap {
  position: relative; margin-top: 16px;
  background: var(--bg-panel); border: 1px solid var(--border-strong);
  border-radius: var(--r-md); height: 36px;
  display: flex; align-items: center; gap: 8px; padding: 0 8px 0 10px;
  transition: box-shadow var(--t-fast) var(--ease-out);
}
.search-wrap:focus-within { border-color: transparent; box-shadow: var(--ring); }
.search-ico { color: var(--text-3); display: flex; font-size: 15px; }
.search-input { border: none; outline: none; background: transparent; flex: 1; min-width: 0; font-size: 13px; color: var(--text-1); font-family: inherit; }
.search-input::placeholder { color: var(--text-3); }

.stats { display: flex; gap: 8px; margin-top: 12px; }
.stat {
  flex: 1; height: 56px; border-radius: var(--r-md);
  background: var(--bg-panel); border: 1px solid var(--border); box-shadow: var(--shadow-1);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  cursor: pointer; font-family: inherit; transition: background var(--t-fast) var(--ease-out);
}
.stat b { font-size: 20px; font-weight: 700; color: var(--accent-deep); line-height: 1.1; }
.stat span { font-size: 11px; color: var(--text-3); }
.stat:hover { background: var(--bg-card-hover); }
.stat.on { background: var(--bg-selected); border-color: transparent; }
.stat:active { background: var(--bg-active); }

.sec-head {
  display: flex; align-items: center; justify-content: space-between;
  margin: 20px 0 6px; font-size: 12px; font-weight: 600; color: var(--text-2);
}
.add-btn { background: var(--accent); color: var(--accent-ink); width: 26px; height: 26px; }
.add-btn:hover { background: var(--accent-hover); }
.add-btn:active { background: var(--accent-active); } /* 主按钮变体按下走 accent-active（C1） */

.feed-item {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  min-height: 44px; padding: 6px 10px; border-radius: var(--r-md);
  cursor: pointer; color: var(--text-1); transition: background var(--t-fast) var(--ease-out);
}
.feed-item:hover { background: var(--bg-hover); }
.feed-item.on { background: var(--bg-selected); }
.feed-item.on .fi-main, .feed-item.on .fi-count { color: var(--accent-deep); }
.feed-item:active { background: var(--bg-active); }
.fi-body { flex: 1; min-width: 0; }
.fi-main { font-size: 13px; font-weight: 500; line-height: 1.3; }
.fi-sub { font-size: 11px; color: var(--text-3); margin-top: 1px; }
.fi-count { font-size: 12px; font-weight: 600; color: var(--text-2); }
.err-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--danger);
  box-shadow: 0 0 0 2px var(--bg-app); flex-shrink: 0;
}
.fi-more { opacity: 0; width: 24px; height: 24px; flex-shrink: 0; }
.feed-item:hover .fi-more, .feed-item:focus-visible .fi-more { opacity: 1; }
.feed-item.on .fi-more { opacity: 1; }

.fi-menu {
  position: absolute; right: 8px; top: calc(100% - 4px); z-index: var(--z-dropdown);
  min-width: 132px; background: var(--bg-panel); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); border: 1px solid var(--border); padding: 4px;
}
html[data-theme="dark"] .fi-menu { background: var(--bg-elevated); }
.menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  height: 32px; padding: 0 10px; border: none; background: transparent; border-radius: var(--r-sm);
  font-size: 13px; color: var(--text-1); font-family: inherit; cursor: pointer;
}
.menu-item:hover { background: var(--bg-hover); }
.menu-item:active { background: var(--bg-active); }
.menu-item.danger { color: var(--danger-text); }

.collapsed .feed-list { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.fi-badge {
  width: 28px; height: 28px; border-radius: var(--r-sm);
  background: var(--bg-selected); color: var(--accent-deep);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; position: relative;
}
.fi-badge.unread::after {
  content: ""; position: absolute; right: -2px; bottom: -2px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent-strong); border: 2px solid var(--bg-app);
}

.cat-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: var(--r-md);
  border: none; background: transparent; font-family: inherit; font-size:  13px; font-weight: 500;
  color: var(--text-1); cursor: pointer; transition: background var(--t-fast) var(--ease-out);
}
.cat-item:hover { background: var(--bg-hover); }
.cat-item.on { background: var(--bg-selected); color: var(--accent-deep); }
.cat-item:active { background: var(--bg-active); }
.cat-count { font-size: 12px; color: var(--text-3); font-weight: 600; }
.cat-item.on .cat-count { color: var(--accent-deep); }

/* 分类行（D1）：项 + ⋯ 菜单 */
.cat-row { position: relative; display: flex; align-items: center; }
.cat-more { opacity: 0; width: 22px; height: 22px; flex-shrink: 0; font-size: 13px; }
.cat-row:hover .cat-more, .cat-row:focus-within .cat-more { opacity: 1; }
.cat-menu { right: 4px; top: calc(100% - 2px); }

/* DnD 拖拽视觉（D2）：仅边框色/指示线，禁一切布局过渡（铁律） */
.feed-item.dragging { opacity: 0.45; }
.feed-item.drop-before { box-shadow: inset 0 2px 0 var(--accent-strong); }
.feed-item.drop-after { box-shadow: inset 0 -2px 0 var(--accent-strong); }

/* 标签云（C）：芯片样式与 ai-tag 同族 */
.tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.cloud-tag {
  display: inline-flex; align-items: center; gap: 5px;
  max-width: 100%; padding: 2px 9px; border-radius: var(--r-full);
  border: 1px solid var(--border); background: transparent;
  font-family: inherit; font-size: 11.5px; font-weight: 600; color: var(--text-2);
  cursor: pointer; transition: background var(--t-fast) var(--ease-out);
}
.cloud-tag > span:first-child { min-width: 0; }
.cloud-tag .num { font-size: 10px; color: var(--text-3); font-weight: 500; }
.cloud-tag:hover { background: var(--bg-hover); }
.cloud-tag.on { background: var(--bg-selected); color: var(--accent-deep); border-color: transparent; }
.cloud-tag.on .num { color: var(--accent-deep); }
.cloud-tag:active { background: var(--bg-active); }

.sb-footer {
  display: flex; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--border); flex-shrink: 0;
}
.sb-btn {
  flex: 1; height: 32px; border: none; border-radius: var(--r-md);
  background: var(--bg-btn-muted); color: var(--text-2);
  font-family: inherit; font-size: 12px; font-weight: 500;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; transition: background var(--t-fast) var(--ease-out);
}
.sb-btn:hover { background: var(--bg-btn-muted-hover); color: var(--text-1); }
.sb-btn:active { background: var(--bg-active); }
.sb-footer.collapsed { flex-direction: column; align-items: stretch; padding: 12px 14px; }

.sb-toggle { flex: 0 0 32px; padding: 0; }
</style>
