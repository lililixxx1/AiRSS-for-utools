/**
 * check-preload-mapping.js — 静态核对 preload/index.js 服务映射与类型声明一致性
 * 用法：node scripts/check-preload-mapping.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "preload/index.js"), "utf8");
// 去掉 require("...") 路径字符串，避免 events.js / readService.js 被误判成导出方法调用
const codeOnly = src.replace(/require\((["'])[^"']+\1\)/g, "");

const moduleRefs = {
  dbSvc: "preload/services/db.js",
  feedSvc: "preload/services/feed.js",
  articleSvc: "preload/services/article.js",
  extractSvc: "preload/services/extract.js",
  opmlSvc: "preload/services/opml.js",
  aiSvc: "preload/services/ai.js",
  loggerSvc: "preload/services/logger.js",
  events: "preload/core/events.js",
  readService: "preload/core/readService.js",
  refreshService: "preload/core/refreshService.js",
  laterService: "preload/core/laterService.js",
  lifecycleMgr: "preload/lifecycle.js",
};

let bad = 0;
for (const [varName, relMod] of Object.entries(moduleRefs)) {
  const exportsObj = require(path.join(root, relMod));
  const re = new RegExp(`\\b${varName}\\.([A-Za-z_$][\\w$]*)`, "g");
  let m;
  while ((m = re.exec(codeOnly))) {
    if (typeof exportsObj[m[1]] !== "function") {
      console.log(`MISSING: ${varName}.${m[1]} (${relMod} 无此函数导出)`);
      bad += 1;
    }
  }
}

// 核对生成声明与 env.d.ts
const genIndexPath = path.join(root, "src/types/generated/index.d.ts");
const envPath = path.join(root, "src/env.d.ts");
if (!fs.existsSync(genIndexPath)) {
  console.log("MISSING: src/types/generated/index.d.ts（请先运行 npm run gen:types）");
  bad += 1;
} else {
  const genDts = fs.readFileSync(genIndexPath, "utf8");
  for (const ns of ["on", "db", "feed", "article", "opml", "read", "refresh", "later", "schedule", "features", "lifecycle", "ai", "log", "sys"]) {
    const ok = genDts.includes(`namespace ${ns}`) || genDts.includes(`export let ${ns}:`) || genDts.includes(`export declare let ${ns}:`);
    if (!ok) {
      console.log(`MISSING IN DTS: airss.${ns}`);
      bad += 1;
    }
  }
}

const envText = fs.readFileSync(envPath, "utf8");
if (!envText.includes('typeof import("./types/generated/index")')) {
  console.log("OUTDATED: src/env.d.ts 未使用自动生成的 generated/index 类型");
  bad += 1;
}

if (bad === 0) {
  console.log(`ALL MAPPINGS OK (${Object.keys(moduleRefs).length} preload modules + generated d.ts verified)`);
} else {
  console.log(`${bad} BROKEN`);
  process.exit(1);
}
