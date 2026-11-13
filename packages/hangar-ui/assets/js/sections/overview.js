/**
 * Overview: how a harness is doing, and what here needs a person.
 *
 * A row is `{ id, label, describe, load, render, rest?, capture?, deep?,
 * hidden?, gate? }`, one per line, so an area adds its sub-view by appending
 * a row; the shell, the router and the gate read the table and need no edit.
 * `load` names its module by a literal path (the embed check follows
 * it), and `render` receives what `load` resolved, the root to draw into and
 * the view context.
 */

import { stack } from "./stack.js";

export const OVERVIEW = Object.freeze({
  id: "overview",
  label: "Overview",
  describe: "How this harness is doing, at a glance.",
  index: {
    load: () => Promise.all([import("../views/overview.js"), import("../views/health.js")]),
    render: async ([overview, health], root, ctx) => {
      await overview.renderOverview(root, ctx);
      // The explained score runs a preflight, so it loads on its own.
      await health.renderHealthCard(stack(root), ctx);
    },
  },
  // biome-ignore format: one row per line, so an area appends its row without touching the shell
  views: Object.freeze([
    { id: "needs-you", label: "Needs you", describe: "Alerts and suggestions for this harness, most urgent first.", load: () => import("../views/advisor.js"), render: (m, root, ctx) => m.renderAdvisor(root, ctx), rest: true },
  ]),
});
