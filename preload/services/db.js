// @ts-check
/**
 * db.js — 数据层门面（v2：转调 preload/core/storage + migrate）
 *
 * 保持与既有服务层（scheduler / extract / ai / test-db-mock）的导出签名一致。
 */
const storage = require("../core/storage.js");
const migrate = require("../core/migrate.js");
const utils = require("../core/utils.js");

module.exports = {
  sha12: utils.sha12,
  newFeedId: utils.newFeedId,
  feedUrlKey: utils.feedUrlKey,
  computeItemKey: utils.computeItemKey,
  putRetry: utils.putRetry,
  bulkSharded: utils.bulkSharded,
  plainClone: utils.plainClone,

  init: storage.init,
  ensureInit: storage.ensureInit,
  resetForTest: storage.resetForTest,
  getFeeds: storage.getFeeds,
  getFeed: storage.getFeed,
  getDoc: storage.getDoc,
  saveFeed: storage.saveFeed,
  snapshotItems: storage.snapshotItems,
  itemsOfFeed: storage.itemsOfFeed,
  ingestFeed: storage.ingestFeed,
  setRead: storage.setRead,
  setStarred: storage.setStarred,
  setReadPos: storage.setReadPos,
  getReadPos: storage.getReadPos,
  markManyRead: storage.markManyRead,
  recalcUnread: storage.recalcUnread,
  getItemFull: storage.getItemFull,
  getItemFullxMeta: storage.getItemFullxMeta,
  getItemFullBest: storage.getItemFullBest,
  getItemDetail: storage.getItemDetail,
  saveItemFullx: storage.saveItemFullx,
  saveItemAi: storage.saveItemAi,
  retentionClean: storage.retentionClean,
  deleteFeedCascade: storage.deleteFeedCascade,
  saveLaterArticle: storage.saveLaterArticle,
  applyPullDocs: storage.applyPullDocs,
  clearAll: storage.clearAll,
  searchContent: storage.searchContent,
  rebuildSearchIndex: storage.rebuildSearchIndex,
  clearBodyCache: storage.clearBodyCache,
  getLocalStats: storage.getLocalStats,
  flush: storage.flush,

  detectLegacy: migrate.detectLegacy,
  runPhase1IfNeeded: migrate.runPhase1IfNeeded,
  cleanLegacySyncDocs: migrate.cleanLegacySyncDocs,
};
