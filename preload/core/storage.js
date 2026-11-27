// @ts-check
/**
 * storage.js — v2 分层存储统一门面
 *
 * 同步库 (utools.db):
 *   feed:{uuid} / feed:__later__    仅存订阅配置（剥离传输态与派生 unreadCount）
 *   state:{itemKey}                 已读/星标/阅读进度（懒创建：未交互文章零文档）
 *   star:{itemKey}                  星标精简快照（取消星标即删，换设备兜底）
 *   later:{itemKey}                 稍后读精简快照（删条目即删）
 *   meta:schema                     版本门控
 *
 * 本地数据目录 (<PluginLocalDataPath>/airss-data):
 *   meta.json                       { schemaVersion: 2, lastCompactAt }
 *   feed-state.json                 Record<feedId, { etag, lastModified, lastFetchedAt, lastError }>
 *   feeds/{feedHash12}.json         单源轻量条目索引（不含正文、译文、目录）
 *   bodies/{feedHash12}/{key}.html.gz / .x.html.gz
 *   ai/{itemKey}.json               { ai?, aiTrans?, aiToc?, contentHash? }
 *   search/minisearch.json          MiniSearch 倒排索引
 */
const { Buffer } = require("buffer");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const logger = require("../services/logger.js");
const events = require("./events.js");
const searchIndex = require("./searchIndex.js");
const {
  db,
  sleep0,
  sha12,
  feedUrlKey,
  feedHash,
  computeItemKey,
  plainClone,
  getLocalRoot,
  ensureDir,
  atomicWriteFileSync,
  atomicWriteJsonSync,
  readJsonSafe,
  putRetry,
  bulkSharded,
  bulkDeleteSyncDocs,
} = require("./utils.js");

const SYNC_FEED_KEYS = [
  "_id", "_rev", "url", "urlKey", "title", "titleEn", "titleLocked",
  "category", "siteUrl", "desc", "order", "refreshMin", "fullText",
  "notify", "special", "createdAt",
];
const STATE_PRUNE_AGE_MS = 180 * 86400e3;

let initialized = false;
let initPromise = null;
let lastDbRef = null;
let lastRoot = "";

/** @type {Map<string, any>} feedId -> syncFeedDoc */
const syncFeedMap = new Map();
/** @type {Record<string, any>} feedId -> { etag, lastModified, lastFetchedAt, lastError } */
let feedStateMap = {};
/** @type {Map<string, any>} itemKey -> SyncStateDoc */
const stateMap = new Map();
/** @type {Map<string, any>} itemKey -> SyncStarSnapDoc */
const starMap = new Map();
/** @type {Map<string, any>} itemKey -> SyncLaterSnapDoc */
const laterMap = new Map();
/** @type {Map<string, any[]>} feedId -> lightItem[] (without read/starred/readPos) */
const shardMap = new Map();
/** @type {Map<string, { item: any, feedId: string }>} itemId -> entry */
const itemById = new Map();
/** @type {Map<string, any>} itemKey -> item */
const itemByKey = new Map();

let feedStateTimer = null;

function localPaths() {
  const root = getLocalRoot();
  return {
    root,
    meta: path.join(root, "meta.json"),
    feedState: path.join(root, "feed-state.json"),
    feedsDir: path.join(root, "feeds"),
    bodiesDir: path.join(root, "bodies"),
    aiDir: path.join(root, "ai"),
    shardFile: (feedId) => path.join(root, "feeds", feedHash(feedId) + ".json"),
    bodyFile: (feedId, itemKey) => path.join(root, "bodies", feedHash(feedId), itemKey + ".html.gz"),
    fullxFile: (feedId, itemKey) => path.join(root, "bodies", feedHash(feedId), itemKey + ".x.html.gz"),
    aiFile: (itemKey) => path.join(root, "ai", itemKey + ".json"),
  };
}

function pickSyncFeedFields(feedDoc) {
  const out = {};
  for (const k of SYNC_FEED_KEYS) {
    if (feedDoc[k] !== undefined) out[k] = feedDoc[k];
  }
  if (out._id === "feed:__later__") {
    out.urlKey = "__later__";
    out.special = "later";
  } else if (out.url) {
    out.urlKey = feedUrlKey(out.url);
  }
  return out;
}

function syncFeedChanged(a, b) {
  if (!a || !b) return true;
  for (const k of SYNC_FEED_KEYS) {
    if (k === "_rev") continue;
    if ((a[k] ?? undefined) !== (b[k] ?? undefined)) return true;
  }
  return false;
}

function saveFeedStateNow() {
  if (feedStateTimer) {
    clearTimeout(feedStateTimer);
    feedStateTimer = null;
  }
  try {
    atomicWriteJsonSync(localPaths().feedState, feedStateMap);
  } catch (_) { /* ignore */ }
}

function scheduleFeedStateSave() {
  if (feedStateTimer) return;
  feedStateTimer = setTimeout(saveFeedStateNow, 300);
}

function gzipWriteSync(filePath, text) {
  const buf = zlib.gzipSync(Buffer.from(String(text), "utf8"));
  atomicWriteFileSync(filePath, buf);
}

function gunzipReadTextSync(filePath) {
  try {
    const raw = fs.readFileSync(filePath);
    return zlib.gunzipSync(raw).toString("utf8");
  } catch (_) {
    return null;
  }
}

function unlinkSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) { /* ignore */ }
}

function writeShardSync(feedId, list) {
  const file = localPaths().shardFile(feedId);
  const clean = (list || []).map((it) => {
    const copy = { ...it };
    delete copy.read;
    delete copy.starred;
    delete copy.readPos;
    delete copy._rev;
    delete copy.aiTrans;
    delete copy.aiToc;
    delete copy.fromStarSnap;
    delete copy.fromLaterSnap;
    return copy;
  });
  atomicWriteJsonSync(file, clean);
}

function readAiSidecar(itemKey) {
  if (!itemKey) return {};
  return readJsonSafe(localPaths().aiFile(itemKey), {}) || {};
}

function writeAiSidecar(itemKey, patch) {
  if (!itemKey) return;
  const cur = readAiSidecar(itemKey);
  const next = { ...cur, ...patch };
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) delete next[k];
  }
  if (!Object.keys(next).length) unlinkSafe(localPaths().aiFile(itemKey));
  else atomicWriteJsonSync(localPaths().aiFile(itemKey), next);
}

