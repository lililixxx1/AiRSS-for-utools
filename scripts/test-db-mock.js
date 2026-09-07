/**
 * test-db-mock.js — 用内存版 utools.db mock 直测数据层与刷新管线（Node 可跑，无需 uTools 宿主）
 * 覆盖：ingest 判重/更新策略/写序推进、read/starred 保留、unreadCount 对账、保留清理、级联删除、
 *       端到端 refreshOne（真实网络抓取 → 解析 → 入库 → feed 推进）
 * 用法：node scripts/test-db-mock.js
 */
const assert = require("assert");
const path = require("path");
const PRELOAD = path.join(__dirname, "..", "preload");

// ---- 内存版 utools.db（模拟 _rev 语义 + bulkDocs） ----
function makeMockDb() {
  const docs = new Map();
  let revSeq = 1;
  const res = (ok, id, extra) => ({ ok, id, rev: "r" + revSeq++, ...(extra || {}) });
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

global.utools = { db: null };
const dbSvc = require(path.join(PRELOAD, "services/db.js"));
const scheduler = require(path.join(PRELOAD, "services/scheduler.js"));

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error("FAIL: " + name);
  pass += 1;
  console.log("  ✓ " + name);
};

function mkItems(overrides) {
  const base = [
    { guid: "g1", link: "https://e/1", title: "文章A", contentHtml: "<p>内容A</p>", contentHash: "aaa111", summaryText: "摘要A", cover: null, pubTs: 1000 },
    { guid: "g2", link: "https://e/2", title: "文章B", contentHtml: "<p>内容B</p>", contentHash: "bbb222", summaryText: "摘要B", cover: null, pubTs: 2000 },
    { guid: "g3", link: "https://e/3", title: "文章C", contentHtml: "<p>内容C</p>", contentHash: "ccc333", summaryText: "摘要C", cover: null, pubTs: 3000 },
  ];
  return overrides ? base.map((b) => (overrides[b.guid] ? { ...b, ...overrides[b.guid] } : b)) : base;
}

