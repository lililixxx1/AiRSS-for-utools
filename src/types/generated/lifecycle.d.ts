export const GLOBAL_SEARCH_CODE: "airss_search";
export function register(): void;
export function onReady(): Promise<void>;
export function onEnter(action?: {}): Promise<{
    ok: boolean;
    item: any;
    error: any;
} | {
    handled: string;
    opened?: undefined;
} | {
    handled: any;
    opened: any;
}>;
export function onOut(isKill: any): void;
export function handleMainPush(action: any): {
    icon: string;
    text: any;
    title: string;
}[];
export function handleMainPushSelect(action: any): boolean;
export function consumePendingActions(): {
    actions: {
        type: string;
        payload: any;
    }[];
    detached: boolean;
};
export function isGlobalSearchEnabled(): boolean;
export function setGlobalSearchEnabled(enabled: any): boolean;
export function resetForTest(): void;
