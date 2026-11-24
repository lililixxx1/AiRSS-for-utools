// @ts-check
/**
 * ai/prompts.js — 提示词构建与 AI 输出解析（纯函数）
 */
const DEFAULT_CATEGORIES = ["科技", "商业", "设计", "开发", "工具", "生活", "文化", "其他"];

function firstSentence(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const m = t.split(/[。！？!?.\n\r]/)[0] || t;
  return m.slice(0, 80);
}

function buildEnrichMessages(item, truncText, categories) {
  const cat = (categories && categories.length ? categories : DEFAULT_CATEGORIES).join("/");
  const system =
    "你是中文资讯编辑。先输出一行元信息：\n" +
    "【titleZh】英文标题的中文版（非英文则留空）【titleNorm】AI优化标题：原标题冗长、含糊、堆砌关键词、标题党或营销腔时给出信息完整、清晰客观的中文标题（≤24字、无感叹号、不保留悬念），原标题已清晰则留空【tags】从可选分类中选1-2个标签（逗号分隔）\n" +
    "然后另起一行，写 3~5 句中文摘要：客观陈述核心事实与结论，不夸大、不添加文中没有的信息。";
  let user = "【可选分类】" + cat + "\n【标题】" + item.title;
  if (item.author) user += "\n【作者】" + String(item.author).slice(0, 60);
  user += "\n【正文】<<<\n" + (truncText || item.summaryText || "") + "\n>>>";
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildBatchMessages(docs, categories) {
  const cat = (categories && categories.length ? categories : DEFAULT_CATEGORIES).join("/");
  const system =
    "你是 RSS 分类助手。对列表中每篇文章：\n" +
    "1) 从可选分类中选 1-2 个最贴切的标签；\n" +
    "2) 英文标题 → 简洁中文标题 titleZh（中文标题则 titleZh 留空）；\n" +
    "3) 冗长、含糊、堆砌关键词、标题党或营销腔的标题 → 信息完整、清晰客观的中文 titleNorm（≤24字、无感叹号、不保留悬念），原标题已清晰则留空。\n" +
    '只输出 JSON 数组，无其他文字：[{"id":"…","tags":["…"],"titleZh":"…","titleNorm":"…"}]';
  const list = docs
    .map((d) => "id:" + d._id + "\n标题:" + d.title + "\n首句:" + firstSentence(d.summaryText))
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: "【可选分类】" + cat + "\n【文章列表】\n" + list },
  ];
}

function clampAiTitle(s, max = 30) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf("："),
    head.lastIndexOf("，"),
    head.lastIndexOf("、"),
    head.lastIndexOf("·"),
    head.lastIndexOf("—"),
    head.lastIndexOf("-"),
    head.lastIndexOf(" ")
  );
  let base = (cut >= 10 ? head.slice(0, cut) : head).replace(/[，、：·—\-\s]+$/, "");
  if (base.length > max - 1) base = base.slice(0, max - 1);
  return base + "…";
}

function parseEnrichOutput(text) {
  const out = { summary: "", titleZh: "", titleNorm: "", tags: [] };
  const head = String(text || "");
  const m = /【titleZh】\s*([^【\n]*)\s*【titleNorm】\s*([^【\n]*)\s*【tags】\s*([^【\n]*)/.exec(head);
  if (m) {
    out.titleZh = m[1].trim().slice(0, 60);
    out.titleNorm = clampAiTitle(m[2], 30);
    out.tags = m[3]
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 2);
    const after = head.slice(m.index + m[0].length);
    out.summary = after.replace(/^\s*[\r\n]+/, "").trim();
  } else {
    out.summary = head.trim();
  }
  if (out.summary.length > 500) out.summary = out.summary.slice(0, 500) + "…";
  return out;
}

function pickDisplayTitle(title, ai) {
  const cand = ((ai && (ai.titleNorm || ai.titleZh)) || "").trim();
  return cand && cand !== title ? cand : "";
}

function cjkRatio(text) {
  const t = String(text || "");
  if (!t) return 0;
  return (t.match(/[\u4e00-\u9fff]/g) || []).length / t.length;
}

function buildTransMessages(paras) {
  const system =
    "你是专业翻译。将列表中逐段编号的非中文段落译成流畅自然的简体中文，按编号一一对应。\n" +
    "输出格式：每段译文以 [[编号]] 开头，如 [[0]]译文内容。\n" +
    "不要输出解释或原文；代码/网址等非自然语言内容原样保留；已是中文的段落输出空段。";
  const user = paras.map((p) => "[[" + p.idx + "]]" + p.text).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseTransOutput(text) {
  const out = { texts: {}, count: 0 };
  const re = /\[\[(\d+)\]\]([\s\S]*?)(?=\[\[\d+\]\]|$)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const val = m[2].trim();
    if (!val) continue;
    out.texts[m[1]] = val.slice(0, 2000);
    out.count += 1;
  }
  return out;
}

function buildTocMessages(paras) {
  const system =
    "你是资深编辑。把栅栏内逐段编号的长文划分为 3~10 个连续章节，为每章拟一个客观的中文标题；章内若有明显可区分的子话题，可为该章再分 1~4 个子章并各自拟标题。\n" +
    "输入中部分行首的 #/##/### 等前缀是原文的标题标记，请参考其层级归属。\n" +
    "输出格式：每章或子章一行，以 [[起始段编号|层级]] 开头，层级 1=章、2=子章，子章行紧跟其章行，如 [[3|1]]章节标题、[[5|2]]子章标题；文章无明显子结构时全部用层级 1。\n" +
    "标题不超过 24 字、不带序号、表情或 # 前缀；只输出这些行，不要解释、不要复述正文。";
  const user =
    "<<<\n" +
    paras
      .map((p) => {
        const mm = /^h([1-6])$/.test(String(p && p.tag) || "") ? "#".repeat(Number(p.tag[1])) + " " : "";
        return "[[" + p.idx + "]]" + mm + p.text;
      })
      .join("\n") +
    "\n>>>";
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseTocOutput(text) {
  const out = { sections: [], count: 0 };
  const seen = new Set();
  const re = /\[\[(\d+)(?:\|(\d+))?\]\](.+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const idx = Number(m[1]);
    const level = Math.min(3, Math.max(1, Number(m[2] !== undefined ? m[2] : 1)));
    const title = m[3].trim().replace(/^#{1,6}\s*/, "").slice(0, 24);
    if (!Number.isInteger(idx) || idx < 0 || !title || seen.has(idx)) continue;
    seen.add(idx);
    out.sections.push({ title, idx, level });
    out.count += 1;
  }
  out.sections.sort((a, b) => a.idx - b.idx);
  return out;
}

function tocAnchorSections(paras, sections) {
  const byIdx = new Map(paras.map((p) => [p.idx, p]));
  const out = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    const p = byIdx.get(Number(s && s.idx));
    if (!p || !p.head) continue;
    const lv = Number(s && s.level);
    out.push({
      title: String(s.title || "").slice(0, 24),
      idx: p.idx,
      head: String(p.head).slice(0, 20),
      level: Number.isFinite(lv) && lv >= 1 && lv <= 3 ? Math.round(lv) : 1,
    });
  }
  return out;
}

module.exports = {
  DEFAULT_CATEGORIES,
  firstSentence,
  buildEnrichMessages,
  buildBatchMessages,
  clampAiTitle,
  parseEnrichOutput,
  pickDisplayTitle,
  cjkRatio,
  buildTransMessages,
  parseTransOutput,
  buildTocMessages,
  parseTocOutput,
  tocAnchorSections,
};
