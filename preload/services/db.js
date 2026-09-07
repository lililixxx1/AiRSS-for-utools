/**
 * db.js — 数据层（utools.db 文档模型的服务封装）
 *
 * 文档形态（PLAN §4）：
 *   feed:{uuid}                    订阅源
 *   item:{feed._id}:{hash12}       文章（轻字段；正文不进此文档）
 *   itemfull:{item._id}            正文（消毒 HTML ≤100KB，仅阅读时 get）
 *   itemfullx:{item._id}           提取版全文（PLAN-V1.3 A：Readability 产物，独立前缀
 *                                  不写回 itemfull——与 ingest 写序/contentHash 判重解耦）
 *
 * 写序纪律：items+itemfull bulk 全成功 → 才 put feed（推进 etag/lastFetchedAt + 重算 unreadCount）；
 * 任一失败不推进 etag，下轮重抓。冲突（_rev 过期）带退避重试 3 次。
 */
const crypto = require("crypto");

/** @returns utools.db.promises（preload 与渲染层同上下文） */
function db() {
  return (global.utools || window.utools).db.promises;
}
const sleep0 = () => new Promise((r) => setTimeout(r, 0));

/** SHA-256 hex 前 12 位（48bit 判重键） */
function sha12(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 12);
}

function newFeedId() {
  return "feed:" + crypto.randomUUID();
}

/**
 * 渲染层传入的文档是 Vue reactive Proxy —— utools IPC 走结构化克隆，Proxy 会抛
 * "An object could not be cloned."（本地 mock 测不出，实机必炸）。入库前统一
 * JSON 深克隆为普通对象；文档本身全是 JSON 形态字段，round-trip 无损。
 */
function plainClone(doc) {
  if (doc == null || typeof doc !== "object") return doc;
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch (_) {
    return doc; // 不可序列化对象原样透传，让 IPC 错误暴露问题
  }
}

/** put 带冲突重试：失败重新 get 最新 _rev 后重试 */
async function putRetry(doc, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await db().put(plainClone(doc));
    if (res.ok) {
      doc._rev = res.rev;
      return doc;
    }
    const fresh = await db().get(doc._id);
    if (fresh) doc._rev = fresh._rev; // 用最新版本重试
    else delete doc._rev;
    await sleep0();
  }
  return null; // 3 次仍失败，调用方记 lastError
}

/** bulkDocs 分批（≤50/批，批间让出主线程），返回是否全部成功 */
async function bulkSharded(docs, onProgress) {
  let ok = true;
  for (let i = 0; i < docs.length; i += 50) {
    const batch = docs.slice(i, i + 50);
    const results = await db().bulkDocs(batch.map(plainClone));
    results.forEach((r) => {
      if (r.error) ok = false;
      else {
        const d = batch.find((x) => x._id === r.id);
        if (d) d._rev = r.rev;
      }
    });
    if (onProgress) onProgress(i + batch.length, docs.length);
    await sleep0(); // 主线程预算：批间让出
  }
  return ok;
}

async function getFeeds() {
  return db().allDocs("feed:");
}

/** 通用 get（extract 等 preload 侧服务用；渲染层走各专用接口） */
async function getDoc(id) {
  return db().get(id);
}

async function saveFeed(feedDoc) {
  return putRetry(feedDoc);
}

/** 全量文章快照（内存索引；allDocs 无分页 API，PLAN §9 方案 A） */
async function snapshotItems() {
  return db().allDocs("item:");
}

async function itemsOfFeed(feedFullId) {
  return db().allDocs("item:" + feedFullId + ":");
}

// ---------------------------------------------------------------------------
// 刷新入库管线
// ---------------------------------------------------------------------------

/**
 * 解析产物 → 标准入库。返回 { ok, newCount, updatedCount, error }
 *
 * @param {object} feedDoc          feed 文档（须含 _id）
 * @param {Array} parsedItems       feed.js 归一化后的条目
 * @param {object} feedMeta         本次抓取元数据 { etag, lastModified, siteUrl, desc, title }
 */
