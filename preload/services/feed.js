/**
 * feed.js — 订阅发现管线 + 抓取解析
 *
 * 发现管线（PLAN §5.2）：校验 → RSS/Atom 直判 → <link rel=alternate> 探测 → 常见路径探测
 * 抓取（PLAN §5.1）：ETag/If-Modified-Since 条件请求；304 直接返回不解析
 */
const { nodeFetch } = require("./http.js");
const { sanitizeContent, makeSummary, extractCover, htmlToText } = require("./article.js");
const crypto = require("crypto");
const iconv = require("iconv-lite");
const Parser = require("rss-parser").Parser || require("rss-parser");

const parser = new Parser({
  // RSS2.0 全文常在 content:encoded；v3 需要 customFields 映射
  customFields: { item: [["content:encoded", "contentEncoded"], ["encoded", "encodedAlt"]] },
});

const COMMON_PATHS = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/index.xml", "/rss.xml"];

/** 发现期智能默认阈值：与 extract.js FULLTEXT_MIN_CHARS 同值（rich 守卫判定线）——
 *  低于此线的源只带摘要，打开文章时抓原文才有增量 */
const FULLTEXT_SUGGEST_CHARS = 600;

/** 摘要型源启发式（2026-09-12，驱动添加弹窗「抓取全文」智能默认）：抽样近期条目
 *  （feed 一般最新在前，取前 5 条）的正文中位纯文本长度，中位数 < 阈值 → 只带摘要。
 *  协议无关——RSS2.0 的 content:encoded/description 与 Atom 的 content/summary 已在
 *  parseFeedXml 归一到 contentHtml，量的是「源实际带来多少正文」而非猜协议字段。
 *  @returns {boolean|null} true=摘要型 false=全文型 null=无条目可量（空源，勿当全文型断言） */
function looksSummaryOnly(items) {
  const lens = (items || []).slice(0, 5).map((it) => htmlToText(it.contentHtml || "").trim().length);
  if (!lens.length) return null;
  lens.sort((a, b) => a - b);
  // 偶数长度取上中位（[100,700] 取 700 → 不预开）：偏保守——误判"摘要型"由 extract.js
  // rich 守卫兜底（≥600 字条目零成本短路），误判"全文型"只是默认关、用户可改，两头代价都小
  return lens[Math.floor(lens.length / 2)] < FULLTEXT_SUGGEST_CHARS;
}

/** 文本是否像 RSS/Atom 源（宽松判定：声明或根元素） */
function looksLikeFeedXml(text) {
  const head = String(text).slice(0, 600).toLowerCase();
  if (!head.includes("<")) return false;
  return head.includes("<rss") || head.includes("<feed") || head.includes("<rdf:rdf") || (head.includes("<?xml") && head.includes("<channel"));
}

/** 编码兜底：Content-Type charset → XML 声明 encoding → UTF-8（GBK 等老源靠这层） */
function decodeBuffer(buf, contentType) {
  let charset = "";
  const ct = String(contentType || "").toLowerCase();
  const ctM = /charset=([\w-]+)/.exec(ct);
  if (ctM) charset = ctM[1];
  if (!charset) {
    // XML 声明在文档头部，latin1 读出原始字节再正则
    const head = buf.slice(0, 300).toString("latin1").toLowerCase();
    const m = /encoding="([\w-]+)"/.exec(head) || /encoding='([\w-]+)'/.exec(head);
    if (m) charset = m[1];
  }
  charset = (charset || "utf-8").toLowerCase();
  if (charset === "utf8") charset = "utf-8";
  if (!iconv.encodingExists(charset)) charset = "utf-8";
  return iconv.decode(buf, charset);
}

/**
 * 解析 feed XML → 归一化条目
 * @returns {{meta:{title,siteUrl,desc}, items:Array}}
 */
async function parseFeedXml(xml) {
  const parsed = await parser.parseString(xml);
  const now = Date.now();
  const items = [];
  // 逐条处理 + 每 5 条让出主线程：sanitize-html 对大正文是 CPU 尖峰，
  // preload 与渲染层同线程，一口气处理几十条会把刷新期间的 UI 卡成幻灯片
  for (let i = 0; i < (parsed.items || []).length; i++) {
    const raw = parsed.items[i];
    const contentHtml = sanitizeContent(raw.contentEncoded || raw.encodedAlt || raw.content || raw.summary || "");
    let pubTs = raw.isoDate ? Date.parse(raw.isoDate) : NaN;
    if (!Number.isFinite(pubTs)) pubTs = now; // 无日期源用入库时间，仅展示排序（不参与 _id）
    if (pubTs > now + 60_000) pubTs = now; // 未来日期 clamp
    items.push({
      guid: raw.guid || raw.id || "",
      link: raw.link || "",
      title: String(raw.title || "").trim() || "(无标题)",
      author: raw.creator || raw.author || "",
      pubTs,
      contentHtml,
      contentHash: crypto.createHash("sha256").update(contentHtml || String(raw.title || "")).digest("hex").slice(0, 12),
      summaryText: makeSummary(raw.contentSnippet || contentHtml || raw.title || ""),
      cover: extractCover(contentHtml),
    });
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
  }
  return {
    meta: {
      title: String(parsed.title || "").trim(),
      siteUrl: parsed.link || "",
      desc: String(parsed.description || "").trim(),
    },
    items,
  };
}

