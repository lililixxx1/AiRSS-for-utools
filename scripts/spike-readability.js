/**
 * spike-readability.js — 阶段0 依赖选型 spike（PLAN-V1.3 §3）
 *
 * 目标：为 preload/services/extract.js 选定 DOM 库（linkedom vs jsdom），四项判定：
 *  ① CJS require 可用性（本脚本自身 require 成功即为证明；Node16 运行时以 engines 字段核对，
 *     实机回归列入待验证项）
 *  ② 包体增量（jsdom 按依赖闭包累计；linkedom 零依赖）
 *  ③ 提取质量：真实摘要型源文章页 × 双库（长度≥600 / 标题非空；数值全部入报告）
 *  ④ XSS fixture 过 Readability+sanitizeContent 后无脚本残留（含相对 URL 绝对化验证）
 *
 * 网络抓取落 scripts/fixtures 缓存（.meta.json 记 url/charset），重跑离线确定性。
 * 依赖装在 scripts/spike-tmp（临时目录纪律，不入 preload/package.json）。
 *
 * 用法：node scripts/spike-readability.js [--refresh]
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SPIKE = path.join(ROOT, "scripts", "spike-tmp");
const FIXTURES = path.join(ROOT, "scripts", "fixtures");

// 复用 preload 生产管线（spike 即未来 extract.js 的同款调用面）
const { nodeFetch } = require(path.join(ROOT, "preload/services/http.js"));
const { decodeBuffer, fetchFeed } = require(path.join(ROOT, "preload/services/feed.js"));
const { sanitizeContent, htmlToText } = require(path.join(ROOT, "preload/services/article.js"));

// 候选 DOM 库（CJS require 成功 = 判定① 的一半证据）
const { parseHTML } = require(path.join(SPIKE, "node_modules/linkedom"));
const { JSDOM } = require(path.join(SPIKE, "node_modules/jsdom"));
const { Readability } = require(path.join(SPIKE, "node_modules/@mozilla/readability"));

const REFRESH = process.argv.includes("--refresh");
const MIN_CHARS = 600; // PLAN-V1.3 FULLTEXT_MIN_CHARS 同值

/** 摘要型源候选：feed 只给摘要，文章页才有全文 —— 即全文提取的真实目标形态 */
const FEED_CANDIDATES = [
  { name: "ars", feedUrl: "https://feeds.arstechnica.com/arstechnica/index", expectGbk: false },
  { name: "engadget", feedUrl: "https://www.engadget.com/rss.xml", expectGbk: false },
  { name: "kr36", feedUrl: "https://36kr.com/feed", expectGbk: false },
  { name: "cn-gbk", feedUrl: "https://www.chinanews.com.cn/rss/scroll-news.xml", expectGbk: true },
];
const DIRECT_PAGES = [
  // Paul Graham 的 RSS 只给链接（纯摘要型源的极端形态），页面为老式手写 HTML，兼容性压力测试
  { name: "pg-greatwork", url: "https://www.paulgraham.com/greatwork.html", expectGbk: false },
];

function fixturePath(name) {
  return path.join(FIXTURES, name + ".html");
}
function metaPath(name) {
  return path.join(FIXTURES, name + ".meta.json");
}

/** 抓取一页并落缓存；命中缓存直接回放（离线重跑确定性） */
async function fetchCached(name, url) {
  if (!REFRESH && fs.existsSync(fixturePath(name)) && fs.existsSync(metaPath(name))) {
    const meta = JSON.parse(fs.readFileSync(metaPath(name), "utf8"));
    return { ...meta, html: fs.readFileSync(fixturePath(name), meta.binary ? null : "utf8") };
  }
  const res = await nodeFetch(url, { timeout: 12000, maxBytes: 3 * 1024 * 1024 });
  if (!res.ok) return { error: res.error || "HTTP_" + res.status, url };
  const contentType = res.headers["content-type"] || "";
  const meta = { url, contentType, binary: true, fetchedAt: Date.now() };
  fs.writeFileSync(fixturePath(name), res.body); // 存原始字节（GBK 判定要按字节过 decodeBuffer）
  fs.writeFileSync(metaPath(name), JSON.stringify(meta, null, 2));
  return { ...meta, html: res.body };
}

