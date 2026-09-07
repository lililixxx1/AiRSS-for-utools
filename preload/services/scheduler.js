/**
 * scheduler.js — 打开即增量刷新的调度器
 *
 * 预算：并发 3（p-limit v3）；单请求 12s 超时（http 层）；单轮总预算 90s（超时源本轮跳过，下轮再试）。
 * 中断纪律（PLAN §5.1）：onPluginOut(isKill=true) 才 abort；隐藏后台（isKill=false）静默完成本批。
 */
const pLimitFactory = require("p-limit");
const pLimit = pLimitFactory.default || pLimitFactory; // v3 CJS 直接导出函数
const { fetchFeed } = require("./feed.js");
const dbSvc = require("./db.js");
const logger = require("./logger.js");

const CONCURRENCY = 3;
const ROUND_BUDGET_MS = 90_000;
let aborted = false;

/** 硬中断当前轮次（仅插件进程被杀时调用） */
function abort() {
  aborted = true;
}

const sleep0 = () => new Promise((r) => setTimeout(r, 0));

/**
 * 刷新单个源（入库即首抓 / 手动重试 / 批量调度共用）
 * @returns {Promise<{ok:boolean, status:string, newCount:number, error:string|null}>}
 */
async function refreshOne(feedDoc) {
  try {
    const res = await fetchFeed(feedDoc.url, { etag: feedDoc.etag, lastModified: feedDoc.lastModified, timeout: 12000 });

    if (res.status === "not_modified") {
      const r = await dbSvc.ingestFeed(feedDoc, [], { etag: feedDoc.etag, lastModified: feedDoc.lastModified });
      return { ok: r.ok, status: "not_modified", newCount: 0, error: r.error };
    }
    if (res.status === "error") {
      feedDoc.lastError = res.error || "UNKNOWN";
      await dbSvc.saveFeed(feedDoc);
      return { ok: false, status: "error", newCount: 0, error: feedDoc.lastError };
    }

    const r = await dbSvc.ingestFeed(feedDoc, res.items, { etag: res.etag, lastModified: res.lastModified, title: res.meta.title, siteUrl: res.meta.siteUrl, desc: res.meta.desc });
    await sleep0(); // 主线程预算：每源解析+入库后让出
    logger.info("feed.refresh", "单源刷新完成", { feed: feedDoc._id, ok: r.ok, new: r.newCount, updated: r.updatedCount, error: r.error });
    return { ok: r.ok, status: "ok", newCount: r.newCount, error: r.error };
  } catch (e) {
    feedDoc.lastError = String(e.message || e).slice(0, 80);
    logger.warn("feed.refresh", "单源刷新异常", { feed: feedDoc._id, error: feedDoc.lastError });
    try { await dbSvc.saveFeed(feedDoc); } catch (_) { /* 记录失败不致命 */ }
    return { ok: false, status: "error", newCount: 0, error: feedDoc.lastError };
  }
}

/**
 * 批量刷新到期源
 * @param {Array} feedDocs 到期源列表（渲染层已按 refreshMin 过滤）
 * @param {{onFeedDone?:(feed, result)=>void, onAllDone?:(summary)=>void}} [hooks]
 */
async function refreshFeeds(feedDocs, hooks = {}) {
  aborted = false;
  const deadline = Date.now() + ROUND_BUDGET_MS;
  const limit = pLimit(CONCURRENCY);
  const summary = { total: feedDocs.length, done: 0, ok: 0, failed: 0, skipped: 0, newItems: 0 };

  const tasks = feedDocs.map((feed) =>
    limit(async () => {
      if (aborted) {
        summary.skipped += 1;
        return;
      }
      if (Date.now() > deadline) {
        summary.skipped += 1; // 超总预算：本轮放弃，源仍保持到期状态
        return;
      }
      const result = await refreshOne(feed);
      summary.done += 1;
      if (result.ok) summary.ok += 1;
      else summary.failed += 1;
      summary.newItems += result.newCount;
      if (hooks.onFeedDone) hooks.onFeedDone(feed, result);
    })
  );

  await Promise.all(tasks);
  logger.info("feed.refresh", "本轮刷新结束", { total: summary.total, ok: summary.ok, failed: summary.failed, skipped: summary.skipped, newItems: summary.newItems });
  if (hooks.onAllDone) hooks.onAllDone(summary);
  return summary;
}

module.exports = { refreshOne, refreshFeeds, abort };
