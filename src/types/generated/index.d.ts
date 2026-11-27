import events = require("./core/events.js");
/**
 * 渲染层边界消毒封装：防止未消毒的 contentHtml 直接写入本地正文并进入 v-html
 * （内部 scheduler.js 仍直调 storage.ingestFeed，不重复消毒）
 * @param {any} feedDoc
 * @param {any[]} parsedItems
 * @param {any} [feedMeta]
 */
declare function ingestFeedSafe(feedDoc: any, parsedItems: any[], feedMeta?: any): Promise<{
    ok: boolean;
    newCount: number;
    updatedCount: number;
    error: string;
    healedCount?: undefined;
} | {
    ok: boolean;
    newCount: number;
    updatedCount: number;
    healedCount: number;
    error: any;
}>;
import opmlSvc = require("./services/opml.js");
import refreshService = require("./core/refreshService.js");
import lifecycleMgr = require("./lifecycle.js");
import loggerSvc = require("./services/logger.js");
/**
 * 新建订阅源并写入同步库
 * @param {{ url: string, title?: string, category?: string, fullText?: boolean, refreshMin?: number, siteUrl?: string, desc?: string }} opts
 */
declare function createFeed({ url, title, category, fullText, refreshMin, siteUrl, desc }: {
    url: string;
    title?: string;
    category?: string;
    fullText?: boolean;
    refreshMin?: number;
    siteUrl?: string;
    desc?: string;
}): Promise<{
    etag: string;
    lastModified: string;
    lastFetchedAt: any;
    refreshMin: number;
    unreadCount: number;
    lastError: string;
    notify: boolean;
    createdAt: number;
    fullText?: boolean;
    _id: string;
    url: string;
    urlKey: string;
    title: string;
    titleEn: string;
    category: string;
    siteUrl: string;
    desc: string;
}>;
export let on: typeof events.on;
export namespace db {
    export let getFeeds: typeof import("./core/storage.js").getFeeds;
    export let saveFeed: typeof import("./core/storage.js").saveFeed;
    export let snapshotItems: typeof import("./core/storage.js").snapshotItems;
    export let itemsOfFeed: typeof import("./core/storage.js").itemsOfFeed;
    export { ingestFeedSafe as ingestFeed };
    export let setRead: typeof import("./core/storage.js").setRead;
    export let setStarred: typeof import("./core/storage.js").setStarred;
    export let setReadPos: typeof import("./core/storage.js").setReadPos;
    export let getReadPos: typeof import("./core/storage.js").getReadPos;
    export let markManyRead: typeof import("./core/storage.js").markManyRead;
    export let recalcUnread: typeof import("./core/storage.js").recalcUnread;
    export let getItemFull: typeof import("./core/storage.js").getItemFull;
    export let getItemDetail: typeof import("./core/storage.js").getItemDetail;
    export let retentionClean: typeof import("./core/storage.js").retentionClean;
    export let deleteFeedCascade: typeof import("./core/storage.js").deleteFeedCascade;
    export let clearAll: typeof import("./core/storage.js").clearAll;
    export let searchContent: typeof import("./core/storage.js").searchContent;
    export let rebuildSearchIndex: typeof import("./core/storage.js").rebuildSearchIndex;
    export let clearBodyCache: typeof import("./core/storage.js").clearBodyCache;
    export let getLocalStats: typeof import("./core/storage.js").getLocalStats;
    export let detectLegacy: typeof import("./core/migrate.js").detectLegacy;
    export let cleanLegacySyncDocs: typeof import("./core/migrate.js").cleanLegacySyncDocs;
}
export namespace feed {
    let discover: (inputUrl: any) => Promise<{
        found: boolean;
        candidates: {
            url: any;
            title: any;
            itemCount: any;
            summaryOnly: boolean;
            externalLinks: boolean;
        }[];
        tried: {
            path: string;
            result: string;
        }[];
    } | {
        found: boolean;
        candidates: any[];
        tried: any[];
    }>;
    let normalizeUrl: (input: any) => string;
}
export namespace article {
    let readingMinutes: (text: any) => number;
    let ensureFull: (itemId: string) => Promise<{
        status: "off" | "hit" | "rich" | "fetched" | "error";
        content: string | null;
        error: string | null;
    }>;
}
export namespace opml {
    let parse: typeof opmlSvc.parseOpml;
    let build: typeof opmlSvc.buildOpml;
}
export namespace read {
    let getSnapshot: () => Promise<{
        feeds: any[];
        items: any[];
        stats: {
            total: any;
            unread: number;
            starred: number;
            later: number;
            laterUnread: number;
        };
    }>;
}
export namespace refresh {
    let due: typeof refreshService.refreshDue;
    let one: typeof refreshService.refreshOne;
    let abort: typeof refreshService.abort;
    let isRefreshing: typeof refreshService.isRefreshing;
}
export namespace later {
    let saveUrl: (rawUrl: any) => Promise<{
        ok: boolean;
        item: any;
        error: string;
    } | {
        ok: boolean;
        item: any;
        error: any;
    }>;
}
export namespace schedule {
    let getStatus: typeof refreshService.getScheduleStatus;
    let enable: typeof refreshService.enableSchedule;
    let disable: typeof refreshService.disableSchedule;
}
export namespace features {
    let isGlobalSearchEnabled: typeof lifecycleMgr.isGlobalSearchEnabled;
    let setGlobalSearchEnabled: typeof lifecycleMgr.setGlobalSearchEnabled;
}
export namespace lifecycle {
    let consumePendingActions: typeof lifecycleMgr.consumePendingActions;
}
export namespace ai {
    export let enrich: typeof import("./services/ai/pipelines/enrich.js").enrich;
    export let batchEnrich: typeof import("./services/ai/pipelines/batch.js").batchEnrich;
    export let translateItem: typeof import("./services/ai/pipelines/translate.js").translateItem;
    export let generateToc: typeof import("./services/ai/pipelines/toc.js").generateToc;
    let abort_1: typeof import("./services/ai/engines/index.js").abort;
    export { abort_1 as abort };
    let getStatus_1: () => Promise<{
        ready: boolean;
        engine: "utools" | "byok";
        models: any[];
        byokReady: boolean;
        byokStorage: string;
        reasoningEffort: "none" | "low" | "medium";
        quota: {
            manual: number;
            manualMax: number;
            bg: number;
            bgMax: number;
        };
        exempt: boolean;
    }>;
    export { getStatus_1 as getStatus };
    export let getConfig: typeof import("./services/ai/config.js").getConfig;
    export let saveConfig: typeof import("./services/ai/config.js").saveConfig;
    export let setByokKey: typeof import("./services/ai/config.js").setByokKey;
    export let hasByokKey: typeof import("./services/ai/config.js").hasByokKey;
    export let getByokStorageMode: typeof import("./services/ai/config.js").getByokStorageMode;
}
export namespace log {
    let debug: typeof loggerSvc.debug;
    let info: typeof loggerSvc.info;
    let warn: typeof loggerSvc.warn;
    let error: typeof loggerSvc.error;
    let getLogs: typeof loggerSvc.getLogs;
    let clear: typeof loggerSvc.clear;
    let dumpText: typeof loggerSvc.dumpText;
}
export namespace sys {
    /**
     * 通过系统打开文件对话框选择并读取 .opml/.xml 文件内容
     * @returns {{ picked: boolean, text: string }}
     */
    export function pickOpmlText(): {
        picked: boolean;
        text: string;
    };
    /**
     * 通过系统保存文件对话框导出 OPML 文本（强制 .opml/.xml 后缀）
     * @param {string} opmlText
     * @returns {{ saved: boolean }}
     */
    export function saveOpmlWithDialog(opmlText: string): {
        saved: boolean;
    };
    /**
     * 通过系统保存文件对话框导出诊断日志（强制 .txt/.log 后缀）
     * @returns {{ saved: boolean }}
     */
    export function exportLogsWithDialog(): {
        saved: boolean;
    };
    /**
     * 仅允许打开 http/https 外部链接
     * @param {string} url
     * @returns {boolean}
     */
    export function openExternal(url: string): boolean;
    export { createFeed };
}
export {};
