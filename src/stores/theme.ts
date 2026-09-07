import { defineStore } from "pinia";
import { useUiStore } from "./ui";
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
        // auto：matchMedia 优先，宿主 isDarkColors 兜底
        dark = media ? media.matches : utools.isDarkColors();
      }
      this.dark = dark;
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      // 配色与明暗正交（PLAN-THEMES）：warm 不命中任何配色块，回落 data-theme 缺省令牌
      document.documentElement.setAttribute("data-palette", settings.palette);
    },
  },
});

/** 文章阅读进度（LRU，仅内存上限控制；键=条目 id）
 *  整表内存缓存：保存路径高频（阅读中每次重渲染都可能触发节流保存），
 *  每次都 getItem 全量反序列化是纯浪费；该键只有本模块一个写入方，缓存安全 */
const POS_KEY = "airss:readPositions";
const POS_MAX = 5000;
let posCache: Record<string, number> | null = null;

export function saveReadPosition(itemId: string, ratio: number) {
  const all = loadReadPositions();
  all[itemId] = ratio;
  const keys = Object.keys(all);
  if (keys.length > POS_MAX) {
    for (const k of keys.slice(0, keys.length - POS_MAX)) delete all[k];
  }
  utools.dbStorage.setItem(POS_KEY, all);
}

export function loadReadPositions(): Record<string, number> {
  if (!posCache) {
    const raw = utools.dbStorage.getItem(POS_KEY) as Record<string, number> | null | undefined;
    posCache = raw || {};
  }
  return posCache;
}
