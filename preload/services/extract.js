/**
 * extract.js — 全文提取服务（PLAN-V1.3 §1.1 阶段 A）
 *
 * 形态：摘要型源（feed 只带摘要/短正文）打开文章时，preload 抓原文页 →
 * Readability 提取（linkedom，选型见 PLAN-V1.3 附录）→ 相对 URL 绝对化 →
 * sanitizeContent 消毒 → itemfullx: 独立前缀缓存 → 渲染层替换正文。
 *
 * 安全基线：Readability 输出按不可信输入处理，一律过 sanitizeContent（§7 唯一 HTML 产源）。
 * 数据纪律：itemfullx 不写回 itemfull（与 ingest 写序/contentHash 判重解耦）；
 * 落库时连带失效 item.aiTrans（T-09 同族——译文对替换前正文生成，head 匹配必失配）。
 * 日志纪律（T-11）：只记 { itemId, status, ms, error }，原文 URL 与正文不入日志。
 *
 * 状态机：
 *   off      源未开全文（feed.fullText 缺失/false，硬门控）
 *   hit      itemfullx 缓存命中
 *   rich     feed 自带正文已达标（≥FULLTEXT_MIN_CHARS），无需提取
 *   fetched  本次提取成功并已落库
 *   error    NO_LINK / FETCH_* / EXTRACT_FAILED / EXTRACT_TOO_SHORT / NOT_FOUND / STORE_FAILED
 *            （渲染层各失败态一律安静保留原摘要，无 toast）
 */
// 惰性加载 DOM 引擎：linkedom 的传递依赖一旦漂移成纯 ESM（2026-09 实机炸点：
// 0.18.13 依赖 css-select@7 "type":"module"，uTools Electron 的 CJS loader 拒载，
// 顶层 require 会拖死整个 preload），此处降级为提取失败，阅读主链路不受牵连。
let engine;
function getEngine() {
  if (engine === undefined) {
    try {
      engine = {
        parseHTML: require("linkedom").parseHTML,
        Readability: require("@mozilla/readability").Readability,
      };
    } catch (_) {
      engine = null;
      logger.warn("extract", "engine unavailable", {});
    }
  }
  return engine;
}
const { nodeFetch } = require("./http.js");
const { decodeBuffer } = require("./feed.js");
const { sanitizeContent, htmlToText } = require("./article.js");
const dbSvc = require("./db.js");
const logger = require("./logger.js");

const FULLTEXT_MIN_CHARS = 600; // 与 PLAN-V1.3 §1.1 常量一致；提取与 rich 判定共用
const FETCH_TIMEOUT_MS = 12000;
const FETCH_MAX_BYTES = 3 * 1024 * 1024;

/** 注入点（test-db-mock 用 fixture + stub，不走真实网络） */
const ctx = { nodeFetch: (url, opts) => nodeFetch(url, opts) };

/** 并发去重：同 item 并发调用合流（快速切文再切回不重复抓） */
const inflight = new Map();

function err(error) {
  return { status: "error", content: null, error };
}

/**
 * 相对 URL 绝对化：提取结果内 img[src]/a[href] 以 item.link 为基址补全。
 * 否则 sanitize 的 scheme 白名单会把 /assets/x.jpg 这类相对地址全剥（风险③）。
 * 协议相对（//host/x）与 data:/javascript: 由 new URL 解析或 sanitize 白名单兜底。
 */
function absolutize(html, base) {
  const eng = getEngine();
  if (!eng) return html; // 引擎不可用：原样交 sanitize（相对地址会被剥，阅读主链路存活）
  try {
    const { document } = eng.parseHTML(html);
    for (const el of document.querySelectorAll("img[src]")) {
      try {
        el.setAttribute("src", new URL(el.getAttribute("src"), base).toString());
      } catch (_) {
        /* 非法 src 原样保留，交给 sanitize 剥 */
      }
    }
    for (const el of document.querySelectorAll("a[href]")) {
      try {
        el.setAttribute("href", new URL(el.getAttribute("href"), base).toString());
      } catch (_) {
        /* 同上 */
      }
    }
    return document.toString();
  } catch (_) {
    return html; // 序列化异常原样交 sanitize 兜底
  }
}

