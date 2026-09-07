/**
 * icons.ts — 内联 SVG 图标（24 viewBox · stroke 2 · round · currentColor；design-system §7）
 * 尺寸由使用处 CSS 决定（1em 基准）；不用 emoji、不引图标库。
 */
import { h, type FunctionalComponent } from "vue";

function make(children: string[], opts: { fill?: boolean } = {}): FunctionalComponent {
  return () =>
    h(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: "1em",
        height: "1em",
        fill: opts.fill ? "currentColor" : "none",
        stroke: "currentColor",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      },
      children.map((d, i) => h("path", { key: i, d }))
    );
}

function makeShapes(shapes: any[]): FunctionalComponent {
  return () =>
    h(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: "1em",
        height: "1em",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      },
      // 形状描述对象必须转成真实 VNode（裸对象传 h() 会被当无效子节点丢弃）
      shapes.map((s, i) => {
        if (s.type === "circle") return h("circle", { key: i, cx: s.cx, cy: s.cy, r: s.r, ...(s.fill ? { fill: "currentColor", stroke: "none" } : {}) });
        if (s.type === "rect") return h("rect", { key: i, x: s.x, y: s.y, width: s.width, height: s.height, rx: s.rx || 0 });
        if (s.type === "path") return h("path", { key: i, d: s.d });
        return null;
      })
    );
}

const circle = (cx: number, cy: number, r: number, extra: any = {}) => ({ type: "circle", cx, cy, r, ...extra });
const rect = (x: number, y: number, width: number, height: number, rx = 0) => ({ type: "rect", x, y, width, height, rx });

export const I = {
  refresh: make(["M21 12a9 9 0 1 1-2.64-6.36L21 8", "M21 3v5h-5"]),
  doneAll: make(["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"]),
  list: make(["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"]),
  grid: makeShapes([rect(3, 3, 7, 7, 1), rect(14, 3, 7, 7, 1), rect(14, 14, 7, 7, 1), rect(3, 14, 7, 7, 1)]),
  sort: make(["m7 15 5 5 5-5", "m7 9 5-5 5 5"]),
  search: makeShapes([circle(11, 11, 7), { type: "path", d: "m21 21-4.3-4.3" }]),
  plus: make(["M5 12h14", "M12 5v14"]),
  settings: make(["M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3", "M14 2v4", "M8 10v4", "M16 18v4"]),
  upload: make(["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"]),
  download: make(["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"]),
  star: make(["M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"]),
  starFilled: make(["M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"], { fill: true }),
  bookmark: make(["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"]),
  bookmarkFilled: make(["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"], { fill: true }),
  share: makeShapes([
    circle(18, 5, 3),
    circle(6, 12, 3),
    circle(18, 19, 3),
    { type: "path", d: "m8.59 13.51 6.83 3.98" },
    { type: "path", d: "m15.41 6.51-6.82 3.98" },
  ]),
  externalLink: make(["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"]),
  clock: makeShapes([circle(12, 12, 10), { type: "path", d: "M12 6v6l4 2" }]),
  arrowLeft: make(["m12 19-7-7 7-7", "M19 12H5"]),
  close: make(["M18 6 6 18", "m6 6 12 12"]),
  alertTriangle: make(["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2z", "M12 9v4", "M12 17h.01"]),
  check: make(["M20 6 9 17l-5-5"]),
  chevronLeft: make(["m15 18-6-6 6-6"]),
  chevronRight: make(["m9 18 6-6-6-6"]),
  chevronDown: make(["m6 9 6 6 6-6"]),
  trash: make(["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"]),
  edit: make(["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"]),
  moreVertical: makeShapes([circle(12, 5, 1), circle(12, 12, 1), circle(12, 19, 1)]),
  rss: make(["M4 11a9 9 0 0 1 9 9", "M4 4a16 16 0 0 1 16 16", "M5 19a.5.5 0 1 1 0-.01"]),
  copy: makeShapes([rect(9, 9, 13, 13, 2), { type: "path", d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]),
  sun: makeShapes([
    circle(12, 12, 4),
    { type: "path", d: "M12 2v2" }, { type: "path", d: "M12 20v2" },
    { type: "path", d: "m4.93 4.93 1.41 1.41" }, { type: "path", d: "m17.66 17.66 1.41 1.41" },
    { type: "path", d: "M2 12h2" }, { type: "path", d: "M20 12h2" },
    { type: "path", d: "m6.34 17.66-1.41 1.41" }, { type: "path", d: "m19.07 4.93-1.41 1.41" },
  ]),
  moon: make(["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"]),
  monitor: makeShapes([rect(2, 3, 20, 14, 2), { type: "path", d: "M8 21h8" }, { type: "path", d: "M12 17v4" }]),
  folder: make(["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]),
  inbox: make(["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"]),
  radio: makeShapes([circle(12, 12, 9)]),
  radioChecked: makeShapes([circle(12, 12, 9), circle(12, 12, 3, { fill: "currentColor" })]),
  sparkle: make([
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z",
    "M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z",
  ]),
  languages: make(["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"]),
  volumeX: make(["M11 5 6 9H2v6h4l5 4V5z", "m22 9-6 6", "m16 9 6 6"]),
};

export type IconName = keyof typeof I;
