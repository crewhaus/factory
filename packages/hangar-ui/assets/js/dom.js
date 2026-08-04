/**
 * Injection-safe DOM toolkit. Rendering is 100% createElement/textContent —
 * markup-string assignment is banned app-wide (a unit test scans every
 * embedded module for it) — so server data and agent output can never
 * inject markup or script. SVG goes through createElementNS with attribute
 * strings computed by pure helpers.
 *
 * Only function BODIES touch `document`; importing the module outside a
 * browser is safe (the test suite imports it to assert exports).
 */

import { parseMarkdown } from "./markdown.js";
import { fmtRelativeTime } from "./util.js";

const SVGNS = "http://www.w3.org/2000/svg";

/**
 * Build an element.
 *   attrs: { class, text, dataset: {}, style: {}, on<Event>: fn, <attr>: v }
 *   children: Node | string | array (nested) | null
 * Strings become text nodes — never markup.
 */
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "dataset") {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      } else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) {
          // custom properties (e.g. --accent) only apply via setProperty
          if (sk.startsWith("--")) node.style.setProperty(sk, sv);
          else node.style[sk] = sv;
        }
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(node, children);
  return node;
}

/** A plain text node. */
export function text(value) {
  return document.createTextNode(String(value));
}

/** Append Node | string | nested arrays; null/undefined are skipped. */
export function append(node, children) {
  if (children === null || children === undefined) return node;
  if (Array.isArray(children)) {
    for (const c of children) append(node, c);
    return node;
  }
  if (typeof Node !== "undefined" && children instanceof Node) {
    node.appendChild(children);
    return node;
  }
  node.appendChild(text(children));
  return node;
}

/** Remove all children. Returns the node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** An SVG element (children must already be nodes). */
export function svgEl(tag, attrs, children) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
    }
  }
  if (Array.isArray(children)) {
    for (const c of children) node.appendChild(c);
  }
  return node;
}

/**
 * Traffic-light dot — ALWAYS paired with a text label (never color alone).
 * state: "ok" | "warn" | "bad" | "unknown" | "off"
 */
export function dot(state, label) {
  return el("span", { class: `dot-pair dot-${state}` }, [
    el("span", { class: "dot", "aria-hidden": "true" }),
    el("span", { class: "dot-label", text: label }),
  ]);
}

/**
 * Standard empty state. "Absence is not an error": a 404/empty payload
 * renders as "nothing yet" and names the CLI verb that creates the data.
 */
export function emptyState(message, verb) {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-msg", text: message }),
    verb
      ? el("div", { class: "empty-verb" }, ["Run ", el("code", { text: verb }), " to create it."])
      : null,
  ]);
}

/** Loading skeleton (opacity pulse only — the one animation in the app). */
export function skeleton(lines = 3) {
  const wrap = el("div", { class: "skeleton", "aria-label": "loading", role: "status" });
  for (let i = 0; i < lines; i += 1) wrap.appendChild(el("div", { class: "skel-line" }));
  return wrap;
}

/** "as of 3m ago" chip for cached figures (honest-latency invariant). */
export function asOf(cachedAtIso) {
  if (!cachedAtIso) return null;
  return el("span", {
    class: "asof",
    title: cachedAtIso,
    text: `as of ${fmtRelativeTime(cachedAtIso, Date.now())}`,
  });
}

/** Click-to-copy button (clipboard API; silently no-ops when unavailable). */
export function copyBtn(value, label = "copy") {
  const btn = el("button", { class: "btn btn-ghost btn-copy", type: "button", text: label });
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = "copied";
      btn.classList.add("ok");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("ok");
      }, 1200);
    } catch {
      btn.textContent = "copy failed";
    }
  });
  return btn;
}

/** A native collapsible (<details>) card. */
export function collapsible(summaryChildren, bodyChildren, open = false) {
  return el("details", { class: "fold", open: open || null }, [
    el("summary", { class: "fold-summary" }, summaryChildren),
    el("div", { class: "fold-body" }, bodyChildren),
  ]);
}

/** Line-numbered read-only code view (one div per line, all textContent). */
export function numberedCode(source, label = "code") {
  const wrap = el("div", { class: "codeview", role: "region", "aria-label": label });
  const lines = String(source ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    wrap.appendChild(
      el("div", { class: "codeline" }, [
        el("span", { class: "ln", text: String(i + 1) }),
        el("span", { class: "lc", text: lines[i] === "" ? " " : lines[i] }),
      ]),
    );
  }
  return wrap;
}

/** Pretty-printed JSON in a <pre> (for the Raw toggles). */
export function jsonPre(value) {
  let body;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return el("pre", { class: "rawjson", text: body });
}

/** Render parsed markdown tokens (see markdown.js) into a container div. */
export function mdBlocks(source) {
  const wrap = el("div", { class: "md" });
  for (const block of parseMarkdown(source)) {
    if (block.type === "heading") {
      const level = Math.min(6, Math.max(1, block.level));
      wrap.appendChild(el(`h${level}`, null, spansToNodes(block.spans)));
    } else if (block.type === "para") {
      wrap.appendChild(el("p", null, spansToNodes(block.spans)));
    } else if (block.type === "list") {
      wrap.appendChild(
        el(
          block.ordered ? "ol" : "ul",
          null,
          block.items.map((spans) => el("li", null, spansToNodes(spans))),
        ),
      );
    } else if (block.type === "code") {
      wrap.appendChild(el("pre", { class: "mdcode" }, [el("code", { text: block.text })]));
    }
  }
  return wrap;
}

function spansToNodes(spans) {
  return spans.map((s) => {
    if (s.type === "bold") return el("strong", { text: s.text });
    if (s.type === "code") return el("code", { text: s.text });
    return text(s.text);
  });
}
