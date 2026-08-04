/**
 * Feedback — the growth loops: the ratings browser with the distill
 * watermark, the few-shot pool, FAQ distill, lessons, the advice feed, and
 * channel reaction state. Plus the fleet-wide rollup screen, which answers
 * "which harnesses have enough feedback to distill".
 *
 * The review QUEUE and its adjudication are the M2 screen (`views/review.js`)
 * and stay there; this is what the ratings turn INTO.
 *
 * The advice feed is ADVISORY. Rendering a proposed SpecPatch is not
 * applying it — apply is a separate gesture that goes back through the spec
 * write path, and a non-optimizable path routes to `crewhaus propose`.
 */

import { renderPendingSurface } from "../pending.js";

/** The per-harness Feedback tab. */
export async function renderFeedback(root, _ctx) {
  renderPendingSurface(root, {
    group: "feedback",
    title: "Feedback loops",
    blurb:
      "Ratings folded with the distill watermark and unprocessed count, the golden few-shot pool, the auto-discovered FAQ skill, lessons and preferences, the advisory SpecPatch feed, and channel reaction state with its sessionKey caveat.",
  });
}

/** The fleet-wide rollup (`#/feedback`). */
export async function renderFeedbackBoard(root) {
  renderPendingSurface(root, {
    group: "feedback",
    title: "Fleet feedback",
    blurb:
      "Ratings volume and balance per harness with each one's unprocessed count — the single screen that says who is distill-ready.",
  });
}
