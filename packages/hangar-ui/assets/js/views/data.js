/**
 * Datasets — the dataset registry, its hygiene checks, and the growth verbs.
 *
 * Rules the screen carries rather than hides: a verify MISMATCH means
 * tampered (not stale); `<spec>-ratings` and `<spec>-regressions` are
 * auto-maintained and should not invite hand edits; the test split is locked
 * to the release flow with a visible burn count; and quarantined samples
 * appear beside the registry with their provenance, because a quarantined
 * sample nobody can see is a bug nobody can file.
 *
 * `dataset audit` (registry integrity) and `dataset lint` (canary
 * contamination across specs and few-shot pools) answer different questions
 * and get different buttons.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderData(root, _ctx) {
  renderPendingSurface(root, {
    group: "data",
    title: "Datasets",
    blurb:
      "Registry records with split sizes, provenance and verify status; saturation, freshness and test-split burn; the quarantine browser; and mine / synthesize / refresh-goldens with diff previews.",
  });
}
