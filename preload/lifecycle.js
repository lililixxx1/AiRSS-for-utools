// @ts-check
/**
 * lifecycle.js — uTools 8.0+ 生命周期统一注册与快捷入口协调
 *
 * 官方规范：7 项事件（onPluginReady / Enter / Out / Detach / DbPull / ScheduleTrigger / MainPush）
 * 每个插件应用仅在此处注册一次；渲染层只订阅 events 与 consumePendingActions()。
 */
const logger = require("./services/logger.js");
const aiSvc = require("./services/ai.js");
const storage = require("./core/storage.js");
const migrate = require("./core/migrate.js");
const readService = require("./core/readService.js");
const refreshService = require("./core/refreshService.js");
const laterService = require("./core/laterService.js");
const events = require("./core/events.js");
const { ut } = require("./core/utils.js");

const GLOBAL_SEARCH_CODE = "airss_search";

let registered = false;
let readyRan = false;
let detachedState = false;
let pendingOpenItemId = null;
/** @type {Array<{ type: string, payload: any }>} */
const pendingUiActions = [];
/** @type {Map<string, string | null>} mainPush 展示文本 -> itemId */
const lastPushMap = new Map();

function queueOrEmit(type, payload) {
  pendingUiActions.push({ type, payload });
  if (pendingUiActions.length > 20) pendingUiActions.shift();
  events.emit(type, payload);
}

function consumePendingActions() {
  const copy = pendingUiActions.slice();
  pendingUiActions.length = 0;
  return { actions: copy, detached: detachedState };
}

function handleMainPush(action) {
  lastPushMap.clear();
  const code = action && action.code;

  if (code === GLOBAL_SEARCH_CODE) {
    const query = String((action && action.payload) || "").trim();
    if (!query) return [];
    const hits = readService.searchForMainPushSync(query, 5);
    if (!hits.length) return [];
    return hits.map((h, idx) => {
      const label = h.title.length > 52 ? h.title.slice(0, 52) + "…" : h.title;
      const uniqueText = lastPushMap.has(label) ? `${label} (${idx + 1})` : label;
      lastPushMap.set(uniqueText, h._id);
      return {
        icon: "logo.png",
        text: uniqueText,
        title: `${h.feedTitle} · ${h.relTime}`,
      };
    });
  }

  // 默认 airss feature：第 1 条总览 + 最多 4 条最新未读文章直达
  const { unreadTotal, items } = readService.getUnreadTopSync(4);
  if (unreadTotal <= 0) {
    const zeroText = "进入 AiRSS（暂无未读文章）";
    lastPushMap.set(zeroText, null);
    return [{ icon: "logo.png", title: "AiRSS", text: zeroText }];
  }

  const results = [];
  const headText = `进入 AiRSS · 共 ${unreadTotal} 篇未读`;
  lastPushMap.set(headText, null);
  results.push({ icon: "logo.png", title: "AiRSS", text: headText });

  items.forEach((h, idx) => {
    const label = h.title.length > 50 ? h.title.slice(0, 50) + "…" : h.title;
    const uniqueText = lastPushMap.has(label) ? `${label} (${idx + 1})` : label;
    lastPushMap.set(uniqueText, h._id);
    results.push({
      icon: "logo.png",
      text: uniqueText,
      title: `${h.feedTitle} · ${h.relTime}`,
    });
  });
  return results;
}

function handleMainPushSelect(action) {
  const optText = action && action.option && action.option.text;
  if (optText && lastPushMap.has(optText)) {
    const targetId = lastPushMap.get(optText);
    if (targetId) pendingOpenItemId = targetId;
  }
  return true;
}

async function onReady() {
  if (readyRan) return;
  readyRan = true;
  await storage.init();
  await migrate.runPhase1IfNeeded();
}

