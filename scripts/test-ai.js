/**
 * test-ai.js — AI 管线直测（Node 可跑，mock utools.ai / db / dbStorage / dbCryptoStorage）
 * 覆盖：enrich 流式落库/缓存命中/bypass、abort 原子性（H2）与已产出计额（F4）、
 *       失败降级 error 且旧产物保留、额度分池耗尽、轻量批 JSON 回写与 H4/T-21 守则、
 *       ingest 内容变化清 AI 字段（T-09）、BYOK 端点归一、配额跨日重置、
 *       AI 目录（v1.4）：行协议解析/去重升序/锚点补全/纯内容缓存跨源/B-1 弃写/限幅/T-09 连带清
 * 用法：node scripts/test-ai.js
 */
const assert = require("assert");
const path = require("path");
const PRELOAD = path.join(__dirname, "..", "preload");

// ---- 内存版 utools.db（与 test-db-mock 同款：_rev 冲突语义 + bulkDocs） ----
function makeMockDb() {
  const docs = new Map();
  let revSeq = 1;
  const res = (ok, id) => ({ ok, id, rev: "r" + revSeq++ });
  const db = {
    put: (doc) => {
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
  };
  db.promises = {};
  for (const k of ["put", "get", "remove", "bulkDocs", "allDocs"]) db.promises[k] = (x, y) => Promise.resolve(db[k](x, y));
  return { db, raw: docs };
}

// ---- 可编程 fake utools.ai（流式按块吐 + abort 注入 + 快照式/早退/挂起模拟） ----
const fake = { calls: 0, script: [], fail: null, options: [], snapshot: false, earlyResolve: false, hang: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installUtools(db) {
  const storageMap = new Map();
  const cryptoMap = new Map();
  global.utools = {
    db,
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
    ai(option, streamCb) {
      fake.calls += 1;
      fake.options.push(option);
      let aborted = false;
      let settled = false;
      let acc = "";
      const promise = new Promise((resolve, reject) => {
        (async () => {
          try {
            if (fake.hang) return; // 永不 settle，模拟宿主 AI 挂起
            for (let i = 0; i < fake.script.length; i++) {
              await sleep(4);
              if (aborted) throw new Error("The request was aborted");
              acc += fake.script[i];
              // snapshot=true 模拟快照式流（回调给累计全文）；否则给增量
              if (streamCb) streamCb({ role: "assistant", content: fake.snapshot ? acc : fake.script[i] });
              // earlyResolve=true 模拟提前 resolve 但回调仍在继续的竞态
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
      promise.abort = () => {
        aborted = true;
      };
      return promise;
    },
  };
  return { storageMap };
}

installUtools(makeMockDb().db); // 先装宿主再 require（服务模块读 global.utools）
const dbSvc = require(path.join(PRELOAD, "services/db.js"));
const aiSvc = require(path.join(PRELOAD, "services/ai.js"));
const T = aiSvc.__test;
aiSvc.saveConfig({ enabled: true }); // 管线用例默认开启；默认关闭行为在「配置与状态」块单独验证

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
  console.log("[ai] 单元：BYOK 端点归一 / 输出解析");
  {
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
    ok("首句截取", T.firstSentence("第一句。第二句") === "第一句");

    // v1.2：titleNorm 口径由"噱头客观化"放宽为 AI优化标题（防回归到旧口径文案）
    const esys = T.buildEnrichMessages({ title: "t" }, "正文", ["科技"])[0].content;
    ok("enrich prompt 用 AI优化标题口径", esys.includes("AI优化标题") && !esys.includes("噱头"));
    const bsys = T.buildBatchMessages([{ _id: "i", title: "t", summaryText: "s" }], ["科技"])[0].content;
    ok("batch prompt 同口径", bsys.includes("清晰客观") && !bsys.includes("噱头"));
  }

  console.log("[ai] enrich 全链路（流式落库/缓存/额度）");
  let manualUsed;
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    const base = { feedKey: "feed:f1", guid: "g", link: "l", pubTs: 1, summaryText: "first sentence", read: false, starred: false, contentHash: "x", aiStatus: "none" };
    const item = { ...base, _id: "item:f1:h1", title: "Some English Title", titleDisplay: "Some English Title" };
    await db.promises.put(item);
    await db.promises.put({ _id: "itemfull:item:f1:h1", content: "<p>正文内容第一段。第二段讲结论。</p>" });

    fake.script = ["【titleZh】某英文标题的中文版", "【titleNorm】客观改写标题【tags】科技,商业\n", "这是流式摘要。共三句话。第三句收尾。"];
    fake.calls = 0;
    const deltas = [];
    const r = await aiSvc.enrich(item._id, { onDelta: (t) => deltas.push(t) });
    ok("enrich 成功", r.ok && r.ai.summary.includes("流式摘要"));
    ok("流式回调逐块透传", deltas.length === 3);
    const after = await db.promises.get(item._id);
    ok("item.ai 落库（aiSource=enrich）", after.aiStatus === "done" && after.ai.aiSource === "enrich");
    ok("titleNorm 优先写 titleDisplay", after.titleDisplay === "客观改写标题");
    ok("tags ≤2 且入库", after.ai.tags.join() === "科技,商业");
    const enrichCache = await db.promises.allDocs("ai:enrich:");
    ok("缓存文档已写（复合键 v2）", enrichCache.length === 1 && enrichCache[0]._id.startsWith("ai:enrich:v2:"));
    manualUsed = T.loadQuota().manual;
    ok("手动池计 1 次", manualUsed === 1);

    // 缓存命中：同 title + 同正文 → 同复合键，不调引擎
    const item2 = { ...base, _id: "item:f1:h2", title: "Some English Title", titleDisplay: "Some English Title" };
    await db.promises.put(item2);
    await db.promises.put({ _id: "itemfull:item:f1:h2", content: "<p>正文内容第一段。第二段讲结论。</p>" });
    const callsBefore = fake.calls;
    const r2 = await aiSvc.enrich(item2._id);
    ok("缓存命中不调引擎", r2.ok && r2.cached === true && fake.calls === callsBefore);
    const after2 = await db.promises.get(item2._id);
    ok("缓存命中也回写 item", after2.aiStatus === "done" && after2.titleDisplay === "客观改写标题");
    ok("缓存命中不计额度", T.loadQuota().manual === manualUsed);

    // item 层命中：已 enrich 完的直接返回
    const r2b = await aiSvc.enrich(item2._id);
    ok("item 层 enrich 产物直返", r2b.cached === true && fake.calls === callsBefore);

    // bypass：跳过缓存直调
    const r3 = await aiSvc.enrich(item._id, { bypass: true });
    ok("bypass 重调引擎", r3.ok && !r3.cached && fake.calls === callsBefore + 1);
    manualUsed = T.loadQuota().manual;
    ok("bypass 计额度", manualUsed === 2);
  }

  console.log("[ai] abort 原子性（H2）与已产出计额（F4）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const item = { _id: "item:f1:a1", feedKey: "feed:f1", title: "T", titleDisplay: "T", aiStatus: "none" };
    await db.promises.put(item);
    await db.promises.put({ _id: "itemfull:item:f1:a1", content: "<p>正文</p>" });
    fake.script = ["第一块产出", "第二块产出", "第三块产出"];
    const p = aiSvc.enrich(item._id, {});
    await sleep(12); // 等第一块流出
    aiSvc.abort();
    const r = await p;
    ok("abort 返回 aborted", !r.ok && r.aborted === true);
    const after = await db.promises.get(item._id);
    ok("abort 不落库不落缓存（H2）", after.aiStatus === "none" && !after.ai && (await db.promises.allDocs("ai:")).length === 0);
    ok("abort 已产出文本计入额度（F4）", T.loadQuota().manual === 1);
  }

  console.log("[ai] 截断防御：快照式流 / 提前 resolve 竞态");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const mk = (id) => ({ _id: id, feedKey: "feed:s", guid: id, title: "T" + id, titleDisplay: "T" + id, pubTs: 1, summaryText: "首句", aiStatus: "none" });

    // 快照式流（回调给累计全文而非增量）——不兼容会把累计拼成乱串
    const s1 = mk("item:s:1");
    await db.promises.put(s1);
    await db.promises.put({ _id: "itemfull:item:s:1", content: "<p>正文</p>" });
    fake.snapshot = true;
    fake.script = ["【titleZh】", "【titleNorm】客观改写【tags】科技\n", "快照流摘要第一句。第二句。"];
    const r1 = await aiSvc.enrich(s1._id, {});
    ok("快照式流回调不产生重复乱串", r1.ok && r1.ai.summary === "快照流摘要第一句。第二句。" && r1.ai.titleNorm === "客观改写");

    // 提前 resolve 竞态——resolve 早于回调完成，宽限期后取完整累计
    const s2 = mk("item:s:2");
    await db.promises.put(s2);
    await db.promises.put({ _id: "itemfull:item:s:2", content: "<p>正文</p>" });
    fake.snapshot = false;
    fake.earlyResolve = true;
    fake.script = ["【titleZh】【titleNorm】【tags】科技\n", "早退竞态下仍要拿全摘要。", "第三句。"];
    const r2 = await aiSvc.enrich(s2._id, {});
    ok("提前 resolve 后宽限取全内容", r2.ok && r2.ai.summary.includes("第三句。"));
    fake.earlyResolve = false;

    // 引擎永不 resolve——硬超时兜底退出，UI 不会永远转圈
    const s3 = mk("item:s:3");
    await db.promises.put(s3);
    await db.promises.put({ _id: "itemfull:item:s:3", content: "<p>正文</p>" });
    fake.hang = true;
    T.setEngineTimeout(120);
    const t0 = Date.now();
    const r3 = await aiSvc.enrich(s3._id, {});
    const elapsed = Date.now() - t0;
    ok("引擎挂起时硬超时退出", !r3.ok && r3.error === "ENGINE_TIMEOUT" && elapsed < 2000);
    const s3doc = await db.promises.get(s3._id);
    ok("超时落 error 可重试", s3doc.aiStatus === "error");
    fake.hang = false;
    T.setEngineTimeout(60000);
  }

  console.log("[ai] 失败降级：error 状态 / 旧产物保留");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const item = { _id: "item:f1:e1", feedKey: "feed:f1", title: "T", titleDisplay: "T", aiStatus: "none" };
    await db.promises.put(item);
    await db.promises.put({ _id: "itemfull:item:f1:e1", content: "<p>正文</p>" });
    fake.fail = "reject";
    fake.script = [];
    const r = await aiSvc.enrich(item._id, {});
    ok("引擎失败返回 error", !r.ok && r.error === "ENGINE_ERROR");
    let after = await db.promises.get(item._id);
    ok("无产物失败 → aiStatus=error 且不计额", after.aiStatus === "error" && T.loadQuota().manual === 0);

    // 已 done 的文章重生成失败：旧摘要保留可读
    fake.script = ["【titleZh】【titleNorm】【tags】科技\n旧摘要生成成功。"];
    fake.fail = null;
    await aiSvc.enrich(item._id, { bypass: true });
    after = await db.promises.get(item._id);
    ok("重生成成功恢复 done", after.aiStatus === "done" && after.ai.summary === "旧摘要生成成功。");
    fake.fail = "reject";
    await aiSvc.enrich(item._id, { bypass: true });
    after = await db.promises.get(item._id);
    ok("重生成失败保留旧产物", after.aiStatus === "done" && after.ai.summary === "旧摘要生成成功。");
    fake.fail = null;
  }

  console.log("[ai] 额度分池：耗尽拒绝 / 跨日重置 / BYOK 豁免");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    const item = { _id: "item:f1:q1", feedKey: "feed:f1", title: "T", titleDisplay: "T", aiStatus: "none" };
    await db.promises.put(item);
    await db.promises.put({ _id: "itemfull:item:f1:q1", content: "<p>正文</p>" });
    const callsBefore = fake.calls;
    global.utools.dbStorage.setItem("airss:ai-quota", JSON.stringify({ date: today(), manual: 120, bg: 30 }));
    const r = await aiSvc.enrich(item._id, {});
    ok("手动池耗尽直接拒绝", !r.ok && r.error === "QUOTA_EXHAUSTED" && fake.calls === callsBefore);

    const byok = T.quotaCheck("manual", { engine: "byok" });
    ok("BYOK 豁免额度", byok.ok === true);

    global.utools.dbStorage.setItem("airss:ai-quota", JSON.stringify({ date: "2000-01-01", manual: 120, bg: 30 }));
    ok("跨日自动重置", T.loadQuota().manual === 0);
    raw.clear();
  }

  console.log("[ai] 轻量批：JSON 回写 / H4 复验 / T-21 不覆盖 enrich");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const mk = (id, status, ai) => ({ _id: id, feedKey: "feed:b", guid: id, title: "标题" + id, titleDisplay: "标题" + id, pubTs: 1, summaryText: "首句内容", aiStatus: status, ...(ai ? { ai } : {}) });
    const b1 = mk("item:b:1", "none");
    const b2 = mk("item:b:2", "done", { summary: "已有", tags: [], titleZh: "", titleNorm: "enrich 改写", aiSource: "enrich" });
    const b3 = mk("item:b:3", "none");
    for (const d of [b1, b2, b3]) await db.promises.put(d);

    fake.calls = 0;
    fake.script = [JSON.stringify([
      { id: b1._id, tags: ["设计", "工具"], titleZh: "", titleNorm: "客观陈述式标题" },
      { id: b3._id, tags: "单字符串标签", titleZh: "中文翻译标题" },
      { id: "item:b:999", tags: ["幽灵"], titleZh: "不存在的篇" },
    ])];
    const r = await aiSvc.batchEnrich([b1, b2, b3]);
    ok("轻量批成功", r.ok && r.error === null);
    const a1 = await db.promises.get(b1._id);
    ok("b1 回写 tags+titleNorm", a1.aiStatus === "done" && a1.ai.tags.join() === "设计,工具" && a1.titleDisplay === "客观陈述式标题");
    const a2 = await db.promises.get(b2._id);
    ok("done 篇跳过", a2.ai.titleNorm === "enrich 改写");
    const a3 = await db.promises.get(b3._id);
    ok("字符串 tags 兼容解析 + titleZh 展示", a3.ai.tags.join() === "单字符串标签" && a3.titleDisplay === "中文翻译标题");
    ok("幽灵篇不炸且不回写（按篇隔离）", (await db.promises.get("item:b:999")) === null && r.updated.every((u) => u._id !== "item:b:999"));
    const clsCache = await db.promises.allDocs("ai:cls:");
    ok("轻量批缓存已写（v2）", clsCache.length === 2 && clsCache.every((c) => c._id.startsWith("ai:cls:v2:")));
    ok("后台池计 1 次", T.loadQuota().bg === 1);
    ok("后台池不计手动池", T.loadQuota().manual === 0);

    // T-21：enrich 产物不被后续 batch 覆盖
    const r2 = await T.applyAi(b1, { summary: "", tags: ["别的"], titleZh: "", titleNorm: "" }, "enrich");
    const r3 = await T.applyAi(r2, { summary: "", tags: ["batch 标签"], titleZh: "", titleNorm: "" }, "batch");
    ok("batch 不覆盖 enrich 产物（T-21）", r3.ai.aiSource === "enrich" && r3.ai.tags.join() === "别的");
    // H4：item 已被清理 → 回写安全返回 null
    ok("item 已删除时回写返回 null（H4）", (await T.applyAi({ _id: "item:gone" }, { summary: "" }, "batch")) === null);

    // 坏 JSON 整批失败
    fake.script = ["这不是 JSON"];
    const r4 = await aiSvc.batchEnrich([{ ...mk("item:b:4", "none"), _id: "item:b:4" }]);
    ok("坏 JSON 输出报错不入库", !r4.ok && r4.error === "BAD_JSON_OUTPUT" && (await db.promises.get("item:b:4")) === null);
  }

  console.log("[db→ai] ingest 内容变化清 AI 字段（T-09）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:t9", url: "https://e/feed", title: "T", unreadCount: 0, lastFetchedAt: null };
    await dbSvc.ingestFeed(feed, [{ guid: "g9", link: "https://e/9", title: "标题九", contentHtml: "<p>九</p>", contentHash: "hash9", summaryText: "九", cover: null, pubTs: 9 }], {});
    const it9 = (await dbSvc.itemsOfFeed("feed:t9"))[0];
    const saved = await T.applyAi(it9, { summary: "s", tags: ["科技"], titleZh: "", titleNorm: "改写标题" }, "enrich");
    ok("AI 产物已写", saved.aiStatus === "done" && saved.titleDisplay === "改写标题");
    await T.applyTrans(it9, [{ idx: 0, head: "九", text: "九" }], { "0": "九的译文" }, "m");
    ok("段落译文已写", (await db.promises.get(it9._id)).aiTrans.paras.length === 1);
    await dbSvc.ingestFeed(feed, [{ guid: "g9", link: "https://e/9", title: "标题九", contentHtml: "<p>九改</p>", contentHash: "hash9new", summaryText: "九改", cover: null, pubTs: 9 }], {});
    const now = await db.promises.get(it9._id);
    ok("contentHash 变化 → ai/aiTrans 清空、aiStatus=none、标题复位", now.aiStatus === "none" && now.ai === undefined && now.aiTrans === undefined && now.titleDisplay === "标题九");
  }

  console.log("[ai] 段落翻译 translateItem（v1.2）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const item = { _id: "item:tr:1", feedKey: "feed:tr", title: "T", titleDisplay: "T", aiStatus: "done", ai: { summary: "s", tags: [], titleZh: "", titleNorm: "", aiSource: "enrich" } };
    await db.promises.put(item);
    const paras = [
      { idx: 0, head: "English paragraph one", text: "English paragraph one about something." },
      { idx: 1, head: "Second paragraph here", text: "Second paragraph here with more words." },
    ];

    ok("CJK 占比判定", T.cjkRatio("这是中文内容") > 0.5 && T.cjkRatio("plain english words") < 0.2);
    const parsed = T.parseTransOutput("[[0]]第一段译文 [备注] 内容\n[[1]]第二段译文");
    ok("[[n]] 协议解析，译文含 [ 不截断", parsed.texts["0"].includes("[备注]") && parsed.texts["1"] === "第二段译文" && parsed.count === 2);
    ok("缺段隔离（只出一篇）", T.parseTransOutput("[[0]]只有第一段").count === 1);

    fake.calls = 0;
    const cn = await aiSvc.translateItem(item._id, [{ idx: 0, head: "中文段落", text: "这是一段以中文为主的正文段落，中文占比远超一半应当直接门控不调引擎。" }], {});
    ok("中文为主 NO_NEED 且不调引擎", !cn.ok && cn.error === "NO_NEED" && fake.calls === 0);

    fake.script = ["[[0]]第一段译文 [备注] 内容\n", "[[1]]第二段译文"];
    const r = await aiSvc.translateItem(item._id, paras, {});
    ok("翻译成功并返回 aiTrans", r.ok && r.aiTrans && r.aiTrans.paras.length === 2 && r.aiTrans.paras[0].text.includes("[备注]"));
    const after = await db.promises.get(item._id);
    ok("aiTrans 落库（head 配对留档）", after.aiTrans.paras[1].head === paras[1].text.slice(0, 20) && after.aiTrans.model.length > 0);
    ok("手动池计 1 次", T.loadQuota().manual === 1);
    ok("翻译缓存已写", (await db.promises.allDocs("ai:trans:")).length === 1);

    const calls = fake.calls;
    const r2 = await aiSvc.translateItem(item._id, paras, {});
    ok("item 层已有译文直返（cached）", r2.ok && r2.cached === true && fake.calls === calls);

    const item2 = { _id: "item:tr:2", feedKey: "feed:tr", title: "T2", titleDisplay: "T2", aiStatus: "none" };
    await db.promises.put(item2);
    fake.script = ["没有任何标记的纯文本输出"];
    const r3 = await aiSvc.translateItem(item2._id, [{ idx: 0, head: "abc", text: "some english words here ok" }], {});
    ok("无标记输出报 BAD_TRANS_OUTPUT 不回写", !r3.ok && r3.error === "BAD_TRANS_OUTPUT" && !(await db.promises.get("item:tr:2")).aiTrans);

    // 空段落入参：不炸、不调引擎
    const r4 = await aiSvc.translateItem(item2._id, [], {});
    ok("空 paras 返回 NO_PARAS", !r4.ok && r4.error === "NO_PARAS");

    // abort 全弃 + 已产出计额（F4 同构）
    const item3 = { _id: "item:tr:3", feedKey: "feed:tr", title: "T3", titleDisplay: "T3", aiStatus: "none" };
    await db.promises.put(item3);
    fake.script = ["[[0]]第一段开头产出", "[[1]]不会到达的第二段"];
    const p3 = aiSvc.translateItem(item3._id, [{ idx: 0, head: "abc", text: "some english words here ok" }], {});
    await sleep(12); // 等第一块流出
    aiSvc.abort();
    const r5 = await p3;
    ok("翻译中止全弃（H2）且已产出计额（F4）", !r5.ok && r5.aborted === true && !(await db.promises.get("item:tr:3")).aiTrans && T.loadQuota().manual === 3);

    // 纯内容键缓存：同文跨源命中不调引擎（feed 联播场景）
    const item4 = { _id: "item:tr:4", feedKey: "feed:other", title: "T4", titleDisplay: "T4", aiStatus: "none" };
    await db.promises.put(item4);
    const callsBefore = fake.calls;
    const r6 = await aiSvc.translateItem(item4._id, paras, {});
    ok("同文跨源缓存命中回写", r6.ok && r6.cached === true && r6.aiTrans && r6.aiTrans.paras.length === 2 && fake.calls === callsBefore);
    ok("缓存命中不计额度", T.loadQuota().manual === 3);
  }

  console.log("[ai] AI 目录 generateToc（v1.4，PLAN-AI-TOC）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const item = { _id: "item:toc:1", feedKey: "feed:toc", title: "长文标题", titleDisplay: "长文标题", aiStatus: "none" };
    await db.promises.put(item);
    const paras = [
      { idx: 0, head: "开头段讲述了背景与动机", text: "开头段讲述了背景与动机，交代来龙去脉。" },
      { idx: 1, head: "第二段展开核心问题", text: "第二段展开核心问题，提出三个假设。" },
      { idx: 2, head: "第三段给出实验数据", text: "第三段给出实验数据，样本量一万人。" },
      { idx: 3, head: "结尾段总结全文", text: "结尾段总结全文并展望后续工作方向。" },
    ];

    // 单元：[[idx]]标题 行协议解析
    const parsed = T.parseTocOutput("[[0]]背景与动机\n[[2]]实验与数据\n[[2]]重复条目应丢弃\n[[9]]越界章\n说明行不匹配\n[[3]]结论与展望");
    ok("行协议解析（说明行自然丢弃，升序排列）", parsed.count === 4 && parsed.sections[0].idx === 0 && parsed.sections[1].title === "实验与数据" && parsed.sections[2].idx === 3 && parsed.sections[3].idx === 9);
    ok("重复 idx 保首条去重", !parsed.sections.some((s) => s.title === "重复条目应丢弃"));
    ok("超长标题截 24 字", T.parseTocOutput("[[0]]" + "长".repeat(40)).sections[0].title.length === 24);
    ok("空/无标记输出 count=0", T.parseTocOutput("没有任何标记").count === 0 && T.parseTocOutput("").count === 0);
    ok("输出按 idx 升序", T.parseTocOutput("[[3]]c\n[[1]]a\n[[2]]b").sections.map((s) => s.idx).join() === "1,2,3");

    // 单元：锚点过滤（head 按 idx 查表补全、越界丢弃）
    const anchored = T.tocAnchorSections(paras, parsed.sections);
    ok("head 从当前输入段落补全（≤20 字）", anchored[0].head === "开头段讲述了背景与动机" && anchored.every((s) => s.head.length <= 20));
    ok("idx 越界条目丢弃", !anchored.some((s) => s.idx === 9) && anchored.length === 3);

    // 门控
    fake.calls = 0;
    ok("item 不存在 NOT_FOUND", !((await aiSvc.generateToc("item:toc:none", paras, {})).ok) && fake.calls === 0);
    ok("空 paras 返回 NO_PARAS", (await aiSvc.generateToc(item._id, [], {})).error === "NO_PARAS" && fake.calls === 0);

    // 全链路：生成成功
    fake.script = ["[[0]]背景与动机\n", "[[2]]实验与数据\n[[3]]结论与展望"];
    const r = await aiSvc.generateToc(item._id, paras, {});
    ok("目录生成成功", r.ok && r.aiToc && r.aiToc.sections.length === 3 && !r.cached);
    const after = await db.promises.get(item._id);
    ok("aiToc 落库（head=段首 20 字）", after.aiToc.sections[1].head === paras[2].head && after.aiToc.model.length > 0);
    ok("手动池计 1 次", T.loadQuota().manual === 1);
    const tocCache = await db.promises.allDocs("ai:toc:");
    ok("目录缓存已写且不含 head（命中路径重补）", tocCache.length === 1 && tocCache[0]._id.startsWith("ai:toc:v1:") && tocCache[0].result.sections.every((s) => s.head === undefined));

    const calls = fake.calls;
    const r2 = await aiSvc.generateToc(item._id, paras, {});
    ok("item 层已有目录直返（cached）", r2.ok && r2.cached === true && fake.calls === calls);

    // 纯内容键缓存：同文跨源命中（feed 联播场景）
    const item2 = { _id: "item:toc:2", feedKey: "feed:other", title: "联播同文", titleDisplay: "联播同文", aiStatus: "none" };
    await db.promises.put(item2);
    const r3 = await aiSvc.generateToc(item2._id, paras, {});
    ok("同文跨源缓存命中并重补 head", r3.ok && r3.cached === true && r3.aiToc.sections.length === 3 && r3.aiToc.sections[0].head === paras[0].head && fake.calls === calls);
    ok("缓存命中不计额度", T.loadQuota().manual === 1);

    // 坏输出整体降级（负路径用 paras2 换内容，避开与上文同文的纯内容缓存命中）
    const paras2 = paras.map((p) => ({ idx: p.idx, head: p.head, text: p.text + " different content here." }));
    const item3 = { _id: "item:toc:3", feedKey: "feed:toc", title: "坏输出", titleDisplay: "坏输出", aiStatus: "none" };
    await db.promises.put(item3);
    fake.script = ["没有任何标记的输出"];
    const r4 = await aiSvc.generateToc(item3._id, paras2, {});
    ok("无标记输出 BAD_TOC_OUTPUT 不回写", !r4.ok && r4.error === "BAD_TOC_OUTPUT" && !(await db.promises.get("item:toc:3")).aiToc);
    fake.script = ["[[99]]只有一个越界章"];
    const r4b = await aiSvc.generateToc(item3._id, paras2, {});
    ok("idx 全越界同样 BAD_TOC_OUTPUT（锚点不可用）", !r4b.ok && r4b.error === "BAD_TOC_OUTPUT" && fake.calls === calls + 2);

    // abort 全弃 + 已产出计额（F4 同构）
    const item4 = { _id: "item:toc:4", feedKey: "feed:toc", title: "中止", titleDisplay: "中止", aiStatus: "none" };
    await db.promises.put(item4);
    fake.script = ["[[0]]开头产出", "[[3]]不会到达的末章"];
    const p5 = aiSvc.generateToc(item4._id, paras2, {});
    await sleep(12); // 等第一块流出
    aiSvc.abort();
    const r5 = await p5;
    ok("中止全弃（H2）且已产出计额（F4）", !r5.ok && r5.aborted === true && !(await db.promises.get("item:toc:4")).aiToc && T.loadQuota().manual === 4);

    // T-09 同族：ingest contentHash 变化连带清 aiToc
    const feed9 = { _id: "feed:toc9", url: "https://e/toc", title: "T9", unreadCount: 0, lastFetchedAt: null };
    await dbSvc.ingestFeed(feed9, [{ guid: "g9", link: "https://e/9", title: "标题", contentHtml: "<p>一</p>", contentHash: "h1", summaryText: "一", cover: null, pubTs: 9 }], {});
    const it9 = (await dbSvc.itemsOfFeed("feed:toc9"))[0];
    await T.applyToc(it9, paras, parsed.sections, "m");
    ok("目录已写（回写前 get 复验通过）", (await db.promises.get(it9._id)).aiToc.sections.length === 3);
    await dbSvc.ingestFeed(feed9, [{ guid: "g9", link: "https://e/9", title: "标题", contentHtml: "<p>一改</p>", contentHash: "h2", summaryText: "一改", cover: null, pubTs: 9 }], {});
    ok("contentHash 变化 → aiToc 连带清空（T-09 同族）", (await db.promises.get(it9._id)).aiToc === undefined);

    // B-1：生成期间全文提取落库 → 产物弃写（额度已计）
    const item5 = { _id: "item:toc:5", feedKey: "feed:toc", title: "竞态", titleDisplay: "竞态", aiStatus: "none" };
    await db.promises.put(item5);
    fake.script = ["[[0]]开头", "[[3]]结尾章"];
    const p6 = aiSvc.generateToc(item5._id, paras2, {});
    await sleep(6); // 调用进行中，模拟提取层此刻落库
    await db.promises.put({ _id: "itemfullx:" + item5._id, content: "<p>新全文</p>", at: Date.now(), src: "readability" });
    const r6 = await p6;
    ok("提取替换正文产物弃写（B-1，额度已计）", !r6.ok && r6.error === "CONTENT_CHANGED" && !(await db.promises.get("item:toc:5")).aiToc && T.loadQuota().manual === 5);

    // 限幅：200 字/段 × 60 段 = 12000 字 > TOC_MAX_CHARS → 只收纳前 ~50 段，越界锚点章丢弃
    const item6 = { _id: "item:toc:6", feedKey: "feed:toc", title: "限幅", titleDisplay: "限幅", aiStatus: "none" };
    await db.promises.put(item6);
    const big = Array.from({ length: 60 }, (_, i) => ({ idx: i, head: "第" + i + "段标题占位文本", text: "x".repeat(200) }));
    fake.script = ["[[0]]第一章\n[[59]]末章"];
    const r7 = await aiSvc.generateToc(item6._id, big, {});
    ok("TOC_MAX_CHARS 截断：覆盖外锚点章丢弃", r7.ok && r7.aiToc.sections.length === 1 && r7.aiToc.sections[0].idx === 0);

    // bypass：跳过 item 层与缓存直调引擎
    fake.script = ["[[1]]第二章改"];
    const r8 = await aiSvc.generateToc(item._id, paras, { bypass: true });
    ok("bypass 跳过两层缓存直调引擎", r8.ok && !r8.cached && r8.aiToc.sections.length === 1 && fake.calls === calls + 6);
  }

  console.log("[ai] 发起序双飞防御（阶段C：前奏中被超越的调用自弃）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const item = { _id: "item:cl:1", feedKey: "feed:cl", title: "T", titleDisplay: "T", aiStatus: "none" };
    await db.promises.put(item);
    await db.promises.put({ _id: "itemfull:item:cl:1", content: "<p>Body words here for enrich test</p>" });
    fake.calls = 0;
    fake.script = ["【titleZh】【titleNorm】【tags】科技\n摘要内容。"];
    const p = aiSvc.enrich(item._id, {});
    aiSvc.abort(); // 同步打断：enrich 尚在前奏（首个 await 之后、引擎起飞之前）
    const r = await p;
    ok("前奏中被超越的调用自弃，不调引擎不计额", !r.ok && r.aborted === true && fake.calls === 0 && T.loadQuota().manual === 0);
  }

  console.log("[ai] 配置与状态");
  {
    global.utools.dbStorage.removeItem("airss:ai-config");
    const cfg0 = aiSvc.getConfig();
    ok("默认配置：关闭 + utools 引擎", cfg0.engine === "utools" && cfg0.enabled === false);
    const gate = await aiSvc.enrich("item:none", {});
    ok("默认关闭时 enrich 直接拒绝", !gate.ok && gate.error === "AI_DISABLED");
    aiSvc.saveConfig({ enabled: true, engine: "byok", byokBaseUrl: "https://api.x.com/v1" });
    ok("配置可改（含开关开启）", aiSvc.getConfig().enabled === true && aiSvc.getConfig().engine === "byok");
    aiSvc.saveConfig({ model: "aimodels/abc123", modelLabel: "deepseek-v4-flash" });
    ok("模型 id+可读名同步保存（日志显示用）", aiSvc.getConfig().model === "aimodels/abc123" && aiSvc.getConfig().modelLabel === "deepseek-v4-flash");
    aiSvc.setByokKey("sk-test");
    ok("密钥加密层存取", aiSvc.hasByokKey() === true);
    const st = await aiSvc.getStatus();
    ok("getStatus 反映引擎与额度", st.engine === "byok" && st.exempt === true && st.quota.manualMax === 120 && Array.isArray(st.models));
    aiSvc.saveConfig({ engine: "utools" });
    aiSvc.setByokKey("");
    ok("清密钥", aiSvc.hasByokKey() === false);
  }

  console.log("[log] 诊断日志");
  {
    const logger = require(path.join(PRELOAD, "services/logger.js"));
    const before = logger.getLogs().length;
    ok("AI/刷新流程已有日志写入", before > 0);
    const dump = logger.dumpText();
    ok("dumpText 含引擎调用与解析记录", dump.includes("ai.enrich") && dump.includes("解析产物"));
    ok("日志不含 BYOK 密钥类字段", !dump.includes("Authorization"));
    logger.clear();
    ok("清空生效", logger.getLogs().length === 0);
    logger.info("test", "hello", { a: 1 });
    const after = logger.dumpText();
    ok("写入与格式化", after.includes("hello") && after.includes('"a":1') && logger.getLogs().length === 1);
  }

  console.log("[ai×extract] 翻译与全文提取并发（PLAN-V1.3 A 送审必改 B-1 回归）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage.removeItem("airss:ai-quota");
    const extractSvc = require(path.join(PRELOAD, "services/extract.js"));
    const FX = Buffer.from(`<html><head><title>t</title></head><body><article><h1>Full</h1>${"<p>English body paragraph long enough to pass the six hundred chars threshold for extraction. ".repeat(20)}</article></body></html>`);
    extractSvc.__test.ctx.nodeFetch = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html" }, body: FX, truncated: false, error: null });

    await db.promises.put({ _id: "feed:x9", url: "https://e/f", title: "x", fullText: true });
    // 不带 aiTrans 种子：真实竞态是「首次翻译在飞」——带旧译文会在入口 item 层命中短路，引擎根本不起飞
    const item = { _id: "item:x9:1", feedKey: "feed:x9", guid: "g", link: "https://ex/a", title: "T", titleDisplay: "T", aiStatus: "done", ai: { summary: "s", tags: [], titleZh: "", titleNorm: "", aiSource: "enrich" } };
    await db.promises.put(item);

    // 竞态：引擎在飞（10 块 × sleep 4ms ≈ 40ms 窗口）期间全文提取落库并连带清 aiTrans
    fake.calls = 0;
    fake.fail = null;
    fake.hang = false;
    fake.snapshot = false;
    fake.earlyResolve = false;
    fake.script = ["[[0]]fresh", " translation", " for old", " paras,", " chunk", " one", " and", " more", " chunks", " tail."];
    const p = aiSvc.translateItem(item._id, [{ idx: 0, head: "Old summary head", text: "Old summary paragraph in english." }], {});
    await new Promise((r) => setTimeout(r, 8)); // 引擎跑到中途
    const ex = await extractSvc.ensureFull(item._id);
    const tr = await p;
    ok("提取期间完成（fetched）", ex.status === "fetched");
    ok("翻译产物被弃写（CONTENT_CHANGED）", tr.ok === false && tr.error === "CONTENT_CHANGED");
    ok("item.aiTrans 未被复活", (await db.promises.get(item._id)).aiTrans === undefined);
    ok("ai.summary 仍保留", (await db.promises.get(item._id)).ai != null);

    // 对照：提取已落库（at < 新翻译的 t0），其后发起的翻译正常写回
    fake.script = ["[[0]]translation aligned to new full text."];
    const tr2 = await aiSvc.translateItem(item._id, [{ idx: 0, head: "New fulltext head", text: "New fulltext paragraph english." }], {});
    ok("提取后的新翻译正常写回", tr2.ok === true && !!tr2.aiTrans && (await db.promises.get(item._id)).aiTrans != null);
  }

  console.log("\nAI 管线测试通过：" + pass + " 项");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
