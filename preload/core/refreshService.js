// @ts-check
/**
 * refreshService.js — 刷新、保留清理、汇总通知与 uTools 8.0 后台定时任务编排
 *
 * 从 src/stores/data.ts 下沉至此，保证：
 * - onScheduleTrigger 无窗后台路径与 UI 前台刷新复用完全相同的业务链路
 * - 多源更新汇总为单条系统通知，避免通知轰炸
 * - 后台定时默认不触发 AI 批（需显式开启 scheduleAiBatch）
 */
const schedulerSvc = require("../services/scheduler.js");
const aiSvc = require("../services/ai.js");
const logger = require("../services/logger.js");
const storage = require("./storage.js");
const events = require("./events.js");
const { ut, store, plainClone } = require("./utils.js");

const SCHEDULE_CODE = "airss-refresh";
const SCHEDULE_LABEL = "AiRSS 定时刷新订阅";
const SETTINGS_KEY = "airss:settings";

let activePromise = null;

function readSettings() {
  const defaults = {
    refreshMin: 30,
    keepPerFeed: 200,
    notifyEnabled: true,
    aiEnabled: false,
    aiAutoCount: 0,
    scheduleAiBatch: false,
  };
  try {
    const kv = store();
    const raw = kv ? kv.getItem(SETTINGS_KEY) : null;
    if (raw && typeof raw === "object") return { ...defaults, ...raw };
  } catch (_) { /* ignore */ }
  return defaults;
}

function isRefreshing() {
  return !!activePromise;
}

function abort() {
  schedulerSvc.abort();
}

async function runBatchAi(trigger, settings) {
  if (!settings.aiEnabled) return;
  if (trigger === "schedule") {
    if (!settings.scheduleAiBatch) return;
  } else if (Number(settings.aiAutoCount) === 0) {
    return;
  }
  const items = await storage.snapshotItems();
  const weekAgo = Date.now() - 7 * 86400e3;
  const pending = items.filter((x) => x.aiStatus === "none" && (x.pubTs || 0) > weekAgo).slice(0, 20);
  if (!pending.length) return;
  try {
    await aiSvc.batchEnrich(pending);
  } catch (_) {
    /* 后台 AI 失败不阻塞刷新主流程 */
  }
}

/**
 * 刷新到期订阅源（manual=true 刷新全部；trigger="enter"|"manual"|"schedule"）
 * @param {{ manual?: boolean, trigger?: string }} [opts]
 */
async function refreshDue(opts = {}) {
  if (activePromise) return activePromise;

  const manual = !!opts.manual;
  const trigger = opts.trigger || (manual ? "manual" : "enter");

  activePromise = (async () => {
    await storage.ensureInit();
    const settings = readSettings();
    const feeds = await storage.getFeeds();
    const now = Date.now();

    const due = feeds.filter((f) => {
      if (f.special === "later" || f._id === "feed:__later__") return false;
      if (manual) return true;
      const min = f.refreshMin > 0 ? f.refreshMin : settings.refreshMin;
      return !f.lastFetchedAt || now - f.lastFetchedAt > min * 60000;
    });

    if (!due.length) {
      return { total: 0, done: 0, ok: 0, failed: 0, skipped: 0, newItems: 0, notifiedFeeds: 0 };
    }

    let done = 0;
    const total = due.length;
    const updatedFeedNames = [];
    let notifiedNewItems = 0;

    events.emit("refresh-progress", { refreshing: true, done: 0, total });

    const summary = await schedulerSvc.refreshFeeds(due, {
      onFeedDone: (feed, result) => {
        done += 1;
        events.emit("refresh-progress", {
          refreshing: true,
          done,
          total,
          feed: plainClone(feed),
          result,
        });
        if (result && result.ok && result.newCount > 0 && feed.notify) {
          updatedFeedNames.push(feed.title || feed.url);
          notifiedNewItems += result.newCount;
        }
      },
    });

    // 按需保留清理：仅非星标计数超 keepPerFeed 的源触发
    const keep = Number(settings.keepPerFeed) > 0 ? Number(settings.keepPerFeed) : 200;
    const items = await storage.snapshotItems();
    const nonStarred = new Map();
    for (const x of items) {
      if (x.starred) continue;
      nonStarred.set(x.feedKey, (nonStarred.get(x.feedKey) || 0) + 1);
    }
    for (const f of feeds) {
      if ((nonStarred.get(f._id) || 0) > keep) {
        await storage.retentionClean(f, keep);
      }
    }

    // 汇总单条系统通知
    if (settings.notifyEnabled && notifiedNewItems > 0) {
      const u = ut();
      if (u && typeof u.showNotification === "function") {
        const msg =
          updatedFeedNames.length === 1
            ? `${updatedFeedNames[0]}：${notifiedNewItems} 篇新文章`
            : `AiRSS 更新：${updatedFeedNames.length} 个源共 ${notifiedNewItems} 篇新文章`;
        try {
          u.showNotification(msg, "airss");
        } catch (_) { /* ignore */ }
      }
    }

    // 后台 AI 轻量批（定时模式受独立开关门控）
    if (trigger === "schedule") {
      await runBatchAi(trigger, settings);
    } else {
      void runBatchAi(trigger, settings);
    }

    storage.flush();
    aiSvc.flush();
    events.emit("refresh-progress", { refreshing: false, done: total, total });
    events.emit("feeds-changed", { kind: "refresh", trigger });
    events.emit("items-changed", { kind: "refresh", trigger, newItems: summary.newItems });

    return { ...summary, notifiedFeeds: updatedFeedNames.length };
  })();

  try {
    return await activePromise;
  } finally {
    activePromise = null;
  }
}

