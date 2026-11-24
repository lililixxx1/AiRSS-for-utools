// @ts-check
/**
 * utils.js — preload/core 共享基础工具
 *
 * 约定：所有本地数据严格写入 `<utools.getPluginLocalDataPath()>/airss-data`，
 * 绝不碰根目录（避免清库时误删 dev-bridge 的 devbridge-spill 等宿主同级目录）。
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

let tmpSeq = 0;

function ut() {
  return global.utools || (typeof window !== "undefined" ? window.utools : undefined);
}

function db() {
  const u = ut();
  return u && u.db ? u.db.promises : null;
}

function store() {
  const u = ut();
  return u ? u.dbStorage : null;
}

const sleep0 = () => new Promise((r) => setTimeout(r, 0));

/** SHA-256 hex 前 12 位（48bit 判重键） */
function sha12(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 12);
}

function newFeedId() {
  return "feed:" + crypto.randomUUID();
}

/** 订阅源 URL 归一化判重键（与 src/lib/recommend.ts 完全同口径） */
function feedUrlKey(url) {
  let s = String(url || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

/** feed 本地分片哈希（稍后读伪源固定 __later__） */
function feedHash(feedId) {
  if (feedId === "feed:__later__") return "__later__";
  return sha12(feedId);
}

/** 跨设备/重订阅稳定的条目键（不依赖随机 feed UUID） */
function computeItemKey(urlKey, guid, link, title) {
  const stable = guid || link || title || "";
  if (!stable) return "";
  return sha12(String(urlKey || "") + "|" + String(stable));
}

/**
 * 渲染层传入的文档可能是 Vue reactive Proxy —— utools IPC 走结构化克隆，Proxy 会抛
 * "An object could not be cloned."；入库前统一 JSON 深克隆为普通对象。
 */
function plainClone(doc) {
  if (doc == null || typeof doc !== "object") return doc;
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch (_) {
    return doc;
  }
}

/** 本插件私有本地数据目录（<PluginLocalDataPath>/airss-data） */
function getLocalRoot() {
  const u = ut();
  try {
    if (u && typeof u.getPluginLocalDataPath === "function") {
      const p = u.getPluginLocalDataPath();
      if (p && typeof p === "string") return path.join(p, "airss-data");
    }
  } catch (_) {
    /* 测试环境兜底 */
  }
  return path.join(os.tmpdir(), "airss-fallback-local", "airss-data");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 同目录写临时文件再 renameSync 原子替换（Windows 瞬时锁容忍 3 次） */
function atomicWriteFileSync(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp." + process.pid + "." + (++tmpSeq);
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      if (i === 2 || !["EPERM", "EBUSY", "EACCES"].includes(e && e.code)) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw e;
      }
    }
  }
}

function atomicWriteJsonSync(filePath, data) {
  atomicWriteFileSync(filePath, JSON.stringify(data));
}

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/** put 带冲突重试：失败重新 get 最新 _rev 后重试 */
async function putRetry(doc, tries = 3) {
  const d = db();
  if (!d) return null;
  for (let i = 0; i < tries; i++) {
    const res = await d.put(plainClone(doc));
    if (res && res.ok) {
      doc._rev = res.rev;
      return doc;
    }
    const fresh = await d.get(doc._id);
    if (fresh) doc._rev = fresh._rev;
    else delete doc._rev;
    await sleep0();
  }
  return null;
}

/** bulkDocs 分批（≤50/批，批间让出主线程），返回是否全部成功 */
async function bulkSharded(docs, onProgress) {
  const d = db();
  if (!d) return false;
  let ok = true;
  for (let i = 0; i < docs.length; i += 50) {
    const batch = docs.slice(i, i + 50);
    const results = await d.bulkDocs(batch.map(plainClone));
    (results || []).forEach((r) => {
      if (!r || r.error) ok = false;
      else {
        const target = batch.find((x) => x._id === r.id);
        if (target && r.rev) target._rev = r.rev;
      }
    });
    if (onProgress) onProgress(i + batch.length, docs.length);
    await sleep0();
  }
  return ok;
}

/**
 * 批量删除同步库文档：有 _rev 时使用 bulkDocs + _deleted:true（每批 ≤50），
 * 缺失 _rev 的先批量补查一次或退回 remove。
 */
async function bulkDeleteSyncDocs(docsOrIds) {
  const d = db();
  if (!d || !docsOrIds || !docsOrIds.length) return 0;
  let docs = docsOrIds;
  if (typeof docsOrIds[0] === "string") {
    docs = await d.allDocs(docsOrIds);
  }
  if (!docs.length) return 0;
  const needRev = docs.filter((x) => x && x._id && !x._rev).map((x) => x._id);
  const revMap = new Map();
  if (needRev.length) {
    const fetched = await d.allDocs(needRev);
    for (const f of fetched || []) if (f && f._id && f._rev) revMap.set(f._id, f._rev);
  }
  const payloads = [];
  const noRevIds = [];
  for (const doc of docs) {
    if (!doc || !doc._id) continue;
    const rev = doc._rev || revMap.get(doc._id);
    if (rev) payloads.push({ _id: doc._id, _rev: rev, _deleted: true });
    else noRevIds.push(doc._id);
  }
  let deleted = 0;
  for (let i = 0; i < payloads.length; i += 50) {
    const batch = payloads.slice(i, i + 50);
    const res = await d.bulkDocs(batch);
    (res || []).forEach((r) => { if (r && r.ok) deleted += 1; });
    await sleep0();
  }
  for (const id of noRevIds) {
    const r = await d.remove(id);
    if (r && r.ok) deleted += 1;
  }
  return deleted;
}

module.exports = {
  ut,
  db,
  store,
  sleep0,
  sha12,
  newFeedId,
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
};
