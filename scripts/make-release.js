/**
 * make-release.js — 生成发布目录 release/（镜像自单一真源 dist/）
 *
 * v2.1 起 dist/ 已经包含 plugin.json、logo.png、前端产物、preload 与裁剪后的 node_modules，
 * 可直接导入 uTools 开发者工具；本脚本仅在需要单独归档 release/ 目录时镜像 dist/。
 * 用法：node scripts/make-release.js
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(path.dirname(__filename));
const DIST = path.join(ROOT, "dist");
const REL = path.join(ROOT, "release");

function runNode(scriptRel) {
  execFileSync(process.execPath, [path.join(ROOT, scriptRel)], { cwd: ROOT, stdio: "inherit" });
}

const viteRes = spawnSync("npm run build", { stdio: "inherit", shell: true, cwd: ROOT });
if (viteRes.status !== 0) {
  console.error(`[make-release] npm run build 失败（exit ${viteRes.status}）`);
  process.exit(1);
}
if (!fs.existsSync(path.join(DIST, "plugin.json"))) {
  runNode("scripts/build-dist.js");
}

try {
  fs.rmSync(REL, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (e) {
  console.error(`[make-release] 清理 release/ 失败：${e.message}`);
  process.exit(1);
}
fs.cpSync(DIST, REL, { recursive: true });
console.log(`[make-release] OK：已镜像 dist/ → ${REL}`);
