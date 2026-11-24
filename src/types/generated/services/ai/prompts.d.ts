/**
 * ai/prompts.js — 提示词构建与 AI 输出解析（纯函数）
 */
export const DEFAULT_CATEGORIES: string[];
export function firstSentence(text: any): string;
export function buildEnrichMessages(item: any, truncText: any, categories: any): {
    role: string;
    content: string;
}[];
export function buildBatchMessages(docs: any, categories: any): {
    role: string;
    content: string;
}[];
export function clampAiTitle(s: any, max?: number): string;
export function parseEnrichOutput(text: any): {
    summary: string;
    titleZh: string;
    titleNorm: string;
    tags: any[];
};
export function pickDisplayTitle(title: any, ai: any): any;
export function cjkRatio(text: any): number;
export function buildTransMessages(paras: any): {
    role: string;
    content: any;
}[];
export function parseTransOutput(text: any): {
    texts: {};
    count: number;
};
export function buildTocMessages(paras: any): {
    role: string;
    content: string;
}[];
export function parseTocOutput(text: any): {
    sections: any[];
    count: number;
};
export function tocAnchorSections(paras: any, sections: any): {
    title: string;
    idx: any;
    head: string;
    level: number;
}[];
