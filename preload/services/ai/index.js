// @ts-check
/**
 * ai/index.js — AI 增强服务聚合入口（uTools 8.0+）
 */
const { ut } = require("../../core/utils.js");
const config = require("./config.js");
const quota = require("./quota.js");
const cache = require("./cache.js");
const engines = require("./engines/index.js");
const { byokEndpoint } = require("./engines/byok.js");
const prompts = require("./prompts.js");
const common = require("./pipelines/common.js");
const { enrich, TRUNC_CHARS } = require("./pipelines/enrich.js");
const { batchEnrich, BATCH_MAX } = require("./pipelines/batch.js");
const { translateItem } = require("./pipelines/translate.js");
const { generateToc, TOC_MAX_PARAS, TOC_PARA_CHARS, TOC_MAX_CHARS } = require("./pipelines/toc.js");

async function getStatus() {
  const cfg = config.getConfig();
  const u = ut();
  const ready = !!(u && typeof u.ai === "function");
  let models = [];
  if (ready && typeof u.allAiModels === "function") {
    try {
      const list = await u.allAiModels();
      if (Array.isArray(list)) models = list;
    } catch (_) {
      models = [];
    }
  }
  const q = quota.loadQuota();
  return {
    ready,
    engine: cfg.engine,
    models,
    byokReady: cfg.engine !== "byok" || (!!config.getByokKey() && !!cfg.byokBaseUrl),
    byokStorage: config.getByokStorageMode(),
    reasoningEffort: cfg.reasoningEffort || "none",
    quota: {
      manual: q.manual || 0,
      manualMax: quota.QUOTA_MANUAL_MAX,
      bg: q.bg || 0,
      bgMax: quota.QUOTA_BG_MAX,
    },
    exempt: cfg.engine === "byok",
  };
}

function flush() {
  cache.flush();
}

function resetForTest() {
  cache.resetForTest();
  quota.resetQuotaForTest();
}

module.exports = {
  enrich,
  batchEnrich,
  translateItem,
  generateToc,
  abort: engines.abort,
  getStatus,
  getConfig: config.getConfig,
  saveConfig: config.saveConfig,
  setByokKey: config.setByokKey,
  hasByokKey: config.hasByokKey,
  getByokStorageMode: config.getByokStorageMode,
  flush,
  resetForTest,
  __test: {
    ...prompts,
    ...common,
    loadQuota: quota.loadQuota,
    countCall: quota.countCall,
    quotaCheck: quota.quotaCheck,
    cachePut: cache.cachePut,
    cacheGet: cache.cacheGet,
    byokEndpoint,
    DEFAULT_CONFIG: config.DEFAULT_CONFIG,
    BATCH_MAX,
    TRUNC_CHARS,
    setEngineTimeout: engines.setEngineTimeout,
    TOC_MAX_PARAS,
    TOC_PARA_CHARS,
    TOC_MAX_CHARS,
  },
};
