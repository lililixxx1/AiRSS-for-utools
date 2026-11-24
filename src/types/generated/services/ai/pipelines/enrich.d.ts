/**
 * 单篇流式 AI 摘要与标题标签增强
 * @param {string} itemId
 * @param {{ bypass?: boolean, reasoningEffort?: string, onDelta?: (text: string) => void }} [opts]
 */
export function enrich(itemId: string, opts?: {
    bypass?: boolean;
    reasoningEffort?: string;
    onDelta?: (text: string) => void;
}): Promise<{
    ok: boolean;
    ai: any;
    cached: boolean;
    error: any;
    item?: undefined;
    aborted?: undefined;
} | {
    ok: boolean;
    ai: any;
    cached: boolean;
    error: any;
    item: any;
    aborted?: undefined;
} | {
    ok: boolean;
    aborted: boolean;
    ai: any;
    cached: boolean;
    error: string;
    item?: undefined;
} | {
    ok: boolean;
    ai: any;
    cached: boolean;
    error: any;
    item?: undefined;
    aborted?: undefined;
}>;
export const TRUNC_CHARS: 2000;
