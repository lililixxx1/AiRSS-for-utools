export function batchEnrich(itemDocs: any): Promise<{
    ok: boolean;
    updated: any[];
    error: any;
}>;
export const BATCH_MAX: 20;
