/**
 * article.js — 文章内容加工：消毒、摘要、封面、阅读时长
 *
 * 安全基线（PLAN §7）：preload 是唯一 HTML 生产方；渲染层 v-html 只信任本模块产物。
 */
const sanitizeHtml = require("sanitize-html");

/** 消毒白名单（标签/属性严格白名单，其余全剥） */
const SANITIZE_OPTIONS = {
  allowedTags: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "img", "a", "table", "thead", "tbody", "tr", "td", "th", "strong", "em"],
  allowedAttributes: {
    img: ["src", "alt", "width", "height"],
    a: ["href", "title", "rel", "target"],
  },
  // 只放行 http(s) 图与链接（协议相对 // 与 javascript: 一律剥）
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: { img: ["https"], a: ["http", "https"] },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener", target: "_blank" }),
  },
  disallowedTagsMode: "discard",
  // 显式禁止（纵深防御，白名单本已排除）
  forbiddenTags: ["svg", "math", "form", "input", "iframe", "style", "link", "meta", "script"],
};

const MAX_CONTENT_BYTES = 100 * 1024; // 正文分层上限：100KB UTF-8 字节

/**
 * 消毒 HTML；超过 100KB 字节则按字符截断后二次消毒（parser 自动闭合残缺标签）
 * @param {string} html
 * @returns {string}
 */
function sanitizeContent(html) {
  if (!html) return "";
  let clean = sanitizeHtml(String(html), SANITIZE_OPTIONS);
  if (Buffer.byteLength(clean, "utf8") > MAX_CONTENT_BYTES) {
    // 先按字符粗切到 ~99KB 字节，再消毒一次让标签闭合
    let cut = clean.length;
    while (cut > 0 && Buffer.byteLength(clean.slice(0, cut), "utf8") > MAX_CONTENT_BYTES - 512) {
      cut = Math.floor(cut / 2);
    }
    clean = sanitizeHtml(clean.slice(0, cut) + "…", SANITIZE_OPTIONS);
  }
  return clean;
}

/** HTML → 纯文本（剥全部标签、实体解码由 sanitize-html 顺路完成） */
// 装饰符号属正文排版噪音（箭头/杂项/几何图形/象形部首区块、零宽变体选择符），摘要里只添乱
const NOISE_SYMBOL_RE = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2B00-\u2BFF\uFE0F\u2060]/g;
function htmlToText(html) {
  if (!html) return "";
  return sanitizeHtml(String(html), { allowedTags: [], allowedAttributes: {} })
    .replace(NOISE_SYMBOL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 生成摘要（≤300 字符）
 * @param {string} htmlOrText
 */
function makeSummary(htmlOrText, max = 300) {
  const text = /<[a-z!]/i.test(htmlOrText || "") ? htmlToText(htmlOrText) : String(htmlOrText || "");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** 封面候选里的明显小图标/头像/装饰图（URL 特征启发式） */
const COVER_JUNK_RE = /(avatar|favicon|icon|logo|emoji|spacer|pixel|tracking|badge|\.svg(\?|$))/i;

/**
 * 提取封面：正文中第一张合格的 https 图
 * 门控：URL 像图标/头像的跳过；img 自带 width/height 属性且过小的跳过。
 * 自然尺寸（URL 不暴露）由渲染层 banner 的 @load 复查兜底。
 * @returns {string|null}
 */
function extractCover(html) {
  if (!html) return null;
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(String(html)))) {
    const tag = m[0];
    const src = /\ssrc=["'](https:\/\/[^"']+)["']/i.exec(tag);
    if (!src) continue;
    if (COVER_JUNK_RE.test(src[1])) continue;
    const w = /[\s]width=["']?(\d{2,4})/i.exec(tag);
    const h = /[\s]height=["']?(\d{2,4})/i.exec(tag);
    if (w && parseInt(w[1], 10) < 300) continue;
    if (h && parseInt(h[1], 10) < 100) continue;
    return src[1];
  }
  return null;
}

/** 阅读时长估算（中文 ~400 字/分钟，至少 1 分钟） */
function readingMinutes(text) {
  const n = (text || "").length;
  return Math.max(1, Math.round(n / 400));
}

module.exports = { sanitizeContent, htmlToText, makeSummary, extractCover, readingMinutes, SANITIZE_OPTIONS, MAX_CONTENT_BYTES };
