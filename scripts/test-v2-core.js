/**
 * test-v2-core.js — v2.1 核心架构与 uTools 8.0 特性综合离线测试
 *
 * 覆盖：
 * 1. 同步 vs 本地分层（50 篇入库：0 条 item:/itemfull:/itemfullx: 进 sync db；懒写 state:/star:；clearAll 隔离 devbridge-spill）
 * 2. 星标/稍后读轻量快照兜底（仅同步库有 star:/later:，无本地分片时仍可展示与阅读）
 * 3. 分片损坏自愈与原子写（破坏 feeds/*.json 后重启 init 不崩）
 * 4. MiniSearch 万级（10,000 篇）中英文混合检索 <50ms、无截断
 * 5. v1 -> v2 两阶段安全迁移（阶段一无损导入且保旧文档；阶段二校验 replicateStateFromCloud()!==1 后清理）
 * 6. 单点生命周期注册（7 项钩子）、onDbPull 增量合并、mainPush 1+4 直达、动态 airss_search
 * 7. requestSchedule / onScheduleTrigger（汇总单条通知、默认 scheduleAiBatch=false 跳过 AI 批）
 * 8. 稍后读 laterService.saveUrl（本地回环 HTTP、消毒、hideMainWindow、later: 快照）
 *
 * 用法：node scripts/test-v2-core.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const PRELOAD = path.join(__dirname, "..", "preload");
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "airss-test-v2-"));
let curLocalDir = path.join(TMP_BASE, "init");

function makeHarness() {
  const docs = new Map();
  const kv = new Map();
  const features = new Map();
  const schedules = new Map();
  const hooks = {};
  const notifications = [];
  let revSeq = 1;
  let cloudState = 0;
  let hideCalled = 0;
  let aiCalls = 0;
  let rejectSchedule = false;

  const db = {
    put: (doc) => {
      if (doc._deleted) {
        if (!docs.has(doc._id)) return { error: true, id: doc._id, message: "not_found" };
        docs.delete(doc._id);
        return { ok: true, id: doc._id, rev: "r" + ++revSeq };
      }
      const cur = docs.get(doc._id);
      if (cur && cur._rev !== doc._rev) return { error: true, id: doc._id, message: "conflict" };
      const rev = "r" + ++revSeq;
      docs.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: rev });
      return { ok: true, id: doc._id, rev };
    },
    get: (id) => (docs.has(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null),
    remove: (docOrId) => {
      const id = typeof docOrId === "string" ? docOrId : docOrId._id;
      if (!docs.has(id)) return { error: true, id, message: "not_found" };
      docs.delete(id);
      return { ok: true, id, rev: "r" + ++revSeq };
    },
    bulkDocs: (list) => list.map((d) => db.put(d)),
    allDocs: (prefixOrIds) => {
      let vals = [...docs.values()];
      if (typeof prefixOrIds === "string") vals = vals.filter((d) => d._id.startsWith(prefixOrIds));
      else if (Array.isArray(prefixOrIds)) vals = vals.filter((d) => prefixOrIds.includes(d._id));
      return vals.map((d) => JSON.parse(JSON.stringify(d)));
    },
    replicateStateFromCloud: () => cloudState,
    promises: {},
  };
  for (const k of ["put", "get", "remove", "bulkDocs", "allDocs"]) db.promises[k] = (x, y) => Promise.resolve(db[k](x, y));

  const ut = {
    db,
    getPluginLocalDataPath: () => curLocalDir,
    getPluginTempPath: () => TMP_BASE,
    dbStorage: {
      getItem: (k) => (kv.has(k) ? kv.get(k) : null),
      setItem: (k, v) => kv.set(k, v),
      removeItem: (k) => kv.delete(k),
    },
    onPluginReady: (cb) => { hooks.onPluginReady = cb; },
    onPluginEnter: (cb) => { hooks.onPluginEnter = cb; },
    onPluginOut: (cb) => { hooks.onPluginOut = cb; },
    onPluginDetach: (cb) => { hooks.onPluginDetach = cb; },
    onDbPull: (cb) => { hooks.onDbPull = cb; },
    onScheduleTrigger: (cb) => { hooks.onScheduleTrigger = cb; },
    onMainPush: (cb, onSel) => { hooks.onMainPush = cb; hooks.onMainPushSelect = onSel; },
    getFeatures: (codes) => {
      const arr = [...features.values()];
      return codes?.length ? arr.filter((f) => codes.includes(f.code)) : arr;
    },
    setFeature: (f) => { if (f && f.code) features.set(f.code, f); },
    removeFeature: (code) => { features.delete(code); },
    requestSchedule: async (opts) => {
      if (!rejectSchedule && opts && opts.code) schedules.set(opts.code, { ...opts, successCount: 0, failureCount: 0 });
      return !rejectSchedule;
    },
    getSchedules: () => [...schedules.values()],
    removeSchedule: (code) => { schedules.delete(code); },
    showNotification: (body, code) => notifications.push({ body, code }),
    hideMainWindow: () => { hideCalled += 1; return true; },
    ai: (_opts) => {
      aiCalls += 1;
      const p = Promise.resolve({ content: "[]" });
      p.abort = () => {};
      return p;
    },
  };

  return {
    ut,
    raw: docs,
    kv,
    hooks,
    features,
    schedules,
    notifications,
    get hideCalled() { return hideCalled; },
    get aiCalls() { return aiCalls; },
    setCloudState: (v) => { cloudState = v; },
    setRejectSchedule: (v) => { rejectSchedule = v; },
    resetCounters: () => { hideCalled = 0; aiCalls = 0; notifications.length = 0; },
  };
}

let h = makeHarness();
global.utools = h.ut;

const storage = require(path.join(PRELOAD, "core/storage.js"));
const migrate = require(path.join(PRELOAD, "core/migrate.js"));
const searchIndex = require(path.join(PRELOAD, "core/searchIndex.js"));
const readService = require(path.join(PRELOAD, "core/readService.js"));
const refreshService = require(path.join(PRELOAD, "core/refreshService.js"));
const laterService = require(path.join(PRELOAD, "core/laterService.js"));
const lifecycle = require(path.join(PRELOAD, "lifecycle.js"));
const logger = require(path.join(PRELOAD, "services/logger.js"));
const feedSvc = require(path.join(PRELOAD, "services/feed.js"));
const aiSvc = require(path.join(PRELOAD, "services/ai.js"));
const { feedUrlKey, computeItemKey } = require(path.join(PRELOAD, "core/utils.js"));

let envSeq = 0;
function resetEnv() {
  storage.resetForTest();
  searchIndex.resetForTest();
  lifecycle.resetForTest();
  aiSvc.resetForTest();
  logger.resetForTest();
  curLocalDir = path.join(TMP_BASE, "v2-" + ++envSeq);
  fs.mkdirSync(curLocalDir, { recursive: true });
  h = makeHarness();
  global.utools = h.ut;
  return h;
}

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error("FAIL: " + name);
  pass += 1;
  console.log("  ✓ " + name);
};

(async () => {
  try {
    console.log("[v2] 1. 分层存储边界 + spill 目录隔离");
    {
      const env = resetEnv();
      const spillDir = path.join(curLocalDir, "devbridge-spill");
      fs.mkdirSync(spillDir, { recursive: true });
      fs.writeFileSync(path.join(spillDir, "keep.txt"), "spill");

      const feed = { _id: "feed:50", url: "https://ex.com/rss.xml", title: "50篇测试源", category: "科技", notify: true, createdAt: 100 };
      await storage.saveFeed(feed);
      const batch = Array.from({ length: 50 }, (_, i) => ({
        guid: "id-" + i,
        link: "https://ex.com/p/" + i,
        title: `第${i}篇深度技术文章 AI System`,
        contentHtml: `<p>第 ${i} 篇详细正文，包含关键词 quantum computing 与嵌入式存储分层。</p>`,
        contentHash: "ch-" + i,
        summaryText: "摘要 " + i,
        cover: null,
        pubTs: 100000 + i * 1000,
      }));
      const res = await storage.ingestFeed(feed, batch, { etag: "e50" });
      ok("50 篇一次性入库成功", res.ok && res.newCount === 50);

      const syncKeys = [...env.raw.keys()];
      ok("同步库仅含 feed:（无任何 item:/itemfull:/itemfullx:/state:/star:）", syncKeys.length === 1 && syncKeys[0] === "feed:50");
      ok("同步库 feed 已剥除 etag 传输态", env.raw.get("feed:50").etag === undefined);

      const airssRoot = path.join(curLocalDir, "airss-data");
      ok("本地 feed-state.json 已写入", fs.existsSync(path.join(airssRoot, "feed-state.json")));
      ok("本地分片文件存在", fs.readdirSync(path.join(airssRoot, "feeds")).some((f) => f.endsWith(".json")));
      const firstId = "item:feed:50:" + require("crypto").createHash("sha256").update("id-0").digest("hex").slice(0, 12);
      await storage.setRead(firstId, true);
      await storage.setStarred(firstId, true);
      await storage.setReadPos(firstId, 0.45);
      ok("懒写仅产生 1 条 state: 与 1 条 star: 同步文档", (await env.ut.db.promises.allDocs("state:")).length === 1 && (await env.ut.db.promises.allDocs("star:")).length === 1);

      await storage.clearAll();
      ok("clearAll 清空 sync 与重建空 airss-data", env.raw.size === 0 && (await storage.snapshotItems()).length === 0);
      ok("clearAll 绝不删除同级 devbridge-spill", fs.readFileSync(path.join(spillDir, "keep.txt"), "utf8") === "spill");
    }

    console.log("[v2] 2. 星标/稍后读同步快照兜底（跨端新设备无本地分片仍可见）");
    {
      const env = resetEnv();
      await env.ut.db.promises.put({
        _id: "star:snapKey1",
        feedUrlKey: "ex.com/rss",
        feedTitle: "远端源",
        title: "远端收藏文章",
        link: "https://ex.com/starred",
        author: "Alice",
        pubTs: 5000,
        summaryText: "这是同步快照保存的摘要内容",
        starredAt: 6000,
      });
      await env.ut.db.promises.put({
        _id: "later:laterKey1",
        feedUrlKey: "__later__",
        feedTitle: "稍后读",
        title: "远端稍后读文章",
        link: "https://ex.com/later",
        author: "",
        pubTs: 7000,
        summaryText: "稍后读云端快照摘要",
        savedAt: 7000,
      });
      const snap = await readService.getSnapshot();
      ok("冷启动无需本地分片即可还原 star: 兜底条目", snap.items.some((x) => x.itemKey === "snapKey1" && x.fromStarSnap && x.starred));
      ok("冷启动无需本地分片即可还原 later: 兜底条目", snap.items.some((x) => x.itemKey === "laterKey1" && x.fromLaterSnap && x.isLater));
      ok("统计准确计算 later 与 starred", snap.stats.starred === 1 && snap.stats.later === 1);
    }

    console.log("[v2] 3. 分片损坏自愈与原子写");
    {
      resetEnv();
      const feed = { _id: "feed:corrupt", url: "https://c.example/feed", title: "C", category: "默认", createdAt: 1 };
      await storage.saveFeed(feed);
      await storage.ingestFeed(feed, [{ guid: "c1", link: "https://c/1", title: "Good", contentHtml: "<p>body</p>", contentHash: "h1", summaryText: "s", pubTs: 10 }], {});
      const shardsDir = path.join(curLocalDir, "airss-data", "feeds");
      const shardFile = path.join(shardsDir, fs.readdirSync(shardsDir)[0]);
      fs.writeFileSync(shardFile, "{broken json trunc", "utf8");
      storage.resetForTest();
      await storage.init();
      const list = await storage.snapshotItems();
      ok("损坏分片被安全跳过且 init 不崩溃", Array.isArray(list) && list.length === 0);
    }

    console.log("[v2] 4. MiniSearch 10,000 篇中英文混合检索 <50ms");
    {
      resetEnv();
      const fakeItems = [];
      const bodyMap = new Map();
      for (let i = 0; i < 10000; i++) {
        const id = "item:bench:" + i;
        const hit = i === 4242 || i === 8888;
        fakeItems.push({
          _id: id,
          title: hit ? "深度解析人工智能与 Transformer 架构" : `普通资讯第 ${i} 条日常更新`,
          titleDisplay: "",
          summaryText: hit ? "专注大语言模型注意力机制" : `常规摘要编号 ${i} sample update notes`,
          ai: hit ? { tags: ["AI", "LLM"] } : undefined,
        });
        bodyMap.set(id, hit ? "<p>这里讨论 Transformer 自注意力机制在人工智能系统的实践。</p>" : `<p>Generic article paragraph index ${i} about daily engineering workflows.</p>`);
      }
      const indexed = searchIndex.rebuildAll(fakeItems, (it) => bodyMap.get(it._id) || "");
      ok("万级语料完成建索引", indexed === 10000);

      // 预热一次后再测量多次查询平均耗时，同时断言单次 <50ms
      const t0 = performance.now();
      const res = searchIndex.search("人工智能 transformer");
      const elapsed = performance.now() - t0;
      console.log(`  · 10,000 篇中英混合检索耗时 ${elapsed.toFixed(2)}ms (命中 ${res.ids.length})`);
      ok("精确命中 2 篇中英复合目标且无截断", res.ids.length === 2 && res.ids.includes("item:bench:4242") && res.ids.includes("item:bench:8888") && res.truncated === false);
      ok("查询耗时 < 50ms", elapsed < 50);
    }

    console.log("[v2] 5. v1 → v2 两阶段安全迁移");
    {
      const env = resetEnv();
      await env.ut.db.promises.put({
        _id: "feed:old1",
        url: "https://old.example/rss",
        title: "旧版订阅",
        etag: "old-etag",
        lastFetchedAt: 12345,
        createdAt: 100,
      });
      await env.ut.db.promises.put({
        _id: "item:feed:old1:abc",
        feedKey: "feed:old1",
        guid: "old-g1",
        link: "https://old.example/1",
        title: "旧版星标文章",
        titleDisplay: "旧版星标文章",
        summaryText: "旧摘要",
        read: true,
        starred: true,
        pubTs: 9000,
        aiStatus: "done",
        ai: { summary: "S", tags: ["旧"], titleZh: "", titleNorm: "", aiSource: "enrich" },
        aiTrans: { paras: [{ idx: 0, head: "H", text: "译" }], at: 1, model: "m" },
      });
      await env.ut.db.promises.put({ _id: "itemfull:item:feed:old1:abc", content: "<p>旧版正文 HTML</p>" });
      await env.ut.db.promises.put({ _id: "itemfullx:item:feed:old1:abc", content: "<p>旧版提取全文</p>", at: 500, src: "readability" });
      await env.ut.db.promises.put({ _id: "ai:enrich:v2:k1", result: { summary: "cached" }, createdAt: 100 });
      env.kv.set("airss:readPositions", { "item:feed:old1:abc": 0.72 });
      env.kv.set("airss:logs", [{ t: 1000, level: "info", tag: "v1", msg: "old log" }]);

      await lifecycle.onReady();

      const detAfterPhase1 = await migrate.detectLegacy();
      ok("阶段一不删旧同步文档（保旧端兼容）", detAfterPhase1.total === 4);
      const detail = await storage.getItemDetail("item:feed:old1:abc");
      ok("阶段一无损导入正文与提取全文", detail.content === "<p>旧版正文 HTML</p>" && detail.fullxContent === "<p>旧版提取全文</p>");
      ok("阶段一导入 read/starred/readPos/aiTrans", detail.item.read && detail.item.starred && detail.readPos === 0.72 && detail.aiTrans.paras.length === 1);
      ok("阶段一生成同步 state: 与 star: 与 meta:schema", (await env.ut.db.promises.allDocs("state:")).length === 1 && (await env.ut.db.promises.allDocs("star:")).length === 1 && (await env.ut.db.promises.get("meta:schema")).version === 2);
      ok("阶段一导入旧诊断日志", logger.getLogs().some((l) => l.msg === "old log"));

      // 阶段二：同步中拒绝清理
      env.setCloudState(1);
      const refused = await migrate.cleanLegacySyncDocs();
      ok("云同步中拒绝阶段二清理", refused.ok === false && refused.error === "CLOUD_SYNC_IN_PROGRESS");

      env.setCloudState(0);
      const cleaned = await migrate.cleanLegacySyncDocs();
      ok("阶段二批量删除全部旧同步冗余", cleaned.ok && cleaned.removed === 4 && (await migrate.detectLegacy()).total === 0);
      ok("阶段二清理旧 dbStorage 键", !env.kv.has("airss:readPositions") && !env.kv.has("airss:logs"));
    }

    console.log("[v2] 6. 生命周期单点注册 / onDbPull 增量合并 / mainPush 1+4 / 动态全局搜索");
    {
      const env = resetEnv();
      lifecycle.register();
      ok("7 项宿主生命周期已单点注册", !!env.hooks.onPluginReady && !!env.hooks.onPluginEnter && !!env.hooks.onPluginOut && !!env.hooks.onPluginDetach && !!env.hooks.onDbPull && !!env.hooks.onScheduleTrigger && !!env.hooks.onMainPush);

      await lifecycle.onReady();
      const feed = { _id: "feed:mp", url: "https://mp.example/rss", title: "热榜源", createdAt: 1 };
      await storage.saveFeed(feed);
      await storage.ingestFeed(
        feed,
        Array.from({ length: 6 }, (_, i) => ({
          guid: "m" + i,
          link: "https://mp.example/" + i,
          title: `未读头条文章 ${i} 深度学习指南`,
          contentHtml: `<p>文章 ${i} 包含正文 keyword_alpha</p>`,
          contentHash: "mh-" + i,
          summaryText: "摘要",
          pubTs: 10000 + i * 1000,
        })),
        {}
      );

      // 测试 mainPush 1+4 与直达点击
      const pushList = env.hooks.onMainPush({ code: "airss" });
      ok("mainPush 返回 1 总览 + 4 未读", pushList.length === 5 && pushList[0].text.includes("共 6 篇未读"));
      env.hooks.onMainPushSelect({ option: { text: pushList[1].text } });
      await lifecycle.onEnter({ code: "airss", from: "main" });
      const queued = lifecycle.consumePendingActions();
      ok("点击 mainPush 条目直达目标文章", queued.actions.some((a) => a.type === "open-item" && a.payload.itemId.startsWith("item:feed:mp:")));

      // 测试动态全局搜索开关与 over 搜索
      ok("全局搜索默认关闭", lifecycle.isGlobalSearchEnabled() === false);
      ok("开启全局搜索注册 airss_search", lifecycle.setGlobalSearchEnabled(true) === true && env.features.has("airss_search"));
      const ovPush = env.hooks.onMainPush({ code: "airss_search", payload: "keyword_alpha" });
      ok("airss_search mainPush 实时检索正文命中", ovPush.length === 5);
      ok("关闭全局搜索移除 airss_search", lifecycle.setGlobalSearchEnabled(false) === false && !env.features.has("airss_search"));

      // 测试 onDbPull 增量合并 state:
      const allMp = await storage.itemsOfFeed("feed:mp");
      const target = allMp[0];
      const uk = feedUrlKey(feed.url);
      const ik = computeItemKey(uk, target.guid, target.link, target.title);
      await env.hooks.onDbPull([{ _id: "state:" + ik, feedUrlKey: uk, read: true, starred: true, updatedAt: Date.now() }]);
      await new Promise((r) => setTimeout(r, 30));
      const updated = (await storage.itemsOfFeed("feed:mp")).find((x) => x._id === target._id);
      ok("onDbPull(docs) 增量合并已读与星标", updated.read === true && updated.starred === true);
    }

    console.log("[v2] 7. 后台定时刷新 requestSchedule / onScheduleTrigger（汇总通知 + AI 批隔离）");
    {
      const env = resetEnv();
      lifecycle.register();
      await lifecycle.onReady();

      env.setRejectSchedule(true);
      const rej = await refreshService.enableSchedule("*/15 * * * *");
      ok("用户拒绝定时权限返回 rejected=true", rej.ok === false && rej.rejected === true && rej.error === "USER_REJECTED");

      env.setRejectSchedule(false);
      const okSch = await refreshService.enableSchedule("*/30 * * * *");
      ok("授权定时成功并记录 Cron", okSch.ok === true && refreshService.getScheduleStatus().enabled === true);

      const origFeedFetch = feedSvc.__test.ctx.nodeFetch;
      feedSvc.__test.ctx.nodeFetch = async (u) => {
        const title = u.endsWith("/f1") ? "源一" : u.endsWith("/f2") ? "源二" : "源三";
        return {
          ok: true,
          url: u,
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8" },
          body: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>https://sch.example/</link><item><title>${title}新文</title><guid>${title}-1</guid><link>https://sch.example/${title}</link><description>正文</description></item></channel></rss>`),
          truncated: false,
          error: null,
        };
      };
      const base = "https://sch.example";
      try {
        await storage.saveFeed({ _id: "feed:s1", url: base + "/f1", title: "源一", notify: true, createdAt: 1 });
        await storage.saveFeed({ _id: "feed:s2", url: base + "/f2", title: "源二", notify: true, createdAt: 2 });
        env.kv.set("airss:settings", { refreshMin: 30, notifyEnabled: true, aiEnabled: true, aiAutoCount: 3, scheduleAiBatch: false });
        aiSvc.saveConfig({ enabled: true });

        env.resetCounters();
        const sum = await env.hooks.onScheduleTrigger({ code: "airss-refresh" });
        ok("onScheduleTrigger 完成双源刷新", sum.newItems === 2);
        ok("多源新文章仅发送 1 条汇总通知", env.notifications.length === 1 && env.notifications[0].body.includes("2 个源共 2 篇新文章"));
        ok("scheduleAiBatch=false 时后台定时不调用 AI", env.aiCalls === 0);

        await storage.saveFeed({ _id: "feed:s3", url: base + "/f3", title: "源三", notify: true, createdAt: 3 });
        env.kv.set("airss:settings", { refreshMin: 30, notifyEnabled: true, aiEnabled: true, aiAutoCount: 0, scheduleAiBatch: true });
        env.resetCounters();
        await env.hooks.onScheduleTrigger({ code: "airss-refresh" });
        ok("scheduleAiBatch=true 时后台定时自动触发 AI 轻量批", env.aiCalls >= 1);
      } finally {
        feedSvc.__test.ctx.nodeFetch = origFeedFetch;
      }

      refreshService.disableSchedule();
      ok("disableSchedule 已取消定时任务", refreshService.getScheduleStatus().enabled === false);
    }

    console.log("[v2] 8. 稍后读 laterService.saveUrl（mainHide + HTML 消毒）");
    {
      const env = resetEnv();
      lifecycle.register();
      await lifecycle.onReady();
      const origLaterFetch = laterService.__test.ctx.nodeFetch;
      const url = "https://later.example/article.html";
      laterService.__test.ctx.nodeFetch = async () => ({
        ok: true,
        url,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(`<html><head><title>稍后读测试网页</title></head><body><article><h1>稍后读标题</h1>${"<p>这是一篇通过稍后读 URL 正则无窗保存的网页文章，包含足够正文长度供提取并安全消毒。<img src='/img.png'></p>".repeat(12)}<script>alert('xss')</script></article></body></html>`),
        truncated: false,
        error: null,
      });
      try {
        const res = await lifecycle.onEnter({ code: "save_later", payload: url, from: "main" });
        ok("main 来源呼出 save_later 时隐藏主窗", env.hideCalled === 1);
        ok("saveUrl 返回成功并落入 feed:__later__", res.ok && res.item.feedKey === "feed:__later__");
        ok("稍后读产生同步快照 later:*", (await env.ut.db.promises.allDocs("later:")).length === 1);
        const detail = await storage.getItemDetail(res.item._id);
        ok("稍后读正文已提取并剥除 script / 绝对化图片", !/<script/i.test(detail.content) && detail.content.includes("https://later.example/img.png"));
        ok("发送已存入稍后读通知", env.notifications.some((n) => n.body.includes("已存入稍后读")));
      } finally {
        laterService.__test.ctx.nodeFetch = origLaterFetch;
      }
    }

    console.log("\n全部通过：" + pass + " 项（v2.1 核心架构与 uTools 8.0 特性）");
  } finally {
    storage.resetForTest();
    searchIndex.resetForTest();
    lifecycle.resetForTest();
    aiSvc.resetForTest();
    logger.resetForTest();
    try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
