import { defineStore } from "pinia";

export type ViewName = "main" | "reader" | "settings";
export type ModalState =
  | null
  | { type: "addFeed"; presetUrl?: string }
  | { type: "confirm"; title: string; body: string; danger?: boolean; onOk: () => void }
  /** 通用输入弹窗（PLAN-V1.3 D1：分类重命名/合并）；有 suggestions 用 ComboboxInput（C17） */
  | { type: "prompt"; title: string; label?: string; initial?: string; suggestions?: string[]; onOk: (v: string) => void };

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

let toastSeq = 1;

export const useUiStore = defineStore("ui", {
  state: () => ({
    view: "main" as ViewName,
    readerItemId: null as string | null,
    modal: null as ModalState,
    toasts: [] as Toast[],
    detached: false, // onPluginDetach 分离窗
    cursor: 0, // j/k 键盘当前位（filtered 索引）
    dropdown: null as string | null, // 打开中的下拉 id（Esc 逐级返回用）
  }),

  actions: {
    openReader(itemId: string) {
      this.readerItemId = itemId;
      this.view = "reader";
    },
    closeReader() {
      this.view = "main";
      this.readerItemId = null;
    },
    openSettings() {
      this.view = "settings";
    },
    toast(text: string, kind: "info" | "error" = "info") {
      const t = { id: toastSeq++, text, kind };
      this.toasts.push(t);
      setTimeout(() => {
        this.toasts = this.toasts.filter((x) => x.id !== t.id);
      }, 2600);
    },
  },
});
