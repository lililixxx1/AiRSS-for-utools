/**
 * ai.js — AI 增强管线（二期，airss-design.md v0.4 §5.2/§6）
 *
 * 引擎：utools.ai（默认，流式）| BYOK（OpenAI 兼容 /chat/completions，密钥存 dbCryptoStorage，T-11）
 * 缓存：ai:{kind}:{hash} 文档 — enrich 复合键 ai:enrich:v2:{contentHashTrunc}:{titleHash}（H1/F2，
 *       v2 = titleNorm 改 AI优化标题口径），轻量批 ai:cls:v2:{titleHash}；LRU 上限 5000。
 * 额度：分池硬保护（手动 120/日、后台 30/日），BYOK 豁免；abort 已产出文本计入（F4）。
 * 原子性（H2）：流式产物仅在完整结束后写缓存与 item.ai；abort/失败全丢弃。
 * 回写守则（H4）：回写前 get() 复验 item 存在（清理竞态 M8）；轻量批不覆盖 enrich（T-21）；按篇隔离失败。
 *
 * aiStatus 状态机：none → done | error（pending 仅存在于调用方内存，崩溃后无残留）。
 */
const dbSvc = require("./db.js");
const articleSvc = require("./article.js");
const logger = require("./logger.js");
const { postJson } = require("./http.js");

const CFG_KEY = "airss:ai-config";
const QUOTA_KEY = "airss:ai-quota";
const BYOK_KEY_NAME = "airss:byok-key";

const TRUNC_CHARS = 2000; // 送 AI 正文截断。2026-09 实机：4000 字输入时 enrich 全程 6~32s，
// 延迟大头在服务端预填充；3~5 句客观摘要用前 2000 字足够，砍半输入换明显提速
const CACHE_MAX = 5000; // AI 缓存 LRU 上限
const BATCH_MAX = 20; // 轻量批单次篇数
const QUOTA_MANUAL_MAX = 120;
const QUOTA_BG_MAX = 30;
const DEFAULT_CATEGORIES = ["科技", "商业", "设计", "开发", "工具", "生活", "文化", "其他"];

const DEFAULT_CONFIG = {
  enabled: false, // 默认关闭：设置页显式开启（与渲染层 settings.aiEnabled 联动写穿）
  engine: "utools", // "utools" | "byok"
  model: "", // 空 = utools.ai 默认 deepseek-v3
  modelLabel: "", // 所选模型的可读名（allAiModels 的 label；日志显示用，不参与调用）
  byokBaseUrl: "",
  byokModel: "",
  byokAllowHttp: false, // T-11：http 需显式确认
};

const ut = () => global.utools || window.utools;
const store = () => ut().dbStorage;
const cryptoStore = () => ut().dbCryptoStorage;
const db = () => ut().db.promises;

// ---------------------------------------------------------------------------
// 配置与密钥（配置走 dbStorage；密钥只进 dbCryptoStorage，永不出 preload）
// ---------------------------------------------------------------------------

function getConfig() {
  try {
    let raw = store().getItem(CFG_KEY);
    if (typeof raw === "string") raw = JSON.parse(raw);
    return Object.assign({}, DEFAULT_CONFIG, raw || {});
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  const cfg = Object.assign(getConfig(), patch || {});
  store().setItem(CFG_KEY, JSON.stringify(cfg));
  return cfg;
}

function getByokKey() {
  try {
    return cryptoStore().getItem(BYOK_KEY_NAME) || "";
  } catch (_) {
    return "";
  }
}

function setByokKey(key) {
  cryptoStore().setItem(BYOK_KEY_NAME, String(key || ""));
}

function hasByokKey() {
  return !!getByokKey();
}

// ---------------------------------------------------------------------------
// 额度分池（BYOK 豁免；跨日自动重置）
// ---------------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function loadQuota() {
  try {
    let raw = store().getItem(QUOTA_KEY);
    if (typeof raw === "string") raw = JSON.parse(raw);
    if (raw && raw.date === todayStr()) return raw;
  } catch (_) { /* 坏数据按新一天处理 */ }
  return { date: todayStr(), manual: 0, bg: 0 };
}

function quotaCheck(pool, cfg) {
  if (cfg.engine === "byok") return { ok: true }; // BYOK 豁免
  const q = loadQuota();
  const cap = pool === "manual" ? QUOTA_MANUAL_MAX : QUOTA_BG_MAX;
  return (q[pool] || 0) >= cap ? { ok: false, error: "QUOTA_EXHAUSTED" } : { ok: true };
}

function countCall(pool, cfg) {
  if (cfg.engine === "byok") return;
  const q = loadQuota();
  q[pool] = (q[pool] || 0) + 1;
  store().setItem(QUOTA_KEY, JSON.stringify(q));
}

// ---------------------------------------------------------------------------
// 引擎调用（统一 abort 句柄；流式回调透传给渲染层）
// ---------------------------------------------------------------------------

let currentAbort = null;
// 发起序（阶段C 审核 I2）：enrich/translateItem/batch 入口与 abort() 都自增；引擎层"起飞前"比对，
// 序号落后即自弃且不让位在飞调用——封死"前奏期间被 abort、注册时反而覆盖新调用句柄"的双飞窗口
let callClaim = 0;

/** 中断当前进行中的 AI 调用（离开阅读面板 / 插件被杀） */
function abort() {
  callClaim += 1; // 也视作一次更新意图：尚在前奏（未起飞）的旧调用将自弃
  if (currentAbort) {
    try {
      currentAbort();
    } catch (_) { /* 已结束的调用忽略 */ }
    currentAbort = null;
  }
}

