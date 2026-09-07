/**
 * http.js — Node 侧网络请求（preload 与 UI 同线程，网络 IO 异步不阻塞渲染）
 *
 * 职责：
 *  - GET 请求 + 重定向跟随（≤3 跳，跨协议 http/https 均可）
 *  - gzip / deflate / br 解压（主流 CDN 必然压缩，不解压则 RSS 解析全败）
 *  - maxBytes 上限以「解压后」字节计（防压缩炸弹与超大响应）
 *  - 整体超时（默认 12s，到点销毁请求）
 *
 * 返回 { ok, url, status, headers, body:Buffer|null, truncated:boolean, error:string|null }
 * 不抛异常，错误一律走返回值（调用方好写统一失败分支）。
 */
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// keep-alive 连接池：订阅周期刷新（同源反复抓）与 AI 网关调用（同域名高频）
// 每次都全新 TCP+TLS 握手，复用可省 1-3 个 RTT；timeout 30s = 空闲 socket 自动回收，
// 防隐藏后台期间滞留连接。req.destroy()（超时/截断）会连带销毁 socket，池自动补位。
const kaHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 30_000, scheduling: "lifo" });
const kaHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 30_000, scheduling: "lifo" });

/**
 * @param {string} url
 * @param {{headers?:object, timeout?:number, maxBytes?:number, redirects?:number}} [opts]
 * @returns {Promise<{ok:boolean,url:string,status:number,headers:object,body:Buffer|null,truncated:boolean,error:string|null}>}
 */
async function nodeFetch(url, opts = {}) {
  const timeout = opts.timeout || 12000;
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  let redirectsLeft = opts.redirects === undefined ? 3 : opts.redirects;

  let currentUrl = url;
  // 重定向循环：每一跳重新走一次请求
  for (;;) {
    let target;
    try {
      target = new URL(currentUrl);
    } catch (e) {
      return fail(currentUrl, 0, null, "INVALID_URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return fail(currentUrl, 0, null, "UNSUPPORTED_PROTOCOL");
    }

    const res = await once(currentUrl, target, opts.headers, timeout, maxBytes);
    if (res.error) return res;

    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.location) {
      if (redirectsLeft <= 0) return fail(currentUrl, status, null, "TOO_MANY_REDIRECTS");
      let next;
      try {
        next = new URL(res.headers.location, currentUrl).toString();
      } catch (e) {
        return fail(currentUrl, status, null, "INVALID_REDIRECT");
      }
      redirectsLeft -= 1;
      currentUrl = next;
      continue; // 跟随重定向
    }
    return res;
  }
}

/** 单次请求（不带重定向逻辑） */
function once(urlStr, target, extraHeaders, timeout, maxBytes) {
  return new Promise((resolve) => {
    const mod = target.protocol === "https:" ? https : http;
    const headers = Object.assign(
      {
        "User-Agent": DEFAULT_UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
        "Accept-Encoding": "gzip, deflate, br",
      },
      extraHeaders || {}
    );

    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    // 首参必须传字符串：uTools preload 里 new URL() 产出的是渲染层 URL 对象，
    // 非 Node realm 实例，http.get 会把它当 options、把 options 当回调导致 TypeError
    const req = mod.get(
      urlStr,
      { headers, rejectUnauthorized: false, agent: target.protocol === "https:" ? kaHttpsAgent : kaHttpAgent },
      (res) => {
        const status = res.statusCode || 0;
        const resHeaders = res.headers || {};

        // 非 2xx/3xx：不读 body，直接返回（调用方按 lastError 处理）
        if (status < 200 || status >= 400) {
          res.resume(); // 丢弃 body 释放连接
          finish({ ok: false, url: urlStr, status, headers: resHeaders, body: null, truncated: false, error: "HTTP_" + status });
          return;
        }

        // 按声明的 Content-Encoding 解压
        const enc = String(resHeaders["content-encoding"] || "").toLowerCase().trim();
        let stream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate" || enc === "x-deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let received = 0;
        let truncated = false;
        stream.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            // 解压后超限：截断并销毁，标记 truncated（调用方记 lastError）
            truncated = true;
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", (e) => finish({ ok: false, url: urlStr, status, headers: resHeaders, body: null, truncated: false, error: "DECODE_" + (e.code || e.message).slice(0, 40) }));
        stream.on("end", () =>
          finish({ ok: true, url: urlStr, status, headers: resHeaders, body: Buffer.concat(chunks), truncated, error: truncated ? "TOO_LARGE" : null })
        );
      }
    );

    // 整体超时：到点销毁请求（连接慢/服务端挂起都覆盖）
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, url: urlStr, status: 0, headers: {}, body: null, truncated: false, error: "TIMEOUT" });
    }, timeout);

    req.on("error", (e) => {
      if (settled) return; // 主动 destroy 的情况已在 data 分支 settle
      finish({ ok: false, url: urlStr, status: 0, headers: {}, body: null, truncated: false, error: String(e.code || e.message || e).slice(0, 60) });
    });
  });
}

