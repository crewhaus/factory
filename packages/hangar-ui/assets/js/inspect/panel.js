/**
 * The inspector: one object, opened in place over the page it lives on.
 *
 * - An object link (`#/i/<ref>`) is resolved through `refs.resolve`; the address
 *   is replaced (no history entry) by the object's home route with
 *   `?inspect=<ref>`, and that page draws with the inspector over it. A link that
 *   opens nothing says why in words, and a bare id that may name several things
 *   lists them as links.
 * - `?inspect=<ref>` on any page opens the inspector: a side panel on a wide
 *   screen beside the page (the page keeps its width clear of it), its heading
 *   taking focus, Escape anywhere closing it (after any open dialog or tooltip)
 *   and focus returning to what opened it; under the narrow breakpoint a
 *   full-screen dialog, which keeps focus inside while it is open. Opening or
 *   closing it never draws the page again.
 * - Tabs: Summary (what Home says about it, its state in words, its revision),
 *   Technical (the ref, its kind, its revisions, the API request that resolves
 *   it), and Timeline for a run (the run view).
 *
 * The DOM is built with `el` only; nothing runs at import.
 */

import { el } from "../dom.js";
import { hrefHarness, refShape, withInspect, withoutInspect } from "../router.js";
import { openDialog } from "../ui/dialog.js";
import { call, discover } from "../v1.js";
import { equivalentsFor } from "./equivalents.js";
import { answerWords, candidateLinks, harnessOfRef, inspectKind } from "./kinds.js";

/** Below this width the inspector is a full-screen dialog (the stylesheet's breakpoint). */
const NARROW = "(max-width: 860px)";

/** The ref a route names, parsed for its shape, or null. */
function refOf(text) {
  return refShape(text);
}

/** Resolve a ref (or a bare id with its harness) through Home. */
export async function resolveRef(ref, harness) {
  return call("refs.resolve", {
    params: { ref },
    ...(typeof harness === "string" && harness !== "" ? { query: { harness } } : {}),
  });
}

/** A short block of plain words: a heading and a sentence. */
function says(title, detail) {
  return [el("h1", { tabindex: "-1", text: title }), el("p", { class: "muted", text: detail })];
}

/**
 * Draw an object link's page: resolve it, then go to the object's page with the
 * inspector over it, or say why it does not open. `go(hash)` replaces the address
 * and draws it.
 */
export async function renderRefRoute(container, route, { signal, go }) {
  const harness = typeof route.query?.harness === "string" ? route.query.harness : undefined;
  const answer = await resolveRef(route.ref, harness);
  if (signal?.aborted) return {};
  const body = answer.ok ? answer.body : null;
  if (body !== null && body.kind !== "candidates") {
    const resolved = typeof body.href === "string" ? body.href.replace(/^\/#\/i\//, "") : route.ref;
    const ref = refOf(resolved) ?? refOf(route.ref);
    const kind = ref === null ? null : inspectKind(ref.kind);
    if (ref !== null && kind !== null) {
      go(withInspect(kind.homeRoute(ref), `${ref.scope}/${ref.kind}/${ref.id}`));
      return {};
    }
  }
  const page = el("div", { class: "card inspect-link" });
  if (body !== null && body.kind === "candidates") {
    page.append(...says("This id names more than one thing", "Open the one you meant."));
    page.append(linkList(candidateLinks(body.candidates)));
  } else {
    const words = answerWords(refOf(route.ref), answer);
    page.append(...says(words.title, words.detail));
    if (Array.isArray(words.candidates) && words.candidates.length > 0) {
      page.append(linkList(candidateLinks(words.candidates)));
    }
  }
  page.append(el("p", null, [el("a", { class: "btn", href: "#/", text: "Go to Home" })]));
  container.replaceChildren(page);
  return {};
}

function linkList(links) {
  return el(
    "ul",
    { class: "inspect-candidates" },
    links.map((link) =>
      el("li", null, [
        el("a", { href: link.href, text: link.label }),
        " ",
        el("code", { class: "mono", text: link.ref }),
      ]),
    ),
  );
}

let open = null;

/** Close the inspector, if one is open. */
export function closeInspector() {
  if (open !== null) open.close();
}

/**
 * The inspector over the current page for `refText`. `opener` gets focus back
 * when it closes; `onClose` runs after, e.g. to drop `?inspect=` from the address.
 */
export function openInspector(refText, { root, opener = null, onClose } = {}) {
  closeInspector();
  const ref = refOf(refText);
  if (ref === null) return null;
  const kind = inspectKind(ref.kind);
  const titleId = "inspector-title";
  const heading = el("h2", { id: titleId, tabindex: "-1", text: kind?.noun ?? "Object" });
  const content = el("div", { class: "inspector-body" });
  // What a tab opened (the run view's stream) ends when another tab is chosen or it closes.
  let tabAbort = null;
  const tabs = tabStrip(kind?.tabs ?? [], (tab) => {
    tabAbort?.abort();
    tabAbort = new AbortController();
    void drawTab(content, ref, tab, tabAbort.signal);
  });
  const narrow = typeof window !== "undefined" && window.matchMedia?.(NARROW).matches === true;
  const returnTo = opener instanceof HTMLElement ? opener : document.activeElement;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    tabAbort?.abort();
    open = null;
    if (typeof onClose === "function") onClose();
  };
  if (narrow) {
    const dialog = openDialog({
      title: kind?.noun ?? "Object",
      body: [tabs.node, content],
      className: "modal card inspector inspector-full",
      initialFocus: "heading",
      returnFocus: returnTo,
      actions: [
        el("button", {
          class: "btn",
          type: "button",
          text: "Close",
          onClick: () => dialog.close(),
        }),
      ],
      onClose: finish,
    });
    open = { close: dialog.close };
  } else {
    const closeBtn = el("button", {
      class: "btn btn-ghost inspector-close",
      type: "button",
      text: "Close",
      "aria-label": "Close the inspector",
    });
    const panel = el(
      "aside",
      { class: "inspector card", "aria-labelledby": titleId, dataset: { inspector: ref.kind } },
      [el("div", { class: "inspector-head" }, [heading, closeBtn]), tabs.node, content],
    );
    // Escape from the page closes it too: the app's one key layer calls closeInspector.
    const close = () => {
      panel.remove();
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true });
      }
      finish();
    };
    closeBtn.addEventListener("click", close);
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    (root ?? document.getElementById("view") ?? document.body).appendChild(panel);
    heading.focus();
    open = { close };
  }
  tabs.select(0);
  return open;
}

