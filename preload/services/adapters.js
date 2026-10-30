/**
 * adapters.js — 站内适配层（feed 级正文清理 + 文章级结构化提取）
 *
 * 为什么需要「站内」适配：RSS 生态里有一类源不是语义化 HTML，通用启发式（Readability）
 * 在它们身上必然失真，且失真方式各不相同：
 *   1. 列表型期刊页（HelloGitHub 月刊）：项目名/仓库链接写在 `<a><div>项目名</div></a>` 里，
 *      Readability 按「链接密度」判定为页面杂质整块剔除 → 全文只剩 Star 数与描述，
 *      项目名与仓库链接全丢（2026-10 实测第 127 期）。页面内嵌 `__NEXT_DATA__` JSON
 *      才是结构化真源。
 *   2. 单条精选页（Indie Radar）：服务端渲染的 article 里是「导读/推荐理由/来源/标签」区块，
 *      Readability 会把元信息行与标签云一并算进正文，正文又是纯短篇（<600 字）——
 *      落到 FULLTEXT_MIN_CHARS 门槛外，白抓一次后仍显示 feed 的两行。
 *   3. 聚合型源（AIGC NEWS）：description 是**纯文本**（无标签、\n 分段）且尾部挂引流文案，
 *      直接进 sanitize 会被浏览器折叠成一张大饼（一堵墙），引流行也是每篇必现的噪音。
 *
 * 本模块提供两类可注册适配器（都只做「读」与「产白名单 HTML」，不碰 db/网络）：
 *   - FEED_ADAPTERS   ：按 **feed URL** 匹配，parseFeedXml 归一化后清理条目 contentHtml；
 *   - ARTICLE_ADAPTERS：按 **文章 URL** 匹配，extract.js 在 Readability 之前尝试，
 *     命中即直接产出结构化正文（不再走 Readability）。
 *
 * 纪律：
 *   - 适配器失败一律返回 null/原值，**绝不抛错**——调用方回落通用链路，提取主链路存活；
 *   - 产出的 HTML 只允许 SANITIZE 白名单标签（p/h2/h3/a/strong…），且仍要过 sanitizeContent
 *     （纵深防御：URL 方案白名单、on* 属性、100KB 截断都在那一层）；
 *   - 属性值一律转义（esc），URL 只接受 http(s)，其它一律丢弃——适配器不是可信输入。
 */
const { htmlToText } = require("./article.js");

/** 通用宿主/路径解析（解析失败返回空串，调用方按不匹配处理） */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}
function pathOf(url) {
  try {
    return new URL(String(url)).pathname;
  } catch (_) {
    return "";
  }
}

