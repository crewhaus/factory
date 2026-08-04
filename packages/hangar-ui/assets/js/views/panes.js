/**
 * HM-179 — plugin panes, rendered.
 *
 * A pane is third-party markup, so it is never injected into this document.
 * It goes into an `<iframe>` whose `sandbox` grants `allow-scripts` and
 * NOTHING else: without `allow-same-origin` the frame has an opaque origin,
 * so its script cannot reach this page's DOM, its sessionStorage (where the
 * bearer token lives) or its history. The Content-Security-Policy the server
 * computed from the plugin's own `net` allow-list rides along inside the
 * document as a `<meta http-equiv>` line — fail-closed, so a plugin with no
 * declared network permission gets `connect-src 'none'`.
 *
 * The frame is built with `srcdoc`, which is the ONE place in this console
 * where a markup string reaches the DOM — and it is the one place where that
 * is the safe option rather than the dangerous one: the string never becomes
 * part of this document, only of a sandboxed one. Everything else on this
 * screen is built with createElement like the rest of the app.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, skeleton } from "../dom.js";

/**
 * Assemble the sandboxed document: the plugin's own markup with the policy
 * prepended. Pure, so the containment can be unit-tested — the assertions
 * that matter are that the CSP is present and that the sandbox list never
 * grows `allow-same-origin`.
 */
export function paneSrcdoc(doc) {
  const csp = String(doc?.csp ?? "default-src 'none'");
  const body = String(doc?.doc ?? "");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${body}</body></html>`;
}

/** The sandbox token list for a pane frame. Never `allow-same-origin`. */
export function paneSandbox(doc) {
  const declared = String(doc?.sandbox ?? "allow-scripts");
  const tokens = declared.split(/\s+/).filter((t) => t !== "" && t !== "allow-same-origin");
  return tokens.length > 0 ? tokens.join(" ") : "allow-scripts";
}

export async function renderPanes(root, ctx) {
  clear(root).appendChild(skeleton(4));
  let payload = null;
  try {
    payload = await api.panes(ctx.id);
  } catch (err) {
    clear(root).appendChild(
      el("div", { class: "card error-card" }, [
        el("h2", { text: "Panes unavailable" }),
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  clear(root);
  const panes = Array.isArray(payload?.panes) ? payload.panes : [];
  const observers = Array.isArray(payload?.traceObservers) ? payload.traceObservers : [];

  root.appendChild(
    el("section", { class: "card" }, [
      el("h3", { class: "card-title", text: "Trace observers" }),
      observers.length === 0
        ? emptyState(
            "No plugin observes this harness's trace events",
            "crewhaus plugins install <name>",
          )
        : el(
            "div",
            { class: "safety-strip" },
            observers.map((name) => el("span", { class: "chip", text: String(name) })),
          ),
      el("p", {
        class: "muted small",
        text: "A plugin observes a harness only when its filesystem read permission covers that harness's directory — the same fail-closed evaluator the loader uses.",
      }),
    ]),
  );

  if (panes.length === 0) {
    root.appendChild(
      emptyState("No plugin pane applies to this harness", "crewhaus plugins install <name>"),
    );
  }
  for (const pane of panes) {
    root.appendChild(await paneCard(pane));
  }
}

async function paneCard(pane) {
  const card = el("section", { class: "card" }, [
    el("div", { class: "rollup" }, [
      el("h3", { class: "card-title", text: String(pane?.title ?? pane?.id ?? "pane") }),
      el("span", { class: "chip", text: String(pane?.plugin ?? "") }),
    ]),
  ]);
  let doc = null;
  try {
    doc = await api.pluginPane(String(pane?.plugin ?? ""), String(pane?.id ?? ""));
  } catch (err) {
    card.appendChild(
      el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
    );
    return card;
  }
  if (doc === null) {
    card.appendChild(emptyState("This pane's document is missing", "crewhaus plugins list"));
    return card;
  }
  const frame = el("iframe", {
    class: "pane-frame",
    title: String(pane?.title ?? "plugin pane"),
    sandbox: paneSandbox(doc),
    referrerpolicy: "no-referrer",
    loading: "lazy",
  });
  // `srcdoc` — see the module docblock: the string becomes the SANDBOXED
  // document, never part of this one.
  frame.setAttribute("srcdoc", paneSrcdoc(doc));
  card.appendChild(frame);
  card.appendChild(
    el("div", { class: "muted small" }, [
      dot("ok", "sandboxed (opaque origin)"),
      el("code", { class: "mono", text: String(doc.csp ?? "") }),
    ]),
  );
  if (doc.truncated === true) {
    card.appendChild(dot("warn", "the pane document was capped — it is shown truncated"));
  }
  return card;
}
