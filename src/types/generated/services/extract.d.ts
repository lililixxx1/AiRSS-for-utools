/**
 * @param {string} itemId
 * @returns {Promise<{status:'off'|'hit'|'rich'|'fetched'|'error', content:string|null, error:string|null}>}
 */
export function ensureFull(itemId: string): Promise<{
    status: "off" | "hit" | "rich" | "fetched" | "error";
    content: string | null;
    error: string | null;
}>;
declare const FULLTEXT_MIN_CHARS: 600;
/** 站内适配产物的长度门槛（远低于通用全文线）：结构化栏目（导读/推荐理由/项目清单）天然短篇，
 *  按 600 拦等于把这些源唯一有效的内容丢回摘要；80 字≈两句话，低于此按「页面改版/空壳」处理回落通用链路 */
declare const ADAPTER_MIN_CHARS: 80;
/** 失败记忆窗口 / 上限：只记注定失败或过短的结果，成功结果走 itemfullx 持久缓存 */
declare const MEMO_TTL_MS: number;
/**
 * 相对 URL 绝对化：提取结果内 img[src]/a[href] 以 item.link 为基址补全。
 * 否则 sanitize 的 scheme 白名单会把 /assets/x.jpg 这类相对地址全剥（风险③）。
 * 协议相对（//host/x）与 data:/javascript: 由 new URL 解析或 sanitize 白名单兜底。
 */
declare function absolutize(html: any, base: any): any;
declare namespace ctx {
    function nodeFetch(url: any, opts: any): Promise<{
        ok: boolean;
        url: string;
        status: number;
        headers: object;
        body: any | null;
        truncated: boolean;
        error: string | null;
    }>;
}
/** 并发去重：同 item 并发调用合流（快速切文再切回不重复抓） */
declare const inflight: Map<any, any>;
/** 失败记忆：itemId → { res, at }（仅进程内存，退出即失；成功路径不经过它） */
declare const failureMemo: Map<any, any>;
export declare namespace __test {
    export { FULLTEXT_MIN_CHARS };
    export { ADAPTER_MIN_CHARS };
    export { MEMO_TTL_MS };
    export { absolutize };
    export { ctx };
    export { inflight };
    export { failureMemo };
    export function clearMemo(): void;
}
export {};