async function callEngine(messages, { cfg, stream, onDelta, claim }) {
  if (cfg.engine === "byok") return callByok(messages, cfg, stream, onDelta, claim);
  return callUtools(messages, cfg, stream, onDelta, claim);
}

// 硬超时兜底：个别实现可能永不 resolve/reject（宿主 AI 服务未登录/挂起等），
// 没有兜底阅读面板会永远转圈。测试可经 __test.setEngineTimeout 缩短。
let engineTimeoutMs = 60_000;
const TIMEOUT_SENTINEL = "__AIRSS_ENGINE_TIMEOUT__";

function withTimeout(promiseLike, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), ms);
  });
  return Promise.race([promiseLike, timeout]).finally(() => clearTimeout(timer));
}

/** 起飞前序号判定：落后于最新意图（claim<callClaim）自弃；我即最新时旧序在飞调用让位 */
function claimGate(claim) {
  if (claim != null && claim < callClaim) return false; // 已被更新调用超越：不起飞、不动在飞句柄
  if (currentAbort) {
    try {
      currentAbort();
    } catch (_) { /* 引擎侧已回收 */ }
    currentAbort = null;
  }
  return true;
}

/** 空输出时 resolve 值的元信息：宿主若以 {error:…} 之类收场可直接看见病因。
 *  T-11 纪律：只记类型/字段名/短错误串（≤120 字符）；字符串值只记长度，防正文片段入日志 */
function resolveMeta(result) {
  if (result == null) return String(result); // "undefined" / "null"
  const t = typeof result;
  if (t !== "object") return { type: t, len: String(result).length };
  const meta = { keys: Object.keys(result).slice(0, 12) };
  for (const k of ["error", "code", "status", "message"]) {
    const v = result[k];
    if (v != null && String(v) !== "") meta[k] = String(v).slice(0, 120);
  }
  return meta;
}

/** utools.ai（宿主 ≥7.0）：流式收增量 chunk，PromiseLike 带 abort() */
async function callUtools(messages, cfg, stream, onDelta, claim) {
  const u = ut();
  if (!u || typeof u.ai !== "function") {
    logger.warn("ai.call", "utools.ai 不可用（宿主 <7.0 或接口未开放）");
    return { ok: false, error: "UTOOLS_AI_UNAVAILABLE" };
  }
  if (!claimGate(claim)) return { ok: false, aborted: true, error: "ABORTED" };
  const option = { messages };
  if (cfg.model) option.model = cfg.model;
  const t0 = Date.now();
  let acc = "";
  let chunkCount = 0;
  let snapshotMode = false; // 兼容快照式流（回调给累计全文而非增量）
  let p = null;
  try {
    p = stream
      ? u.ai(option, (chunk) => {
          const t = chunk && chunk.content ? String(chunk.content) : "";
          if (!t) return;
          chunkCount += 1;
          if (!snapshotMode && acc.length >= 8 && t.length > acc.length && t.startsWith(acc)) {
            snapshotMode = true;
            logger.info("ai.stream", "检测到快照式流回调（给累计全文），切换覆盖累计", { atChars: acc.length });
          }
          if (snapshotMode) {
            const delta = t.slice(acc.length);
            acc = t;
            if (delta && onDelta) onDelta(delta);
          } else {
            acc += t;
            if (onDelta) onDelta(t);
          }
        })
      : u.ai(option);
    currentAbort = () => {
      try {
        p.abort();
      } catch (_) { /* 引擎侧已回收 */ }
    };
    const result = await withTimeout(p, engineTimeoutMs);
    currentAbort = null;

    let content = stream ? acc : String((result && result.content) || "");
    if (stream) {
      // 早退竞态防御：个别实现可能提前 resolve，稍候让迟到回调落地，取更长者
      const accAtResolve = acc;
      await new Promise((r) => setTimeout(r, 150));
      if (acc.length > accAtResolve.length) {
        logger.warn("ai.stream", "resolve 后回调仍在追加（早退竞态）", { atResolve: accAtResolve.length, final: acc.length });
        content = acc;
      }
      const resolvedLen = result && result.content ? String(result.content).length : 0;
      if (resolvedLen > content.length) {
        logger.info("ai.stream", "resolve 值长于回调累计，采用 resolve 值", { resolvedLen, accLen: content.length });
        content = String(result.content);
      }
      logger.info("ai.call", "引擎调用完成", {
        engine: "utools",
        stream: true,
        model: modelLabelFor(cfg),
        ms: Date.now() - t0,
        chunks: chunkCount,
        chars: content.length,
        head: content.slice(0, 24),
        tail: content.slice(-24),
      });
    } else {
      logger.info("ai.call", "引擎调用完成", { engine: "utools", stream: false, model: modelLabelFor(cfg), ms: Date.now() - t0, chars: content.length });
    }
    if (!content.trim()) {
      logger.warn("ai.call", "空输出", { chunks: chunkCount, resolve: resolveMeta(result) });
      return { ok: false, error: "EMPTY_OUTPUT" };
    }
    return { ok: true, content };
  } catch (e) {
    currentAbort = null;
    const msg = String((e && e.message) || e);
    if (msg === TIMEOUT_SENTINEL) {
      try {
        p.abort();
      } catch (_) { /* 引擎不响应 abort 也无所谓，调用方已拿到超时结果 */ }
      logger.warn("ai.call", "引擎硬超时，放弃本次调用", { ms: engineTimeoutMs, chunks: chunkCount, accChars: acc.length });
      return { ok: false, error: "ENGINE_TIMEOUT" };
    }
    const aborted = /abort/i.test(msg);
    logger.warn("ai.call", aborted ? "调用被中止" : "调用抛错", { error: msg.slice(0, 120), chunks: chunkCount, accChars: acc.length });
    return { ok: false, aborted, error: aborted ? "ABORTED" : msg.slice(0, 80) };
  }
}

