// @ts-check
/**
 * migrate.js — v1.x -> v2.0 两阶段安全迁移
 *
 * 阶段一 (runPhase1IfNeeded)：
 *   首次启动检测无 meta.json (schemaVersion>=2) 且同步库有旧 item: 文档：
 *   1) 等待 replicateStateFromCloud()===1 最多 3s；
 *   2) 将旧 feed:/item:/itemfull:/itemfullx:/ai: 无损写入本地 airss-data/；
 *   3) 对 read||starred 生成 state:{itemKey}，对 starred 生成 star:{itemKey}；
 *   4) 合并旧 dbStorage 的 airss:readPositions 与 airss:logs；
 *   5) 写入本地 meta.json 与同步 meta:schema，**绝不删旧同步文档**（兼容未升级设备）。
 *
 * 阶段二 (cleanLegacySyncDocs)：
 *   强制校验 replicateStateFromCloud() !== 1，再批量 _deleted:true 清理旧前缀。
 */
const fs = require("fs");
const logger = require("../services/logger.js");
const searchIndex = require("./searchIndex.js");
const storage = require("./storage.js");
const {
  ut,
  db,
  store,
  sha12,
  feedUrlKey,
  computeItemKey,
  atomicWriteJsonSync,
  readJsonSafe,
  putRetry,
  bulkSharded,
  bulkDeleteSyncDocs,
} = require("./utils.js");

const LEGACY_POS_KEY = "airss:readPositions";
const LEGACY_LOG_KEY = "airss:logs";
const LEGACY_QUOTA_KEY = "airss:ai-quota";
const LEGACY_SCHEMA_KEY = "schemaVersion";

async function detectLegacy() {
  const d = db();
  if (!d) return { hasLegacy: false, items: 0, fulls: 0, fullxs: 0, aiCache: 0, total: 0 };
  const [items, fulls, fullxs, aiCache] = await Promise.all([
    d.allDocs("item:"),
    d.allDocs("itemfull:"),
    d.allDocs("itemfullx:"),
    d.allDocs("ai:"),
  ]);
  const cItems = (items || []).filter((x) => !x._deleted).length;
  const cFulls = (fulls || []).filter((x) => !x._deleted).length;
  const cFullxs = (fullxs || []).filter((x) => !x._deleted).length;
  const cAi = (aiCache || []).filter((x) => !x._deleted).length;
  const total = cItems + cFulls + cFullxs + cAi;
  return { hasLegacy: total > 0, items: cItems, fulls: cFulls, fullxs: cFullxs, aiCache: cAi, total };
}

function readCloudState() {
  const u = ut();
  const rawDb = u && u.db;
  if (rawDb && typeof rawDb.replicateStateFromCloud === "function") {
    return rawDb.replicateStateFromCloud();
  }
  const d = db();
  if (d && typeof d.replicateStateFromCloud === "function") {
    return d.replicateStateFromCloud();
  }
  return null;
}

async function waitCloudIfPulling(maxMs = 3000) {
  try {
    const state = await readCloudState();
    if (state !== 1) return;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if ((await readCloudState()) !== 1) break;
    }
  } catch (_) { /* ignore */ }
}