async function refreshOne(feedOrId) {
  await storage.ensureInit();
  const feedDoc = typeof feedOrId === "string" ? await storage.getFeed(feedOrId) : feedOrId;
  if (!feedDoc) return { ok: false, status: "error", newCount: 0, error: "NOT_FOUND" };
  const result = await schedulerSvc.refreshOne(feedDoc);
  const settings = readSettings();
  void runBatchAi("manual", settings);
  storage.flush();
  events.emit("feeds-changed", { kind: "refresh-one", feedId: feedDoc._id });
  events.emit("items-changed", { kind: "refresh-one", feedId: feedDoc._id, newCount: result.newCount });
  return result;
}

// ---------------------------------------------------------------------------
// uTools 8.0 定时任务管理（requestSchedule / getSchedules / removeSchedule）
// ---------------------------------------------------------------------------

function getScheduleStatus() {
  const u = ut();
  const supported = !!(u && typeof u.requestSchedule === "function" && typeof u.getSchedules === "function");
  if (!supported) return { supported: false, enabled: false, schedule: null };
  try {
    const list = u.getSchedules() || [];
    const found = Array.isArray(list) ? list.find((s) => s && s.code === SCHEDULE_CODE) : null;
    return { supported: true, enabled: !!found, schedule: found || null };
  } catch (_) {
    return { supported: true, enabled: false, schedule: null };
  }
}

async function enableSchedule(cron = "*/30 * * * *") {
  const u = ut();
  if (!u || typeof u.requestSchedule !== "function") {
    return { ok: false, rejected: false, error: "SCHEDULE_UNSUPPORTED", status: getScheduleStatus() };
  }
  const cleanCron = String(cron || "").trim().split(/\s+/).length === 5 ? String(cron).trim() : "*/30 * * * *";
  try {
    if (typeof u.removeSchedule === "function") u.removeSchedule(SCHEDULE_CODE);
  } catch (_) { /* 不存在时忽略 */ }

  await u.requestSchedule({
    code: SCHEDULE_CODE,
    label: SCHEDULE_LABEL,
    trigger: { cron: cleanCron },
  });

  const status = getScheduleStatus();
  logger.info("schedule", "请求创建定时刷新", { cron: cleanCron, granted: status.enabled });
  return { ok: status.enabled, rejected: !status.enabled, error: status.enabled ? null : "USER_REJECTED", status };
}

function disableSchedule() {
  const u = ut();
  try {
    if (u && typeof u.removeSchedule === "function") u.removeSchedule(SCHEDULE_CODE);
  } catch (_) { /* 不存在时忽略 */ }
  const status = getScheduleStatus();
  logger.info("schedule", "已取消定时刷新", { enabled: status.enabled });
  return { ok: !status.enabled, status };
}

/** onScheduleTrigger 执行入口（失败向上抛错以记录 failureCount） */
async function runScheduled() {
  logger.info("schedule", "后台定时刷新触发");
  const summary = await refreshDue({ manual: false, trigger: "schedule" });
  storage.flush();
  aiSvc.flush();
  return summary;
}

module.exports = {
  SCHEDULE_CODE,
  isRefreshing,
  abort,
  refreshDue,
  refreshOne,
  getScheduleStatus,
  enableSchedule,
  disableSchedule,
  runScheduled,
};
