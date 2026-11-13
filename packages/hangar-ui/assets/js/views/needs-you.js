/**
 * Needs you (`#/home/needs-you`): everything waiting on a person, in one
 * place. All stacks the approvals inbox, the review queue and the fleet
 * advice, each in its own section under its own heading; `?type=` shows one.
 * Each section loads and fails on its own, and each list keeps the keys it
 * has always had while it has focus.
 */

import { NEEDS_YOU_FILTERS } from "../destinations.js";
import { clear, el } from "../dom.js";
import { hrefFleet } from "../router.js";
import { emptyFor } from "../ui/empty.js";
import { renderAdvisorBoard } from "./advisor.js";
import { renderApprovals } from "./approvals.js";
import { renderReview } from "./review.js";

/** Filter id → the screen that draws it. */
const DRAW = {
  approvals: renderApprovals,
  review: renderReview,
  advice: renderAdvisorBoard,
};

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
  const shown =
    current === null ? NEEDS_YOU_FILTERS : NEEDS_YOU_FILTERS.filter((f) => f.id === current);
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
