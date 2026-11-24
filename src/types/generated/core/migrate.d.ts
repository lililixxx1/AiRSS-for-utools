export function detectLegacy(): Promise<{
    hasLegacy: boolean;
    items: any;
    fulls: any;
    fullxs: any;
    aiCache: any;
    total: any;
}>;
export function runPhase1IfNeeded(): Promise<{
    ran: boolean;
    migratedItems: any;
}>;
/**
 * 阶段二：确认云端同步已完成拉取后，清理 v1.x 历史同步冗余文档
 */
export function cleanLegacySyncDocs(): Promise<{
    ok: boolean;
    removed: number;
    error: string;
}>;
