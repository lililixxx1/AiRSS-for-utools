import { defineStore } from "pinia";
import { DEFAULT_SETTINGS, type Settings } from "../types";

const KEY = "airss:settings";
const SCHEMA_KEY = "schemaVersion";
const SCHEMA_VERSION = 3; // v3 = 二期 AI 字段（item.ai 等，旧文档缺失按 undefined 兼容读）

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
      if (utools.dbStorage.getItem(SCHEMA_KEY) !== SCHEMA_VERSION) {
        // v2→v3：新增字段全部可选，旧文档不改写、缺失按 undefined 读取（PLAN §4 迁移纪律）
        utools.dbStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION);
      }
    },
    /** 单项修改并持久化（按 DEFAULT_SETTINGS 键集序列化，防杂物入库） */
    set<K extends keyof Settings>(key: K, value: Settings[K]) {
      (this as any)[key] = value;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const v = (this as any)[k];
        // Pinia state 取出的数组是 reactive Proxy，utools IPC 结构化克隆不支持
        // （2026-09-07 实机：dbStorage.setItem 抛 "An object could not be cloned"，
        //  宿主内所有设置写入失败，且抛错吞掉调用方后续语句——如 AI 开关的 preload 双写）
        out[k] = Array.isArray(v) ? [...v] : v;
      }
      utools.dbStorage.setItem(KEY, out);
    },
  },
});