/** BYOK 端点归一：裸域名 → /v1/chat/completions；…/v1 → /chat/completions；全路径直用 */
function byokEndpoint(base) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return b + "/chat/completions";
  return b + "/v1/chat/completions";
}

/** BYOK：OpenAI 兼容 chat/completions（SSE 流式或整体 JSON）。日志只记状态/字数，不记 URL 与密钥（T-11） */
async function callByok(messages, cfg, stream, onDelta, claim) {
  const key = getByokKey();
  if (!key) return { ok: false, error: "BYOK_KEY_MISSING" };
  const url = byokEndpoint(cfg.byokBaseUrl);
  if (!url) return { ok: false, error: "BYOK_URL_MISSING" };
  if (!claimGate(claim)) return { ok: false, aborted: true, error: "ABORTED" };

  let acc = "";
  let sseEvents = 0;
  const t0 = Date.now();
  const res = await postJson(url, {
    headers: { Authorization: "Bearer " + key },
    json: { model: cfg.byokModel || "gpt-4o-mini", messages, stream: !!stream },
    sse: !!stream,
    httpsOnly: !cfg.byokAllowHttp,
    register: (destroy) => {
      currentAbort = destroy;
    },
    onLine: (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const j = JSON.parse(payload);
        sseEvents += 1;
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) {
          acc += String(t);
          if (onDelta) onDelta(String(t));
        }
      } catch (_) { /* 心跳/半包行忽略 */ }
    },
  });
  currentAbort = null;

  if (res.error === "ABORTED") {
    logger.info("ai.call", "BYOK 调用被中止", { chars: acc.length });
    return { ok: false, aborted: true, error: "ABORTED" };
  }
  if (res.ok || (stream && acc)) {
    let content = acc;
    if (!stream) {
      try {
        const j = JSON.parse(res.text);
        content = String(j.choices[0].message.content || "");
      } catch (_) {
        content = "";
      }
    }
    logger.info("ai.call", "BYOK 调用完成", { engine: "byok", stream: !!stream, model: modelLabelFor(cfg), ms: Date.now() - t0, sseEvents, chars: content.length, head: content.slice(0, 24), tail: content.slice(-24) });
    if (content.trim()) return { ok: true, content };
    logger.warn("ai.call", "BYOK 空输出", { sseEvents, httpStatus: res.status });
    return { ok: false, error: "EMPTY_OUTPUT" };
  }
  logger.warn("ai.call", "BYOK 调用失败", { error: res.error, httpStatus: res.status }); // 不记 URL
  return { ok: false, error: res.error || "HTTP_" + res.status };
}

// ---------------------------------------------------------------------------
// AI 缓存（ai:{kind}:{hash}，LRU）
// ---------------------------------------------------------------------------

/** 日志/展示用的模型名：可读 label 优先，退回内部 id（aimodels/…哈希），再退回默认名 */
function modelLabelFor(cfg) {
  if (cfg.engine === "byok") return cfg.byokModel || "byok";
  return cfg.modelLabel || cfg.model || "deepseek-v3";
}

let putsSinceTrim = 0;

async function cachePut(id, result) {
  const cfg = getConfig();
  const existing = await db().get(id);
  const doc = { _id: id, result, model: modelLabelFor(cfg), createdAt: Date.now() };
  if (existing) doc._rev = existing._rev;
  await dbSvc.putRetry(doc);
  putsSinceTrim += 1;
}

/** LRU：超上限删最旧（低频执行，每 50 次写入触发一次检查） */
async function cacheTrim() {
  if (putsSinceTrim < 50) return;
  putsSinceTrim = 0;
  const all = await db().allDocs("ai:");
  if (all.length <= CACHE_MAX) return;
  const doomed = all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(0, all.length - CACHE_MAX);
  for (const d of doomed) await db().remove(d._id);
}

// ---------------------------------------------------------------------------
// Prompt（§6.2 草案；正文用 <<< >>> 栅栏包裹，正文内指令样文本不构成指令 T-58）
// ---------------------------------------------------------------------------

async function categoryList() {
  try {
    const feeds = await dbSvc.getFeeds();
    const set = new Set(DEFAULT_CATEGORIES);
    for (const f of feeds) if (f.category) set.add(f.category);
    return [...set].slice(0, 12);
  } catch (_) {
    return DEFAULT_CATEGORIES.slice();
  }
}