async function ingestFeed(feedDoc, parsedItems, feedMeta) {
  const now = Date.now();
  const toWrite = []; // item 文档（新建+更新）
  const fullsToWrite = []; // itemfull 文档
  let newCount = 0;
  let updatedCount = 0;

  // 既有文档一次前缀预取：逐条 get 是 2N 次串行 IPC 往返（50 条的源 = 100 次），
  // 是刷新路径的头号开销；allDocs 快照与逐条 get 同样新鲜（本函数是每源唯一写方）
  const [existingItems, existingFulls] = await Promise.all([
    itemsOfFeed(feedDoc._id),
    db().allDocs("itemfull:item:" + feedDoc._id + ":"),
  ]);
  const byId = new Map(existingItems.map((d) => [d._id, d]));
  const fullRev = new Map(existingFulls.map((d) => [d._id, d._rev]));

  for (const it of parsedItems) {
    // hash12 输入：guid 存在仅取 guid（源方改标题/链接不影响 id 稳定性）
    const hashInput = it.guid || it.link || it.title || "";
    if (!hashInput) continue; // 三者皆空的脏条目直接丢
    let _id = "item:" + feedDoc._id + ":" + sha12(hashInput);

    const existing = byId.get(_id);
    if (existing && existing.title === it.title && existing.contentHash === it.contentHash) {
      continue; // 内容未变，跳过
    }

    if (existing) {
      // 更新策略：contentHash 变化才覆盖内容字段；read/starred/_rev 恒保留
      existing.title = it.title;
      existing.titleDisplay = it.title;
      existing.author = it.author || existing.author;
      existing.link = it.link || existing.link;
      existing.pubTs = it.pubTs;
      existing.summaryText = it.summaryText;
      existing.cover = it.cover;
      existing.contentHash = it.contentHash;
      // AI 产物随内容失效（T-09）：标题/正文已变，缓存键换新哈希，按新内容重新生成
      delete existing.ai;
      delete existing.aiTrans; // 段落译文同步失效（v1.2，同 T-09 纪律）
      existing.aiStatus = "none";
      // 提取版全文同步失效（T-09 同族）：先删后写——宁可丢一次提取下次重抓，
      // 也不让旧正文配新 contentHash（remove 不存在文档与 itemfull 同款容忍）
      await db().remove("itemfullx:" + _id);
      toWrite.push(existing);
      updatedCount += 1;
    } else {
      toWrite.push({
        _id,
        feedKey: feedDoc._id, // 冗余反查字段（渲染层按源过滤不用解析 _id）
        guid: it.guid || "",
        link: it.link || "",
        title: it.title,
        titleDisplay: it.title,
        author: it.author || "",
        pubTs: it.pubTs,
        fetchedAt: now,
        contentHash: it.contentHash,
        summaryText: it.summaryText,
        cover: it.cover,
        read: false,
        starred: false,
        aiStatus: "none", // 二期 AI 管线占位（schemaVersion 纪律见 PLAN §4）
      });
      newCount += 1;
    }
    if (it.contentHtml) {
      fullsToWrite.push({ _id: "itemfull:" + _id, content: it.contentHtml, _rev: fullRev.get("itemfull:" + _id) });
    }
  }

  // 写序：item/itemfull 全成功 → 才推进 feed
  let allOk = true;
  if (toWrite.length) allOk = await bulkSharded(toWrite);
  if (allOk && fullsToWrite.length) allOk = await bulkSharded(fullsToWrite);
  if (!allOk) return { ok: false, newCount, updatedCount, error: "BULK_FAILED" };

  // 无新文也推进 lastFetchedAt（否则每次打开都重复全量抓）
  const items = await itemsOfFeed(feedDoc._id);
  feedDoc.etag = feedMeta.etag || feedDoc.etag || "";
  feedDoc.lastModified = feedMeta.lastModified || feedDoc.lastModified || "";
  feedDoc.lastFetchedAt = now;
  feedDoc.lastError = "";
  if (feedMeta.title && !feedDoc.titleLocked) feedDoc.title = feedMeta.title;
  if (feedMeta.siteUrl) feedDoc.siteUrl = feedMeta.siteUrl;
  if (feedMeta.desc && !feedDoc.desc) feedDoc.desc = feedMeta.desc;
  feedDoc.unreadCount = items.filter((x) => !x.read).length;

  const saved = await putRetry(feedDoc);
  return { ok: !!saved, newCount, updatedCount, error: saved ? null : "FEED_PUT_FAILED" };
}

// ---------------------------------------------------------------------------
// 文章状态操作
// ---------------------------------------------------------------------------

async function setRead(itemId, read) {
  const doc = await db().get(itemId);
  if (!doc || doc.read === read) return doc;
  doc.read = read;
  return putRetry(doc);
}

async function setStarred(itemId, starred) {
  const doc = await db().get(itemId);
  if (!doc || doc.starred === starred) return doc;
  doc.starred = starred;
  return putRetry(doc);
}

/** 批量已读（渲染层给出过滤后的 id 列表；未读 0 篇时直接跳过） */
async function markManyRead(itemIds) {
  if (!itemIds.length) return 0;
  const docs = await db().allDocs(itemIds);
  const targets = docs.filter((d) => !d.read);
  targets.forEach((d) => (d.read = true));
  if (targets.length) await bulkSharded(targets);
  return targets.length;
}