function resolveItemKey(item) {
  if (!item) return "";
  if (item.itemKey) return item.itemKey;
  const isVirtualId =
    item.feedKey === "feed:__later__" ||
    item.fromLaterSnap ||
    item.fromStarSnap ||
    (typeof item._id === "string" &&
      (item._id.startsWith("item:feed:__later__:") || item._id.startsWith("item:feed:__star_fallback__:")));
  if (isVirtualId && typeof item._id === "string") {
    const parts = item._id.split(":");
    if (parts.length >= 3) return parts[parts.length - 1];
  }
  const f = item.feedKey ? syncFeedMap.get(item.feedKey) : null;
  const urlKey = (f && f.urlKey) || (f && f.url ? feedUrlKey(f.url) : "") || item.feedKey || "";
  const computed = computeItemKey(urlKey, item.guid, item.link, item.title);
  if (computed) return computed;
  if (typeof item._id === "string") {
    const parts = item._id.split(":");
    if (parts.length >= 3) return parts[parts.length - 1];
  }
  return "";
}

function overlayItemState(raw) {
  const itemKey = resolveItemKey(raw);
  const st = itemKey ? stateMap.get(itemKey) : null;
  const item = {
    ...raw,
    itemKey,
    read: st ? !!st.read : !!raw.read,
    starred: st ? !!st.starred : !!raw.starred,
  };
  if (st && typeof st.readPos === "number") item.readPos = st.readPos;
  return item;
}

function rebuildItemIndexes() {
  itemById.clear();
  itemByKey.clear();
  const feedByUrlKey = new Map();
  for (const f of syncFeedMap.values()) {
    const uk = f.urlKey || (f.url ? feedUrlKey(f.url) : "");
    if (uk) feedByUrlKey.set(uk, f);
  }

  for (const [feedId, arr] of shardMap.entries()) {
    for (let i = 0; i < arr.length; i++) {
      const merged = overlayItemState(arr[i]);
      arr[i] = merged;
      itemById.set(merged._id, { item: merged, feedId });
      if (merged.itemKey && !itemByKey.has(merged.itemKey)) {
        itemByKey.set(merged.itemKey, merged);
      }
    }
  }

  // 星标跨端兜底：同步库有 star:{itemKey} 但本机分片尚未抓到该条
  for (const [itemKey, snap] of starMap.entries()) {
    if (itemByKey.has(itemKey)) continue;
    const matchedFeed = snap.feedUrlKey ? feedByUrlKey.get(snap.feedUrlKey) : null;
    const feedId = matchedFeed ? matchedFeed._id : "feed:__star_fallback__";
    const st = stateMap.get(itemKey);
    const synth = {
      _id: "item:" + feedId + ":" + itemKey,
      itemKey,
      feedKey: matchedFeed ? matchedFeed._id : "",
      feedTitle: snap.feedTitle || "",
      guid: "",
      link: snap.link || "",
      title: snap.title || "(已收藏文章)",
      titleDisplay: snap.title || "(已收藏文章)",
      author: snap.author || "",
      pubTs: snap.pubTs || snap.starredAt || Date.now(),
      fetchedAt: snap.starredAt || Date.now(),
      contentHash: "",
      summaryText: snap.summaryText || "",
      cover: null,
      read: st ? !!st.read : true,
      starred: true,
      readPos: st && typeof st.readPos === "number" ? st.readPos : undefined,
      aiStatus: "none",
      fromStarSnap: true,
    };
    itemById.set(synth._id, { item: synth, feedId });
    itemByKey.set(itemKey, synth);
  }

  // 稍后读跨端兜底
  for (const [itemKey, snap] of laterMap.entries()) {
    if (itemByKey.has(itemKey)) continue;
    const feedId = "feed:__later__";
    const st = stateMap.get(itemKey);
    const synth = {
      _id: "item:" + feedId + ":" + itemKey,
      itemKey,
      feedKey: feedId,
      guid: snap.url || itemKey,
      link: snap.link || snap.url || "",
      title: snap.title || snap.link || "(稍后读)",
      titleDisplay: snap.title || snap.link || "(稍后读)",
      author: snap.author || "",
      pubTs: snap.pubTs || snap.savedAt || Date.now(),
      fetchedAt: snap.savedAt || Date.now(),
      contentHash: "",
      summaryText: snap.summaryText || "",
      cover: snap.cover || null,
      read: st ? !!st.read : false,
      starred: st ? !!st.starred : false,
      readPos: st && typeof st.readPos === "number" ? st.readPos : undefined,
      aiStatus: "none",
      isLater: true,
      fromLaterSnap: true,
    };
    itemById.set(synth._id, { item: synth, feedId });
    itemByKey.set(itemKey, synth);
  }
}

function hydrateFeed(syncFeed) {
  const st = feedStateMap[syncFeed._id] || {};
  let unreadCount = 0;
  for (const entry of itemById.values()) {
    if (entry.item.feedKey === syncFeed._id && !entry.item.read) unreadCount += 1;
  }
  return {
    ...syncFeed,
    etag: st.etag || "",
    lastModified: st.lastModified || "",
    lastFetchedAt: st.lastFetchedAt !== undefined ? st.lastFetchedAt : null,
    lastError: st.lastError || "",
    unreadCount,
  };
}

function readBodyTextBest(item) {
  if (!item) return "";
  const feedId = item.feedKey || "";
  const itemKey = resolveItemKey(item);
  if (feedId && itemKey) {
    const xRaw = gunzipReadTextSync(localPaths().fullxFile(feedId, itemKey));
    if (xRaw) {
      try {
        const parsed = JSON.parse(xRaw);
        if (parsed && parsed.content) return parsed.content;
      } catch (_) { /* ignore */ }
    }
    const bRaw = gunzipReadTextSync(localPaths().bodyFile(feedId, itemKey));
    if (bRaw) return bRaw;
  }
  return "";
}

