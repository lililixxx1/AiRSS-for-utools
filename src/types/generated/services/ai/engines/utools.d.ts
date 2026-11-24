export function callUtools(messages: any, { cfg, stream, onDelta, claim, reasoningEffort, timeoutMs, claimGate, setAbort, clearAbort }: {
    cfg: any;
    stream: any;
    onDelta: any;
    claim: any;
    reasoningEffort: any;
    timeoutMs: any;
    claimGate: any;
    setAbort: any;
    clearAbort: any;
}): Promise<{
    ok: boolean;
    error: string;
    aborted?: undefined;
    content?: undefined;
} | {
    ok: boolean;
    aborted: boolean;
    error: string;
    content?: undefined;
} | {
    ok: boolean;
    content: string;
    error?: undefined;
    aborted?: undefined;
}>;
