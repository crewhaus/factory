# @crewhaus/watchme-store

Durable state for the **"watch me"** feature (`crewhaus watchme`) — the store
that outlives the 30-day transcript TTL. Three pieces: a per-harness store of
redacted session digests and judge verdicts, the global cross-harness
registry, and the pure quality→shadow-arm join behind
`watchme report --feed-routing`. Zero-dep by design: redaction is an injected
callback at every CLI append site — this package never imports PII detectors
and never inspects content.

## Per-harness store

`openWatchmeStore(rootDir, opts?)` roots the store at `<rootDir>/watchme`
(rootDir is the harness `.crewhaus` directory, the scoreboard convention) and
returns `{ dir, appendObservation, readObservations, readAggregates,
appendJudgment, readJudgments, compact, state, setState, windowKey,
acquireLock }`. Files (all mode `0600`):

- `observations.jsonl` — append-only `WatchmeObservation` digests plus
  `{agg:1}` Welford aggregate lines. **No TTL**: digests must stand alone
  after the transcript sweep (sessionId is provenance only, never a pointer).
  Appends are atomic small-line `O_APPEND` writes, so concurrent harness
  processes never lose each other's lines; malformed/torn lines are skipped
  on read. `compact()` folds raw lines into one Welford aggregate per
  `<specName>|<target>` key (mean/M2 of turn counts and pooled quality,
  summed token/cost/tool/feedback counters, per-intent counts) and lands
  write-then-rename; aggregates parallel-combine (Chan et al.) with later
  lines on the next compaction.
- `judgments.jsonl` — append-only `WatchmeJudgment` verdicts from the
  budgeted phase-2 judge. Machine signal stays OUT of the human feedback
  channel; the explicit `--emit-feedback` bridge converts, never this store.
- `state.json` — `WatchmeState` (watching flag, analysis watermark, consumed
  report windows, last report time), tmp+rename atomic. A missing or torn
  file reads as the default rather than wedging the schedule.
- `run.lock` — advisory single-writer lock in the dream-engine mold:
  `acquireLock()` is a try-once `O_EXCL` create returning a release fn or
  `undefined` on contention; a lock older than 30 s (holder crashed) is
  stolen and re-raced.

`windowKey(nowMs, everyMs)` is the report-window idempotency key —
`watchme:<spec>:<floor(nowMs/everyMs)>`, fixed epoch-anchored flooring so
every process computes the same window for the same clock. Pass `specName`
in the options; without it the harness directory basename stands in.

## Cross-harness registry

`openHarnessRegistry(globalRoot, opts?)` opens
`<globalRoot>/harnesses.json` (global root default `~/.crewhaus/watchme`;
the CLI overrides via `CREWHAUS_WATCHME_ROOT` or `--root`) and returns
`{ register, deregister, list }`. Entries are keyed by absolute harness dir;
`register` upserts (keeping `registeredAt`, refreshing `lastSeen`) and lands
tmp+rename atomic. `list()` prunes tolerantly: entries whose dir vanished are
dropped from the returned list and reported via `onWarn` — the file is only
rewritten by `register`/`deregister`, so reads never race writers.

## Quality join

`joinQualityToArms(decisions, quality)` joins durable route decisions to
delayed quality scores per `(sessionId, turnNumber)`; the decision's model
names the arm. Emitted rows carry SHADOW routeKeys — `"q:" + routeKey`, a
namespace the runtime router never mints or reads — so recording them
observes routing quality without steering it. Scores clamp to `[0, 1]` and
multiple scores for one turn average. Rewards are computed by the caller via
routing-store's `computeReward` with `obs.quality` set; this module stays
reward-free and fs-free.

## Exports

`openWatchmeStore`, `openHarnessRegistry`, `joinQualityToArms`, and the types
`WatchmeObservation`, `WatchmeAggregate`, `WatchmeJudgment`, `WatchmeState`,
`HarnessEntry`, `WatchmeStore`, `WatchmeStoreOptions`, `HarnessRegistry`,
`HarnessRegistryOptions`, `RouteDecision`, `TurnQuality`, `QualityArmRow`.
