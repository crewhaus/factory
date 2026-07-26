# @crewhaus/feedback-distill

The human-rating half of the improvement flywheel, extracted so both the
toolchain and a **compiled daemon bundle** can run it.

- `feedback.ts` — the pure core: `FeedbackRecord`, turn derivation, multi-rater
  resolution (majority / mean / adjudication + Cohen's kappa), and `distill()`
  (rated turns → `Sample[]` + a synthesized `graders.yaml`). No IO, no imports.
- `redact.ts` — the shared sync PII/secret redactor every ingestion surface
  applies before free text can reach a dataset.
- `watermark.ts` — the `.crewhaus/feedback/.distill-state.json` trigger: "≥ N
  unprocessed ratings", idempotent and retry-safe.
- `collect.ts` — reads the transcripts + `.crewhaus/feedback/*.jsonl` into
  `{ turns, records, sessionCount, sessionsDirs }`. The transcript root is
  resolved the way the runtime resolves it (explicit `sessionsDirs` → a managed
  daemon's per-tenant `tenantsRootDir` → `CREWHAUS_SESSION_DIR` →
  `<cwd>/.crewhaus/sessions`), because reading the wrong root makes every
  rating look unmatchable.
- `review-queue.ts` — the B20 persistent human-review queue
  (`.crewhaus/review/queue.jsonl`) and its feeders. Lives here so the DAEMON
  step can enqueue B19 rater disagreements; `apps/cli/src/review-queue.ts`
  re-exports it unchanged.
- `janitor-step.ts` — `createDistillJanitorStep()`: a `@crewhaus/runtime-core`
  janitor step (same seam as the dream step) that distills accumulated ratings
  into a new version of the `<spec>-ratings` registry dataset on the daemon's
  own clock.

**Why the janitor step exists (D39).** `feedback.autoDistill` used to fire only
at `crewhaus run` teardown, so the shapes that actually generate ratings — the
channel bot's 👍/👎 reactions and the gateway's web UI — accumulated feedback
that nothing ever distilled. The daemon runs with credentials and base distill
is offline anyway, so the step is safe to run there.

**What the shared watermark does and does not guarantee.** The CLI teardown,
cron, and the daemon step share one `.distill-state.json`, so once any of them
lands a batch the others see nothing unprocessed and register nothing new. It
is not a lock: the read→distill→register→write sequence is unsynchronized, so
two runs that OVERLAP in the same harness dir can each register a version built
from the same ratings (each version is a self-contained full rebuild — no
feedback is lost or double-counted).

**Two zero-sample outcomes, deliberately different.** Ratings that exist but
match no transcript turn advance the watermark (their sessions are gone;
retrying is noise). A sweep that finds *no readable transcript at all* does
**not** — that is indistinguishable from a misconfigured session root, and
advancing there would mark every submitted rating processed forever.
