// @ts-check
/**
 * readService.js — 阅读与列表查询领域服务（UI、mainPush 共用）
 */
const storage = require("./storage.js");

function relTimeShort(ts) {
  const diff = Math.max(0, Date.now() - (Number(ts) || 0));
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + "分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "小时前";
  const d = Math.floor(h / 24);
  return d + "天前";
}

async function getSnapshot() {
  const [feeds, items] = await Promise.all([storage.getFeeds(), storage.snapshotItems()]);
  feeds.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.createdAt || 0) - (b.createdAt || 0));
  items.sort((a, b) => (b.pubTs || 0) - (a.pubTs || 0));
  return { feeds, items, stats: computeStats(items) };
}

function computeStats(items) {
  let unread = 0;
  let starred = 0;
  let later = 0;
  let laterUnread = 0;
  for (const x of items) {
    if (!x.read) unread += 1;
    if (x.starred) starred += 1;
    if (x.isLater || x.feedKey === "feed:__later__") {
      later += 1;
      if (!x.read) laterUnread += 1;
    }
  }
  return { total: items.length, unread, starred, later, laterUnread };
}

/** 同步读取当前内存快照中的统计与最新未读（供 onMainPush 同步回调使用） */
function getUnreadTopSync(limit = 4) {
  const { itemById, syncFeedMap } = storage._getInternals();
  let unreadTotal = 0;
  const top = [];
  for (const entry of itemById.values()) {
    const it = entry.item;
    if (it.read) continue;
    unreadTotal += 1;
    if (top.length < limit || (it.pubTs || 0) > (top[top.length - 1].pubTs || 0)) {
      top.push(it);
      top.sort((a, b) => (b.pubTs || 0) - (a.pubTs || 0));
      if (top.length > limit) top.length = limit;
    }
  }
  return {
    unreadTotal,
    items: top.map((it) => {
      const f = it.feedKey ? syncFeedMap.get(it.feedKey) : null;
      return {
        _id: it._id,
        title: it.titleDisplay || it.title || "",
        feedTitle: (f && f.title) || it.feedTitle || "AiRSS",
        pubTs: it.pubTs || 0,
        relTime: relTimeShort(it.pubTs),
      };
    }),
  };
}

/** 同步全文搜索（供 onMainPush over 模式调用） */
function searchForMainPushSync(query, limit = 5) {
  const searchIndex = require("./searchIndex.js");
  const { itemById, syncFeedMap } = storage._getInternals();
  const res = searchIndex.search(query, { limit });
  const out = [];
  for (const id of res.ids) {
    const entry = itemById.get(id);
    if (!entry) continue;
    const it = entry.item;
    const f = it.feedKey ? syncFeedMap.get(it.feedKey) : null;
    out.push({
      _id: it._id,
      title: it.titleDisplay || it.title || "",
      feedTitle: (f && f.title) || it.feedTitle || "AiRSS",
      pubTs: it.pubTs || 0,
      relTime: relTimeShort(it.pubTs),
    });
  }
  return out;
}

module.exports = {
  relTimeShort,
  getSnapshot,
  computeStats,
  getUnreadTopSync,
  searchForMainPushSync,
  search: storage.searchContent,
  markRead: storage.setRead,
  toggleStar: async (itemId) => {
    const item = await storage.getDoc(itemId);
    if (!item) return null;
    return storage.setStarred(itemId, !item.starred);
  },
  markManyRead: storage.markManyRead,
  setReadPos: storage.setReadPos,
  getReadPos: storage.getReadPos,
  getItemDetail: storage.getItemDetail,
};
