import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import type { Feed, Item } from "../types";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";

export interface ListFilter {
  kind: "all" | "unread" | "starred" | "later" | "feed" | "category" | "tag";
  value?: string;
}

let searchTimer: number | undefined;
let scanSeq = 0;
let lastTerms = "";
let eventsWired = false;

const normTerms = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");

function filterSearchBase(params: {
  items: Item[];
  feeds: Feed[];
  filter: ListFilter;
  search: string;
  contentHits: Set<string>;
}): Item[] {
  const terms = params.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = params.items;
  const f = params.filter;
  if (f.kind === "unread") list = list.filter((x) => !x.read);
  else if (f.kind === "starred") list = list.filter((x) => x.starred);
  else if (f.kind === "later") list = list.filter((x) => x.isLater || x.feedKey === "feed:__later__");
  else if (f.kind === "feed" && f.value) list = list.filter((x) => x.feedKey === f.value);
  else if (f.kind === "category" && f.value) {
    const feedIds = new Set(params.feeds.filter((fd) => fd.special !== "later" && (fd.category || "默认") === f.value).map((fd) => fd._id));
    list = list.filter((x) => feedIds.has(x.feedKey));
  } else if (f.kind === "tag" && f.value) {
    list = list.filter((x) => x.ai?.tags?.includes(f.value!));
  }

  if (terms.length) {
    const quick = (x: Item) => {
      const t = (x.titleDisplay || x.title).toLowerCase();
      const s = x.summaryText ? x.summaryText.toLowerCase() : "";
      return terms.every((term) => t.includes(term) || s.includes(term));
    };
    list = list.filter((x) => quick(x) || params.contentHits.has(x._id));
  }
  return list;
}

function isMuted(x: Item, words: string[]): boolean {
  const t = (x.titleDisplay || x.title).toLowerCase();
  const s = (x.summaryText || "").toLowerCase();
  return words.some((w) => t.includes(w.toLowerCase()) || s.includes(w.toLowerCase()));
}

