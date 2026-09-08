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

### Promotion — the one way out of an observe-only lane (0.6.0 §6.3)

`q:` and `shadow:` lanes are namespaces the runtime router never mints and
never reads, so recording into them observes quality without steering a single
live decision — and committee/shadow **member** arms never fold into live arms
on their own. `promoteLanes(rootDir, {dryRun?})` is the sanctioned fold, driven
by `crewhaus route promote`, which refuses unless a routed (`as-declared`) eval
with a pinned seed and a warm frozen arm snapshot passed its baseline gate and
writes a `routing_promotion` audit record.

The fold is a single-writer maintenance op, the same class as `compact()`:
every not-yet-promoted lane line is folded under the live routeKey (the
prefix stripped, stamped `pr: <lane key>`) and the original is stamped
`pm: 1`. So the lane keeps its own history — a promoted audition stays visible
in `route status` — and promotion is idempotent: re-running it folds nothing,
and folds only the delta once the lane has accumulated more. `pm` / `pr` are
unknown fields to every reader, 0.5.x included.

**The two lanes fold differently, because they are not the same evidence.**
A promotion must never count one measurement twice (§7.10's lower bound reads
`n` as independent evidence) and never mix instruments.

- `shadow:` is new evidence for a candidate that never served live, so its
  line carries **whole** (`carried: "full"` — reward, latency, cost, quality).
  Its `primary` side does not: that arm already recorded the turn live, and
  its lane quality is a pairwise blind verdict (0 / 0.5 / 1) rather than an
  absolute judged score. Both sides are stamped `at` (`SHADOW_LANE_SHADOW_ARM`
  / `SHADOW_LANE_PRIMARY_ARM`), which is the only thing that distinguishes
  them; the primary line stays in the lane.
- `q:` re-observes turns the live arm already recorded — the offline join keys
  on the same `(routeKey, arm)` pair the runtime used at call time — so it
  back-fills the judged quality alone (`carried: "quality"`): an `n: 0`
  aggregate carrying `qs`/`qn`/`qm2`, which adds no second reward observation
  and does not double the arm's latency or cost sums.

The folded copy carries **no `pf`**. Lineage covers `reward.quality_source`,
and the documented workflow is `shadow` → `route promote` →
`quality_source: promoted`; a copy stamped with the lane's lineage would be
discarded by that very flip, permanently. An unstamped line is always kept —
the honest semantics for a gated, operator-authorized carry across a lineage
boundary.

`route freeze` stops promotion like every other write to an arm: `promoteLanes`
refuses under a marker and reports `frozenPolicyVersion`, and `crewhaus route
promote` refuses before it even resolves the eval gate.

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
(`--clear` lifts the pin); `crewhaus route promote [--gate] [--dry-run]` folds
the observe-only lanes into live arms once a routed eval authorizes it.

## Exports

`computeReward`, `DEFAULT_OBJECTIVE`, `openScoreboard`, `freezeScoreboard`,
`readRouteFreeze`, `writeRouteFreeze`, `clearRouteFreeze`, `routeFreezePath`,
`readRoutingPriorsRaw`, `routingPriorsPath`, the lane helpers, `promoteLanes`,
`liveRouteKeyOf`, and the types `RouteObservation`, `RouteObjective`,
`RewardConfig`, `ArmStats`, `Scoreboard`, `ScoreboardOptions`, `ScoreReader`,
`RouteFreeze`, `LanePromotion`, `PromoteOptions`, `PromoteResult`,
`PromotedCarry`.
