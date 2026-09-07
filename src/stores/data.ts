import { defineStore } from "pinia";
import type { Feed, Item } from "../types";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";

/** 列表过滤器：统计三卡 / 订阅源 / 分类 / 标签 共用一个选择模型 */
export interface ListFilter {
  kind: "all" | "unread" | "starred" | "feed" | "category" | "tag";
  value?: string;
}

const noopHooks = {};

/** 搜索防抖句柄、扫描代际 token 与上次已扫词项（模块级：非响应态，不进 store） */
let searchTimer: number | undefined;
let scanSeq = 0;
let lastTerms = "";

/** 词项归一：多空白合一、小写，用于"词项确实变化才重扫"的比对 */
const normTerms = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** 过滤+搜索（静音剔除前）的口径：filtered 与 mutedInView 共用同一实现，防两处漂移 */
function filterSearchBase(state: { items: Item[]; feeds: Feed[]; filter: ListFilter; search: string; contentHits: Set<string> }): Item[] {
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = state.items;
  const f = state.filter;
  if (f.kind === "unread") list = list.filter((x) => !x.read);
  else if (f.kind === "starred") list = list.filter((x) => x.starred);
  else if (f.kind === "feed" && f.value) list = list.filter((x) => x.feedKey === f.value);
  else if (f.kind === "category" && f.value) {
    const feedIds = new Set(state.feeds.filter((fd) => (fd.category || "默认") === f.value).map((fd) => fd._id));
    list = list.filter((x) => feedIds.has(x.feedKey));
  } else if (f.kind === "tag" && f.value) {
    // 标签智能文件夹（C）：命中的是 AI 产物 tags，与搜索/静音天然叠加为交集
    list = list.filter((x) => x.ai?.tags?.includes(f.value!));
  }
  // 搜索 = 标题/摘要多词 AND 命中 ∪ 正文命中（contentHits 由 searchContent 异步回填，防抖期先出快结果）
  // 标题口径含 titleDisplay（AI 优化标题）：用户按卡片上明示的改写题搜索也能命中
  if (terms.length) {
    // 小写化每条只做一次（原来每个词项各 toLowerCase 一遍标题+摘要，3 词 = 6 次分配/条）
    const quick = (x: Item) => {
      const t = (x.titleDisplay || x.title).toLowerCase();
      const s = x.summaryText ? x.summaryText.toLowerCase() : "";
      return terms.every((term) => t.includes(term) || s.includes(term));
    };
    list = list.filter((x) => quick(x) || state.contentHits.has(x._id));
  }
  return list;
}

/** 静音命中（PLAN-V1.3 B）：多词 OR——任一词命中即静音（排雷宁多勿漏）；
 * 匹配面与搜索口径一致：titleDisplay||title + summaryText，小写 includes */
function isMuted(x: Item, words: string[]): boolean {
  const t = (x.titleDisplay || x.title).toLowerCase();
  const s = (x.summaryText || "").toLowerCase();
  return words.some((w) => t.includes(w.toLowerCase()) || s.includes(w.toLowerCase()));
}

