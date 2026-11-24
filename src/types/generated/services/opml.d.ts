/**
 * 解析 OPML → [{ title, xmlUrl, siteUrl, category }]（多级 folder 拼 "a/b" 平铺分类）
 * @param {string} xmlText
 */
export function parseOpml(xmlText: string): any[];
/**
 * feeds → OPML 1.0 文本（按分类分组为两级 outline）
 * @param {Array} feeds feed 文档数组（含 title/url/siteUrl/category）
 */
export function buildOpml(feeds: any[]): string;
