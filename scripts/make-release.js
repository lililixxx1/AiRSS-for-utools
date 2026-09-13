// make-release.js — 组装发布目录 release/（uTools 上架专用，可重复执行）
// 平台校验规则（2026-09 实测）：
//   1) logo ≤ 256×256（源头保证：根 logo.png 已是 256，本脚本不缩放只拷贝）
//   2) 打包目录不得包含 .map / .js.gz 等调试文件 → node_modules 只留运行时文件
//      （.js/.cjs/.json 全保留——nanoid 的 CJS 入口就是 index.cjs；README/LICENSE/测试/
//       .idea/.github/ESM 变体等非运行时一律剔除，preload 源码直供不打包是 uTools 规范）
//   3) package-lock.json 非运行时文件不随包
// 用法：node scripts/make-release.js
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(path.dirname(__filename));
const REL = path.join(ROOT, "release");
const NM_SRC = path.join(ROOT, "preload", "node_modules");
// 非运行时扩展名（含平台拒收的 .map/.gz）
const JUNK_EXT = /\.(map|ts|d\.ts|gz|md|markdown|mdown|txt|yml|yaml|xml|mjs|cts|mts|coffee|sh|iml|lock|eslintcache|jshintrc|editorconfig)$/i;
// 无扩展名/带扩展名的杂项文件名（LICENSE、README、Makefile…）
const JUNK_NAMES = /^(license|licence|readme|authors|changelog|history|notice|patents|contributing|makefile|\.npmignore|\.ds_store|thumbs\.db)(\.[^.]*)?$/i;
// 测试/文档/IDE 目录与 CLI 垫片（require 永不触达 .bin）
const JUNK_DIRS = new Set([".bin", "test", "tests", "__tests__", "doc", "docs", "example", "examples", "benchmark", "benchmarks", "coverage", ".github", ".vscode", ".idea"]);

function isJunk(relPath, base) {
  return JUNK_EXT.test(base) || JUNK_NAMES.test(base);
}

function run(cmd) {
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: ROOT });
  if (r.status !== 0) {
    console.error(`[make-release] ${cmd} 失败（exit ${r.status}）`);
    process.exit(1);
  }
}

// 1) 全新构建渲染层
run("npm run build");

// 目录本身被占用（资源管理器/开发者工具开着 release/）时保留目录壳、清空内容继续；
// 子项也删不动才报错退出。纯瞬时占用（杀软扫描）靠 maxRetries 消化。
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
      stuck.push(`${name}（${e.code}）`);
    }
  }
  if (stuck.length) {
    console.error(`[make-release] release/ 被占用，以下子项删不掉：\n  ${stuck.join("\n  ")}\n请关闭正开着 release/（或其子目录）的资源管理器窗口 / uTools 开发者工具后重跑。`);
    process.exit(1);
  }
}

// 2) 重组 release/
clearDir(REL);
fs.mkdirSync(path.join(REL, "preload"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "plugin.json"), path.join(REL, "plugin.json"));
// 版本号单一真源 = package.json（vite define 同源注入关于区）：发布包 plugin.json 以它为准盖章，
// 防两头手改漂移（源 plugin.json 的 version 仅供开发模式参考）
{
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const pj = path.join(REL, "plugin.json");
  const j = JSON.parse(fs.readFileSync(pj, "utf8"));
  if (j.version !== ver) {
    j.version = ver;
    fs.writeFileSync(pj, JSON.stringify(j, null, 2) + "\n");
    console.log(`[make-release] plugin.json version 盖章为 ${ver}`);
  }
}
fs.copyFileSync(path.join(ROOT, "logo.png"), path.join(REL, "logo.png"));
fs.cpSync(path.join(ROOT, "dist"), path.join(REL, "dist"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "preload", "index.js"), path.join(REL, "preload", "index.js"));
fs.copyFileSync(path.join(ROOT, "preload", "package.json"), path.join(REL, "preload", "package.json"));
fs.cpSync(path.join(ROOT, "preload", "services"), path.join(REL, "preload", "services"), { recursive: true });
fs.cpSync(path.join(ROOT, "preload", "node_modules"), path.join(REL, "preload", "node_modules"), {
  recursive: true,
  // 只对 node_modules 内部做剔除：.js/.cjs/.json 全保留，其余按杂项规则过滤
  filter: (src) => {
    const rel = path.relative(NM_SRC, src);
    if (rel.startsWith("..")) return true;
    const parts = rel.split(path.sep);
    if (parts.some((p) => JUNK_DIRS.has(p))) return false;
    return !isJunk(rel, parts[parts.length - 1]);
  },
});

// 3) 自检：不允许残留任何杂项文件；统计体积
let bad = [];
let count = 0;
let bytes = 0;
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else {
      count++;
      bytes += st.size;
      if (isJunk(name, name)) bad.push(path.relative(REL, p));
    }
  }
})(REL);
if (bad.length) {
  console.error(`[make-release] 自检失败，残留 ${bad.length} 个非运行时文件：\n  ` + bad.slice(0, 20).join("\n  "));
  process.exit(1);
}
console.log(`[make-release] OK：${count} 个文件，${(bytes / 1024 / 1024).toFixed(1)}MB → ${REL}`);
