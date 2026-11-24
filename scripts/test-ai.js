/**
 * test-ai.js — v2.1 AI 管线测试（uTools 8.0+ · 本机 cache/quota/sidecar）
 *
 * 覆盖：enrich 流式落库/缓存命中/bypass、abort 原子性与已产出计额、降级与旧产物保留、
 *       分池额度与跨日重置、轻量批 JSON 回写与 T-21/H4、T-09 内容变化清空 AI 与译文/目录、
 *       段落翻译、AI 目录两级协议、单飞前奏自弃、reasoningEffort (none/low/medium) 与 BYOK 两级存储。
 * 用法：node scripts/test-ai.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const PRELOAD = path.join(__dirname, "..", "preload");
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "airss-test-ai-"));
let curLocalDir = path.join(TMP_BASE, "init");

function makeMockDb() {
  const docs = new Map();
  let revSeq = 1;
  const res = (ok, id) => ({ ok, id, rev: "r" + revSeq++ });
  const db = {
    put: (doc) => {
      if (doc._deleted) {
        docs.delete(doc._id);
        return res(true, doc._id);
      }
      const cur = docs.get(doc._id);
      if (cur && cur._rev !== doc._rev) return { error: true, id: doc._id, message: "conflict" };
      docs.set(doc._id, { ...doc, _rev: "r" + ++revSeq });
      return res(true, doc._id);
    },
    get: (id) => (docs.has(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null),
    remove: (docOrId) => {
      const id = typeof docOrId === "string" ? docOrId : docOrId._id;
      if (!docs.has(id)) return { error: true, id, message: "not_found" };
      docs.delete(id);
      return res(true, id);
    },
    bulkDocs: (list) => list.map((d) => db.put(d)),
    allDocs: (prefixOrIds) => {
      let vals = [...docs.values()];
      if (typeof prefixOrIds === "string") vals = vals.filter((d) => d._id.startsWith(prefixOrIds));
      else if (Array.isArray(prefixOrIds)) vals = vals.filter((d) => prefixOrIds.includes(d._id));
      return vals.map((d) => JSON.parse(JSON.stringify(d)));
    },
    replicateStateFromCloud: () => 0,
  };
  db.promises = {};
  for (const k of ["put", "get", "remove", "bulkDocs", "allDocs"]) db.promises[k] = (x, y) => Promise.resolve(db[k](x, y));
  return { db, raw: docs };
}

const fake = { calls: 0, script: [], fail: null, options: [], snapshot: false, earlyResolve: false, hang: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const storageMap = new Map();
const cryptoMap = new Map();

function installUtools(db) {
  global.utools = {
    db,
    getPluginLocalDataPath: () => curLocalDir,
    getPluginTempPath: () => TMP_BASE,
    dbStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, v),
      removeItem: (k) => storageMap.delete(k),
    },
    dbCryptoStorage: {
      getItem: (k) => (cryptoMap.has(k) ? cryptoMap.get(k) : null),
      setItem: (k, v) => cryptoMap.set(k, v),
      removeItem: (k) => cryptoMap.delete(k),
    },
    allAiModels: async () => [{ id: "m1", label: "模型一", description: "", icon: "", cost: 1 }],
    getAppVersion: () => "8.0.2",
    ai(option, streamCb) {
      fake.calls += 1;
      fake.options.push(option);
      let aborted = false;
      let settled = false;
      let acc = "";
      const promise = new Promise((resolve, reject) => {
        (async () => {
          try {
            if (fake.hang) return;
            for (let i = 0; i < fake.script.length; i++) {
              await sleep(4);
              if (aborted) throw new Error("The request was aborted");
              acc += fake.script[i];
              if (streamCb) streamCb({ role: "assistant", content: fake.snapshot ? acc : fake.script[i] });
              if (fake.earlyResolve && i === 0) {
                settled = true;
                resolve(undefined);
              }
            }
            if (fake.fail === "reject") throw new Error("ENGINE_ERROR");
            if (!settled) {
              settled = true;
              resolve(streamCb ? undefined : { role: "assistant", content: acc });
            }
          } catch (e) {
            if (!settled) {
              settled = true;
              reject(e);
            }
          }
        })();
      });
      promise.abort = () => { aborted = true; };
      return promise;
    },
  };
}

installUtools(makeMockDb().db);
const storage = require(path.join(PRELOAD, "core/storage.js"));
const dbSvc = require(path.join(PRELOAD, "services/db.js"));
const aiSvc = require(path.join(PRELOAD, "services/ai.js"));
const extractSvc = require(path.join(PRELOAD, "services/extract.js"));
const logger = require(path.join(PRELOAD, "services/logger.js"));
const T = aiSvc.__test;

let envSeq = 0;
function freshEnv() {
  storage.resetForTest();
  aiSvc.resetForTest();
  extractSvc.__test.clearMemo();
  logger.resetForTest();
  storageMap.clear();
  cryptoMap.clear();
  fake.calls = 0;
  fake.script = [];
  fake.options = [];
  fake.fail = null;
  fake.snapshot = false;
  fake.earlyResolve = false;
  fake.hang = false;
  curLocalDir = path.join(TMP_BASE, "e" + ++envSeq);
  fs.mkdirSync(curLocalDir, { recursive: true });
  const { db } = makeMockDb();
  global.utools.db = db;
  aiSvc.saveConfig({ enabled: true, engine: "utools", reasoningEffort: "none" });
  return { db, localDir: curLocalDir };
}

async function seedItems(feedId, list, feedOpts = {}) {
  const feed = { _id: feedId, url: "https://e/" + feedId.replace(/[^a-z0-9]/gi, ""), title: feedId, unreadCount: 0, lastFetchedAt: null, ...feedOpts };
  await dbSvc.saveFeed(feed);
  const specs = list.map((x, idx) => ({
    guid: x.guid || x._id || "g" + idx,
    link: x.link || "https://e/item/" + idx,
    title: x.title || "Title " + idx,
    contentHtml: x.contentHtml || "<p>正文</p>",
    contentHash: x.contentHash || "hash-" + (x.guid || idx),
    summaryText: x.summaryText || "首句内容",
    cover: null,
    pubTs: x.pubTs || (idx + 1) * 1000,
  }));
  await dbSvc.ingestFeed(feed, specs, {});
  return dbSvc.itemsOfFeed(feedId);
}

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error("FAIL: " + name);
  pass += 1;
  console.log("  ✓ " + name);
};
const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

(async () => {
  try {
    console.log("[ai] 单元：BYOK 端点归一 / 输出解析");
    {
      freshEnv();
      ok("裸域名 → /v1/chat/completions", T.byokEndpoint("https://api.x.com") === "https://api.x.com/v1/chat/completions");
      ok("…/v1 → 追加路径", T.byokEndpoint("https://api.x.com/v1") === "https://api.x.com/v1/chat/completions");
      ok("尾斜杠归一", T.byokEndpoint("https://api.x.com/v1/") === "https://api.x.com/v1/chat/completions");
      ok("全路径直用", T.byokEndpoint("https://api.x.com/chat/completions") === "https://api.x.com/chat/completions");

      const good = T.parseEnrichOutput("【titleZh】DeepSeek 发布 V4【titleNorm】【tags】科技, AI\n这是摘要第一句。第二句。");
      ok("头部解析：titleZh", good.titleZh === "DeepSeek 发布 V4");
      ok("头部解析：tags 分隔", good.tags.join("|") === "科技|AI");
      ok("头部解析：摘要在元信息行之后", good.summary.startsWith("这是摘要"));
      const degraded = T.parseEnrichOutput("没有头部的纯摘要文本。");
      ok("头部失败降级纯摘要", degraded.summary === "没有头部的纯摘要文本。" && !degraded.titleZh && degraded.tags.length === 0);
      const multi = T.parseEnrichOutput("【titleZh】英文题\n【titleNorm】客观题\n【tags】科技\n这是跨行元信息后的摘要。");
      ok("元信息跨行也能解析", multi.titleNorm === "客观题" && multi.tags.join() === "科技" && multi.summary === "这是跨行元信息后的摘要。");

      const longTitle = T.parseEnrichOutput("【titleZh】x【titleNorm】Anthropic发布Claude Opus 5：百万token上下文窗口【tags】科技\n摘要。");
      ok("超长 titleNorm 按标点边界截断", longTitle.titleNorm.endsWith("…") && longTitle.titleNorm.length <= 30);

      const esys = T.buildEnrichMessages({ title: "t" }, "正文", ["科技"])[0].content;
      ok("enrich prompt 用 AI优化标题口径", esys.includes("AI优化标题") && !esys.includes("噱头"));
      const bsys = T.buildBatchMessages([{ _id: "i", title: "t", summaryText: "s" }], ["科技"])[0].content;
      ok("batch prompt 同口径", bsys.includes("清晰客观") && !bsys.includes("噱头"));
    }

    console.log("[ai] enrich 全链路（流式落库/本地缓存/本地额度）");
    {
      const { db, localDir } = freshEnv();
      const [item, item2] = await seedItems("feed:f1", [
        { guid: "h1", title: "Some English Title", contentHtml: "<p>正文内容第一段。第二段讲结论。</p>", summaryText: "first sentence" },
        { guid: "h2", title: "Some English Title", contentHtml: "<p>正文内容第一段。第二段讲结论。</p>", summaryText: "first sentence" },
      ]);

      fake.script = ["【titleZh】某英文标题的中文版", "【titleNorm】客观改写标题【tags】科技,商业\n", "这是流式摘要。共三句话。第三句收尾。"];
      const deltas = [];
      const r = await aiSvc.enrich(item._id, { onDelta: (t) => deltas.push(t) });
      ok("enrich 成功", r.ok && r.ai.summary.includes("流式摘要"));
      ok("流式回调逐块透传", deltas.length === 3);
      const after = (await dbSvc.getItemDetail(item._id)).item;
      ok("item.ai 落库（aiSource=enrich）", after.aiStatus === "done" && after.ai.aiSource === "enrich");
      ok("titleNorm 优先写 titleDisplay", after.titleDisplay === "客观改写标题");
      ok("tags ≤2 且入库", after.ai.tags.join() === "科技,商业");
      ok("AI 缓存不写同步 utools.db", (await db.promises.allDocs("ai:")).length === 0);
      ok("手动池计 1 次", T.loadQuota().manual === 1);

      const callsBefore = fake.calls;
      const r2 = await aiSvc.enrich(item2._id);
      ok("缓存命中不调引擎", r2.ok && r2.cached === true && fake.calls === callsBefore);
      const after2 = (await dbSvc.getItemDetail(item2._id)).item;
      ok("缓存命中也回写 item", after2.aiStatus === "done" && after2.titleDisplay === "客观改写标题");
      ok("缓存命中不计额度", T.loadQuota().manual === 1);

      aiSvc.flush();
      const cacheFile = path.join(localDir, "airss-data", "ai", "cache.json");
      ok("AI 缓存持久化到本地 ai/cache.json", fs.existsSync(cacheFile) && fs.readFileSync(cacheFile, "utf8").includes("ai:enrich:v2:"));

      const r2b = await aiSvc.enrich(item2._id);
      ok("item 层 enrich 产物直返", r2b.cached === true && fake.calls === callsBefore);

      const r3 = await aiSvc.enrich(item._id, { bypass: true });
      ok("bypass 重调引擎", r3.ok && !r3.cached && fake.calls === callsBefore + 1);
      ok("bypass 计额度", T.loadQuota().manual === 2);
    }

    console.log("[ai] abort 原子性与已产出计额");
    {
      freshEnv();
      const [item] = await seedItems("feed:ab", [{ guid: "a1", contentHtml: "<p>正文</p>" }]);
      fake.script = ["第一块产出", "第二块产出", "第三块产出"];
      const p = aiSvc.enrich(item._id, {});
      await sleep(12);
      aiSvc.abort();
      const r = await p;
      ok("abort 返回 aborted", !r.ok && r.aborted === true);
      const after = (await dbSvc.getItemDetail(item._id)).item;
      ok("abort 不落库", after.aiStatus === "none" && !after.ai);
      ok("abort 已产出计入额度", T.loadQuota().manual === 1);
    }

    console.log("[ai] 截断防御：快照式流 / 提前 resolve / 硬超时");
    {
      freshEnv();
      const [s1, s2, s3] = await seedItems("feed:st", [
        { guid: "s1", contentHtml: "<p>正文</p>" },
        { guid: "s2", contentHtml: "<p>正文</p>" },
        { guid: "s3", contentHtml: "<p>正文</p>" },
      ]);
      fake.snapshot = true;
      fake.script = ["【titleZh】", "【titleNorm】客观改写【tags】科技\n", "快照流摘要第一句。第二句。"];
      const r1 = await aiSvc.enrich(s1._id, {});
      ok("快照式流回调不产生重复乱串", r1.ok && r1.ai.summary === "快照流摘要第一句。第二句。" && r1.ai.titleNorm === "客观改写");

      fake.snapshot = false;
      fake.earlyResolve = true;
      fake.script = ["【titleZh】【titleNorm】【tags】科技\n", "早退竞态下仍要拿全摘要。", "第三句。"];
      const r2 = await aiSvc.enrich(s2._id, {});
      ok("提前 resolve 后宽限取全内容", r2.ok && r2.ai.summary.includes("第三句。"));
      fake.earlyResolve = false;

      fake.hang = true;
      T.setEngineTimeout(120);
      const t0 = Date.now();
      const r3 = await aiSvc.enrich(s3._id, {});
      ok("引擎挂起时硬超时退出", !r3.ok && r3.error === "ENGINE_TIMEOUT" && Date.now() - t0 < 2000);
      ok("超时落 error 可重试", (await dbSvc.getItemDetail(s3._id)).item.aiStatus === "error");
      fake.hang = false;
      T.setEngineTimeout(60000);
    }

    console.log("[ai] 失败降级与旧产物保留");
    {
      freshEnv();
      const [item] = await seedItems("feed:fail", [{ guid: "e1", contentHtml: "<p>正文</p>" }]);
      fake.fail = "reject";
      const r = await aiSvc.enrich(item._id, {});
      ok("引擎失败返回 error", !r.ok && r.error === "ENGINE_ERROR");
      let after = (await dbSvc.getItemDetail(item._id)).item;
      ok("无产物失败 → aiStatus=error 且不计额", after.aiStatus === "error" && T.loadQuota().manual === 0);

      fake.fail = null;
      fake.script = ["【titleZh】【titleNorm】【tags】科技\n旧摘要生成成功。"];
      await aiSvc.enrich(item._id, { bypass: true });
      after = (await dbSvc.getItemDetail(item._id)).item;
      ok("重生成成功恢复 done", after.aiStatus === "done" && after.ai.summary === "旧摘要生成成功。");

      fake.fail = "reject";
      await aiSvc.enrich(item._id, { bypass: true });
      after = (await dbSvc.getItemDetail(item._id)).item;
      ok("重生成失败保留旧产物", after.aiStatus === "done" && after.ai.summary === "旧摘要生成成功。");
      fake.fail = null;
    }

    console.log("[ai] 额度分池：本地 quota.json 耗尽拒绝 / 跨日重置 / BYOK 豁免");
    {
      const { localDir } = freshEnv();
      const [item] = await seedItems("feed:qt", [{ guid: "q1", contentHtml: "<p>正文</p>" }]);
      const qPath = path.join(localDir, "airss-data", "ai", "quota.json");
      fs.mkdirSync(path.dirname(qPath), { recursive: true });
      fs.writeFileSync(qPath, JSON.stringify({ date: today(), manual: 120, bg: 30 }));
      const callsBefore = fake.calls;
      const r = await aiSvc.enrich(item._id, {});
      ok("手动池耗尽直接拒绝", !r.ok && r.error === "QUOTA_EXHAUSTED" && fake.calls === callsBefore);
      ok("BYOK 豁免额度", T.quotaCheck("manual", { engine: "byok" }).ok === true);

      fs.writeFileSync(qPath, JSON.stringify({ date: "2000-01-01", manual: 120, bg: 30 }));
      ok("跨日自动重置", T.loadQuota().manual === 0);
    }

    console.log("[ai] 轻量批：JSON 回写 / T-21 / H4");
    {
      freshEnv();
      const [b1, b2, b3, b4] = await seedItems("feed:bt", [
        { guid: "b1", title: "标题b1" },
        { guid: "b2", title: "标题b2" },
        { guid: "b3", title: "标题b3" },
        { guid: "b4", title: "标题b4" },
      ]);
      await dbSvc.saveItemAi(b2._id, {
        aiStatus: "done",
        ai: { summary: "已有", tags: [], titleZh: "", titleNorm: "enrich 改写", aiSource: "enrich" },
      });

      fake.script = [
        JSON.stringify([
          { id: b1._id, tags: ["设计", "工具"], titleZh: "", titleNorm: "客观陈述式标题" },
          { id: b3._id, tags: "单字符串标签", titleZh: "中文翻译标题" },
          { id: "item:feed:bt:ghost", tags: ["幽灵"], titleZh: "不存在的篇" },
        ]),
      ];
      const r = await aiSvc.batchEnrich([b1, b2, b3]);
      ok("轻量批成功", r.ok && r.error === null);
      const a1 = (await dbSvc.getItemDetail(b1._id)).item;
      ok("b1 回写 tags+titleNorm", a1.aiStatus === "done" && a1.ai.tags.join() === "设计,工具" && a1.titleDisplay === "客观陈述式标题");
      const a2 = (await dbSvc.getItemDetail(b2._id)).item;
      ok("done 篇跳过", a2.ai.titleNorm === "enrich 改写");
      const a3 = (await dbSvc.getItemDetail(b3._id)).item;
      ok("字符串 tags 兼容解析 + titleZh 展示", a3.ai.tags.join() === "单字符串标签" && a3.titleDisplay === "中文翻译标题");
      ok("幽灵篇不炸且按篇隔离", r.updated.every((u) => u._id !== "item:feed:bt:ghost"));
      ok("后台池计 1 次且不计手动池", T.loadQuota().bg === 1 && T.loadQuota().manual === 0);

      const r2 = await T.applyAi(b1, { summary: "", tags: ["别的"], titleZh: "", titleNorm: "" }, "enrich");
      const r3 = await T.applyAi(r2, { summary: "", tags: ["batch 标签"], titleZh: "", titleNorm: "" }, "batch");
      ok("batch 不覆盖 enrich 产物（T-21）", r3.ai.aiSource === "enrich" && r3.ai.tags.join() === "别的");
      ok("item 已删除时回写返回 null（H4）", (await T.applyAi({ _id: "item:gone" }, { summary: "" }, "batch")) === null);

      fake.script = ["这不是 JSON"];
      const r4 = await aiSvc.batchEnrich([b4]);
      ok("坏 JSON 输出报错不入库", !r4.ok && r4.error === "BAD_JSON_OUTPUT" && (await dbSvc.getItemDetail(b4._id)).item.aiStatus === "none");
    }

    console.log("[db→ai] ingest 内容变化清 AI 字段与本地 sidecar（T-09）");
    {
      freshEnv();
      const feed = { _id: "feed:t9", url: "https://e/feed", title: "T", unreadCount: 0, lastFetchedAt: null };
      await dbSvc.saveFeed(feed);
      await dbSvc.ingestFeed(feed, [{ guid: "g9", link: "https://e/9", title: "标题九", contentHtml: "<p>九</p>", contentHash: "hash9", summaryText: "九", cover: null, pubTs: 9 }], {});
      const [it9] = await dbSvc.itemsOfFeed("feed:t9");
      const saved = await T.applyAi(it9, { summary: "s", tags: ["科技"], titleZh: "", titleNorm: "改写标题" }, "enrich");
      ok("AI 产物已写", saved.aiStatus === "done" && saved.titleDisplay === "改写标题");
      await T.applyTrans(it9, [{ idx: 0, head: "九", text: "九" }], { "0": "九的译文" }, "m");
      ok("段落译文已写侧载", (await dbSvc.getItemDetail(it9._id)).aiTrans.paras.length === 1);
      await dbSvc.ingestFeed(feed, [{ guid: "g9", link: "https://e/9", title: "标题九", contentHtml: "<p>九改</p>", contentHash: "hash9new", summaryText: "九改", cover: null, pubTs: 9 }], {});
      const nowDetail = await dbSvc.getItemDetail(it9._id);
      ok("contentHash 变化 → ai/aiTrans 清空、aiStatus=none、标题复位", nowDetail.item.aiStatus === "none" && !nowDetail.ai && !nowDetail.aiTrans && nowDetail.item.titleDisplay === "标题九");
    }

    console.log("[ai] 段落翻译 translateItem & AI 目录 generateToc");
    {
      freshEnv();
      const [tr1, tr2, tr3, tr4, toc1, toc2, toc3, toc4, toc5, toc6] = await seedItems("feed:trtoc", [
        { guid: "tr1", title: "T1" },
        { guid: "tr2", title: "T2" },
        { guid: "tr3", title: "T3" },
        { guid: "tr4", title: "T4" },
        { guid: "toc1", title: "长文标题" },
        { guid: "toc2", title: "联播同文" },
        { guid: "toc3", title: "坏输出" },
        { guid: "toc4", title: "中止" },
        { guid: "toc5", title: "竞态" },
        { guid: "toc6", title: "限幅" },
      ]);
      const paras = [
        { idx: 0, head: "English paragraph one", text: "English paragraph one about something." },
        { idx: 1, head: "Second paragraph here", text: "Second paragraph here with more words." },
      ];

      ok("CJK 占比判定", T.cjkRatio("这是中文内容") > 0.5 && T.cjkRatio("plain english words") < 0.2);
      const parsed = T.parseTransOutput("[[0]]第一段译文 [备注] 内容\n[[1]]第二段译文");
      ok("[[n]] 协议解析不截断", parsed.texts["0"].includes("[备注]") && parsed.count === 2);

      const cn = await aiSvc.translateItem(tr1._id, [{ idx: 0, head: "中文段落", text: "这是一段以中文为主的正文段落，中文占比远超一半应当直接门控不调引擎。" }], {});
      ok("中文为主 NO_NEED 且不调引擎", !cn.ok && cn.error === "NO_NEED" && fake.calls === 0);

      fake.script = ["[[0]]第一段译文 [备注] 内容\n", "[[1]]第二段译文"];
      const r = await aiSvc.translateItem(tr1._id, paras, {});
      ok("翻译成功并返回 aiTrans", r.ok && r.aiTrans && r.aiTrans.paras.length === 2);
      const dTr1 = await dbSvc.getItemDetail(tr1._id);
      ok("aiTrans 通过 getItemDetail 读取（不在轻量列表）", dTr1.aiTrans.paras[1].head === paras[1].text.slice(0, 20) && dTr1.item.hasAiTrans === true);

      const calls1 = fake.calls;
      const r2 = await aiSvc.translateItem(tr1._id, paras, {});
      ok("已有译文直返（cached）", r2.ok && r2.cached === true && fake.calls === calls1);

      fake.script = ["无标记输出"];
      const r3 = await aiSvc.translateItem(tr2._id, [{ idx: 0, head: "abc", text: "some english words here ok" }], {});
      ok("BAD_TRANS_OUTPUT 不回写", !r3.ok && r3.error === "BAD_TRANS_OUTPUT" && !(await dbSvc.getItemDetail(tr2._id)).aiTrans);
      ok("空 paras 返回 NO_PARAS", (await aiSvc.translateItem(tr2._id, [], {})).error === "NO_PARAS");

      fake.script = ["[[0]]第一段开头产出", "[[1]]不会到达的第二段"];
      const p3 = aiSvc.translateItem(tr3._id, [{ idx: 0, head: "abc", text: "some english words here ok" }], {});
      await sleep(12);
      aiSvc.abort();
      const r5 = await p3;
      ok("翻译中止全弃", !r5.ok && r5.aborted === true && !(await dbSvc.getItemDetail(tr3._id)).aiTrans);

      const r6 = await aiSvc.translateItem(tr4._id, paras, {});
      ok("同文跨源缓存命中", r6.ok && r6.cached === true && r6.aiTrans.paras.length === 2);

      // 目录测试
      const tocParas = [
        { idx: 0, head: "开头段讲述了背景与动机", text: "开头段讲述了背景与动机，交代来龙去脉。" },
        { idx: 1, head: "第二段展开核心问题", text: "第二段展开核心问题，提出三个假设。" },
        { idx: 2, head: "第三段给出实验数据", text: "第三段给出实验数据，样本量一万人。" },
        { idx: 3, head: "结尾段总结全文", text: "结尾段总结全文并展望后续工作方向。" },
      ];
      const parsedToc = T.parseTocOutput("[[0|1]]背景与动机\n[[2|2]]实验与数据\n[[3]]结论与展望");
      ok("目录两级协议解析", parsedToc.count === 3 && parsedToc.sections[1].level === 2);

      fake.script = ["[[0]]背景与动机\n", "[[2]]实验与数据\n[[3]]结论与展望"];
      const rt = await aiSvc.generateToc(toc1._id, tocParas.map((p, i) => ({ ...p, tag: i === 1 ? "h2" : undefined })), {});
      ok("目录生成成功", rt.ok && rt.aiToc.sections.length === 3 && !rt.cached);
      ok("getItemDetail 可读 aiToc", (await dbSvc.getItemDetail(toc1._id)).aiToc.sections[1].head === tocParas[2].head);

      const callsToc = fake.calls;
      const rt2 = await aiSvc.generateToc(toc2._id, tocParas, {});
      ok("目录纯内容缓存跨源命中", rt2.ok && rt2.cached === true && fake.calls === callsToc);

      fake.script = ["无标记"];
      const rtBad = await aiSvc.generateToc(toc3._id, tocParas.map((p) => ({ ...p, text: p.text + " x" })), {});
      ok("无标记输出 BAD_TOC_OUTPUT", !rtBad.ok && rtBad.error === "BAD_TOC_OUTPUT");

      fake.script = ["[[0]]开头", "[[3]]结尾"];
      const pt4 = aiSvc.generateToc(toc4._id, tocParas.map((p) => ({ ...p, text: p.text + " y" })), {});
      await sleep(10);
      aiSvc.abort();
      ok("目录中止全弃", !(await pt4).ok && !(await dbSvc.getItemDetail(toc4._id)).aiToc);

      fake.script = ["[[0]]开头", "[[3]]结尾"];
      const pt5 = aiSvc.generateToc(toc5._id, tocParas.map((p) => ({ ...p, text: p.text + " z" })), {});
      await sleep(8);
      await dbSvc.saveItemFullx(toc5._id, "<p>新全文</p>", null, "readability");
      const rt5 = await pt5;
      ok("生成目录期间提取替换正文 → 产物弃写", !rt5.ok && rt5.error === "CONTENT_CHANGED");

      const big = Array.from({ length: 60 }, (_, i) => ({ idx: i, head: "第" + i + "段", text: "x".repeat(200) }));
      fake.script = ["[[0]]首章\n[[59]]越界章"];
      const rt6 = await aiSvc.generateToc(toc6._id, big, {});
      ok("TOC_MAX_CHARS 截断越界章", rt6.ok && rt6.aiToc.sections.length === 1);
    }

    console.log("[ai] 发起序双飞防御 & 并发翻译/全文提取");
    {
      freshEnv();
      const [item] = await seedItems("feed:cl", [{ guid: "c1", contentHtml: "<p>English body paragraph one for test.</p>" }]);
      fake.script = ["【titleZh】【titleNorm】【tags】科技\n摘要内容。"];
      const p = aiSvc.enrich(item._id, {});
      aiSvc.abort();
      const r = await p;
      ok("前奏中被超越的调用自弃，不调引擎", !r.ok && r.aborted === true && fake.calls === 0);

      const [exItem] = await seedItems("feed:exrace", [{ guid: "er1", link: "https://ex/a", contentHtml: "<p>Old summary.</p>" }], { fullText: true });
      const FX = Buffer.from(`<html><body><article><h1>Full</h1>${"<p>English body paragraph long enough to pass the six hundred chars threshold for extraction. ".repeat(20)}</article></body></html>`);
      extractSvc.__test.ctx.nodeFetch = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html" }, body: FX, truncated: false, error: null });
      fake.script = ["[[0]]fresh", " trans", " for", " old", " text", " tail."];
      const trP = aiSvc.translateItem(exItem._id, [{ idx: 0, head: "Old head", text: "Old summary paragraph in english." }], {});
      await sleep(8);
      const ex = await extractSvc.ensureFull(exItem._id);
      const tr = await trP;
      ok("提取完成且并发翻译被弃写（CONTENT_CHANGED）", ex.status === "fetched" && !tr.ok && tr.error === "CONTENT_CHANGED");
      ok("aiTrans 未被复活", !(await dbSvc.getItemDetail(exItem._id)).aiTrans);

      fake.script = ["[[0]]translation aligned to new full text."];
      const tr2 = await aiSvc.translateItem(exItem._id, [{ idx: 0, head: "New head", text: "New fulltext paragraph english." }], {});
      ok("提取后的新翻译正常写回", tr2.ok === true && (await dbSvc.getItemDetail(exItem._id)).aiTrans != null);
    }

    console.log("[ai] uTools 8.0+ 配置：reasoningEffort / BYOK 两级存储");
    {
      const { localDir } = freshEnv();
      const [item] = await seedItems("feed:u8", [{ guid: "u81", title: "深度思考测试" }]);
      const paras0 = [{ idx: 0, head: "首段标题", text: "用于直达引擎的段落文本，长度超过十个字符。" }];
      const lastOpt = () => fake.options[fake.options.length - 1];

      aiSvc.saveConfig({ reasoningEffort: "none" });
      fake.script = ["[[0]]第一章"];
      const rNone = await aiSvc.generateToc(item._id, paras0, { bypass: true });
      ok("reasoningEffort=none 传入 utools.ai", rNone.ok && lastOpt().reasoning_effort === "none");

      aiSvc.saveConfig({ reasoningEffort: "low" });
      fake.script = ["[[0]]第一章"];
      const rLow = await aiSvc.generateToc(item._id, paras0, { bypass: true });
      ok("reasoningEffort=low 生效", rLow.ok && lastOpt().reasoning_effort === "low");

      fake.script = ["[[0]]第一章"];
      const rMed = await aiSvc.generateToc(item._id, paras0, { bypass: true, reasoningEffort: "medium" });
      ok("调用级 reasoningEffort=medium 覆盖", rMed.ok && lastOpt().reasoning_effort === "medium");

      // BYOK 两级密钥存储：dbCryptoStorage -> local-fallback (byok.local)
      ok("默认存储模式为 crypto", aiSvc.getByokStorageMode() === "crypto");
      ok("crypto 存储写入正常", aiSvc.setByokKey("sk-crypto").storage === "crypto" && aiSvc.hasByokKey() === true);

      const savedCrypto = global.utools.dbCryptoStorage;
      try {
        delete global.utools.dbCryptoStorage;
        ok("crypto 不可用时报告 local-fallback", aiSvc.getByokStorageMode() === "local-fallback");
        const sv = aiSvc.setByokKey("sk-local-fallback");
        ok("密钥降级写入 airss-data/byok.local", sv.ok && sv.storage === "local-fallback" && aiSvc.hasByokKey() === true);
        ok("byok.local 文件确实落盘", fs.readFileSync(path.join(localDir, "airss-data", "byok.local"), "utf8").trim() === "sk-local-fallback");
        ok("status 反映 byokStorage=local-fallback", (await aiSvc.getStatus()).byokStorage === "local-fallback");
        ok("降级清除正常", aiSvc.setByokKey("").ok === true && aiSvc.hasByokKey() === false && !fs.existsSync(path.join(localDir, "airss-data", "byok.local")));
      } finally {
        global.utools.dbCryptoStorage = savedCrypto;
      }
      aiSvc.setByokKey("");
    }

    console.log("[log] 诊断日志（本地按天滚动）");
    {
      const { localDir } = freshEnv();
      logger.info("ai.test", "hello world", { a: 1 });
      logger.flush();
      const dump = logger.dumpText();
      ok("日志缓冲写入与格式化", dump.includes("hello world") && dump.includes('"a":1'));
      const logFiles = fs.readdirSync(path.join(localDir, "airss-data", "logs"));
      ok("按天滚动日志落盘", logFiles.some((f) => /^airss-\d{8}\.log$/.test(f)));
      logger.clear();
      ok("日志清空同步删文件", logger.getLogs().length === 0 && fs.readdirSync(path.join(localDir, "airss-data", "logs")).length === 0);
    }

    console.log("\nAI 管线测试通过：" + pass + " 项");
  } finally {
    storage.resetForTest();
    aiSvc.resetForTest();
    logger.resetForTest();
    try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
