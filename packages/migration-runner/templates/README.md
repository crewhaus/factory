# migration-runner templates

Copy-in starting points for keeping a harness spec current with the CLI's spec
schema on a schedule. These are **templates, not active workflows** — nothing
in this directory runs from inside the factory repo.

- [`crewhaus-upgrade.yml`](crewhaus-upgrade.yml) — GitHub Actions cron template
  (item 43). Copy it into your harness repository's `.github/workflows/` and
  edit the `<PLACEHOLDER>` comments. On a schedule it:

  1. installs the latest `crewhaus`,
  2. runs `crewhaus upgrade crewhaus.yaml --dry-run` to detect spec version
     drift against the CLI's current spec version,
  3. when a migration is available, applies it with `--write` (each migrated
     spec is validated with `parseSpec` before it can be written), and
  4. opens a pull request with the migrated spec for human review.

  Accepted migrations arrive as PRs — nothing is committed to the default
  branch automatically.

The schedule (not on-push) is deliberate: a spec upgrade is driven by a **new
CLI version shipping a migration**, not by a change to your repo. Re-run
`crewhaus upgrade --dry-run` locally to reproduce a PR's diff.
