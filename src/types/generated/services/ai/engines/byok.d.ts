export function byokEndpoint(base: any): string;
export function callByok(messages: any, { cfg, stream, onDelta, claim, claimGate, setAbort, clearAbort }: {
    cfg: any;
    stream: any;
    onDelta: any;
    claim: any;
    claimGate: any;
    setAbort: any;
    clearAbort: any;
}): Promise<{
    ok: boolean;
    aborted: boolean;
    error: string;
    content?: undefined;
} | {
    ok: boolean;
    content: string;
    aborted?: undefined;
    error?: undefined;
} | {
    ok: boolean;
    error: any;
    aborted?: undefined;
    content?: undefined;
}>;