/**
 * 条件抓取一个 feed。返回 {status:'ok'|'not_modified'|'error', meta?, items?, error?}
 * @param {string} feedUrl
 * @param {{etag?:string, lastModified?:string, timeout?:number}} cond
 */
async function fetchFeed(feedUrl, cond = {}) {
  const headers = {};
  if (cond.etag) headers["If-None-Match"] = cond.etag;
  if (cond.lastModified) headers["If-Modified-Since"] = cond.lastModified;

  const res = await nodeFetch(feedUrl, { headers, timeout: cond.timeout || 12000 });
  if (!res.ok) return { status: "error", error: res.error || "HTTP_" + res.status };
  if (res.status === 304) return { status: "not_modified" };

  const xml = decodeBuffer(res.body, res.headers["content-type"]);
  if (!looksLikeFeedXml(xml)) return { status: "error", error: "NOT_FEED_XML" };
  try {
    const { meta, items } = await parseFeedXml(xml);
    return {
      status: "ok",
      meta,
      items,
      etag: res.headers.etag || "",
      lastModified: res.headers["last-modified"] || "",
    };
  } catch (e) {
    return { status: "error", error: "PARSE_FAILED:" + String(e.message || e).slice(0, 60) };
  }
}

/** URL 规整：裸域名补 https:// */
function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  return s;
}

/**
 * 发现管线：返回 {found, candidates:[{url,title,itemCount,summaryOnly}], tried:[{path,result}]}
 * 候选按确定性排序：直连 feed > <link> 声明 > 路径探测。summaryOnly：摘要型源启发式结果，
 * 渲染层据此预开「抓取全文」（全文型/未知保持关，用户可改）。
 */
async function discoverFeed(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const tried = [];

  // 1) 直连即 feed
  const direct = await fetchFeed(url, { timeout: 10000 });
  if (direct.status === "ok") {
    return { found: true, candidates: [{ url, title: direct.meta.title || url, itemCount: direct.items.length, summaryOnly: looksSummaryOnly(direct.items) }], tried: [{ path: "(直连)", result: "feed" }] };
  }
  tried.push({ path: "(直连)", result: direct.error });

  // 2) HTML <link rel="alternate"> 声明
  let html = "";
  const page = await nodeFetch(url, { timeout: 8000 });
  if (page.ok) {
    html = decodeBuffer(page.body, page.headers["content-type"]);
    const links = [];
    const re = /<link[^>]+rel=["']alternate["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html)) && links.length < 5) {
      const tag = m[0];
      if (/type=["']application\/(rss|atom)\+xml["']/i.test(tag)) {
        const hrefM = /href=["']([^"']+)["']/i.exec(tag);
        if (hrefM) links.push(new URL(hrefM[1], url).toString());
      }
    }
    for (const link of links) {
      const probe = await fetchFeed(link, { timeout: 8000 });
      if (probe.status === "ok") {
        return { found: true, candidates: [{ url: link, title: probe.meta.title || link, itemCount: probe.items.length, summaryOnly: looksSummaryOnly(probe.items) }], tried: tried.concat([{ path: "<link> 声明", result: link }]) };
      }
      tried.push({ path: "<link> 声明", result: probe.error });
    }
  } else {
    tried.push({ path: "页面抓取", result: page.error });
  }

  // 3) 常见路径探测（逐个 5s）
  const origin = new URL(url).origin;
  for (const p of COMMON_PATHS) {
    const cand = origin + p;
    const probe = await fetchFeed(cand, { timeout: 5000 });
    if (probe.status === "ok") {
      return { found: true, candidates: [{ url: cand, title: probe.meta.title || cand, itemCount: probe.items.length, summaryOnly: looksSummaryOnly(probe.items) }], tried: tried.concat([{ path: p, result: "feed" }]) };
    }
    tried.push({ path: p, result: probe.error });
  }

  return { found: false, candidates: [], tried };
}

module.exports = { fetchFeed, discoverFeed, normalizeUrl, parseFeedXml, looksLikeFeedXml, decodeBuffer, looksSummaryOnly };