async function init(force = false) {
  const curDb = db();
  const curRoot = getLocalRoot();
  if (!force && initialized && lastDbRef === curDb && lastRoot === curRoot) return;
  if (initPromise && !force) return initPromise;

  initPromise = (async () => {
    lastDbRef = curDb;
    lastRoot = curRoot;
    syncFeedMap.clear();
    stateMap.clear();
    starMap.clear();
    laterMap.clear();
    shardMap.clear();
    itemById.clear();
    itemByKey.clear();

    const p = localPaths();
    ensureDir(p.feedsDir);
    ensureDir(p.bodiesDir);
    ensureDir(p.aiDir);
    feedStateMap = readJsonSafe(p.feedState, {}) || {};

    if (curDb) {
      const [feeds, states, stars, laters] = await Promise.all([
        curDb.allDocs("feed:"),
        curDb.allDocs("state:"),
        curDb.allDocs("star:"),
        curDb.allDocs("later:"),
      ]);
      for (const f of feeds || []) {
        if (f && f._id && !f._deleted) syncFeedMap.set(f._id, pickSyncFeedFields(f));
      }
      for (const s of states || []) {
        if (s && s._id && !s._deleted) stateMap.set(s._id.slice("state:".length), s);
      }
      for (const st of stars || []) {
        if (st && st._id && !st._deleted) starMap.set(st._id.slice("star:".length), st);
      }
      for (const lt of laters || []) {
        if (lt && lt._id && !lt._deleted) laterMap.set(lt._id.slice("later:".length), lt);
      }
    }

    // 加载本机所有已知订阅源（+ __later__）的分片，并容错损坏 JSON
    const feedIds = new Set([...syncFeedMap.keys(), "feed:__later__"]);
    for (const feedId of feedIds) {
      const file = p.shardFile(feedId);
      if (!fs.existsSync(file)) continue;
      const arr = readJsonSafe(file, null);
      if (Array.isArray(arr)) {
        shardMap.set(feedId, arr.filter((x) => x && x._id));
      } else {
        // 损坏分片自愈：清掉坏分片，让下轮刷新重建
        logger.warn("storage", "检测到损坏分片，已重建空分片", { feedId });
        unlinkSafe(file);
        shardMap.set(feedId, []);
      }
    }

    rebuildItemIndexes();

    // 惰性索引：冷启动不阻塞加载，首次检索/写入或损坏自愈时异步加载或重建
    searchIndex.setRebuildProvider(() => {
      const allItems = [...itemById.values()].map((e) => e.item);
      searchIndex.rebuildAll(allItems, (it) => readBodyTextBest(it));
    });

    initialized = true;
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function ensureInit() {
  const curDb = db();
  const curRoot = getLocalRoot();
  if (!initialized || lastDbRef !== curDb || lastRoot !== curRoot) {
    await init(true);
  }
}

function resetForTest() {
  if (feedStateTimer) {
    clearTimeout(feedStateTimer);
    feedStateTimer = null;
  }
  initialized = false;
  initPromise = null;
  lastDbRef = null;
  lastRoot = "";
  syncFeedMap.clear();
  feedStateMap = {};
  stateMap.clear();
  starMap.clear();
  laterMap.clear();
  shardMap.clear();
  itemById.clear();
  itemByKey.clear();
  searchIndex.resetForTest();
  logger.resetForTest();
}

// ---------------------------------------------------------------------------
// 订阅源操作
// ---------------------------------------------------------------------------

async function getFeeds() {
  await ensureInit();
  return [...syncFeedMap.values()].map(hydrateFeed);
}

async function getFeed(feedId) {
  await ensureInit();
  const f = syncFeedMap.get(feedId);
  return f ? hydrateFeed(f) : null;
}

async function saveFeed(feedDoc) {
  await ensureInit();
  if (!feedDoc || !feedDoc._id) return null;

  // 本地传输态单独落 feed-state.json
  const hasTransport =
    feedDoc.etag !== undefined ||
    feedDoc.lastModified !== undefined ||
    feedDoc.lastFetchedAt !== undefined ||
    feedDoc.lastError !== undefined;
  if (hasTransport) {
    const prev = feedStateMap[feedDoc._id] || {};
    feedStateMap[feedDoc._id] = {
      etag: feedDoc.etag !== undefined ? feedDoc.etag : prev.etag || "",
      lastModified: feedDoc.lastModified !== undefined ? feedDoc.lastModified : prev.lastModified || "",
      lastFetchedAt: feedDoc.lastFetchedAt !== undefined ? feedDoc.lastFetchedAt : (prev.lastFetchedAt ?? null),
      lastError: feedDoc.lastError !== undefined ? feedDoc.lastError : prev.lastError || "",
    };
    scheduleFeedStateSave();
  }

  const nextSync = pickSyncFeedFields(feedDoc);
  const existingSync = syncFeedMap.get(feedDoc._id);
  if (!existingSync || syncFeedChanged(existingSync, nextSync)) {
    if (existingSync && existingSync._rev && !nextSync._rev) nextSync._rev = existingSync._rev;
    const saved = await putRetry(nextSync);
    if (!saved) return null;
    syncFeedMap.set(feedDoc._id, saved);
    feedDoc._rev = saved._rev;
  }
  return hydrateFeed(syncFeedMap.get(feedDoc._id));
}

// ---------------------------------------------------------------------------
// 文章查询 / 详情
// ---------------------------------------------------------------------------

async function snapshotItems() {
  await ensureInit();
  return [...itemById.values()].map((e) => e.item);
}

async function itemsOfFeed(feedFullId) {
  await ensureInit();
  const list = shardMap.get(feedFullId);
  if (list) return list.map((x) => overlayItemState(x));
  return [...itemById.values()]
    .filter((e) => e.item.feedKey === feedFullId)
    .map((e) => e.item);
}

async function getDoc(id) {
  await ensureInit();
  if (!id) return null;
  if (id.startsWith("feed:")) return getFeed(id);
  if (id.startsWith("itemfullx:")) {
    const itemId = id.slice("itemfullx:".length);
    return getItemFullxMeta(itemId);
  }
  if (id.startsWith("itemfull:")) {
    const itemId = id.slice("itemfull:".length);
    const c = await getItemFull(itemId);
    return c != null ? { _id: id, content: c } : null;
  }
  const entry = itemById.get(id);
  if (entry) return entry.item;
  // 兼容：极少数单测直接向 mock utools.db put 过裸 item/feed
  const d = db();
  return d ? d.get(id) : null;
}

async function getItemFull(itemId) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (entry) {
    const body = gunzipReadTextSync(localPaths().bodyFile(entry.feedId, resolveItemKey(entry.item)));
    if (body != null) return body;
  }
  const d = db();
  if (d) {
    const legacy = await d.get("itemfull:" + itemId);
    if (legacy && legacy.content) return legacy.content;
  }
  return null;
}

async function getItemFullxMeta(itemId) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (entry) {
    const raw = gunzipReadTextSync(localPaths().fullxFile(entry.feedId, resolveItemKey(entry.item)));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.content) return { _id: "itemfullx:" + itemId, ...parsed };
      } catch (_) { /* ignore */ }
    }
  }
  const d = db();
  if (d) {
    const legacy = await d.get("itemfullx:" + itemId);
    if (legacy && legacy.content) return legacy;
  }
  return null;
}

