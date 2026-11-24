import { ref, type Ref } from "vue";
import { useDataStore } from "../stores/data";

/**
 * 订阅源侧栏拖拽排序状态与操作（仅作用于 regularFeeds）
 */
export function useFeedDrag(collapsed: Ref<boolean>) {
  const data = useDataStore();
  const dragFrom = ref(-1);
  const dragOver = ref(-1);

  function onDragStart(i: number) {
    if (collapsed.value) return;
    dragFrom.value = i;
  }

  function onDragEnter(i: number) {
    if (dragFrom.value >= 0 && dragFrom.value !== i) dragOver.value = i;
  }

  async function onDrop(i: number) {
    const from = dragFrom.value;
    dragFrom.value = -1;
    dragOver.value = -1;
    if (from < 0 || from === i) return;
    await data.initOrderOnce();
    await data.moveFeed(from, i);
  }

  function onDragEnd() {
    dragFrom.value = -1;
    dragOver.value = -1;
  }

  return {
    dragFrom,
    dragOver,
    onDragStart,
    onDragEnter,
    onDrop,
    onDragEnd,
  };
}
