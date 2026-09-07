/**
 * bench-search.js — P3 测量项（PLAN-V1.3 §4 阶段E）
 *
 * 构造 itemfull + itemfullx 合计 ≥1 万篇灌水存量（内存 mock db，无网络），
 * 实测双前缀 allDocs + 线性扫描耗时。口径：>500ms → README 待验证项记录结论，
 * 按 PLAN-NEXT §5 决策树默认维持预算截断降级（不开发索引）。
 * 用法：node scripts/bench-search.js [篇数=12000]
 */
const path = require("path");
const PRELOAD = path.join(__dirname, "..", "preload");

// 与 test-db-mock 同款内存 utools.db
function makeMockDb() {
  const docs = new Map();
  let revSeq = 1;
  const db = {
    put: (doc) => {
      docs.set(doc._id, { ...doc, _rev: "r" + ++revSeq });
      return { ok: true, id: doc._id };
    },
    get: (id) => (docs.has(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null),
    remove: (d) => {
      const id = typeof d === "string" ? d : d._id;
      return docs.delete(id) ? { ok: true, id } : { error: true };
    },
    bulkDocs: (l) => l.map((d) => db.put(d)),
    allDocs: (p) => {
      let vals = [...docs.values()];
      if (typeof p === "string") vals = vals.filter((d) => d._id.startsWith(p));
      return vals.map((d) => JSON.parse(JSON.stringify(d)));
    },
  };
  db.promises = {};
  for (const k of ["put", "get", "remove", "bulkDocs", "allDocs"]) db.promises[k] = (x, y) => Promise.resolve(db[k](x, y));
  return db;
}

const N = Number(process.argv[2]) || 12000;

(async () => {
  const db = makeMockDb();
  global.utools = { db };
  const dbSvc = require(path.join(PRELOAD, "services/db.js"));

  // 灌水：一半进 itemfull（feed 自带正文形态），一半进 itemfullx（提取版形态），
  // 内容为 ~2KB 中英混排正文（接近真实文章体量），每第 100 篇埋一个 needle 词
  const paras = "这一段是用于压测的正文内容，模拟真实文章的段落长度与词汇分布。The quick brown fox jumps over the lazy dog. ".repeat(8);
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const id = (i % 2 === 0 ? "itemfull:item:bench:" : "itemfullx:item:bench:") + i;
    const content = paras + (i % 100 === 0 ? " zzzneedle" : "") + " tail" + i;
    await db.promises.put({ _id: id, content });
  }
  console.log(`灌水 ${N} 篇（itemfull/itemfullx 各半，~${Math.round(paras.length / 1024)}KB/篇）耗时 ${Date.now() - t0}ms`);

  // 测 3 轮：命中词（needle）与未命中词（冷词）各代表最好/最坏路径（全表扫）
  for (const q of ["zzzneedle", "不存在的冷词xyz"]) {
    const times = [];
    for (let r = 0; r < 3; r++) {
      const res = await dbSvc.searchContent(q);
      times.push(res.ms);
      if (r === 0) console.log(`「${q}」：命中 ${res.ids.length} 篇，扫描 ${res.scanned} 篇，truncated=${res.truncated}`);
    }
    console.log(`  耗时 3 轮：${times.join(" / ")} ms（预算 1500ms）`);
  }
  console.log(`\n口径：全部轮次 ≤500ms → 双前缀线性扫描在万级存量下无感知；任一 >500ms → 记录 README 待验证项，维持预算截断降级`);
})();
