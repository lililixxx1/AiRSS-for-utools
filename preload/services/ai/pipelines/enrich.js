// @ts-check
/**
 * ai/pipelines/enrich.js — 单篇打开流式摘要 + 标题/标签（手动池）
 */
const dbSvc = require("../../db.js");
const articleSvc = require("../../article.js");
const logger = require("../../logger.js");
const { getConfig } = require("../config.js");
const { quotaCheck, countCall, loadQuota } = require("../quota.js");
const { cacheGet, cachePut, cacheTrim } = require("../cache.js");
const { nextClaim, callEngine } = require("../engines/index.js");
const { buildEnrichMessages, parseEnrichOutput } = require("../prompts.js");
const { categoryList, applyAi, markError } = require("./common.js");

const TRUNC_CHARS = 2000;

/**
 * 单篇流式 AI 摘要与标题标签增强
 * @param {string} itemId
 * @param {{ bypass?: boolean, reasoningEffort?: string, onDelta?: (text: string) => void }} [opts]
 */
async function enrich(itemId, opts = {}) {
  const claim = nextClaim();
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, ai: null, cached: false, error: "AI_DISABLED" };

  const item = await dbSvc.getDoc(itemId);
  if (!item) return { ok: false, ai: null, cached: false, error: "NOT_FOUND" };

  if (!opts.bypass && item.aiStatus === "done" && item.ai && item.ai.aiSource === "enrich") {
    logger.info("ai.enrich", "item 层命中（已有 enrich 产物）", { itemId });
    return { ok: true, ai: item.ai, cached: true, error: null };
  }

  const full = await dbSvc.getItemFullBest(itemId);
  const text = full ? articleSvc.htmlToText(String(full).slice(0, 24576)) : "";
  const trunc = text.slice(0, TRUNC_CHARS);
  const truncHash = trunc
    ? dbSvc.sha12(trunc)
    : dbSvc.sha12(item.title + "‖" + (item.guid || "") + "‖" + (item.summaryText || ""));
  const titleHash = dbSvc.sha12(item.title);
  const cacheId = "ai:enrich:v2:" + truncHash + ":" + titleHash;

  if (!opts.bypass) {
    const cached = await cacheGet(cacheId);
    if (cached && cached.result) {
      const saved = await applyAi(item, cached.result, "enrich");
      logger.info("ai.enrich", "复合缓存命中并回写", { itemId, inputChars: trunc.length, hasFull: !!full });
      return { ok: true, ai: cached.result, cached: true, error: null, item: saved };
    }
  }

  const q = quotaCheck("manual", cfg);
  if (!q.ok) {
    logger.warn("ai.enrich", "手动池额度耗尽，跳过", { itemId, used: loadQuota().manual });
    return { ok: false, ai: null, cached: false, error: q.error };
  }

  const categories = await categoryList();
  const messages = buildEnrichMessages(item, trunc, categories);
  logger.info("ai.enrich", "发起合并调用", { itemId, engine: cfg.engine, inputChars: trunc.length, hasFull: !!full, bypass: !!opts.bypass, stream: true });

  let produced = false;
  const call = await callEngine(messages, {
    cfg,
    claim,
    stream: true,
    reasoningEffort: opts.reasoningEffort,
    onDelta: (t) => {
      produced = true;
      if (opts.onDelta) opts.onDelta(t);
    },
  });

  if (!call.ok) {
    if (produced) countCall("manual", cfg);
    if (call.aborted) {
      logger.info("ai.enrich", "调用被中止（离开面板等），产物全弃", { itemId, produced });
      return { ok: false, aborted: true, ai: null, cached: false, error: "ABORTED" };
    }
    logger.warn("ai.enrich", "调用失败", { itemId, error: call.error, produced });
    await markError(itemId);
    return { ok: false, ai: null, cached: false, error: call.error };
  }

  countCall("manual", cfg);
  const ai = parseEnrichOutput(call.content);
  logger.info("ai.enrich", "解析产物", {
    itemId,
    rawChars: call.content.length,
    summaryChars: ai.summary.length,
    titleZh: ai.titleZh ? "有" : "无",
    titleNorm: ai.titleNorm ? "有" : "无",
    tags: ai.tags.join(","),
    degraded: !/【titleZh】/.test(call.content),
  });
  await cachePut(cacheId, ai);
  const saved = await applyAi(item, ai, "enrich");
  await cacheTrim();
  logger.info("ai.enrich", "回写完成", { itemId, wrote: !!saved });
  return { ok: true, ai, cached: false, error: null, item: saved };
}

module.exports = { enrich, TRUNC_CHARS };
