export const QUOTA_MANUAL_MAX: 120;
export const QUOTA_BG_MAX: 30;
export function loadQuota(): {
    date: any;
    manual: number;
    bg: number;
};
export function quotaCheck(pool: any, cfg: any): {
    ok: boolean;
    error?: undefined;
} | {
    ok: boolean;
    error: string;
};
export function countCall(pool: any, cfg: any): void;
export function resetQuotaForTest(): void;