/** 单次提取尝试（无并发副作用；ensureFull 负责去重与日志） */
async function runOnce(itemId) {
  // item/feed 复验：删除/保留清理竞态下安静退出（渲染层按安静分支处理，不弹错）
  const item = await dbSvc.getDoc(itemId);
  if (!item || !item.feedKey) return err("NOT_FOUND");
  const feed = await dbSvc.getDoc(item.feedKey);
  if (!feed) return err("NOT_FOUND");

  if (!feed.fullText) return { status: "off", content: null, error: null };

  const cached = await dbSvc.getDoc("itemfullx:" + itemId);
  if (cached && cached.content) return { status: "hit", content: cached.content, error: null };

  const full = await dbSvc.getItemFull(itemId);
  if (full && htmlToText(full).length >= FULLTEXT_MIN_CHARS) return { status: "rich", content: null, error: null };

  if (!item.link) return err("NO_LINK");

  // URL 必须传字符串（preload 跨 realm 坑，AGENTS.md 已知坑）
  const res = await ctx.nodeFetch(String(item.link), { timeout: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
  if (!res.ok) return err("FETCH_" + String(res.error || res.status || "FAILED").slice(0, 40)); // 截 40 字符防 URL/地址片段入日志（T-11 边际）
  if (res.truncated) return err("FETCH_TOO_LARGE"); // 3MB 截断的半个页面不得当全文落库
  if (!res.body || res.body.length === 0) return err("FETCH_EMPTY_BODY"); // spike 实例：bot 挑战页 202+Content-Length:0

  const html = decodeBuffer(res.body, res.headers["content-type"]);
  if (!html || !/<[a-z!]/i.test(html.slice(0, 1000))) return err("EXTRACT_FAILED");

  // 构造与 parse 全程 try/catch：linkedom 遇空/碎 HTML 在访问 body 时抛 TypeError（spike 已证）
  let art;
  try {
    const eng = getEngine();
    if (!eng) return err("EXTRACT_FAILED");
    const { document } = eng.parseHTML(html);
    art = new eng.Readability(document).parse();
  } catch (_) {
    return err("EXTRACT_FAILED");
  }
  if (!art || !art.content) return err("EXTRACT_FAILED");

  const clean = sanitizeContent(absolutize(art.content, String(item.link)));
  if (htmlToText(clean).length < FULLTEXT_MIN_CHARS) return err("EXTRACT_TOO_SHORT"); // 不落库，下次打开可重试

  // 落库 1：itemfullx 独立前缀（putRetry 内 plainClone；失败可重试）
  const saved = await dbSvc.putRetry({ _id: "itemfullx:" + itemId, content: clean, at: Date.now(), src: "readability" });
  if (!saved) return err("STORE_FAILED");

  // 落库 2：连带失效旧译文与旧目录（保留 ai.summary/tags——基于摘要文本生成，仍成立）。
  // get 复验再写，避免覆盖期间并发的已读/星标变更。
  const fresh = await dbSvc.getDoc(itemId);
  if (fresh && (fresh.aiTrans || fresh.aiToc)) {
    delete fresh.aiTrans;
    delete fresh.aiToc; // 目录锚点对替换前正文，head 必失配（T-09 同族，PLAN-AI-TOC）
    await dbSvc.putRetry(fresh);
  }

  return { status: "fetched", content: clean, error: null };
}

/**
 * @param {string} itemId
 * @returns {Promise<{status:'off'|'hit'|'rich'|'fetched'|'error', content:string|null, error:string|null}>}
 */
async function ensureFull(itemId) {
  const pending = inflight.get(itemId);
  if (pending) return pending;
  const t0 = Date.now();
  const p = (async () => {
    try {
      return await runOnce(itemId);
    } catch (_) {
      return err("EXTRACT_FAILED"); // 兜底：runOnce 任何未预期异常都归安静降级
    } finally {
      inflight.delete(itemId);
    }
  })().then((r) => {
    // 埋点不含原文 URL/正文（T-11）
    const data = { itemId, ms: Date.now() - t0 };
    if (r.error) data.error = r.error;
    (r.status === "error" ? logger.warn : logger.info)("extract", "ensureFull " + r.status, data);
    return r;
  });
  inflight.set(itemId, p);
  return p;
}

module.exports = { ensureFull, __test: { FULLTEXT_MIN_CHARS, absolutize, ctx, inflight } };