function buildEnrichMessages(item, truncText, categories) {
  const cat = (categories.length ? categories : DEFAULT_CATEGORIES).join("/");
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

function firstSentence(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const m = t.split(/[。！？!?.\n\r]/)[0] || t;
  return m.slice(0, 80);
}

function buildBatchMessages(docs, categories) {
  const cat = (categories.length ? categories : DEFAULT_CATEGORIES).join("/");
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

/**
 * 合并调用输出解析：头部元信息失败整体降级为纯摘要（§6.2）。
 * 元信息各段之间允许换行/空白（模型常把【titleZh】/【titleNorm】/【tags】分行输出）。
 */
function parseEnrichOutput(text) {
  const out = { summary: "", titleZh: "", titleNorm: "", tags: [] };
  const head = String(text || "");
  const m = /【titleZh】\s*([^【\n]*)\s*【titleNorm】\s*([^【\n]*)\s*【tags】\s*([^【\n]*)/.exec(head);
  if (m) {
    out.titleZh = m[1].trim().slice(0, 60);
    out.titleNorm = m[2].trim().slice(0, 30);
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

// ---------------------------------------------------------------------------
// item 回写（H4 守则 + T-21 覆盖规则）
// ---------------------------------------------------------------------------

/** 展示标题优先级：titleNorm（AI优化）> titleZh > 原 title（与原标题相同则不替换） */
function pickDisplayTitle(title, ai) {
  const cand = (ai.titleNorm || ai.titleZh || "").trim();
  return cand && cand !== title ? cand : "";
}

/**
 * AI 产物回写 item。回写前重新 get()：期间可能被清理/内容更新（M8）。
 * batch 不覆盖 enrich 产物（T-21 展示始终 enrich 优先，避免标题前后跳变）。
 */
async function applyAi(itemDoc, ai, source) {
  const fresh = await db().get(itemDoc._id);
  if (!fresh) return null;
  if (source === "batch" && fresh.ai && fresh.ai.aiSource === "enrich") return fresh;
  fresh.ai = {
    summary: String(ai.summary || ""),
    tags: Array.isArray(ai.tags) ? ai.tags.map(String).slice(0, 2) : [],
    titleZh: String(ai.titleZh || ""),
    titleNorm: String(ai.titleNorm || ""),
    aiSource: source,
  };
  fresh.aiStatus = "done";
  const disp = pickDisplayTitle(fresh.title, fresh.ai);
  if (disp) fresh.titleDisplay = disp;
  else if (fresh.titleDisplay !== fresh.title) fresh.titleDisplay = fresh.title;
  const saved = await dbSvc.putRetry(fresh);
  return saved || fresh;
}

/** 失败落 aiStatus=error（已 done 的保留旧产物不降级；重新生成失败时旧摘要仍可读） */
async function markError(itemId) {
  const fresh = await db().get(itemId);
  if (!fresh || fresh.aiStatus === "done") return;
  fresh.aiStatus = "error";
  await dbSvc.putRetry(fresh);
}

// ---------------------------------------------------------------------------
// enrich：打开文章时的合并调用（流式 · 手动池）
// ---------------------------------------------------------------------------

/**
 * @param {string} itemId
 * @param {{bypass?:boolean, onDelta?:(t:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, aborted?:boolean, ai:object|null, cached:boolean, error:string|null}>}
 */
async function enrich(itemId, opts = {}) {
  const claim = ++callClaim; // 发起序：引擎起飞前比对，被 abort/更新调用超越即自弃
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, ai: null, cached: false, error: "AI_DISABLED" };

  const item = await db().get(itemId);
  if (!item) return { ok: false, ai: null, cached: false, error: "NOT_FOUND" };

  // item 层命中：已有 enrich 产物且非强制重生成
  if (!opts.bypass && item.aiStatus === "done" && item.ai && item.ai.aiSource === "enrich") {
    logger.info("ai.enrich", "item 层命中（已有 enrich 产物）", { itemId });
    return { ok: true, ai: item.ai, cached: true, error: null };
  }

  // 复合缓存键（H1/F2）：contentHashTrunc = 截断正文哈希，正文缺失退化 title‖guid‖summaryText
  // 输入限幅：itemfull 上限 100KB，全文同步消毒转纯文本开销大且没必要——截 24KB 原文足够产出 2000 字纯文本
  // PLAN-V1.3 A：改取 Best（优先 itemfullx 提取版，正文更完整摘要质量受益）；缓存键含截断正文
  // 哈希，提取版出现后自然换键生成；item 层 aiStatus=done 短路保留旧产物（不刷存量）
  const full = await dbSvc.getItemFullBest(itemId);
  const text = full ? articleSvc.htmlToText(String(full).slice(0, 24576)) : "";
  const trunc = text.slice(0, TRUNC_CHARS);
  const truncHash = trunc
    ? dbSvc.sha12(trunc)
    : dbSvc.sha12(item.title + "‖" + (item.guid || "") + "‖" + (item.summaryText || ""));
  const titleHash = dbSvc.sha12(item.title);
  // v2：titleNorm 口径由"噱头客观化"放宽为 AI优化标题，缓存键升版让旧口径产物不命中
  const cacheId = "ai:enrich:v2:" + truncHash + ":" + titleHash;

  if (!opts.bypass) {
    const cached = await db().get(cacheId);
    if (cached && cached.result) {
      const saved = await applyAi(item, cached.result, "enrich");
      logger.info("ai.enrich", "复合缓存命中并回写", { itemId, inputChars: trunc.length, hasFull: !!full });
      return { ok: true, ai: cached.result, cached: true, error: null, item: saved };
    }
  }

  const q = quotaCheck("manual", cfg);
  if (!q.ok) {
    logger.warn("ai.enrich", "手动池额度耗尽，跳过", { itemId, used: loadQuota().manual });
    return { ok: false, ai: null, cached: false, error: q.error };
  }

  const categories = await categoryList();
  const messages = buildEnrichMessages(item, trunc, categories);
  logger.info("ai.enrich", "发起合并调用", { itemId, engine: cfg.engine, inputChars: trunc.length, hasFull: !!full, bypass: !!opts.bypass, stream: true });

  let produced = false;
  const call = await callEngine(messages, {
    cfg,
    claim,
    stream: true,
    onDelta: (t) => {
      produced = true;
      if (opts.onDelta) opts.onDelta(t);
    },
  });

  if (!call.ok) {
    if (produced) countCall("manual", cfg); // F4：abort/失败但已产出文本均计入额度
    if (call.aborted) {
      logger.info("ai.enrich", "调用被中止（离开面板等），产物全弃", { itemId, produced });
      return { ok: false, aborted: true, ai: null, cached: false, error: "ABORTED" };
    }
    logger.warn("ai.enrich", "调用失败", { itemId, error: call.error, produced });
    await markError(itemId);
    return { ok: false, ai: null, cached: false, error: call.error };
  }

  countCall("manual", cfg);
  const ai = parseEnrichOutput(call.content);
  logger.info("ai.enrich", "解析产物", {
    itemId,
    rawChars: call.content.length,
    summaryChars: ai.summary.length,
    titleZh: ai.titleZh ? "有" : "无",
    titleNorm: ai.titleNorm ? "有" : "无",
    tags: ai.tags.join(","),
    degraded: !/【titleZh】/.test(call.content), // 头部没按格式给 → 降级为纯摘要
  });
  await cachePut(cacheId, ai);
  const saved = await applyAi(item, ai, "enrich");
  await cacheTrim();
  logger.info("ai.enrich", "回写完成", { itemId, wrote: !!saved });
  return { ok: true, ai, cached: false, error: null, item: saved };
}

// ---------------------------------------------------------------------------
// 轻量批：刷新后对新文章补 tags/titleZh/titleNorm（非流式 · 后台池）
// ---------------------------------------------------------------------------

/**
 * @param {Array} itemDocs 候选文章（渲染层已按 pubTs 近 7 天过滤）
 * @returns {Promise<{ok:boolean, updated:Array, error:string|null}>}
 */
async function batchEnrich(itemDocs) {
  const claim = ++callClaim; // 发起序（与 enrich 同纪律，防批调用与前奏中的新调用双飞）
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, updated: [], error: "AI_DISABLED" };

  const updated = [];
  const candidates = [];
  for (const doc of itemDocs) {
    if (!doc || doc.aiStatus === "done" || doc.aiStatus === "error") continue;
    const cacheId = "ai:cls:v2:" + dbSvc.sha12(doc.title); // v2 同 enrich：AI优化标题口径
    const cached = await db().get(cacheId);
    if (cached && cached.result) {
      const r = await applyAi(doc, cached.result, "batch"); // 缓存命中直取，不耗调用
      if (r) updated.push(r);
      continue;
    }
    if (candidates.length < BATCH_MAX) candidates.push({ doc, cacheId });
  }
  if (!candidates.length) return { ok: true, updated, error: null };

  const q = quotaCheck("bg", cfg);
  if (!q.ok) {
    logger.warn("ai.batch", "后台池额度耗尽，本批跳过", { pending: candidates.length, used: loadQuota().bg });
    return { ok: false, updated, error: q.error };
  }

  const categories = await categoryList();
  const call = await callEngine(buildBatchMessages(candidates.map((c) => c.doc), categories), { cfg, claim, stream: false });
  if (!call.ok) {
    logger.warn("ai.batch", "批量调用失败", { pending: candidates.length, error: call.error });
    return { ok: false, updated, error: call.error };
  }
  countCall("bg", cfg);

  let arr;
  try {
    const m = /\[[\s\S]*\]/.exec(call.content);
    arr = JSON.parse(m ? m[0] : call.content);
    if (!Array.isArray(arr)) throw new Error("not_array");
  } catch (_) {
    logger.warn("ai.batch", "JSON 输出解析失败", { rawChars: call.content.length, head: call.content.slice(0, 60) });
    return { ok: false, updated, error: "BAD_JSON_OUTPUT" };
  }

  const byId = new Map();
  for (const row of arr) if (row && row.id != null) byId.set(String(row.id), row);

  let applied = 0;
  for (const c of candidates) {
    const row = byId.get(String(c.doc._id));
    if (!row) continue; // 按篇隔离：缺篇不阻塞其他篇
    const ai = {
      summary: "",
      tags: Array.isArray(row.tags)
        ? row.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 2)
        : String(row.tags || "")
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 2),
      titleZh: String(row.titleZh || "").trim().slice(0, 60),
      titleNorm: String(row.titleNorm || "").trim().slice(0, 30),
    };
    await cachePut(c.cacheId, ai);
    const r = await applyAi(c.doc, ai, "batch"); // 内部 get() 复验 + 不覆盖 enrich（H4/T-21）
    if (r) {
      updated.push(r);
      applied += 1;
    }
  }
  await cacheTrim();
  logger.info("ai.batch", "轻量批完成", { sent: candidates.length, parsed: arr.length, applied, cacheDirect: updated.length - applied });
  return { ok: true, updated, error: null };
}

