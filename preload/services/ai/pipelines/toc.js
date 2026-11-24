// @ts-check
/**
 * ai/pipelines/toc.js — AI 目录生成（手动池）
 */
const dbSvc = require("../../db.js");
const logger = require("../../logger.js");
const { getConfig, modelLabelFor } = require("../config.js");
const { quotaCheck, countCall, loadQuota } = require("../quota.js");
const { cacheGet, cachePut, cacheTrim } = require("../cache.js");
const { nextClaim, callEngine } = require("../engines/index.js");
const { buildTocMessages, parseTocOutput, tocAnchorSections } = require("../prompts.js");
const { applyToc, supersededByExtract } = require("./common.js");

const TOC_MAX_PARAS = 200;
const TOC_PARA_CHARS = 200;
const TOC_MAX_CHARS = 10000;

/**
 * AI 目录生成（手动池）
 * @param {string} itemId
 * @param {Array<{ idx: number, head: string, text: string, tag?: string }>} paras
 * @param {{ bypass?: boolean, reasoningEffort?: string }} [opts]
 */
async function generateToc(itemId, paras, opts = {}) {
  const claim = nextClaim();
  const startedAt = Date.now();
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, aiToc: null, cached: false, error: "AI_DISABLED" };

  const detail = await dbSvc.getItemDetail(itemId);
  const item = detail && detail.item;
  if (!item) return { ok: false, aiToc: null, cached: false, error: "NOT_FOUND" };

  if (!opts.bypass && detail.aiToc && Array.isArray(detail.aiToc.sections) && detail.aiToc.sections.length) {
    return { ok: true, aiToc: detail.aiToc, cached: true, error: null };
  }

  const list = (Array.isArray(paras) ? paras : [])
    .filter((p) => p && Number.isInteger(p.idx) && typeof p.head === "string" && typeof p.text === "string" && p.text.trim())
    .slice(0, TOC_MAX_PARAS);
  if (!list.length) return { ok: false, aiToc: null, cached: false, error: "NO_PARAS" };

  const trimmed = [];
  let total = 0;
  for (const p of list) {
    if (total >= TOC_MAX_CHARS) break;
    trimmed.push({ idx: p.idx, head: p.head, text: p.text.slice(0, Math.min(TOC_PARA_CHARS, TOC_MAX_CHARS - total)), tag: p.tag });
    total += trimmed[trimmed.length - 1].text.length;
  }
  const joined = trimmed.map((p) => p.text).join("");

  const cacheId = "ai:toc:v2:" + dbSvc.sha12(joined);
  if (!opts.bypass) {
    const cached = await cacheGet(cacheId);
    if (cached && cached.result && Array.isArray(cached.result.sections) && cached.result.sections.length) {
      if (await supersededByExtract(itemId, startedAt)) {
        logger.info("ai.toc", "提取已替换正文，缓存产物弃写", { itemId });
        return { ok: false, aiToc: null, cached: false, error: "CONTENT_CHANGED" };
      }
      const res = await applyToc(item, trimmed, cached.result.sections, cached.result.model);
      if (res && res.aiToc) {
        logger.info("ai.toc", "复合缓存命中并回写", { itemId, sections: res.aiToc.sections.length });
        return { ok: true, aiToc: res.aiToc, cached: true, error: null };
      }
    }
  }

  const q = quotaCheck("manual", cfg);
  if (!q.ok) {
    logger.warn("ai.toc", "手动池额度耗尽，跳过", { itemId, used: loadQuota().manual });
    return { ok: false, aiToc: null, cached: false, error: q.error };
  }

  const messages = buildTocMessages(trimmed);
  logger.info("ai.toc", "发起目录生成", { itemId, engine: cfg.engine, paras: trimmed.length, inputChars: joined.length, bypass: !!opts.bypass });

  let produced = false;
  const call = await callEngine(messages, {
    cfg,
    claim,
    stream: true,
    reasoningEffort: opts.reasoningEffort,
    onDelta: () => { produced = true; },
  });

  if (!call.ok) {
    if (produced) countCall("manual", cfg);
    if (call.aborted) {
      logger.info("ai.toc", "调用被中止，产物全弃", { itemId, produced });
      return { ok: false, aborted: true, aiToc: null, cached: false, error: "ABORTED" };
    }
    logger.warn("ai.toc", "调用失败", { itemId, error: call.error, produced });
    return { ok: false, aiToc: null, cached: false, error: call.error };
  }

  countCall("manual", cfg);
  const parsed = parseTocOutput(call.content);
  logger.info("ai.toc", "解析目录", { itemId, rawChars: call.content.length, sections: parsed.count });
  if (!parsed.count) {
    return { ok: false, aiToc: null, cached: false, error: "BAD_TOC_OUTPUT" };
  }
  const anchored = tocAnchorSections(trimmed, parsed.sections);
  if (!anchored.length) {
    return { ok: false, aiToc: null, cached: false, error: "BAD_TOC_OUTPUT" };
  }
  if (await supersededByExtract(itemId, startedAt)) {
    logger.info("ai.toc", "提取已替换正文，产物弃写", { itemId, sections: parsed.count });
    return { ok: false, aiToc: null, cached: false, error: "CONTENT_CHANGED" };
  }

  const model = modelLabelFor(cfg);
  await cachePut(cacheId, { sections: anchored.map(({ title, idx, level }) => ({ title, idx, level })), model }, model);
  const res = await applyToc(item, trimmed, parsed.sections, model);
  await cacheTrim();
  logger.info("ai.toc", "回写完成", { itemId, wrote: !!(res && res.aiToc) });
  return { ok: true, aiToc: res ? res.aiToc : null, cached: false, error: null };
}

module.exports = { generateToc, TOC_MAX_PARAS, TOC_PARA_CHARS, TOC_MAX_CHARS };
