/** 文内搜索（PLAN-READER-FIND）：对渲染后正文 DOM 的只读扫描纯函数。
 *  选择器按 preload/services/article.js 的 sanitize 白名单推导（无 figure/figcaption）；
 *  不含 table/thead/tbody/tr——含 tr 会让嵌套去重守卫误杀 td（tr.closest 命中自身）。
 *  a/strong/em/code 入选：sanitize disallowedTagsMode:"discard" 会把 div/figure 剥成
 *  顶层内联节点/裸文本，不兜底就无声漏报（审核 B5）。 */
export const FIND_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,code,td,th,a,strong,em";

export interface FindMatch {
  el: HTMLElement; // 跳转/闪烁目标（root 直挂裸文本的 pseudo-block 为 root 本身）
  pre: string;
  hit: string;
  post: string;
}

/** 每块命中行上限：防「的/the」高频词吃满列表（审核 S7） */
const PER_BLOCK_CAP = 10;
/** 总行上限；截断时计数显示「N+ 处」 */
const TOTAL_CAP = 200;
/** 命中点前后上下文字符数 */
const CTX = 24;

/** 查询/文本同口径归一：空白折叠 + trim + 小写（查询侧不归一会命中率骤降，审核 S6） */
export function normalizeFindText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

interface Block {
  el: HTMLElement;
  text: string;
}

function enumerateBlocks(root: HTMLElement): Block[] {
  const out: Block[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FIND_SELECTOR))) {
    // 嵌套归外层块（p>a / pre>code / 外层 li>嵌套 li）：textContent 天然包含，不漏报、跳转粒度变粗而已
    if (el.parentElement?.closest(FIND_SELECTOR)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) out.push({ el, text });
  }
  // root 直挂裸文本（sanitize discard div/figure 的产物）：连续 Text 节点聚合为一个 pseudo-block，el=root
  let buf = "";
  const flush = () => {
    const t = buf.replace(/\s+/g, " ").trim();
    if (t) out.push({ el: root, text: t });
    buf = "";
  };
  for (const n of root.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) buf += n.textContent || "";
    else if (buf) flush(); // 元素节点中断聚合（元素自身已在选择器枚举内）
  }
  flush();
  return out;
}

/** 全量扫描：total = 真实命中总数；matches 行数受双重上限约束；truncated = total > 行数 */
export function findMatches(
  root: HTMLElement | null,
  qRaw: string
): { matches: FindMatch[]; total: number; truncated: boolean } {
  const q = normalizeFindText(qRaw);
  if (!root || !q) return { matches: [], total: 0, truncated: false };
  const matches: FindMatch[] = [];
  let total = 0;
  for (const b of enumerateBlocks(root)) {
    const lower = b.text.toLowerCase();
    let from = 0;
    let inBlock = 0;
    for (let i = lower.indexOf(q, from); i >= 0; i = lower.indexOf(q, from)) {
      total += 1;
      if (inBlock < PER_BLOCK_CAP && matches.length < TOTAL_CAP) {
        matches.push({
          el: b.el,
          pre: b.text.slice(Math.max(0, i - CTX), i),
          hit: b.text.slice(i, i + q.length),
          post: b.text.slice(i + q.length, i + q.length + CTX),
        });
        inBlock += 1;
      }
      from = i + q.length;
    }
  }
  return { matches, total, truncated: total > matches.length };
}