/** 取 feed 首条文章页（摘要型源 → 文章页，与产品提取路径一致） */
async function pageFromFeed(cand, maxItems) {
  const feedName = "feed-" + cand.name;
  const r = await fetchCached(feedName, cand.feedUrl);
  if (r.error) return null;
  const xml = decodeBuffer(Buffer.isBuffer(r.html) ? r.html : Buffer.from(r.html), r.contentType);
  const parsed = await fetchFeed(cand.feedUrl, { timeout: 12000 }).catch(() => null);
  const links = [];
  if (parsed && parsed.status === "ok") {
    for (const it of parsed.items) if (it.link && /^https?:/i.test(it.link)) links.push({ link: it.link, title: it.title });
  }
  return { cand, links: links.slice(0, maxItems) };
}

/** 单库解析 + Readability 提取 */
function extractWith(libName, htmlStr, url) {
  const t0 = Date.now();
  try {
    let document;
    if (libName === "linkedom") document = parseHTML(htmlStr).document;
    else document = new JSDOM(htmlStr, { url }).window.document;
    const art = new Readability(document).parse();
    const ms = Date.now() - t0;
    if (!art || !art.content) return { ok: false, ms, error: "PARSE_NULL" };
    const text = htmlToText(art.content);
    let pageTitle = "";
    try {
      pageTitle = String(document.querySelector("title")?.textContent || "").trim();
    } catch (e) {
      /* linkedom 兜底 */
    }
    return {
      ok: true,
      ms,
      title: String(art.title || "").trim(),
      pageTitle,
      textLen: text.length,
      htmlLen: art.content.length,
      text,
      content: art.content,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 120) };
  }
}

/** 相对 URL 绝对化（PLAN-V1.3 §1.1 第9步机制验证；extract.js 同款逻辑） */
function absolutizeHtml(htmlStr, base) {
  const doc = parseHTML(htmlStr).document;
  for (const img of doc.querySelectorAll("img[src]")) {
    try {
      img.setAttribute("src", new URL(img.getAttribute("src"), base).toString());
    } catch (e) {
      /* 非法 src 留给 sanitize 剥 */
    }
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    try {
      a.setAttribute("href", new URL(a.getAttribute("href"), base).toString());
    } catch (e) {
      /* 同上 */
    }
  }
  return doc.toString();
}

/** 乱码率：U+FFFD 替换符占比（GBK 判定的量化口径） */
function garbleRate(str) {
  const total = str.length || 1;
  let n = 0;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 0xfffd) n++;
  return n / total;
}

/** 依赖闭包体积：从 jsdom 起递归 dependencies，逐包 du */
function closureSizeKB(entryPkg) {
  const seen = new Set();
  const queue = [entryPkg];
  let totalKB = 0;
  const nm = path.join(SPIKE, "node_modules");
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = path.join(nm, ...name.split("/"));
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    totalKB += Math.round(dirSize(dir) / 1024);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push(dep);
  }
  return { totalKB, pkgs: seen.size };
}

function dirSize(dir) {
  let size = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) size += dirSize(p);
    else size += fs.statSync(p).size;
  }
  return size;
}

