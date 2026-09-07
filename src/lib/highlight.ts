/** 搜索词项安全高亮：纯文本切段（模板 v-for 渲染文本插值，绝不 innerHTML） */
export function highlightSegments(text: string, terms: string[]): { t: string; hit: boolean }[] {
  const ts = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 3);
  if (!ts.length || !text) return [{ t: text, hit: false }];
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of ts) {
    const i = lower.indexOf(term);
    if (i >= 0) spans.push([i, i + term.length]);
  }
  if (!spans.length) return [{ t: text, hit: false }];
  spans.sort((a, b) => a[0] - b[0]);
  const segs: { t: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue; // 重叠词项跳过
    if (s > pos) segs.push({ t: text.slice(pos, s), hit: false });
    segs.push({ t: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) segs.push({ t: text.slice(pos), hit: false });
  return segs;
}
