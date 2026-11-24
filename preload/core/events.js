// @ts-check
/**
 * events.js — preload -> renderer 轻量事件总线
 *
 * 用于后台刷新、onDbPull 增量合并、稍后读等事件通知渲染层局部更新，
 * 避免渲染层再全量 loadAll()。
 */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * 订阅 preload 事件，返回取消订阅函数
 * @param {string} event
 * @param {(payload: any) => void} fn
 * @returns {() => void}
 */
function on(event, fn) {
  if (typeof fn !== "function") return () => {};
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  return () => off(event, fn);
}

/**
 * @param {string} event
 * @param {(payload: any) => void} fn
 */
function off(event, fn) {
  const set = listeners.get(event);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) listeners.delete(event);
}

/**
 * @param {string} event
 * @param {any} [payload]
 */
function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || !set.size) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (_) {
      /* 单监听异常不阻断后续分发 */
    }
  }
}

function clear() {
  listeners.clear();
}

module.exports = { on, off, emit, clear };
