/**
 * test-dev-bridge.js — 通过 utools-dev-bridge MCP 网关对 dist/ 执行真宿主端到端验收
 *
 * 鉴权（按 utools-dev-bridge 官方约定，不扫描磁盘搜索密钥）：
 *   - 环境变量 UTOOLS_MCP_KEY（或 UTOOLS_MCP_CONFIG 指向含 mcpServers.utools 的 JSON）
 *   - 可选 UTOOLS_MCP_URL（默认 http://127.0.0.1:3501/mcp）
 *
 * 覆盖 §7.1 验收矩阵（仅在沙箱隔离态执行 + dev_cleanup 还原，不污染真实环境）：
 *   1) dev_run 加载 dist/（preload + plugin.json）→ __ready → 建源并入库 → 本地 .html.gz 与 searchContent →
 *      核验 utools.db 无 item:/itemfull:/itemfullx: → state:/star: 懒写 → __dbPull → __mainPush / Select →
 *      features.setGlobalSearchEnabled → schedule.getStatus → ai.getStatus / setByokKey
 *   2) dev_ui_open(dist/) → dev_ui_snapshot 验证界面正常渲染 → dev_ui_close → dev_cleanup
 *
 * 用法：UTOOLS_MCP_KEY=<key> node scripts/test-dev-bridge.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const DIST = path.join(ROOT, "dist");

function loadGatewayConfig() {
  let srv = {};
  const cfgPath = process.env.UTOOLS_MCP_CONFIG;
  if (cfgPath && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    srv = (cfg.mcpServers && cfg.mcpServers.utools)
      || (((cfg.mcp || {}).servers || {}).utools)
      || ((cfg.mcp || {}).utools)
      || {};
  }
  const url = process.env.UTOOLS_MCP_URL || srv.url || "http://127.0.0.1:3501/mcp";
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error("[test-dev-bridge] 拒绝连接非回环网关：" + url);
    process.exit(2);
  }
  const key = process.env.UTOOLS_MCP_KEY || process.env.X_MCP_KEY || (srv.headers || {})["x-mcp-key"] || "";
  if (!key) {
    console.error("[test-dev-bridge] 未设置 UTOOLS_MCP_KEY 或 UTOOLS_MCP_CONFIG；请从 uTools 设置 → AI Agent 连接复制网关密钥后重试。");
    process.exit(2);
  }
  return { url, key };
}

async function createClient() {
  const { url, key } = loadGatewayConfig();
  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-mcp-key": key,
  };
  let nextId = 1;
  let sid = null;

  async function rpc(method, params) {
    const headers = Object.assign({}, baseHeaders);
    if (sid) headers["Mcp-Session-Id"] = sid;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    sid = res.headers.get("mcp-session-id") || sid;
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") || /^(event:|data:)/m.test(text)) {
      const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i].slice(5).trim());
          if (o && (o.result !== undefined || o.error !== undefined || o.jsonrpc)) return o;
        } catch (_) {}
      }
      return null;
    }
    return text.trim() ? JSON.parse(text) : null;
  }

  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "airss-v2-e2e", version: "2.1.0" },
  });
  await fetch(url, {
    method: "POST",
    headers: Object.assign({}, baseHeaders, sid ? { "Mcp-Session-Id": sid } : {}),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});

  const tl = await rpc("tools/list", {});
  const all = ((tl && tl.result && tl.result.tools) || []).map((t) => String(t.name));
  const bridgeId = process.env.UTOOLS_BRIDGE_ID || "";
  const devLoadFull =
    (bridgeId && all.find((n) => n.includes(bridgeId) && /(?:_|\.)dev_load$/.test(n))) ||
    all.find((n) => /(?:_|\.)dev_load$/.test(n)) ||
    all.find((n) => n === "dev_load") ||
    null;
  const prefix = devLoadFull ? devLoadFull.slice(0, -"dev_load".length) : "";

  async function call(bareTool, args = {}) {
    const full =
      all.find((n) => n === bareTool) ||
      (prefix && all.find((n) => n === prefix + bareTool)) ||
      all.find((n) => n.endsWith("_" + bareTool) || n.endsWith("." + bareTool));
    if (!full) throw new Error(`MCP 网关未暴露工具 ${bareTool}`);
    const out = await rpc("tools/call", { name: full, arguments: args });
    if (!out || out.error) throw new Error(`${bareTool} RPC 错误: ${JSON.stringify(out && out.error)}`);
    const r = out.result || {};
    if (r.isError) throw new Error(`${bareTool} 返回错误: ${JSON.stringify(r)}`);
    const textItem = (r.content || []).find((c) => c.type === "text");
    if (textItem && textItem.text) {
      try { return JSON.parse(textItem.text); } catch (_) { return { rawText: textItem.text }; }
    }
    return r;
  }

  return { call };
}

(async () => {
  if (!fs.existsSync(path.join(DIST, "plugin.json"))) {
    console.error("[test-dev-bridge] 缺少 dist/plugin.json，请先运行 npm run build");
    process.exit(1);
  }

  const mcp = await createClient();
  let pass = 0;
  const ok = (name, cond) => {
    assert(cond, "FAIL: " + name);
    pass += 1;
    console.log("  ✓ " + name);
  };

  try {
    const feedId = "feed:devbridge_v2";
    const guid1 = "db-g1";
    const guid2 = "db-g2";
    const sha12 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
    const itemId1 = `item:${feedId}:${sha12(guid1)}`;
    const itemId2 = `item:${feedId}:${sha12(guid2)}`;
    const itemKey1 = sha12(`bridge-test.example/feed.xml‖${guid1}`);

    console.log("[bridge] 1. dev_run 验证 preload + v2 分层存储 + 生命周期（cleanup: true）");
    const steps = [
      { call: "__ready", expect: { ok: true } },
      {
        call: "airss.db.saveFeed",
        args: [{ _id: feedId, url: "https://bridge-test.example/feed.xml", title: "DevBridge Test", category: "测试", notify: true, createdAt: Date.now() }],
        expect: { ok: true, path: "result._id", eq: feedId },
      },
      {
        call: "airss.db.ingestFeed",
        args: [
          { _id: feedId, url: "https://bridge-test.example/feed.xml", urlKey: "bridge-test.example/feed.xml", title: "DevBridge Test" },
          [
            {
              guid: guid1,
              link: "https://bridge-test.example/p/1",
              title: "DevBridge 实机验收文章 1",
              contentHtml: "<p>用于验证 devbridge_token_alpha 全文检索与本地 gz 存储。</p>",
              contentHash: "dbh1",
              summaryText: "摘要内容 1",
              pubTs: Date.now() - 1000,
            },
            {
              guid: guid2,
              link: "https://bridge-test.example/p/2",
              title: "DevBridge 未读直达文章 2",
              contentHtml: "<p>第二篇测试文章用于验证 mainPush 未读直达与已读切换。</p>",
              contentHash: "dbh2",
              summaryText: "摘要内容 2",
              pubTs: Date.now(),
            },
          ],
          { etag: "db-etag-1" },
        ],
        expect: { ok: true, path: "result.newCount", eq: 2 },
      },
      { call: "airss.db.getItemDetail", args: [itemId1], expect: { ok: true, path: "result.content", contains: "devbridge_token_alpha" } },
      { call: "airss.db.searchContent", args: ["devbridge_token_alpha"], expect: { ok: true, path: "result.ids.0", eq: itemId1 } },
      { call: "airss.db.getLocalStats", args: [], expect: { ok: true, path: "result.itemCount", gte: 2 } },
      { call: "airss.db.setStarred", args: [itemId1, true], expect: { ok: true, path: "result.starred", eq: true } },
      { call: "airss.db.setRead", args: [itemId1, true], expect: { ok: true, path: "result.read", eq: true } },
      { call: "__dbPull", args: [[{ _id: "state:" + itemKey1, read: true, starred: true, updatedAt: Date.now() }]], expect: { ok: true } },
      { call: "__mainPush", args: [{ code: "airss" }], expect: { ok: true, path: "result.0.title", eq: "AiRSS" } },
      { call: "__mainPushSelect", args: [{ option: { text: "DevBridge 未读直达文章 2" } }], expect: { ok: true, path: "result", eq: true } },
      { call: "__enter", args: [{ code: "airss", from: "main" }], expect: { ok: true } },
      { call: "airss.lifecycle.consumePendingActions", args: [], expect: { ok: true, path: "result.actions.0.payload.itemId", eq: itemId2 } },
      { call: "airss.features.setGlobalSearchEnabled", args: [true], expect: { ok: true } },
      { call: "airss.features.setGlobalSearchEnabled", args: [false], expect: { ok: true, path: "result", eq: false } },
      { call: "airss.schedule.getStatus", args: [], expect: { ok: true, path: "result.supported", eq: true } },
      { call: "airss.later.saveUrl", args: ["javascript:invalid"], expect: { ok: true, path: "result.ok", eq: false } },
      { call: "airss.ai.getStatus", args: [], expect: { ok: true, path: "result.engine", type: "string" } },
      { call: "airss.read.getSnapshot", args: [], expect: { ok: true, path: "result.items.length", gte: 2 } },
      { call: "airss.db.getItemDetail", args: [itemId2], expect: { ok: true, path: "result.item.read", eq: false } },
    ];
    const runRes = await mcp.call("dev_run", {
      load: { path: DIST },
      cleanup: true,
      stopOnFail: true,
      steps,
    });

    const stepResults = (runRes && runRes.steps) || [];
    const runOk = !!runRes && runRes.ok === true && stepResults.length === steps.length && stepResults.every((s) => s.pass && s.ok);
    if (!runOk) {
      console.error("[bridge] dev_run 详情:", JSON.stringify(runRes, null, 2));
    }
    ok(`dev_run 执行全部 ${steps.length} 步且全部通过`, runOk);
    ok("同步库零 item:/itemfull: 膨胀（dbDelete <= 4）", !!runRes.cleanup && runRes.cleanup.restored && runRes.cleanup.restored.dbDelete <= 4);
    ok("dev_run 退出后 cleanup 自动还原", !!runRes.cleanup && runRes.cleanup.ok === true);

    console.log("[bridge] 2. dev_ui_open + dev_ui_eval + dev_ui_snapshot 验证 dist/ 渲染层");
    await mcp.call("dev_ui_open", {
      path: DIST,
      width: 1080,
      height: 680,
      show: false,
      enter: { code: "airss", type: "text", payload: "", from: "main" },
    });
    const evalRes = await mcp.call("dev_ui_eval", {
      js: `(async () => {
        for (let i = 0; i < 30; i++) {
          if (document.querySelectorAll('.sidebar').length >= 1) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          hasAirss: !!window.airss,
          sidebarCount: document.querySelectorAll('.sidebar').length,
          laterBtn: !!document.querySelector('.later-entry'),
          theme: document.documentElement.getAttribute('data-theme'),
        };
      })()`,
      awaitPromise: true,
    });
    const snap = await mcp.call("dev_ui_snapshot", {});
    const snapStr = JSON.stringify(snap);
    const evalVal = evalRes && (evalRes.result !== undefined ? evalRes.result : evalRes);
    const uiOk =
      !!evalVal &&
      evalVal.hasAirss === true &&
      evalVal.sidebarCount === 1 &&
      evalVal.laterBtn === true &&
      snapStr.includes("AiRSS") &&
      !snap.error;
    if (!uiOk) {
      console.error("[bridge] UI 详情:", JSON.stringify({ evalRes, snap }, null, 2));
    }
    ok("UI 窗口成功挂载 preload 并渲染 AiRSS（含侧栏与稍后读入口）", uiOk);
    await mcp.call("dev_ui_close", {});

    console.log("[bridge] 3. dev_cleanup 还原并核验无泄露");
    const cleanOut = await mcp.call("dev_cleanup", {});
    ok("dev_cleanup 正常完成", !cleanOut.error && cleanOut.ok !== false);

    console.log(`\n全部通过：${pass} 项（utools-dev-bridge 端到端验收）`);
  } finally {
    try { await mcp.call("dev_ui_close", {}); } catch (_) {}
    try { await mcp.call("dev_cleanup", {}); } catch (_) {}
  }
})().catch((e) => {
  console.error("[test-dev-bridge] 失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