async function getItemFullBest(itemId) {
  const x = await getItemFullxMeta(itemId);
  if (x && x.content) return x.content;
  return getItemFull(itemId);
}

/** 一次返回阅读面板所需的正文、提取全文、AI 译文、AI 目录与阅读进度 */
async function getItemDetail(itemId) {
  await ensureInit();
  const entry = itemById.get(itemId);
  const item = entry ? entry.item : null;
  const itemKey = item ? resolveItemKey(item) : "";
  const content = await getItemFull(itemId);
  const fullx = await getItemFullxMeta(itemId);
  const sidecar = itemKey ? readAiSidecar(itemKey) : {};
  const st = itemKey ? stateMap.get(itemKey) : null;
  return {
    item,
    content,
    fullxContent: fullx ? fullx.content : null,
    ai: (item && item.ai) || sidecar.ai || null,
    aiTrans: sidecar.aiTrans || (item && item.aiTrans) || null,
    aiToc: sidecar.aiToc || (item && item.aiToc) || null,
    readPos: st && typeof st.readPos === "number" ? st.readPos : 0,
  };
}

async function saveItemFullx(itemId, clean, cover, src) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (!entry) return false;
  const { item, feedId } = entry;
  const itemKey = resolveItemKey(item);
  try {
    gzipWriteSync(localPaths().fullxFile(feedId, itemKey), JSON.stringify({ content: clean, at: Date.now(), src: src || "readability" }));
  } catch (e) {
    logger.warn("storage", "写提取全文失败", { itemId, error: String(e && e.message) });
    return false;
  }

  // 连带失效旧译文/目录 + 补写空封面（T-09 同族）
  const sidecar = readAiSidecar(itemKey);
  if (sidecar.aiTrans || sidecar.aiToc) {
    writeAiSidecar(itemKey, { aiTrans: undefined, aiToc: undefined });
  }
  let shardTouched = false;
  if (item.hasAiTrans) {
    item.hasAiTrans = false;
    shardTouched = true;
  }
  if (item.hasAiToc) {
    item.hasAiToc = false;
    shardTouched = true;
  }
  if (cover && !item.cover) {
    item.cover = cover;
    shardTouched = true;
  }
  if (shardTouched) {
    const arr = shardMap.get(feedId) || [];
    writeShardSync(feedId, arr);
  }
  await searchIndex.ensureLoadedAsync();
  searchIndex.upsert(item, clean);
  return true;
}

async function saveItemAi(itemId, patch) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (!entry) return null;
  const { item, feedId } = entry;
  const itemKey = resolveItemKey(item);

  const sidePatch = {};
  let shardTouched = false;
  if (patch.ai !== undefined) {
    item.ai = patch.ai;
    sidePatch.ai = patch.ai;
    shardTouched = true;
  }
  if (patch.aiStatus !== undefined) {
    item.aiStatus = patch.aiStatus;
    shardTouched = true;
  }
  if (patch.titleDisplay !== undefined) {
    item.titleDisplay = patch.titleDisplay;
    shardTouched = true;
  }
  if (patch.aiTrans !== undefined) {
    sidePatch.aiTrans = patch.aiTrans;
    item.hasAiTrans = !!patch.aiTrans;
    shardTouched = true;
  }
  if (patch.aiToc !== undefined) {
    sidePatch.aiToc = patch.aiToc;
    item.hasAiToc = !!patch.aiToc;
    shardTouched = true;
  }

  if (Object.keys(sidePatch).length) {
    writeAiSidecar(itemKey, sidePatch);
  }
  if (shardTouched) {
    const arr = shardMap.get(feedId) || [];
    writeShardSync(feedId, arr);
    if (patch.ai !== undefined || patch.titleDisplay !== undefined) {
      await searchIndex.ensureLoadedAsync();
      searchIndex.upsert(item, readBodyTextBest(item));
    }
    events.emit("items-changed", { kind: "ai-updated", itemIds: [item._id], items: [plainClone(item)] });
  }
  return item;
}

// ---------------------------------------------------------------------------
// 刷新入库管线
// ---------------------------------------------------------------------------