// ---------------------------------------------------------------------------
// 段落翻译（v1.2）：渲染层切块纯文本入，preload 只调引擎与落库（无 HTML 往返）
// ---------------------------------------------------------------------------

const TRANS_MAX_PARAS = 10; // 单次翻译段上限（一次调用整批，额度友好）
const TRANS_MAX_CHARS = 4000; // 单次输入总字符上限（输出同量级，防慢请求）

/** CJK 占比：>0.5 视为中文为主，无需翻译（渲染层预估、preload 硬门控双层） */
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

/**
 * 解析 [[n]]译文 协议。切段边界=下一个标记或文本尾（译文含 [ 不截断）；
 * 缺失段跳过（按段隔离）；译文含 [[数字]] 字样的极端输出降级为切段错位，不致命。
 * @returns {{texts: Object<string,string>, count: number}}
 */
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

/** 译文回写 item.aiTrans（H4 get 复验同 applyAi；纯文本产物，无 HTML） */
async function applyTrans(itemDoc, paras, texts, model) {
  const fresh = await db().get(itemDoc._id);
  if (!fresh) return null;
  const out = [];
  for (const p of paras) {
    const t = texts[String(p.idx)];
    if (t) out.push({ idx: p.idx, head: String(p.head || "").slice(0, 20), text: t });
  }
  if (!out.length) return fresh;
  fresh.aiTrans = { paras: out, at: Date.now(), model };
  const saved = await dbSvc.putRetry(fresh);
  return saved || fresh;
}

