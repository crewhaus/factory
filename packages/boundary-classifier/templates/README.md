# boundary-classifier templates

Copy-in starting points for operating the item 49 scope-audit drift watch in
CI. These are **templates, not active workflows** — nothing in this directory
runs from inside the factory repo.

Why this package hosts the template: the drift watch exists to enforce THIS
package's single-chokepoint invariant. The `boundary-classifier` header
declares that every cross-trust-domain transition must route through
`classifyBoundary`, and that "a new boundary that re-implements
classification inline (or skips it) is a security regression, not a perf
optimisation" — but until item 49, only the six canonical boundary sites
were checked, print-only, run-and-forget. The drift watch turns that
invariant into a baselined CI gate, so the workflow that wires it up lives
next to the invariant it protects (following the `templates/` convention
established by `compliance-controls` and `data-retention-engine`).

- [`scope-audit-drift.yml`](scope-audit-drift.yml) — GitHub Actions
  PR-trigger template. Copy it into the factory-shaped repository's
  `.github/workflows/` (the audit reads `packages/*/src`, so it applies to
  the factory repo, forks, and vendored monorepos with the same layout) and
  edit the `<PLACEHOLDER>` comments. It runs:

  ```
  crewhaus doctor --philosophy-alignment --baseline
  ```

  on every PR that touches `packages/**` or a spec, which:

  1. Re-audits the three pillars (boundary sites, tool scopes, package
     presence) **plus** the boundary-drift detector — a conservative scan
     for cross-trust ingress signals (raw MCP SDK imports, inbound channel
     transports, federation peer payloads, chain content decoders) in
     packages that never reference the classification fabric.
  2. Diffs the findings (by stable id: hash of class + file + symbol)
     against the last accepted baseline at
     `.crewhaus/scope-audit/baseline.json`, and exits non-zero **only on
     NEW findings** — legacy accepted findings never block, so the gate can
     be adopted on a repo with known, deliberate downstream-classification
     transports.

  To (re)accept the baseline after reviewing findings:

  ```
  crewhaus doctor --philosophy-alignment --accept-baseline
  git add -f .crewhaus/scope-audit/baseline.json   # -f: .crewhaus/ is gitignored
  ```

  **The baseline must be committed.** The factory `.gitignore` excludes
  `.crewhaus/` (runtime artifacts), so the accepted baseline needs a
  force-add — that is deliberate: accepting findings is a reviewed,
  history-tracked act, not a runtime side effect. A PR whose only change is
  the baseline file IS the review surface for newly accepted findings.