async function ingestFeed(feedDoc, parsedItems, feedMeta = {}) {
  await ensureInit();
  const now = Date.now();
  const feedId = feedDoc._id;
  const urlKey = feedDoc.urlKey || feedUrlKey(feedDoc.url);

  if (!syncFeedMap.has(feedId)) {
    syncFeedMap.set(feedId, pickSyncFeedFields({ ...feedDoc, urlKey }));
  }

  const existingArr = shardMap.get(feedId) ? [...shardMap.get(feedId)] : [];
  const byId = new Map(existingArr.map((d) => [d._id, d]));

  let newCount = 0;
  let updatedCount = 0;
  let healedCount = 0;
  const touchedItems = [];
  const healedItems = [];

  for (const it of parsedItems || []) {
    const stable = it.guid || it.link || it.title || "";
    if (!stable) continue;
    const itemKey = computeItemKey(urlKey, it.guid, it.link, it.title);
    // 同源下 _id 唯一；guid 存在时即使用 guid 派生（兼容单源旧测），itemKey 跨端一致
    const _id = "item:" + feedId + ":" + sha12(stable);
    const existing = byId.get(_id);

    if (existing && existing.title === it.title && existing.contentHash === it.contentHash) {
      // 独立正文自愈早退分支：仅补写缺失正文与索引，绝不抹除 titleDisplay / ai / 侧载 / state
      const key = existing.itemKey || itemKey;
      if (key && it.contentHtml && !fs.existsSync(localPaths().bodyFile(feedId, key))) {
        gzipWriteSync(localPaths().bodyFile(feedId, key), it.contentHtml);
        healedItems.push({ item: existing, body: it.contentHtml });
        healedCount += 1;
      }
      continue;
    }

    if (existing) {
      existing.itemKey = existing.itemKey || itemKey;
      existing.title = it.title;
      existing.titleDisplay = it.title;
      existing.author = it.author || existing.author;
      existing.link = it.link || existing.link;
      existing.pubTs = it.pubTs;
      existing.summaryText = it.summaryText;
      existing.cover = it.cover;
      existing.contentHash = it.contentHash;
      delete existing.ai;
      existing.aiStatus = "none";
      existing.hasAiTrans = false;
      existing.hasAiToc = false;

      // T-09：正文变了 → 删除提取版与 AI 侧载
      unlinkSafe(localPaths().fullxFile(feedId, existing.itemKey));
      unlinkSafe(localPaths().aiFile(existing.itemKey));

      if (it.contentHtml) {
        gzipWriteSync(localPaths().bodyFile(feedId, existing.itemKey), it.contentHtml);
      }
      touchedItems.push({ item: existing, body: it.contentHtml || "" });
      updatedCount += 1;
    } else {
      const created = {
        _id,
        itemKey,
        feedKey: feedId,
        guid: it.guid || "",
        link: it.link || "",
        title: it.title,
        titleDisplay: it.title,
        author: it.author || "",
        pubTs: it.pubTs,
        fetchedAt: now,
        contentHash: it.contentHash,
        summaryText: it.summaryText,
        cover: it.cover,
        aiStatus: "none",
      };
      if (it.contentHtml) {
        gzipWriteSync(localPaths().bodyFile(feedId, itemKey), it.contentHtml);
      }
      byId.set(_id, created);
      touchedItems.push({ item: created, body: it.contentHtml || "" });
      newCount += 1;
    }
  }

  if (newCount > 0 || updatedCount > 0 || !fs.existsSync(localPaths().shardFile(feedId))) {
    const nextArr = [...byId.values()];
    shardMap.set(feedId, nextArr);
    writeShardSync(feedId, nextArr);
    rebuildItemIndexes();
  }
  if (touchedItems.length || healedItems.length) {
    await searchIndex.ensureLoadedAsync();
    for (const t of touchedItems) {
      searchIndex.upsert(itemById.get(t.item._id)?.item || t.item, t.body);
    }
    for (const h of healedItems) {
      searchIndex.upsert(itemById.get(h.item._id)?.item || h.item, h.body);
    }
  }
  if (healedCount > 0) {
    logger.info("ingest.heal", "正文缺失已自动补回", { feedId, healed: healedCount });
  }

  // 本地传输态推进
  const nextState = {
    etag: feedMeta.etag || feedDoc.etag || (feedStateMap[feedId]?.etag) || "",
    lastModified: feedMeta.lastModified || feedDoc.lastModified || (feedStateMap[feedId]?.lastModified) || "",
    lastFetchedAt: now,
    lastError: "",
  };
  feedStateMap[feedId] = nextState;
  saveFeedStateNow();

  feedDoc.etag = nextState.etag;
  feedDoc.lastModified = nextState.lastModified;
  feedDoc.lastFetchedAt = now;
  feedDoc.lastError = "";

  // 仅当同步字段发生变化（首次入库、标题/siteUrl/desc 更新）时才写入 utools.db
  const curSync = syncFeedMap.get(feedId);
  let needSyncPut = !curSync || !curSync._rev;
  if (feedMeta.title && !feedDoc.titleLocked && feedDoc.title !== feedMeta.title) {
    feedDoc.title = feedMeta.title;
    needSyncPut = true;
  }
  if (feedMeta.siteUrl && feedDoc.siteUrl !== feedMeta.siteUrl) {
    feedDoc.siteUrl = feedMeta.siteUrl;
    needSyncPut = true;
  }
  if (feedMeta.desc && !feedDoc.desc) {
    feedDoc.desc = feedMeta.desc;
    needSyncPut = true;
  }

  if (needSyncPut) {
    const saved = await putRetry(pickSyncFeedFields({ ...feedDoc, urlKey }));
    if (!saved) return { ok: false, newCount, updatedCount, error: "FEED_PUT_FAILED" };
    syncFeedMap.set(feedId, saved);
    feedDoc._rev = saved._rev;
  }

  const hydrated = hydrateFeed(syncFeedMap.get(feedId));
  feedDoc.unreadCount = hydrated.unreadCount;

  if (newCount > 0 || updatedCount > 0) {
    events.emit("items-changed", { kind: "ingest", feedId, newCount, updatedCount });
  }
  return { ok: true, newCount, updatedCount, healedCount, error: null };
}

// ---------------------------------------------------------------------------
// 用户意图同步写（state:* / star:*）
// ---------------------------------------------------------------------------

async function persistUserState(item, patch) {
  const itemKey = resolveItemKey(item);
  if (!itemKey) return null;
  const f = item.feedKey ? syncFeedMap.get(item.feedKey) : null;
  const feedUrlKeyVal = (f && f.urlKey) || (f && f.url ? feedUrlKey(f.url) : "") || item.feedKey || "";

  const prev = stateMap.get(itemKey) || { _id: "state:" + itemKey, feedUrlKey: feedUrlKeyVal, read: false, starred: false };
  const next = {
    ...prev,
    _id: "state:" + itemKey,
    feedUrlKey: feedUrlKeyVal || prev.feedUrlKey || "",
    read: patch.read !== undefined ? !!patch.read : !!prev.read,
    starred: patch.starred !== undefined ? !!patch.starred : !!prev.starred,
    updatedAt: Date.now(),
  };
  if (patch.readPos !== undefined) next.readPos = patch.readPos;

  const saved = await putRetry(next);
  if (saved) stateMap.set(itemKey, saved);
  return saved;
}

async function setRead(itemId, read) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (!entry) return null;
  const { item } = entry;
  const targetRead = !!read;
  if (!!item.read === targetRead && stateMap.has(resolveItemKey(item))) return item;
  item.read = targetRead;
  await persistUserState(item, { read: targetRead });
  events.emit("items-changed", { kind: "state", patch: [{ _id: itemId, read: targetRead }] });
  return item;
}

async function setStarred(itemId, starred) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (!entry) return null;
  const { item } = entry;
  const itemKey = resolveItemKey(item);
  const targetStar = !!starred;
  if (!!item.starred === targetStar && stateMap.has(itemKey)) return item;
  item.starred = targetStar;
  await persistUserState(item, { starred: targetStar });

  let removed = false;
  const f = item.feedKey ? syncFeedMap.get(item.feedKey) : null;
  const feedUrlKeyVal = (f && f.urlKey) || "";
  if (targetStar) {
    const snap = {
      ...(starMap.get(itemKey) || {}),
      _id: "star:" + itemKey,
      feedUrlKey: feedUrlKeyVal,
      feedTitle: (f && f.title) || item.feedTitle || "",
      title: item.titleDisplay || item.title || "",
      link: item.link || "",
      author: item.author || "",
      pubTs: item.pubTs || Date.now(),
      summaryText: String(item.summaryText || "").slice(0, 400),
      starredAt: Date.now(),
    };
    const savedSnap = await putRetry(snap);
    if (savedSnap) starMap.set(itemKey, savedSnap);
  } else {
    const existingSnap = starMap.get(itemKey);
    starMap.delete(itemKey);
    if (existingSnap) await bulkDeleteSyncDocs([existingSnap]);
    if (item.fromStarSnap) {
      removed = true;
      rebuildItemIndexes();
    }
  }
  events.emit("items-changed", { kind: "state", patch: [{ _id: itemId, starred: targetStar }], removed });
  return item;
}