/**
 * 提取竞态守卫（PLAN-V1.3 A 送审必改 B-1）：本请求发起（t0）之后全文提取才落库
 * （itemfullx.at > t0）→ 输入段落切自替换前的摘要正文，译文对新正文必然 head 失配，
 * 产物必须弃写——否则会把刚被提取层 T-09 同族清理的旧译文复活成死数据。
 */
async function supersededByExtract(itemId, startedAt) {
  const x = await db().get("itemfullx:" + itemId);
  return !!(x && x.at && x.at > startedAt);
}

/**
 * AI 段落翻译（v1.2，流式 · 手动池）。
 * @param {string} itemId
 * @param {Array<{idx:number, head:string, text:string}>} paras 渲染层从正文 DOM 切的纯文本块
 * @param {{bypass?:boolean, onDelta?:(t:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, aborted?:boolean, aiTrans:object|null, cached:boolean, error:string|null}>}
 */
async function translateItem(itemId, paras, opts = {}) {
  const claim = ++callClaim; // 发起序：引擎起飞前比对，被 abort/更新调用超越即自弃
  const startedAt = Date.now(); // 提取竞态守卫基线（B-1）：渲染层切段的时刻只能以调用入口近似
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, aiTrans: null, cached: false, error: "AI_DISABLED" };

  const item = await db().get(itemId);
  if (!item) return { ok: false, aiTrans: null, cached: false, error: "NOT_FOUND" };

  // item 层命中：已有译文且非强制重译
  if (!opts.bypass && item.aiTrans && Array.isArray(item.aiTrans.paras) && item.aiTrans.paras.length) {
    return { ok: true, aiTrans: item.aiTrans, cached: true, error: null };
  }

  const list = (Array.isArray(paras) ? paras : [])
    .filter((p) => p && typeof p.text === "string" && p.text.trim())
    .slice(0, TRANS_MAX_PARAS);
  if (!list.length) return { ok: false, aiTrans: null, cached: false, error: "NO_PARAS" };

  // 输入限幅：≤TRANS_MAX_CHARS（渲染层已截过，此处兜底）
  const trimmed = [];
  let total = 0;
  for (const p of list) {
    if (total >= TRANS_MAX_CHARS) break;
    trimmed.push({ idx: p.idx, head: p.head, text: p.text.slice(0, TRANS_MAX_CHARS - total) });
    total += trimmed[trimmed.length - 1].text.length;
  }
  const joined = trimmed.map((p) => p.text).join("");

  // CJK 门控（输入窗口内判定）：中文为主不调引擎不耗额度；前 4000 字英文后文中文的混排会放行，属可接受偏差
  if (cjkRatio(joined) > 0.5) {
    logger.info("ai.translate", "中文为主正文，跳过翻译", { itemId, cjkRatio: Math.round(cjkRatio(joined) * 100) / 100 });
    return { ok: false, aiTrans: null, cached: false, error: "NO_NEED" };
  }

  // 纯内容复合键（不含 itemId）：feed 联播场景同文跨源命中，同 DOM 结构下 idx/head 天然对齐
  const cacheId = "ai:trans:v2:" + dbSvc.sha12(joined);
  if (!opts.bypass) {
    const cached = await db().get(cacheId);
    if (cached && cached.result && cached.result.texts) {
      if (await supersededByExtract(itemId, startedAt)) {
        logger.info("ai.translate", "提取已替换正文，缓存产物弃写", { itemId });
        return { ok: false, aiTrans: null, cached: false, error: "CONTENT_CHANGED" };
      }
      const saved = await applyTrans(item, trimmed, cached.result.texts, cached.result.model);
      if (saved && saved.aiTrans) {
        logger.info("ai.translate", "复合缓存命中并回写", { itemId, paras: trimmed.length });
        return { ok: true, aiTrans: saved.aiTrans, cached: true, error: null };
      }
      // 缓存产物与当前段集配不上（理论不可达）：当 miss 走新调用
    }
  }

  const q = quotaCheck("manual", cfg);
  if (!q.ok) {
    logger.warn("ai.translate", "手动池额度耗尽，跳过", { itemId, used: loadQuota().manual });
    return { ok: false, aiTrans: null, cached: false, error: q.error };
  }

  const messages = buildTransMessages(trimmed);
  logger.info("ai.translate", "发起段落翻译", { itemId, engine: cfg.engine, paras: trimmed.length, inputChars: joined.length, bypass: !!opts.bypass, stream: true });

  let produced = false;
  const call = await callEngine(messages, {
    cfg,
    claim,
    stream: true,
    onDelta: (t) => {
      produced = true;
      if (opts.onDelta) opts.onDelta(t);
    },
  });

  if (!call.ok) {
    if (produced) countCall("manual", cfg); // F4：abort/失败但已产出文本均计入额度
    if (call.aborted) {
      logger.info("ai.translate", "调用被中止，产物全弃", { itemId, produced });
      return { ok: false, aborted: true, aiTrans: null, cached: false, error: "ABORTED" };
    }
    logger.warn("ai.translate", "调用失败", { itemId, error: call.error, produced });
    return { ok: false, aiTrans: null, cached: false, error: call.error };
  }

  countCall("manual", cfg);
  const parsed = parseTransOutput(call.content);
  logger.info("ai.translate", "解析译文", { itemId, rawChars: call.content.length, paras: trimmed.length, parsed: parsed.count });
  if (!parsed.count) {
    return { ok: false, aiTrans: null, cached: false, error: "BAD_TRANS_OUTPUT" };
  }
  if (await supersededByExtract(itemId, startedAt)) {
    // B-1：翻译期间全文提取落库，正文已换——产物弃写（额度已计，同 abort 已产出计额口径）
    logger.info("ai.translate", "提取已替换正文，产物弃写", { itemId, paras: trimmed.length });
    return { ok: false, aiTrans: null, cached: false, error: "CONTENT_CHANGED" };
  }
  await cachePut(cacheId, { texts: parsed.texts, model: modelLabelFor(cfg) });
  const saved = await applyTrans(item, trimmed, parsed.texts, modelLabelFor(cfg));
  await cacheTrim();
  logger.info("ai.translate", "回写完成", { itemId, wrote: !!(saved && saved.aiTrans) });
  return { ok: true, aiTrans: saved && saved.aiTrans ? saved.aiTrans : null, cached: false, error: null };
}

