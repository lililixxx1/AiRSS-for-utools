/** 数据模型（与 preload/services/db.js 的文档形态一一对应） */

export interface Feed {
  _id: string;
  _rev?: string;
  url: string;
  title: string;
  titleEn?: string;
  category: string;
  siteUrl: string;
  desc: string;
  etag: string;
  lastModified: string;
  lastFetchedAt: number | null;
  refreshMin: number; // 0 = 跟随全局
  unreadCount: number;
  lastError: string;
  notify: boolean;
  createdAt: number;
  titleLocked?: boolean; // 用户手动改过名，抓取不再覆盖
  fullText?: boolean; // 摘要型源打开文章时自动抓取原文（PLAN-V1.3 A；undefined 按关）
  order?: number; // 手动排序（D2；首次拖拽时批量赋值，此后新增源无 order 排末尾）
}

export interface ArticleAi {
  summary: string;
  tags: string[];
  titleZh: string;
  titleNorm: string; // AI 优化标题：冗长/含糊/标题党→清晰客观中文改写；原标题已清晰则空（v1.2 由"噱头客观化"放宽）
  aiSource: "batch" | "enrich";
}

/** AI 段落翻译产物（v1.2）：纯文本，渲染层按 idx+head 对位插到正文段后（无 HTML） */
export interface ArticleAiTrans {
  paras: { idx: number; head: string; text: string }[];
  at: number;
  model: string;
}

/** AI 目录产物（v1.4，PLAN-AI-TOC）：纯数据，无 HTML；sections 与全文段落按 idx+head 对位（同 aiTrans 口径）。
 *  head 由 preload 从输入段落补全（AI 不回写）；正文 contentHash 变化 / itemfullx 全文替换连带失效（T-09 同族） */
export interface ArticleAiToc {
  sections: { title: string; idx: number; head: string }[]; // title ≤24 字
  at: number;
  model: string;
}

export interface Item {
  _id: string;
  _rev?: string;
  feedKey: string;
  guid: string;
  link: string;
  title: string;
  titleDisplay: string; // 展示标题：AI 改写（titleNorm>titleZh）优先，无则等于 title
  author: string;
  pubTs: number;
  fetchedAt: number;
  contentHash: string;
  summaryText: string;
  cover: string | null;
  read: boolean;
  starred: boolean;
  aiStatus: "none" | "done" | "error" | string;
  ai?: ArticleAi; // 二期 AI 产物（schemaVersion 3；旧数据缺失按 undefined 读）
  aiTrans?: ArticleAiTrans; // AI 段落翻译（v1.2；正文 contentHash 变化即随 ai 一并失效）
  aiToc?: ArticleAiToc; // AI 目录（v1.4；失效联动同 aiTrans，前端提取目录不落库）
}

export type ThemeMode = "auto" | "light" | "dark";
export type PaletteId = "warm" | "sepia" | "sage" | "indigo"; // 配色与明暗正交（PLAN-THEMES）
export type ViewMode = "card" | "list";
export type OrderBy = "newest" | "oldest" | "unread";

export interface Settings {
  theme: ThemeMode;
  palette: PaletteId; // 配色（默认 warm=暖米白现状；tokens.css data-palette 块）
  fontLevel: 0 | 1 | 2 | 3;
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  serif: boolean;
  refreshMin: number; // 全局默认刷新间隔（分钟）
  keepPerFeed: number; // 每源保留篇数
  notifyEnabled: boolean;
  orderBy: OrderBy;
  aiEnabled: boolean; // AI 增强总开关（默认关，设置页显式开启；引擎配置在 preload airss.ai.getConfig）
  aiTitle: boolean; // 显示 AI 优化标题（titleNorm>titleZh；关则一律原题）
  aiAutoCount: 0 | 1 | 3 | 5; // 自动摘要范围（v1.2）：0=关闭自动(逐篇手动AI按钮) 1=仅当前 3/5=向下连续预取
  muteWords: string[]; // 静音词（PLAN-V1.3 B；多词 OR 任一命中即从列表剔除，计数不剔除）
  highlightWords: string[]; // 高亮词（B；与搜索词合并进 hlTerms，3 词上限由 highlightSegments 决定）
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  palette: "warm",
  fontLevel: 1,
  viewMode: "card",
  sidebarCollapsed: false,
  serif: false,
  refreshMin: 30,
  keepPerFeed: 200,
  notifyEnabled: true,
  orderBy: "newest",
  aiEnabled: false,
  aiTitle: true,
  aiAutoCount: 0,
  muteWords: [],
  highlightWords: [],
};

/** 发现管线的候选源 */
export interface FeedCandidate {
  url: string;
  title: string;
  itemCount: number;
}

export interface TriedPath {
  path: string;
  result: string;
}
