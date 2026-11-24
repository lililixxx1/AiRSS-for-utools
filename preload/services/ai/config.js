// @ts-check
/**
 * ai/config.js — AI 引擎配置与 BYOK 两级密钥存储（uTools 8.0+）
 *
 * 密钥优先存 utools.dbCryptoStorage；若宿主不可用或下线，自动降级存到
 * <PluginLocalDataPath>/airss-data/byok.local（仅本机、不进同步库），并在返回值标明 storage 模式。
 */
const fs = require("fs");
const path = require("path");
const logger = require("../logger.js");
const { ut, store, getLocalRoot, atomicWriteFileSync } = require("../../core/utils.js");

const CFG_KEY = "airss:ai-config";
const BYOK_KEY_NAME = "airss:byok-key";
const VALID_EFFORTS = new Set(["none", "low", "medium"]);

const DEFAULT_CONFIG = {
  enabled: false,
  engine: "utools", // "utools" | "byok"
  model: "",
  modelLabel: "",
  reasoningEffort: "none", // "none" | "low" | "medium"
  byokBaseUrl: "",
  byokModel: "",
  byokAllowHttp: false,
};

function byokFallbackFile() {
  return path.join(getLocalRoot(), "byok.local");
}

function cryptoStore() {
  const u = ut();
  return u && u.dbCryptoStorage ? u.dbCryptoStorage : null;
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   engine: "utools" | "byok",
 *   model: string,
 *   modelLabel: string,
 *   reasoningEffort: "none" | "low" | "medium",
 *   byokBaseUrl: string,
 *   byokModel: string,
 *   byokAllowHttp: boolean,
 * }} AiConfig
 */

/** @returns {AiConfig} */
function getConfig() {
  try {
    const s = store();
    let raw = s ? s.getItem(CFG_KEY) : null;
    if (typeof raw === "string") raw = JSON.parse(raw);
    const merged = Object.assign({}, DEFAULT_CONFIG, raw || {});
    if (!VALID_EFFORTS.has(merged.reasoningEffort)) merged.reasoningEffort = "none";
    return merged;
  } catch (_) {
    return /** @type {AiConfig} */ ({ ...DEFAULT_CONFIG });
  }
}

/**
 * @param {Partial<AiConfig>} [patch]
 * @returns {AiConfig}
 */
function saveConfig(patch) {
  const next = Object.assign(getConfig(), patch || {});
  if (!VALID_EFFORTS.has(next.reasoningEffort)) next.reasoningEffort = "none";
  const s = store();
  if (s) s.setItem(CFG_KEY, JSON.stringify(next));
  return next;
}

function getByokStorageMode() {
  const cs = cryptoStore();
  if (cs && typeof cs.getItem === "function" && typeof cs.setItem === "function") {
    try {
      cs.getItem(BYOK_KEY_NAME);
      return "crypto";
    } catch (_) {
      /* 降级本机文件 */
    }
  }
  return "local-fallback";
}

function readFallbackKey() {
  try {
    return fs.readFileSync(byokFallbackFile(), "utf8").trim();
  } catch (_) {
    return "";
  }
}

function writeFallbackKey(key) {
  const f = byokFallbackFile();
  if (!key) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) { /* ignore */ }
    return;
  }
  atomicWriteFileSync(f, String(key));
  try { fs.chmodSync(f, 0o600); } catch (_) { /* Windows 忽略 */ }
}

function getByokKey() {
  const cs = cryptoStore();
  if (cs && typeof cs.getItem === "function") {
    try {
      const v = cs.getItem(BYOK_KEY_NAME);
      if (v) return String(v);
    } catch (_) {
      /* 尝试读降级文件 */
    }
  }
  return readFallbackKey();
}

function setByokKey(key) {
  const val = String(key || "");
  const cs = cryptoStore();
  if (cs && typeof cs.setItem === "function") {
    try {
      if (!val && typeof cs.removeItem === "function") cs.removeItem(BYOK_KEY_NAME);
      else cs.setItem(BYOK_KEY_NAME, val);
      writeFallbackKey(""); // 清理旧降级残留
      return { ok: true, storage: "crypto" };
    } catch (e) {
      logger.warn("ai.byok", "dbCryptoStorage 不可用，切换本机目录兜底", { error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  try {
    writeFallbackKey(val);
    return { ok: true, storage: "local-fallback" };
  } catch (e) {
    logger.error("ai.byok", "本机密钥保存失败", { error: String((e && e.message) || e).slice(0, 120) });
    return { ok: false, error: "KEY_STORAGE_UNAVAILABLE", storage: "none" };
  }
}

function hasByokKey() {
  return !!getByokKey();
}

function modelLabelFor(cfg) {
  if (cfg.engine === "byok") return cfg.byokModel || "byok";
  return cfg.modelLabel || cfg.model || "host-default";
}

module.exports = {
  CFG_KEY,
  BYOK_KEY_NAME,
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  getByokKey,
  setByokKey,
  hasByokKey,
  getByokStorageMode,
  modelLabelFor,
};
