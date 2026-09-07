/**
 * logger.js — 插件诊断日志（环形缓冲，dbStorage 持久，实机排查用）
 *
 * 场景：AI 截断/抓取失败等宿主侧问题，本地 mock 全绿实机才暴露，没有日志只能盲猜。
 * 出口：设置页「诊断日志」复制/导出/清空（window.airss.log.dumpText()）。
 *
 * 纪律：日志是诊断面不是审计面——msg ≤300 字、data 序列化 ≤500 字；
 *       BYOK 密钥/接口地址、完整正文一律不入日志（T-11，隐私）。
 */
const KEY = "airss:logs";
const MAX_ENTRIES = 500;

const ut = () => global.utools || window.utools;

let buffer = null;
let flushTimer = null;

function load() {
  if (buffer) return buffer;
  try {
    let raw = ut().dbStorage.getItem(KEY);
    if (typeof raw === "string") raw = JSON.parse(raw);
    buffer = Array.isArray(raw) ? raw : [];
  } catch (_) {
    buffer = [];
  }
  return buffer;
}

/** 落盘防抖（1s 合并）：每条日志都同步写 dbStorage 是一次跨进程 IPC，
 *  刷新/AI 突发期逐条写库会放大成可感知卡顿；读路径（getLogs/dumpText）走内存即准确 */
function persist() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      ut().dbStorage.setItem(KEY, JSON.stringify(buffer));
    } catch (_) {
      /* 配额满则放弃持久化，内存缓冲仍可用 */
    }
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
  persist();
  // 同步镜像到 console（uTools 开发者工具可见）
  const line = "[airss][" + tag + "] " + entry.msg + (entry.data ? " " + entry.data : "");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const pad = (n) => String(n).padStart(2, "0");

module.exports = {
  debug: (tag, msg, data) => push("debug", tag, msg, data),
  info: (tag, msg, data) => push("info", tag, msg, data),
  warn: (tag, msg, data) => push("warn", tag, msg, data),
  error: (tag, msg, data) => push("error", tag, msg, data),
  getLogs: () => load().slice(),
  clear: () => {
    buffer = [];
    persist();
  },
  dumpText: () =>
    load()
      .map((e) => {
        const d = new Date(e.t);
        const ts =
          d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
          " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
          "." + String(d.getMilliseconds()).padStart(3, "0");
        return ts + " " + String(e.level).toUpperCase().padEnd(5) + " " + e.tag + " | " + e.msg + (e.data ? " | " + e.data : "");
      })
      .join("\n"),
};
