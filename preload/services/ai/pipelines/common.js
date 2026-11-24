// @ts-check
/**
 * ai/pipelines/common.js — 各 AI 管线共用回写与竞态守卫
 */
const dbSvc = require("../../db.js");
const { DEFAULT_CATEGORIES, pickDisplayTitle, tocAnchorSections } = require("../prompts.js");

async function categoryList() {
  try {
    const feeds = await dbSvc.getFeeds();
    const set = new Set(DEFAULT_CATEGORIES);
    for (const f of feeds) if (f.category) set.add(f.category);
    return [...set].slice(0, 12);
  } catch (_) {
    return DEFAULT_CATEGORIES.slice();
  }
}

async function applyAi(itemDoc, ai, source) {
  const fresh = await dbSvc.getDoc(itemDoc._id);
  if (!fresh) return null;
  if (source === "batch" && fresh.ai && fresh.ai.aiSource === "enrich") return fresh;
  const nextAi = {
    summary: String(ai.summary || ""),
    tags: Array.isArray(ai.tags) ? ai.tags.map(String).slice(0, 2) : [],
    titleZh: String(ai.titleZh || ""),
    titleNorm: String(ai.titleNorm || ""),
    aiSource: source,
  };
  const disp = pickDisplayTitle(fresh.title, nextAi);
  const saved = await dbSvc.saveItemAi(fresh._id, {
    ai: nextAi,
    aiStatus: "done",
    titleDisplay: disp || fresh.title,
  });
  return saved || fresh;
}

async function markError(itemId) {
  const fresh = await dbSvc.getDoc(itemId);
  if (!fresh || fresh.aiStatus === "done") return;
  await dbSvc.saveItemAi(fresh._id, { aiStatus: "error" });
}

async function applyTrans(itemDoc, paras, texts, model) {
  const fresh = await dbSvc.getDoc(itemDoc._id);
  if (!fresh) return null;
  const out = [];
  for (const p of paras) {
    const t = texts[String(p.idx)];
    if (t) out.push({ idx: p.idx, head: String(p.head || "").slice(0, 20), text: t });
  }
  if (!out.length) return { item: fresh, aiTrans: null };
  const aiTrans = { paras: out, at: Date.now(), model };
  const saved = await dbSvc.saveItemAi(fresh._id, { aiTrans });
  return { item: saved || fresh, aiTrans };
}

async function applyToc(itemDoc, paras, sections, model) {
  const fresh = await dbSvc.getDoc(itemDoc._id);
  if (!fresh) return null;
  const out = tocAnchorSections(paras, sections);
  if (!out.length) return { item: fresh, aiToc: null };
  const aiToc = { sections: out, at: Date.now(), model };
  const saved = await dbSvc.saveItemAi(fresh._id, { aiToc });
  return { item: saved || fresh, aiToc };
}

async function supersededByExtract(itemId, startedAt) {
  const x = await dbSvc.getItemFullxMeta(itemId);
  return !!(x && x.at && x.at > startedAt);
}

module.exports = {
  categoryList,
  applyAi,
  markError,
  applyTrans,
  applyToc,
  supersededByExtract,
};
