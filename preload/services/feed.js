/**
 * feed.js — 订阅发现管线 + 抓取解析
 *
 * 发现管线（PLAN §5.2）：校验 → RSS/Atom 直判 → <link rel=alternate> 探测 → 常见路径探测
 * （2026-10 优化：页面相对路径优先、有界并发；非根路径页的声明源 300ms 内不应答即并行探测
 *  本地候选，防 feedburner 类不可达声明把发现拖到 8s 超时——见 docs/PLAN-DISCOVER-FAST.md）
 * 抓取（PLAN §5.1）：ETag/If-Modified-Since 条件请求；304 直接返回不解析
 */
const { nodeFetch } = require("./http.js");
const ctx = { nodeFetch: (url, opts) => nodeFetch(url, opts) };
const { sanitizeContent, makeSummary, extractCover, htmlToText, paragraphizePlainText } = require("./article.js");
const adapters = require("./adapters.js");
const crypto = require("crypto");
const iconv = require("iconv-lite");

// 惰性初始化 rss-parser：冷启动只展示列表时无需在 preload 顶层付出解析库装载耗时
let parserInstance = null;
function getParser() {
  if (!parserInstance) {
    const ParserMod = require("rss-parser");
    const Parser = ParserMod.Parser || ParserMod;
    parserInstance = new Parser({
      // RSS2.0 全文常在 content:encoded；v3 需要 customFields 映射
      customFields: { item: [["content:encoded", "contentEncoded"], ["encoded", "encodedAlt"]] },
    });
  }
  return parserInstance;
}

const COMMON_PATHS = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/index.xml", "/rss.xml"];
// 发现期探测预算：路径候选 5s；声明源保留 8s（慢源兼容），但只给 300ms 优先窗口——
// 正常源通常 <300ms 应答，超窗仍未回说明可能不可达，此时并行探测页面相对候选
// （/blog/ → /blog/atom.xml），有界并发 3 防把站点打成小型压测。
const DISCOVER_PROBE_MS = 5000;
const DISCOVER_DECLARED_MS = 8000;
const DISCOVER_DECLARED_GRACE_MS = 300;
const DISCOVER_CONCURRENCY = 3;

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

/** 聚合型源启发式（2026-10，AIGC NEWS 实测）：抽样前 5 条的 link，多数指向 **本站以外的域**
 *  → 原文在第三方站点，打开文章抓全文基本抓不到（反爬/登录墙），确认步不该预开「抓取全文」。
 *  判定拿 feed 自身域与 channel.link 域当"本站"，避免 feed 托管在第三方（如 feedburner）时误判。
 *  @returns {boolean} true=聚合型 */
function looksExternalLinks(items, feedUrl, siteUrl) {
  const hosts = new Set();
  for (const u of [feedUrl, siteUrl]) {
    try {
      const h = new URL(String(u)).hostname.toLowerCase();
      if (h) hosts.add(h);
    } catch (_) {
      /* 解析不了就不参与"本站"判定 */
    }
  }
  const links = (items || [])
    .slice(0, 5)
    .map((it) => String((it && it.link) || "").trim())
    .filter(Boolean);
  if (links.length < 2) return false; // 样本不足不下断言（单条/空源）
  let parsed = 0;
  let external = 0;
  for (const link of links) {
    let host = "";
    try {
      host = new URL(link).hostname.toLowerCase();
    } catch (_) {
      continue; // 非法链接不进分母（分母只算能解析的条目）
    }
    parsed += 1;
    if (host && !hosts.has(host)) external += 1;
  }
  if (parsed < 2) return false; // 可解析样本仍不足
  return external / parsed >= 0.6;
}

