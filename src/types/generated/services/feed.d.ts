/**
 * 条件抓取一个 feed。返回 {status:'ok'|'not_modified'|'error', meta?, items?, error?}
 * @param {string} feedUrl
 * @param {{etag?:string, lastModified?:string, timeout?:number}} cond
 */
export function fetchFeed(feedUrl: string, cond?: {
    etag?: string;
    lastModified?: string;
    timeout?: number;
}): Promise<{
    status: string;
    error: string;
    html?: undefined;
    finalUrl?: undefined;
    meta?: undefined;
    items?: undefined;
    etag?: undefined;
    lastModified?: undefined;
} | {
    status: string;
    error?: undefined;
    html?: undefined;
    finalUrl?: undefined;
    meta?: undefined;
    items?: undefined;
    etag?: undefined;
    lastModified?: undefined;
} | {
    status: string;
    error: string;
    html: string;
    finalUrl: string;
    meta?: undefined;
    items?: undefined;
    etag?: undefined;
    lastModified?: undefined;
} | {
    status: string;
    meta: {
        title: any;
        siteUrl: any;
        desc: any;
    };
    items: any[];
    etag: any;
    lastModified: any;
    error?: undefined;
    html?: undefined;
    finalUrl?: undefined;
}>;
/** 渲染层公开抓取结果：剥掉仅供 discoverFeed 内部复用的 raw html。
 *  安全基线（AGENTS「双道信任模型」）：原始 HTML 只允许留在 preload——`airss.feed.fetch`
 *  直接暴露 fetchFeed 会把未消毒远程 HTML 递给渲染层，成为注入隐患（2026-10 复盘加）。
 * @param {string} url
 * @param {{ etag?: string, lastModified?: string, timeout?: number }} [cond]
 */
export function fetchFeedPublic(url: string, cond?: {
    etag?: string;
    lastModified?: string;
    timeout?: number;
}): Promise<{
    status: string;
    error: string;
    html?: undefined;
    finalUrl?: undefined;
    meta?: undefined;
    items?: undefined;
    etag?: undefined;
    lastModified?: undefined;
} | {
    status: string;
    error?: undefined;
    html?: undefined;
    finalUrl?: undefined;
    meta?: undefined;
    items?: undefined;
    etag?: undefined;
    lastModified?: undefined;
} | {
    status: string;
    error: string;
    html: string;
    finalUrl: string;
    meta?: undefined;
    items?: undefined;
    etag?: undefined;
    lastModified?: undefined;
} | {
    status: string;
    meta: {
        title: any;
        siteUrl: any;
        desc: any;
    };
    items: any[];
    etag: any;
    lastModified: any;
    error?: undefined;
    html?: undefined;
    finalUrl?: undefined;
}>;
/**
 * 发现管线：返回 {found, candidates:[{url,title,itemCount,summaryOnly}], tried:[{path,result}]}
 * 候选优先级：直连 feed > <link> 声明 > 页面相对路径 > 站点根路径；路径组内有界并发、命中即用
 * （多个候选可用时取最先响应的等价源）。summaryOnly：摘要型源启发式结果，
 * 渲染层据此预开「抓取全文」（全文型/未知保持关，用户可改）。
 */
export function discoverFeed(inputUrl: any): Promise<{
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
/** URL 规整：裸域名补 https:// */
export function normalizeUrl(input: any): string;
/**
 * 解析 feed XML → 归一化条目
 * @param {string} xml
 * @param {string} [feedUrl] 源地址：供 feed 级适配器（site adapters）识别站点用；
 *        缺省时适配器不介入（纯通用链路，测试与旧调用方不受影响）
 * @returns {{meta:{title,siteUrl,desc}, items:Array}}
 */
export function parseFeedXml(xml: string, feedUrl?: string): {
    meta: {
        title: any;
        siteUrl: any;
        desc: any;
    };
    items: any[];
};
/** 文本是否像 RSS/Atom 源（宽松判定：声明或根元素） */
export function looksLikeFeedXml(text: any): boolean;
/** 编码兜底：Content-Type charset → XML 声明 encoding → UTF-8（GBK 等老源靠这层） */
export function decodeBuffer(buf: any, contentType: any): string;
/** 摘要型源启发式（2026-09-12，驱动添加弹窗「抓取全文」智能默认）：抽样近期条目
 *  （feed 一般最新在前，取前 5 条）的正文中位纯文本长度，中位数 < 阈值 → 只带摘要。
 *  协议无关——RSS2.0 的 content:encoded/description 与 Atom 的 content/summary 已在
 *  parseFeedXml 归一到 contentHtml，量的是「源实际带来多少正文」而非猜协议字段。
 *  @returns {boolean|null} true=摘要型 false=全文型 null=无条目可量（空源，勿当全文型断言） */
export function looksSummaryOnly(items: any): boolean | null;
/** 聚合型源启发式（2026-10，AIGC NEWS 实测）：抽样前 5 条的 link，多数指向 **本站以外的域**
 *  → 原文在第三方站点，打开文章抓全文基本抓不到（反爬/登录墙），确认步不该预开「抓取全文」。
 *  判定拿 feed 自身域与 channel.link 域当"本站"，避免 feed 托管在第三方（如 feedburner）时误判。
 *  @returns {boolean} true=聚合型 */
export function looksExternalLinks(items: any, feedUrl: any, siteUrl: any): boolean;
/** 页面相对 feed 候选（/blog/ → /blog/atom.xml；无尾斜杠的 /blog 也视作目录；根路径返回 []） */
export function pathFeedCandidates(pageUrl: any): string[];
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
export declare namespace __test {
    export { ctx };
}
export {};