async function setReadPos(itemId, ratio) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (!entry) return;
  const { item } = entry;
  const r = Math.max(0, Math.min(1, Math.round(Number(ratio || 0) * 1000) / 1000));
  const itemKey = resolveItemKey(item);
  const prev = stateMap.get(itemKey);
  if (!prev && r <= 0.01) return;
  if (prev && typeof prev.readPos === "number" && Math.abs(prev.readPos - r) < 0.01) return;
  item.readPos = r;
  await persistUserState(item, { readPos: r });
}

async function getReadPos(itemId) {
  await ensureInit();
  const entry = itemById.get(itemId);
  if (!entry) return 0;
  const st = stateMap.get(resolveItemKey(entry.item));
  return st && typeof st.readPos === "number" ? st.readPos : 0;
}

async function markManyRead(itemIds) {
  await ensureInit();
  if (!itemIds || !itemIds.length) return 0;
  const now = Date.now();
  const docsToPut = [];
  const affectedIds = [];
  for (const id of itemIds) {
    const entry = itemById.get(id);
    if (!entry || entry.item.read) continue;
    const item = entry.item;
    const itemKey = resolveItemKey(item);
    item.read = true;
    affectedIds.push(id);
    const f = item.feedKey ? syncFeedMap.get(item.feedKey) : null;
    const prev = stateMap.get(itemKey) || { _id: "state:" + itemKey, feedUrlKey: (f && f.urlKey) || "", starred: false };
    docsToPut.push({
      ...prev,
      _id: "state:" + itemKey,
      read: true,
      updatedAt: now,
    });
  }
  if (!docsToPut.length) return 0;
  await bulkSharded(docsToPut);
  for (const doc of docsToPut) {
    stateMap.set(doc._id.slice("state:".length), doc);
  }
  events.emit("items-changed", {
    kind: "state",
    patch: affectedIds.map((_id) => ({ _id, read: true })),
  });
  return docsToPut.length;
}

async function recalcUnread(feedDoc) {
  await ensureInit();
  const items = await itemsOfFeed(feedDoc._id);
  const n = items.filter((x) => !x.read).length;
  feedDoc.unreadCount = n;
  return n;
}

// ---------------------------------------------------------------------------
// 保留清理 / 删源 / 清库
// ---------------------------------------------------------------------------

async function retentionClean(feedDoc, keep) {
  await ensureInit();
  if (!feedDoc || feedDoc.special === "later" || feedDoc._id === "feed:__later__") return 0;
  const feedId = feedDoc._id;
  const arr = shardMap.get(feedId);
  if (!arr || !arr.length) return 0;

  const doomed = arr
    .map((x) => overlayItemState(x))
    .filter((x) => !x.starred)
    .sort((a, b) => b.pubTs - a.pubTs)
    .slice(keep);
  if (!doomed.length) return 0;

  // 一次批量向 sync db 复查星标，防止清理期间刚被收藏误删
  const d = db();
  const freshStarred = new Set();
  if (d) {
    const stateIds = doomed.map((x) => "state:" + resolveItemKey(x));
    const freshStates = await d.allDocs(stateIds);
    for (const s of freshStates || []) {
      if (s && s._id) {
        const k = s._id.slice("state:".length);
        stateMap.set(k, s);
        if (s.starred) freshStarred.add(k);
      }
    }
  }

  const doomedIds = new Set();
  const doomedKeys = [];
  for (const item of doomed) {
    const k = resolveItemKey(item);
    if (freshStarred.has(k)) continue;
    doomedIds.add(item._id);
    doomedKeys.push(k);
    unlinkSafe(localPaths().bodyFile(feedId, k));
    unlinkSafe(localPaths().fullxFile(feedId, k));
    unlinkSafe(localPaths().aiFile(k));
  }
  if (!doomedIds.size) return 0;

  const nextArr = arr.filter((x) => !doomedIds.has(x._id));
  shardMap.set(feedId, nextArr);
  writeShardSync(feedId, nextArr);
  rebuildItemIndexes();
  await searchIndex.ensureLoadedAsync();
  searchIndex.removeMany([...doomedIds]);

  // 顺带裁剪超过 180 天且已不在本地分片中的非星标 state:*
  const cutoff = Date.now() - STATE_PRUNE_AGE_MS;
  const expiredStates = [];
  for (const [k, st] of stateMap.entries()) {
    if (!st.starred && !itemByKey.has(k) && (st.updatedAt || 0) < cutoff) {
      expiredStates.push(st);
      stateMap.delete(k);
    }
  }
  if (expiredStates.length) await bulkDeleteSyncDocs(expiredStates);

  events.emit("items-changed", { kind: "retention", feedId });
  return doomedIds.size;
}

async function deleteFeedCascade(feedDoc) {
  await ensureInit();
  const feedId = feedDoc._id;
  const arr = shardMap.get(feedId) || [];
  const removedIds = arr.map((x) => x._id);
  const removedCount = arr.length;

  // 删除本地分片、正文目录、AI 侧载
  unlinkSafe(localPaths().shardFile(feedId));
  try {
    fs.rmSync(path.join(localPaths().bodiesDir, feedHash(feedId)), { recursive: true, force: true });
  } catch (_) { /* ignore */ }
  for (const it of arr) {
    unlinkSafe(localPaths().aiFile(resolveItemKey(it)));
  }
  shardMap.delete(feedId);
  delete feedStateMap[feedId];
  saveFeedStateNow();

  // 清理该源的非星标状态（星标保留 star:* 或连带删除，由产品口径「含星标不可恢复」决定：此处连带删此源关联的 state/star/later 与 feed）
  const syncDoomed = [];
  const fSync = syncFeedMap.get(feedId);
  if (fSync) syncDoomed.push(fSync);
  syncFeedMap.delete(feedId);

  for (const it of arr) {
    const k = resolveItemKey(it);
    const st = stateMap.get(k);
    if (st) {
      syncDoomed.push(st);
      stateMap.delete(k);
    }
    const sp = starMap.get(k);
    if (sp) {
      syncDoomed.push(sp);
      starMap.delete(k);
    }
    const lt = laterMap.get(k);
    if (lt) {
      syncDoomed.push(lt);
      laterMap.delete(k);
    }
  }
  if (syncDoomed.length) await bulkDeleteSyncDocs(syncDoomed);

  rebuildItemIndexes();
  await searchIndex.ensureLoadedAsync();
  searchIndex.removeMany(removedIds);
  events.emit("feeds-changed", { kind: "deleted", feedId });
  events.emit("items-changed", { kind: "feed-deleted", feedId });
  return removedCount;
}

