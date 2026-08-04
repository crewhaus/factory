/**
 * Minimal SAFE markdown parser for the wiki reader: headings, bold, inline
 * code, unordered/ordered lists, and fenced code blocks — nothing else, and
 * explicitly NO raw-HTML passthrough. The parser emits a token tree; the DOM
 * layer renders every token via `textContent`, so `<script>` in an article
 * body stays literal text by construction.
 *
 * DOM-free and pure so it runs identically in the browser and under
 * `bun test`.
 */

/** Parse inline spans: `**bold**` and `` `code` ``; the rest is plain text. */
export function parseInline(src) {
  const s = String(src ?? "");
  const spans = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf !== "") {
      spans.push({ type: "text", text: buf });
      buf = "";
    }
  };
  while (i < s.length) {
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        spans.push({ type: "bold", text: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        flush();
        spans.push({ type: "code", text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += s[i];
    i += 1;
  }
  flush();
  return spans;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_ITEM_RE = /^\s*[-*]\s+(.*)$/;
const OL_ITEM_RE = /^\s*\d+[.)]\s+(.*)$/;
const FENCE_RE = /^```/;

/**
 * Parse a markdown source string into a flat list of block tokens:
 *   { type: "heading", level, spans }
 *   { type: "para", spans }
 *   { type: "list", ordered, items: spans[][] }
 *   { type: "code", text }
 * Unrecognized syntax degrades to paragraph text; raw HTML is never parsed.
 */
export function parseMarkdown(src) {
  const lines = String(src ?? "").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "para", spans: parseInline(para.join(" ")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      blocks.push(list);
      list = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line.trim())) {
      flushPara();
      flushList();
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence (or run off the end on an unclosed one)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    const ul = line.match(UL_ITEM_RE);
    const ol = ul === null ? line.match(OL_ITEM_RE) : null;
    if (ul || ol) {
      flushPara();
      const ordered = ol !== null;
      const item = parseInline((ul ?? ol)[1]);
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push(item);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      i += 1;
      continue;
    }
    flushList();
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  flushList();
  return blocks;
}
