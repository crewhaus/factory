# cost-tracker templates

Copy-in starting points for operating model-cost automation on a schedule.
These are **templates, not active workflows** — nothing in this directory runs
from inside the factory repo.

- [`model-scan.yml`](model-scan.yml) — GitHub Actions cron template for
  **item 24, the scheduled model-market scan**. Copy it into your deployment
  repository's `.github/workflows/` and edit the `<PLACEHOLDER>` comments. On
  a schedule (default weekly) it runs:

  1. `crewhaus model-scan --dataset <data> --graders <graders>` — reads the
     cwd `crewhaus.yaml`'s `agent.model`, enumerates capability-compatible
     cheaper replacement models from the pricing table (add `--same-provider`
     to keep credentials + cache continuity; `--limit N` bounds the candidate
     count, default 6), evals current + each candidate on your dataset, and —
     when a candidate beats current on mean score at lower projected cost —
     writes a proposal (`patch.json`) + a benchmark matrix report.
  2. Opens a **proposal PR** for a human to review. Model fields are outside
     `OPTIMIZABLE_PATHS` by design, so nothing is auto-applied; the PR carries
     the `model-scan --write` CST edit (comment-preserving) for review.

  **Cost:** every scheduled run bills one eval per candidate plus one for the
  current model against `ANTHROPIC_API_KEY` (and any candidate provider's key
  when `--same-provider` is dropped). Keep the cron infrequent and the
  concurrency low (the template pins `EVAL_CONCURRENCY=1` for the 30k-TPM tier).

## Related CLI surfaces (schedulable, no template needed)

- `crewhaus doctor --models` — flags spec models missing from the pricing
  table (silently billed `$0`), pricing-table staleness, and known model
  sunsets. Runs offline; good as a fast pre-merge check.
- `crewhaus pricing sync --file <feed.json>` — installs a versioned pricing
  feed into `~/.crewhaus/pricing/`, from where the CLI's cost projections pick
  up the newest table without a code release. `crewhaus pricing show` prints
  the effective version + freshness.
