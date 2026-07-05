# @crewhaus/routing-store

The durable reward scoreboard behind `agent.model_pool` **learned** routing —
the persistence layer that makes model selection improve the more a harness is
used (Section 17). Two pieces: a pure `computeReward` and a file-backed
per-`(routeKey, model)` scoreboard. The `PolicyRouter` in
[`@crewhaus/model-router`](../model-router#model-pool-agentmodel_pool) reads it
through an injected lookup; runtime-core owns the writes.

## Reward

`computeReward(observation, config?)` maps one observed model call to a scalar
in `[0, 1]` — higher is better: successful, cheap, fast. It is pure,
side-effect-free, and reproducible from the persisted observation, so the whole
learning objective lives here.

- A **failed** turn scores `0` outright, regardless of latency or cost —
  crediting a fast failure on the latency axis would let a frequently-failing
  model out-score a slower, reliable one.
- On **success**, two sub-scores combine (quality is fixed at 1), each in
  `[0, 1]`: `cost = costRef / (costRef + costUsd)` and
  `latency = latRef / (latRef + latencyMs)` (0.5 at the reference). The reward
  is their objective-weighted average; default objective is quality-dominant
  (`{ quality: 0.7, cost: 0.2, latency: 0.1 }`).
- The cost term is **dropped and reweighted** when `costUsd` is absent, so a run
  without cost accounting still learns on quality + latency.

## Scoreboard

`openScoreboard(rootDir, opts?)` opens (or creates) the store at
`<rootDir>/routing/arms.jsonl` and returns `{ score, record, snapshot, compact, path }`:

- `score(routeKey, model)` → the arm's rolled-up `ArmStats` (`n`, `meanReward`,
  `varReward`, `meanLatencyMs`, `meanCostUsd`, `costCount`) or `undefined`.
- `record(routeKey, model, reward, obs)` folds one observation into the arm and
  appends it.
- `snapshot()` returns every arm, sorted; `compact()` shrinks an append-heavy
  store to one aggregate line per arm.

Storage is an **append-only JSONL** (mode `0600`). Each line is either a delta
observation or an aggregate snapshot; aggregates fold in memory with Welford's
algorithm on load (mean/variance), and `compact()`'s aggregate lines
parallel-combine with any later deltas. Append-only + load-time replay is what
makes the store correct under **concurrent harness processes**: every run only
appends its own new observations (atomic small-line writes) and never rewrites
another run's data, so two harnesses learning into the same store cannot lose
each other's updates. A torn final line from a crashed writer is tolerated.

`ScoreReader` (just `score`) is the narrow interface handed to the
`PolicyRouter`, keeping model-router itself fs-free.

## CLI

`crewhaus route status` renders the scoreboard (per-band arms, best-per-bucket
starred — what a `learned` policy exploits); `crewhaus route reset` wipes it.

## Exports

`computeReward`, `DEFAULT_OBJECTIVE`, `openScoreboard`, and the types
`RouteObservation`, `RouteObjective`, `RewardConfig`, `ArmStats`, `Scoreboard`,
`ScoreboardOptions`, `ScoreReader`.
