#!/usr/bin/env node
/**
 * check-theme-contrast.js — 多主题配色对比度与完整性守门（PLAN-THEMES §2.7）
 *
 * 用法：node scripts/check-theme-contrast.js
 * 校验内容（任一失败 → 非零退出）：
 *   1. warm 快照：tokens.css 的 html[data-theme="light"/"dark"] 两块与下方内嵌快照逐值一致
 *      （"warm 逐字节不动"的自动门禁；有意改 warm 必须同步快照，属显式动作）。
 *   2. 完整性：每个配色×明暗块必须包含对应 warm 模式的全部颜色令牌（缺一令牌 = 静默回落
 *      warm 造成混色）；swatch 块 4 块齐全、各有 --p-sw-panel/--p-sw-accent。
 *   3. 格式 fail-loud：颜色令牌值只允许 #RRGGBB 与 rgba(...)；其他格式直接报错（防假绿）。
 *   4. 对比度矩阵（docs/design-system.md §3.3 纪律，PLAN-THEMES §1.4 契约）：
 *      text-1/2 对全部常用底 ≥4.5；text-3 仅对 bg-panel（白底专用豁免，与 warm 现状对齐）；
 *      accent-deep 对常用底与 accent-soft（hl 组合）≥4.5；非文本强调 ≥3；ink on accent 三态 ≥4.5；
 *      danger-text ≥4.5；白字 on danger ≥4.5。dark 底色集额外含 bg-elevated。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const TOKENS_PATH = path.join(__dirname, "..", "src", "styles", "tokens.css");

/* warm 缺省两块的锁定快照（与改造前 tokens.css 逐值一致） */
const WARM_SNAPSHOT = {
  light: {
    "bg-app": "#F9F6F1", "bg-panel": "#FFFFFF", "bg-hover": "#F1EDE5", "bg-card-hover": "#FAF8F3",
    "bg-active": "#ECE7DD", "bg-btn-muted": "#F1EFE9", "bg-btn-muted-hover": "#E9E5DC", "bg-selected": "#FCEFE3",
    "text-1": "#292524", "text-2": "#57534E", "text-3": "#78716C", "text-disabled": "#A8A29E",
    "text-read": "#44403C",
    "accent": "#F97316", "accent-hover": "#FB8438", "accent-active": "#F2650C",
    "accent-strong": "#EA580C", "accent-deep": "#C2410C", "accent-soft": "#FCEFE3", "accent-ink": "#431407",
    "border": "#E8E5DF", "border-strong": "#D6D1C8", "border-input": "#8F8A80", "focus-ring": "#EA580C",
    "danger": "#DC2626", "danger-text": "#DC2626", "danger-soft": "#FDE8E8",
    "scrim": "rgba(41, 37, 36, 0.42)", "skel-a": "#F0EDE6", "skel-b": "#F9F6F0",
    "shadow-1": "0 1px 2px rgba(41, 37, 36, 0.05)", "shadow-2": "0 2px 8px rgba(41, 37, 36, 0.07)",
    "shadow-3": "0 12px 32px rgba(41, 37, 36, 0.14), 0 2px 8px rgba(41, 37, 36, 0.08)",
  },
  dark: {
    "bg-app": "#171412", "bg-panel": "#201C19", "bg-elevated": "#282219", "bg-hover": "#2A241E",
    "bg-card-hover": "#26211C", "bg-active": "#332C24", "bg-btn-muted": "#2A251F", "bg-btn-muted-hover": "#332C24", "bg-selected": "#35261A",
    "text-1": "#F2EDE4", "text-2": "#B8B0A4", "text-3": "#928A7D", "text-disabled": "#6B6459",
    "text-read": "#B8B0A4",
    "accent": "#FB923C", "accent-hover": "#FDBA74", "accent-active": "#F08633",
    "accent-strong": "#FB923C", "accent-deep": "#FDBA74", "accent-soft": "#35261A", "accent-ink": "#431407",
    "border": "#332C25", "border-strong": "#474036", "border-input": "#746C5B", "focus-ring": "#FB923C",
    "danger": "#DC2626", "danger-text": "#F87171", "danger-soft": "#3A211E",
    "scrim": "rgba(10, 8, 6, 0.6)", "skel-a": "#2B2620", "skel-b": "#352E26",
    "shadow-1": "0 1px 2px rgba(0, 0, 0, 0.45)", "shadow-2": "0 2px 8px rgba(0, 0, 0, 0.5)",
    "shadow-3": "0 12px 32px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.5)",
  },
};

