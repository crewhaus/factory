/**
 * Security & audit — the audit chain, the egress review console, the PII
 * tuner, the justification console, the security corpus and sandbox checks,
 * the onchain safety panels, compliance evidence, retention, and the SLO
 * monitor.
 *
 * Honesty rules this screen is responsible for:
 *   - `audit verify` reports its DESIGNED limits (`externalAnchorChecked:
 *     false`) as facts, not as failures, and raw audit files are never
 *     shown — only rendered records.
 *   - an egress record carries lineage, not the outbound payload. Say so
 *     rather than rendering an empty body field.
 *   - retention sweep and purge run `--dry-run` FIRST and show the plan; the
 *     real run is a second, typed-confirm gesture, and the plan names what
 *     the pins saved.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderSecurity(root, _ctx) {
  renderPendingSurface(root, {
    group: "security",
    title: "Security & audit",
    blurb:
      "Audit records with verify, egress triage, the PII and onchain policy tuners with before/after previews, the justification console and its dry run, corpus and sandbox checks, compliance evidence, retention with dry-run-first, and the SLO ladder.",
  });
}
