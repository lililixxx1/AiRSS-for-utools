export type AiConfig = {
    enabled: boolean;
    engine: "utools" | "byok";
    model: string;
    modelLabel: string;
    reasoningEffort: "none" | "low" | "medium";
    byokBaseUrl: string;
    byokModel: string;
    byokAllowHttp: boolean;
};
export const CFG_KEY: "airss:ai-config";
export const BYOK_KEY_NAME: "airss:byok-key";
export namespace DEFAULT_CONFIG {
    let enabled: boolean;
    let engine: string;
    let model: string;
    let modelLabel: string;
    let reasoningEffort: string;
    let byokBaseUrl: string;
    let byokModel: string;
    let byokAllowHttp: boolean;
}
/**
 * @typedef {{
 *   enabled: boolean,
 *   engine: "utools" | "byok",
 *   model: string,
 *   modelLabel: string,
 *   reasoningEffort: "none" | "low" | "medium",
 *   byokBaseUrl: string,
 *   byokModel: string,
 *   byokAllowHttp: boolean,
 * }} AiConfig
 */
/** @returns {AiConfig} */
export function getConfig(): AiConfig;
/**
 * @param {Partial<AiConfig>} [patch]
 * @returns {AiConfig}
 */
export function saveConfig(patch?: Partial<AiConfig>): AiConfig;
export function getByokKey(): any;
export function setByokKey(key: any): {
    ok: boolean;
    storage: string;
    error?: undefined;
} | {
    ok: boolean;
    error: string;
    storage: string;
};
export function hasByokKey(): boolean;
export function getByokStorageMode(): "crypto" | "local-fallback";
export function modelLabelFor(cfg: any): any;
