/**
 * 消毒 HTML；超过 100KB 字节则按字符截断后二次消毒（parser 自动闭合残缺标签）
 * @param {string} html
 * @returns {string}
 */
export function sanitizeContent(html: string): string;
export function htmlToText(html: any): any;
/**
 * 生成摘要（≤300 字符）
 * @param {string} htmlOrText
 */
export function makeSummary(htmlOrText: string, max?: number): any;
/**
 * 提取封面：正文中第一张合格的 https 图
 * 门控：URL 像图标/头像的跳过；img 自带 width/height 属性且过小的跳过。
 * 自然尺寸（URL 不暴露）由渲染层 banner 的 @load 复查兜底。
 * @returns {string|null}
 */
export function extractCover(html: any): string | null;
/** 阅读时长估算（中文 ~400 字/分钟，至少 1 分钟） */
export function readingMinutes(text: any): number;
/**
 * 纯文本正文段落化（2026-10，AIGC NEWS 一类聚合源实测）。
 *
 * 现象：很多源的 description 是**纯文本**，段落只用 \n 分隔、没有任何标签。原样塞进
 * sanitize 后整篇是一个文本节点，浏览器把换行折叠成空格——阅读器里就是「一堵墙」，
 * 两三段的中文资讯读起来完全失去结构。这里把纯文本按行重建为 `<p>`。
 *
 * 规则（宁保守勿误伤）：
 *  - 已含标签 → 原样返回（富文本源的 \n 是排版噪声，动了反而破坏）；
 *  - 无换行 → 原样返回（单段纯文本包 <p> 无视觉差异，且会无谓改变 contentHash 造成全量重入库）；
 *  - 空行（\n\n）= 硬分段；非空行之间默认也视为分段（中文源普遍「一段一行」）；
 *  - 例外：拉丁文硬折行接回同一段（上一行 ≥40 字符且无句末标点、下一行以小写/数字/左括号开头）——
 *    否则英文源会被折成一句一段的碎片。
 * @param {string} text
 * @returns {string} 段落化后的 HTML 或原值
 */
export function paragraphizePlainText(text: string): string;
declare namespace SANITIZE_BASE_OPTIONS {
    let allowedTags: string[];
    namespace allowedAttributes {
        let img: string[];
        let a: string[];
    }
    let allowedSchemes: string[];
    namespace allowedSchemesByTag {
        let img_1: string[];
        export { img_1 as img };
        let a_1: string[];
        export { a_1 as a };
    }
    let disallowedTagsMode: string;
    let forbiddenTags: string[];
}
export const MAX_CONTENT_BYTES: number;
export { SANITIZE_BASE_OPTIONS as SANITIZE_OPTIONS };
