export const LATER_FEED_ID: "feed:__later__";
export function saveUrl(rawUrl: any): Promise<{
    ok: boolean;
    item: any;
    error: string;
} | {
    ok: boolean;
    item: any;
    error: any;
}>;
declare namespace ctx {
    function nodeFetch(url: any, opts: any): Promise<{
        ok: boolean;
        url: string;
        status: number;
        headers: object;
        body: any | null;
        truncated: boolean;
        error: string | null;
    }>;
}
export declare namespace __test {
    export { ctx };
}
export {};