export const useDataStore = defineStore("data", {
  state: () => ({
    feeds: [] as Feed[],
    items: [] as Item[],
    loaded: false,
    refreshing: false,
    progress: { done: 0, total: 0 },
    filter: { kind: "all" } as ListFilter,
    search: "",
    // 正文检索态（setSearch 防抖驱动，均不持久化；contentHits 为去前缀 itemId 集）
    contentHits: new Set<string>(),
    searchScanning: false,
    searchScanned: 0,
    searchTruncated: false,
    aiBusy: new Set<string>(), // 手动 AI 摘要进行中的 itemId（防重复点击；不持久化）
    opmlImporting: null as null | { done: number; total: number },
    mutePaused: false, // 静音暂停（内存态不持久化：暂停是临时检查动作，每次启动过滤默认生效）
  }),

  getters: {
    feedMap(state): Map<string, Feed> {
      return new Map(state.feeds.map((f) => [f._id, f]));
    },

    categories(state): { name: string; total: number; unread: number }[] {
      // 单遍计数：原实现对每源两遍全量 items.filter（O(源数×条数)），任意已读/星标翻转
      // 都触发全量重算，几十个源 × 万级条目时侧栏会明显卡顿
      const perFeed = new Map<string, { total: number; unread: number }>();
      for (const x of state.items) {
        const cur = perFeed.get(x.feedKey);
        if (cur) {
          cur.total += 1;
          if (!x.read) cur.unread += 1;
        } else {
          perFeed.set(x.feedKey, { total: 1, unread: x.read ? 0 : 1 });
        }
      }
      const byCat = new Map<string, { total: number; unread: number }>();
      for (const f of state.feeds) {
        const cat = f.category || "默认";
        const v = perFeed.get(f._id) || { total: 0, unread: 0 };
        const cur = byCat.get(cat) || { total: 0, unread: 0 };
        cur.total += v.total;
        cur.unread += v.unread;
        byCat.set(cat, cur);
      }
      return [...byCat.entries()].map(([name, v]) => ({ name, ...v }));
    },

    stats(state): { total: number; unread: number; starred: number } {
      let unread = 0;
      let starred = 0;
      for (const x of state.items) {
        if (!x.read) unread += 1;
        if (x.starred) starred += 1;
      }
      return { total: state.items.length, unread, starred };
    },

    /** 过滤 + 搜索 + 静音剔除 + 排序（搜索/全部已读基于全量快照，PLAN §9）。
     *  静音剔除位于搜索之后、排序之前；mutePaused 时跳过。计数三卡/侧栏未读基于全量 items
     *  不受影响——计数是事实、列表是视图，混算会让用户怀疑丢文章 */
    filtered(state): Item[] {
      const settings = useSettingsStore();
      let list = filterSearchBase(state);
      const words = settings.muteWords;
      if (words.length && !state.mutePaused) list = list.filter((x) => !isMuted(x, words));
      if (settings.orderBy === "oldest") return [...list].sort((a, b) => a.pubTs - b.pubTs);
      if (settings.orderBy === "unread") return [...list].sort((a, b) => Number(a.read) - Number(b.read) || b.pubTs - a.pubTs);
      return [...list].sort((a, b) => b.pubTs - a.pubTs); // newest 默认
    },

    /** 当前过滤+搜索口径下被静音篇数（透视入口；暂停态也回真实计数，按钮始终知道会静音几篇） */
    mutedInView(state): number {
      const settings = useSettingsStore();
      const words = settings.muteWords;
      if (!words.length) return 0;
      return filterSearchBase(state).filter((x) => isMuted(x, words)).length;
    },

    unreadTopTitles(state): string[] {
      // 单遍选 top3（原实现全量拷贝+排序只为取 3 条；onMainPush 每次拉取都跑）
      const top: Item[] = [];
      for (const x of state.items) {
        if (x.read) continue;
        if (top.length < 3 || x.pubTs > top[top.length - 1].pubTs) {
          top.push(x);
          top.sort((a, b) => b.pubTs - a.pubTs);
          if (top.length > 3) top.length = 3;
        }
      }
      return top.map((x) => x.title);
    },

    /** 标签云（PLAN-V1.3 C）：items 扁平化 ai.tags 计数降序取前 8；
     *  AI 关闭/无任何 tags 时为空数组 → 侧栏标签区整区不渲染（不制造"坏了"错觉） */
    topTags(state): { name: string; count: number }[] {
      const byTag = new Map<string, number>();
      for (const x of state.items) {
        if (!x.ai?.tags) continue;
        for (const t of x.ai.tags) {
          if (!t) continue;
          byTag.set(t, (byTag.get(t) || 0) + 1);
        }
      }
      return [...byTag.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 8);
    },
  },

  actions: {
    /** 搜索词统一入口：侧栏输入框 / utools 子输入框 / ⌫ 清空 / 空态按钮四路共用 */
    setSearch(q: string) {
      this.search = q;
      clearTimeout(searchTimer);
      const terms = normTerms(q);
      if (!terms) {
        scanSeq += 1; // 作废在途回包，防陈旧 scanned/truncated 落地
        lastTerms = "";
        this.contentHits = new Set();
        this.searchScanning = false;
        this.searchTruncated = false;
        this.searchScanned = 0;
        return;
      }
      if (terms === lastTerms) return; // 词项没变：不重扫（防抖静默/首尾空格等）
      // 换词：立即清旧命中（旧词的正文命中不能混进新查询结果），扫描回包前只剩标题/摘要快结果
      this.contentHits = new Set();
      this.searchTruncated = false;
      this.searchScanned = 0;
      searchTimer = window.setTimeout(() => this.runContentSearch(q, terms), 300);
    },

    /** 正文扫描（preload searchContent）；代际 token 丢弃过期回包，并发输入不叠跑两次 1.5s 预算扫描 */
    async runContentSearch(q: string, terms: string) {
      const seq = ++scanSeq;
      lastTerms = terms;
      this.searchScanning = true;
      this.searchTruncated = false;
      try {
        const r = await window.airss.db.searchContent(q);
        // 双重守卫：代际过期、或落地时用户已换词（防抖窗内旧扫描回包）都丢弃
        if (seq !== scanSeq || normTerms(this.search) !== terms) return;
        this.contentHits = new Set(r.ids);
        this.searchScanned = r.scanned;
        this.searchTruncated = r.truncated;
      } catch {
        if (seq === scanSeq) {
          this.contentHits = new Set(); // 失败降级：仅剩标题/摘要快结果
          lastTerms = ""; // 允许同词重试
        }
      } finally {
        if (seq === scanSeq) this.searchScanning = false;
      }
    },

    async loadAll() {
      const [feeds, items] = await Promise.all([window.airss.db.getFeeds(), window.airss.db.snapshotItems()]);
      // D2 排序口径：order 升序（首次拖拽前全员无 order → 保持 createdAt 序；此后新增源无 order 排末尾）
      this.feeds = feeds.sort((a: Feed, b: Feed) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt - b.createdAt);
      this.items = items.sort((a: Item, b: Item) => b.pubTs - a.pubTs);
      this.loaded = true;
    },

    /** 分类重指派（D1：重命名/合并/删除共用）。逐个落库（putRetry 自带冲突重试，feed 数量级小）；
     *  当前过滤命中旧分类名时跟随或复位。删除分类 = reassignCategory(name, "默认") */
    async reassignCategory(from: string, to: string) {
      if (from === to) return; // 守卫：目标即来源（含「默认」删除「默认」）为空操作
      const ui = useUiStore();
      const targets = this.feeds.filter((f) => (f.category || "默认") === from);
      for (const f of targets) {
        await window.airss.db.saveFeed({ ...f, category: to });
      }
      await this.loadAll();
      if (this.filter.kind === "category" && this.filter.value === from) {
        const stillThere = this.feeds.some((f) => (f.category || "默认") === to);
        this.filter = stillThere ? { kind: "category", value: to } : { kind: "all" };
      }
      ui.toast(`已将 ${targets.length} 个订阅移至「${to}」`);
    },

    /** 首次拖拽时给当前全部 feeds 按现序赋 order（只此一次批量落库，此后全员显式排序） */
    async initOrderOnce() {
      if (this.feeds.some((f) => typeof f.order === "number")) return;
      let i = 0;
      for (const f of this.feeds) {
        f.order = i++;
        await window.airss.db.saveFeed({ ...f });
      }
    },

    /** 拖拽落位：只重排受影响区间 [min,max] 的 order 再逐个落库（避免"拖一个、全体重写"） */
    async moveFeed(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.feeds.length || to >= this.feeds.length) return;
      const list = [...this.feeds];
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let i = lo; i <= hi; i++) {
        const f = list[i];
        f.order = i;
        await window.airss.db.saveFeed({ ...f });
      }
      this.feeds = list;
    },

    /** AI 轻量批（二期）：刷新/导入后对近 7 天未处理文章补 tags/标题（后台池，preload 侧 ≤20 篇/批） */
    queueAiBatch() {
      const settings = useSettingsStore();
      if (!settings.aiEnabled) return;
      const weekAgo = Date.now() - 7 * 86400e3; // T-08：首刷/导入只处理最近文章，历史存量不做 AI
      const pending = this.items.filter((x) => x.aiStatus === "none" && x.pubTs > weekAgo).slice(0, 20);
      if (!pending.length) return;
      window.airss.ai
        .batchEnrich(pending)
        .then((r) => {
          if (!r?.updated) return;
          for (const u of r.updated) {
            const i = this.items.findIndex((x) => x._id === u._id);
            if (i >= 0) this.items[i] = u;
          }
        })
        .catch(() => {}); // 后台任务失败不打扰阅读主流程
    },

    /** 到期源增量刷新（打开时/手动刷新共用）；manual=true 刷新全部忽略 refreshMin */
    async refreshDue(manual = false) {
      if (this.refreshing) return;
      const settings = useSettingsStore();
      const now = Date.now();
      const due = this.feeds.filter((f) => {
        if (manual) return true;
        const min = f.refreshMin > 0 ? f.refreshMin : settings.refreshMin;
        return !f.lastFetchedAt || now - f.lastFetchedAt > min * 60000; // lastFetchedAt null 一律视为到期
      });
      if (!due.length) return;

      this.refreshing = true;
      this.progress = { done: 0, total: due.length };
      const ui = useUiStore();
      try {
        const summary = await window.airss.scheduler.refreshFeeds(due, {
          onFeedDone: (feed: Feed, result: { ok: boolean; newCount: number; error: string | null }) => {
            this.progress.done += 1;
            // feed 文档已在 preload 侧推进（etag/unreadCount/lastError），此处同步内存
            const idx = this.feeds.findIndex((x) => x._id === feed._id);
            if (idx >= 0) this.feeds[idx] = { ...feed };
            if (result.ok && result.newCount > 0 && feed.notify && settings.notifyEnabled) {
              utools.showNotification(`${feed.title}：${result.newCount} 篇新文章`, "airss");
            }
          },
          ...noopHooks,
        });
        await this.loadAll();
        this.queueAiBatch(); // 轻量批：刷新完成后后台补 AI 标题/标签
        // 刷新完成后触发保留清理（PLAN §4 时机约定）
        const keep = settings.keepPerFeed;
        for (const f of this.feeds) {
          await window.airss.db.retentionClean(f, keep);
        }
        if (manual) {
          ui.toast(summary.newItems > 0 ? `刷新完成 · ${summary.newItems} 篇新文章` : "刷新完成 · 没有新文章");
        }
      } finally {
        this.refreshing = false;
      }
    },

    /** 发现确认后的落库 + 入库即首抓 */
    async addFeed(cand: { url: string; title: string; category: string }) {
      const doc = await window.airss.sys.createFeed(cand);
      this.feeds.push(doc);
      const result = await window.airss.scheduler.refreshOne(doc);
      await this.loadAll();
      this.queueAiBatch(); // 入库即首抓后补 AI（首刷节流：仅最近 7 天）
      return { doc, result };
    },

    async deleteFeed(feed: Feed) {
      const ui = useUiStore();
      const removed = await window.airss.db.deleteFeedCascade(feed);
      if (this.filter.kind === "feed" && this.filter.value === feed._id) this.filter = { kind: "all" };
      await this.loadAll();
      ui.toast(`已删除「${feed.title}」· 清理 ${removed} 篇文章`);
    },

    async updateFeed(feed: Feed, patch: Partial<Feed>) {
      Object.assign(feed, patch);
      if (patch.title !== undefined) feed.titleLocked = true;
      await window.airss.db.saveFeed(feed);
      await this.loadAll();
    },

    async markRead(item: Item, read = true) {
      item.read = read; // 乐观翻转（<300ms 反馈）
      const feed = this.feedMap.get(item.feedKey);
      if (feed) feed.unreadCount = Math.max(0, feed.unreadCount + (read ? -1 : 1));
      await window.airss.db.setRead(item._id, read);
    },

    async toggleStar(item: Item) {
      item.starred = !item.starred;
      await window.airss.db.setStarred(item._id, item.starred);
    },

    /** 手动 AI 摘要（自动摘要关闭时的逐篇按钮；列表卡片/行共用） */
    async summarizeItem(item: Item) {
      const settings = useSettingsStore();
      const ui = useUiStore();
      if (!settings.aiEnabled) return;
      if (this.aiBusy.has(item._id) || item.ai?.summary) return;
      this.aiBusy.add(item._id);
      window.airss.ai.abort(); // single-handle 纪律：先回收在飞调用（阅读面流/预取）
      try {
        const r = await window.airss.ai.enrich(item._id, {});
        if (r?.ok && r.item) {
          const i = this.items.findIndex((x) => x._id === r.item!._id);
          if (i >= 0) this.items[i] = r.item;
        } else if (r?.ok && r.ai) {
          // item 层直返不带文档：就地合并内存
          const i = this.items.findIndex((x) => x._id === item._id);
          if (i >= 0) {
            this.items[i].ai = r.ai as Item["ai"];
            this.items[i].aiStatus = "done";
            const disp = r.ai.titleNorm || r.ai.titleZh;
            if (disp && disp !== this.items[i].title) this.items[i].titleDisplay = disp;
          }
        } else if (r?.aborted || r?.error === "ABORTED") {
          // 被用户新调用抢占：安静结束
        } else {
          ui.toast(`AI 摘要失败：${r?.error === "QUOTA_EXHAUSTED" ? "今日额度已用完" : r?.error || "AI_FAILED"}`, "error");
        }
      } catch (e: any) {
        ui.toast("AI 摘要失败：" + String(e?.message || e), "error");
      } finally {
        this.aiBusy.delete(item._id);
      }
    },

    async markAllRead() {
      const ui = useUiStore();
      const ids = this.filtered.filter((x) => !x.read).map((x) => x._id);
      if (!ids.length) {
        ui.toast("没有未读文章");
        return;
      }
      await window.airss.db.markManyRead(ids);
      await this.loadAll();
      ui.toast(`已将 ${ids.length} 篇文章标为已读`);
    },

    async retryFeed(feed: Feed) {
      const ui = useUiStore();
      const r = await window.airss.scheduler.refreshOne(feed);
      await this.loadAll();
      if (r.ok) ui.toast(`「${feed.title}」同步成功`);
      else ui.toast(`同步失败：${r.error}`, "error");
    },

    /** OPML 导入：分批 50 源/批（进度可见；已存在跳过） */
    async importOpml(xmlText: string) {
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
      const existing = new Set(this.feeds.map((f) => f.url));
      const fresh = parsed.filter((p) => !existing.has(p.xmlUrl));
      this.opmlImporting = { done: 0, total: fresh.length };
      let i = 0;
      for (const p of fresh) {
        await window.airss.sys.createFeed({ url: p.xmlUrl, title: p.title, category: p.category, siteUrl: p.siteUrl });
        i += 1;
        this.opmlImporting = { done: i, total: fresh.length };
      }
      this.opmlImporting = null;
      await this.loadAll();
      ui.toast(`导入完成 · 新增 ${fresh.length} 个源${parsed.length - fresh.length ? `，跳过 ${parsed.length - fresh.length} 个已存在` : ""}，正在抓取首批文章`);
      this.refreshDue(); // 后台首抓
    },

    async exportOpml(filePath: string) {
      const ui = useUiStore();
      window.airss.sys.writeTextFile(filePath, window.airss.opml.build(this.feeds));
      ui.toast(`已导出 ${this.feeds.length} 个订阅源`);
    },

    async clearAllData() {
      const ui = useUiStore();
      await window.airss.db.clearAll();
      await this.loadAll();
      this.filter = { kind: "all" };
      ui.view = "main";
      ui.toast("已清空所有数据");
    },
  },
});
