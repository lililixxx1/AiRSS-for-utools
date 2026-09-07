/** 展示层格式化工具 */

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60e3) return "刚刚";
  if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + " 天前";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function firstChar(s: string): string {
  return (s || "?").trim().charAt(0).toUpperCase();
}
