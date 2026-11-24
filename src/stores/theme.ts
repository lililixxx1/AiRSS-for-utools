import { defineStore } from "pinia";
import { useSettingsStore } from "./settings";

let media: MediaQueryList | null = null;

/** 主题三态：auto 跟随 matchMedia 实时切换；isDarkColors() 仅初始兜底（design-system §10） */
export const useThemeStore = defineStore("theme", {
  state: () => ({
    dark: false,
  }),

  actions: {
    init() {
      const settings = useSettingsStore();
      this.apply();
      if (!media) {
        media = window.matchMedia("(prefers-color-scheme: dark)");
        media.addEventListener("change", () => {
          if (settings.theme === "auto") this.apply();
        });
      }
    },
    apply() {
      const settings = useSettingsStore();
      let dark: boolean;
      if (settings.theme === "dark") dark = true;
      else if (settings.theme === "light") dark = false;
      else {
        dark = media ? media.matches : utools.isDarkColors();
      }
      this.dark = dark;
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      document.documentElement.setAttribute("data-palette", settings.palette);
    },
  },
});

/**
 * 文章阅读进度（v2：写入 preload state:{itemKey}.readPos，不再整表写 dbStorage）
 */
const posCache = new Map<string, number>();

export function saveReadPosition(itemId: string, ratio: number) {
  const clamped = Math.max(0, Math.min(1, Math.round((Number(ratio) || 0) * 1000) / 1000));
  posCache.set(itemId, clamped);
  void window.airss.db.setReadPos(itemId, clamped);
}

export async function getReadPosition(itemId: string): Promise<number> {
  if (posCache.has(itemId)) return posCache.get(itemId)!;
  const r = await window.airss.db.getReadPos(itemId).catch(() => 0);
  if (typeof r === "number" && r > 0) posCache.set(itemId, r);
  return r || 0;
}

export function setReadPositionCache(itemId: string, ratio: number) {
  if (typeof ratio === "number" && ratio >= 0) posCache.set(itemId, ratio);
}
