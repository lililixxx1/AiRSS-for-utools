/**
 * AiRSS preload 入口 — 挂 window.airss（渲染层唯一数据/网络通道）
 *
 * uTools 规范：本目录（preload/）源码直供、不打包不压缩；node_modules 原样随包。
 * 各服务实现见 services/，职责划分见 docs/PLAN-PHASE1.md §2。
 */
const dbSvc = require("./services/db.js");
const feedSvc = require("./services/feed.js");
const articleSvc = require("./services/article.js");
const extractSvc = require("./services/extract.js");
const opmlSvc = require("./services/opml.js");
const schedulerSvc = require("./services/scheduler.js");
const aiSvc = require("./services/ai.js");
const loggerSvc = require("./services/logger.js");
const fs = require("fs");

const ut = () => global.utools || window.utools;

window.airss = {
  // ---- 数据层 ----
  db: {
    getFeeds: dbSvc.getFeeds,
    saveFeed: dbSvc.saveFeed,
    snapshotItems: dbSvc.snapshotItems,
    itemsOfFeed: dbSvc.itemsOfFeed,
    ingestFeed: dbSvc.ingestFeed,
    setRead: dbSvc.setRead,
    setStarred: dbSvc.setStarred,
    markManyRead: dbSvc.markManyRead,
    recalcUnread: dbSvc.recalcUnread,
    getItemFull: dbSvc.getItemFull,
    retentionClean: dbSvc.retentionClean,
    deleteFeedCascade: dbSvc.deleteFeedCascade,
    clearAll: dbSvc.clearAll,
    searchContent: dbSvc.searchContent,
  },

  // ---- 订阅发现与抓取 ----
  feed: {
    discover: feedSvc.discoverFeed,
    fetch: feedSvc.fetchFeed,
    normalizeUrl: feedSvc.normalizeUrl,
  },

  // ---- 内容加工 ----
  article: {
    readingMinutes: articleSvc.readingMinutes,
    /** 全文提取（PLAN-V1.3 A）：摘要型源打开文章时抓原文→Readability→消毒→回传 */
    ensureFull: extractSvc.ensureFull,
  },

  // ---- OPML ----
  opml: {
    parse: opmlSvc.parseOpml,
    build: opmlSvc.buildOpml,
  },

  // ---- 刷新调度 ----
  scheduler: {
    refreshOne: schedulerSvc.refreshOne,
    refreshFeeds: schedulerSvc.refreshFeeds,
    abort: schedulerSvc.abort,
  },

  // ---- AI 增强管线（二期；密钥仅存 dbCryptoStorage，不经渲染层）----
  ai: {
    /** 打开文章的合并调用：一次产出 titleZh/titleNorm/tags/summary（流式） */
    enrich: aiSvc.enrich,
    /** 刷新后轻量批：新文章补 tags/titleZh（≤20 篇/次，后台池额度） */
    batchEnrich: aiSvc.batchEnrich,
    /** AI 段落翻译（v1.2）：渲染层切块纯文本入，译文落 item.aiTrans（流式） */
    translateItem: aiSvc.translateItem,
    /** AI 目录生成（v1.4，PLAN-AI-TOC）：全量段落入，AI 划分章节起标题，产物落 item.aiToc（手动池） */
    generateToc: aiSvc.generateToc,
    /** 中断进行中的 AI 调用（离开阅读面板/插件被杀） */
    abort: aiSvc.abort,
    /** 设置页：引擎可用性/模型列表/今日额度 */
    getStatus: aiSvc.getStatus,
    getConfig: aiSvc.getConfig,
    saveConfig: aiSvc.saveConfig,
    setByokKey: aiSvc.setByokKey,
    hasByokKey: aiSvc.hasByokKey,
  },

  // ---- 诊断日志（环形缓冲 500 条；密钥/URL/全文不入日志）----
  log: {
    debug: loggerSvc.debug,
    info: loggerSvc.info,
    warn: loggerSvc.warn,
    error: loggerSvc.error,
    getLogs: loggerSvc.getLogs,
    clear: loggerSvc.clear,
    dumpText: loggerSvc.dumpText,
  },

  // ---- 系统能力（Node 侧文件 IO 等）----
  sys: {
    /** 读文本文件（OPML 导入：路径来自 utools.showOpenDialog） */
    readTextFile(path) {
      return fs.readFileSync(path, "utf8");
    },
    /** 写文本文件（OPML 导出：路径来自 utools.showSaveDialog） */
    writeTextFile(path, text) {
      fs.writeFileSync(path, text, "utf8");
    },
    openExternal(url) {
      ut().shellOpenExternal(url);
    },
    /** 新建 feed 文档并入库（发现确认后调用；返回完整文档）。fullText：摘要型源预开抓取全文（缺省不写字段=关）；refreshMin：0=跟随全局 */
    async createFeed({ url, title, category, fullText, refreshMin, siteUrl, desc }) {
      const doc = {
        _id: dbSvc.newFeedId(),
        url,
        title: title || url,
        titleEn: "",
        category: category || "默认",
        siteUrl: siteUrl || "",
        desc: desc || "",
        ...(fullText ? { fullText: true } : {}),
        etag: "",
        lastModified: "",
        lastFetchedAt: null, // null = 立即到期，入库即首抓（H5）
        refreshMin: refreshMin || 0, // 0 = 跟随全局设置
        unreadCount: 0,
        lastError: "",
        notify: true,
        createdAt: Date.now(),
      };
      await dbSvc.saveFeed(doc);
      return doc;
    },
  },
};

// 启动埋点：控制台/诊断日志里若连这条都没有，说明 preload 挂载本身失败（看渲染层致命错误页）
loggerSvc.info("boot", "preload 挂载完成 window.airss", { services: ["db", "feed", "article", "opml", "scheduler", "ai", "log", "sys"] });
