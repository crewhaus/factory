/**
 * Quality: how well this harness does its job, and the cases and ratings it
 * is measured by. Rows as in `overview.js`.
 */

import { stack } from "./stack.js";

export const QUALITY = Object.freeze({
  id: "quality",
  label: "Quality",
  describe: "How well it does its job, and what it is measured against.",
  index: null,
  // biome-ignore format: one row per line, so an area appends its row without touching the shell
  views: Object.freeze([
    { id: "results", label: "Results", describe: "Evaluation runs, one case at a time, and the lab that compares them.", load: () => Promise.all([import("../views/evals.js"), import("../views/evals-lab.js")]), render: async ([evals, lab], root, ctx) => { await evals.renderEvals(root, ctx); await lab.renderEvalsLab(stack(root), ctx); }, capture: ["runId", "sampleId"] },
    { id: "datasets", label: "Datasets", describe: "The test cases it is measured against.", load: () => import("../views/data.js"), render: (m, root, ctx) => m.renderData(root, ctx), rest: true },
    { id: "feedback", label: "Feedback", describe: "Ratings and comments people left, and what was learned from them.", load: () => import("../views/feedback.js"), render: (m, root, ctx) => m.renderFeedback(root, ctx), rest: true, gate: { shapes: ["cli", "channel", "managed"], why: "this target's schema admits no feedback: block, so the ratings loop — reactions, distill sinks, advice — is not wired here", plain: "This kind of harness does not collect feedback." } },
  ]),
});
