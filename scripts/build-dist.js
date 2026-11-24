/**
 * build-dist.js — 组装单一开发/发布目录 dist/（在 vite build 之后执行）
 *
 * 职责：
 * 1) 按 package.json 版本统一给 dist/plugin.json 盖章
 * 2) 拷贝 preload/{index.js,lifecycle.js,package.json,core,services} 与裁剪后的 node_modules 到 dist/preload/
 * 3) 自检：无 .map/.ts/.d.ts/.d.cts/测试/文档等非运行时杂项残留
 * 4) 纯 CJS 装载自检（带 --no-experimental-require-module，验证核心模块与第三方依赖可正确 require）
 *
 * 用法：node scripts/build-dist.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(path.dirname(__filename));
const DIST = path.join(ROOT, "dist");
const DIST_PRELOAD = path.join(DIST, "preload");
const SRC_PRELOAD = path.join(ROOT, "preload");
const NM_SRC = path.join(SRC_PRELOAD, "node_modules");

const JUNK_EXT = /\.map$/i;
const JUNK_NAMES = /^(\.ds_store|thumbs\.db)$/i;
const JUNK_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  ".git",
  ".github",
  ".vscode",
  ".idea",
]);

function isJunk(base) {
  return JUNK_EXT.test(base) || JUNK_NAMES.test(base);
}

function clearDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return;
  } catch (e) {
    if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(e.code)) throw e;
  }
  const stuck = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      stuck.push(`${name} (${e.code})`);
    }
  }
  if (stuck.length) {
    console.error(`[build-dist] 无法清理 ${dir}：\n  ${stuck.join("\n  ")}`);
    process.exit(1);
  }
}

function listJsRecursive(dir, relBase = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = relBase ? path.join(relBase, name) : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listJsRecursive(full, rel));
    else if (name.endsWith(".js")) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

if (!fs.existsSync(DIST) || !fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("[build-dist] 缺少 dist/index.html，请先运行 vite build");
  process.exit(1);
}

// 1) 版本号单一真源 = package.json，盖章到 dist/plugin.json
const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const distPluginJson = path.join(DIST, "plugin.json");
if (!fs.existsSync(distPluginJson)) {
  console.error("[build-dist] 缺少 dist/plugin.json，请确认 public/plugin.json 存在");
  process.exit(1);
}
const pluginMeta = JSON.parse(fs.readFileSync(distPluginJson, "utf8"));
if (pluginMeta.version !== pkgVer) {
  pluginMeta.version = pkgVer;
  fs.writeFileSync(distPluginJson, JSON.stringify(pluginMeta, null, 2) + "\n", "utf8");
}

// 2) 重建 dist/preload/ 并裁剪 node_modules
if (fs.existsSync(DIST_PRELOAD)) clearDir(DIST_PRELOAD);
fs.mkdirSync(DIST_PRELOAD, { recursive: true });

for (const file of ["index.js", "lifecycle.js", "package.json"]) {
  fs.copyFileSync(path.join(SRC_PRELOAD, file), path.join(DIST_PRELOAD, file));
}
fs.cpSync(path.join(SRC_PRELOAD, "core"), path.join(DIST_PRELOAD, "core"), { recursive: true });
fs.cpSync(path.join(SRC_PRELOAD, "services"), path.join(DIST_PRELOAD, "services"), { recursive: true });

if (fs.existsSync(NM_SRC)) {
  fs.cpSync(NM_SRC, path.join(DIST_PRELOAD, "node_modules"), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(NM_SRC, src);
      if (!rel || rel.startsWith("..")) return true;
      const parts = rel.split(path.sep);
      if (parts.some((p) => JUNK_DIRS.has(p))) return false;
      const base = parts[parts.length - 1];
      return !isJunk(base);
    },
  });
}

// 3) 自检必要产物与无杂项残留
for (const reqFile of ["plugin.json", "index.html", "logo.png", "preload/index.js", "preload/lifecycle.js"]) {
  if (!fs.existsSync(path.join(DIST, reqFile))) {
    console.error(`[build-dist] 缺少必需产物：dist/${reqFile}`);
    process.exit(1);
  }
}

const bad = [];
let fileCount = 0;
let totalBytes = 0;
(function walk(dir, inNm = false) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    const nm = inNm || name === "node_modules";
    if (st.isDirectory()) {
      walk(p, nm);
    } else {
      fileCount += 1;
      totalBytes += st.size;
      if (nm && isJunk(name)) bad.push(path.relative(DIST, p));
      else if (/\.map$/i.test(name)) bad.push(path.relative(DIST, p));
    }
  }
})(DIST);

if (bad.length) {
  console.error(`[build-dist] 自检失败，残留 ${bad.length} 个非运行时文件：\n  ${bad.slice(0, 20).join("\n  ")}`);
  process.exit(1);
}

// 4) 纯 CJS 装载自检（模拟 uTools 宿主环境验证 preload 模块与全部直接依赖可 require）
const coreMods = listJsRecursive(path.join(DIST_PRELOAD, "core")).map((m) => "./preload/core/" + m);
const svcMods = listJsRecursive(path.join(DIST_PRELOAD, "services")).map((m) => "./preload/services/" + m);
const directDeps = [
  "minisearch",
  "linkedom",
  "@mozilla/readability",
  "rss-parser",
  "sanitize-html",
  "fast-xml-parser",
  "iconv-lite",
  "p-limit",
];

const cjsFlag =
  process.allowedNodeEnvironmentFlags && process.allowedNodeEnvironmentFlags.has("--no-experimental-require-module")
    ? ["--no-experimental-require-module"]
    : [];

const checkCode = [
  `const req = (m) => require(m);`,
  `for (const m of ${JSON.stringify([...coreMods, ...svcMods, "./preload/lifecycle.js"])}) req(m);`,
  `for (const d of ${JSON.stringify(directDeps)}) require(require.resolve(d, { paths: ["./preload"] }));`,
].join("\n");

try {
  execFileSync(process.execPath, [...cjsFlag, "-e", checkCode], { cwd: DIST, stdio: "pipe" });
} catch (e) {
  console.error("[build-dist] CJS 装载自检失败：\n" + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
}

console.log(
  `[build-dist] OK：v${pkgVer} · ${fileCount} 个文件 · ${(totalBytes / 1024 / 1024).toFixed(2)}MB → ${DIST}`
);