/** HTML 文本转义（& < > " '）——适配器拼接字符串的唯一安全出口 */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只放行 http(s) 绝对地址；其余（javascript:/data:/相对）返回空串由调用方跳过 */
function httpUrl(u) {
  try {
    const parsed = new URL(String(u || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function hostIs(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

// ─────────────────────────────── feed 级 ───────────────────────────────

/**
 * AIGC NEWS（aigcnews.cn）：description 尾部固定引流行
 * 「📮 全文 RSS（中文译文 · 完整归档），注册登录即可免费订阅：https://…/subscriptions」
 * 这是每篇都带的广告位，阅读器里纯噪音——按行剥掉（只剥以 📮 开头且含订阅链接的行，
 * 正文里偶然提到「RSS」不受影响）。
 */
const AIGC_PROMO_RE = /^\s*(?:📮|📬|📨|🔔|📢)?\s*(?:全文\s*)?RSS[\s\S]{0,80}?(?:订阅|subscribe)[\s\S]*$/i;

/**
 * @param {{rawBody:string, link:string}} item rawBody 是 feed 里的原始 description/content
 * @returns {string|null} 清理后的正文（仍是纯文本/HTML 原形态），null = 不介入
 */
function cleanAigcNews({ rawBody }) {
  const text = String(rawBody || "");
  // 只处理纯文本形态（该源现状）；万一改成富文本，交回通用链路，不在 HTML 上按行乱切
  if (!text || /<\/?[a-z][^<>]*>/i.test(text)) return null;
  const lines = text.split(/\n/);
  const kept = lines.filter((line) => !(AIGC_PROMO_RE.test(line) && /https?:\/\//i.test(line)));
  if (kept.length === lines.length) return null; // 没有引流行 → 不改（contentHash 不抖动）
  const out = kept.join("\n").trim();
  return out || null;
}

const FEED_ADAPTERS = [
  {
    id: "aigcnews",
    test: (feedUrl) => hostIs(hostOf(feedUrl), "aigcnews.cn"),
    clean: cleanAigcNews,
  },
  {
    id: "indie-radar",
    test: (feedUrl) => hostIs(hostOf(feedUrl), "radar.everythingisok.top"),
    clean: cleanIndieRadar,
  },
];

/**
 * feed 级清理入口。
 * @param {string} feedUrl 该条目所属 feed 的地址
 * @param {{rawBody?:string, link?:string}} item
 * @returns {string|null} 清理后的正文原形态；null = 无适配/无需改动
 */
function applyFeedAdapter(feedUrl, item) {
  const adapter = FEED_ADAPTERS.find((a) => {
    try {
      return a.test(feedUrl);
    } catch (_) {
      return false;
    }
  });
  if (!adapter) return null;
  try {
    return adapter.clean(item || {}) || null;
  } catch (_) {
    return null; // 适配器异常 = 当没命中，正文保持原样
  }
}

// ────────────────────────────── 文章级 ──────────────────────────────

/** URL 同页判定（忽略首尾空白与末尾斜杠） */
function samePageUrl(a, b) {
  const norm = (u) => String(u || "").trim().replace(/\/+$/, "");
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && x === y;
}

/**
 * Indie Radar（radar.everythingisok.top）：条目正文尾部固定带一行
 * 「via Indie Radar · <本条目自己的链接>」。读者点开的就是这一页，这一行纯冗余——
 * 列表摘要也跟着带出一长串 URL，观感很差。只剥「锚点 href == 本条 link」那一行，
 * 其它 via/来源链接不动。
 */
function cleanIndieRadar({ rawBody, link }) {
  const html = String(rawBody || "");
  if (!/<p/i.test(html) || !link) return null;
  const out = html.replace(
    /<p>\s*via\s+[^<]{0,60}?<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>\s*<\/p>/gi,
    (whole, href) => (samePageUrl(href, link) ? "" : whole)
  );
  const trimmed = out.trim();
  return trimmed === html.trim() ? null : trimmed;
}

/**
 * HelloGitHub 月刊页：从 `#__NEXT_DATA__` 的 volume.data 重建「分类 → 项目清单」。
 * 结构化字段（2026-10 实测）：category_name / items[{name,full_name,description,github_url,stars,forks,image_url}]
 * 产出：每个分类一个 h2，每个项目 h3（链接到仓库）+ 描述 + 仓库名/星标行。
 * cover：取第一个项目的配图（列表卡片用），正文不内联配图（35 张动图会把阅读页拖死）。
 */
function extractHellogithub({ document }) {
  const node = document.querySelector("#__NEXT_DATA__");
  if (!node) return null;
  let json;
  try {
    json = JSON.parse(String(node.textContent || ""));
  } catch (_) {
    return null;
  }
  const vol = json && json.props && json.props.pageProps && json.props.pageProps.volume;
  if (!vol || !Array.isArray(vol.data) || !vol.data.length) return null;

  const parts = [];
  let cover = "";
  let projectCount = 0;
  for (const cat of vol.data) {
    const items = Array.isArray(cat && cat.items) ? cat.items : [];
    if (!items.length) continue;
    parts.push(`<h2>${esc(cat.category_name || "项目")}</h2>`);
    for (const it of items) {
      const name = String((it && (it.name || it.full_name)) || "").trim();
      if (!name) continue;
      const repo = httpUrl(it.github_url) || httpUrl("https://github.com/" + String(it.full_name || ""));
      const desc = String((it && it.description) || "").trim();
      projectCount += 1;
      parts.push(repo ? `<h3><a href="${esc(repo)}">${esc(name)}</a></h3>` : `<h3>${esc(name)}</h3>`);
      if (desc) parts.push(`<p>${esc(desc)}</p>`);
      const meta = [];
      if (repo && it.full_name) meta.push(`<a href="${esc(repo)}">${esc(it.full_name)}</a>`);
      else if (it.full_name) meta.push(esc(it.full_name));
      if (Number(it.stars) > 0) meta.push(`★ ${esc(it.stars)}`);
      if (Number(it.forks) > 0) meta.push(`Fork ${esc(it.forks)}`);
      if (meta.length) parts.push(`<p>${meta.join(" · ")}</p>`);
      if (!cover) {
        const img = httpUrl(it.image_url);
        if (img) cover = img; // 仅作封面候选，不内联（动图配图逐张加载代价高）
      }
    }
  }
  if (!projectCount) return null;
  parts.unshift(`<p>本期共 ${projectCount} 个项目，按分类列出。</p>`);
  return { content: parts.join(""), cover: cover || undefined, adapter: "hellogithub" };
}

/** Indie Radar 条目页：article 内「摘录 → AI 导读 → 推荐理由 → 来源 → 标签」重组 */
function extractIndieRadar({ document }) {
  const article = document.querySelector("article");
  if (!article) return null;
  const h1 = article.querySelector("h1");
  const parts = [];
  let excerpt = "";
  let source = null;
  const sections = [];

  for (const child of Array.from(article.children || [])) {
    const tag = String(child.tagName || "").toUpperCase();
    if (tag === "H1") continue; // 标题由阅读器单独渲染
    if (tag === "SECTION") {
      const labelNode = child.querySelector("div");
      const bodyNode = child.querySelector("p") || child.querySelector("blockquote");
      const label = labelNode ? String(labelNode.textContent || "").trim() : "";
      const body = bodyNode ? String(bodyNode.textContent || "").trim() : "";
      if (label && body) sections.push({ label, body });
      continue;
    }
    if (tag === "P") {
      const text = String(child.textContent || "").trim();
      if (!text) continue;
      if (/^来源[：:]/.test(text)) {
        const a = child.querySelector("a[href]");
        source = a ? { href: httpUrl(a.getAttribute("href")), text: String(a.textContent || "").trim() } : { href: "", text: text.replace(/^来源[：:]\s*/, "") };
      } else if (!excerpt && !/^AI 评分|^精选$/.test(text)) {
        excerpt = text;
      }
      continue;
    }
    if (tag === "DIV") {
      const chips = Array.from(child.querySelectorAll("a.chip, a[href*='/all?tag=']")).map((a) =>
        String(a.textContent || "").replace(/^#\s*/, "").trim()
      );
      if (chips.length) sections.push({ label: "\u0000tags", body: chips.filter(Boolean).join(" · ") });
    }
  }

  if (excerpt) parts.push(`<p>${esc(excerpt)}</p>`);
  for (const s of sections) {
    if (s.label === "\u0000tags") {
      if (s.body) parts.push(`<p><strong>标签</strong>：${esc(s.body)}</p>`);
      continue;
    }
    parts.push(`<h2>${esc(s.label)}</h2>`);
    parts.push(`<p>${esc(s.body)}</p>`);
  }
  if (source && source.text) {
    parts.push(
      source.href
        ? `<p><strong>来源</strong>：<a href="${esc(source.href)}">${esc(source.text)}</a></p>`
        : `<p><strong>来源</strong>：${esc(source.text)}</p>`
    );
  }
  if (!parts.length) return null;
  // 兜底：h1 只有标题，正文全是空 → 视为适配失败（交 Readability）
  if (htmlToText(parts.join("")).length < 80) return null;
  const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
  const cover = og ? httpUrl(og.getAttribute("content")) : "";
  return { content: parts.join(""), cover: cover || undefined, adapter: "indie-radar" };
}

const ARTICLE_ADAPTERS = [
  {
    id: "hellogithub-periodical",
    test: (url) => hostIs(hostOf(url), "hellogithub.com") && /^\/periodical\/volume\/\d+/.test(pathOf(url)),
    extract: extractHellogithub,
  },
  {
    id: "indie-radar-item",
    test: (url) => hostIs(hostOf(url), "radar.everythingisok.top") && /^\/items\//.test(pathOf(url)),
    extract: extractIndieRadar,
  },
];

/**
 * 文章级适配入口。
 * @param {string} url 文章地址
 * @param {object} document linkedom 解析后的 document（调用方已 parse，避免二次 parse）
 * @returns {{content:string, cover?:string, adapter:string}|null} null = 无适配/适配失败 → 回落 Readability
 */
function extractArticle(url, document) {
  if (!document) return null;
  const adapter = ARTICLE_ADAPTERS.find((a) => {
    try {
      return a.test(url);
    } catch (_) {
      return false;
    }
  });
  if (!adapter) return null;
  try {
    const out = adapter.extract({ url: String(url), document });
    if (!out || !out.content) return null;
    return out;
  } catch (_) {
    return null; // 页面改版/JSON 变形 → 静默回落 Readability，绝不让适配层炸掉提取链路
  }
}

module.exports = {
  applyFeedAdapter,
  extractArticle,
  hostOf,
  esc,
  httpUrl,
  __test: { FEED_ADAPTERS, ARTICLE_ADAPTERS, extractHellogithub, extractIndieRadar, AIGC_PROMO_RE },
};
