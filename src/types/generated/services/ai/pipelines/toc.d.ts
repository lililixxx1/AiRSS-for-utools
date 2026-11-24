/**
 * AI 目录生成（手动池）
 * @param {string} itemId
 * @param {Array<{ idx: number, head: string, text: string, tag?: string }>} paras
 * @param {{ bypass?: boolean, reasoningEffort?: string }} [opts]
 */
export function generateToc(itemId: string, paras: Array<{
    idx: number;
    head: string;
    text: string;
    tag?: string;
}>, opts?: {
    bypass?: boolean;
    reasoningEffort?: string;
}): Promise<{
    ok: boolean;
    aiToc: any;
    cached: boolean;
    error: any;
    aborted?: undefined;
} | {
    ok: boolean;
    aborted: boolean;
    aiToc: any;
    cached: boolean;
    error: string;
} | {
    ok: boolean;
    aiToc: any;
    cached: boolean;
    error: any;
    aborted?: undefined;
}>;
export const TOC_MAX_PARAS: 200;
export const TOC_PARA_CHARS: 200;
export const TOC_MAX_CHARS: 10000;
