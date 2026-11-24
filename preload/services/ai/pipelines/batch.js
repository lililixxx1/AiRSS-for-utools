// @ts-check
/**
 * ai/pipelines/batch.js — 刷新后轻量批（≤20 篇/次 · 后台池）
 */
const dbSvc = require("../../db.js");
const logger = require("../../logger.js");
const { getConfig } = require("../config.js");
const { quotaCheck, countCall, loadQuota } = require("../quota.js");
const { cacheGet, cachePut, cacheTrim } = require("../cache.js");
const { nextClaim, callEngine } = require("../engines/index.js");
const { buildBatchMessages, clampAiTitle } = require("../prompts.js");
const { categoryList, applyAi } = require("./common.js");

const BATCH_MAX = 20;

async function batchEnrich(itemDocs) {
  const claim = nextClaim();
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, updated: [], error: "AI_DISABLED" };

  const updated = [];
  const candidates = [];
  for (const doc of itemDocs || []) {
    if (!doc || doc.aiStatus === "done" || doc.aiStatus === "error") continue;
    const cacheId = "ai:cls:v2:" + dbSvc.sha12(doc.title);
    const cached = await cacheGet(cacheId);
    if (cached && cached.result) {
      const r = await applyAi(doc, cached.result, "batch");
      if (r) updated.push(r);
      continue;
    }
    if (candidates.length < BATCH_MAX) candidates.push({ doc, cacheId });
  }
  if (!candidates.length) return { ok: true, updated, error: null };

  const q = quotaCheck("bg", cfg);
  if (!q.ok) {
    logger.warn("ai.batch", "后台池额度耗尽，本批跳过", { pending: candidates.length, used: loadQuota().bg });
    return { ok: false, updated, error: q.error };
  }

  const categories = await categoryList();
  const call = await callEngine(buildBatchMessages(candidates.map((c) => c.doc), categories), {
    cfg,
    claim,
    stream: false,
    reasoningEffort: "none", // 轻量批固定非思考提速
  });
  if (!call.ok) {
    logger.warn("ai.batch", "批量调用失败", { pending: candidates.length, error: call.error });
    return { ok: false, updated, error: call.error };
  }
  countCall("bg", cfg);

  let arr;
  try {
    const m = /\[[\s\S]*\]/.exec(call.content);
    arr = JSON.parse(m ? m[0] : call.content);
    if (!Array.isArray(arr)) throw new Error("not_array");
  } catch (_) {
    logger.warn("ai.batch", "JSON 输出解析失败", { rawChars: call.content.length, head: call.content.slice(0, 60) });
    return { ok: false, updated, error: "BAD_JSON_OUTPUT" };
  }

  const byId = new Map();
  for (const row of arr) if (row && row.id != null) byId.set(String(row.id), row);

  let applied = 0;
  for (const c of candidates) {
    const row = byId.get(String(c.doc._id));
    if (!row) continue;
    const ai = {
      summary: "",
      tags: Array.isArray(row.tags)
        ? row.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 2)
        : String(row.tags || "")
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 2),
      titleZh: String(row.titleZh || "").trim().slice(0, 60),
      titleNorm: clampAiTitle(row.titleNorm, 30),
    };
    await cachePut(c.cacheId, ai);
    const r = await applyAi(c.doc, ai, "batch");
    if (r) {
      updated.push(r);
      applied += 1;
    }
  }
  await cacheTrim();
  logger.info("ai.batch", "轻量批完成", { sent: candidates.length, parsed: arr.length, applied, cacheDirect: updated.length - applied });
  return { ok: true, updated, error: null };
}

module.exports = { batchEnrich, BATCH_MAX };
