/**
 * Inspect — the browsers that make "inspect ALL captured data" literally
 * true: scope-audit, the prompt-cache rotation record, logs, skills,
 * commands, preferences, settings.json, knowledge.json, identity.json,
 * meta.json and environments.json — plus a generic raw browser for anything
 * unrecognized.
 *
 * Three subtrees are deliberately unreachable and the screen says so rather
 * than showing an empty folder: `secrets/`, the raw audit files (rendered
 * only as verified records on the Security tab), and `.env` (presence
 * booleans only, on the Credentials tab).
 *
 * `identity.json` displays the Ed25519 FINGERPRINT — the one that stamps
 * every trace envelope. Everything here is read-only except `settings.json`,
 * which is human-owned configuration and therefore carries the same redacted
 * diff plus typed confirmation the spec's human-owned paths do.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderInspect(root, _ctx) {
  renderPendingSurface(root, {
    group: "inspect",
    title: "Inspect",
    blurb:
      "Dedicated browsers for every remaining .crewhaus store, a generic read-only raw browser as the fallback, and the settings.json editor behind the human-owned gate.",
  });
}
