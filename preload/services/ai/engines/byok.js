// @ts-check
/**
 * ai/engines/byok.js — OpenAI 兼容 /chat/completions 引擎
 */
const logger = require("../../logger.js");
const { postJson } = require("../../http.js");
const { getByokKey, modelLabelFor } = require("../config.js");

function byokEndpoint(base) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return b + "/chat/completions";
  return b + "/v1/chat/completions";
}

async function callByok(messages, { cfg, stream, onDelta, claim, claimGate, setAbort, clearAbort }) {
  const key = getByokKey();
  if (!key) return { ok: false, error: "BYOK_KEY_MISSING" };
  const url = byokEndpoint(cfg.byokBaseUrl);
  if (!url) return { ok: false, error: "BYOK_URL_MISSING" };
  if (!claimGate(claim)) return { ok: false, aborted: true, error: "ABORTED" };

  let acc = "";
  let sseEvents = 0;
  const t0 = Date.now();
  const res = await postJson(url, {
    headers: { Authorization: "Bearer " + key },
    json: { model: cfg.byokModel || "gpt-4o-mini", messages, stream: !!stream },
    sse: !!stream,
    httpsOnly: !cfg.byokAllowHttp,
    register: (destroy) => setAbort(destroy),
    onLine: (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const j = JSON.parse(payload);
        sseEvents += 1;
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) {
          acc += String(t);
          if (onDelta) onDelta(String(t));
        }
      } catch (_) { /* ignore */ }
    },
  });
  clearAbort();

  if (res.error === "ABORTED") {
    logger.info("ai.call", "BYOK 调用被中止", { chars: acc.length });
    return { ok: false, aborted: true, error: "ABORTED" };
  }
  if (res.ok || (stream && acc)) {
    let content = acc;
    if (!stream) {
      try {
        const j = JSON.parse(res.text);
        content = String(j.choices[0].message.content || "");
      } catch (_) {
        content = "";
      }
    }
    logger.info("ai.call", "BYOK 调用完成", {
      engine: "byok",
      stream: !!stream,
      model: modelLabelFor(cfg),
      ms: Date.now() - t0,
      sseEvents,
      chars: content.length,
      head: content.slice(0, 24),
      tail: content.slice(-24),
    });
    if (content.trim()) return { ok: true, content };
    logger.warn("ai.call", "BYOK 空输出", { sseEvents, httpStatus: res.status });
    return { ok: false, error: "EMPTY_OUTPUT" };
  }
  logger.warn("ai.call", "BYOK 调用失败", { error: res.error, httpStatus: res.status });
  return { ok: false, error: res.error || "HTTP_" + res.status };
}

module.exports = { byokEndpoint, callByok };
