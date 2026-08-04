/**
 * Spec — the M3 half of the Spec tab: the structured (form ⇄ YAML) editor,
 * trust-tier badges, version history with pins and diffs, and the four
 * builders (new-spec wizard, grader builder, dataset builder, MCP
 * connectors).
 *
 * The M1 read (`views/spec.js`: YAML, issues, env-ref presence, badges)
 * stays where it is and is rendered above this.
 *
 * The one thing this screen must never let a user do accidentally: write a
 * HUMAN-OWNED path (permissions, the model roster, watchme, plugins, expose,
 * learning.sources, thredz, sandbox, transaction_policy) as if it were a
 * quality knob. Those fields render with the security-surface interstitial —
 * a credential-redacted diff plus a typed confirmation — or hand off to
 * `crewhaus propose`. The server enforces the same split, so the UI is the
 * explanation, never the gate.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderSpecEdit(root, _ctx) {
  renderPendingSurface(root, {
    group: "spec",
    title: "Spec editor, versions & builders",
    blurb:
      "Form ⇄ YAML editing with schema forms and undo, auto-tunable vs human-owned badges, version history with pins, promote/rollback and redacted diffs, plus the wizard, grader, dataset and MCP-connector builders.",
  });
}
