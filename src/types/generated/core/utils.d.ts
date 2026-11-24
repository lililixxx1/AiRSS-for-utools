export function ut(): any;
export function db(): any;
export function store(): any;
export function sleep0(): Promise<any>;
/** SHA-256 hex 前 12 位（48bit 判重键） */
export function sha12(input: any): any;
export function newFeedId(): string;
/** 订阅源 URL 归一化判重键（与 src/lib/recommend.ts 完全同口径） */
export function feedUrlKey(url: any): string;
/** feed 本地分片哈希（稍后读伪源固定 __later__） */
export function feedHash(feedId: any): any;
/** 跨设备/重订阅稳定的条目键（不依赖随机 feed UUID） */
export function computeItemKey(urlKey: any, guid: any, link: any, title: any): any;
/**
 * 渲染层传入的文档可能是 Vue reactive Proxy —— utools IPC 走结构化克隆，Proxy 会抛
 * "An object could not be cloned."；入库前统一 JSON 深克隆为普通对象。
 */
export function plainClone(doc: any): any;
/** 本插件私有本地数据目录（<PluginLocalDataPath>/airss-data） */
export function getLocalRoot(): any;
export function ensureDir(dir: any): any;
/** 同目录写临时文件再 renameSync 原子替换（Windows 瞬时锁容忍 3 次） */
export function atomicWriteFileSync(filePath: any, content: any): void;
export function atomicWriteJsonSync(filePath: any, data: any): void;
export function readJsonSafe(filePath: any, fallback: any): any;
/** put 带冲突重试：失败重新 get 最新 _rev 后重试 */
export function putRetry(doc: any, tries?: number): Promise<any>;
/** bulkDocs 分批（≤50/批，批间让出主线程），返回是否全部成功 */
export function bulkSharded(docs: any, onProgress: any): Promise<boolean>;
/**
 * 批量删除同步库文档：有 _rev 时使用 bulkDocs + _deleted:true（每批 ≤50），
 * 缺失 _rev 的先批量补查一次或退回 remove。
 */
export function bulkDeleteSyncDocs(docsOrIds: any): Promise<number>;
