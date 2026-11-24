/**
 * 刷新单个源（入库即首抓 / 手动重试 / 批量调度共用）
 * @returns {Promise<{ok:boolean, status:string, newCount:number, error:string|null}>}
 */
export function refreshOne(feedDoc: any): Promise<{
    ok: boolean;
    status: string;
    newCount: number;
    error: string | null;
}>;
/**
 * 批量刷新到期源
 * @param {Array} feedDocs 到期源列表（渲染层已按 refreshMin 过滤）
 * @param {{onFeedDone?:(feed, result)=>void, onAllDone?:(summary)=>void}} [hooks]
 */
export function refreshFeeds(feedDocs: any[], hooks?: {
    onFeedDone?: (feed: any, result: any) => void;
    onAllDone?: (summary: any) => void;
}): Promise<{
    total: number;
    done: number;
    ok: number;
    failed: number;
    skipped: number;
    newItems: number;
}>;
/** 硬中断当前轮次（仅插件进程被杀时调用） */
export function abort(): void;
