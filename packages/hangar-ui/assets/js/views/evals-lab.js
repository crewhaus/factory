/**
 * Evals — the M3 half of the Evals tab: the typed launcher, matrix runs, CI
 * suites, trends, the sample-size planner, judge calibration, grader
 * quality, redteam, coverage, the drift sentinel, voice replays, the
 * optimizer, the flywheel, experiments, and the annotation → distill join.
 *
 * The M1/M2 surface (`views/evals.js`: run history, drill-down, baselines)
 * stays where it is and is rendered above this.
 *
 * Two rendering rules this screen must not break, because both turn a
 * measurement into a false alarm: a PARTIAL run renders deflated and is
 * never charted as a regression, and a REPLAYED run is badged not-live.
 * Trends split agent spend from judge spend — the judge frequently costs
 * more than the thing it is judging.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderEvalsLab(root, _ctx) {
  renderPendingSurface(root, {
    group: "evals",
    title: "Eval lab",
    blurb:
      "Launcher with typed flags and resume, matrix cells with classified crash reasons, CI suites and floors, trends with judge-vs-agent spend, judge calibration, grader cards, redteam, coverage, sentinel, the optimizer and experiments.",
  });
}
