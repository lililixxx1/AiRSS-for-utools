// @ts-check
/**
 * ai/engines/index.js — 统一单飞控制与引擎派发
 */
const { callUtools } = require("./utools.js");
const { callByok } = require("./byok.js");

let currentAbort = null;
let callClaim = 0;
let engineTimeoutMs = 60_000;

function nextClaim() {
  return ++callClaim;
}

function abort() {
  callClaim += 1;
  if (currentAbort) {
    try {
      currentAbort();
    } catch (_) { /* ignore */ }
    currentAbort = null;
  }
}

function claimGate(claim) {
  if (claim != null && claim < callClaim) return false;
  if (currentAbort) {
    try {
      currentAbort();
    } catch (_) { /* ignore */ }
    currentAbort = null;
  }
  return true;
}

/**
 * 统一 AI 引擎调用（带单飞门控）
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ cfg: any, stream?: boolean, onDelta?: (text: string) => void, claim?: number, reasoningEffort?: string }} opts
 */
async function callEngine(messages, { cfg, stream, onDelta, claim, reasoningEffort }) {
  const ctx = {
    cfg,
    stream,
    onDelta,
    claim,
    reasoningEffort,
    timeoutMs: engineTimeoutMs,
    claimGate,
    setAbort: (fn) => { currentAbort = fn; },
    clearAbort: () => { currentAbort = null; },
  };
  if (cfg.engine === "byok") return callByok(messages, ctx);
  return callUtools(messages, ctx);
}

function setEngineTimeout(ms) {
  engineTimeoutMs = ms;
}

module.exports = {
  nextClaim,
  abort,
  callEngine,
  setEngineTimeout,
};