async function runPhase1IfNeeded() {
  const internals = storage._getInternals();
  const p = internals.localPaths();
  const meta = readJsonSafe(p.meta, null);
  if (meta && meta.schemaVersion >= 2) {
    return { ran: false, migratedItems: 0 };
  }

  const d = db();
  if (!d) {
    atomicWriteJsonSync(p.meta, { schemaVersion: 2, migratedAt: Date.now() });
    return { ran: false, migratedItems: 0 };
  }

  await waitCloudIfPulling(3000);

  const [feeds, legacyItems, legacyFulls, legacyFullxs, legacyAiCache] = await Promise.all([
    d.allDocs("feed:"),
    d.allDocs("item:"),
    d.allDocs("itemfull:"),
    d.allDocs("itemfullx:"),
    d.allDocs("ai:"),
  ]);

  const activeItems = (legacyItems || []).filter((x) => x && !x._deleted);
  const feedById = new Map();
  for (const f of feeds || []) {
    if (!f || f._deleted) continue;
    feedById.set(f._id, f);
    // 迁移 feed 的本地传输态到 feed-state.json
    if (f.etag || f.lastModified || f.lastFetchedAt || f.lastError) {
      internals.feedStateMap[f._id] = {
        etag: f.etag || "",
        lastModified: f.lastModified || "",
        lastFetchedAt: f.lastFetchedAt ?? null,
        lastError: f.lastError || "",
      };
    }
  }

  // 读取旧阅读进度表
  const kv = store();
  let legacyPos = {};
  try {
    if (kv) {
      const rawPos = kv.getItem(LEGACY_POS_KEY);
      if (rawPos && typeof rawPos === "object") legacyPos = rawPos;
    }
  } catch (_) { /* ignore */ }

  const fullMap = new Map((legacyFulls || []).map((x) => [x._id, x]));
  const fullxMap = new Map((legacyFullxs || []).map((x) => [x._id, x]));

  const perFeedItems = new Map();
  const statesToPut = [];
  const starsToPut = [];
  const bodiesForIndex = new Map();

  for (const it of activeItems) {
    const feed = feedById.get(it.feedKey);
    const urlKey = (feed && (feed.urlKey || feedUrlKey(feed.url))) || it.feedKey || "";
    const itemKey = computeItemKey(urlKey, it.guid, it.link, it.title) || sha12(it._id);
    const fId = it.feedKey || "feed:unknown";

    const light = {
      _id: it._id,
      itemKey,
      feedKey: fId,
      guid: it.guid || "",
      link: it.link || "",
      title: it.title || "",
      titleDisplay: it.titleDisplay || it.title || "",
      author: it.author || "",
      pubTs: it.pubTs || Date.now(),
      fetchedAt: it.fetchedAt || Date.now(),
      contentHash: it.contentHash || "",
      summaryText: it.summaryText || "",
      cover: it.cover || null,
      aiStatus: it.aiStatus || "none",
      ...(it.ai ? { ai: it.ai } : {}),
      ...(it.aiTrans ? { hasAiTrans: true } : {}),
      ...(it.aiToc ? { hasAiToc: true } : {}),
    };
    const arr = perFeedItems.get(fId);
    if (arr) arr.push(light);
    else perFeedItems.set(fId, [light]);

    const fDoc = fullMap.get("itemfull:" + it._id);
    if (fDoc && fDoc.content) {
      internals.gzipWriteSync(p.bodyFile(fId, itemKey), fDoc.content);
      bodiesForIndex.set(it._id, fDoc.content);
    }
    const xDoc = fullxMap.get("itemfullx:" + it._id);
    if (xDoc && xDoc.content) {
      internals.gzipWriteSync(p.fullxFile(fId, itemKey), JSON.stringify({ content: xDoc.content, at: xDoc.at || Date.now(), src: xDoc.src || "readability" }));
      bodiesForIndex.set(it._id, xDoc.content);
    }

    if (it.ai || it.aiTrans || it.aiToc) {
      internals.writeAiSidecar(itemKey, {
        ...(it.ai ? { ai: it.ai } : {}),
        ...(it.aiTrans ? { aiTrans: it.aiTrans } : {}),
        ...(it.aiToc ? { aiToc: it.aiToc } : {}),
      });
    }

    const pos = typeof legacyPos[it._id] === "number" ? legacyPos[it._id] : undefined;
    if (it.read || it.starred || (pos != null && pos > 0.01)) {
      if (!internals.stateMap.has(itemKey)) {
        const stDoc = {
          _id: "state:" + itemKey,
          feedUrlKey: urlKey,
          read: !!it.read,
          starred: !!it.starred,
          ...(pos != null && pos > 0.01 ? { readPos: Math.round(pos * 1000) / 1000 } : {}),
          updatedAt: Date.now(),
        };
        statesToPut.push(stDoc);
        internals.stateMap.set(itemKey, stDoc);
      }
    }
    if (it.starred && !internals.starMap.has(itemKey)) {
      const starDoc = {
        _id: "star:" + itemKey,
        feedUrlKey: urlKey,
        feedTitle: (feed && feed.title) || "",
        title: it.titleDisplay || it.title || "",
        link: it.link || "",
        author: it.author || "",
        pubTs: it.pubTs || Date.now(),
        summaryText: String(it.summaryText || "").slice(0, 400),
        starredAt: Date.now(),
      };
      starsToPut.push(starDoc);
      internals.starMap.set(itemKey, starDoc);
    }
  }

  for (const [fId, arr] of perFeedItems.entries()) {
    internals.shardMap.set(fId, arr);
    internals.writeShardSync(fId, arr);
  }
  internals.saveFeedStateNow();

  // 迁移旧 AI 缓存到 local ai/cache.json
  if (legacyAiCache && legacyAiCache.length) {
    const cacheFile = require("path").join(p.aiDir, "cache.json");
    const existingCache = readJsonSafe(cacheFile, { entries: {} }) || { entries: {} };
    if (!existingCache.entries) existingCache.entries = {};
    for (const c of legacyAiCache) {
      if (c && c._id && !c._deleted && c.result) {
        existingCache.entries[c._id] = { result: c.result, model: c.model || "", createdAt: c.createdAt || Date.now() };
      }
    }
    atomicWriteJsonSync(cacheFile, existingCache);
  }

  // 迁移旧诊断日志到 local logs/
  try {
    if (kv) {
      let rawLogs = kv.getItem(LEGACY_LOG_KEY);
      if (typeof rawLogs === "string") rawLogs = JSON.parse(rawLogs);
      if (Array.isArray(rawLogs) && rawLogs.length) logger.migrateLegacyLogs(rawLogs);
    }
  } catch (_) { /* ignore */ }

  if (statesToPut.length) await bulkSharded(statesToPut);
  if (starsToPut.length) await bulkSharded(starsToPut);

  // 写同步 meta:schema（与已有修订合并）
  const curMetaSync = await d.get("meta:schema");
  await putRetry({ ...(curMetaSync || {}), _id: "meta:schema", version: 2 });

  // 写本地 meta.json，标记阶段一完成（旧同步文档故意保留！）
  atomicWriteJsonSync(p.meta, { schemaVersion: 2, migratedAt: Date.now() });

  internals.rebuildItemIndexes();
  if (activeItems.length) {
    const allItems = [...internals.itemById.values()].map((e) => e.item);
    searchIndex.rebuildAll(allItems, (it) => bodiesForIndex.get(it._id) || "");
  }

  if (activeItems.length) {
    logger.info("migrate", "v1->v2 阶段一本地导入完成", { items: activeItems.length, states: statesToPut.length, stars: starsToPut.length });
  }
  return { ran: true, migratedItems: activeItems.length };
}

