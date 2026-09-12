/**
 * preload 冒烟测试（Node 直接跑，不依赖 utools 环境；db 层除外）
 * 用法：node scripts/smoke-preload.js
 */
const assert = require("assert");
const path = require("path");
const PRELOAD = path.join(__dirname, "..", "preload");

const { sanitizeContent, makeSummary, extractCover, readingMinutes, htmlToText } = require(path.join(PRELOAD, "services/article.js"));
const { parseFeedXml, decodeBuffer, looksLikeFeedXml, looksSummaryOnly } = require(path.join(PRELOAD, "services/feed.js"));
const { parseOpml, buildOpml } = require(path.join(PRELOAD, "services/opml.js"));
const { nodeFetch } = require(path.join(PRELOAD, "services/http.js"));
const iconv = require(path.join(PRELOAD, "node_modules/iconv-lite"));

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error("FAIL: " + name);
  pass += 1;
  console.log("  ✓ " + name);
};

// ---- article.sanitizeContent：XSS 样本 ----
console.log("[article] sanitize 白名单");
{
  const dirty = `<script>alert(1)</script><p onclick="x()">hi</p>` +
    `<img src="http://evil/x.jpg" onerror="y()"><img src="https://ok/a.png" alt="a">` +
    `<a href="javascript:z()">l</a><a href="https://ok.com/">ok</a>` +
    `<iframe src="https://evil"></iframe><svg onload="a()"></svg><style>body{}</style>` +
    `<form><input></form><math><mi>x</mi></math>`;
  const clean = sanitizeContent(dirty);
  ok("script 被剥", !clean.includes("script"));
  ok("on* 事件被剥", !/on(error|load|click)=/.test(clean));
  ok("http 明文图被剥（仅 https）", !clean.includes('src="http://evil'));
  ok("https 图保留", clean.includes('src="https://ok/a.png"'));
  ok("javascript: 链接被剥", !clean.includes("javascript:"));
  ok("iframe/svg/style/form/math 全被剥", !/<(iframe|svg|style|form|input|math)\b/i.test(clean));
  ok("a 带 rel=noopener", clean.includes('rel="noopener"'));
}
{
  const long = "<p>" + "字".repeat(60000) + "</p>";
  const clean = sanitizeContent(long);
  ok("100KB 截断生效（" + Buffer.byteLength(clean, "utf8") + " bytes ≤ 100KB）", Buffer.byteLength(clean, "utf8") <= 100 * 1024 + 2048 && clean.length < long.length);
}
ok("摘要 ≤300", makeSummary("a".repeat(400)).length <= 301);
ok("封面提取", extractCover('<p><img src="https://x/a.png"></p>') === "https://x/a.png");
ok("封面跳过 http 图", extractCover('<img src="http://x/a.png">') === null);
ok("阅读时长", readingMinutes("x".repeat(800)) === 2);