function fail(url, status, body, error) {
  return { ok: false, url, status: status || 0, headers: {}, body: body || null, truncated: false, error };
}

/**
 * POST JSON（AI BYOK 调用）：Node http(s) 本就不跟随重定向，3xx 一律拒绝（T-11 拒跨源重定向）；
 * sse=true 时按行回调 onLine(line)（不含换行符），完整文本仍累积在 text 里。
 * 返回 { ok, status, text, error }。opts.register(destroyFn) 暴露中途销毁句柄（ai.abort 用）。
 */
function postJson(urlStr, opts = {}) {
  const timeout = opts.timeout || 90_000;
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch (e) {
      return resolve({ ok: false, status: 0, text: "", error: "INVALID_URL" });
    }
    if (opts.httpsOnly !== false && target.protocol !== "https:") {
      return resolve({ ok: false, status: 0, text: "", error: "INSECURE_PROTOCOL" });
    }

    const mod = target.protocol === "https:" ? https : http;
    const headers = Object.assign(
      {
        "Content-Type": "application/json",
        Accept: opts.sse ? "text/event-stream" : "application/json",
        "Accept-Encoding": "identity", // SSE 按行切，不解压
      },
      opts.headers || {}
    );

    let settled = false;
    let text = "";
    let destroyed = false;
    const finish = (okFlag, status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: okFlag, status, text, error: error || null });
    };

    // 首参必须传字符串（realm 坑见 once() 注释）
    const req = mod.request(
      urlStr,
      { method: "POST", headers, rejectUnauthorized: false, agent: target.protocol === "https:" ? kaHttpsAgent : kaHttpAgent },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(false, status, "REDIRECTED"); // BYOK 网关换域名重定向一律拒绝
        }
        res.setEncoding("utf8");
        if (opts.sse && typeof opts.onLine === "function") {
          let buf = "";
          res.on("data", (chunk) => {
            text += chunk;
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).replace(/\r$/, "");
              buf = buf.slice(idx + 1);
              opts.onLine(line);
            }
          });
        } else {
          res.on("data", (c) => (text += c));
        }
        res.on("end", () => finish(true, status, null));
        res.on("error", (e) => finish(false, status, "STREAM_" + String(e.message || e).slice(0, 40)));
      }
    );

    const timer = setTimeout(() => {
      destroyed = true;
      req.destroy();
      finish(false, 0, "TIMEOUT");
    }, timeout);
    if (typeof opts.register === "function") {
      opts.register(() => {
        destroyed = true;
        req.destroy();
        finish(false, 0, "ABORTED");
      });
    }
    req.on("error", () => {
      if (!settled) finish(false, 0, destroyed ? "ABORTED" : "REQUEST_ERROR");
    });
    req.end(JSON.stringify(opts.json || {}));
  });
}

module.exports = { nodeFetch, postJson, DEFAULT_UA };
