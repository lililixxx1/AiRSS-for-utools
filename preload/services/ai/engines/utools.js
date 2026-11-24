// @ts-check
/**
 * ai/engines/utools.js — uTools 8.0+ 原生 utools.ai 引擎
 */
const logger = require("../../logger.js");
const { ut } = require("../../../core/utils.js");
const { modelLabelFor } = require("../config.js");

const TIMEOUT_SENTINEL = "__AIRSS_ENGINE_TIMEOUT__";

function withTimeout(promiseLike, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), ms);
  });
  return Promise.race([promiseLike, timeout]).finally(() => clearTimeout(timer));
}

function resolveMeta(result) {
  if (result == null) return String(result);
  const t = typeof result;
  if (t !== "object") return { type: t, len: String(result).length };
  const meta = { keys: Object.keys(result).slice(0, 12) };
  for (const k of ["error", "code", "status", "message"]) {
    const v = result[k];
    if (v != null && String(v) !== "") meta[k] = String(v).slice(0, 120);
  }
  return meta;
}

async function callUtools(messages, { cfg, stream, onDelta, claim, reasoningEffort, timeoutMs, claimGate, setAbort, clearAbort }) {
  const u = ut();
  if (!u || typeof u.ai !== "function") {
    logger.warn("ai.call", "utools.ai 不可用（需 uTools 8.0+）");
    return { ok: false, error: "UTOOLS_AI_UNAVAILABLE" };
  }
  if (!claimGate(claim)) return { ok: false, aborted: true, error: "ABORTED" };

  const effort = reasoningEffort || cfg.reasoningEffort || "none";
  const option = { messages, reasoning_effort: effort };
  if (cfg.model) option.model = cfg.model;

  const t0 = Date.now();
  let acc = "";
  let chunkCount = 0;
  let snapshotMode = false;
  let p = null;

  try {
    p = stream
      ? u.ai(option, (chunk) => {
          const t = chunk && chunk.content ? String(chunk.content) : "";
          if (!t) return;
          chunkCount += 1;
          if (!snapshotMode && acc.length >= 8 && t.length > acc.length && t.startsWith(acc)) {
            snapshotMode = true;
            logger.info("ai.stream", "检测到快照式流回调（给累计全文），切换覆盖累计", { atChars: acc.length });
          }
          if (snapshotMode) {
            const delta = t.slice(acc.length);
            acc = t;
            if (delta && onDelta) onDelta(delta);
          } else {
            acc += t;
            if (onDelta) onDelta(t);
          }
        })
      : u.ai(option);

    setAbort(() => {
      try {
        p.abort();
      } catch (_) { /* ignore */ }
    });

    const result = await withTimeout(p, timeoutMs);
    clearAbort();

    let content = stream ? acc : String((result && result.content) || "");
    if (stream) {
      const accAtResolve = acc;
      await new Promise((r) => setTimeout(r, 150));
      if (acc.length > accAtResolve.length) {
        logger.warn("ai.stream", "resolve 后回调仍在追加（早退竞态）", { atResolve: accAtResolve.length, final: acc.length });
        content = acc;
      }
      const resolvedLen = result && result.content ? String(result.content).length : 0;
      if (resolvedLen > content.length) {
        logger.info("ai.stream", "resolve 值长于回调累计，采用 resolve 值", { resolvedLen, accLen: content.length });
        content = String(result.content);
      }
      logger.info("ai.call", "引擎调用完成", {
        engine: "utools",
        stream: true,
        model: modelLabelFor(cfg),
        effort: option.reasoning_effort,
        ms: Date.now() - t0,
        chunks: chunkCount,
        chars: content.length,
        head: content.slice(0, 24),
        tail: content.slice(-24),
      });
    } else {
      logger.info("ai.call", "引擎调用完成", {
        engine: "utools",
        stream: false,
        model: modelLabelFor(cfg),
        effort: option.reasoning_effort,
        ms: Date.now() - t0,
        chars: content.length,
      });
    }

    if (!content.trim()) {
      logger.warn("ai.call", "空输出", { chunks: chunkCount, resolve: resolveMeta(result) });
      return { ok: false, error: "EMPTY_OUTPUT" };
    }
    return { ok: true, content };
  } catch (e) {
    clearAbort();
    const msg = String((e && e.message) || e);
    if (msg === TIMEOUT_SENTINEL) {
      try { p.abort(); } catch (_) { /* ignore */ }
      logger.warn("ai.call", "引擎硬超时，放弃本次调用", { ms: timeoutMs, chunks: chunkCount, accChars: acc.length });
      return { ok: false, error: "ENGINE_TIMEOUT" };
    }
    const aborted = /abort/i.test(msg);
    logger.warn("ai.call", aborted ? "调用被中止" : "调用抛错", { error: msg.slice(0, 120), chunks: chunkCount, accChars: acc.length });
    return { ok: false, aborted, error: aborted ? "ABORTED" : msg.slice(0, 80) };
  }
}

module.exports = { callUtools };
