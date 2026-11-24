// @ts-check
/**
 * logger.js — 插件诊断日志（内存环形缓冲 + 本机按天滚动追加写，不进同步 dbStorage）
 *
 * 落盘位置：<getPluginLocalDataPath()>/airss-data/logs/airss-YYYYMMDD.log（保留 7 天）。
 * 纪律：msg ≤300 字、data 序列化 ≤500 字；BYOK 密钥/接口地址、完整正文不入日志。
 */
const fs = require("fs");
const path = require("path");
const { getLocalRoot, ensureDir } = require("../core/utils.js");

const MAX_ENTRIES = 500;
const RETAIN_DAYS = 7;

let buffer = null;
let pendingLines = [];
let flushTimer = null;
let prunedForRoot = "";

const pad = (n) => String(n).padStart(2, "0");

function dayStr(ts = Date.now()) {
  const d = new Date(ts);
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function formatTs(ts) {
  const d = new Date(ts);
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
    "." + String(d.getMilliseconds()).padStart(3, "0")
  );
}

function formatLine(e) {
  return formatTs(e.t) + " " + String(e.level).toUpperCase().padEnd(5) + " " + e.tag + " | " + e.msg + (e.data ? " | " + e.data : "");
}

function logsDir() {
  return path.join(getLocalRoot(), "logs");
}

function pruneOldLogs() {
  const dir = logsDir();
  if (prunedForRoot === dir) return;
  prunedForRoot = dir;
  try {
    if (!fs.existsSync(dir)) return;
    const cutoff = dayStr(Date.now() - RETAIN_DAYS * 86400e3);
    for (const name of fs.readdirSync(dir)) {
      const m = /^airss-(\d{8})\.log$/.exec(name);
      if (m && m[1] < cutoff) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* 清理失败不影响主流程 */ }
}

function load() {
  if (buffer) return buffer;
  buffer = [];
  pruneOldLogs();
  return buffer;
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pendingLines.length) return;
  const lines = pendingLines;
  pendingLines = [];
  try {
    const dir = logsDir();
    ensureDir(dir);
    const byDay = new Map();
    for (const item of lines) {
      const day = dayStr(item.t);
      const arr = byDay.get(day);
      if (arr) arr.push(item.line);
      else byDay.set(day, [item.line]);
    }
    for (const [day, arr] of byDay.entries()) {
      fs.appendFileSync(path.join(dir, "airss-" + day + ".log"), arr.join("\n") + "\n", "utf8");
    }
  } catch (_) {
    /* 磁盘异常不拖垮业务，内存缓冲仍可用 */
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1000);
}

function clip(s, n) {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function push(level, tag, msg, data) {
  const entry = { t: Date.now(), level, tag, msg: clip(msg, 300) };
  if (data !== undefined) {
    try {
      entry.data = clip(JSON.stringify(data), 500);
    } catch (_) {
      entry.data = "[unserializable]";
    }
  }
  const buf = load();
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  pendingLines.push({ t: entry.t, line: formatLine(entry) });
  scheduleFlush();

  const consoleLine = "[airss][" + tag + "] " + entry.msg + (entry.data ? " " + entry.data : "");
  if (level === "error") console.error(consoleLine);
  else if (level === "warn") console.warn(consoleLine);
  else console.log(consoleLine);
}

/** v1→v2 迁移时写入历史诊断记录 */
function migrateLegacyLogs(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const buf = load();
  for (const e of entries) {
    if (!e || !e.msg) continue;
    const item = { t: Number(e.t) || Date.now(), level: String(e.level || "info"), tag: String(e.tag || "legacy"), msg: clip(e.msg, 300), ...(e.data ? { data: clip(e.data, 500) } : {}) };
    buf.push(item);
    pendingLines.push({ t: item.t, line: formatLine(item) });
  }
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  flush();
}

function resetForTest() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  buffer = null;
  pendingLines = [];
  prunedForRoot = "";
}

/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
function debug(tag, msg, data) { push("debug", tag, msg, data); }

/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
function info(tag, msg, data) { push("info", tag, msg, data); }

/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
function warn(tag, msg, data) { push("warn", tag, msg, data); }

/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
function error(tag, msg, data) { push("error", tag, msg, data); }

/** @returns {Array<{ t: number, level: string, tag: string, msg: string, data?: string }>} */
function getLogs() {
  return load().slice();
}

function clear() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  buffer = [];
  pendingLines = [];
  try {
    const dir = logsDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (/^airss-\d{8}\.log$/.test(f)) fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch (_) { /* ignore */ }
}

/** @returns {string} */
function dumpText() {
  return load().map(formatLine).join("\n");
}

module.exports = {
  debug,
  info,
  warn,
  error,
  getLogs,
  clear,
  dumpText,
  flush,
  migrateLegacyLogs,
  resetForTest,
};
