// @ts-check
/**
 * ai/cache.js — AI 产物本地单文件缓存（<localRoot>/ai/cache.json，LRU 5000，不进 utools.db）
 */
const path = require("path");
const { getLocalRoot, readJsonSafe, atomicWriteJsonSync } = require("../../core/utils.js");
const { modelLabelFor, getConfig } = require("./config.js");

const CACHE_MAX = 5000;

let loadedRoot = "";
/** @type {Record<string, { result: any, model: string, createdAt: number }>} */
let entries = {};
let dirty = false;
let saveTimer = null;

function cacheFile() {
  return path.join(getLocalRoot(), "ai", "cache.json");
}

function ensureLoaded() {
  const root = getLocalRoot();
  if (loadedRoot === root) return;
  loadedRoot = root;
  const data = readJsonSafe(cacheFile(), null);
  entries = data && data.entries && typeof data.entries === "object" ? data.entries : {};
  dirty = false;
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  try {
    atomicWriteJsonSync(cacheFile(), { v: 2, entries });
    dirty = false;
  } catch (_) { /* ignore */ }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 500);
}

async function cacheGet(id) {
  ensureLoaded();
  const hit = entries[id];
  if (!hit) return null;
  return { _id: id, ...hit };
}

async function cachePut(id, result, model) {
  ensureLoaded();
  const cfg = getConfig();
  entries[id] = {
    result,
    model: model || modelLabelFor(cfg),
    createdAt: Date.now(),
  };
  scheduleSave();
}

async function cacheTrim() {
  ensureLoaded();
  const keys = Object.keys(entries);
  if (keys.length <= CACHE_MAX) return;
  keys.sort((a, b) => (entries[a].createdAt || 0) - (entries[b].createdAt || 0));
  const drop = keys.length - CACHE_MAX;
  for (let i = 0; i < drop; i++) {
    delete entries[keys[i]];
  }
  scheduleSave();
}

function resetForTest() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  loadedRoot = "";
  entries = {};
  dirty = false;
}

module.exports = {
  CACHE_MAX,
  cacheGet,
  cachePut,
  cacheTrim,
  flush,
  resetForTest,
};
