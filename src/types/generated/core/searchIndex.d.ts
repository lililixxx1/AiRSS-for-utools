/**
 * 中英文混合分词（索引 & 查询共用）：
 * - 英文/数字直接转小写词元
 * - CJK 连续块生成 2-gram；单字时保留单字，同时首字/尾字按前缀搜索可覆盖绝大多数单字输入
 */
export function tokenize(text: any): any[];
/**
 * 注册索引缺失/损坏时的全量重建回调（由 storage.init 一次性注入）
 * @param {(() => void | Promise<void>) | null} fn
 */
export function setRebuildProvider(fn: (() => void | Promise<void>) | null): void;
export function isReady(): boolean;
/**
 * 同步从磁盘加载索引（MiniSearch.loadJS 免二次编解码）；失败或版本不符返回 false。
 */
export function loadFromDisk(): boolean;
/**
 * 惰性异步加载或自愈重建索引（分片让出主线程；带 epoch 防重置竞态）
 * @returns {Promise<boolean>}
 */
export function ensureLoadedAsync(): Promise<boolean>;
/**
 * 全量重建索引
 * @param {Array<any>} items
 * @param {(item: any) => string} getBodyFn
 */
export function rebuildAll(items: Array<any>, getBodyFn: (item: any) => string): number;
export function upsert(item: any, bodyHtml: any): void;
export function remove(itemId: any): void;
export function removeMany(itemIds: any): void;
/**
 * 执行本地全文检索（无截断，目标 <50ms）
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {{ids: string[], scanned: number, truncated: boolean, ms: number}}
 */
export function search(query: string, opts?: {
    limit?: number;
}): {
    ids: string[];
    scanned: number;
    truncated: boolean;
    ms: number;
};
export function flush(): void;
export function documentCount(): any;
export function resetForTest(): void;