/** 稍后读写入（供 laterService 调用） */
async function saveLaterArticle({ url, title, author, link, contentHtml, summaryText, cover, contentHash }) {
  await ensureInit();
  const feedId = "feed:__later__";
  if (!syncFeedMap.has(feedId)) {
    const laterFeed = {
      _id: feedId,
      url: "airss://later",
      urlKey: "__later__",
      title: "稍后读",
      category: "默认",
      siteUrl: "",
      desc: "订阅外网页收藏收件箱",
      refreshMin: 0,
      notify: false,
      special: "later",
      createdAt: Date.now(),
    };
    const savedFeed = await putRetry(laterFeed);
    syncFeedMap.set(feedId, savedFeed || laterFeed);
  }

  const now = Date.now();
  const itemKey = computeItemKey("__later__", url, link, title);
  const _id = "item:" + feedId + ":" + itemKey;
  const arr = shardMap.get(feedId) ? [...shardMap.get(feedId)] : [];
  const idx = arr.findIndex((x) => x._id === _id);
  const prev = idx >= 0 ? arr[idx] : null;
  const nextHash = contentHash || sha12(contentHtml || title || url);
  const sameHash = !!(prev && prev.contentHash && prev.contentHash === nextHash);

  const itemDoc = {
    _id,
    itemKey,
    feedKey: feedId,
    guid: url,
    link: link || url,
    title: title || url,
    titleDisplay: sameHash && prev.titleDisplay ? prev.titleDisplay : (title || url),
    author: author || (prev && prev.author) || "",
    pubTs: (prev && prev.pubTs) || now,
    fetchedAt: now,
    contentHash: nextHash,
    summaryText: summaryText || (sameHash && prev.summaryText) || "",
    cover: cover || (prev && prev.cover) || null,
    aiStatus: sameHash ? (prev.aiStatus || "none") : "none",
    ...(sameHash && prev.ai ? { ai: prev.ai } : {}),
    ...(sameHash && prev.hasAiTrans ? { hasAiTrans: true } : {}),
    ...(sameHash && prev.hasAiToc ? { hasAiToc: true } : {}),
    isLater: true,
  };
  if (prev && !sameHash && (prev.hasAiTrans || prev.hasAiToc)) {
    writeAiSidecar(itemKey, { aiTrans: undefined, aiToc: undefined });
  }
  if (contentHtml) gzipWriteSync(localPaths().bodyFile(feedId, itemKey), contentHtml);

  if (idx >= 0) arr[idx] = itemDoc;
  else arr.unshift(itemDoc);
  shardMap.set(feedId, arr);
  writeShardSync(feedId, arr);

  const laterSnap = {
    ...(laterMap.get(itemKey) || {}),
    _id: "later:" + itemKey,
    url,
    link: link || url,
    title: itemDoc.title,
    author: itemDoc.author,
    pubTs: itemDoc.pubTs,
    summaryText: String(itemDoc.summaryText || "").slice(0, 400),
    cover: itemDoc.cover,
    savedAt: now,
  };
  const savedLater = await putRetry(laterSnap);
  if (savedLater) laterMap.set(itemKey, savedLater);

  rebuildItemIndexes();
  await searchIndex.ensureLoadedAsync();
  searchIndex.upsert(itemById.get(_id)?.item || itemDoc, contentHtml || "");
  events.emit("feeds-changed", { kind: "later" });
  events.emit("items-changed", { kind: "later", itemIds: [_id] });
  return itemById.get(_id)?.item || itemDoc;
}

/** 增量处理 onDbPull(docs)：绝不全量重读 */
async function applyPullDocs(docs) {
  await ensureInit();
  if (!Array.isArray(docs) || !docs.length) return { feedsChanged: false, itemsChanged: false };

  let feedsChanged = false;
  let itemsChanged = false;
  const changedItemIds = [];

  for (const doc of docs) {
    if (!doc || !doc._id) continue;
    if (doc._id.startsWith("feed:")) {
      feedsChanged = true;
      if (doc._deleted) syncFeedMap.delete(doc._id);
      else syncFeedMap.set(doc._id, pickSyncFeedFields(doc));
    } else if (doc._id.startsWith("state:")) {
      const k = doc._id.slice("state:".length);
      if (doc._deleted) stateMap.delete(k);
      else stateMap.set(k, doc);
      const item = itemByKey.get(k);
      if (item) {
        item.read = doc._deleted ? false : !!doc.read;
        item.starred = doc._deleted ? false : !!doc.starred;
        if (!doc._deleted && typeof doc.readPos === "number") item.readPos = doc.readPos;
        changedItemIds.push(item._id);
      }
      itemsChanged = true;
    } else if (doc._id.startsWith("star:")) {
      const k = doc._id.slice("star:".length);
      if (doc._deleted) starMap.delete(k);
      else starMap.set(k, doc);
      itemsChanged = true;
    } else if (doc._id.startsWith("later:")) {
      const k = doc._id.slice("later:".length);
      if (doc._deleted) laterMap.delete(k);
      else laterMap.set(k, doc);
      itemsChanged = true;
    }
  }

  if (itemsChanged || feedsChanged) {
    rebuildItemIndexes();
  }
  if (feedsChanged) events.emit("feeds-changed", { kind: "pull" });
  if (itemsChanged) events.emit("items-changed", { kind: "pull", itemIds: changedItemIds });
  return { feedsChanged, itemsChanged };
}

