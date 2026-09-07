/**
 * opml.js — OPML 导入导出（fast-xml-parser v4，锁 v4 禁升 5：v5 为 ESM-only）
 */
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

/**
 * 解析 OPML → [{ title, xmlUrl, siteUrl, category }]（多级 folder 拼 "a/b" 平铺分类）
 * @param {string} xmlText
 */
function parseOpml(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true });
  let tree;
  try {
    tree = parser.parse(xmlText);
  } catch (e) {
    throw new Error("OPML_PARSE_FAILED: " + String(e.message || e).slice(0, 60));
  }
  const body = tree && tree.opml && tree.opml.body;
  if (!body) throw new Error("OPML_NO_BODY");

  const out = [];
  const walk = (node, path) => {
    // 单 outline 或数组都要兼容；fast-xml-parser 在单元素时不产生数组
    let children = [];
    if (node && node.outline) children = Array.isArray(node.outline) ? node.outline : [node.outline];
    for (const o of children) {
      if (typeof o !== "object") continue; // 自闭合空节点可能被解析为空串
      const attrs = o["@_"] || o; // ignoreAttributes:false 时属性带 @_ 前缀，纯属性节点无子集
      const xmlUrl = attrs["@_xmlUrl"] || attrs.xmlUrl || "";
      const text = attrs["@_text"] || attrs.text || "";
      const title = attrs["@_title"] || attrs.title || text;
      const htmlUrl = attrs["@_htmlUrl"] || attrs.htmlUrl || "";
      if (xmlUrl) {
        out.push({
          title: String(title || text || xmlUrl).trim(),
          xmlUrl: String(xmlUrl),
          siteUrl: String(htmlUrl || ""),
          category: path.join("/") || "默认",
        });
      } else if (o.outline) {
        // folder 节点：递归（text 为 folder 名）
        walk(o, path.concat([String(text || title || "").trim()].filter(Boolean)));
      }
    }
  };
  walk(body, []);
  return out;
}

/**
 * feeds → OPML 1.0 文本（按分类分组为两级 outline）
 * @param {Array} feeds feed 文档数组（含 title/url/siteUrl/category）
 */
function buildOpml(feeds) {
  const groups = new Map();
  for (const f of feeds) {
    const cat = f.category || "默认";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(f);
  }

  const esc = (s) =>
    String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let body = "";
  for (const [cat, list] of groups) {
    body += `        <outline text="${esc(cat)}" title="${esc(cat)}">\n`;
    for (const f of list) {
      body += `            <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${f.siteUrl ? ` htmlUrl="${esc(f.siteUrl)}"` : ""} />\n`;
    }
    body += `        </outline>\n`;
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<opml version="1.0">\n` +
    `    <head>\n` +
    `        <title>AiRSS 订阅</title>\n` +
    `        <dateCreated>${new Date().toUTCString()}</dateCreated>\n` +
    `    </head>\n` +
    `    <body>\n${body}    </body>\n` +
    `</opml>\n`
  );
}

module.exports = { parseOpml, buildOpml };
