/**
 * feed 级清理入口。
 * @param {string} feedUrl 该条目所属 feed 的地址
 * @param {{rawBody?:string, link?:string}} item
 * @returns {string|null} 清理后的正文原形态；**空串是有效结果**（整条被剥空）；null = 无适配/无需改动
 */
export function applyFeedAdapter(feedUrl: string, item: {
    rawBody?: string;
    link?: string;
}): string | null;
/**
 * 文章级适配入口。
 * @param {string} url 文章地址
 * @param {object} document linkedom 解析后的 document（调用方已 parse，避免二次 parse）
 * @returns {{content:string, cover?:string, adapter:string}|null} null = 无适配/适配失败 → 回落 Readability
 */
export function extractArticle(url: string, document: object): {
    content: string;
    cover?: string;
    adapter: string;
} | null;
/** 通用宿主/路径解析（解析失败返回空串，调用方按不匹配处理） */
export function hostOf(url: any): string;
/** HTML 文本转义（& < > " '）——适配器拼接字符串的唯一安全出口 */
export function esc(s: any): string;
/** 只放行 http(s) 绝对地址；其余（javascript:/data:/相对）返回空串由调用方跳过 */
export function httpUrl(u: any): string;
declare const FEED_ADAPTERS: {
    id: string;
    test: (feedUrl: any) => any;
    clean: typeof cleanAigcNews;
}[];
declare const ARTICLE_ADAPTERS: {
    id: string;
    test: (url: any) => boolean;
    extract: typeof extractHellogithub;
}[];
/**
 * HelloGitHub 月刊页：从 `#__NEXT_DATA__` 的 volume.data 重建「分类 → 项目清单」。
 * 结构化字段（2026-10 实测）：category_name / items[{name,full_name,description,github_url,stars,forks,image_url}]
 * 产出：每个分类一个 h2，每个项目 h3（链接到仓库）+ 描述 + 仓库名/星标行。
 * cover：取第一个项目的配图（列表卡片用），正文不内联配图（35 张动图会把阅读页拖死）。
 */
declare function extractHellogithub({ document }: {
    document: any;
}): {
    content: string;
    cover: string;
    adapter: string;
};
/** Indie Radar 条目页：article 内「摘录 → AI 导读 → 推荐理由 → 来源 → 标签」重组 */
declare function extractIndieRadar({ document }: {
    document: any;
}): {
    content: string;
    cover: string;
    adapter: string;
};
/**
 * AIGC NEWS（aigcnews.cn）：description 尾部固定引流行
 * 「📮 全文 RSS（中文译文 · 完整归档），注册登录即可免费订阅：https://…/subscriptions」
 * 这是每篇都带的广告位，阅读器里纯噪音——按行剥掉（只剥以 📮 开头且含订阅链接的行，
 * 正文里偶然提到「RSS」不受影响）。
 */
declare const AIGC_PROMO_RE: RegExp;
/**
 * @param {{rawBody:string, link:string}} item rawBody 是 feed 里的原始 description/content
 * @returns {string|null|undefined} 清理后的正文（仍是纯文本/HTML 原形态）；"" = 整段都是广告、
 *         正文已被剥空（**必须保留空串**，不能返回 null —— 2026-10-31 宿主实测：该源有若干条目
 *         description 只有引流行，回退成"没改动"会把广告原样当正文）；null = 不介入
 */
declare function cleanAigcNews({ rawBody }: {
    rawBody: string;
    link: string;
}): string | null | undefined;
export declare namespace __test {
    export { FEED_ADAPTERS };
    export { ARTICLE_ADAPTERS };
    export { extractHellogithub };
    export { extractIndieRadar };
    export { AIGC_PROMO_RE };
}
export {};