/** 清空所有数据（同步库全部文档 + 仅删 airss-data/，不动同级 devbridge-spill） */
async function clearAll() {
  const d = db();
  let removed = 0;
  if (d) {
    const all = await d.allDocs();
    if (all && all.length) removed = await bulkDeleteSyncDocs(all);
  }
  if (feedStateTimer) {
    clearTimeout(feedStateTimer);
    feedStateTimer = null;
  }
  searchIndex.resetForTest();
  logger.clear();
  try {
    fs.rmSync(localPaths().root, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
  syncFeedMap.clear();
  feedStateMap = {};
  stateMap.clear();
  starMap.clear();
  laterMap.clear();
  shardMap.clear();
  itemById.clear();
  itemByKey.clear();
  initialized = false;
  await init(true);
  events.emit("feeds-changed", { kind: "clear" });
  events.emit("items-changed", { kind: "clear" });
  return removed;
}

/** 重建全文索引 */
async function rebuildSearchIndex() {
  await ensureInit();
  const all = [...itemById.values()].map((e) => e.item);
  const count = searchIndex.rebuildAll(all, (it) => readBodyTextBest(it));
  return { count, stats: getLocalStats() };
}

/** 清理普通订阅正文与提取全文缓存（保留订阅、状态、已收藏正文与稍后读正文，并清空传输态） */
async function clearBodyCache() {
  await ensureInit();
  const p = localPaths();
  const keepBodyFiles = new Set();

  for (const [feedId, arr] of shardMap.entries()) {
    if (feedId === "feed:__later__") {
      // 稍后读无自动刷新渠道，正文目录整源豁免保护
      const laterDir = path.join(p.bodiesDir, feedHash(feedId));
      try {
        if (fs.existsSync(laterDir)) {
          for (const name of fs.readdirSync(laterDir)) {
            keepBodyFiles.add(path.resolve(laterDir, name));
          }
        }
      } catch (_) { /* ignore */ }
      continue;
    }

    let shardTouched = false;
    for (const item of arr || []) {
      const key = resolveItemKey(item);
      if (!key) continue;
      const st = stateMap.get(key);
      const isStarred = !!(st ? st.starred : item.starred);
      const bf = p.bodyFile(feedId, key);
      const xf = p.fullxFile(feedId, key);

      if (isStarred) {
        keepBodyFiles.add(path.resolve(bf));
        keepBodyFiles.add(path.resolve(xf));
        continue;
      }

      unlinkSafe(bf);
      unlinkSafe(xf);
      const sidecar = readAiSidecar(key);
      if (sidecar.aiTrans || sidecar.aiToc) {
        writeAiSidecar(key, { aiTrans: undefined, aiToc: undefined });
      }
      if (item.hasAiTrans) {
        item.hasAiTrans = false;
        shardTouched = true;
      }
      if (item.hasAiToc) {
        item.hasAiToc = false;
        shardTouched = true;
      }
    }
    if (shardTouched) {
      writeShardSync(feedId, arr);
    }
  }

  try {
    if (fs.existsSync(p.bodiesDir)) {
      for (const dirName of fs.readdirSync(p.bodiesDir)) {
        if (dirName === "__later__") continue;
        const subDir = path.join(p.bodiesDir, dirName);
        let stDir;
        try { stDir = fs.statSync(subDir); } catch (_) { continue; }
        if (stDir.isDirectory()) {
          for (const fileName of fs.readdirSync(subDir)) {
            const full = path.resolve(subDir, fileName);
            if (!keepBodyFiles.has(full)) unlinkSafe(full);
          }
          try {
            if (fs.readdirSync(subDir).length === 0) fs.rmdirSync(subDir);
          } catch (_) { /* ignore */ }
        } else {
          unlinkSafe(subDir);
        }
      }
    }
  } catch (_) { /* ignore */ }

  // 同步清空所有非稍后读源的传输态，解开「refreshMin 未到期」与「304 空入库」两道门
  const allFeedIds = new Set([...syncFeedMap.keys(), ...Object.keys(feedStateMap)]);
  for (const feedId of allFeedIds) {
    if (feedId === "feed:__later__") continue;
    feedStateMap[feedId] = {
      ...(feedStateMap[feedId] || {}),
      etag: "",
      lastModified: "",
      lastFetchedAt: null,
    };
  }
  saveFeedStateNow();

  rebuildItemIndexes();
  await rebuildSearchIndex();
  events.emit("feeds-changed", { kind: "clear-cache" });
  return getLocalStats();
}

function walkBytes(dir) {
  let bytes = 0;
  let files = 0;
  try {
    if (!fs.existsSync(dir)) return { bytes, files };
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const sub = walkBytes(full);
        bytes += sub.bytes;
        files += sub.files;
      } else {
        bytes += st.size;
        files += 1;
      }
    }
  } catch (_) { /* ignore */ }
  return { bytes, files };
}

function getLocalStats() {
  const { bytes, files } = walkBytes(getLocalRoot());
  const indexExists = fs.existsSync(path.join(getLocalRoot(), "search", "minisearch.json"));
  return {
    diskBytes: bytes,
    diskMb: Math.round((bytes / (1024 * 1024)) * 100) / 100,
    files,
    indexedDocs: searchIndex.isReady() ? searchIndex.documentCount() : (indexExists ? itemById.size : 0),
    itemCount: itemById.size,
  };
}

function flush() {
  saveFeedStateNow();
  searchIndex.flush();
  logger.flush();
}

/**
 * 全文检索
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 */
async function searchContent(query, opts = {}) {
  await ensureInit();
  await searchIndex.ensureLoadedAsync();
  return searchIndex.search(query, opts);
}

/** 给 migrate.js / 测试使用的底层注入接口 */
function _getInternals() {
  return {
    localPaths,
    syncFeedMap,
    feedStateMap,
    stateMap,
    starMap,
    laterMap,
    shardMap,
    itemById,
    itemByKey,
    writeShardSync,
    gzipWriteSync,
    writeAiSidecar,
    rebuildItemIndexes,
    saveFeedStateNow,
    pickSyncFeedFields,
  };
}

module.exports = {
  init,
  ensureInit,
  resetForTest,
  getFeeds,
  getFeed,
  saveFeed,
  snapshotItems,
  itemsOfFeed,
  getDoc,
  getItemFull,
  getItemFullxMeta,
  getItemFullBest,
  getItemDetail,
  saveItemFullx,
  saveItemAi,
  ingestFeed,
  setRead,
  setStarred,
  setReadPos,
  getReadPos,
  markManyRead,
  recalcUnread,
  retentionClean,
  deleteFeedCascade,
  saveLaterArticle,
  applyPullDocs,
  clearAll,
  rebuildSearchIndex,
  clearBodyCache,
  getLocalStats,
  flush,
  searchContent,
  _getInternals,
};
