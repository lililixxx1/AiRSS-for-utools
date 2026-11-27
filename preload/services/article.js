/**
 * article.js — 文章内容加工：消毒、摘要、封面、阅读时长
 *
 * 安全基线（PLAN §7）：preload 是唯一 HTML 生产方；渲染层 v-html 只信任本模块产物。
 */
const { Buffer } = require("buffer");

/** 消毒白名单（标签/属性严格白名单，其余全剥） */
const SANITIZE_BASE_OPTIONS = {
  allowedTags: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "img", "a", "table", "thead", "tbody", "tr", "td", "th", "strong", "em"],
  allowedAttributes: {
    img: ["src", "alt", "width", "height"],
    a: ["href", "title", "rel", "target"],
  },
  // 只放行 http(s) 图与链接（协议相对 // 与 javascript: 一律剥）
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: { img: ["https"], a: ["http", "https"] },
  disallowedTagsMode: "discard",
  // 显式禁止（纵深防御，白名单本已排除）
  forbiddenTags: ["svg", "math", "form", "input", "iframe", "style", "link", "meta", "script"],
};

let sanitizeHtmlLib = null;
let sanitizeOptionsCache = null;

// 惰性初始化 sanitize-html 与 transformTags，避免冷启动首屏承受不必要的依赖解析开销
function getSanitizer() {
  if (!sanitizeHtmlLib) {
    sanitizeHtmlLib = require("sanitize-html");
    sanitizeOptionsCache = {
      ...SANITIZE_BASE_OPTIONS,
      transformTags: {
        a: sanitizeHtmlLib.simpleTransform("a", { rel: "noopener", target: "_blank" }),
      },
    };
  }
  return { sanitizeHtml: sanitizeHtmlLib, sanitizeOptions: sanitizeOptionsCache };
}

const MAX_CONTENT_BYTES = 100 * 1024; // 正文分层上限：100KB UTF-8 字节

/**
 * 消毒 HTML；超过 100KB 字节则按字符截断后二次消毒（parser 自动闭合残缺标签）
 * @param {string} html
 * @returns {string}
 */
function sanitizeContent(html) {
  if (!html) return "";
  const { sanitizeHtml, sanitizeOptions } = getSanitizer();
  let clean = sanitizeHtml(String(html), sanitizeOptions);
  if (Buffer.byteLength(clean, "utf8") > MAX_CONTENT_BYTES) {
    // 先按字符粗切到 ~99KB 字节，再消毒一次让标签闭合
    let cut = clean.length;
    while (cut > 0 && Buffer.byteLength(clean.slice(0, cut), "utf8") > MAX_CONTENT_BYTES - 512) {
      cut = Math.floor(cut / 2);
    }
    clean = sanitizeHtml(clean.slice(0, cut) + "…", sanitizeOptions);
  }
  return clean;
}

/** HTML → 纯文本（剥全部标签、实体解码由 sanitize-html 顺路完成） */
// 装饰符号属正文排版噪音（箭头/杂项/几何图形/象形部首区块、零宽变体选择符），摘要里只添乱
const NOISE_SYMBOL_RE = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2B00-\u2BFF\uFE0F\u2060]/g;
// 块级边界先换成空格：sanitize-html 剥标签是**直接删除**，<p>a</p><p>b</p> 会粘成 "ab"
// （2026-10 摘要改由 contentHtml 派生后暴露：英文摘要曾变成 "alphabeta"）
const BLOCK_BREAK_RE = /<\/(?:p|div|section|article|li|ul|ol|h[1-6]|blockquote|pre|tr|td|th|table)\s*>|<br\s*\/?>/gi;
function htmlToText(html) {
  if (!html) return "";
  const { sanitizeHtml } = getSanitizer();
  return sanitizeHtml(String(html).replace(BLOCK_BREAK_RE, " "), { allowedTags: [], allowedAttributes: {} })
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

/** 文本里是否已有 HTML 标签（有则说明是富文本源，段落化不介入） */
const HAS_HTML_TAG_RE = /<\/?[a-z][^<>]*>/i;
/** 中日韩字符（判断「一段一行」还是「拉丁文硬折行」的锚） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
/** 句末标点（上一行以它收尾 = 语句完整，下一行另起一段；含 ASCII 句点，缺它英文硬折行会连成一大段） */
const SENTENCE_END_RE = /[.!?。！？；;…：:]["'”』」)\]]?$/;

/** 纯文本片段转义（段落化时产 HTML 文本节点的唯一出口） */
function escapeText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 纯文本正文段落化（2026-10，AIGC NEWS 一类聚合源实测）。
 *
 * 现象：很多源的 description 是**纯文本**，段落只用 \n 分隔、没有任何标签。原样塞进
 * sanitize 后整篇是一个文本节点，浏览器把换行折叠成空格——阅读器里就是「一堵墙」，
 * 两三段的中文资讯读起来完全失去结构。这里把纯文本按行重建为 `<p>`。
 *
 * 规则（宁保守勿误伤）：
 *  - 已含标签 → 原样返回（富文本源的 \n 是排版噪声，动了反而破坏）；
 *  - 无换行 → 原样返回（单段纯文本包 <p> 无视觉差异，且会无谓改变 contentHash 造成全量重入库）；
 *  - 空行（\n\n）= 硬分段；非空行之间默认也视为分段（中文源普遍「一段一行」）；
 *  - 例外：拉丁文硬折行接回同一段（上一行 ≥40 字符且无句末标点、下一行以小写/数字/左括号开头）——
 *    否则英文源会被折成一句一段的碎片。
 * @param {string} text
 * @returns {string} 段落化后的 HTML 或原值
 */
function paragraphizePlainText(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim() || !s.includes("\n") || HAS_HTML_TAG_RE.test(s)) return s;
  const blocks = s.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return s;
  const paras = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    let buf = "";
    for (const line of lines) {
      if (!buf) {
        buf = line;
        continue;
      }
      const hardWrap =
        !SENTENCE_END_RE.test(buf) &&
        buf.length >= 40 &&
        !CJK_RE.test(buf) &&
        !CJK_RE.test(line) &&
        /^[a-z0-9([“"']/.test(line); // 小写/数字/括号/引号起头才是同一句的续行；大写起头多为新句
      if (hardWrap) {
        buf = buf + " " + line;
      } else {
        paras.push(buf);
        buf = line;
      }
    }
    if (buf) paras.push(buf);
  }
  if (!paras.length) return s;
  return paras.map((p) => `<p>${escapeText(p)}</p>`).join("");
}

/** 阅读时长估算（中文 ~400 字/分钟，至少 1 分钟） */
function readingMinutes(text) {
  const n = (text || "").length;
  return Math.max(1, Math.round(n / 400));
}

module.exports = { sanitizeContent, htmlToText, makeSummary, extractCover, readingMinutes, paragraphizePlainText, SANITIZE_OPTIONS: SANITIZE_BASE_OPTIONS, MAX_CONTENT_BYTES };