(async () => {
  console.log("[db] ingest 判重/更新策略/写序");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:t1", url: "https://e/feed", title: "测试源", unreadCount: 0, lastFetchedAt: null };

    let r = await dbSvc.ingestFeed(feed, mkItems(), { etag: "W/1", lastModified: "LM1" });
    ok("首轮入库 3 篇", r.ok && r.newCount === 3 && r.updatedCount === 0);
    ok("lastFetchedAt 推进", typeof feed.lastFetchedAt === "number");
    ok("unreadCount=3", feed.unreadCount === 3);
    ok("etag 写入", feed.etag === "W/1");
    ok("itemfull 已写", (await db.promises.get("itemfull:item:feed:t1:" + dbSvc.sha12("g1"))) !== null);

    // 模拟用户已读+星标
    const items = await dbSvc.itemsOfFeed("feed:t1");
    await dbSvc.setRead(items[0]._id, true);
    await dbSvc.setStarred(items[1]._id, true);

    // 二轮：g2 内容变化，g1/g3 不变，新增 g4
    r = await dbSvc.ingestFeed(feed, mkItems({ g2: { title: "文章B改", contentHtml: "<p>内容B2</p>", contentHash: "bbb999" } }).concat([
      { guid: "g4", link: "https://e/4", title: "文章D", contentHtml: "<p>D</p>", contentHash: "ddd444", summaryText: "D", cover: null, pubTs: 4000 },
    ]), { etag: "W/2", lastModified: "LM2" });
    ok("二轮 新1 改1", r.ok && r.newCount === 1 && r.updatedCount === 1);
    const after = await dbSvc.itemsOfFeed("feed:t1");
    ok("共 4 篇", after.length === 4);
    const readItem = after.find((x) => x.guid === "g1");
    const starItem = after.find((x) => x.guid === "g2");
    ok("更新策略：read 恒保留", readItem.read === true);
    ok("更新策略：starred 恒保留", starItem.starred === true);
    ok("内容变化才覆盖（标题已更新）", starItem.title === "文章B改");
    ok("unreadCount 对账=3（g2/g3 未读 + 新增 g4）", feed.unreadCount === 3);

    // guid 稳定性：源方改标题后 id 不变（不产生重复文章）
    r = await dbSvc.ingestFeed(feed, mkItems({ g1: { title: "文章A改标题", contentHash: "aaa111" } }), { etag: "W/3" });
    const final = await dbSvc.itemsOfFeed("feed:t1");
    ok("源方改标题不产生重复", final.length === 4 && r.newCount === 0);
  }

  console.log("[db] 标记与批量");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:t2", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
    await dbSvc.ingestFeed(feed, mkItems(), {});
    const items = await dbSvc.itemsOfFeed("feed:t2");
    const n = await dbSvc.markManyRead(items.map((x) => x._id));
    ok("批量已读 3", n === 3);
    ok("对账归零", (await dbSvc.recalcUnread(feed)) === 0);
    ok("重复批量为 0", (await dbSvc.markManyRead(items.map((x) => x._id))) === 0);
  }

  console.log("[db] 保留清理与级联删除");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:t3", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
    const many = [];
    for (let i = 0; i < 6; i++) many.push({ guid: "k" + i, link: "l" + i, title: "T" + i, contentHtml: "<p>x</p>", contentHash: "h" + i, summaryText: "s", cover: null, pubTs: i * 1000 });
    await dbSvc.ingestFeed(feed, many, {});
    // 最新一篇（pubTs 最大 = k5）设星标；itemsOfFeed 为插入序，需按 pubTs 找
    const all = await dbSvc.itemsOfFeed("feed:t3");
    const newest = all.reduce((a, b) => (b.pubTs > a.pubTs ? b : a));
    await dbSvc.setStarred(newest._id, true); // k5

    // keep=3：非星标按 pubTs 降序留 3（k4/k3/k2），最老的 k0/k1 被清 → 存活 k5,k4,k3,k2
    const removed = await dbSvc.retentionClean(feed, 3);
    items = await dbSvc.itemsOfFeed("feed:t3");
    ok("保留 3 篇 + 星标豁免 1 篇（共 4）", items.length === 4 && removed === 2);
    ok("被清的是最老两篇", items.every((x) => ["k2", "k3", "k4", "k5"].includes(x.guid)));
    ok("itemfull 连带清理", (await db.promises.get("itemfull:item:feed:t3:" + dbSvc.sha12("k0"))) === null);

    // 清理前复查星标：给将被清理的篇目设星标 → 应被跳过（keep=1 时 k2 本该被清）
    await dbSvc.setStarred(items.find((x) => x.guid === "k2")._id, true);
    const removed2 = await dbSvc.retentionClean(feed, 1);
    const after2 = await dbSvc.itemsOfFeed("feed:t3");
    ok("删除前复查星标（k2 星标不被误删）", after2.some((x) => x.guid === "k2") && removed2 <= 2);

    const cnt = await dbSvc.deleteFeedCascade(feed);
    ok("级联删除全部", cnt >= 2 && (await dbSvc.itemsOfFeed("feed:t3")).length === 0);
  }

  console.log("[scheduler] 端到端 refreshOne（真实抓取阮一峰 → 入库 → feed 推进）");
  {
    const { db } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:real", url: "https://www.ruanyifeng.com/blog/atom.xml", title: "", unreadCount: 0, lastFetchedAt: null, etag: "", lastModified: "" };
    const r = await scheduler.refreshOne(feed);
    ok("刷新 ok", r.ok && r.status === "ok");
    ok("抓到文章（" + r.newCount + " 篇）", r.newCount > 0);
    ok("feed 标题回填", feed.title.includes("阮一峰"));
    ok("lastFetchedAt 推进", typeof feed.lastFetchedAt === "number");
    ok("unreadCount=newCount", feed.unreadCount === r.newCount);
    const items = await dbSvc.itemsOfFeed("feed:real");
    ok("item 含正文分层", (await dbSvc.getItemFull(items[0]._id)) !== null);
    console.log("  · 最新一篇：" + items[0].title.slice(0, 32) + "…");
  }

  console.log("[db] 渲染层 Proxy 文档入库（实机 'An object could not be cloned.' 回归）");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    const seen = [];
    const origPut = db.put;
    db.put = (doc) => (seen.push(doc), origPut(doc));

    // 渲染层 store 里的 feed/item 是 Vue reactive Proxy：本地 mock 感知不到，实机 IPC 必炸
    const feed = new Proxy({ _id: "feed:px", url: "https://e/f", title: "代理源", unreadCount: 9, lastFetchedAt: null, etag: "" }, {});
    const saved = await dbSvc.putRetry(feed);
    ok("putRetry 接受 Proxy 文档", !!saved && !!raw.get("feed:px"));
    ok("db.put 收到的是普通克隆（非原代理引用）", seen[0] !== feed && seen[0]._id === "feed:px" && seen[0].title === "代理源");
    ok("_rev 仍回写到调用方对象", typeof feed._rev === "string");

    // recalcUnread（App.vue 启动时对每个 store feed 调用）：此前实机未处理拒绝
    raw.set("item:feed:px:1", { _id: "item:feed:px:1", feedKey: "feed:px", read: true, starred: false, pubTs: 1 });
    raw.set("item:feed:px:2", { _id: "item:feed:px:2", feedKey: "feed:px", read: false, starred: false, pubTs: 2 });
    const n = await dbSvc.recalcUnread(feed);
    ok("recalcUnread 接受 Proxy 并回写 unreadCount", n === 1 && raw.get("feed:px").unreadCount === 1);

    // bulkSharded（markManyRead 等批量路径）同样不透传原引用
    seen.length = 0;
    await dbSvc.markManyRead(["item:feed:px:2"]);
    ok("bulkSharded 批量写入走克隆", seen.every((d) => d !== null && typeof d === "object") && raw.get("item:feed:px:2").read === true);
  }

  console.log("[db] 内容搜索 searchContent");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    // A 含全部目标词；B 只含部分词（quick）；C 不含；D 正文全大写（大小写归一用）
    const idA = "item:feed:s:" + dbSvc.sha12("sa");
    const idB = "item:feed:s:" + dbSvc.sha12("sb");
    const idC = "item:feed:s:" + dbSvc.sha12("sc");
    const idD = "item:feed:s:" + dbSvc.sha12("sd");
    raw.set("itemfull:" + idA, { _id: "itemfull:" + idA, content: "the quick brown fox jumps over the fence" });
    raw.set("itemfull:" + idB, { _id: "itemfull:" + idB, content: "only a quick rabbit here" });
    raw.set("itemfull:" + idC, { _id: "itemfull:" + idC, content: "nothing relevant at all" });
    raw.set("itemfull:" + idD, { _id: "itemfull:" + idD, content: "THE LAZY DOG SLEEPS ALL DAY" });

    const empty = await dbSvc.searchContent("");
    ok("空 query 零命中且不截断", empty.ids.length === 0 && empty.scanned === 0 && empty.truncated === false);
    ok("空白串同空 query", (await dbSvc.searchContent("   ")).ids.length === 0);

    const one = await dbSvc.searchContent("fox");
    ok("单词命中 1 篇且扫完 4 篇", one.ids.length === 1 && one.ids[0] === idA && one.scanned === 4 && one.truncated === false);
    ok("ids 已剥 itemfull: 前缀（=itemId）", one.ids.every((x) => x === idA && !x.startsWith("itemfull:")));

    const and = await dbSvc.searchContent("quick fox");
    ok("多词 AND 只命含全词那篇", and.ids.length === 1 && and.ids[0] === idA);
    const rev = await dbSvc.searchContent("fox   quick"); // 多空白拆词 + 词序无关
    ok("词序无关（多空白容错）", rev.ids.length === 1 && rev.ids[0] === idA);
    ok("只含部分词的不命中", (await dbSvc.searchContent("quick fence rabbit")).ids.length === 0);

    const ci = await dbSvc.searchContent("lazy dog");
    ok("大小写不敏感（正文大写、查询小写）", ci.ids.length === 1 && ci.ids[0] === idD);

    // 预算截断：300 篇 + budgetMs=1（分片让出后必超 1ms）→ 中途止损；默认预算同语料全量扫完
    for (let i = 0; i < 300; i++) {
      const id = "item:feed:big:" + i;
      raw.set("itemfull:" + id, { _id: "itemfull:" + id, content: "bulk filler text number " + i + " with needle inside" });
    }
    const cut = await dbSvc.searchContent("needle", { budgetMs: 1 });
    ok("超预算截断：truncated 且未扫完", cut.truncated === true && cut.scanned >= 1 && cut.scanned < 304);
    const full = await dbSvc.searchContent("needle");
    ok("默认预算同语料全量扫完", full.truncated === false && full.scanned === 304 && full.ids.length === 300);
  }

  console.log("[db] 内容搜索双前缀去重（itemfull + itemfullx，PLAN-V1.3 A）");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    // X 两前缀都写（判重前提取过、判重后新 itemfull）→ 只回一次；Y 仅提取版
    const idX = "item:feed:dd:" + dbSvc.sha12("dx");
    const idY = "item:feed:dd:" + dbSvc.sha12("dy");
    raw.set("itemfull:" + idX, { _id: "itemfull:" + idX, content: "shared keyword alpha in both" });
    raw.set("itemfullx:" + idX, { _id: "itemfullx:" + idX, content: "shared keyword alpha extracted version" });
    raw.set("itemfullx:" + idY, { _id: "itemfullx:" + idY, content: "keyword alpha only extracted" });
    const r = await dbSvc.searchContent("keyword alpha");
    ok("双前缀命中且同 id 去重", r.ids.length === 2 && r.ids.includes(idX) && r.ids.includes(idY));
    ok("ids 已剥各自前缀", r.ids.every((x) => !x.startsWith("itemfull")));
    // 仅前缀一命中（另一个不含词）不误伤
    raw.set("itemfullx:" + idY, { _id: "itemfullx:" + idY, content: "extracted only" });
    const r2 = await dbSvc.searchContent("alpha");
    ok("itemfull 命中而 itemfullx 不含词时仍回一次", r2.ids.length === 1 && r2.ids[0] === idX);
  }

  console.log("[db] T-09 联动：ingest 内容变化清 itemfullx");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:t9", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
    await dbSvc.ingestFeed(feed, mkItems(), {});
    const items = await dbSvc.itemsOfFeed("feed:t9");
    const g1 = items.find((x) => x.guid === "g1");
    raw.set("itemfullx:" + g1._id, { _id: "itemfullx:" + g1._id, content: "<p>旧提取</p>", at: 1, src: "readability" });
    await dbSvc.ingestFeed(feed, mkItems(), {}); // 内容未变：判重短路，不触碰 itemfullx
    ok("内容未变 itemfullx 保留", (await db.promises.get("itemfullx:" + g1._id)) !== null);
    await dbSvc.ingestFeed(feed, mkItems({ g1: { contentHtml: "<p>内容A2</p>", contentHash: "aaa999" } }), {}); // 内容变化
    ok("内容变化连带清 itemfullx", (await db.promises.get("itemfullx:" + g1._id)) === null);
  }

  console.log("[db] 级联清理连带 itemfullx（retention + deleteFeed）");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    const feed = { _id: "feed:t10", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
    await dbSvc.ingestFeed(feed, mkItems(), {});
    const items = await dbSvc.itemsOfFeed("feed:t10");
    for (const it of items) raw.set("itemfullx:" + it._id, { _id: "itemfullx:" + it._id, content: "<p>x</p>", at: 1, src: "readability" });
    const removed = await dbSvc.retentionClean(feed, 1);
    const left = await dbSvc.itemsOfFeed("feed:t10");
    const gone = items.filter((x) => !left.some((y) => y._id === x._id));
    ok("保留清理删除 " + removed + " 篇", removed === 2 && gone.length === 2);
    ok("被清篇目 itemfullx 连带删", gone.every((g) => raw.get("itemfullx:" + g._id) === undefined));
    ok("存活篇目 itemfullx 不受影响", left.every((l) => raw.get("itemfullx:" + l._id) !== undefined));
    await dbSvc.deleteFeedCascade(feed);
    ok("级联删除后 itemfullx 无残留", (await db.promises.allDocs("itemfullx:")).length === 0);
  }

  console.log("[extract] ensureFull 全状态机（fixture + stub nodeFetch，不走真实网络）");
  {
    const { db, raw } = makeMockDb();
    global.utools.db = db;
    global.utools.dbStorage = { getItem: () => null, setItem: () => {} }; // logger 落盘面
    const extractSvc = require(path.join(PRELOAD, "services/extract.js"));
    const LONG = "<p>正文段落占位内容，用于超过六百字下限。".repeat(60);
    const FX_PAGE = Buffer.from(`<html><head><title>夹具页</title></head><body><article><h1>标题</h1>${LONG}<img src="/rel/pic.jpg"></article></body></html>`);
    let fetchCalls = 0;
    let stub = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: FX_PAGE, truncated: false, error: null });
    extractSvc.__test.ctx.nodeFetch = (...a) => {
      fetchCalls += 1;
      return stub(...a);
    };

    const feed = { _id: "feed:x1", url: "https://e/f", title: "x", unreadCount: 0, lastFetchedAt: null };
    raw.set(feed._id, feed);
    const mkItem = (id, over = {}) => raw.set(id, { _id: id, feedKey: "feed:x1", guid: id, link: "https://ex/a", title: "T", titleDisplay: "T", summaryText: "S", read: false, starred: false, aiStatus: "done", ai: { summary: "s", tags: ["t"], titleZh: "", titleNorm: "", aiSource: "enrich" }, ...over });
    const mainId = "item:feed:x1:" + dbSvc.sha12("gx");
    mkItem(mainId, { aiTrans: { paras: [{ idx: 0, head: "旧段首二十个字符占位占位占位占位占", text: "旧译" }], at: 1, model: "m" } });

    let r = await extractSvc.ensureFull("item:feed:x1:不存在");
    ok("NOT_FOUND（item 缺失安静退出）", r.status === "error" && r.error === "NOT_FOUND");
    r = await extractSvc.ensureFull(mainId);
    ok("off（源未开全文，零网络）", r.status === "off" && fetchCalls === 0);

    feed.fullText = true;
    r = await extractSvc.ensureFull(mainId);
    ok("fetched（首开提取成功）", r.status === "fetched" && !!r.content && fetchCalls === 1);
    ok("提取产物已消毒（无 script/onerror）", !/<script/i.test(r.content) && !/onerror/i.test(r.content));
    ok("相对图已绝对化", r.content.includes("https://ex/rel/pic.jpg"));
    ok("itemfullx 已落库", (await db.promises.get("itemfullx:" + mainId)) !== null);
    ok("fetched 连带清 aiTrans（T-09 同族）", (await db.promises.get(mainId)).aiTrans === undefined);
    ok("ai.summary/tags 保留", (await db.promises.get(mainId)).ai != null);

    r = await extractSvc.ensureFull(mainId);
    ok("hit（二次缓存秒出，不再抓）", r.status === "hit" && fetchCalls === 1);

    raw.delete("itemfullx:" + mainId);
    const [c1, c2] = await Promise.all([extractSvc.ensureFull(mainId), extractSvc.ensureFull(mainId)]);
    ok("并发合流只抓一次", fetchCalls === 2 && c1.status === "fetched" && c2.status === "fetched");

    const richId = "item:feed:x1:" + dbSvc.sha12("gr");
    mkItem(richId);
    raw.set("itemfull:" + richId, { _id: "itemfull:" + richId, content: LONG });
    r = await extractSvc.ensureFull(richId);
    ok("rich（feed 自带正文达标，不抓取）", r.status === "rich" && fetchCalls === 2);

    const nolinkId = "item:feed:x1:" + dbSvc.sha12("gn");
    mkItem(nolinkId, { link: "" });
    r = await extractSvc.ensureFull(nolinkId);
    ok("NO_LINK", r.status === "error" && r.error === "NO_LINK");

    stub = async () => ({ ok: false, url: "https://ex/a", status: 500, headers: {}, body: null, truncated: false, error: "HTTP_500" });
    raw.delete("itemfullx:" + mainId);
    r = await extractSvc.ensureFull(mainId);
    ok("FETCH_HTTP_500", r.status === "error" && r.error === "FETCH_HTTP_500");

    stub = async () => ({ ok: true, url: "https://ex/a", status: 202, headers: {}, body: Buffer.alloc(0), truncated: false, error: null });
    r = await extractSvc.ensureFull(mainId);
    ok("FETCH_EMPTY_BODY（bot 挑战空页）", r.status === "error" && r.error === "FETCH_EMPTY_BODY");

    stub = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><body><p>太短</p></body></html>"), truncated: false, error: null });
    r = await extractSvc.ensureFull(mainId);
    ok("EXTRACT_TOO_SHORT（不落库可重试）", r.status === "error" && r.error === "EXTRACT_TOO_SHORT" && (await db.promises.get("itemfullx:" + mainId)) === null);

    stub = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><head><title>t</title></head><body></body></html>"), truncated: false, error: null });
    r = await extractSvc.ensureFull(mainId);
    ok("EXTRACT_FAILED（Readability null；碎 HTML 抛错同归此）", r.status === "error" && r.error === "EXTRACT_FAILED");
  }

  console.log("\n全部通过：" + pass + " 项（数据层 + 端到端刷新管线）");
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
