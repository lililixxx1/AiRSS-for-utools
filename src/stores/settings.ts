import { defineStore } from "pinia";
import { DEFAULT_SETTINGS, type Settings } from "../types";

const KEY = "airss:settings";

function loadPersisted(): Settings {
  try {
    const raw = utools.dbStorage.getItem(KEY);
    return { ...DEFAULT_SETTINGS, ...(raw || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const useSettingsStore = defineStore("settings", {
  state: (): Settings => ({ ...DEFAULT_SETTINGS }),

  getters: {
    readingFs: (s): string => ["14px", "16px", "18px", "22px"][s.fontLevel] || "16px",
  },

  actions: {
    load() {
      this.$patch(loadPersisted());
      const fl = Math.round(Number(this.fontLevel));
      this.fontLevel = (Number.isFinite(fl) ? Math.min(3, Math.max(0, fl)) : 1) as Settings["fontLevel"];
    },
    /** 单项修改并持久化（按 DEFAULT_SETTINGS 键集序列化，防 Proxy 克隆报错） */
    set<K extends keyof Settings>(key: K, value: Settings[K]) {
      if (key === "fontLevel") {
        const n = Math.round(Number(value));
        value = (Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 1) as Settings["fontLevel"] as Settings[K];
      }
      (this as any)[key] = value;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const v = (this as any)[k];
        out[k] = Array.isArray(v) ? [...v] : v;
      }
      utools.dbStorage.setItem(KEY, out);
    },
  },
});
