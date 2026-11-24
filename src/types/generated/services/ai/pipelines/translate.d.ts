/**
 * AI 段落翻译（手动池）
 * @param {string} itemId
 * @param {Array<{ idx: number, head: string, text: string }>} paras
 * @param {{ bypass?: boolean, reasoningEffort?: string, onDelta?: (text: string) => void }} [opts]
 */
export function translateItem(itemId: string, paras: Array<{
    idx: number;
    head: string;
    text: string;
}>, opts?: {
    bypass?: boolean;
    reasoningEffort?: string;
    onDelta?: (text: string) => void;
}): Promise<{
    ok: boolean;
    aiTrans: any;
    cached: boolean;
    error: any;
    aborted?: undefined;
} | {
    ok: boolean;
    aborted: boolean;
    aiTrans: any;
    cached: boolean;
    error: string;
} | {
    ok: boolean;
    aiTrans: any;
    cached: boolean;
    error: any;
    aborted?: undefined;
}>;
export const TRANS_MAX_PARAS: 10;
export const TRANS_MAX_CHARS: 4000;
