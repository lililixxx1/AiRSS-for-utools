# ADR-002：Preload 领域下沉与单点生命周期协调

- **状态**：已采纳（v2.1）

## 背景
v1.x 将刷新协调、保留清理判断、系统通知与 5 个 uTools 生命周期监听分散写在 `src/stores/data.ts` 与 `src/App.vue`，导致：
1. 宿主后台定时触发（`onScheduleTrigger`）与无窗入口（`save_later`）没有稳定的无 UI 执行路径；
2. 渲染层任意状态变更触发 `data.loadAll()` 全量 IPC 往返；
3. `src/env.d.ts` 手写接口与 `preload/index.js` 多次发生漂移。

## 决策
- 在 `preload/core/` 新增 `readService`、`refreshService`、`laterService` 与 `events` 轻量总线；刷新调度、按源汇总单条通知、保留清理及 AI 后台批门控均由 `refreshService` 统一执行，前后台路径同源复用。
- 在 `preload/lifecycle.js` 唯一注册全部 7 项 uTools 生命周期回调；冷启动阶段动作先入队列，渲染层挂载后通过 `lifecycle.consumePendingActions()` 回放并通过 `window.airss.on(...)` 接收增量事件与局部 `state` 补丁。
- 配置 `tsconfig.preload.json` 与 `npm run gen:types`，从 `preload/index.js` 及其 JSDoc 单向派生 `src/types/generated/` 给 `src/env.d.ts` 引用。

## 后果
- 渲染层彻底脱离宿主底层事件与磁盘 IO，视图层专注展现与交互。
- Preload 与渲染层契约由 TypeScript 编译期强制检验，消除手工接口漂移。
