export function init(force?: boolean): Promise<any>;
export function ensureInit(): Promise<void>;
export function resetForTest(): void;
export function getFeeds(): Promise<any[]>;
export function getFeed(feedId: any): Promise<any>;
export function saveFeed(feedDoc: any): Promise<any>;
export function snapshotItems(): Promise<any[]>;
export function itemsOfFeed(feedFullId: any): Promise<any[]>;
export function getDoc(id: any): Promise<any>;
export function getItemFull(itemId: any): Promise<any>;
export function getItemFullxMeta(itemId: any): Promise<any>;
export function getItemFullBest(itemId: any): Promise<any>;
/** 一次返回阅读面板所需的正文、提取全文、AI 译文、AI 目录与阅读进度 */
export function getItemDetail(itemId: any): Promise<{
    item: any;
    content: any;
    fullxContent: any;
    ai: any;
    aiTrans: any;
    aiToc: any;
    readPos: any;
}>;
export function saveItemFullx(itemId: any, clean: any, cover: any, src: any): Promise<boolean>;
export function saveItemAi(itemId: any, patch: any): Promise<any>;
export function ingestFeed(feedDoc: any, parsedItems: any, feedMeta?: {}): Promise<{
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
export function setRead(itemId: any, read: any): Promise<any>;
export function setStarred(itemId: any, starred: any): Promise<any>;
export function setReadPos(itemId: any, ratio: any): Promise<void>;
export function getReadPos(itemId: any): Promise<any>;
export function markManyRead(itemIds: any): Promise<number>;
export function recalcUnread(feedDoc: any): Promise<number>;
export function retentionClean(feedDoc: any, keep: any): Promise<number>;
export function deleteFeedCascade(feedDoc: any): Promise<number>;
/** 稍后读写入（供 laterService 调用） */
export function saveLaterArticle({ url, title, author, link, contentHtml, summaryText, cover, contentHash }: {
    url: any;
    title: any;
    author: any;
    link: any;
    contentHtml: any;
    summaryText: any;
    cover: any;
    contentHash: any;
}): Promise<any>;
/** 增量处理 onDbPull(docs)：绝不全量重读 */
export function applyPullDocs(docs: any): Promise<{
    feedsChanged: boolean;
    itemsChanged: boolean;
}>;
/** 清空所有数据（同步库全部文档 + 仅删 airss-data/，不动同级 devbridge-spill） */
export function clearAll(): Promise<number>;
/** 重建全文索引 */
export function rebuildSearchIndex(): Promise<{
    count: number;
    stats: {
        diskBytes: number;
        diskMb: number;
        files: number;
        indexedDocs: any;
        itemCount: number;
    };
}>;
/** 清理普通订阅正文与提取全文缓存（保留订阅、状态、已收藏正文与稍后读正文，并清空传输态） */
export function clearBodyCache(): Promise<{
    diskBytes: number;
    diskMb: number;
    files: number;
    indexedDocs: any;
    itemCount: number;
}>;
export function getLocalStats(): {
    diskBytes: number;
    diskMb: number;
    files: number;
    indexedDocs: any;
    itemCount: number;
};
export function flush(): void;
/**
 * 全文检索
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 */
export function searchContent(query: string, opts?: {
    limit?: number;
}): Promise<{
    ids: string[];
    scanned: number;
    truncated: boolean;
    ms: number;
}>;
/** 给 migrate.js / 测试使用的底层注入接口 */
export function _getInternals(): {
    localPaths: typeof localPaths;
    syncFeedMap: Map<string, any>;
    feedStateMap: Record<string, any>;
    stateMap: Map<string, any>;
    starMap: Map<string, any>;
    laterMap: Map<string, any>;
    shardMap: Map<string, any[]>;
    itemById: Map<string, {
        item: any;
        feedId: string;
    }>;
    itemByKey: Map<string, any>;
    writeShardSync: typeof writeShardSync;
    gzipWriteSync: typeof gzipWriteSync;
    writeAiSidecar: typeof writeAiSidecar;
    rebuildItemIndexes: typeof rebuildItemIndexes;
    saveFeedStateNow: typeof saveFeedStateNow;
    pickSyncFeedFields: typeof pickSyncFeedFields;
};
declare function localPaths(): {
    root: any;
    meta: any;
    feedState: any;
    feedsDir: any;
    bodiesDir: any;
    aiDir: any;
    shardFile: (feedId: any) => any;
    bodyFile: (feedId: any, itemKey: any) => any;
    fullxFile: (feedId: any, itemKey: any) => any;
    aiFile: (itemKey: any) => any;
};
declare function writeShardSync(feedId: any, list: any): void;
declare function gzipWriteSync(filePath: any, text: any): void;
declare function writeAiSidecar(itemKey: any, patch: any): void;
declare function rebuildItemIndexes(): void;
declare function saveFeedStateNow(): void;
declare function pickSyncFeedFields(feedDoc: any): {
    urlKey: string;
    special: string;
};
export {};