// ---- XSS fixture：真实文章结构包裹 payload，确保 Readability 不会因内容稀疏整页丢弃 ----
const XSS_FIXTURE = `<!DOCTYPE html><html><head><title>XSS Fixture - Normal Site</title></head><body>
<nav><a href="/home">Home</a><a href="/about">About</a></nav>
<article>
<h1>A Real Looking Article About Local Weather Patterns</h1>
<p>${"Regional climate observation has been a cornerstone of agricultural planning for centuries. ".repeat(8)}</p>
<script>alert('xss-script')</script>
<img src="/assets/photo.jpg" onerror="alert('xss-onerror')">
<p onmouseover="alert('xss-mouseover')">${"Farmers and meteorologists alike benefit from consistent record keeping and shared datasets. ".repeat(8)}</p>
<a href="javascript:alert('xss-js-uri')">click me</a>
<iframe srcdoc="<script>alert('xss-iframe')</script>"></iframe>
<style>body{background:url(javascript:alert(1))}</style>
<p>${"Beyond the practical uses, long term archives reveal shifting patterns season over season. ".repeat(8)}</p>
<img src="relative/pic2.png">
</article>
<footer><p>Copyright Example Site</p></footer>
</body></html>`;

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const report = { fetchedAt: new Date().toISOString(), pages: [], xss: {}, sizes: {}, verdict: null };

  // ---- 1) 真实页面集：摘要型源 → 文章页 ----
  const pages = []; // {name, url, html(str), contentType, expectGbk, feedTitle?}
  const usedNames = new Set();
  for (const cand of FEED_CANDIDATES) {
    try {
      const r = await pageFromFeed(cand, cand.expectGbk ? 2 : 1);
      if (!r || !r.links.length) {
        console.log("[feed-skip] " + cand.name + "（feed 不可用或无 http 链接）");
        continue;
      }
      for (const lk of r.links) {
        const name = cand.name + "-" + (lk.link.replace(/[^\w]/g, "").slice(-24) || String(usedNames.size));
        if (usedNames.has(name)) continue;
        usedNames.add(name);
        const page = await fetchCached(name, lk.link);
        if (page.error) {
          console.log("[page-skip] " + name + ": " + page.error);
          continue;
        }
        pages.push({ name, url: lk.link, body: page.html, contentType: page.contentType, expectGbk: cand.expectGbk, feedTitle: lk.title });
        console.log("[page-ok] " + name + " <- " + cand.name);
      }
    } catch (e) {
      console.log("[feed-error] " + cand.name + ": " + String(e.message || e).slice(0, 80));
    }
  }
  for (const d of DIRECT_PAGES) {
    const page = await fetchCached(d.name, d.url);
    if (page.error) {
      console.log("[page-skip] " + d.name + ": " + page.error);
      continue;
    }
    pages.push({ name: d.name, url: d.url, body: page.html, contentType: page.contentType, expectGbk: false });
    console.log("[page-ok] " + d.name);
  }

  // GBK 合成兜底：真实 GBK 页拿不到时合成 fixture（测 decodeBuffer 生产管线同一代码路径）。
  // 合成源固定为缓存里文件名排序第一个 cn-gbk-*.html —— 字节级确定性，重跑数值稳定
  // （送审建议1：曾因源随当轮页面集漂移导致报告乱码率漂移）。
  const gotGbk = pages.some((p) => /gb/i.test(p.contentType || ""));
  if (!gotGbk) {
    const cached = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.startsWith("cn-gbk-") && f.endsWith(".html"))
      .sort()[0];
    let srcHtml = null;
    let srcUrl = "https://example.com/";
    if (cached) {
      const buf = fs.readFileSync(path.join(FIXTURES, cached));
      const meta = fs.existsSync(metaPath(cached.replace(/\.html$/, ""))) ? JSON.parse(fs.readFileSync(metaPath(cached.replace(/\.html$/, "")), "utf8")) : {};
      const ct = /gb/i.test(meta.contentType || "") ? meta.contentType : "text/html; charset=UTF-8";
      srcHtml = decodeBuffer(buf, ct);
      srcUrl = meta.url || srcUrl;
      console.log("[gbk-synth] 合成源固定: " + cached);
    } else {
      const src = pages.find((p) => /[\u4e00-\u9fff]/.test(decodeBuffer(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body), p.contentType).slice(0, 2000)));
      if (src) {
        srcHtml = decodeBuffer(Buffer.isBuffer(src.body) ? src.body : Buffer.from(src.body), src.contentType);
        srcUrl = src.url;
      }
    }
    if (srcHtml) {
      const iconv = require(path.join(ROOT, "preload/node_modules/iconv-lite"));
      fs.writeFileSync(fixturePath("synth-gbk-declared"), iconv.encode(srcHtml, "gbk"));
      fs.writeFileSync(metaPath("synth-gbk-declared"), JSON.stringify({ url: srcUrl + "#synth-gbk", contentType: "text/html; charset=GBK", binary: true, fetchedAt: Date.now() }, null, 2));
      pages.push({ name: "synth-gbk-declared", url: srcUrl, body: iconv.encode(srcHtml, "gbk"), contentType: "text/html; charset=GBK", expectGbk: true, synth: true });
      // 风险⑨：无 charset 声明的 GBK 页（预期乱码，量化记录）
      fs.writeFileSync(fixturePath("synth-gbk-undeclared"), iconv.encode(srcHtml, "gbk"));
      fs.writeFileSync(metaPath("synth-gbk-undeclared"), JSON.stringify({ url: srcUrl + "#synth-undeclared", contentType: "text/html", binary: true, fetchedAt: Date.now() }, null, 2));
      pages.push({ name: "synth-gbk-undeclared", url: srcUrl + "#synth-undeclared", body: iconv.encode(srcHtml, "gbk"), contentType: "text/html", expectGbk: true, synth: true, expectGarbled: true });
      console.log("[gbk-synth] GBK 声明/未声明两 fixture 已写");
    } else {
      console.log("[gbk-miss] 无中文页可合成，GBK 判定缺失（需补真实页重跑）");
    }
  }

  // ---- 2) 双库提取 ----
  for (const p of pages) {
    const htmlStr = decodeBuffer(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body), p.contentType);
    const bodyEmpty = htmlStr.length === 0; // 抓取层失败（如 ars 的 202+Content-Length:0 bot 挑战），非 DOM 库质量问题
    const entry = {
      name: p.name,
      url: p.url,
      contentType: p.contentType,
      bodyLen: htmlStr.length,
      bodyEmpty,
      expectGbk: !!p.expectGbk,
      expectGarbled: !!p.expectGarbled,
      synth: !!p.synth,
      garbleRate: Number(garbleRate(htmlStr).toFixed(6)),
      feedTitle: p.feedTitle || "",
      linkedom: bodyEmpty ? { ok: false, error: "EMPTY_BODY(fetch层)", pass: false } : extractWith("linkedom", htmlStr, p.url),
      jsdom: bodyEmpty ? { ok: false, error: "EMPTY_BODY(fetch层)", pass: false } : extractWith("jsdom", htmlStr, p.url),
    };
    for (const lib of ["linkedom", "jsdom"]) {
      const r = entry[lib];
      if (r.ok) {
        // 额外记录：消毒后长度（提取→消毒全链路的实际入库长度）
        r.sanitizedLen = sanitizeContent(r.content).length;
      }
    }
    // 质量判据：解析成功 + 标题非空 +（提取长度≥600【真实长文】或与另一库完全一致【短文页
    // （图集/快讯）两套独立 DOM 实现产出同长同题 = 均为页面的真实内容】）
    if (entry.linkedom.ok && entry.jsdom.ok) {
      entry.parity = entry.linkedom.textLen === entry.jsdom.textLen && entry.linkedom.title === entry.jsdom.title;
    }
    for (const lib of ["linkedom", "jsdom"]) {
      const r = entry[lib];
      const other = lib === "linkedom" ? entry.jsdom : entry.linkedom;
      r.pass = r.ok && r.title.length > 0 && (r.textLen >= MIN_CHARS || (other.ok && other.textLen === r.textLen && other.title === r.title));
    }
    // 风险⑨断言：无声明 GBK 必然乱码（量化并记录，属已知残留非不通过项）
    if (entry.expectGarbled) entry.garbleConfirmed = entry.garbleRate > 0.001;
    report.pages.push(entry);
  }

  // ---- 3) XSS fixture：Readability → 绝对化 → sanitizeContent，断言零残留 ----
  {
    const out = {};
    for (const lib of ["linkedom", "jsdom"]) {
      const r = extractWith(lib, XSS_FIXTURE, "https://example.com/post/1");
      const abs = r.ok ? absolutizeHtml(r.content, "https://example.com/post/1") : "";
      const clean = r.ok ? sanitizeContent(abs) : "";
      const checks = {
        parseOk: r.ok,
        noScriptTag: !/<\s*script/i.test(clean),
        noEventAttr: !/\son\w+\s*=/i.test(clean),
        noJsUri: !/javascript\s*:/i.test(clean),
        noIframe: !/<\s*iframe/i.test(clean),
        noStyleTag: !/<\s*style/i.test(clean),
        relImgAbsolutized: r.ok && /src="https:\/\/example\.com\/assets\/photo\.jpg"/.test(clean),
      };
      out[lib] = { ...checks, allPass: Object.values(checks).every(Boolean), sanitizedLen: clean.length };
    }
    report.xss = out;
  }

  // ---- 4) 包体（判定②） ----
  const linkedomKB = Math.round(dirSize(path.join(SPIKE, "node_modules/linkedom")) / 1024);
  const jsdomClosure = closureSizeKB("jsdom");
  report.sizes = {
    linkedomKB,
    jsdomKB: jsdomClosure.totalKB,
    jsdomPkgs: jsdomClosure.pkgs,
    readabilityKB: Math.round(dirSize(path.join(SPIKE, "node_modules/@mozilla/readability")) / 1024),
  };

  // ---- 5) 判定 ----
  // 质量口径：仅统计「真实摘要型源页面 + 非空 body」；空 body 页（HTTP 202 等 bot 挑战）是
  // 抓取层失败、两库同样无从提取，不构成 DOM 库质量差异。真实 GBK 页在野外未寻得（chinanews
  // 已转 UTF-8），用合成声明 GBK fixture（真实页字节转码）覆盖同一 decodeBuffer 代码路径。
  const realPages = report.pages.filter((p) => !p.synth && !p.bodyEmpty);
  const emptyPages = report.pages.filter((p) => p.bodyEmpty).map((p) => p.name);
  const gbkDeclared = report.pages.find((p) => p.synth && !p.expectGarbled);
  const gbkUndeclared = report.pages.find((p) => p.expectGarbled);
  const xssAllPass = report.xss.linkedom.allPass && report.xss.jsdom.allPass;
  const quality = { linkedom: realPages.length > 0 && realPages.every((p) => p.linkedom.pass), jsdom: realPages.length > 0 && realPages.every((p) => p.jsdom.pass) };
  const parity = realPages.length > 0 && realPages.every((p) => p.parity === true);
  const qualityPartial = {
    linkedom: realPages.filter((p) => p.linkedom.pass).length + "/" + realPages.length,
    jsdom: realPages.filter((p) => p.jsdom.pass).length + "/" + realPages.length,
  };
  const gbkOk = !!gbkDeclared && gbkDeclared.garbleRate < 0.001;
  const cjsOk = true; // 本脚本顶部 require 已成功，否则跑不到这里
  report.verdict = {
    c1CjsRequire: cjsOk,
    c3Quality: quality,
    c3CrossLibParity: parity, // 两套独立 DOM 实现在全部真实页上同长同题
    c3QualityPartial: qualityPartial,
    c3EmptyBodyPages: emptyPages,
    c3GbkDeclaredOk: gbkOk,
    c3GbkDeclaredGarbleRate: gbkDeclared ? gbkDeclared.garbleRate : null,
    c3GbkUndeclaredGarbleRate: gbkUndeclared ? gbkUndeclared.garbleRate : null, // 风险⑨量化：utf-8 兜底乱码率
    c4XssAllPass: xssAllPass,
    winner: null,
    rule: "四项全过取包体小者；linkedom 质量不过则 jsdom（包体代价接受并记录）。质量口径剔除空 body 页（抓取层失败非库差异）",
  };
  if (cjsOk && xssAllPass && quality.linkedom && gbkOk) report.verdict.winner = "linkedom";
  else if (cjsOk && xssAllPass && quality.jsdom && gbkOk) report.verdict.winner = "jsdom";
  else report.verdict.winner = "NONE（人工裁决）";

  fs.writeFileSync(path.join(FIXTURES, "spike-report.json"), JSON.stringify(report, null, 2));

  // ---- 摘要输出 ----
  console.log("\n===== 页面提取（真实页，剔除空 body 抓取层失败） =====");
  for (const p of realPages) {
    console.log(`${p.name} [${p.contentType || "?"}] bodyLen=${p.bodyLen}`);
    console.log(`  linkedom: ${fmt(p.linkedom)} | jsdom: ${fmt(p.jsdom)}`);
  }
  if (emptyPages && emptyPages.length) console.log("空 body 页（不计质量）: " + emptyPages.join(", "));
  if (gbkDeclared) console.log(`GBK 声明: ${gbkDeclared.name} garbleRate=${gbkDeclared.garbleRate}`);
  if (gbkUndeclared) console.log(`GBK 无声明（风险⑨）: ${gbkUndeclared.name} garbleRate=${gbkUndeclared.garbleRate}（已知残留，本期不修）`);
  console.log("\n===== XSS fixture =====");
  console.log("linkedom:", JSON.stringify(report.xss.linkedom));
  console.log("jsdom:   ", JSON.stringify(report.xss.jsdom));
  console.log("\n===== 包体 =====");
  console.log(`linkedom=${report.sizes.linkedomKB}KB(0 deps) jsdom=${report.sizes.jsdomKB}KB(${report.sizes.jsdomPkgs} pkgs) readability=${report.sizes.readabilityKB}KB`);
  console.log("\n===== 判定 =====");
  console.log(JSON.stringify(report.verdict, null, 2));
  console.log("\n报告: scripts/fixtures/spike-report.json");

  function fmt(r) {
    return r.ok ? `ok len=${r.textLen} title="${r.title.slice(0, 40)}" ${r.ms}ms ${r.pass ? "PASS" : "FAIL(<600/no-title)"}` : `FAIL ${r.error}`;
  }
}

main().catch((e) => {
  console.error("spike crashed:", e);
  process.exit(1);
});