// ---------------------------------------------------------------------------
// AI 目录（v1.4，PLAN-AI-TOC）：渲染层全量段落入，AI 只划分章节起标题；
// 锚定 {idx+head} 同 aiTrans 口径，head 由输入侧补全（AI/缓存不回写，防编造）
// ---------------------------------------------------------------------------

const TOC_MAX_PARAS = 200; // 单次目录段上限（全文枚举口径，非翻译的 10 段）
const TOC_PARA_CHARS = 200; // 每段送入截断
const TOC_MAX_CHARS = 10000; // 单次输入总字符上限，超出截断（渲染层按 sections 末条 idx 现算覆盖率）

function buildTocMessages(paras) {
  const system =
    "你是资深编辑。把栅栏内逐段编号的长文划分为 3~10 个连续章节，为每章拟一个客观的中文标题；章内若有明显可区分的子话题，可为该章再分 1~4 个子章并各自拟标题。\n" +
    "输入中部分行首的 #/##/### 等前缀是原文的标题标记，请参考其层级归属。\n" +
    "输出格式：每章或子章一行，以 [[起始段编号|层级]] 开头，层级 1=章、2=子章，子章行紧跟其章行，如 [[3|1]]章节标题、[[5|2]]子章标题；文章无明显子结构时全部用层级 1。\n" +
    "标题不超过 24 字、不带序号、表情或 # 前缀；只输出这些行，不要解释、不要复述正文。";
  // 结构标记（PLAN-TOC-LEVEL）：h1-h6 段行首加 markdown # 前缀（数量=标题级），# 不计入限幅/缓存键 joined
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

/** 解析 [[idx|level]]标题 行协议（PLAN-TOC-LEVEL：level 缺省 1，数字越界 clamp 1-3；标题剥 # 前缀防输入标记渗入）；
 *  同 idx 保首条去重 + 升序（防 AI 重复输出致条目重复/覆盖率失真） */
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

/** 锚点过滤：head 从当前输入 paras 按 idx 查表补全（非数组下标取），越界/缺 head 条目丢弃——
 *  与渲染层 jumpTo 的严格 head 比对同口径，坏锚点进不了 aiToc */
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
      level: Number.isFinite(lv) && lv >= 1 && lv <= 3 ? Math.round(lv) : 1, // PLAN-TOC-LEVEL：非法/缺失回退 1
    });
  }
  return out;
}

/** 目录回写 item.aiToc（H4 get 复验同 applyTrans；纯数据产物，无 HTML） */
async function applyToc(itemDoc, paras, sections, model) {
  const fresh = await db().get(itemDoc._id);
  if (!fresh) return null;
  const out = tocAnchorSections(paras, sections);
  if (!out.length) return fresh;
  fresh.aiToc = { sections: out, at: Date.now(), model };
  const saved = await dbSvc.putRetry(fresh);
  return saved || fresh;
}

/**
 * AI 目录生成（v1.4，PLAN-AI-TOC · 手动池；PLAN-TOC-LEVEL 两级层级协议）。
 * @param {string} itemId
 * @param {Array<{idx:number, head:string, text:string, tag?:string}>} paras 渲染层全量段落（collectParasAll 产物；tag=h1-h6 供输入侧结构标记）
 * @param {{bypass?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, aborted?:boolean, aiToc:object|null, cached:boolean, error:string|null}>}
 */
