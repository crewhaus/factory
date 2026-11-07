/**
 * Injection-safe DOM toolkit. Rendering is 100% createElement/textContent —
 * markup-string assignment is banned app-wide (a unit test scans every
 * embedded module for it) — so server data and agent output can never
 * inject markup or script. SVG goes through createElementNS with attribute
 * strings computed by pure helpers.
 *
 * Only function BODIES touch `document`; importing the module outside a
 * browser is safe (the test suite imports it to assert exports). That is
 * also what makes the import cycle with `ui/live.js` and `ui/time.js` safe:
 * they import `el` from here, and neither side builds a node or registers a
 * listener at import time.
 */

import { parseMarkdown } from "./markdown.js";
import { announce, liveHost, politenessFor } from "./ui/live.js";
import { timeEl } from "./ui/time.js";

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
 * A state as a word in a badge, with its mark beside it: "Selected",
 * "Armed", a severity. The word is the message; the mark only repeats it.
 * state: "ok" | "warn" | "bad" | "info" | "off"
 */
export function statusBadge(state, word) {
  const tone = ["ok", "warn", "bad", "info"].includes(state) ? state : "off";
  return el("span", { class: `status-badge status-badge-${tone}` }, [
    el("span", { class: "dot", "aria-hidden": "true" }),
    el("span", { text: String(word ?? "") }),
  ]);
}

/**
 * A container that scrolls sideways (a wide table) and can be reached and
 * scrolled from the keyboard: a named region in the Tab order. The page
 * itself never scrolls sideways; the region does.
 */
export function scrollRegion(label, child) {
  return el(
    "div",
    { class: "table-scroll", tabindex: "0", role: "region", "aria-label": String(label) },
    child,
  );
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

/** "as of 3m ago" chip for cached figures (honest-latency invariant). The
 *  time inside is a `<time datetime>` the shared ticker keeps current. */
export function asOf(cachedAtIso) {
  if (typeof cachedAtIso !== "string" || cachedAtIso === "") return null;
  return el("span", { class: "asof" }, ["as of ", timeEl(cachedAtIso)]);
}

/** How long an information toast stays, unless it is being read. */
const INFO_TOAST_MS = 6000;

/**
 * Error/notice toast — the "no write ever fails silently" affordance. One
 * toast at a time (a newer message replaces the older).
 *
 * The words are SPOKEN through the live regions: information politely,
 * errors assertively (`ui/live.js`). The box itself is not a live region, so
 * nothing is read twice. An error stays until it is dismissed; information
 * leaves after a few seconds, and holds while the pointer is over it or it
 * has focus. Both have a close button.
 */
export function toast(message, kind = "error") {
  for (const old of document.querySelectorAll(".toast")) old.remove();
  const isError = kind === "error";
  const close = el("button", {
    class: "btn btn-ghost toast-close",
    type: "button",
    "aria-label": "Dismiss this message",
    text: "×",
  });
  const node = el("div", { class: `toast toast-${isError ? "error" : "info"}` }, [
    el("span", { class: "toast-text", text: String(message ?? "") }),
    close,
  ]);
  close.addEventListener("click", () => node.remove());
  liveHost().appendChild(node);
  announce(String(message ?? ""), {
    assertive: politenessFor(isError ? "error" : "info") === "assertive",
  });
  if (!isError) {
    let timer = null;
    const arm = () => {
      if (timer === null) timer = setTimeout(() => node.remove(), INFO_TOAST_MS);
    };
    const hold = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    node.addEventListener("mouseenter", hold);
    node.addEventListener("mouseleave", arm);
    node.addEventListener("focusin", hold);
    node.addEventListener("focusout", arm);
    arm();
  }
  return node;
}

/**
 * Copy `text`, falling back to the old selection trick.
 *
 * `navigator.clipboard` is a secure-context API. `127.0.0.1` counts as
 * secure, so on the loopback console it always works — and over
 * `http://192.168.x.x`, which is what `crewhaus hangar --lan` serves, the
 * whole object is `undefined` and every copy button in the console reads
 * "copy failed". That is invisible until someone opens the console from a
 * phone, which is exactly who cannot retype a harness directory by hand.
 *
 * The fallback is `document.execCommand("copy")` over a throwaway textarea:
 * deprecated, still implemented everywhere, and not gated on a secure
 * context. The textarea is positioned off-screen rather than hidden because
 * a `display: none` element cannot hold a selection.
 */
async function writeClipboard(text) {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused, or a non-secure context that still exposes the
      // object. Fall through rather than giving up.
    }
  }
  const scratch = el("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "readonly");
  scratch.setAttribute("aria-hidden", "true");
  // Off-screen rather than hidden: a `display: none` element cannot hold a
  // selection, and `opacity: 0` alone would still scroll the page.
  scratch.style.position = "fixed";
  scratch.style.top = "-1000px";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  try {
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    scratch.remove();
  }
}

/** Click-to-copy button. Works on the loopback console and over a LAN
 *  address alike — see {@link writeClipboard}. */
export function copyBtn(value, label = "copy") {
  const btn = el("button", { class: "btn btn-ghost btn-copy", type: "button", text: label });
  btn.addEventListener("click", async () => {
    const copied = await writeClipboard(value);
    btn.textContent = copied ? "copied" : "copy failed";
    if (copied) btn.classList.add("ok");
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("ok");
    }, 1200);
  });
  return btn;
}

/**
 * Attach a tooltip. The text rides a `data-tip` attribute; the one tooltip
 * element (`ui/tooltip.js`) shows it on hover AND on focus, describes the
 * control with it while open, and closes on Escape. It is always text,
 * never markup, so the injection ban holds. Put it on something that takes
 * focus — a button, a link, a field — or a keyboard never reaches it.
 * Returns the node.
 */
export function withTip(node, tipText) {
  const value = String(tipText ?? "");
  if (value === "") return node;
  node.dataset.tip = value;
  return node;
}

/** A small "?" button carrying only its tooltip — guidance on rows where a
 *  whole sentence inline would drown the content. A button, so the tip is
 *  reachable by keyboard; a 24px target around a small mark. */
export function tipIcon(tipText) {
  return withTip(
    el("button", {
      class: "tip-icon",
      type: "button",
      "aria-label": "What this means",
      text: "?",
    }),
    tipText,
  );
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
  const wrap = el("div", { class: "codeview", role: "region", "aria-label": label, tabindex: "0" });
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
  // In the Tab order: a long line scrolls sideways, and a keyboard has to
  // be able to reach what is past the edge.
  return el("pre", { class: "rawjson", tabindex: "0", text: body });
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
      wrap.appendChild(
        el("pre", { class: "mdcode", tabindex: "0" }, [el("code", { text: block.text })]),
      );
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
