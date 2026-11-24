export function nextClaim(): number;
export function abort(): void;
/**
 * 统一 AI 引擎调用（带单飞门控）
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ cfg: any, stream?: boolean, onDelta?: (text: string) => void, claim?: number, reasoningEffort?: string }} opts
 */
export function callEngine(messages: Array<{
    role: string;
    content: string;
}>, { cfg, stream, onDelta, claim, reasoningEffort }: {
    cfg: any;
    stream?: boolean;
    onDelta?: (text: string) => void;
    claim?: number;
    reasoningEffort?: string;
}): Promise<{
    ok: boolean;
    aborted: boolean;
    error: string;
    content?: undefined;
} | {
    ok: boolean;
    content: string;
    error?: undefined;
    aborted?: undefined;
} | {
    ok: boolean;
    error: any;
    aborted?: undefined;
    content?: undefined;
}>;
export function setEngineTimeout(ms: any): void;
