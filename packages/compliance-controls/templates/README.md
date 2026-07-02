# compliance-controls templates

Copy-in starting points for operating Section 39 evidence collection on a
schedule. These are **templates, not active workflows** — nothing in this
directory runs from inside the factory repo.

- [`compliance-evidence.yml`](compliance-evidence.yml) — GitHub Actions cron
  template. Copy it into your deployment repository's `.github/workflows/`
  and edit the `<PLACEHOLDER>` comments. It chains the two schedulable CLI
  surfaces this package pairs with:

  1. `crewhaus audit verify [--dir <auditDir>] [--anchor file:<path>]` —
     tamper tripwire over the hash-chained audit log (exit 1 on any broken
     link, or on a requested-but-unconsultable anchor store).
  2. `crewhaus compliance evidence --all-frameworks --period current
     --fail-on-empty` — collects every registered framework for the current
     UTC quarter; `--fail-on-empty` makes the scheduled run exit 1 when any
     control gathered 0 records (without it, an empty control exits 0 with a
     warning naming the gap).

Bundles land at `.crewhaus/compliance/<framework>/<controlId>/<period>.json`;
re-verify them with this package's `verifyBundle` before presenting them as
authoritative evidence.
