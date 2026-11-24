// @ts-check
/**
 * AiRSS preload 入口 — 挂载 window.airss 并完成 uTools 8.0+ 单次生命周期注册
 *
 * uTools 规范：本目录（preload/）源码直供、不打包不压缩；node_modules 原样随包。
 */
const { Buffer } = require("buffer");
if (typeof globalThis !== "undefined" && typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
const fs = require("fs");
const dbSvc = require("./services/db.js");
const feedSvc = require("./services/feed.js");
const articleSvc = require("./services/article.js");
const extractSvc = require("./services/extract.js");
const opmlSvc = require("./services/opml.js");
const aiSvc = require("./services/ai.js");
const loggerSvc = require("./services/logger.js");

const events = require("./core/events.js");
const readService = require("./core/readService.js");
const refreshService = require("./core/refreshService.js");
const laterService = require("./core/laterService.js");
const lifecycleMgr = require("./lifecycle.js");
const { ut, newFeedId, feedUrlKey } = require("./core/utils.js");

/**
 * 新建订阅源并写入同步库
 * @param {{ url: string, title?: string, category?: string, fullText?: boolean, refreshMin?: number, siteUrl?: string, desc?: string }} opts
 */
async function createFeed({ url, title, category, fullText, refreshMin, siteUrl, desc }) {
  const doc = {
    _id: newFeedId(),
    url,
    urlKey: feedUrlKey(url),
    title: title || url,
    titleEn: "",
    category: category || "默认",
    siteUrl: siteUrl || "",
    desc: desc || "",
    ...(fullText ? { fullText: true } : {}),
    etag: "",
    lastModified: "",
    lastFetchedAt: null,
    refreshMin: refreshMin || 0,
    unreadCount: 0,
    lastError: "",
    notify: true,
    createdAt: Date.now(),
  };
  await dbSvc.saveFeed(doc);
  events.emit("feeds-changed", { kind: "created", feed: doc });
  return doc;
}

const airss = {
  // ---- 事件订阅（preload -> renderer 增量同步）----
  on: events.on,

  // ---- 数据层 ----
  db: {
    getFeeds: dbSvc.getFeeds,
    saveFeed: dbSvc.saveFeed,
    snapshotItems: dbSvc.snapshotItems,
    itemsOfFeed: dbSvc.itemsOfFeed,
    ingestFeed: dbSvc.ingestFeed,
    setRead: dbSvc.setRead,
    setStarred: dbSvc.setStarred,
    setReadPos: dbSvc.setReadPos,
    getReadPos: dbSvc.getReadPos,
    markManyRead: dbSvc.markManyRead,
    recalcUnread: dbSvc.recalcUnread,
    getItemFull: dbSvc.getItemFull,
    getItemDetail: dbSvc.getItemDetail,
    retentionClean: dbSvc.retentionClean,
    deleteFeedCascade: dbSvc.deleteFeedCascade,
    clearAll: dbSvc.clearAll,
    searchContent: dbSvc.searchContent,
    rebuildSearchIndex: dbSvc.rebuildSearchIndex,
    clearBodyCache: dbSvc.clearBodyCache,
    getLocalStats: dbSvc.getLocalStats,
    detectLegacy: dbSvc.detectLegacy,
    cleanLegacySyncDocs: dbSvc.cleanLegacySyncDocs,
  },

  // ---- 订阅发现与 URL 规整 ----
  feed: {
    discover: feedSvc.discoverFeed,
    normalizeUrl: feedSvc.normalizeUrl,
  },

  // ---- 内容加工 ----
  article: {
    readingMinutes: articleSvc.readingMinutes,
    ensureFull: extractSvc.ensureFull,
  },

  // ---- OPML ----
  opml: {
    parse: opmlSvc.parseOpml,
    build: opmlSvc.buildOpml,
  },

  // ---- 领域编排：阅读 / 刷新 / 稍后读 / 定时任务 / 动态功能 ----
  read: {
    getSnapshot: readService.getSnapshot,
  },
  refresh: {
    due: refreshService.refreshDue,
    one: refreshService.refreshOne,
    abort: refreshService.abort,
    isRefreshing: refreshService.isRefreshing,
  },
  later: {
    saveUrl: laterService.saveUrl,
  },
  schedule: {
    getStatus: refreshService.getScheduleStatus,
    enable: refreshService.enableSchedule,
    disable: refreshService.disableSchedule,
  },
  features: {
    isGlobalSearchEnabled: lifecycleMgr.isGlobalSearchEnabled,
    setGlobalSearchEnabled: lifecycleMgr.setGlobalSearchEnabled,
  },
  lifecycle: {
    consumePendingActions: lifecycleMgr.consumePendingActions,
  },

  // ---- AI 增强管线（uTools 8.0+）----
  ai: {
    enrich: aiSvc.enrich,
    batchEnrich: aiSvc.batchEnrich,
    translateItem: aiSvc.translateItem,
    generateToc: aiSvc.generateToc,
    abort: aiSvc.abort,
    getStatus: aiSvc.getStatus,
    getConfig: aiSvc.getConfig,
    saveConfig: aiSvc.saveConfig,
    setByokKey: aiSvc.setByokKey,
    hasByokKey: aiSvc.hasByokKey,
    getByokStorageMode: aiSvc.getByokStorageMode,
  },

  // ---- 诊断日志（本地按天滚动 + 内存环形缓冲）----
  log: {
    debug: loggerSvc.debug,
    info: loggerSvc.info,
    warn: loggerSvc.warn,
    error: loggerSvc.error,
    getLogs: loggerSvc.getLogs,
    clear: loggerSvc.clear,
    dumpText: loggerSvc.dumpText,
  },

  // ---- 系统能力（受限对话框绑定与协议白名单，不暴露任意路径读写）----
  sys: {
    /**
     * 通过系统打开文件对话框选择并读取 .opml/.xml 文件内容
     * @returns {{ picked: boolean, text: string }}
     */
    pickOpmlText() {
      const u = ut();
      if (!u || typeof u.showOpenDialog !== "function") return { picked: false, text: "" };
      const picked = u.showOpenDialog({
        title: "导入 OPML",
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
        properties: ["openFile"],
      });
      const filePath = Array.isArray(picked) ? picked[0] : picked;
      if (!filePath || typeof filePath !== "string" || !/\.(opml|xml)$/i.test(filePath)) {
        return { picked: false, text: "" };
      }
      return { picked: true, text: fs.readFileSync(filePath, "utf8") };
    },
    /**
     * 通过系统保存文件对话框导出 OPML 文本（强制 .opml/.xml 后缀）
     * @param {string} opmlText
     * @returns {{ saved: boolean }}
     */
    saveOpmlWithDialog(opmlText) {
      const u = ut();
      if (!u || typeof u.showSaveDialog !== "function") return { saved: false };
      let targetPath = u.showSaveDialog({
        title: "导出 OPML",
        defaultPath: "airss-subscriptions.opml",
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      });
      if (!targetPath || typeof targetPath !== "string") return { saved: false };
      if (!/\.(opml|xml)$/i.test(targetPath)) targetPath += ".opml";
      fs.writeFileSync(targetPath, String(opmlText || ""), "utf8");
      return { saved: true };
    },
    /**
     * 通过系统保存文件对话框导出诊断日志（强制 .txt/.log 后缀）
     * @returns {{ saved: boolean }}
     */
    exportLogsWithDialog() {
      const u = ut();
      if (!u || typeof u.showSaveDialog !== "function") return { saved: false };
      let targetPath = u.showSaveDialog({
        title: "导出诊断日志",
        defaultPath: "airss-log.txt",
        filters: [{ name: "文本", extensions: ["txt", "log"] }],
      });
      if (!targetPath || typeof targetPath !== "string") return { saved: false };
      if (!/\.(txt|log)$/i.test(targetPath)) targetPath += ".txt";
      fs.writeFileSync(targetPath, loggerSvc.dumpText(), "utf8");
      return { saved: true };
    },
    /**
     * 仅允许打开 http/https 外部链接
     * @param {string} url
     * @returns {boolean}
     */
    openExternal(url) {
      let parsed;
      try {
        parsed = new URL(String(url || ""));
      } catch (_) {
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      const u = ut();
      if (u && typeof u.shellOpenExternal === "function") {
        u.shellOpenExternal(parsed.toString());
        return true;
      }
      return false;
    },
    createFeed,
  },
};

if (typeof window !== "undefined") {
  window.airss = airss;
}
lifecycleMgr.register();

loggerSvc.info("boot", "preload 挂载完成 window.airss (v2.1)", {
  services: ["db", "feed", "article", "opml", "refresh", "later", "schedule", "features", "ai", "log", "sys"],
});

module.exports = airss;
