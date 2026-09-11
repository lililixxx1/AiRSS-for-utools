/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** uTools 宿主 API（只在 uTools 内存在；浏览器 dev 由 mock 层兜底） */
interface UtoolsApi {
  onPluginEnter(cb: (action: { code: string; type: string; payload: any; from?: string }) => void): void;
  onPluginOut(cb: (isKill: boolean) => void): void;
  onMainPush(cb: (action: any) => any[], onSelect: (action: any) => boolean | undefined): void;
  onPluginDetach(cb: () => void): void;
  onDbPull(cb: (docs: any[]) => void): void;
  setSubInput(onChange: (text: string) => void, placeholder: string, isFocus?: boolean): void;
  removeSubInput(): void;
  subInputFocus(): void;
  showNotification(body: string, clickFeatureCode?: string): void;
  shellOpenExternal(url: string): void;
  showOpenDialog(options: any): string[] | null;
  showSaveDialog(options: any): string | null;
  isDarkColors(): boolean;
  getAppVersion(): string;
  redirect(label: string, payload?: any): void;
  outPlugin(isKill?: boolean): void;
  db: any;
  dbStorage: {
    getItem(key: string): any;
    setItem(key: string, value: any): void;
    removeItem(key: string): void;
  };
  [k: string]: any;
}

declare const utools: UtoolsApi;

interface Window {
  utools: UtoolsApi;
  airss: AirssServices;
}

/** preload 暴露的服务面（preload/index.js；浏览器 dev 由 mock 提供同形接口） */
interface AirssServices {
  db: {
    getFeeds(): Promise<any[]>;
    saveFeed(doc: any): Promise<any>;
    snapshotItems(): Promise<any[]>;
    itemsOfFeed(feedId: string): Promise<any[]>;
    ingestFeed(feedDoc: any, items: any[], meta: any): Promise<{ ok: boolean; newCount: number; updatedCount: number; error: string | null }>;
    setRead(itemId: string, read: boolean): Promise<any>;
    setStarred(itemId: string, starred: boolean): Promise<any>;
    markManyRead(ids: string[]): Promise<number>;
    recalcUnread(feedDoc: any): Promise<number>;
    getItemFull(itemId: string): Promise<string | null>;
    retentionClean(feedDoc: any, keep: number): Promise<number>;
    deleteFeedCascade(feedDoc: any): Promise<number>;
    clearAll(): Promise<number>;
    /** 内容搜索：扫 itemfull + itemfullx 双前缀正文（多词 AND，同 id 去重），只回 itemId 列表，正文不过 IPC；1500ms 预算截断 */
    searchContent(query: string): Promise<{ ids: string[]; scanned: number; truncated: boolean; ms: number }>;
  };
  feed: {
    discover(url: string): Promise<{ found: boolean; candidates: import("./types/index").FeedCandidate[]; tried: import("./types/index").TriedPath[] }>;
    fetch(url: string, cond?: any): Promise<any>;
    normalizeUrl(url: string): string;
  };
  article: {
    readingMinutes(text: string): number;
    /** 全文提取（PLAN-V1.3 A）：摘要型源打开文章时抓原文页 Readability 提取，preload 侧消毒后回传；
     *  status: off=源未开全文/hit=缓存命中/rich=feed 自带正文已达标/fetched=本次提取并落库/error=安静降级
     *  （error 含 NOT_FOUND、NO_LINK、FETCH_ 系列（TIMEOUT、HTTP 状态、EMPTY_BODY、TOO_LARGE）、
     *   EXTRACT_FAILED、EXTRACT_TOO_SHORT、STORE_FAILED；渲染层统一安静保留原摘要） */
    ensureFull(itemId: string): Promise<{
      status: "off" | "hit" | "rich" | "fetched" | "error";
      content: string | null;
      error: string | null;
    }>;
  };
  opml: {
    parse(xml: string): { title: string; xmlUrl: string; siteUrl: string; category: string }[];
    build(feeds: any[]): string;
  };
  scheduler: {
    refreshOne(feedDoc: any): Promise<{ ok: boolean; status: string; newCount: number; error: string | null }>;
    refreshFeeds(feedDocs: any[], hooks?: any): Promise<any>;
    abort(): void;
  };
  ai: {
    /** 打开文章的合并调用（流式产出 titleZh/titleNorm/tags/summary；opts.onDelta 收增量文本；成功路径附带回写后的 item 文档） */
    enrich(
      itemId: string,
      opts?: { bypass?: boolean; onDelta?: (text: string) => void }
    ): Promise<{ ok: boolean; aborted?: boolean; ai: import("./types/index").ArticleAi | null; cached: boolean; error: string | null; item?: any }>;
    /** 刷新后轻量批：候选文章补 tags/titleZh/titleNorm（preload 侧 ≤20 篇/次） */
    batchEnrich(items: any[]): Promise<{ ok: boolean; updated: any[]; error: string | null }>;
    /** AI 段落翻译：paras 由渲染层从正文 DOM 切的纯文本块，preload 只调引擎与落库 item.aiTrans（无 HTML 往返） */
    translateItem(
      itemId: string,
      paras: { idx: number; head: string; text: string }[],
      opts?: { bypass?: boolean; onDelta?: (text: string) => void }
    ): Promise<{ ok: boolean; aborted?: boolean; aiTrans: import("./types/index").ArticleAiTrans | null; cached: boolean; error: string | null }>;
    /** AI 目录生成（v1.4，PLAN-AI-TOC；PLAN-TOC-LEVEL 两级协议）：全量段落入（tag=h1-h6 供输入侧 # 标记），AI 划分章节起标题，产物落 item.aiToc（手动池；缓存为纯内容键 v2） */
    generateToc(
      itemId: string,
      paras: { idx: number; head: string; text: string; tag?: string }[],
      opts?: { bypass?: boolean }
    ): Promise<{ ok: boolean; aborted?: boolean; aiToc: import("./types/index").ArticleAiToc | null; cached: boolean; error: string | null }>;
    abort(): void;
    getStatus(): Promise<{
      ready: boolean;
      engine: string;
      models: { id: string; label: string; description: string; icon: string; cost: number }[];
      byokReady: boolean;
      quota: { manual: number; manualMax: number; bg: number; bgMax: number };
      exempt: boolean;
    }>;
    getConfig(): { enabled: boolean; engine: "utools" | "byok"; model: string; modelLabel: string; byokBaseUrl: string; byokModel: string; byokAllowHttp: boolean };
    saveConfig(patch: Partial<ReturnType<AirssServices["ai"]["getConfig"]>>): void;
    setByokKey(key: string): void;
    hasByokKey(): boolean;
  };
  log: {
    debug(tag: string, msg: string, data?: unknown): void;
    info(tag: string, msg: string, data?: unknown): void;
    warn(tag: string, msg: string, data?: unknown): void;
    error(tag: string, msg: string, data?: unknown): void;
    getLogs(): { t: number; level: string; tag: string; msg: string; data?: string }[];
    clear(): void;
    /** 全部日志格式化为纯文本（复制/导出用） */
    dumpText(): string;
  };
  sys: {
    readTextFile(path: string): string;
    writeTextFile(path: string, text: string): void;
    openExternal(url: string): void;
    createFeed(data: { url: string; title: string; category: string; siteUrl?: string; desc?: string }): Promise<any>;
  };
}
