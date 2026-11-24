export const SCHEDULE_CODE: "airss-refresh";
export function isRefreshing(): boolean;
export function abort(): void;
/**
 * 刷新到期订阅源（manual=true 刷新全部；trigger="enter"|"manual"|"schedule"）
 * @param {{ manual?: boolean, trigger?: string }} [opts]
 */
export function refreshDue(opts?: {
    manual?: boolean;
    trigger?: string;
}): Promise<any>;
export function refreshOne(feedOrId: any): Promise<{
    ok: boolean;
    status: string;
    newCount: number;
    error: string;
}>;
export function getScheduleStatus(): {
    supported: boolean;
    enabled: boolean;
    schedule: any;
};
export function enableSchedule(cron?: string): Promise<{
    ok: boolean;
    rejected: boolean;
    error: string;
    status: {
        supported: boolean;
        enabled: boolean;
        schedule: any;
    };
}>;
export function disableSchedule(): {
    ok: boolean;
    status: {
        supported: boolean;
        enabled: boolean;
        schedule: any;
    };
};
/** onScheduleTrigger 执行入口（失败向上抛错以记录 failureCount） */
export function runScheduled(): Promise<any>;
