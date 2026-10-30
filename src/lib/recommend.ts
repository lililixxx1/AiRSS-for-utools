/**
 * recommend.ts — 推荐订阅源清单（静态数据，空态芯片与「推荐订阅」页共用单一来源）
 *
 * 纪律：清单里每个 URL 都必须**实测通过**（发现 → 直判 feed → 能解析出条目）才准入。
 * 失效链接比没有推荐更伤——用户点进去只会看到「未在该地址发现 Feed」。
 * 2026-10-30 逐条联网体检的结论（括号内为当时实测）：12 个全部通过；同期淘汰 V2EX / 36氪 /
 * Hacker News / 虎嗅 / 产品沉思录（超时或被反爬挡，发现管线要等 48s 才落失败态）。
 */

export interface RecommendSource {
  /** 展示名（用户添加后仍可在确认步改名） */
  title: string;
  /** 订阅地址（站点首页亦可：发现管线会自动探测 feed） */
  url: string;
  /** 一句话介绍，回答「这个源值不值得订」 */
  desc: string;
}

export interface RecommendGroup {
  name: string;
  items: RecommendSource[];
}

export const RECOMMEND_GROUPS: RecommendGroup[] = [
  {
    name: "精品聚合",
    items: [
      { title: "橘鸦AI早报", url: "https://daily.juya.uk/rss.xml", desc: "每天一份 AI 圈要闻早餐，5 分钟看完当天重点。" },
      { title: "Indie Radar", url: "https://radar.everythingisok.top/", desc: "出海与独立开发情报站，每日精选新工具、开源项目与变现案例。" },
      { title: "AIGC NEWS", url: "https://aigcnews.cn/", desc: "AI 资讯聚合：论文、GitHub、Product Hunt、HN 与科技媒体的中文简报。" },
      { title: "HelloGitHub 月刊", url: "https://hellogithub.com/rss", desc: "每月一期，精选有趣、入门级的开源项目，附仓库链接与星标。" },
    ],
  },
  {
    name: "技术社区",
    items: [
      { title: "阮一峰的网络日志", url: "https://www.ruanyifeng.com/blog/atom.xml", desc: "科技爱好者周刊与技术随笔，中文开发者长期口碑源。" },
      { title: "InfoQ 中文", url: "https://www.infoq.cn/feed", desc: "面向架构师与开发者的技术资讯、案例与深度分析。" },
      { title: "掘金", url: "https://juejin.cn/rss", desc: "中文前端 / 后端 / AI 工程实践与踩坑经验。" },
      { title: "GitHub Blog", url: "https://github.blog/feed/", desc: "GitHub 官方产品动态、开源生态与工程实践。" },
    ],
  },
  {
    name: "数码与产品",
    items: [
      { title: "少数派", url: "https://sspai.com/feed", desc: "高效工作与数字生活指南，工具与方法论见长。" },
      { title: "爱范儿", url: "https://www.ifanr.com/feed", desc: "科技数码与消费电子报道，偏产品与行业观察。" },
      { title: "小众软件", url: "https://www.appinn.com/feed/", desc: "每天推荐一款小众但好用的软件，含桌面与移动端。" },
      { title: "奇客 Solidot", url: "https://www.solidot.org/index.rss", desc: "中文科技新闻聚合，短平快，覆盖开源、极客与安全。" },
    ],
  },
];

/** 扁平清单（空态芯片、计数等处用） */
export const RECOMMEND_ALL: RecommendSource[] = RECOMMEND_GROUPS.flatMap((g) => g.items);

/** 空态只铺前 4 个芯片，其余走「更多推荐 →」进推荐页（13 个芯片会把空态撑爆） */
export const RECOMMEND_CHIPS = RECOMMEND_ALL.slice(0, 4);

/**
 * 订阅判重键：协议/大小写/www./末尾斜杠都不该决定「已订阅」——
 * 用户可能订的是 `https://hellogithub.com/rss`，推荐位写的是同址不同写法。
 */
export function feedUrlKey(url: string): string {
  let s = String(url || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

/** 该推荐源是否已在订阅列表里（按 feedUrlKey 归一比对） */
export function isSubscribed(url: string, feeds: { url?: string }[]): boolean {
  const key = feedUrlKey(url);
  if (!key) return false;
  return feeds.some((f) => feedUrlKey(f.url || "") === key);
}