/** A tab strip: buttons with `aria-selected`, Left/Right moving between them. */
function tabStrip(tabs, onSelect) {
  const list = el("div", { class: "inspector-tabs", role: "tablist", "aria-label": "Views" });
  const buttons = tabs.map((tab, i) =>
    el("button", {
      type: "button",
      role: "tab",
      id: `inspector-tab-${tab.id}`,
      "aria-selected": "false",
      tabindex: "-1",
      text: tab.label,
      onClick: () => select(i),
    }),
  );
  const select = (i) => {
    buttons.forEach((button, j) => {
      button.setAttribute("aria-selected", String(i === j));
      button.tabIndex = i === j ? 0 : -1;
    });
    onSelect(tabs[i]);
  };
  list.addEventListener("keydown", (event) => {
    const at = buttons.indexOf(document.activeElement);
    if (at === -1) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (at + step + buttons.length) % buttons.length;
    select(next);
    buttons[next].focus();
  });
  list.append(...buttons);
  return { node: list, select: (i) => (buttons.length > 0 ? select(i) : undefined) };
}

/** Draw one tab's content. Each tab reads what it shows when it is chosen. */
async function drawTab(content, ref, tab, signal) {
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", `inspector-tab-${tab.id}`);
  content.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
  const refText = `${ref.scope}/${ref.kind}/${ref.id}`;
  if (tab.id === "timeline") {
    const { mountRunView } = await import("../runview/index.js");
    content.replaceChildren();
    if (signal.aborted) return;
    mountRunView(content, { harness: ref.scope, run: ref.id, signal });
    return;
  }
  const answer = await resolveRef(refText);
  // Another tab was chosen while this one read: it draws instead.
  if (signal.aborted) return;
  if (!answer.ok) {
    const words = answerWords(ref, answer);
    content.replaceChildren(
      el("p", { text: words.title }),
      el("p", { class: "muted", text: words.detail }),
    );
    return;
  }
  const body = answer.body ?? {};
  if (tab.id === "summary") {
    const harness = harnessOfRef(ref);
    content.replaceChildren(
      el("p", { class: "inspector-summary", text: String(body.summary ?? "") }),
      el("dl", { class: "kv" }, [
        el("dt", { text: "Revision" }),
        el("dd", { class: "mono", text: String(body.rev ?? "—") }),
        ...(harness !== null
          ? [
              el("dt", { text: "Harness" }),
              el("dd", null, [el("a", { href: hrefHarness(harness), text: harness })]),
            ]
          : []),
      ]),
    );
    return;
  }
  // Technical: the ref, its kind, its revisions, and the request that resolves it.
  const revisions =
    body.revisions && typeof body.revisions === "object" ? Object.entries(body.revisions) : [];
  const table = await discover().catch(() => null);
  if (signal.aborted) return;
  const row = table?.operations?.find((op) => op.id === "refs.resolve") ?? null;
  const forms = equivalentsFor(row, { ref: refText }, { homeUrl: homeUrl() });
  content.replaceChildren(
    el("dl", { class: "kv" }, [
      el("dt", { text: "Ref" }),
      el("dd", null, [el("code", { class: "mono", text: refText })]),
      el("dt", { text: "Kind" }),
      el("dd", { class: "mono", text: String(body.kind ?? ref.kind) }),
      ...revisions.flatMap(([name, value]) => [
        el("dt", { text: name }),
        el("dd", { class: "mono", text: String(value) }),
      ]),
    ]),
    "none" in forms
      ? el("p", { class: "muted", text: forms.none })
      : el("details", { class: "inspector-api" }, [
          el("summary", { text: "View API request" }),
          el("pre", { class: "mono", tabindex: "0", text: forms.http }),
          el("pre", { class: "mono", tabindex: "0", text: forms.curl }),
          el("pre", { class: "mono", tabindex: "0", text: forms.api }),
        ]),
  );
}

/** Home's address as this browser reaches it. */
export function homeUrl() {
  return typeof window === "undefined" ? null : window.location.origin;
}

/**
 * After a page has drawn, or when only its `?inspect=` changed: open the inspector
 * it names over the page, focus returning to `opener` when it closes, and drop the
 * parameter from the address (no history entry) when the inspector closes.
 */
export function inspectAfterRoute(route, root, { opener = null } = {}) {
  const ref = route?.query?.inspect;
  if (typeof ref !== "string" || refOf(ref) === null) {
    closeInspector();
    return;
  }
  openInspector(ref, {
    root,
    opener,
    // Only this inspector's own `?inspect=` is dropped: a newer one may have replaced it.
    onClose: () => {
      const hash = window.location.hash;
      const at = hash.indexOf("?");
      const named = at === -1 ? null : new URLSearchParams(hash.slice(at + 1)).get("inspect");
      if (named !== ref) return;
      window.history.replaceState(window.history.state, "", withoutInspect(hash));
    },
  });
}
