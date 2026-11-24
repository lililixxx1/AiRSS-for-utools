export function relTimeShort(ts: any): string;
export function getSnapshot(): Promise<{
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
export function computeStats(items: any): {
    total: any;
    unread: number;
    starred: number;
    later: number;
    laterUnread: number;
};
/** 同步读取当前内存快照中的统计与最新未读（供 onMainPush 同步回调使用） */
export function getUnreadTopSync(limit?: number): {
    unreadTotal: number;
    items: {
        _id: any;
        title: any;
        feedTitle: any;
        pubTs: any;
        relTime: string;
    }[];
};
/** 同步全文搜索（供 onMainPush over 模式调用） */
export function searchForMainPushSync(query: any, limit?: number): {
    _id: any;
    title: any;
    feedTitle: any;
    pubTs: any;
    relTime: string;
}[];
import storage = require("./storage.js");
export declare let search: typeof storage.searchContent;
export declare let markRead: typeof storage.setRead;
export declare function toggleStar(itemId: any): Promise<any>;
export declare let markManyRead: typeof storage.markManyRead;
export declare let setReadPos: typeof storage.setReadPos;
export declare let getReadPos: typeof storage.getReadPos;
export declare let getItemDetail: typeof storage.getItemDetail;
