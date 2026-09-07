/**
 * check-preload-mapping.js — 静态核对 preload/index.js 的服务映射
 * 坑记录（2026-09 retentionClean 拼错实机炸过）：映射名拼错本地全绿、实机必炸，
 * 故用脚本核对 index.js 里每个 XxSvc.name 引用都是目标模块的真实导出。
 * 用法：node scripts/check-preload-mapping.js
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const src = fs.readFileSync(path.join(root, "preload/index.js"), "utf8");
const services = { dbSvc: "db", feedSvc: "feed", articleSvc: "article", extractSvc: "extract", opmlSvc: "opml", schedulerSvc: "scheduler", aiSvc: "ai", loggerSvc: "logger" };

let bad = 0;
for (const [varName, mod] of Object.entries(services)) {
  const exports = require(path.join(root, "preload", "services", mod + ".js"));
  const re = new RegExp(varName + "\\.([A-Za-z_$][\\w$]*)", "g");
  let m;
  while ((m = re.exec(src))) {
    if (typeof exports[m[1]] !== "function") {
      console.log("MISSING: " + varName + "." + m[1] + " (services/" + mod + ".js 无此导出)");
      bad += 1;
    }
  }
}
if (bad === 0) console.log("ALL MAPPINGS OK (" + Object.keys(services).length + " services checked)");
else {
  console.log(bad + " BROKEN");
  process.exit(1);
}
