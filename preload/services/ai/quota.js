// @ts-check
/**
 * ai/quota.js — AI 每日分池额度（存本机 <localRoot>/ai/quota.json，不进同步 dbStorage）
 */
const path = require("path");
const { getLocalRoot, readJsonSafe, atomicWriteJsonSync } = require("../../core/utils.js");

const QUOTA_MANUAL_MAX = 120;
const QUOTA_BG_MAX = 30;

function quotaFile() {
  return path.join(getLocalRoot(), "ai", "quota.json");
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function loadQuota() {
  const raw = readJsonSafe(quotaFile(), null);
  if (raw && raw.date === todayStr()) {
    return { date: raw.date, manual: Number(raw.manual) || 0, bg: Number(raw.bg) || 0 };
  }
  return { date: todayStr(), manual: 0, bg: 0 };
}

function quotaCheck(pool, cfg) {
  if (cfg && cfg.engine === "byok") return { ok: true };
  const q = loadQuota();
  const cap = pool === "manual" ? QUOTA_MANUAL_MAX : QUOTA_BG_MAX;
  return (q[pool] || 0) >= cap ? { ok: false, error: "QUOTA_EXHAUSTED" } : { ok: true };
}

function countCall(pool, cfg) {
  if (cfg && cfg.engine === "byok") return;
  const q = loadQuota();
  q[pool] = (q[pool] || 0) + 1;
  try {
    atomicWriteJsonSync(quotaFile(), q);
  } catch (_) { /* ignore */ }
}

function resetQuotaForTest() {
  try {
    atomicWriteJsonSync(quotaFile(), { date: todayStr(), manual: 0, bg: 0 });
  } catch (_) { /* ignore */ }
}

module.exports = {
  QUOTA_MANUAL_MAX,
  QUOTA_BG_MAX,
  loadQuota,
  quotaCheck,
  countCall,
  resetQuotaForTest,
};
