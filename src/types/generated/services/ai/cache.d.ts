export const CACHE_MAX: 5000;
export function cacheGet(id: any): Promise<{
    result: any;
    model: string;
    createdAt: number;
    _id: any;
}>;
export function cachePut(id: any, result: any, model: any): Promise<void>;
export function cacheTrim(): Promise<void>;
export function flush(): void;
export function resetForTest(): void;