export const useDataStore = defineStore("data", () => {
  const settings = useSettingsStore();

  // 使用 shallowRef 避免万级条目深层 Proxy 开销；所有局部变更通过替换数组或 triggerRef 触发视图更新
  const feeds = ref<Feed[]>([]);
  const items = shallowRef<Item[]>([]);
  const loaded = ref(false);
  const refreshing = ref(false);
  const progress = ref({ done: 0, total: 0 });
  const filter = ref<ListFilter>({ kind: "all" });
  const search = ref("");
  const contentHits = ref(new Set<string>());
  const searchScanning = ref(false);
  const searchScanned = ref(0);
  const searchTruncated = ref(false);
  const aiBusy = ref(new Set<string>());
  const opmlImporting = ref<null | { done: number; total: number }>(null);
  const mutePaused = ref(false);
  const laterBusy = ref(false);

  const regularFeeds = computed(() => feeds.value.filter((f) => f.special !== "later" && f._id !== "feed:__later__"));

  const feedMap = computed(() => new Map(feeds.value.map((f) => [f._id, f])));

  const categories = computed(() => {
    const perFeed = new Map<string, { total: number; unread: number }>();
    for (const x of items.value) {
      const cur = perFeed.get(x.feedKey);
      if (cur) {
        cur.total += 1;
        if (!x.read) cur.unread += 1;
      } else {
        perFeed.set(x.feedKey, { total: 1, unread: x.read ? 0 : 1 });
      }
    }
    const byCat = new Map<string, { total: number; unread: number }>();
    for (const f of regularFeeds.value) {
      const cat = f.category || "默认";
      const v = perFeed.get(f._id) || { total: 0, unread: 0 };
      const cur = byCat.get(cat) || { total: 0, unread: 0 };
      cur.total += v.total;
      cur.unread += v.unread;
      byCat.set(cat, cur);
    }
    return [...byCat.entries()].map(([name, v]) => ({ name, ...v }));
  });

  const stats = computed(() => {
    let unread = 0;
    let starred = 0;
    let later = 0;
    let laterUnread = 0;
    for (const x of items.value) {
      if (!x.read) unread += 1;
      if (x.starred) starred += 1;
      if (x.isLater || x.feedKey === "feed:__later__") {
        later += 1;
        if (!x.read) laterUnread += 1;
      }
    }
    return { total: items.value.length, unread, starred, later, laterUnread };
  });

  const filtered = computed(() => {
    let list = filterSearchBase({
      items: items.value,
      feeds: feeds.value,
      filter: filter.value,
      search: search.value,
      contentHits: contentHits.value,
    });
    const words = settings.muteWords;
    if (words.length && !mutePaused.value) list = list.filter((x) => !isMuted(x, words));
    if (settings.orderBy === "oldest") return [...list].sort((a, b) => a.pubTs - b.pubTs);
    if (settings.orderBy === "unread") return [...list].sort((a, b) => Number(a.read) - Number(b.read) || b.pubTs - a.pubTs);
    return [...list].sort((a, b) => b.pubTs - a.pubTs);
  });

  const mutedInView = computed(() => {
    const words = settings.muteWords;
    if (!words.length) return 0;
    return filterSearchBase({
      items: items.value,
      feeds: feeds.value,
      filter: filter.value,
      search: search.value,
      contentHits: contentHits.value,
    }).filter((x) => isMuted(x, words)).length;
  });

  const unreadTopTitles = computed(() => {
    const top: Item[] = [];
    for (const x of items.value) {
      if (x.read) continue;
      if (top.length < 3 || x.pubTs > top[top.length - 1].pubTs) {
        top.push(x);
        top.sort((a, b) => b.pubTs - a.pubTs);
        if (top.length > 3) top.length = 3;
      }
    }
    return top.map((x) => x.title);
  });

  const topTags = computed(() => {
    const byTag = new Map<string, number>();
    for (const x of items.value) {
      if (!x.ai?.tags) continue;
      for (const t of x.ai.tags) {
        if (!t) continue;
        byTag.set(t, (byTag.get(t) || 0) + 1);
      }
    }
    return [...byTag.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 8);
  });

  function recomputeFeedUnreadLocal() {
    const unreadBy = new Map<string, number>();
    for (const it of items.value) if (!it.read) unreadBy.set(it.feedKey, (unreadBy.get(it.feedKey) || 0) + 1);
    for (const f of feeds.value) f.unreadCount = unreadBy.get(f._id) || 0;
  }

  function replaceItemInPlace(updated: Item) {
    const arr = items.value.slice();
    const idx = arr.findIndex((x) => x._id === updated._id);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...updated };
    else arr.unshift(updated);
    items.value = arr;
    recomputeFeedUnreadLocal();
  }

  function wirePreloadEvents() {
    if (eventsWired || typeof window.airss?.on !== "function") return;
    eventsWired = true;

    window.airss.on("refresh-progress", (p: any) => {
      refreshing.value = !!p?.refreshing;
      progress.value = { done: p?.done || 0, total: p?.total || 0 };
      if (p?.feed) {
        const idx = feeds.value.findIndex((f) => f._id === p.feed._id);
        if (idx >= 0) feeds.value[idx] = { ...feeds.value[idx], ...p.feed };
      }
    });

    window.airss.on("feeds-changed", async () => {
      const fList = await window.airss.db.getFeeds();
      feeds.value = fList.sort((a: Feed, b: Feed) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt - b.createdAt);
      recomputeFeedUnreadLocal();
    });

    window.airss.on("items-changed", async (ev: any) => {
      if (ev?.kind === "ai-updated" && Array.isArray(ev.items)) {
        const arr = items.value.slice();
        for (const u of ev.items) {
          const idx = arr.findIndex((x) => x._id === u._id);
          if (idx >= 0) arr[idx] = { ...arr[idx], ...u };
        }
        items.value = arr;
        return;
      }
      if (ev?.kind === "state" && !ev.removed && Array.isArray(ev.patch)) {
        const patchMap = new Map<string, any>();
        for (const p of ev.patch) {
          if (p && p._id) patchMap.set(p._id, p);
        }
        if (patchMap.size) {
          let dirty = false;
          const arr = items.value;
          const next = arr.slice();
          for (let i = 0; i < arr.length; i++) {
            const p = patchMap.get(arr[i]._id);
            if (!p) continue;
            const cur = arr[i];
            if (
              (p.read !== undefined && cur.read !== !!p.read) ||
              (p.starred !== undefined && cur.starred !== !!p.starred)
            ) {
              next[i] = {
                ...cur,
                ...(p.read !== undefined ? { read: !!p.read } : {}),
                ...(p.starred !== undefined ? { starred: !!p.starred } : {}),
              };
              dirty = true;
            }
          }
          if (dirty) {
            items.value = next;
            recomputeFeedUnreadLocal();
          }
          return;
        }
      }
      // 其余局部/同步变化由 read.getSnapshot 快速合并，不再做跨进程全量读取 itemfull
      await loadAll();
    });
  }

  function setSearch(q: string) {
    search.value = q;
    clearTimeout(searchTimer);
    const terms = normTerms(q);
    if (!terms) {
      scanSeq += 1;
      lastTerms = "";
      contentHits.value = new Set();
      searchScanning.value = false;
      searchTruncated.value = false;
      searchScanned.value = 0;
      return;
    }
    if (terms === lastTerms) return;
    contentHits.value = new Set();
    searchTruncated.value = false;
    searchScanned.value = 0;
    searchTimer = window.setTimeout(() => runContentSearch(q, terms), 150);
  }

  async function runContentSearch(q: string, terms: string) {
    const seq = ++scanSeq;
    lastTerms = terms;
    searchScanning.value = true;
    searchTruncated.value = false;
    try {
      const r = await window.airss.db.searchContent(q);
      if (seq !== scanSeq || normTerms(search.value) !== terms) return;
      contentHits.value = new Set(r.ids);
      searchScanned.value = r.scanned;
      searchTruncated.value = !!r.truncated;
    } catch {
      if (seq === scanSeq) {
        contentHits.value = new Set();
        lastTerms = "";
      }
    } finally {
      if (seq === scanSeq) searchScanning.value = false;
    }
  }

  async function loadAll() {
    wirePreloadEvents();
    const snap = await window.airss.read.getSnapshot();
    feeds.value = snap.feeds;
    items.value = snap.items;
    recomputeFeedUnreadLocal();
    loaded.value = true;
  }

  async function reassignCategory(from: string, to: string) {
    if (from === to) return;
    const ui = useUiStore();
    const targets = regularFeeds.value.filter((f) => (f.category || "默认") === from);
    for (const f of targets) {
      f.category = to;
      await window.airss.db.saveFeed({ ...f, category: to });
    }
    if (filter.value.kind === "category" && filter.value.value === from) {
      const stillThere = regularFeeds.value.some((f) => (f.category || "默认") === to);
      filter.value = stillThere ? { kind: "category", value: to } : { kind: "all" };
    }
    ui.toast(`已将 ${targets.length} 个订阅移至「${to}」`);
  }

  async function initOrderOnce() {
    if (regularFeeds.value.some((f) => typeof f.order === "number")) return;
    let i = 0;
    for (const f of regularFeeds.value) {
      f.order = i++;
      await window.airss.db.saveFeed({ ...f });
    }
  }

  async function moveFeed(from: number, to: number) {
    const reg = [...regularFeeds.value];
    if (from === to || from < 0 || to < 0 || from >= reg.length || to >= reg.length) return;
    const [moved] = reg.splice(from, 1);
    reg.splice(to, 0, moved);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) {
      const f = reg[i];
      f.order = i;
      await window.airss.db.saveFeed({ ...f });
    }
    const specials = feeds.value.filter((f) => f.special === "later" || f._id === "feed:__later__");
    feeds.value = [...reg, ...specials];
  }

  async function refreshDue(manual = false) {
    if (refreshing.value) return;
    const ui = useUiStore();
    refreshing.value = true;
    try {
      const summary = await window.airss.refresh.due({ manual, trigger: manual ? "manual" : "enter" });
      if (manual) {
        ui.toast(summary.newItems > 0 ? `刷新完成 · ${summary.newItems} 篇新文章` : "刷新完成 · 没有新文章");
      }
    } finally {
      refreshing.value = false;
    }
  }

  async function addFeed(cand: { url: string; title: string; category: string; fullText?: boolean; refreshMin?: number }) {
    const doc = await window.airss.sys.createFeed(cand);
    feeds.value = [...feeds.value, doc];
    const result = await window.airss.refresh.one(doc._id);
    const fSnap = await window.airss.db.getFeeds();
    feeds.value = fSnap.sort((a: Feed, b: Feed) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt - b.createdAt);
    const allItems = await window.airss.db.snapshotItems();
    items.value = allItems.sort((a: Item, b: Item) => b.pubTs - a.pubTs);
    recomputeFeedUnreadLocal();
    return { doc, result };
  }

  async function deleteFeed(feed: Feed) {
    const ui = useUiStore();
    const removed = await window.airss.db.deleteFeedCascade(feed);
    if (filter.value.kind === "feed" && filter.value.value === feed._id) filter.value = { kind: "all" };
    feeds.value = feeds.value.filter((f) => f._id !== feed._id);
    items.value = items.value.filter((x) => x.feedKey !== feed._id);
    recomputeFeedUnreadLocal();
    if (ui.readerItemId && !items.value.some((x) => x._id === ui.readerItemId)) {
      if (ui.view === "reader") ui.closeReader();
      else ui.readerItemId = null;
    }
    ui.toast(`已删除「${feed.title}」· 清理 ${removed} 篇文章`);
  }

  async function updateFeed(feed: Feed, patch: Partial<Feed>) {
    Object.assign(feed, patch);
    if (patch.title !== undefined) feed.titleLocked = true;
    const saved = await window.airss.db.saveFeed({ ...feed });
    if (saved) {
      const idx = feeds.value.findIndex((f) => f._id === feed._id);
      if (idx >= 0) feeds.value[idx] = { ...feeds.value[idx], ...saved };
      recomputeFeedUnreadLocal();
    }
  }

  async function markRead(item: Item, read = true) {
    if (item.read === read) return;
    replaceItemInPlace({ ...item, read });
    await window.airss.db.setRead(item._id, read);
  }

  async function toggleStar(item: Item) {
    const nextStar = !item.starred;
    replaceItemInPlace({ ...item, starred: nextStar });
    await window.airss.db.setStarred(item._id, nextStar);
  }

  async function summarizeItem(item: Item) {
    const ui = useUiStore();
    if (!settings.aiEnabled) return;
    if (aiBusy.value.has(item._id) || item.ai?.summary) return;
    aiBusy.value.add(item._id);
    window.airss.ai.abort();
    try {
      const r = await window.airss.ai.enrich(item._id, {});
      if (r?.ok && r.item) {
        replaceItemInPlace(r.item);
      } else if (r?.ok && r.ai) {
        const next: Item = {
          ...item,
          ai: r.ai as Item["ai"],
          aiStatus: "done",
          titleDisplay: r.ai.titleNorm || r.ai.titleZh || item.title,
        };
        replaceItemInPlace(next);
      } else if (r?.aborted || r?.error === "ABORTED") {
        // quiet
      } else {
        ui.toast(`AI 摘要失败：${r?.error === "QUOTA_EXHAUSTED" ? "今日额度已用完" : r?.error || "AI_FAILED"}`, "error");
      }
    } catch (e: any) {
      ui.toast("AI 摘要失败：" + String(e?.message || e), "error");
    } finally {
      aiBusy.value.delete(item._id);
    }
  }

  async function markAllRead() {
    const ui = useUiStore();
    const ids = filtered.value.filter((x) => !x.read).map((x) => x._id);
    if (!ids.length) {
      ui.toast("没有未读文章");
      return;
    }
    await window.airss.db.markManyRead(ids);
    const idSet = new Set(ids);
    const arr = items.value.slice();
    for (let i = 0; i < arr.length; i++) {
      if (idSet.has(arr[i]._id) && !arr[i].read) {
        arr[i] = { ...arr[i], read: true };
      }
    }
    items.value = arr;
    recomputeFeedUnreadLocal();
    ui.toast(`已将 ${ids.length} 篇文章标为已读`);
  }

  async function retryFeed(feed: Feed) {
    const ui = useUiStore();
    const r = await window.airss.refresh.one(feed._id);
    const fSnap = await window.airss.db.getFeeds();
    feeds.value = fSnap.sort((a: Feed, b: Feed) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt - b.createdAt);
    const allItems = await window.airss.db.snapshotItems();
    items.value = allItems.sort((a: Item, b: Item) => b.pubTs - a.pubTs);
    recomputeFeedUnreadLocal();
    if (r.ok) ui.toast(`「${feed.title}」同步成功`);
    else ui.toast(`同步失败：${r.error}`, "error");
  }

  async function importOpml(xmlText: string) {
    const ui = useUiStore();
    let parsed;
    try {
      parsed = window.airss.opml.parse(xmlText);
    } catch (e: any) {
      ui.toast("OPML 解析失败：" + (e?.message || e), "error");
      return;
    }
    if (!parsed.length) {
      ui.toast("OPML 中没有找到订阅源");
      return;
    }
    const existing = new Set(feeds.value.map((f) => f.url));
    const fresh = parsed.filter((p) => !existing.has(p.xmlUrl));
    opmlImporting.value = { done: 0, total: fresh.length };
    let i = 0;
    try {
      for (const p of fresh) {
        await window.airss.sys.createFeed({ url: p.xmlUrl, title: p.title, category: p.category, siteUrl: p.siteUrl });
        i += 1;
        opmlImporting.value = { done: i, total: fresh.length };
      }
    } catch (e: any) {
      ui.toast(`导入中断（已完成 ${i}/${fresh.length}）：` + String(e?.message || e), "error");
    } finally {
      opmlImporting.value = null;
    }
    await loadAll();
    if (i > 0 || fresh.length === 0) {
      ui.toast(`导入完成 · 新增 ${i} 个源${parsed.length - fresh.length ? `，跳过 ${parsed.length - fresh.length} 个已存在` : ""}${i > 0 ? "，正在抓取首批文章" : ""}`);
    }
    if (i > 0) void refreshDue();
  }

  async function exportOpml() {
    const ui = useUiStore();
    try {
      const res = window.airss.sys.saveOpmlWithDialog(window.airss.opml.build(regularFeeds.value));
      if (res?.saved) {
        ui.toast(`已导出 ${regularFeeds.value.length} 个订阅源`);
      }
    } catch (e: any) {
      ui.toast("导出 OPML 失败：" + String(e?.message || e), "error");
    }
  }

  async function saveLater(rawUrl: string): Promise<boolean> {
    const ui = useUiStore();
    const url = rawUrl.trim();
    if (!url || laterBusy.value) return false;
    laterBusy.value = true;
    try {
      const r = await window.airss.later.saveUrl(url);
      if (r?.ok) {
        await loadAll();
        ui.toast(`已存入稍后读：${r.item?.title || url}`);
        return true;
      }
      const msg =
        r?.error === "INVALID_URL"
          ? "请输入有效的 http(s) 网页链接"
          : `存入稍后读失败：${r?.error || "SAVE_FAILED"}`;
      ui.toast(msg, "error");
      return false;
    } catch (e: any) {
      ui.toast("存入稍后读失败：" + String(e?.message || e), "error");
      return false;
    } finally {
      laterBusy.value = false;
    }
  }

  async function clearAllData() {
    const ui = useUiStore();
    await window.airss.db.clearAll();
    await loadAll();
    filter.value = { kind: "all" };
    setSearch("");
    ui.closeReader();
    ui.toast("已清空所有数据");
  }

  return {
    feeds,
    regularFeeds,
    items,
    loaded,
    refreshing,
    progress,
    filter,
    search,
    contentHits,
    searchScanning,
    searchScanned,
    searchTruncated,
    aiBusy,
    opmlImporting,
    mutePaused,
    laterBusy,
    feedMap,
    categories,
    stats,
    filtered,
    mutedInView,
    unreadTopTitles,
    topTags,
    setSearch,
    loadAll,
    reassignCategory,
    initOrderOnce,
    moveFeed,
    refreshDue,
    addFeed,
    deleteFeed,
    updateFeed,
    markRead,
    toggleStar,
    summarizeItem,
    markAllRead,
    retryFeed,
    importOpml,
    exportOpml,
    saveLater,
    clearAllData,
    replaceItemInPlace,
  };
});
