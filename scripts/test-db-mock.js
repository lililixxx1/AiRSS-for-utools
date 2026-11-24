/**
 * test-db-mock.js — v2 分层存储 + 数据层与抓取/提取管线全链路测试
 *
 * 覆盖：ingest 判重/写序推进、read/starred 同步状态与本地分层、unreadCount 对账、
 *       保留清理（含星标二次复查）、级联删除、Proxy 克隆隔离、MiniSearch 全文搜索、
 *       T-09 itemfullx 连带清理、ensureFull 全状态机与站点适配落库。
 * 用法：node scripts/test-db-mock.js [--offline]
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const OFFLINE = process.argv.includes("--offline");
const PRELOAD = path.join(__dirname, "..", "preload");
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "airss-test-db-"));
let curLocalDir = path.join(TMP_BASE, "init");

function makeMockDb() {
  const docs = new Map();
  let revSeq = 1;
  const res = (ok, id, extra) => ({ ok, id, rev: "r" + revSeq++, ...(extra || {}) });
  const db = {
    put: (doc) => {
      if (doc._deleted) {
        if (!docs.has(doc._id)) return { error: true, id: doc._id, message: "not_found" };
        docs.delete(doc._id);
        return res(true, doc._id);
      }
      const cur = docs.get(doc._id);
      if (cur && cur._rev !== doc._rev) return { error: true, id: doc._id, message: "conflict" };
      const next = { ...doc, _rev: "r" + ++revSeq };
      docs.set(doc._id, next);
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

const kv = new Map();
global.utools = {
  db: null,
  getPluginLocalDataPath: () => curLocalDir,
  getPluginTempPath: () => TMP_BASE,
  dbStorage: {
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => kv.set(k, v),
    removeItem: (k) => kv.delete(k),
  },
};

const storage = require(path.join(PRELOAD, "core/storage.js"));
const dbSvc = require(path.join(PRELOAD, "services/db.js"));
const scheduler = require(path.join(PRELOAD, "services/scheduler.js"));
const extractSvc = require(path.join(PRELOAD, "services/extract.js"));
const logger = require(path.join(PRELOAD, "services/logger.js"));

let envSeq = 0;
function freshEnv() {
  storage.resetForTest();
  extractSvc.__test.clearMemo();
  logger.resetForTest();
  kv.clear();
  curLocalDir = path.join(TMP_BASE, "e" + ++envSeq);
  fs.mkdirSync(curLocalDir, { recursive: true });
  const { db, raw } = makeMockDb();
  global.utools.db = db;
  return { db, raw, localDir: curLocalDir };
}

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
  try {
    console.log("[db] ingest 判重/更新策略/写序与分层边界");
    {
      const { db, raw } = freshEnv();
      const feed = { _id: "feed:t1", url: "https://e/feed", title: "测试源", unreadCount: 0, lastFetchedAt: null };

      let r = await dbSvc.ingestFeed(feed, mkItems(), { etag: "W/1", lastModified: "LM1" });
      ok("首轮入库 3 篇", r.ok && r.newCount === 3 && r.updatedCount === 0);
      ok("lastFetchedAt 推进", typeof feed.lastFetchedAt === "number");
      ok("unreadCount=3", feed.unreadCount === 3);
      ok("etag 写入本地状态", feed.etag === "W/1");
      ok("正文已存本地可读取", (await dbSvc.getItemFull("item:feed:t1:" + dbSvc.sha12("g1"))) === "<p>内容A</p>");
      ok("同步库零 item:/itemfull: 污染", [...raw.keys()].every((k) => !k.startsWith("item:") && !k.startsWith("itemfull:")));

      const items = await dbSvc.itemsOfFeed("feed:t1");
      await dbSvc.setRead(items[0]._id, true);
      await dbSvc.setStarred(items[1]._id, true);

      r = await dbSvc.ingestFeed(
        feed,
        mkItems({ g2: { title: "文章B改", contentHtml: "<p>内容B2</p>", contentHash: "bbb999" } }).concat([
          { guid: "g4", link: "https://e/4", title: "文章D", contentHtml: "<p>D</p>", contentHash: "ddd444", summaryText: "D", cover: null, pubTs: 4000 },
        ]),
        { etag: "W/2", lastModified: "LM2" }
      );
      ok("二轮 新1 改1", r.ok && r.newCount === 1 && r.updatedCount === 1);
      const after = await dbSvc.itemsOfFeed("feed:t1");
      ok("共 4 篇", after.length === 4);
      const readItem = after.find((x) => x.guid === "g1");
      const starItem = after.find((x) => x.guid === "g2");
      ok("更新策略：read 恒保留", readItem.read === true);
      ok("更新策略：starred 恒保留", starItem.starred === true);
      ok("内容变化才覆盖（标题已更新）", starItem.title === "文章B改");
      ok("unreadCount 对账=3（g2/g3 未读 + 新增 g4）", feed.unreadCount === 3);

      r = await dbSvc.ingestFeed(feed, mkItems({ g1: { title: "文章A改标题", contentHash: "aaa111" } }), { etag: "W/3" });
      const final = await dbSvc.itemsOfFeed("feed:t1");
      ok("源方改标题不产生重复", final.length === 4 && r.newCount === 0);
      ok("仅已操作条目写入 state:/star: 文档", (await db.promises.allDocs("state:")).length === 2 && (await db.promises.allDocs("star:")).length === 1);
    }

    console.log("[db] 标记与批量");
    {
      freshEnv();
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
      freshEnv();
      const feed = { _id: "feed:t3", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
      const many = [];
      for (let i = 0; i < 6; i++) {
        many.push({ guid: "k" + i, link: "l" + i, title: "T" + i, contentHtml: "<p>x" + i + "</p>", contentHash: "h" + i, summaryText: "s", cover: null, pubTs: i * 1000 });
      }
      await dbSvc.ingestFeed(feed, many, {});
      const all = await dbSvc.itemsOfFeed("feed:t3");
      const newest = all.reduce((a, b) => (b.pubTs > a.pubTs ? b : a));
      await dbSvc.setStarred(newest._id, true);

      const removed = await dbSvc.retentionClean(feed, 3);
      const keptItems = await dbSvc.itemsOfFeed("feed:t3");
      ok("保留 3 篇 + 星标豁免 1 篇（共 4）", keptItems.length === 4 && removed === 2);
      ok("被清的是最老两篇", keptItems.every((x) => ["k2", "k3", "k4", "k5"].includes(x.guid)));
      ok("本地正文连带清理", (await dbSvc.getItemFull("item:feed:t3:" + dbSvc.sha12("k0"))) === null);

      await dbSvc.setStarred(keptItems.find((x) => x.guid === "k2")._id, true);
      const removed2 = await dbSvc.retentionClean(feed, 1);
      const after2 = await dbSvc.itemsOfFeed("feed:t3");
      ok("删除前复查星标（k2 星标不被误删）", after2.some((x) => x.guid === "k2") && removed2 <= 2);

      const cnt = await dbSvc.deleteFeedCascade(feed);
      ok("级联删除全部", cnt >= 2 && (await dbSvc.itemsOfFeed("feed:t3")).length === 0);
    }

    console.log("[scheduler] 端到端 refreshOne（" + (OFFLINE ? "离线模拟抓取" : "真实抓取阮一峰") + "）");
    {
      freshEnv();
      const feedSvc = require(path.join(PRELOAD, "services/feed.js"));
      const origFetch = feedSvc.__test.ctx.nodeFetch;
      let targetUrl = "https://www.ruanyifeng.com/blog/atom.xml";
      let expectedTitle = "阮一峰";
      if (OFFLINE) {
        targetUrl = "https://offline.example/feed.xml";
        expectedTitle = "离线模拟订阅源";
        feedSvc.__test.ctx.nodeFetch = async (u) => ({
          ok: true,
          url: u,
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8", etag: '"offline-1"' },
          body: Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>离线模拟订阅源</title><link>https://offline.example/</link>' +
              "<item><title>离线首抓文章一</title><guid>loop-g1</guid><link>https://offline.example/1</link><description>测试离线刷新入库与正文分层。</description></item>" +
              "</channel></rss>"
          ),
          truncated: false,
          error: null,
        });
      }
      try {
        const feed = { _id: "feed:real", url: targetUrl, title: "", unreadCount: 0, lastFetchedAt: null, etag: "", lastModified: "" };
        const r = await scheduler.refreshOne(feed);
        ok("刷新 ok", r.ok && r.status === "ok");
        ok("抓到文章（" + r.newCount + " 篇）", r.newCount > 0);
        ok("feed 标题回填", feed.title.includes(expectedTitle));
        ok("lastFetchedAt 推进", typeof feed.lastFetchedAt === "number");
        ok("unreadCount=newCount", feed.unreadCount === r.newCount);
        const items = await dbSvc.itemsOfFeed("feed:real");
        ok("item 含本地正文分层", (await dbSvc.getItemFull(items[0]._id)) !== null);
      } finally {
        feedSvc.__test.ctx.nodeFetch = origFetch;
      }
    }

    console.log("[db] 渲染层 Proxy 文档入库（'An object could not be cloned.' 回归）");
    {
      const { db, raw } = freshEnv();
      const seen = [];
      const origPut = db.put;
      db.put = (doc) => (seen.push(doc), origPut(doc));

      const feed = new Proxy({ _id: "feed:px", url: "https://e/f", title: "代理源", unreadCount: 9, lastFetchedAt: null, etag: "" }, {});
      const saved = await dbSvc.putRetry(feed);
      ok("putRetry 接受 Proxy 文档", !!saved && !!raw.get("feed:px"));
      ok("db.put 收到的是普通克隆（非原代理引用）", seen[0] !== feed && seen[0]._id === "feed:px" && seen[0].title === "代理源");
      ok("_rev 仍回写到调用方对象", typeof feed._rev === "string");

      await dbSvc.ingestFeed(
        feed,
        [
          { guid: "px1", link: "https://e/1", title: "P1", contentHtml: "<p>1</p>", contentHash: "p1", summaryText: "1", cover: null, pubTs: 1 },
          { guid: "px2", link: "https://e/2", title: "P2", contentHtml: "<p>2</p>", contentHash: "p2", summaryText: "2", cover: null, pubTs: 2 },
        ],
        {}
      );
      const pxItems = await dbSvc.itemsOfFeed("feed:px");
      await dbSvc.setRead(pxItems[0]._id, true);
      const n = await dbSvc.recalcUnread(feed);
      ok("recalcUnread 接受 Proxy 并回写 unreadCount", n === 1 && feed.unreadCount === 1);

      seen.length = 0;
      await dbSvc.markManyRead([pxItems[1]._id]);
      ok("bulkSharded 批量写入走克隆", seen.every((d) => d !== null && typeof d === "object") && (await dbSvc.recalcUnread(feed)) === 0);
    }

    console.log("[db] 内容搜索 searchContent（MiniSearch 无截断全文索引）");
    {
      freshEnv();
      const feed = { _id: "feed:s", url: "https://e/s", title: "SearchFeed", unreadCount: 0, lastFetchedAt: null };
      await dbSvc.saveFeed(feed);
      await dbSvc.ingestFeed(
        feed,
        [
          { guid: "sa", link: "https://e/a", title: "Post A", contentHtml: "<p>the quick brown fox jumps over the fence</p>", contentHash: "ca", summaryText: "", cover: null, pubTs: 1 },
          { guid: "sb", link: "https://e/b", title: "Post B", contentHtml: "<p>only a quick rabbit here</p>", contentHash: "cb", summaryText: "", cover: null, pubTs: 2 },
          { guid: "sc", link: "https://e/c", title: "Post C", contentHtml: "<p>nothing relevant at all</p>", contentHash: "cc", summaryText: "", cover: null, pubTs: 3 },
          { guid: "sd", link: "https://e/d", title: "Post D", contentHtml: "<p>THE LAZY DOG SLEEPS ALL DAY</p>", contentHash: "cd", summaryText: "", cover: null, pubTs: 4 },
        ],
        {}
      );
      const idA = "item:feed:s:" + dbSvc.sha12("sa");
      const idD = "item:feed:s:" + dbSvc.sha12("sd");

      const empty = await dbSvc.searchContent("");
      ok("空 query 零命中且不截断", empty.ids.length === 0 && empty.scanned === 0 && empty.truncated === false);
      ok("空白串同空 query", (await dbSvc.searchContent("   ")).ids.length === 0);

      const one = await dbSvc.searchContent("fox");
      ok("单词命中 1 篇且无截断", one.ids.length === 1 && one.ids[0] === idA && one.truncated === false);

      const and = await dbSvc.searchContent("quick fox");
      ok("多词 AND 只命含全词那篇", and.ids.length === 1 && and.ids[0] === idA);
      const rev = await dbSvc.searchContent("fox   quick");
      ok("词序无关（多空白容错）", rev.ids.length === 1 && rev.ids[0] === idA);
      ok("只含部分词的不命中", (await dbSvc.searchContent("quick fence rabbit")).ids.length === 0);

      const ci = await dbSvc.searchContent("lazy dog");
      ok("大小写不敏感（正文大写、查询小写）", ci.ids.length === 1 && ci.ids[0] === idD);

      // saveItemFullx 后索引更新并可命中提取版新词
      const idX = "item:feed:s:" + dbSvc.sha12("sb");
      await dbSvc.saveItemFullx(idX, "<p>extracted alpha omega content</p>", null, "readability");
      const rx = await dbSvc.searchContent("alpha omega");
      ok("saveItemFullx 后全文索引即时命中", rx.ids.includes(idX));
    }

    console.log("[db] T-09 联动：ingest 内容变化清 itemfullx");
    {
      freshEnv();
      const feed = { _id: "feed:t9", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
      await dbSvc.ingestFeed(feed, mkItems(), {});
      const items = await dbSvc.itemsOfFeed("feed:t9");
      const g1 = items.find((x) => x.guid === "g1");
      await dbSvc.saveItemFullx(g1._id, "<p>旧提取</p>", null, "readability");
      await dbSvc.ingestFeed(feed, mkItems(), {});
      ok("内容未变提取全文保留", (await dbSvc.getItemFullxMeta(g1._id)) !== null);
      await dbSvc.ingestFeed(feed, mkItems({ g1: { contentHtml: "<p>内容A2</p>", contentHash: "aaa999" } }), {});
      ok("内容变化连带清提取全文", (await dbSvc.getItemFullxMeta(g1._id)) === null);
    }

    console.log("[db] 级联清理连带清理本地提取全文（retention + deleteFeed）");
    {
      freshEnv();
      const feed = { _id: "feed:t10", url: "https://e/f", title: "s", unreadCount: 0, lastFetchedAt: null };
      await dbSvc.ingestFeed(feed, mkItems(), {});
      const items = await dbSvc.itemsOfFeed("feed:t10");
      for (const it of items) await dbSvc.saveItemFullx(it._id, "<p>x</p>", null, "readability");
      const removed = await dbSvc.retentionClean(feed, 1);
      const left = await dbSvc.itemsOfFeed("feed:t10");
      const gone = items.filter((x) => !left.some((y) => y._id === x._id));
      ok("保留清理删除 " + removed + " 篇", removed === 2 && gone.length === 2);
      for (const g of gone) {
        if ((await dbSvc.getItemFullxMeta(g._id)) !== null) throw new Error("fullx not deleted for " + g._id);
      }
      ok("被清篇目提取全文连带删", true);
      for (const l of left) {
        if ((await dbSvc.getItemFullxMeta(l._id)) === null) throw new Error("fullx lost for " + l._id);
      }
      ok("存活篇目提取全文不受影响", true);
      await dbSvc.deleteFeedCascade(feed);
      ok("级联删除后全部条目清零", (await dbSvc.itemsOfFeed("feed:t10")).length === 0);
    }

    console.log("[extract] ensureFull 全状态机（fixture + stub nodeFetch，不走真实网络）");
    {
      freshEnv();
      const LONG = "<p>正文段落占位内容，用于超过六百字下限。".repeat(60);
      const FX_PAGE = Buffer.from(`<html><head><title>夹具页</title></head><body><article><h1>标题</h1>${LONG}<img src="/rel/pic.jpg"></article></body></html>`);
      let fetchCalls = 0;
      let stub = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: FX_PAGE, truncated: false, error: null });
      extractSvc.__test.ctx.nodeFetch = (...a) => {
        fetchCalls += 1;
        return stub(...a);
      };

      const feed = { _id: "feed:x1", url: "https://e/f", title: "x", unreadCount: 0, lastFetchedAt: null };
      await dbSvc.saveFeed(feed);
      await dbSvc.ingestFeed(
        feed,
        [
          { guid: "gx", link: "https://ex/a", title: "T", contentHtml: "<p>短</p>", contentHash: "hx", summaryText: "S", cover: null, pubTs: 10 },
          { guid: "gr", link: "https://ex/r", title: "TR", contentHtml: LONG, contentHash: "hr", summaryText: "SR", cover: null, pubTs: 20 },
          { guid: "gn", link: "", title: "TN", contentHtml: "<p>短</p>", contentHash: "hn", summaryText: "SN", cover: null, pubTs: 30 },
        ],
        {}
      );
      const mainId = "item:feed:x1:" + dbSvc.sha12("gx");
      const richId = "item:feed:x1:" + dbSvc.sha12("gr");
      const nolinkId = "item:feed:x1:" + dbSvc.sha12("gn");
      await dbSvc.saveItemAi(mainId, {
        aiStatus: "done",
        ai: { summary: "s", tags: ["t"], titleZh: "", titleNorm: "", aiSource: "enrich" },
        aiTrans: { paras: [{ idx: 0, head: "旧段首二十个字符占位占位占位占位占", text: "旧译" }], at: 1, model: "m" },
      });

      let r = await extractSvc.ensureFull("item:feed:x1:不存在");
      ok("NOT_FOUND（item 缺失安静退出）", r.status === "error" && r.error === "NOT_FOUND");
      r = await extractSvc.ensureFull(mainId);
      ok("off（源未开全文，零网络）", r.status === "off" && fetchCalls === 0);

      feed.fullText = true;
      await dbSvc.saveFeed(feed);
      r = await extractSvc.ensureFull(mainId);
      ok("fetched（首开提取成功）", r.status === "fetched" && !!r.content && fetchCalls === 1);
      ok("提取产物已消毒（无 script/onerror）", !/<script/i.test(r.content) && !/onerror/i.test(r.content));
      ok("相对图已绝对化", r.content.includes("https://ex/rel/pic.jpg"));
      const mainDetail = await dbSvc.getItemDetail(mainId);
      ok("提取全文已写本地缓存", mainDetail.fullxContent !== null);
      ok("fetched 连带清 aiTrans（T-09 同族）", mainDetail.aiTrans === null);
      ok("ai.summary/tags 保留", mainDetail.ai !== null);

      r = await extractSvc.ensureFull(mainId);
      ok("hit（二次缓存秒出，不再抓）", r.status === "hit" && fetchCalls === 1);

      // 删除本地提取版文件测试并发合流
      const internals = storage._getInternals();
      const fxPath = internals.localPaths().fullxFile(feed._id, mainDetail.item.itemKey);
      fs.unlinkSync(fxPath);
      const [c1, c2] = await Promise.all([extractSvc.ensureFull(mainId), extractSvc.ensureFull(mainId)]);
      ok("并发合流只抓一次", fetchCalls === 2 && c1.status === "fetched" && c2.status === "fetched");

      r = await extractSvc.ensureFull(richId);
      ok("rich（feed 自带正文达标，不抓取）", r.status === "rich" && fetchCalls === 2);

      r = await extractSvc.ensureFull(nolinkId);
      ok("NO_LINK", r.status === "error" && r.error === "NO_LINK");

      stub = async () => ({ ok: false, url: "https://ex/a", status: 500, headers: {}, body: null, truncated: false, error: "HTTP_500" });
      if (fs.existsSync(fxPath)) fs.unlinkSync(fxPath);
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(mainId);
      ok("FETCH_HTTP_500", r.status === "error" && r.error === "FETCH_HTTP_500");

      const callsBeforeMemo = fetchCalls;
      r = await extractSvc.ensureFull(mainId);
      ok("失败记忆：窗口内二次打开零请求", fetchCalls === callsBeforeMemo && r.status === "error" && r.error === "FETCH_HTTP_500");
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(mainId);
      ok("失败记忆：清空后可重试（重新发请求）", fetchCalls === callsBeforeMemo + 1 && r.error === "FETCH_HTTP_500");

      stub = async () => ({ ok: true, url: "https://ex/a", status: 202, headers: {}, body: Buffer.alloc(0), truncated: false, error: null });
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(mainId);
      ok("FETCH_EMPTY_BODY（bot 挑战空页）", r.status === "error" && r.error === "FETCH_EMPTY_BODY");

      stub = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><body><p>太短</p></body></html>"), truncated: false, error: null });
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(mainId);
      ok("EXTRACT_TOO_SHORT（不落库可重试）", r.status === "error" && r.error === "EXTRACT_TOO_SHORT" && (await dbSvc.getItemFullxMeta(mainId)) === null);

      stub = async () => ({ ok: true, url: "https://ex/a", status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><head><title>t</title></head><body></body></html>"), truncated: false, error: null });
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(mainId);
      ok("EXTRACT_FAILED", r.status === "error" && r.error === "EXTRACT_FAILED");

      // ---- 站内适配层落库 + 封面补写 ----
      await dbSvc.ingestFeed(
        feed,
        [
          { guid: "gadp", link: "https://radar.everythingisok.top/items/abc", title: "Adp", contentHtml: "<p>short</p>", contentHash: "ha", summaryText: "s", cover: null, pubTs: 40 },
          { guid: "gcov", link: "https://radar.everythingisok.top/items/abc", title: "Cov", contentHtml: "<p>short</p>", contentHash: "hc", summaryText: "s", cover: "https://old.example/cover.png", pubTs: 50 },
          { guid: "gshort", link: "https://hellogithub.com/periodical/volume/1", title: "Sh", contentHtml: "<p>short</p>", contentHash: "hs", summaryText: "s", cover: null, pubTs: 60 },
        ],
        {}
      );
      const adpId = "item:feed:x1:" + dbSvc.sha12("gadp");
      const coverId = "item:feed:x1:" + dbSvc.sha12("gcov");
      const shortId = "item:feed:x1:" + dbSvc.sha12("gshort");

      const ADAPTER_PAGE = `<html><head><meta property="og:image" content="https://radar.everythingisok.top/og/items/abc.png"></head><body><article>
        <div><span>V2EX</span><time>2026-10-30</time></div><h1>标题不进正文</h1><p>作者分享了一个跨平台构建工具，值得一看。</p>
        <section><div>AI 导读</div><p>【这是什么】一段导读文字，说明它解决了什么问题，为什么值得关注，以及在什么场景下特别有用。</p></section>
        <section><div>推荐理由</div><p>推荐理由的文字，讲清楚为什么值得看：作者把跨平台构建的踩坑过程与配置细节都写了出来。</p></section>
        <p>来源：<a href="https://www.v2ex.com/t/1">V2EX · 创造节点</a></p>
        </article></body></html>`;
      stub = async () => ({ ok: true, url: "https://radar.everythingisok.top/items/abc", status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(ADAPTER_PAGE), truncated: false, error: null });
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(adpId);
      ok("适配命中：短篇结构化正文也被落库", r.status === "fetched" && r.content.includes("<h2>AI 导读</h2>"));
      const stored = await dbSvc.getItemFullxMeta(adpId);
      ok("适配产物标记来源（src=adapter:*）", !!stored && /^adapter:/.test(stored.src));
      ok("封面补写进 item（只补空）", (await dbSvc.getItemDetail(adpId)).item.cover === "https://radar.everythingisok.top/og/items/abc.png");
      r = await extractSvc.ensureFull(adpId);
      ok("适配产物二次打开走缓存（hit）", r.status === "hit" && r.content.includes("AI 导读"));

      r = await extractSvc.ensureFull(coverId);
      ok("已有封面不被覆盖（只补空）", r.status === "fetched" && (await dbSvc.getItemDetail(coverId)).item.cover === "https://old.example/cover.png");

      const SHORT_ADAPTER_PAGE = `<html><body>
        <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { volume: { data: [{ category_name: "C", items: [{ name: "x" }] }] } } } })}</script>
        <article><h1>通用链路标题</h1>${"<p>这一段来自 Readability 通用链路，用来验证适配产物过短时仍能回落成功。".repeat(30)}</article>
        </body></html>`;
      stub = async () => ({ ok: true, url: "https://hellogithub.com/periodical/volume/1", status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(SHORT_ADAPTER_PAGE), truncated: false, error: null });
      extractSvc.__test.clearMemo();
      r = await extractSvc.ensureFull(shortId);
      ok("适配产物 <80 字 → 回落 Readability 并落库", r.status === "fetched" && r.content.includes("通用链路") && (await dbSvc.getItemFullxMeta(shortId)).src === "readability");
    }

    console.log("\n全部通过：" + pass + " 项（v2 数据层 + 端到端刷新/提取管线）");
  } finally {
    storage.resetForTest();
    logger.resetForTest();
    try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
