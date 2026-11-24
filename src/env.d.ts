/// <reference types="vite/client" />

/** 版本号（vite define 从 package.json 注入，关于区展示用） */
declare const __APP_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** uTools 宿主 API（只在 uTools 内存在；浏览器 dev 由 mock 层兜底） */
interface UtoolsApi {
  onPluginReady(cb: () => void): void;
  onPluginEnter(cb: (action: { code: string; type: string; payload: any; from?: string; option?: { text?: string } }) => void): void;
  onPluginOut(cb: (isKill: boolean) => void): void;
  onMainPush(cb: (action: any) => any[], onSelect?: (action: any) => boolean | undefined): void;
  onPluginDetach(cb: () => void): void;
  onDbPull(cb: (docs: any[]) => void): void;
  onScheduleTrigger(cb: (payload: { code: string; triggeredAt?: number }) => any): void;
  requestSchedule(opts: { code: string; label: string; trigger: { cron: string } }): Promise<any>;
  getSchedules(): Array<{ code: string; label?: string; trigger?: { cron: string }; lastExecuteAt?: number; successCount?: number; failureCount?: number; lastStatus?: string; lastError?: string }>;
  removeSchedule(code: string): void;
  getFeatures(codes?: string[]): any[];
  setFeature(feature: any): void;
  removeFeature(code: string): void;
  getPluginLocalDataPath(): string;
  getPluginTempPath(): string;
  hideMainWindow(): boolean;
  setSubInput(onChange: (details: { text: string }) => void, placeholder?: string, isFocus?: boolean): boolean;
  setSubInputValue(text: string): boolean;
  removeSubInput(): boolean;
  subInputFocus(): boolean;
  subInputBlur(): void;
  subInputSelect(): boolean;
  showNotification(body: string, clickFeatureCode?: string): void;
  shellOpenExternal(url: string): void;
  showOpenDialog(options: any): string[] | undefined;
  showSaveDialog(options: any): string | undefined;
  isDarkColors(): boolean;
  getAppVersion(): string;
  redirect(label: string, payload?: any): void;
  outPlugin(isKill?: boolean): void;
  db: any;
  dbStorage: {
    getItem(key: string): any;
    setItem(key: string, value: any): void;
    removeItem(key: string): void;
  };
  dbCryptoStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  [k: string]: any;
}

declare const utools: UtoolsApi;

interface Window {
  utools: UtoolsApi;
  airss: AirssServices;
}

/** preload 暴露的服务面（由 npm run gen:types 从 preload/*.js 自动生成，勿手写双份） */
type AirssServices = typeof import("./types/generated/index");