/** 某源未读数重算并回写（unreadCount 是派生值，唯一真相源是 item 实态） */
async function recalcUnread(feedDoc) {
  const items = await itemsOfFeed(feedDoc._id);
  const n = items.filter((x) => !x.read).length;
  if (feedDoc.unreadCount !== n) {
    feedDoc.unreadCount = n;
    await putRetry(feedDoc);
  }
  return n;
}

// ---------------------------------------------------------------------------
// 正文分层存取
// ---------------------------------------------------------------------------

async function getItemFull(itemId) {
  const doc = await db().get("itemfull:" + itemId);
  return doc ? doc.content : null;
}

/** 全文最佳版本：优先 itemfullx（提取版，更完整），退化 itemfull（feed 自带）；ai.js enrich 用 */
async function getItemFullBest(itemId) {
  const x = await db().get("itemfullx:" + itemId);
  if (x && x.content) return x.content;
  const doc = await db().get("itemfull:" + itemId);
  return doc ? doc.content : null;
}

// ---------------------------------------------------------------------------
// 保留策略与删除
// ---------------------------------------------------------------------------

/**
 * 保留策略：每源最近 keep 篇（pubTs 序）+ 星标豁免；分片删除连带 itemfull。
 * 删除前逐条 get 复查 starred（防清理批与星标操作交错误删，PLAN §4）。
 */
async function retentionClean(feedDoc, keep) {
  const items = await itemsOfFeed(feedDoc._id);
  const doomed = items
    .filter((x) => !x.starred)
    .sort((a, b) => b.pubTs - a.pubTs)
    .slice(keep);
  for (const d of doomed) {
    const fresh = await db().get(d._id); // 复查：期间可能刚被星标
    if (!fresh || fresh.starred) continue;
    await db().remove("itemfull:" + d._id);
    await db().remove("itemfullx:" + d._id);
    await db().remove(d._id);
    await sleep0();
  }
  return doomed.length;
}

/** 删除订阅源：feed + item + itemfull 级联清理（分片让出），返回删除文章数 */
async function deleteFeedCascade(feedDoc) {
  const items = await itemsOfFeed(feedDoc._id);
  for (let i = 0; i < items.length; i++) {
    await db().remove("itemfull:" + items[i]._id);
    await db().remove("itemfullx:" + items[i]._id);
    await db().remove(items[i]._id);
    if (i % 50 === 49) await sleep0();
  }
  await db().remove(feedDoc._id);
  return items.length;
}

/** 清空所有数据（设置页危险操作，二次确认由渲染层负责） */
async function clearAll() {
  const all = await db().allDocs();
  for (let i = 0; i < all.length; i++) {
    await db().remove(all[i]._id);
    if (i % 50 === 49) await sleep0();
  }
  return all.length;
}

// ---------------------------------------------------------------------------
// 内容搜索（v1.2 需求 5：正文线性扫描；不做全文索引引擎，万级以下够用）
// ---------------------------------------------------------------------------

/**
 * 正文检索：扫 itemfull + itemfullx 双前缀（多词 AND、预算 1500ms 截断），只回 itemId 列表。
 * 同一 itemId 两前缀都命中 Set 去重后只回一次。opts.budgetMs 仅测试注入用。
 */
async function searchContent(query, opts = {}) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { ids: [], scanned: 0, truncated: false, ms: 0 };
  const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 1500;
  const t0 = Date.now();
  const ids = [];
  const seen = new Set();
  let truncated = false;
  let scanned = 0;
  const [fulls, fullxs] = await Promise.all([db().allDocs("itemfull:"), db().allDocs("itemfullx:")]); // 万级 allDocs 是已知 spike，预算内尽力
  for (const doc of fulls.concat(fullxs)) {
    if (Date.now() - t0 > budgetMs) { truncated = true; break; } // 同进程重循环：预算截断
    scanned += 1;
    const idStr = String(doc._id);
    const itemId = idStr.startsWith("itemfullx:") ? idStr.slice("itemfullx:".length) : idStr.slice("itemfull:".length);
    if (seen.has(itemId)) continue;
    const text = String(doc.content || "").toLowerCase();
    if (terms.every((t) => text.includes(t))) {
      seen.add(itemId);
      ids.push(itemId);
    }
    if (scanned % 25 === 0) await sleep0(); // 让出主线程
  }
  return { ids, scanned, truncated, ms: Date.now() - t0 };
}

module.exports = {
  sha12, newFeedId, putRetry, bulkSharded, plainClone,
  getFeeds, getDoc, saveFeed, snapshotItems, itemsOfFeed,
  ingestFeed, setRead, setStarred, markManyRead, recalcUnread,
  getItemFull, getItemFullBest, retentionClean, deleteFeedCascade, clearAll, searchContent,
};
