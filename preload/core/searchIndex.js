// @ts-check
/**
 * searchIndex.js — 基于 MiniSearch 的本地中文/英文倒排索引
 *
 * - 落盘路径：<localRoot>/search/minisearch.json（防抖 3s 原子替换）
 * - 分词：英文/数字词 + CJK 连续段 bigram（长度 1 保留单字），多词 AND 语义，无 1.5s 预算截断
 * - 损坏/版本不一致自动全量重建
 */
const fs = require("fs");
const path = require("path");
const MiniSearch = require("minisearch");
const { htmlToText } = require("../services/article.js");
const { getLocalRoot, atomicWriteJsonSync, readJsonSafe } = require("./utils.js");

const INDEX_VERSION = 2;
const SAVE_DEBOUNCE_MS = 3000;
const BODY_TEXT_LIMIT = 8000;

/** 匹配 ASCII 词、CJK 连续块 */
const TOKEN_CHUNK_RE = /[a-z0-9_]+|[\u3400-\u9fff\uf900-\ufaff]+/gi;
const HAS_CJK_RE = /^[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 中英文混合分词（索引 & 查询共用）：
 * - 英文/数字直接转小写词元
 * - CJK 连续块生成 2-gram；单字时保留单字，同时首字/尾字按前缀搜索可覆盖绝大多数单字输入
 */
function tokenize(text) {
  const out = [];
  const raw = String(text || "");
  if (!raw) return out;
  TOKEN_CHUNK_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_CHUNK_RE.exec(raw))) {
    const seg = m[0];
    if (HAS_CJK_RE.test(seg)) {
      if (seg.length === 1) {
        out.push(seg);
      } else {
        for (let i = 0; i < seg.length - 1; i++) {
          out.push(seg.slice(i, i + 2));
        }
        // 尾单字补充：支持任意单字查询匹配词尾汉字，索引增量可控
        out.push(seg[seg.length - 1]);
      }
    } else {
      out.push(seg.toLowerCase());
    }
  }
  return out;
}

const MS_OPTIONS = {
  idField: "id",
  fields: ["titleDisplay", "title", "tags", "summaryText", "bodyText"],
  storeFields: ["id"],
  tokenize,
  processTerm: (term) => (term ? term.toLowerCase() : null),
  searchOptions: {
    boost: { titleDisplay: 3, title: 2.5, tags: 2, summaryText: 1.5, bodyText: 1 },
    combineWith: "AND",
    prefix: true,
  },
};

let ms = null;
let loadedRoot = "";
let dirty = false;
let saveTimer = null;

function indexFilePath() {
  return path.join(getLocalRoot(), "search", "minisearch.json");
}

function createEmptyIndex() {
  return new MiniSearch(MS_OPTIONS);
}

function ensureInstance() {
  const root = getLocalRoot();
  if (!ms || loadedRoot !== root) {
    ms = createEmptyIndex();
    loadedRoot = root;
    dirty = false;
  }
  return ms;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, SAVE_DEBOUNCE_MS);
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty || !ms) return;
  try {
    atomicWriteJsonSync(indexFilePath(), { v: INDEX_VERSION, index: ms.toJSON() });
    dirty = false;
  } catch (_) {
    /* 磁盘故障留待下次 flush 重试 */
  }
}

function toDoc(item, bodyHtml) {
  const plain = bodyHtml ? htmlToText(String(bodyHtml)).slice(0, BODY_TEXT_LIMIT) : "";
  return {
    id: item._id,
    titleDisplay: String(item.titleDisplay || ""),
    title: String(item.title || ""),
    tags: Array.isArray(item.ai && item.ai.tags) ? item.ai.tags.join(" ") : "",
    summaryText: String(item.summaryText || ""),
    bodyText: plain,
  };
}

/**
 * 尝试从磁盘加载索引；失败或版本不符返回 false（由调用方决定重建）。
 */
function loadFromDisk() {
  const root = getLocalRoot();
  const data = readJsonSafe(indexFilePath(), null);
  if (!data || data.v !== INDEX_VERSION || !data.index) return false;
  try {
    ms = MiniSearch.loadJSON(JSON.stringify(data.index), MS_OPTIONS);
    loadedRoot = root;
    dirty = false;
    return true;
  } catch (_) {
    ms = createEmptyIndex();
    loadedRoot = root;
    dirty = false;
    return false;
  }
}

/**
 * 全量重建索引
 * @param {Array<any>} items
 * @param {(item: any) => string} getBodyFn
 */
function rebuildAll(items, getBodyFn) {
  ms = createEmptyIndex();
  loadedRoot = getLocalRoot();
  const docs = [];
  for (const it of items || []) {
    if (!it || !it._id) continue;
    const html = typeof getBodyFn === "function" ? getBodyFn(it) : "";
    docs.push(toDoc(it, html));
  }
  if (docs.length) ms.addAll(docs);
  dirty = true;
  flush();
  return docs.length;
}

function upsert(item, bodyHtml) {
  if (!item || !item._id) return;
  const inst = ensureInstance();
  const doc = toDoc(item, bodyHtml);
  if (inst.has(doc.id)) inst.replace(doc);
  else inst.add(doc);
  scheduleSave();
}

function remove(itemId) {
  if (!itemId) return;
  const inst = ensureInstance();
  if (inst.has(itemId)) {
    inst.discard(itemId);
    scheduleSave();
  }
}

function removeMany(itemIds) {
  if (!itemIds || !itemIds.length) return;
  const inst = ensureInstance();
  let changed = false;
  for (const id of itemIds) {
    if (inst.has(id)) {
      inst.discard(id);
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

/**
 * 执行本地全文检索（无截断，目标 <50ms）
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {{ids: string[], scanned: number, truncated: boolean, ms: number}}
 */
function search(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return { ids: [], scanned: 0, truncated: false, ms: 0 };
  const inst = ensureInstance();
  const t0 = Date.now();
  const tokens = tokenize(q);
  if (!tokens.length) return { ids: [], scanned: inst.documentCount, truncated: false, ms: 0 };
  const hits = inst.search(q, {
    combineWith: "AND",
    prefix: true,
  });
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  const ids = (limit ? hits.slice(0, limit) : hits).map((h) => String(h.id));
  return {
    ids,
    scanned: inst.documentCount,
    truncated: false,
    ms: Date.now() - t0,
  };
}

function documentCount() {
  return ensureInstance().documentCount;
}

function resetForTest() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  ms = null;
  loadedRoot = "";
  dirty = false;
}

module.exports = {
  tokenize,
  loadFromDisk,
  rebuildAll,
  upsert,
  remove,
  removeMany,
  search,
  flush,
  documentCount,
  resetForTest,
};
