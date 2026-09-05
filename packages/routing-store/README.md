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

### Arm identity, scoped keys and the `v:2` line (0.6.0)

- **Arm identity** (`m`) is the `models:` profile name when the candidate is a
  profile, else the spec model string. No migration: unprofiled arms keep
  their key, profiled arms are new (`upgrade --hoist-models --rewrite-arms`
  re-keys deliberately).
- **Scoped route keys**: a pool on a workflow step, crew role, graph node or
  sub-agent records under `<scope>/<band>` (`support/hard`); the learned policy
  backs off to the unscoped `<band>` arm while the scoped one is
  under-sampled, so pre-0.6.0 history keeps steering. Observe-only lanes sit
  beside them: `q:<key>` (offline join) and `shadow:<scope>/<band>` (audition).
- **`v:2` delta line** — `{v:2,k,m,r,s,l,t,c?,q?,st?,sg?,at?,wp?,pv?,sc?,h?,pf?}`:
  `q` judged quality, `st` stage, `sg` strategy, `at` attributedTo, `wp`
  wouldPass, `pv` policyVersion, `sc` scope, `h` harness, `pf` the arm's
  profile-lineage fingerprint. A 0.5.x reader folds it as a plain delta. A
  plain observation is still written as the exact `v:1` line.
- **Quality** folds with Welford (`meanQuality`, `varQuality`, `qualityCount`
  on `ArmStats`); `compact()` carries `qs`/`qn`/`qm2`/`ug`/`pf` so the floor's
  lower bound survives compaction. `pv`/`sc`/`h` are per-line provenance and
  are not aggregated (`sc` is already the key prefix).
- **Lineage** (`reward.reset_on_profile_change`, default on): open the store
  with `lineage: { <armId>: <fingerprint> }` and a line whose `pf` differs from
  the arm's current fingerprint is skipped on load — history from a profile
  that changed under the same arm id. Lines with no `pf` are always kept.

### Routing-state files beside the arms

- `routing/priors.json` — eval-seeded priors (`readRoutingPriorsRaw`; validated
  by `@crewhaus/model-plan`'s `loadPriors`).
- `routing/freeze.json` — `crewhaus route freeze <policyVersion>`
  (`readRouteFreeze` / `writeRouteFreeze` / `clearRouteFreeze`); while present
  the runtime wraps the scoreboard in `freezeScoreboard` (reads pass through,
  writes are dropped) and reports the frozen `policyVersion`.

## CLI

`crewhaus route status` renders the scoreboard (per-band arms, best-per-bucket
starred — what a `learned` policy exploits); `crewhaus route reset` wipes it;
`crewhaus route freeze <policyVersion>` pins the learned policy
(`--clear` lifts the pin).

## Exports

`computeReward`, `DEFAULT_OBJECTIVE`, `openScoreboard`, `freezeScoreboard`,
`readRouteFreeze`, `writeRouteFreeze`, `clearRouteFreeze`, `routeFreezePath`,
`readRoutingPriorsRaw`, `routingPriorsPath`, the lane helpers, and the types
`RouteObservation`, `RouteObjective`, `RewardConfig`, `ArmStats`, `Scoreboard`,
`ScoreboardOptions`, `ScoreReader`, `RouteFreeze`.
