/**
 * 订阅 preload 事件，返回取消订阅函数
 * @param {string} event
 * @param {(payload: any) => void} fn
 * @returns {() => void}
 */
export function on(event: string, fn: (payload: any) => void): () => void;
/**
 * @param {string} event
 * @param {(payload: any) => void} fn
 */
export function off(event: string, fn: (payload: any) => void): void;
/**
 * @param {string} event
 * @param {any} [payload]
 */
export function emit(event: string, payload?: any): void;
export function clear(): void;