async function generateToc(itemId, paras, opts = {}) {
  const claim = ++callClaim; // 发起序：单飞纪律（渲染层发起前 abort；被超越即自弃）
  const startedAt = Date.now(); // 提取竞态守卫基线（B-1）
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, aiToc: null, cached: false, error: "AI_DISABLED" };

  const item = await db().get(itemId);
  if (!item) return { ok: false, aiToc: null, cached: false, error: "NOT_FOUND" };

  // item 层命中：已有目录且非强制重生成
  if (!opts.bypass && item.aiToc && Array.isArray(item.aiToc.sections) && item.aiToc.sections.length) {
    return { ok: true, aiToc: item.aiToc, cached: true, error: null };
  }

  const list = (Array.isArray(paras) ? paras : [])
    .filter((p) => p && Number.isInteger(p.idx) && typeof p.head === "string" && typeof p.text === "string" && p.text.trim())
    .slice(0, TOC_MAX_PARAS);
  if (!list.length) return { ok: false, aiToc: null, cached: false, error: "NO_PARAS" };

  // 输入限幅：每段 ≤TOC_PARA_CHARS、总量 ≤TOC_MAX_CHARS（渲染层已截过，此处兜底）；
  // tag 必须随重建对象透传（PLAN-TOC-LEVEL 审核必改-1：漏传则 buildTocMessages 的 # 标记静默失效）
  const trimmed = [];
  let total = 0;
  for (const p of list) {
    if (total >= TOC_MAX_CHARS) break;
    trimmed.push({ idx: p.idx, head: p.head, text: p.text.slice(0, Math.min(TOC_PARA_CHARS, TOC_MAX_CHARS - total)), tag: p.tag });
    total += trimmed[trimmed.length - 1].text.length;
  }
  const joined = trimmed.map((p) => p.text).join("");

  // 纯内容键（不含 itemId/contentHash）：feed 联播同文跨源命中；全文提取替换正文不更新
  // contentHash（extract 落库只删 aiTrans），挂 contentHash 会命中旧目录写入死数据（送审确认）。
  // v2（PLAN-TOC-LEVEL）：协议升级两级层级，v1 产物无 level 命中即平铺，键版本隔离
  const cacheId = "ai:toc:v2:" + dbSvc.sha12(joined);
  if (!opts.bypass) {
    const cached = await db().get(cacheId);
    if (cached && cached.result && Array.isArray(cached.result.sections) && cached.result.sections.length) {
      if (await supersededByExtract(itemId, startedAt)) {
        logger.info("ai.toc", "提取已替换正文，缓存产物弃写", { itemId });
        return { ok: false, aiToc: null, cached: false, error: "CONTENT_CHANGED" };
      }
      const saved = await applyToc(item, trimmed, cached.result.sections, cached.result.model);
      if (saved && saved.aiToc) {
        logger.info("ai.toc", "复合缓存命中并回写", { itemId, sections: saved.aiToc.sections.length });
        return { ok: true, aiToc: saved.aiToc, cached: true, error: null };
      }
      // 缓存锚点与当前段集配不上：当 miss 走新调用
    }
  }

  const q = quotaCheck("manual", cfg);
  if (!q.ok) {
    logger.warn("ai.toc", "手动池额度耗尽，跳过", { itemId, used: loadQuota().manual });
    return { ok: false, aiToc: null, cached: false, error: q.error };
  }

  const messages = buildTocMessages(trimmed);
  logger.info("ai.toc", "发起目录生成", { itemId, engine: cfg.engine, paras: trimmed.length, inputChars: joined.length, bypass: !!opts.bypass });

  let produced = false;
  const call = await callEngine(messages, {
    cfg,
    claim,
    stream: true, // 照翻译：流式 abort/超时语义验证充分
    onDelta: () => { produced = true; }, // F4 计额口径：引擎吐过字，失败/abort 也计
  });

  if (!call.ok) {
    if (produced) countCall("manual", cfg);
    if (call.aborted) {
      logger.info("ai.toc", "调用被中止，产物全弃", { itemId, produced });
      return { ok: false, aborted: true, aiToc: null, cached: false, error: "ABORTED" };
    }
    logger.warn("ai.toc", "调用失败", { itemId, error: call.error, produced });
    return { ok: false, aiToc: null, cached: false, error: call.error };
  }

  countCall("manual", cfg);
  const parsed = parseTocOutput(call.content);
  logger.info("ai.toc", "解析目录", { itemId, rawChars: call.content.length, sections: parsed.count });
  if (!parsed.count) {
    return { ok: false, aiToc: null, cached: false, error: "BAD_TOC_OUTPUT" };
  }
  const anchored = tocAnchorSections(trimmed, parsed.sections);
  if (!anchored.length) {
    return { ok: false, aiToc: null, cached: false, error: "BAD_TOC_OUTPUT" }; // AI 输出的 idx 全部越界，锚点不可用
  }
  if (await supersededByExtract(itemId, startedAt)) {
    // B-1：生成期间全文提取落库，正文已换——产物弃写（额度已计，同 abort 已产出计额口径）
    logger.info("ai.toc", "提取已替换正文，产物弃写", { itemId, sections: parsed.count });
    return { ok: false, aiToc: null, cached: false, error: "CONTENT_CHANGED" };
  }
  // 缓存载荷不含 head：命中路径由 applyToc 从当前输入段落重补（跨源同文 DOM 差异免疫）；level 属产物语义随缓存存
  await cachePut(cacheId, { sections: anchored.map(({ title, idx, level }) => ({ title, idx, level })), model: modelLabelFor(cfg) });
  const saved = await applyToc(item, trimmed, parsed.sections, modelLabelFor(cfg));
  await cacheTrim();
  logger.info("ai.toc", "回写完成", { itemId, wrote: !!(saved && saved.aiToc) });
  return { ok: true, aiToc: saved && saved.aiToc ? saved.aiToc : null, cached: false, error: null };
}

// ---------------------------------------------------------------------------
// 状态查询（设置页）
// ---------------------------------------------------------------------------

async function getStatus() {
  const cfg = getConfig();
  const u = ut();
  const ready = !!(u && typeof u.ai === "function");
  let models = [];
  if (ready) {
    try {
      models = await u.allAiModels();
    } catch (_) {
      models = [];
    }
  }
  const q = loadQuota();
  return {
    ready,
    engine: cfg.engine,
    models: Array.isArray(models) ? models : [],
    byokReady: cfg.engine !== "byok" || (!!getByokKey() && !!cfg.byokBaseUrl),
    quota: { manual: q.manual || 0, manualMax: QUOTA_MANUAL_MAX, bg: q.bg || 0, bgMax: QUOTA_BG_MAX },
    exempt: cfg.engine === "byok",
  };
}

module.exports = {
  enrich,
  batchEnrich,
  translateItem,
  generateToc,
  abort,
  getStatus,
  getConfig,
  saveConfig,
  setByokKey,
  hasByokKey,
  __test: { parseEnrichOutput, byokEndpoint, firstSentence, pickDisplayTitle, applyAi, markError, loadQuota, countCall, quotaCheck, cachePut, buildEnrichMessages, buildBatchMessages, parseTransOutput, applyTrans, cjkRatio, buildTransMessages, DEFAULT_CONFIG, BATCH_MAX, TRUNC_CHARS, setEngineTimeout: (ms) => (engineTimeoutMs = ms), buildTocMessages, parseTocOutput, applyToc, tocAnchorSections, TOC_MAX_PARAS, TOC_PARA_CHARS, TOC_MAX_CHARS },
};
