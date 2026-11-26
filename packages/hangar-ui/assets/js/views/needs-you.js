/**
 * Needs you (`#/home/needs-you`): everything waiting on a person, in one
 * place. All is Home's inbox, one list in three bands across the harnesses
 * you can see, where items are decided (`views/attention.js`; `?kind=` shows
 * one kind); `?type=advice` opens the fleet advice. Each section loads and
 * fails on its own, and a list keeps its own keys while it has focus.
 */

import { NEEDS_YOU_FILTERS } from "../destinations.js";
import { clear, el } from "../dom.js";
import { hrefFleet } from "../router.js";
import { emptyFor } from "../ui/empty.js";
import { renderAdvisorBoard } from "./advisor.js";
import { renderAttention } from "./attention.js";

/** Filter id → the screen that draws it; `all` is the inbox. */
const DRAW = {
  all: renderAttention,
  advice: renderAdvisorBoard,
};

/** The sections a filter shows: the inbox for All, else that one screen. Pure. */
export function needsYouSections(current) {
  return current === null
    ? [{ id: "all", label: "Everything waiting on you" }]
    : NEEDS_YOU_FILTERS.filter((f) => f.id === current);
}

/** The filter a route asks for, or null for All. Pure. */
export function needsYouFilter(route) {
  const type = route?.query?.type;
  return NEEDS_YOU_FILTERS.some((f) => f.id === type) ? type : null;
}

/** The filter links: All, then one per filter, the current one marked. */
function filterNav(current) {
  const link = (label, id) => {
    const here = current === id;
    return el("li", null, [
      el("a", {
        class: `tab${here ? " active" : ""}`,
        href: hrefFleet("home", "needs-you", id === null ? null : { type: id }),
        "aria-current": here ? "page" : null,
        text: label,
      }),
    ]);
  };
  return el("nav", { class: "page-nav", "aria-label": "Show" }, [
    el("ul", { class: "tabs page-nav-list" }, [
      link("All", null),
      ...NEEDS_YOU_FILTERS.map((f) => link(f.label, f.id)),
    ]),
  ]);
}

export async function renderNeedsYou(root, ctx = {}) {
  const current = needsYouFilter(ctx.route);
  const shown = needsYouSections(current);
  clear(root).appendChild(filterNav(current));
  const hosts = shown.map((filter) => {
    const headingId = `needs-you-${filter.id}`;
    const host = el("div");
    root.appendChild(
      el("section", { class: "needs-you-section", "aria-labelledby": headingId }, [
        el("h2", { class: "needs-you-heading", id: headingId, text: filter.label }),
        host,
      ]),
    );
    return { filter, host };
  });
  await Promise.all(
    hosts.map(async ({ filter, host }) => {
      try {
        await DRAW[filter.id](host, ctx);
      } catch (err) {
        if (ctx.signal?.aborted) return;
        clear(host).appendChild(
          emptyFor({
            cause: "connection-failed",
            subject: `the ${filter.label.toLowerCase()} list`,
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }),
  );
}