/** 发现结果候选统一构造（title/itemCount/summaryOnly/externalLinks 口径只此一处） */
function buildCandidate(url, meta, items) {
  return {
    url,
    title: (meta && meta.title) || url,
    itemCount: items.length,
    summaryOnly: looksSummaryOnly(items),
    externalLinks: looksExternalLinks(items, url, meta && meta.siteUrl),
  };
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
 * @param {string} xml
 * @param {string} [feedUrl] 源地址：供 feed 级适配器（site adapters）识别站点用；
 *        缺省时适配器不介入（纯通用链路，测试与旧调用方不受影响）
 * @returns {{meta:{title,siteUrl,desc}, items:Array}}
 */
async function parseFeedXml(xml, feedUrl = "") {
  const parsed = await getParser().parseString(xml);
  const now = Date.now();
  const items = [];
  // 逐条处理 + 每 5 条让出主线程：sanitize-html 对大正文是 CPU 尖峰，
  // preload 与渲染层同线程，一口气处理几十条会把刷新期间的 UI 卡成幻灯片
  for (let i = 0; i < (parsed.items || []).length; i++) {
    const raw = parsed.items[i];
    const rawBody = raw.contentEncoded || raw.encodedAlt || raw.content || raw.summary || "";
    // 站内适配（feed 级）先清正文里的固定噪音（如聚合源的引流尾巴），再段落化：
    // 纯文本源的 \n 段落不转 <p>，浏览器会把整篇折叠成一堵墙（2026-10 AIGC NEWS 实测）
    const adapted = adapters.applyFeedAdapter(feedUrl, { rawBody: String(rawBody || ""), link: raw.link || "" });
    const normalized = paragraphizePlainText(adapted == null ? rawBody : adapted);
    const contentHtml = sanitizeContent(normalized);
    // 摘要口径：默认沿用 rss-parser 的 contentSnippet（保留「description=编辑摘要 + content:encoded=全文」
    // 这类 WordPress 系源的编辑手写摘要）；**只有本模块真的改过正文**（站点适配命中或纯文本被段落化）时，
    // 才改用最终正文派生——否则适配剥掉的引流/自引用尾巴会被原始 snippet 又带进列表摘要（2026-10 实测）
    const bodyChanged = adapted != null || normalized !== rawBody;
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
      // 正文被适配器剥空时摘要也保持空（卡片不显示摘要行）：不能回退到 contentSnippet ——
      // 那正是被剥掉的广告原文（2026-10-31 宿主实测：AIGC NEWS 有整条只有引流行
      // 的条目，回退会把广告重新当摘要显示）
      summaryText: bodyChanged ? makeSummary(contentHtml) : makeSummary(raw.contentSnippet || contentHtml || raw.title || ""),
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

  const res = await ctx.nodeFetch(feedUrl, { headers, timeout: cond.timeout || 12000 });
  if (!res.ok) return { status: "error", error: res.error || "HTTP_" + res.status };
  if (res.status === 304) return { status: "not_modified" };

  const xml = decodeBuffer(res.body, res.headers["content-type"]);
  // html/finalUrl 仅供 discoverFeed 内部复用（免二次抓取同页 + 重定向后按落地路径找 feed），
  // T-11/安全基线：不入日志、不进渲染层（公开入口走 fetchFeedPublic 剥离）
  if (!looksLikeFeedXml(xml)) return { status: "error", error: "NOT_FEED_XML", html: xml, finalUrl: res.url };
  try {
    const { meta, items } = await parseFeedXml(xml, res.url || feedUrl);
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

/** 渲染层公开抓取结果：剥掉仅供 discoverFeed 内部复用的 raw html。
 *  安全基线（AGENTS「双道信任模型」）：原始 HTML 只允许留在 preload——`airss.feed.fetch`
 *  直接暴露 fetchFeed 会把未消毒远程 HTML 递给渲染层，成为注入隐患（2026-10 复盘加）。
 * @param {string} url
 * @param {{ etag?: string, lastModified?: string, timeout?: number }} [cond]
 */
async function fetchFeedPublic(url, cond = {}) {
  const r = await fetchFeed(url, cond);
  if (r && (Object.prototype.hasOwnProperty.call(r, "html") || Object.prototype.hasOwnProperty.call(r, "finalUrl"))) {
    const out = { ...r };
    delete out.html;
    delete out.finalUrl;
    return out;
  }
  return r;
}

/** 页面相对 feed 候选（/blog/ → /blog/atom.xml；无尾斜杠的 /blog 也视作目录；根路径返回 []） */
function pathFeedCandidates(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch (_) {
    return [];
  }
  const pathname = u.pathname || "/";
  if (pathname === "/") return [];
  const bases = new Set();
  const dir = pathname.endsWith("/") ? pathname : pathname.replace(/[^/]*$/, "");
  if (dir && dir !== "/") bases.add(dir.replace(/\/$/, ""));
  // /blog（无尾斜杠、末段无扩展名）本身就是目录语义：同时探测 /blog/feed 等
  const lastSeg = pathname.split("/").filter(Boolean).pop() || "";
  if (!pathname.endsWith("/") && lastSeg && !lastSeg.includes(".")) bases.add(pathname);
  const out = [];
  for (const base of bases) for (const p of COMMON_PATHS) out.push(u.origin + base + p);
  return out;
}

/**
 * 有界并发探测：按传入顺序启动（并发 ≤ limit），首个成功即返回；全失败返回按完成顺序的 tried。
 * @param {{url:string,label:string}[]} entries
 * @returns {Promise<{winner:{url:string,probe:object,label:string}|null, failed:{path:string,result:string}[]}>}
 */
async function probeFirst(entries, timeout = DISCOVER_PROBE_MS, limit = DISCOVER_CONCURRENCY) {
  const failed = [];
  if (!entries.length) return { winner: null, failed };
  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let done = false;
    const launch = () => {
      if (done) return;
      while (active < limit && next < entries.length) {
        const entry = entries[next++];
        active += 1;
        Promise.resolve()
          .then(() => fetchFeed(entry.url, { timeout }))
          .then((probe) => {
            if (probe && probe.status === "ok") {
              if (!done) {
                done = true;
                resolve({ winner: { url: entry.url, probe, label: entry.label }, failed: failed.slice() });
              }
              return;
            }
            failed.push({ path: entry.label, result: (probe && probe.error) || "PROBE_FAILED" });
          })
          .catch(() => {
            failed.push({ path: entry.label, result: "PROBE_FAILED" });
          })
          .finally(() => {
            active -= 1;
            if (done) return;
            if (next >= entries.length && active === 0) {
              done = true;
              resolve({ winner: null, failed: failed.slice() });
            } else {
              launch();
            }
          });
      }
    };
    launch();
  });
}

/**
 * 发现管线：返回 {found, candidates:[{url,title,itemCount,summaryOnly}], tried:[{path,result}]}
 * 候选优先级：直连 feed > <link> 声明 > 页面相对路径 > 站点根路径；路径组内有界并发、命中即用
 * （多个候选可用时取最先响应的等价源）。summaryOnly：摘要型源启发式结果，
 * 渲染层据此预开「抓取全文」（全文型/未知保持关，用户可改）。
 */
async function discoverFeed(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const tried = [];

  // 1) 直连即 feed
  const direct = await fetchFeed(url, { timeout: 10000 });
  if (direct.status === "ok") {
    return { found: true, candidates: [buildCandidate(url, direct.meta, direct.items)], tried: [{ path: "(直连)", result: "feed" }] };
  }
  tried.push({ path: "(直连)", result: direct.error });

  // 2) HTML <link rel="alternate"> 声明。直连已抓到页面 body（NOT_FEED_XML 附带 html）则直接
  //    复用，不再对同一 URL 二次抓取——短时重复请求会触发站点限流（2026-10 实测：阮一峰首页
  //    二抓 8s 超时，发现流程 15.9s 才落失败态）
  let html = "";
  let pageUrl = url; // 重定向落地地址：裸域 → /blog/ 这类跳转后，页面相对候选必须按落地路径算
  if (direct.error === "NOT_FEED_XML" && direct.html) {
    html = direct.html;
    pageUrl = direct.finalUrl || url;
  } else {
    const page = await ctx.nodeFetch(url, { timeout: 8000 });
    if (page.ok) {
      html = decodeBuffer(page.body, page.headers["content-type"]);
      pageUrl = page.url || url;
    } else {
      tried.push({ path: "页面抓取", result: page.error });
    }
  }

  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch (_) {
    origin = "";
  }

  let declared = [];
  if (html) {
    const re = /<link[^>]+rel=["']alternate["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html)) && declared.length < 5) {
      const tag = m[0];
      if (/type=["']application\/(rss|atom)\+xml["']/i.test(tag)) {
        const hrefM = /href=["']([^"']+)["']/i.exec(tag);
        if (hrefM) {
          try {
            const abs = new URL(hrefM[1], pageUrl).toString();
            if (abs !== url && abs !== pageUrl) declared.push(abs);
          } catch (_) {
            /* 非法 href：跳过单条，不炸整条发现链 */
          }
        }
      }
    }
  }
  declared = [...new Set(declared)];

  // 页面相对候选（/blog/ → /blog/atom.xml）：子路径博客常把 feed 挂在自己目录下，
  // 用站点根候选（origin + /atom.xml）必然 404——先探本地目录，再回退根路径。
  const pathCands = pathFeedCandidates(pageUrl).filter((c) => c !== url && c !== pageUrl && !declared.includes(c));
  const labelOf = (abs) => (origin && abs.startsWith(origin) ? abs.slice(origin.length) || "/" : abs);

  let declaredErrors = [];
  let pathErrors = [];
  let winner = null;

  if (declared.length) {
    let declaredDone = false;
    let pathStarted = false;
    let pathPromise = null;
    const startPath = () => {
      if (pathStarted) return pathPromise;
      pathStarted = true;
      pathPromise = probeFirst(pathCands.map((c) => ({ url: c, label: labelOf(c) })));
      return pathPromise;
    };
    const declaredCore = (async () => {
      for (const link of declared) {
        const probe = await fetchFeed(link, { timeout: DISCOVER_DECLARED_MS });
        if (probe.status === "ok") return { url: link, probe, label: "<link> 声明" };
        declaredErrors.push({ path: "<link> 声明", result: probe.error || "PROBE_FAILED" });
      }
      return null;
    })();
    const declaredP = declaredCore.finally(() => {
      declaredDone = true;
    });

    let pathTimer = null;
    const dRes = declaredP.then((hit) => ({ k: "d", hit, failed: [] }));
    const pRes = pathCands.length
      ? new Promise((resolve) => {
          pathTimer = setTimeout(() => {
            startPath().then((r) => resolve({ k: "p", hit: r.winner, failed: r.failed }));
          }, DISCOVER_DECLARED_GRACE_MS);
        })
      : null;

    const first = pRes ? await Promise.race([dRes, pRes]) : await dRes;
    if (pathTimer) clearTimeout(pathTimer);
    if (first.hit) {
      winner = first.hit;
    } else if (first.k === "p") {
      // 路径先结束（无果）：声明探测可能仍挂在 8s 超时上，等它给出最终答案
      pathErrors = first.failed;
      winner = declaredDone ? null : await declaredP;
    } else {
      // 声明先失败：路径可能已在跑（>300ms 才失败），否则立刻启动
      const pr = pathStarted ? await pathPromise : await startPath();
      pathErrors = pr.failed;
      winner = pr.winner;
    }
  } else if (pathCands.length) {
    const pr = await probeFirst(pathCands.map((c) => ({ url: c, label: labelOf(c) })));
    pathErrors = pr.failed;
    winner = pr.winner;
  }

  if (winner) {
    return {
      found: true,
      candidates: [buildCandidate(winner.url, winner.probe.meta, winner.probe.items)],
      tried: tried.concat(declaredErrors, pathErrors, [
        { path: winner.label, result: winner.label === "<link> 声明" ? winner.url : "feed" },
      ]),
    };
  }

  // 3) 常见路径探测（页面相对未命中后回退站点根；有界并发 3、每个 5s——失败态上限由
  //    6×5s 串行降到约 10s，推荐源发现不再让用户干等半分钟）
  const rootCands = origin
    ? COMMON_PATHS.map((p) => origin + p).filter((c) => c !== url && c !== pageUrl && !declared.includes(c) && !pathCands.includes(c))
    : [];
  if (rootCands.length) {
    const { winner: rootHit, failed } = await probeFirst(rootCands.map((c) => ({ url: c, label: labelOf(c) })));
    if (rootHit) {
      return {
        found: true,
        candidates: [buildCandidate(rootHit.url, rootHit.probe.meta, rootHit.probe.items)],
        tried: tried.concat(declaredErrors, pathErrors, failed, [{ path: rootHit.label, result: "feed" }]),
      };
    }
    tried.push(...declaredErrors, ...pathErrors, ...failed);
  } else {
    tried.push(...declaredErrors, ...pathErrors);
  }

  return { found: false, candidates: [], tried };
}

module.exports = {
  fetchFeed,
  fetchFeedPublic,
  discoverFeed,
  normalizeUrl,
  parseFeedXml,
  looksLikeFeedXml,
  decodeBuffer,
  looksSummaryOnly,
  looksExternalLinks,
  pathFeedCandidates,
  __test: { ctx },
};
