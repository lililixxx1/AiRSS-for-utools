/** 数据模型（与 preload/core/storage.js 对齐） */

export interface Feed {
  _id: string;
  _rev?: string;
  url: string;
  urlKey?: string;
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
  titleLocked?: boolean;
  fullText?: boolean;
  order?: number;
  special?: "later";
}

export interface ArticleAi {
  summary: string;
  tags: string[];
  titleZh: string;
  titleNorm: string;
  aiSource: "batch" | "enrich";
}

export interface ArticleAiTrans {
  paras: { idx: number; head: string; text: string }[];
  at: number;
  model: string;
}

export interface ArticleAiToc {
  sections: { title: string; idx: number; head: string; level?: 1 | 2 | 3 }[];
  at: number;
  model: string;
}

export interface Item {
  _id: string;
  _rev?: string;
  itemKey?: string;
  feedKey: string;
  feedTitle?: string;
  guid: string;
  link: string;
  title: string;
  titleDisplay: string;
  author: string;
  pubTs: number;
  fetchedAt: number;
  contentHash: string;
  summaryText: string;
  cover: string | null;
  read: boolean;
  starred: boolean;
  readPos?: number;
  aiStatus: "none" | "done" | "error" | string;
  ai?: ArticleAi;
  aiTrans?: ArticleAiTrans;
  aiToc?: ArticleAiToc;
  hasAiTrans?: boolean;
  hasAiToc?: boolean;
  fromStarSnap?: boolean;
  fromLaterSnap?: boolean;
  isLater?: boolean;
}

export type ThemeMode = "auto" | "light" | "dark";
export type PaletteId = "warm" | "sepia" | "sage" | "indigo";
export type ViewMode = "card" | "list";
export type OrderBy = "newest" | "oldest" | "unread";
export type ReasoningEffort = "none" | "low" | "medium";

export interface Settings {
  theme: ThemeMode;
  palette: PaletteId;
  fontLevel: 0 | 1 | 2 | 3;
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  serif: boolean;
  refreshMin: number;
  keepPerFeed: number;
  notifyEnabled: boolean;
  orderBy: OrderBy;
  aiEnabled: boolean;
  aiTitle: boolean;
  aiAutoCount: 0 | 1 | 3 | 5;
  scheduleAiBatch: boolean;
  muteWords: string[];
  highlightWords: string[];
  recommendEnabled: boolean;
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
  scheduleAiBatch: false,
  muteWords: [],
  highlightWords: [],
  recommendEnabled: true,
};

export interface FeedCandidate {
  url: string;
  title: string;
  itemCount: number;
  summaryOnly?: boolean | null;
  externalLinks?: boolean;
}

export interface TriedPath {
  path: string;
  result: string;
}

export interface ScheduleStatus {
  supported: boolean;
  enabled: boolean;
  schedule: {
    code: string;
    label: string;
    trigger: number | { cron: string };
    successCount: number;
    failureCount: number;
    lastExecuteAt?: number;
    lastStatus?: "success" | "failure";
  } | null;
}

export interface LocalStorageStats {
  diskBytes: number;
  diskMb: number;
  files: number;
  indexedDocs: number;
  itemCount: number;
}

export interface LegacyDetectResult {
  hasLegacy: boolean;
  items: number;
  fulls: number;
  fullxs: number;
  aiCache: number;
  total: number;
}
