/**
 * @param {string} url
 * @param {{headers?:object, timeout?:number, maxBytes?:number, redirects?:number}} [opts]
 * @returns {Promise<{ok:boolean,url:string,status:number,headers:object,body:Buffer|null,truncated:boolean,error:string|null}>}
 */
export function nodeFetch(url: string, opts?: {
    headers?: object;
    timeout?: number;
    maxBytes?: number;
    redirects?: number;
}): Promise<{
    ok: boolean;
    url: string;
    status: number;
    headers: object;
    body: any | null;
    truncated: boolean;
    error: string | null;
}>;
/**
 * POST JSON（AI BYOK 调用）：Node http(s) 本就不跟随重定向，3xx 一律拒绝（T-11 拒跨源重定向）；
 * sse=true 时按行回调 onLine(line)（不含换行符），完整文本仍累积在 text 里。
 * 返回 { ok, status, text, error }。opts.register(destroyFn) 暴露中途销毁句柄（ai.abort 用）。
 */
export function postJson(urlStr: any, opts?: {}): Promise<any>;
export const DEFAULT_UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
