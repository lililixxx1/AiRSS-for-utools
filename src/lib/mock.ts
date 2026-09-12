/**
 * mock.ts — 浏览器 dev 环境的 airss/utools 同形兜底
 *
 * 用途：vite dev（纯浏览器，无 uTools 宿主）下界面可跑可调。
 * 数据存 localStorage；不实现真实网络（discover 返回固定候选）。
 * 在 uTools 内运行时本模块不会被使用（渲染层 stores 直接调 window.airss）。
 */
import type { Feed, Item } from "../types";

const LS_KEY = "airss-mock-db";

interface MockDb {
  feeds: any[];
  items: any[];
  fulls: Record<string, string>;
  fullxs: Record<string, string>; // 提取版全文（itemfullx 同形，PLAN-V1.3 A）
}

function load(): MockDb {
  try {
    const db = JSON.parse(localStorage.getItem(LS_KEY) || "") || seed();
    if (!db.fullxs) db.fullxs = {}; // 旧 localStorage 种子迁移
    return db;
  } catch {
    return seed();
  }
}
function save(db: MockDb) {
  localStorage.setItem(LS_KEY, JSON.stringify(db));
}
function seed(): MockDb {
  const now = Date.now();
  const feeds: any[] = [
    { _id: "feed:mock-ruanyifeng", url: "https://www.ruanyifeng.com/blog/atom.xml", title: "阮一峰的网络日志", titleEn: "Ruan Yifeng's Blog", category: "技术", siteUrl: "https://www.ruanyifeng.com", desc: "", etag: "", lastModified: "", lastFetchedAt: now, refreshMin: 0, unreadCount: 1, lastError: "", notify: true, createdAt: now },
    { _id: "feed:mock-sspai", url: "https://sspai.com/feed", title: "少数派", titleEn: "sspai.com", category: "技术", siteUrl: "https://sspai.com", desc: "", etag: "", lastModified: "", lastFetchedAt: now, refreshMin: 0, unreadCount: 1, lastError: "", notify: true, createdAt: now },
  ];
  const items: any[] = [
    { _id: "item:feed:mock-ruanyifeng:a1", feedKey: "feed:mock-ruanyifeng", guid: "a1", link: "https://www.ruanyifeng.com/blog/2026/09/weekly-issue-411.html", title: "科技爱好者周刊（第 411 期）：OpenClaw 2.0 与开源Agent生态", titleDisplay: "", author: "阮一峰", pubTs: now - 18 * 3600e3, fetchedAt: now, contentHash: "a1", summaryText: "这里记录每周值得分享的科技内容，周五发布。本期刊第 411 期，介绍 OpenClaw 2.0 发布带来的开源 Agent 生态变化，以及相关讨论……", cover: null, read: false, starred: false, aiStatus: "none" },
    { _id: "item:feed:mock-ruanyifeng:a2", feedKey: "feed:mock-ruanyifeng", guid: "a2", link: "https://www.ruanyifeng.com/blog/2026/08/weekly-issue-410.html", title: "科技爱好者周刊（第 410 期）", titleDisplay: "", author: "阮一峰", pubTs: now - 3 * 86400e3, fetchedAt: now, contentHash: "a2", summaryText: "周五发布，记录一周值得分享的科技内容……", cover: null, read: true, starred: true, aiStatus: "none" },
    { _id: "item:feed:mock-sspai:b1", feedKey: "feed:mock-sspai", guid: "b1", link: "https://sspai.com/post/99999", title: "效率工具指南：如何用自动化脚本管理你的订阅", titleDisplay: "", author: "少数派", pubTs: now - 8 * 3600e3, fetchedAt: now, contentHash: "b1", summaryText: "信息过载时代，订阅源管理成为新的效率课题。本文介绍几种自动化思路……", cover: null, read: false, starred: false, aiStatus: "none" },
  ];
  const fulls: Record<string, string> = {
    "itemfull:item:feed:mock-ruanyifeng:a1":
      "<p>这里记录每周值得分享的科技内容，周五发布。</p><p>本期话题：<strong>OpenClaw 2.0</strong> 正式发布，开源 Agent 生态迎来新的分水岭。</p><blockquote>开源不是许可证的选择，而是治理方式的选择。</blockquote><p>更多细节与讨论，见正文原文。</p>",
  };
  const db = { feeds, items, fulls, fullxs: {} as Record<string, string> };
  save(db);
  return db;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installMock() {
  const db = load();

  // mock AI 配置（内存态即可；真实环境存 preload 侧 dbStorage）
  let mockAiCfg: { enabled: boolean; engine: "utools" | "byok"; model: string; modelLabel: string; byokBaseUrl: string; byokModel: string; byokAllowHttp: boolean } = {
    enabled: false,
    engine: "utools",
    model: "",
    modelLabel: "",
    byokBaseUrl: "",
    byokModel: "",
    byokAllowHttp: false,
  };

  window.airss = {
    db: {
      async getFeeds() {
        return load().feeds;
      },
      async saveFeed(doc: any) {
        const d = load();
        const i = d.feeds.findIndex((x) => x._id === doc._id);
        if (i >= 0) d.feeds[i] = doc;
        else d.feeds.push(doc);
        save(d);
        return doc;
      },
      async snapshotItems() {
        return load().items;
      },
      async itemsOfFeed(feedId: string) {
        return load().items.filter((x) => x.feedKey === feedId);
      },
      async ingestFeed() {
        return { ok: true, newCount: 0, updatedCount: 0, error: null };
      },
      async setRead(id: string, read: boolean) {
        const d = load();
        const it: any = d.items.find((x) => x._id === id);
        if (it) it.read = read;
        save(d);
        return it;
      },
      async setStarred(id: string, starred: boolean) {
        const d = load();
        const it: any = d.items.find((x) => x._id === id);
        if (it) it.starred = starred;
        save(d);
        return it;
      },
      async markManyRead(ids: string[]) {
        const d = load();
        let n = 0;
        d.items.forEach((x: any) => {
          if (ids.includes(x._id) && !x.read) {
            x.read = true;
            n += 1;
          }
        });
        save(d);
        return n;
      },
      async recalcUnread(feed: any) {
        const d = load();
        return d.items.filter((x) => x.feedKey === feed._id && !x.read).length;
      },
      async getItemFull(itemId: string) {
        return load().fulls["itemfull:" + itemId] || null;
      },
      async retentionClean() {
        return 0;
      },
      async deleteFeedCascade(feed: any) {
        const d = load();
        d.items = d.items.filter((x: any) => x.feedKey !== feed._id);
        d.feeds = d.feeds.filter((x: any) => x._id !== feed._id);
        save(d);
        return 0;
      },
      async clearAll() {
        save({ feeds: [], items: [], fulls: {}, fullxs: {} });
        return 0;
      },
      async searchContent(query: string) {
        // 浏览器 dev 同形简化：无预算截断/分片让出（真机行为见 preload/services/db.js）；
        // 双前缀 + Set 去重与 preload 同口径（PLAN-V1.3 A）
        const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) return { ids: [], scanned: 0, truncated: false, ms: 0 };
        const t0 = Date.now();
        const d = load();
        const ids: string[] = [];
        const seen = new Set<string>();
        let scanned = 0;
        const scan = (table: Record<string, string>, prefix: string) => {
          for (const k of Object.keys(table)) {
            scanned += 1;
            const itemId = k.slice(prefix.length);
            if (seen.has(itemId)) continue;
            const text = String(table[k] || "").toLowerCase();
            if (terms.every((t) => text.includes(t))) {
              seen.add(itemId);
              ids.push(itemId);
            }
          }
        };
        scan(d.fulls, "itemfull:");
        scan(d.fullxs, "itemfullx:");
        return { ids, scanned, truncated: false, ms: Date.now() - t0 };
      },
    },
    feed: {
      async discover(url: string) {
        await sleep(600);
        return { found: true, candidates: [{ url, title: "Mock 源（浏览器模式）", itemCount: 12 }], tried: [{ path: "(直连)", result: "mock" }] };
      },
      async fetch() {
        return { status: "ok", meta: { title: "", siteUrl: "", desc: "" }, items: [] };
      },
      normalizeUrl(u: string) {
        return /^https?:\/\//i.test(u) ? u : "https://" + u;
      },
    },
    article: {
      readingMinutes(t: string) { return Math.max(1, Math.round((t || "").length / 400)); },
      // 全文提取 mock（PLAN-V1.3 A）：状态机与 preload 同形——off/hit/rich/fetched/NOT_FOUND；
      // fetch 路径模拟 600ms 网络延迟，产出的提取版含相对→绝对图（验渲染层替换与懒加载重跑），
      // 落库连带清 item.aiTrans（与 preload T-09 同族口径一致）
      async ensureFull(itemId: string): Promise<{ status: "off" | "hit" | "rich" | "fetched" | "error"; content: string | null; error: string | null }> {
        const d = load();
        const it: any = d.items.find((x) => x._id === itemId);
        const feed: any = it ? d.feeds.find((f) => f._id === it.feedKey) : null;
        if (!it || !feed) return { status: "error", content: null, error: "NOT_FOUND" };
        if (!feed.fullText) return { status: "off", content: null, error: null };
        const key = "itemfullx:" + itemId;
        if (d.fullxs[key]) return { status: "hit", content: d.fullxs[key], error: null };
        const own = d.fulls["itemfull:" + itemId] || "";
        if (own.replace(/<[^>]+>/g, "").length >= 600) return { status: "rich", content: null, error: null };
        if (!it.link) return { status: "error", content: null, error: "NO_LINK" };
        await sleep(600);
        const paras = Array.from({ length: 10 }, (_, i) => `<p>【提取版第 ${i + 1} 段】这是浏览器 mock 生成的全文内容，围绕「${it.title}」展开。真实环境由 preload 抓取原文页并经 Readability 提取与消毒后回传；本段文本仅用于验证正文替换、二次打开缓存命中与译文失效清理等交互。</p>`).join("");
        const base = new URL(it.link);
        const content = `<p><img src="${new URL("/mock/cover.png", base).toString()}" alt="mock 提取版头图"></p>${paras}`;
        d.fullxs[key] = content;
        if (it.aiTrans) delete it.aiTrans; // 译文对替换前正文生成，连带失效（同 preload）
        save(d);
        return { status: "fetched", content, error: null };
      },
    },
    opml: {
      parse() {
        return [];
      },
      build() {
        return "";
      },
    },
    scheduler: {
      async refreshOne() {
        await sleep(400);
        return { ok: true, status: "ok", newCount: 0, error: null };
      },
      async refreshFeeds(_feeds: any[], hooks: any) {
        await sleep(600);
        if (hooks?.onAllDone) hooks.onAllDone({ total: 0, done: 0, ok: 0, failed: 0, skipped: 0, newItems: 0 });
        return { total: 0, done: 0, ok: 0, failed: 0, skipped: 0, newItems: 0 };
      },
      abort() {},
    },
    ai: {
      // 浏览器 dev 的模拟层：按真实管线节流吐字，供 UI 调流式/失败态；uTools 内走 preload/services/ai.js
      async enrich(itemId: string, opts: { bypass?: boolean; onDelta?: (t: string) => void } = {}) {
        const d = load();
        const it: any = d.items.find((x) => x._id === itemId);
        if (!it) return { ok: false, ai: null, cached: false, error: "NOT_FOUND" };
        if (!opts.bypass && it.aiStatus === "done" && it.ai?.aiSource === "enrich") {
          window.airss.log.info("ai.enrich", "item 层命中（已有 enrich 产物）", { itemId });
          return { ok: true, ai: it.ai, cached: true, error: null };
        }
        window.airss.log.info("ai.enrich", "发起合并调用（mock 流式）", { itemId, engine: "mock", inputChars: (load().fulls["itemfull:" + itemId] || "").length, stream: true });
        const isEn = /^[\x00-\x7F\s]+$/.test(it.title || "");
        const zh = isEn ? "模拟中文标题：" + it.title.slice(0, 18) : "";
        const norm = "模拟AI优化标题";
        const meta = `【titleZh】${zh}【titleNorm】${norm}【tags】科技,工具\n`;
        const body = "这是浏览器开发模式的模拟 AI 摘要，用于调通流式渲染与交互；真实环境由 uTools 宿主的 utools.ai 生成。模拟内容与文章无关，仅作占位。";
        const full = meta + body;
        for (let i = 0; i < full.length; i += 6) {
          if (opts.onDelta) opts.onDelta(full.slice(i, i + 6));
          await sleep(24);
        }
        const ai = { summary: body, tags: ["科技", "工具"], titleZh: zh, titleNorm: norm, aiSource: "enrich" as const };
        it.ai = ai;
        it.aiStatus = "done";
        const disp = ai.titleNorm || ai.titleZh;
        if (disp && disp !== it.title) it.titleDisplay = disp;
        save(d);
        window.airss.log.info("ai.enrich", "解析产物并回写（mock）", { itemId, summaryChars: body.length, tags: ai.tags.join(",") });
        return { ok: true, ai, cached: false, error: null };
      },
      async batchEnrich() {
        return { ok: true, updated: [], error: null };
      },
      // AI 段落翻译 mock：假流式按 [[n]] 标记吐译文，回写 item.aiTrans（浏览器 dev 同形）
      async translateItem(itemId: string, paras: { idx: number; head: string; text: string }[], opts: { bypass?: boolean; onDelta?: (t: string) => void } = {}) {
        const d = load();
        const it: any = d.items.find((x) => x._id === itemId);
        if (!it) return { ok: false, aiTrans: null, cached: false, error: "NOT_FOUND" };
        if (!opts.bypass && it.aiTrans) {
          return { ok: true, aiTrans: it.aiTrans, cached: true, error: null };
        }
        const joined = paras.map((p) => p.text).join("");
        const cjk = (joined.match(/[\u4e00-\u9fff]/g) || []).length;
        if (paras.length && cjk / Math.max(1, joined.length) > 0.5) {
          return { ok: false, aiTrans: null, cached: false, error: "NO_NEED" };
        }
        window.airss.log.info("ai.translate", "发起段落翻译（mock 流式）", { itemId, paras: paras.length });
        const out = paras.map((p) => `[[${p.idx}]]【mock 译文】${p.text.slice(0, 30)}`).join("\n");
        for (let i = 0; i < out.length; i += 8) {
          if (opts.onDelta) opts.onDelta(out.slice(i, i + 8));
          await sleep(20);
        }
        const aiTrans = { paras: paras.map((p) => ({ idx: p.idx, head: p.head, text: "【mock 译文】" + p.text.slice(0, 30) })), at: Date.now(), model: "mock" };
        it.aiTrans = aiTrans;
        save(d);
        window.airss.log.info("ai.translate", "译文回写（mock）", { itemId, paras: aiTrans.paras.length });
        return { ok: true, aiTrans, cached: false, error: null };
      },
      /** AI 目录（v1.4；PLAN-TOC-LEVEL 两级）：按段落数均分 3~5 节 mock 目录，第 2 章后插一子章演示层级 */
      async generateToc(itemId: string, paras: { idx: number; head: string; text: string; tag?: string }[], opts: { bypass?: boolean } = {}) {
        const d = load();
        const it: any = d.items.find((x) => x._id === itemId);
        if (!it) return { ok: false, aiToc: null, cached: false, error: "NOT_FOUND" };
        if (!opts.bypass && it.aiToc) return { ok: true, aiToc: it.aiToc, cached: true, error: null };
        if (!paras.length) return { ok: false, aiToc: null, cached: false, error: "NO_PARAS" };
        await sleep(600);
        const n = Math.min(5, Math.max(3, Math.ceil(paras.length / 8)));
        const step = Math.max(1, Math.floor(paras.length / n));
        const sections: any[] = [];
        for (let i = 0; i < paras.length && sections.length < n; i += step) {
          sections.push({ title: `第${sections.length + 1}部分 · mock 目录`, idx: paras[i].idx, head: paras[i].head, level: 1 });
        }
        // 子章候选 idx 必须未被任何章占用（paras 3~5 段时 step=1 三章占连续 idx，「下一段」会撞 kind+idx key；撞则不插。
        // 段数过少（如单段）时上限循环只产 1 章，锚点退守首章防 sections[1] 越界——2026-09-11 审核必改）
        const used = new Set(sections.map((s) => s.idx));
        const anchor = sections[1] ?? sections[0];
        const sub = anchor && paras.find((p) => p.idx > anchor.idx && !used.has(p.idx));
        if (sub) sections.splice(Math.min(2, sections.length), 0, { title: `子节 · mock`, idx: sub.idx, head: sub.head, level: 2 });
        const aiToc = { sections, at: Date.now(), model: "mock" };
        it.aiToc = aiToc;
        save(d);
        window.airss.log.info("ai.toc", "目录回写（mock）", { itemId, sections: sections.length });
        return { ok: true, aiToc, cached: false, error: null };
      },
      abort() {},
      async getStatus() {
        return { ready: false, engine: mockAiCfg.engine, models: [], byokReady: true, quota: { manual: 0, manualMax: 120, bg: 0, bgMax: 30 }, exempt: mockAiCfg.engine === "byok" };
      },
      getConfig() {
        return { ...mockAiCfg };
      },
      saveConfig(patch: any) {
        mockAiCfg = { ...mockAiCfg, ...patch };
        return { ...mockAiCfg };
      },
      setByokKey() {},
      hasByokKey() {
        return false;
      },
    },
    log: (() => {
      // 浏览器 dev：内存环形缓冲 + console 镜像（真实环境走 preload/services/logger.js）
      const buf: { t: number; level: string; tag: string; msg: string; data?: string }[] = [];
      const pad = (n: number) => String(n).padStart(2, "0");
      const push = (level: string) => (tag: string, msg: string, data?: unknown) => {
        buf.push({ t: Date.now(), level, tag, msg, data: data === undefined ? undefined : JSON.stringify(data) });
        if (buf.length > 500) buf.splice(0, buf.length - 500);
        console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[airss][${tag}] ${msg}`, data ?? "");
      };
      return {
        debug: push("debug"),
        info: push("info"),
        warn: push("warn"),
        error: push("error"),
        getLogs: () => buf.slice(),
        clear: () => buf.splice(0),
        dumpText: () =>
          buf
            .map((e) => {
              const d = new Date(e.t);
              const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
              return `${ts} ${e.level.toUpperCase().padEnd(5)} ${e.tag} | ${e.msg}${e.data ? ` | ${e.data}` : ""}`;
            })
            .join("\n"),
      };
    })(),

    sys: {
      readTextFile() {
        return "";
      },
      writeTextFile() {},
      openExternal(url: string) {
        window.open(url, "_blank");
      },
      async createFeed(data: any) {
        const d = load();
        const doc = { _id: "feed:mock-" + Date.now(), url: data.url, title: data.title || data.url, titleEn: "", category: data.category || "默认", siteUrl: data.siteUrl || "", desc: data.desc || "", ...(data.fullText ? { fullText: true } : {}), etag: "", lastModified: "", lastFetchedAt: Date.now(), refreshMin: data.refreshMin || 0, unreadCount: 0, lastError: "", notify: true, createdAt: Date.now() };
        d.feeds.push(doc);
        save(d);
        return doc;
      },
    },
  };

  // utools 宿主 API 的最小 mock（设置持久化走 localStorage）
  const lsKey = (k: string) => "airss-mock-kv:" + k;
  const kv: Record<string, any> = {};
  window.utools = {
    onPluginEnter(cb: any) {
      (window as any).__mockEnter = cb;
    },
    onPluginOut() {},
    onMainPush() {},
    onPluginDetach() {},
    onDbPull() {},
    setSubInput() {},
    removeSubInput() {},
    subInputFocus() {},
    showNotification(body: string) {
      console.log("[mock notification]", body);
    },
    copyText(text: string) {
      navigator.clipboard?.writeText(text);
    },
    shellOpenExternal(url: string) {
      window.open(url, "_blank");
    },
    showOpenDialog() {
      return null;
    },
    showSaveDialog() {
      return null;
    },
    isDarkColors() {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    },
    getAppVersion() {
      return "browser-mock";
    },
    redirect() {},
    outPlugin() {},
    db: {},
    dbStorage: {
      getItem(k: string) {
        if (k in kv) return kv[k];
        try {
          return JSON.parse(localStorage.getItem(lsKey(k)) || "null");
        } catch {
          return null;
        }
      },
      setItem(k: string, v: any) {
        kv[k] = v;
        localStorage.setItem(lsKey(k), JSON.stringify(v));
      },
      removeItem(k: string) {
        delete kv[k];
        localStorage.removeItem(lsKey(k));
      },
    },
  } as any;

  // 浏览器模式下自动触发一次进入
  setTimeout(() => {
    const cb = (window as any).__mockEnter;
    if (cb) cb({ code: "airss", type: "text", payload: "" });
  }, 50);

  // 状态直达（验收截图用）：?view=reader|settings|addfeed
  const view = new URLSearchParams(location.search).get("view");
  if (view) {
    setTimeout(() => window.dispatchEvent(new CustomEvent("airss-mock-view", { detail: view })), 400);
  }

  window.airss.log.info("boot", "mock 层已安装（浏览器 dev）");
}

export function resetMock() {
  localStorage.removeItem(LS_KEY);
  location.reload();
}
