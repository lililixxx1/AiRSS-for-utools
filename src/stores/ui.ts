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
    winNarrow: false, // 窗口宽 < 1080（App.vue resize 监听维护；分离窗三栏最小宽 1080，窄于此侧栏自动降图标轨）
    railSearch: false, // 折叠轨搜索面板开（Sidebar：侧栏折叠时搜索框不在 DOM，Ctrl+F/轨内搜索钮唤出浮层输入）
    sbDrawer: false, // 窄幅侧栏抽屉开（narrowDetached 下展开钮改开 fixed 浮层抽屉，网格与设置都不动；选中/背板/⌫/拖宽即关）
    readerFind: false, // 阅读态文内搜索栏开（PLAN-WHEEL-FIND v1.7：入口=Ctrl+F / AI 轮盘搜索项，轨内搜索钮已回归纯列表搜索；切文/卸载强关，列表搜索管线不动）
    readerFindFocus: 0, // 文内搜索重聚焦令牌（PLAN-WHEEL-FIND §2.5：已开态再触发（轮盘项/Ctrl+F）自增——同值赋 readerFind 不触发 watch，靠本计数驱动重聚焦+全选）
    cursor: 0, // j/k 键盘当前位（filtered 索引）
  }),

  getters: {
    /** 分离窗窄幅（侧栏自动降图标轨的唯一判据；App/Sidebar 共用，勿各自合取产生分叉） */
    narrowDetached: (state) => state.detached && state.winNarrow,
  },
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
