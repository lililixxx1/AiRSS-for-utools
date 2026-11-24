import { ref } from "vue";
import { useDataStore } from "../stores/data";
import { useUiStore } from "../stores/ui";

/**
 * 侧栏分类上下文菜单：重命名 / 合并 / 删除分类（成员迁移至「默认」）
 */
export function useCategoryMenu() {
  const data = useDataStore();
  const ui = useUiStore();
  const catMenuOpen = ref<string | null>(null);

  function toggleCatMenu(name: string) {
    catMenuOpen.value = catMenuOpen.value === name ? null : name;
  }

  function closeCatMenu() {
    catMenuOpen.value = null;
  }

  function renameCategory(name: string) {
    catMenuOpen.value = null;
    ui.modal = {
      type: "prompt",
      title: "重命名分类",
      label: `将「${name}」重命名为：`,
      initial: name,
      onOk: (v) => {
        if (!v || v === name) return;
        if (data.categories.some((c) => c.name === v)) {
          ui.toast(`已存在「${v}」分类，如需合并请用「合并到…」`, "error");
          return;
        }
        void data.reassignCategory(name, v);
      },
    };
  }

  function mergeCategory(name: string) {
    catMenuOpen.value = null;
    const others = data.categories.map((c) => c.name).filter((n) => n !== name);
    if (!others.length) {
      ui.toast("没有其他分类可合并");
      return;
    }
    ui.modal = {
      type: "prompt",
      title: "合并分类",
      label: `将「${name}」的全部订阅合并到：`,
      suggestions: others,
      onOk: (v) => {
        if (v && v !== name) void data.reassignCategory(name, v);
      },
    };
  }

  function askDeleteCategory(name: string) {
    catMenuOpen.value = null;
    const count = data.regularFeeds.filter((f) => (f.category || "默认") === name).length;
    ui.modal = {
      type: "confirm",
      title: "删除分类？",
      body: `「${name}」的 ${count} 个订阅将移入「默认」分类，订阅与文章不受影响。`,
      onOk: () => data.reassignCategory(name, "默认"),
    };
  }

  return {
    catMenuOpen,
    toggleCatMenu,
    closeCatMenu,
    renameCategory,
    mergeCategory,
    askDeleteCategory,
  };
}