/**
 * 阶段二：确认云端同步已完成拉取后，清理 v1.x 历史同步冗余文档
 */
async function cleanLegacySyncDocs() {
  const d = db();
  if (!d) return { ok: false, removed: 0, error: "DB_UNAVAILABLE" };

  try {
    if ((await readCloudState()) === 1) {
      return { ok: false, removed: 0, error: "CLOUD_SYNC_IN_PROGRESS" };
    }
  } catch (_) { /* ignore */ }

  const [items, fulls, fullxs, aiCache] = await Promise.all([
    d.allDocs("item:"),
    d.allDocs("itemfull:"),
    d.allDocs("itemfullx:"),
    d.allDocs("ai:"),
  ]);
  const doomed = []
    .concat(items || [], fulls || [], fullxs || [], aiCache || [])
    .filter((x) => x && !x._deleted);

  const removed = doomed.length ? await bulkDeleteSyncDocs(doomed) : 0;

  // 剥离 feed 文档上的旧传输态字段（只在确有旧字段时更新）
  const feeds = await d.allDocs("feed:");
  const internals = storage._getInternals();
  const dirtyFeeds = [];
  for (const f of feeds || []) {
    if (!f || f._deleted) continue;
    if ("etag" in f || "lastModified" in f || "lastFetchedAt" in f || "lastError" in f || "unreadCount" in f) {
      dirtyFeeds.push({ ...internals.pickSyncFeedFields(f), _rev: f._rev });
    }
  }
  if (dirtyFeeds.length) await bulkSharded(dirtyFeeds);

  // 清旧 dbStorage 键
  try {
    const kv = store();
    if (kv && typeof kv.removeItem === "function") {
      kv.removeItem(LEGACY_POS_KEY);
      kv.removeItem(LEGACY_LOG_KEY);
      kv.removeItem(LEGACY_QUOTA_KEY);
      kv.removeItem(LEGACY_SCHEMA_KEY);
    }
  } catch (_) { /* ignore */ }

  const curMeta = await d.get("meta:schema");
  await putRetry({ ...(curMeta || {}), _id: "meta:schema", version: 2, legacyCleanedAt: Date.now() });

  logger.info("migrate", "v1->v2 阶段二旧同步冗余清理完成", { removed });
  return { ok: true, removed, error: null };
}

module.exports = {
  detectLegacy,
  runPhase1IfNeeded,
  cleanLegacySyncDocs,
};
