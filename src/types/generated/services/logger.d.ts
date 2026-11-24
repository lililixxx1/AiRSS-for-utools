/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
export function debug(tag: string, msg: string, data?: unknown): void;
/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
export function info(tag: string, msg: string, data?: unknown): void;
/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
export function warn(tag: string, msg: string, data?: unknown): void;
/**
 * @param {string} tag
 * @param {string} msg
 * @param {unknown} [data]
 */
export function error(tag: string, msg: string, data?: unknown): void;
/** @returns {Array<{ t: number, level: string, tag: string, msg: string, data?: string }>} */
export function getLogs(): Array<{
    t: number;
    level: string;
    tag: string;
    msg: string;
    data?: string;
}>;
export function clear(): void;
/** @returns {string} */
export function dumpText(): string;
export function flush(): void;
/** v1→v2 迁移时写入历史诊断记录 */
export function migrateLegacyLogs(entries: any): void;
export function resetForTest(): void;
