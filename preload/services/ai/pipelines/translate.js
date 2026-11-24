// @ts-check
/**
 * ai/pipelines/translate.js — AI 段落翻译（流式 · 手动池）
 */
const dbSvc = require("../../db.js");
const logger = require("../../logger.js");
const { getConfig, modelLabelFor } = require("../config.js");
const { quotaCheck, countCall, loadQuota } = require("../quota.js");
const { cacheGet, cachePut, cacheTrim } = require("../cache.js");
const { nextClaim, callEngine } = require("../engines/index.js");
const { buildTransMessages, parseTransOutput, cjkRatio } = require("../prompts.js");
const { applyTrans, supersededByExtract } = require("./common.js");

const TRANS_MAX_PARAS = 10;
const TRANS_MAX_CHARS = 4000;

/**
 * AI 段落翻译（手动池）
 * @param {string} itemId
 * @param {Array<{ idx: number, head: string, text: string }>} paras
 * @param {{ bypass?: boolean, reasoningEffort?: string, onDelta?: (text: string) => void }} [opts]
 */
async function translateItem(itemId, paras, opts = {}) {
  const claim = nextClaim();
  const startedAt = Date.now();
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, aiTrans: null, cached: false, error: "AI_DISABLED" };

  const detail = await dbSvc.getItemDetail(itemId);
  const item = detail && detail.item;
  if (!item) return { ok: false, aiTrans: null, cached: false, error: "NOT_FOUND" };

  if (!opts.bypass && detail.aiTrans && Array.isArray(detail.aiTrans.paras) && detail.aiTrans.paras.length) {
    return { ok: true, aiTrans: detail.aiTrans, cached: true, error: null };
  }

  const list = (Array.isArray(paras) ? paras : [])
    .filter((p) => p && typeof p.text === "string" && p.text.trim())
    .slice(0, TRANS_MAX_PARAS);
  if (!list.length) return { ok: false, aiTrans: null, cached: false, error: "NO_PARAS" };

  const trimmed = [];
  let total = 0;
  for (const p of list) {
    if (total >= TRANS_MAX_CHARS) break;
    trimmed.push({ idx: p.idx, head: p.head, text: p.text.slice(0, TRANS_MAX_CHARS - total) });
    total += trimmed[trimmed.length - 1].text.length;
  }
  const joined = trimmed.map((p) => p.text).join("");

  if (cjkRatio(joined) > 0.5) {
    logger.info("ai.translate", "中文为主正文，跳过翻译", { itemId, cjkRatio: Math.round(cjkRatio(joined) * 100) / 100 });
    return { ok: false, aiTrans: null, cached: false, error: "NO_NEED" };
  }

  const cacheId = "ai:trans:v2:" + dbSvc.sha12(joined);
  if (!opts.bypass) {
    const cached = await cacheGet(cacheId);
    if (cached && cached.result && cached.result.texts) {
      if (await supersededByExtract(itemId, startedAt)) {
        logger.info("ai.translate", "提取已替换正文，缓存产物弃写", { itemId });
        return { ok: false, aiTrans: null, cached: false, error: "CONTENT_CHANGED" };
      }
      const res = await applyTrans(item, trimmed, cached.result.texts, cached.result.model);
      if (res && res.aiTrans) {
        logger.info("ai.translate", "复合缓存命中并回写", { itemId, paras: trimmed.length });
        return { ok: true, aiTrans: res.aiTrans, cached: true, error: null };
      }
    }
  }

  const q = quotaCheck("manual", cfg);
  if (!q.ok) {
    logger.warn("ai.translate", "手动池额度耗尽，跳过", { itemId, used: loadQuota().manual });
    return { ok: false, aiTrans: null, cached: false, error: q.error };
  }

  const messages = buildTransMessages(trimmed);
  logger.info("ai.translate", "发起段落翻译", { itemId, engine: cfg.engine, paras: trimmed.length, inputChars: joined.length, bypass: !!opts.bypass, stream: true });

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
      logger.info("ai.translate", "调用被中止，产物全弃", { itemId, produced });
      return { ok: false, aborted: true, aiTrans: null, cached: false, error: "ABORTED" };
    }
    logger.warn("ai.translate", "调用失败", { itemId, error: call.error, produced });
    return { ok: false, aiTrans: null, cached: false, error: call.error };
  }

  countCall("manual", cfg);
  const parsed = parseTransOutput(call.content);
  logger.info("ai.translate", "解析译文", { itemId, rawChars: call.content.length, paras: trimmed.length, parsed: parsed.count });
  if (!parsed.count) {
    return { ok: false, aiTrans: null, cached: false, error: "BAD_TRANS_OUTPUT" };
  }
  if (await supersededByExtract(itemId, startedAt)) {
    logger.info("ai.translate", "提取已替换正文，产物弃写", { itemId, paras: trimmed.length });
    return { ok: false, aiTrans: null, cached: false, error: "CONTENT_CHANGED" };
  }
  const model = modelLabelFor(cfg);
  await cachePut(cacheId, { texts: parsed.texts, model }, model);
  const res = await applyTrans(item, trimmed, parsed.texts, model);
  await cacheTrim();
  logger.info("ai.translate", "回写完成", { itemId, wrote: !!(res && res.aiTrans) });
  return { ok: true, aiTrans: res ? res.aiTrans : null, cached: false, error: null };
}

module.exports = { translateItem, TRANS_MAX_PARAS, TRANS_MAX_CHARS };