const PALETTES = ["warm", "sepia", "sage", "indigo"];
const SWATCH_KEYS = ["p-sw-panel", "p-sw-accent"];

/* ---- WCAG 2.x ---- */
function hexLum(hex) {
  const n = hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [l1, l2] = [hexLum(a), hexLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ---- 解析 tokens.css ---- */
function parseBlocks(css) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!sel.startsWith("html[")) continue; // 跳过 :root 与注释
    const vars = {};
    const vre = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g;
    let v;
    while ((v = vre.exec(m[2]))) vars[v[1]] = v[2].trim();
    if (Object.keys(vars).length === 0) continue;
    blocks.push({ sel, vars });
  }
  return blocks;
}

const HEX6 = /^#[0-9A-Fa-f]{6}$/;
const RGBA = /^rgba\([^)]+\)$/;
function assertFormat(label, vars) {
  for (const [k, val] of Object.entries(vars)) {
    if (!val) throw new Error(`空值令牌（fail-loud）：${label} 的 ${k} 为空（会静默回落 warm）`);
    if (HEX6.test(val) || RGBA.test(val)) continue;
    // shadow 复合值：剥离 rgba(...) 后仅剩 尺寸/逗号/空白（如 "0 12px 32px , 0 2px 8px "）
    const rest = val.replace(/rgba\([^)]+\)/g, "");
    if (/^[\dpx\s,]*$/.test(rest)) continue;
    throw new Error(`格式不合法（fail-loud）：${label} 的 ${k} = "${val}"（仅允许 #RRGGBB / rgba() / shadow 复合值）`);
  }
}

/* ---- 对比度矩阵（PLAN-THEMES §1.4 契约） ---- */
function checksFor(mode) {
  const bgText = ["bg-panel", "bg-app"];
  const bgText2 = [...bgText, "bg-hover", "bg-card-hover", "bg-btn-muted", "bg-selected"];
  const bgDeep = [...bgText, "bg-selected", "bg-card-hover", "bg-btn-muted", "accent-soft"];
  const bgNonText = ["bg-panel", "bg-app"];
  const c = [
    ["text-1", bgText, 4.5],
    ["text-2", mode === "dark" ? [...bgText2, "bg-elevated"] : bgText2, 4.5],
    ["text-3", mode === "dark" ? ["bg-panel", "bg-elevated"] : ["bg-panel"], 4.5], // 白底专用豁免
    ["accent-deep", mode === "dark" ? [...bgDeep, "bg-elevated"] : bgDeep, 4.5],
    ["accent-strong", mode === "dark" ? [...bgNonText, "bg-elevated"] : bgNonText, 3],
    ["focus-ring", bgNonText, 3],
    ["border-input", ["bg-panel"], 3],
    ["accent-ink", ["accent", "accent-hover", "accent-active"], 4.5],
    // danger-text 面板专用豁免：错误文字只出现在 panel/modal/toast 底上；warm 原值在 bg-app 上 4.48，
    // 设计文档 §3.1 本就只承诺白底 4.83，与 text-3 同类的现状对齐口径（warm 零 diff 原则优先）
    ["danger-text", ["bg-panel"], 4.5],
    // 卡片已读标题（PLAN-POLISH D7）：出现在卡片（bg-panel）与 hover（bg-card-hover）底上
    ["text-read", ["bg-panel", "bg-card-hover"], 4.5],
  ];
  return c.flatMap(([fg, bgs, min]) => bgs.map((bg) => [fg, bg, min])).concat([[null, "danger", 4.5, "#FFFFFF"]]);
}

/* ---- 主流程 ---- */
const css = fs.readFileSync(TOKENS_PATH, "utf8");
const blocks = parseBlocks(css);
const problems = [];

