// @ts-check
/**
 * laterService.js — 「存入稍后读」管线（mainHide + URL 正则）
 *
 * 将订阅外网页后台抓取 → 站内适配/Readability 提取 → 绝对化 + 消毒 → 写入 feed:__later__
 */
const { nodeFetch } = require("../services/http.js");
const { decodeBuffer, normalizeUrl } = require("../services/feed.js");
const { sanitizeContent, makeSummary, extractCover, htmlToText } = require("../services/article.js");
const adapters = require("../services/adapters.js");
const extractSvc = require("../services/extract.js");
const logger = require("../services/logger.js");
const storage = require("./storage.js");
const { ut, sha12 } = require("./utils.js");

const LATER_FEED_ID = "feed:__later__";
const ctx = { nodeFetch: (url, opts) => nodeFetch(url, opts) };

let engine;
function getDomEngine() {
  if (engine === undefined) {
    try {
      engine = {
        parseHTML: require("linkedom").parseHTML,
        Readability: require("@mozilla/readability").Readability,
      };
    } catch (_) {
      engine = null;
    }
  }
  return engine;
}

function extractTitleFallback(document, fallbackUrl) {
  try {
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    if (og && og.trim()) return og.trim().slice(0, 140);
    const t = document.querySelector("title")?.textContent;
    if (t && t.trim()) return t.trim().slice(0, 140);
  } catch (_) { /* ignore */ }
  return fallbackUrl;
}

function notify(body) {
  try {
    const u = ut();
    if (u && typeof u.showNotification === "function") u.showNotification(body, "airss");
  } catch (_) { /* ignore */ }
}

async function saveUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    return { ok: false, item: null, error: "INVALID_URL" };
  }
  const t0 = Date.now();
  const res = await ctx.nodeFetch(url, { timeout: 12000, maxBytes: 3 * 1024 * 1024 });
  if (!res.ok) {
    const err = "FETCH_" + String(res.error || res.status || "FAILED").slice(0, 40);
    logger.warn("later", "抓取失败", { error: err });
    notify("存入稍后读失败（网页抓取失败）");
    return { ok: false, item: null, error: err };
  }

  const finalUrl = res.url || url;
  const html = decodeBuffer(res.body, res.headers["content-type"]);
  let clean = "";
  let title = finalUrl;
  let author = "";
  let cover = null;

  const eng = getDomEngine();
  if (eng && html && /<[a-z!]/i.test(html.slice(0, 1000))) {
    try {
      const { document } = eng.parseHTML(html);
      title = extractTitleFallback(document, finalUrl);
      const adapted = adapters.extractArticle(finalUrl, document);
      if (adapted && adapted.content) {
        clean = sanitizeContent(extractSvc.__test.absolutize(adapted.content, finalUrl));
        cover = adapted.cover || extractCover(clean);
      }
      if (!clean || htmlToText(clean).length < 80) {
        const art = new eng.Readability(document).parse();
        if (art) {
          if (art.title && art.title.trim()) title = art.title.trim().slice(0, 140);
          if (art.byline) author = String(art.byline).trim().slice(0, 80);
          if (art.content) {
            clean = sanitizeContent(extractSvc.__test.absolutize(art.content, finalUrl));
            if (!cover) cover = extractCover(clean);
          }
        }
      }
    } catch (_) {
      /* 降级：只保留标题和兜底摘要 */
    }
  }

  if (!clean) {
    clean = sanitizeContent(
      `<p>原网页正文未能自动提取，请点击上方「原文」打开查看。</p><p><a href="${finalUrl}" rel="noopener" target="_blank">${finalUrl}</a></p>`
    );
  }

  const summaryText = makeSummary(clean);
  const item = await storage.saveLaterArticle({
    url: finalUrl,
    link: finalUrl,
    title,
    author,
    contentHtml: clean,
    summaryText,
    cover,
    contentHash: sha12(clean),
  });

  storage.flush();
  logger.info("later", "存入稍后读完成", { itemId: item._id, ms: Date.now() - t0 });
  notify("已存入稍后读：" + title.slice(0, 40));
  return { ok: true, item, error: null };
}

module.exports = {
  LATER_FEED_ID,
  saveUrl,
  __test: { ctx },
};