// ---- feed 解析 ----
console.log("[feed] 解析与编码");
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>测试源</title><link>https://example.com</link><description>d</description>
<item><title>&lt;Injected&gt; 标题</title><guid>g1</guid><link>https://example.com/1</link>
<pubDate>Wed, 03 Sep 2026 08:00:00 GMT</pubDate><description>摘要&lt;img src=x onerror=alert(1)&gt;</description>
<content:encoded><![CDATA[<p>正文</p><script>bad()</script>]]></content:encoded></item>
<item><title>无日期条目</title><guid>g2</guid><link>https://example.com/2</link></item>
</channel></rss>`;
{
  ok("RSS 直判", looksLikeFeedXml(SAMPLE_RSS));
  (async () => {
    const { meta, items } = await parseFeedXml(SAMPLE_RSS);
    ok("meta.title", meta.title === "测试源");
    ok("条目数=2", items.length === 2);
    ok("标题实体解码", items[0].title === "<Injected> 标题");
    ok("content:encoded 消毒（script 剥除）", items[0].contentHtml.includes("正文") && !items[0].contentHtml.includes("bad()"));
    ok("isoDate→pubTs", new Date(items[0].pubTs).toISOString().startsWith("2026-09-03"));
    ok("无日期→now", Math.abs(items[1].pubTs - Date.now()) < 5000);
    ok("guid 保留", items[0].guid === "g1");

    // 摘要型源启发式（发现期智能默认，2026-09-12）
    ok("启发式：短正文 → 摘要型", looksSummaryOnly(items) === true);
    const fullFeed = await parseFeedXml(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>全文源</title><link>https://example.com</link><description>d</description>
<item><title>a</title><guid>f1</guid><link>https://example.com/1</link>
<content:encoded><![CDATA[<p>${"长".repeat(800)}</p>]]></content:encoded></item>
<item><title>b</title><guid>f2</guid><link>https://example.com/2</link>
<content:encoded><![CDATA[<p>${"文".repeat(900)}</p>]]></content:encoded></item>
</channel></rss>`);
    ok("启发式：长正文 → 全文型", looksSummaryOnly(fullFeed.items) === false);
    ok("启发式：空条目 → 无信号（null，不当全文型断言）", looksSummaryOnly([]) === null);
    ok("启发式：中位数而非均值（4短+1超长 → 摘要型）", looksSummaryOnly([{ contentHtml: "短".repeat(100) }, { contentHtml: "短".repeat(100) }, { contentHtml: "短".repeat(100) }, { contentHtml: "短".repeat(100) }, { contentHtml: "长".repeat(5000) }]) === true);
    ok("启发式：长正文主流+单篇短 → 全文型", looksSummaryOnly([...fullFeed.items, ...fullFeed.items, { contentHtml: "只有一句" }]) === false);

    // GBK 兜底
    const gbkXml = iconv.encode(`<?xml version="1.0" encoding="GBK"?><rss version="2.0"><channel><title>中文编码</title></channel></rss>`, "gbk");
    ok("GBK 解码", decodeBuffer(gbkXml, "").includes("中文编码"));
    ok("charset 参数优先", decodeBuffer(Buffer.from("<a/>"), "text/html; charset=big5").length > 0);

    // Atom
    const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom源</title>
    <entry><id>e1</id><title>条目</title><link href="https://a/1"/><updated>2026-09-01T00:00:00Z</updated>
    <content type="html">&lt;p&gt;hi&lt;/p&gt;</content></entry></feed>`;
    const atom = await parseFeedXml(ATOM);
    ok("Atom 解析", atom.meta.title === "Atom源" && atom.items.length === 1 && atom.items[0].guid === "e1");

    // ---- OPML 往返 ----
    console.log("[opml] 导入导出");
    const OPML = `<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><head/><body>
    <outline text="技术"><outline text="内层" ><outline type="rss" text="阮一峰" xmlUrl="https://r/atom.xml" htmlUrl="https://r"/></outline></outline>
    <outline type="rss" text="裸源" xmlUrl="https://b/rss"/></body></opml>`;
    const feeds = parseOpml(OPML);
    ok("两级 folder 平铺", feeds[0].category === "技术/内层");
    ok("无 folder → 默认", feeds[1].category === "默认");
    const xml = buildOpml([{ title: "阮一峰", url: "https://r/atom.xml", siteUrl: "https://r", category: "技术" }]);
    const round = parseOpml(xml);
    ok("导出→再导入往返一致", round[0].xmlUrl === "https://r/atom.xml" && round[0].category === "技术");
    ok("标题转义", buildOpml([{ title: 'a"b<c', url: "https://x" }]).includes("&quot;"));

    // ---- 全文提取链路（fixture，无网络；状态机见 test-db-mock）----
    console.log("[extract] Readability 提取消毒（fixture）");
    {
      const extractSvc = require(path.join(PRELOAD, "services/extract.js"));
      const { parseHTML } = require(path.join(PRELOAD, "node_modules/linkedom"));
      const { Readability } = require(path.join(PRELOAD, "node_modules/@mozilla/readability"));
      const FX = `<html><head><title>夹具文章标题</title></head><body><nav>导航噪音噪音噪音</nav><article>
        <h1>全文提取夹具</h1>${"<p>这一段是正文内容，用于验证 Readability 提取链路的长度下限与消毒行为，重复以凑足六百字。".repeat(30)}
        <img src="/rel/pic.jpg"><a href="/rel/doc">相对链接</a>
        <script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">险</a>
        </article></body></html>`;
      const { document } = parseHTML(FX);
      const art = new Readability(document).parse();
      ok("Readability(linkedom) 提取达标", !!art && !!art.content && htmlToText(art.content).length >= extractSvc.__test.FULLTEXT_MIN_CHARS);
      const abs = extractSvc.__test.absolutize(art.content, "https://ex.base/post/1");
      ok("相对图绝对化", abs.includes("https://ex.base/rel/pic.jpg"));
      ok("相对链接绝对化", abs.includes("https://ex.base/rel/doc"));
      const clean = sanitizeContent(abs);
      ok("提取链路消毒：script 剥除", !/<script/i.test(clean));
      ok("提取链路消毒：事件属性剥除", !/onerror/i.test(clean));
      ok("提取链路消毒：javascript: 剥除", !/javascript:/i.test(clean));
      ok("绝对化后的 https 图存活", clean.includes("https://ex.base/rel/pic.jpg"));
    }

    // ---- 真实网络：阮一峰 atom（gzip 解压 + ETag 头）----
    console.log("[http] 真实抓取");
    const res = await nodeFetch("https://www.ruanyifeng.com/blog/atom.xml", { timeout: 15000 });
    ok("HTTP 200", res.ok && res.status === 200);
    const xml2 = decodeBuffer(res.body, res.headers["content-type"]);
    ok("gzip 解压后为 XML", looksLikeFeedXml(xml2));
    const real = await parseFeedXml(xml2);
    ok("解析出条目（" + real.items.length + " 篇）", real.items.length > 0);
    console.log("  · " + real.meta.title + " | " + real.items[0].title.slice(0, 30) + "…");

    console.log("\n全部通过：" + pass + " 项");
  })().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