/* 1. warm 快照 + 提取 */
const warm = { light: null, dark: null };
const paletteBlocks = {}; // `${palette}:${mode}` -> vars
const swatches = {}; // palette -> vars
for (const b of blocks) {
  assertFormat(b.sel, b.vars);
  const theme = b.sel.match(/\[data-theme="([^"]+)"\]/)?.[1];
  const palette = b.sel.match(/\[data-palette="([^"]+)"\]/)?.[1];
  if (!palette && theme) {
    if (warm[theme]) problems.push(`重复的 warm ${theme} 块：${b.sel}`);
    warm[theme] = b.vars;
  } else if (palette && theme) {
    paletteBlocks[`${palette}:${theme}`] = b.vars;
  } else if (palette && !theme) {
    swatches[palette] = b.vars;
  } else {
    problems.push(`无法归类的选择器：${b.sel}`);
  }
}

for (const mode of ["light", "dark"]) {
  if (!warm[mode]) { problems.push(`缺 warm ${mode} 块`); continue; }
  const flat = {}; // 键去 -- 前缀，与快照口径对齐
  for (const [k, v] of Object.entries(warm[mode])) flat[k.replace(/^--/, "")] = v;
  const keys = new Set([...Object.keys(WARM_SNAPSHOT[mode]), ...Object.keys(flat)]);
  for (const k of keys) {
    if ((WARM_SNAPSHOT[mode][k] || "") !== (flat[k] || "")) {
      problems.push(`warm ${mode} 快照失守：${k} 快照=${WARM_SNAPSHOT[mode][k] || "(无)"} 实际=${flat[k] || "(无)"}（有意改 warm 需同步本脚本快照）`);
    }
  }
}

/* 2. 完整性 + swatch */
for (const p of PALETTES.slice(1)) {
  for (const mode of ["light", "dark"]) {
    const got = paletteBlocks[`${p}:${mode}`];
    if (!got) { problems.push(`缺配色块：html[data-palette="${p}"][data-theme="${mode}"]`); continue; }
    for (const k of Object.keys(WARM_SNAPSHOT[mode])) {
      if (!(`--${k}` in got)) problems.push(`令牌缺失（会静默回落 warm）：${p}/${mode} 缺 --${k}`);
    }
  }
}
for (const p of PALETTES) {
  const sw = swatches[p];
  if (!sw) { problems.push(`缺 swatch 块：html[data-palette="${p}"]`); continue; }
  for (const k of SWATCH_KEYS) if (!(`--${k}` in sw)) problems.push(`swatch 块 ${p} 缺 --${k}`);
}
const extraSwatch = Object.keys(swatches).filter((p) => !PALETTES.includes(p));
if (extraSwatch.length) problems.push(`未知配色的 swatch 块：${extraSwatch.join(", ")}`);

/* 3. 对比度矩阵（warm + 3 新配色 × 2 模式） */
for (const p of PALETTES) {
  for (const mode of ["light", "dark"]) {
    const t = p === "warm" ? warm[mode] : paletteBlocks[`${p}:${mode}`];
    if (!t) continue;
    for (const [fgKey, bgKey, min, fgOverride] of checksFor(mode)) {
      const fg = fgOverride || t["--" + fgKey];
      const bg = t["--" + bgKey];
      if (!HEX6.test(fg) || !HEX6.test(bg)) {
        problems.push(`${p}/${mode}: ${fgKey || fgOverride} × ${bgKey} 不是 hex，无法核算`);
        continue;
      }
      const r = ratio(fg, bg);
      if (r < min) {
        problems.push(`对比不足：${p}/${mode} ${fgKey || fgOverride} on ${bgKey}(${bg}) = ${r.toFixed(2)} < ${min}`);
      }
    }
  }
}

/* ---- 汇总 ---- */
if (problems.length) {
  console.error(`check-theme-contrast: ${problems.length} 处不通过\n`);
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}
console.log("check-theme-contrast: 全部通过 ✓（warm 快照一致 + 令牌完整 + 4 配色 × 2 模式对比度矩阵）");
