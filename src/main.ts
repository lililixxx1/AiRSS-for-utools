import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/tokens.css";
import "./styles/base.css";

function boot() {
  createApp(App).use(createPinia()).mount("#app");
}

/** 全局错误捕获：假死/白屏最常见的根因是渲染层异常被吞，先落日志再谈排查 */
function wireErrorHooks() {
  window.addEventListener("error", (e) => {
    try {
      window.airss?.log?.error("renderer", e.message || "window.error", { source: e.filename, line: e.lineno });
    } catch {
      /* 日志层本身不可用时忽略 */
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      window.airss?.log?.error("renderer", "未处理的 Promise 拒绝", { reason: String(e.reason).slice(0, 200) });
    } catch {
      /* noop */
    }
  });
}

/** 宿主内 preload 挂载失败：与其白屏假死，不如显式报错页（此时连日志层都没有） */
function fatalHost(title: string, detail: string) {
  document.body.innerHTML =
    '<div style="height:100vh;display:flex;align-items:center;justify-content:center;background:#F9F6F1;' +
    'font-family:-apple-system,Segoe UI,Microsoft YaHei UI,PingFang SC,sans-serif;">' +
    '<div style="max-width:420px;padding:32px;background:#fff;border:1px solid #E8E5DF;border-radius:12px;' +
    'box-shadow:0 2px 8px rgba(41,37,36,.07);">' +
    '<div style="font-size:16px;font-weight:650;color:#292524;margin-bottom:8px;">' + title + "</div>" +
    '<div style="font-size:13px;line-height:1.7;color:#57534E;">' + detail + "</div>" +
    "</div></div>";
}

wireErrorHooks();

// uTools 宿主内：preload 已注入 window.airss/utools；纯浏览器 dev 装 mock 兜底
const hasUtools = !!(window as any).utools;
const hasAirss = !!(window as any).airss;

if (hasUtools && !hasAirss) {
  fatalHost(
    "preload 挂载失败",
    "window.airss 未注入：preload/index.js 或其依赖在 uTools 环境加载报错。<br>" +
      "请打开开发者工具 Console 查看具体报错（重点看 preload/services/ 的 require 错误），修复后重载插件。"
  );
} else if (!hasUtools && !hasAirss) {
  import("./lib/mock").then((m) => {
    m.installMock();
    boot();
  });
} else {
  boot();
}
