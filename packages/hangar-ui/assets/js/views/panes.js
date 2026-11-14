/**
 * HM-179 — plugin panes, rendered.
 *
 * A pane is third-party markup, so it is never injected into this document.
 * It goes into an `<iframe>` whose `sandbox` grants `allow-scripts` and
 * NOTHING else: without `allow-same-origin` the frame has an opaque origin,
 * so its script cannot reach this page's DOM, its sessionStorage (where the
 * session lives) or its history.
 *
 * Home serves a plugin only what its owner allowed in Settings › Plugins: its
 * tabs on the harnesses it was allowed, and only the websites it was allowed.
 *
 * The frame loads the pane from a single-use address the pane read hands out
 * (`src`, `/pane/<nonce>`), which serves the document with the Content-
 * Security-Policy the server computed from the origins its owner allowed —
 * fail-closed, so a plugin allowed none gets `connect-src 'none'` — and the
 * same sandbox, both as response headers. A
 * `srcdoc` frame would inherit this console's own policy instead, under
 * which a pane's own script never runs. No markup string reaches the DOM on
 * this screen; everything is built with createElement like the rest of the app.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, skeleton } from "../dom.js";
import { hrefFleet } from "../router.js";
import { call } from "../v1.js";
import { stateBadge, useInHarness } from "./plugins.js";

const PANE_SRC_RE = /^\/pane\/[0-9a-f]{64}$/;

/**
 * The address a pane frame loads: only a single-use pane address on this
 * server, never anything a payload could point elsewhere. `null` otherwise.
 */
export function paneSrc(doc) {
  const src = typeof doc?.src === "string" ? doc.src : "";
  return PANE_SRC_RE.test(src) ? src : null;
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
        text: "A plugin sees this harness's run activity only when you allowed it in Settings › Plugins.",
      }),
    ]),
  );

  const waiting = Array.isArray(payload?.waiting) ? payload.waiting : [];
  if (panes.length === 0 && waiting.length > 0) {
    root.appendChild(
      el("div", { class: "empty" }, [
        el("div", { class: "empty-msg", text: "Waiting for your OK" }),
        el("p", { class: "muted", text: `${waiting.join(", ")} asks to add panels here.` }),
        el("a", {
          class: "btn btn-primary",
          href: hrefFleet("settings", "plugins"),
          text: "Review",
        }),
      ]),
    );
  } else if (panes.length === 0) {
    root.appendChild(
      emptyState("No plugin pane applies to this harness", "crewhaus plugins install <name>"),
    );
  }
  for (const pane of panes) {
    root.appendChild(await paneCard(pane));
  }
  await appendUseCards(root, ctx);
}

/** One "Use in this harness" card per plugin with a live grant. */
async function appendUseCards(root, ctx) {
  let inventory = null;
  try {
    inventory = await api.plugins();
  } catch {
    return;
  }
  const live = (Array.isArray(inventory?.plugins) ? inventory.plugins : []).filter(
    (p) =>
      (p?.problems ?? []).length === 0 &&
      (p?.grant?.state === "allowed" || p?.grant?.state === "asks-for-more"),
  );
  for (const plugin of live) {
    const review = await call("plugins.review", { params: { plugin: String(plugin.name) } });
    const served =
      review.ok && Array.isArray(review.body?.served?.tools) ? review.body.served.tools : [];
    root.appendChild(
      el("section", { class: "card" }, [
        el("div", { class: "rollup" }, [
          el("h3", { class: "card-title", text: String(plugin.name) }),
          stateBadge(plugin.grant.state),
        ]),
        useInHarness(ctx, plugin, served.map(String), () => renderPanes(root, ctx)),
      ]),
    );
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
  const src = paneSrc(doc);
  if (doc === null || src === null) {
    card.appendChild(emptyState("This pane's document is missing", "crewhaus plugins list"));
    return card;
  }
  const frame = el("iframe", {
    class: "pane-frame",
    title: String(pane?.title ?? "plugin pane"),
    sandbox: paneSandbox(doc),
    referrerpolicy: "no-referrer",
    src,
  });
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
