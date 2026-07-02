# data-retention-engine templates

Copy-in starting points for operating Section 39 GDPR/TTL retention on a
schedule. These are **templates, not active workflows** — nothing in this
directory runs from inside the factory repo.

- [`retention-sweep.yml`](retention-sweep.yml) — GitHub Actions cron
  template. Copy it into your deployment repository's `.github/workflows/`
  and edit the `<PLACEHOLDER>` comments. It chains the schedulable CLI
  surfaces this package pairs with:

  1. `crewhaus retention sweep [--dry-run] [--dir <root>]` — enforce
     `.crewhaus/retention.json` (per-store `maxAgeDays`, session `pins`,
     deferring `auditWindows`) over the harness stores. Sessions expire by
     file mtime under session-store's own eviction rules; the hash-chained
     audit log is **never deleted** (export-only — any deletion breaks
     `verify()`'s cross-file chain). Real runs append a
     `retention_enforcement` evidence record to `.crewhaus/audit`.
  2. `crewhaus audit verify --dir .crewhaus/audit` — post-sweep tamper
     tripwire over the same chain the sweep just appended to.

  The companion verbs share the sweep's rules: `crewhaus retention export
  <outDir> [--since <date>]` (right-to-export — copies records out, raw)
  and `crewhaus retention purge [--before <date>]` (right-to-delete).