async function onEnter(action = {}) {
  const code = action.code || "airss";
  const payload = action.payload;
  const from = action.from || "main";

  // UI 动作在第一个 await 前同步入队，避免冷启动挂载竞态
  let targetId = pendingOpenItemId;
  pendingOpenItemId = null;
  if (!targetId && action.option && action.option.text && lastPushMap.has(action.option.text)) {
    targetId = lastPushMap.get(action.option.text) || null;
  }

  if (code === "add_feed" && payload) {
    queueOrEmit("open-add-feed", { presetUrl: String(payload) });
    await onReady();
    await storage.ensureInit();
    return { handled: "add_feed" };
  }

  if (code !== "save_later") {
    if (targetId) {
      queueOrEmit("open-item", { itemId: targetId });
    } else if (from === "hotkey" || from === "panel") {
      queueOrEmit("switch-filter", { kind: "unread" });
    }
  }

  await onReady();
  await storage.ensureInit();

  if (code === "save_later" && payload) {
    // 若用户从主搜索框（而非超级面板/快捷键）点进 save_later，主动收起窗口保持无干扰体验
    if (from === "main") {
      try {
        const u = ut();
        if (u && typeof u.hideMainWindow === "function") u.hideMainWindow();
      } catch (_) { /* ignore */ }
    }
    return laterService.saveUrl(String(payload));
  }

  // 打开即增量刷新（不阻塞进入）
  if (!refreshService.isRefreshing()) {
    void refreshService.refreshDue({ manual: false, trigger: "enter" });
  }
  return { handled: code, opened: targetId || null };
}

function onOut(isKill) {
  if (isKill) {
    refreshService.abort();
    aiSvc.abort();
  }
  storage.flush();
  aiSvc.flush();
}

function isGlobalSearchEnabled() {
  const u = ut();
  if (!u || typeof u.getFeatures !== "function") return false;
  try {
    const list = u.getFeatures([GLOBAL_SEARCH_CODE]);
    return Array.isArray(list) && list.some((f) => f && f.code === GLOBAL_SEARCH_CODE);
  } catch (_) {
    return false;
  }
}

function setGlobalSearchEnabled(enabled) {
  const u = ut();
  if (!u) return false;
  if (enabled && typeof u.setFeature === "function") {
    u.setFeature({
      code: GLOBAL_SEARCH_CODE,
      description: "在 AiRSS 本地订阅库中实时检索文章",
      mainPush: true,
      cmds: [
        {
          type: "over",
          label: "搜索 AiRSS 文章",
          exclude: "/\\n/",
          minLength: 2,
          maxLength: 60,
        },
      ],
    });
    logger.info("features", "已开启全局 mainPush 搜索");
  } else if (!enabled && typeof u.removeFeature === "function") {
    try {
      u.removeFeature(GLOBAL_SEARCH_CODE);
    } catch (_) { /* ignore */ }
    logger.info("features", "已关闭全局 mainPush 搜索");
  }
  return isGlobalSearchEnabled();
}

function register() {
  if (registered) return;
  const u = ut();
  if (!u) return;
  registered = true;

  if (typeof u.onPluginReady === "function") {
    u.onPluginReady(() => onReady());
  }
  if (typeof u.onPluginEnter === "function") {
    u.onPluginEnter((action) => onEnter(action));
  }
  if (typeof u.onPluginOut === "function") {
    u.onPluginOut((isKill) => onOut(isKill));
  }
  if (typeof u.onPluginDetach === "function") {
    u.onPluginDetach(() => {
      detachedState = true;
      events.emit("detached", { detached: true });
    });
  }
  if (typeof u.onDbPull === "function") {
    u.onDbPull((docs) => {
      void storage.applyPullDocs(docs);
    });
  }
  if (typeof u.onScheduleTrigger === "function") {
    u.onScheduleTrigger(({ code }) => {
      if (code === refreshService.SCHEDULE_CODE) {
        return refreshService.runScheduled();
      }
      return undefined;
    });
  }
  if (typeof u.onMainPush === "function") {
    u.onMainPush(handleMainPush, handleMainPushSelect);
  }
}

function resetForTest() {
  registered = false;
  readyRan = false;
  detachedState = false;
  pendingOpenItemId = null;
  pendingUiActions.length = 0;
  lastPushMap.clear();
  events.clear();
}

module.exports = {
  GLOBAL_SEARCH_CODE,
  register,
  onReady,
  onEnter,
  onOut,
  handleMainPush,
  handleMainPushSelect,
  consumePendingActions,
  isGlobalSearchEnabled,
  setGlobalSearchEnabled,
  resetForTest,
};
