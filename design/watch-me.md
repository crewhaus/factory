# "Watch me" — observe a harness's interactions and learn from them

**Status:** design doc → RFC body (`.github/ISSUE_TEMPLATE/rfc.yml`) per CONTRIBUTING §3; filed before the implementation PR opens.
**Scope:** the `watchme:` spec block (cli/channel/managed), the live trace-tap capture layer, the `@crewhaus/watchme-store` package, the `crewhaus watchme start|stop|status|report|intents|synthesize|publish` command family, real factuality graders, the `RouteObservation.quality` reward field, and the shadow-routing/feedback opt-in bridges.
**Feature name vs code token:** the user-facing name is **"watch me"**; the code token is **`watchme`** everywhere (command `crewhaus watchme <action>`, spec block `watchme:`, package `@crewhaus/watchme-store`). `watch.ts` / `--watch` / `observe*` are all taken — the fs-watch controller, recompile-on-change, and the G26 `observability:` block respectively.

This design was produced by generating three independent architectures, judging them from three lenses, and folding the judges' mandated fixes into the consensus-best backbone (thin composition layer, one new zero-dep package, analysis as `apps/cli` pure modules, in-place grader de-stubbing). Every seam it plugs into was re-verified against the tree before implementation.

---

## 1. Motivation and the three watching scopes

A CrewHaus harness already produces a rich durable record of its own behavior: the session `.jsonl` event log, the default-on advisor mirrors (`cost_accrual`, `model_meta`, `model_route`, `tool_stats`), ratings and feedback records, and — for pooled-model harnesses — a routing scoreboard. Nothing reads that record *as a whole*. Nobody can answer, from data: "how good are this agent's answers, is it staying grounded in its evidence, is it using a more expensive model than its traffic needs, what do people actually ask it, and did it forget what it was told last week?"

"Watch me" closes that gap. You point it at a harness (`crewhaus watchme start`, or a `watchme:` block in the spec) and it (a) taps the live trace bus into a durable, metadata-grade sibling file, and (b) post-hoc distills everything the harness has recorded into a five-section report: response quality, continuity, factuality, model usage, and counterfactual cheaper-model analysis — plus a recurring-intents digest, an optimizer-consumable suggestions file, a few-shot candidate pool, and (on request) a synthesized draft spec that mimics the observed usage.

Three watching scopes, deliberately nested:

- **(a) One harness.** Capture plus a per-harness report, entirely inside the harness's own `.crewhaus/` state dir (standalone-harness convention). This is the default and requires nothing global.
- **(b) One user across agents.** `watchme.scope: user` (or `watchme start` on each harness) registers the harness in a global registry at `~/.crewhaus/watchme/harnesses.json`; `watchme report --all` and `watchme intents --all` roll up across every registered harness, harness-tagged.
- **(c) Agents co-learning.** `watchme publish` (auto-invoked at report time when `watchme.share: true`) distills redacted findings into wiki articles under `watchme/*` slugs; when Thredz is configured with shared visibility, peers' articles are RECALLED by `report --all` — agentName-labeled, confidence-weighted, and classified under the `memory` TrustOrigin like every other recalled body.

Analysis works **retroactively** on any harness with history: the default-on advisor mirrors are enough for `capture: "mirrors"`-grade reports, so `watchme start` runs an immediate deterministic backfill digest and delivers value on day one. The `.events.jsonl` sibling upgrades attribution from ordered to exact (§6) from that point forward.

Everything analytical is model-free and replayable except one budgeted judge phase (default budget 0 — i.e. off), and nothing auto-applies: model conclusions are proposal artifacts, synthesized specs are new files, and the model roster and existing specs are never touched.

## 2. Trust-boundary analysis

Watch-me ingests transcripts, and transcripts are attacker-influenceable: user messages, tool results, and fetched content all flow through the sessions this feature reads. The design treats that as a first-class threat, not a footnote.

**Quality signals never come from model self-claims.** A score can enter the system through exactly three doors:

1. **Deterministic graders** — the continuity graders and the new claim-vs-evidence factuality graders (§10 of the implementation plan) are pure text analysis over the transcript; they cannot be talked into a verdict, only fed different text, and their inputs/outputs are replayable.
2. **The sentinel-hardened judge** — the phase-2 judge reuses `buildJudgePrompt` verbatim, the injection-hardened prompt builder the eval stack already ships. Its evidence trail is reconstructed by scanning the judge session's OWN event log (the `scanDreamSessionEvidence` pattern), never by trusting what the judge model says it did. It is budget-capped, sampled, and refuses to run on unpriced models (`unpricedModelReason`), so an adversary cannot inflate spend either.
3. **User ratings** — the existing human feedback channel, joined per `(sessionId, turnNumber)`.

**Machine and human signal are physically separated.** Judge verdicts land in watchme's own `judgments.jsonl`, not in the feedback flywheel; the routing feed writes only shadow `q:*` arms the runtime router never mints or reads. Both bridges into live systems are explicit per-invocation CLI opt-ins (`--emit-feedback`, `--feed-routing`) — see §9.

**The observation store is redacted at the boundary.** Every append into `observations.jsonl`, every report renderer, and every published wiki article passes through the injected PII redactor (`createPiiRedactor` with `SYNTHESIZE_PII_DETECTORS`) before persistence. `@crewhaus/watchme-store` itself never imports PII detectors — redaction is an injected callback at every CLI append site, so the store cannot silently grow an unredacted path. A test pins that runtime-constructed secret shapes never survive into observations, reports, or articles.

**The capture sibling is metadata-grade by construction** (§7): it contains only bus-only event kinds, so transcript content stays solely in the session `.jsonl` under the existing TTL/permission regime.

**Sharing crosses the harness boundary only on explicit configuration.** `watchme.share` defaults to false, is excluded from `OPTIMIZABLE_PATHS` (§4), and a cross-field spec issue fires when it contradicts an explicit `thredz.visibility: private`. Recalled peer articles inherit the `memory` TrustOrigin classification — co-learning input is treated as untrusted memory, not as instructions.

**Nothing auto-applies.** Synthesized specs are new files requiring `--force` to overwrite; counterfactual model recommendations carry a machine-consumable `verify: {argv}` handoff to `crewhaus model right-size` instead of patching the roster; suggestions flow through the eval-gated `optimize --from-advice` path like every other advice source.

## 3. Architecture

Four layers, composed left to right:

```
CAPTURE (live, in-process)            DURABLE STORE                ANALYSIS (post-hoc)                OUTPUTS
attachWatchmeCapture()          .crewhaus/watchme/            crewhaus watchme report            report.json/.md (5 sections)
runtime-core subscriber,   -->  observations.jsonl       -->  phase 1: deterministic        -->  suggestions.json + fewshot pool
CREWHAUS_WATCHME=1-gated        judgments.jsonl               (deriveTurns, continuity,          synthesized/<name>.yaml (proposal)
writes bus-only kinds to        state.json + run.lock         factuality, counterfactual,        shadow q:* arms (--feed-routing)
sessions/<id>.events.jsonl      ~/.crewhaus/watchme/          intents, joins)                    FeedbackRecords (--emit-feedback)
(sibling sessions export        harnesses.json (registry)     phase 2: ONE budgeted judge        Thredz wiki articles (publish)
already reads)                                                session (priced-model-only)
```

- **Capture** can never crash a run (the trace bus swallows subscriber failures) and never analyzes in-loop. Hooks are trigger-only in this codebase and are not used at all — the durable files are the data plane.
- **Store** is the one new package, `@crewhaus/watchme-store`: zero-dep, routing-store skeleton clone, owning durable watch-me state independent of the 30-day transcript TTL plus the cross-harness registry. All analytical logic stays in `apps/cli` pure modules (`watchme.ts`, `watchme-report.ts`, `watchme-synthesize.ts` — the `watch.ts`/`feedback.ts` precedent), with fs/clock/model seams injected.
- **Analysis** is phase 1 (deterministic, idempotent, run under `run.lock` with window idempotency) plus an optional phase 2 (one budgeted judge session, only when `judge.budget_usd > 0` and the judge model is priced; `--no-model` overrides). Model spend happens in exactly two bounded places: that judge phase and the optional `synthesize --interactive` interview.
- **Outputs** are all proposal artifacts. The report renders five sections (response quality, continuity, factuality, model usage with exact-vs-ordered attribution noted, counterfactual table with evidence tiers and verify argvs, recurring intents) and writes `suggestions.json` in the `buildSuggestionsFile` format (consumable by the eval-gated `optimize --from-advice`) and `fewshot-candidates.json` in the `harvestFewShot` format — intents actuate only through the sanctioned gates.

The command surface: `watchme start|stop|status` manage the watching state and registry; `watchme report [--all]` runs the analysis; `watchme intents [--all]` cuts the intents digest standalone; `watchme synthesize` drafts a validated mimic spec; `watchme publish` shares distilled findings. Every flag is declared; anything that slips during implementation gets the reserved-flag pattern (a declared flag that dies "not yet implemented; see design/watch-me.md §X"), never a silently absent flag.

## 4. Spec surface and the OPTIMIZABLE_PATHS exclusions

The block, on the three RING_TARGET interactive-loop shapes (cli, channel, managed; research/crew are a named deferral — strict schemas reject the key loudly there):

```yaml
watchme:
  enabled: true
  capture: full            # full | mirrors
  judge:                   # absent = deterministic-only (zero model spend)
    model: claude-haiku-4-5
    sample_rate: 0.15
    budget_usd: 0
  scope: harness           # harness | user
  share: false             # publish redacted findings to wiki/Thredz
```

- `capture: full` writes the `.events.jsonl` trace sibling; `capture: mirrors` relies on the default-on advisor mirrors only (retro-analysis grade, no extra file).
- `judge.budget_usd` defaults to 0, so a bare `watchme: {enabled: true}` spends nothing on models, ever. There is no budget-without-model invariant because `judge.model` has a default — a budgeted judge always resolves.
- `scope: user` additionally registers the harness in the global registry at run time.
- One cross-field invariant, appended at the END of `crossFieldIssues()` (append-only ordering preserved): `watchme.share: true` while the spec declares a `thredz:` OBJECT with an EXPLICIT `visibility: "private"` is an issue ("watchme.share publishes co-learning articles; thredz.visibility: private blocks cross-agent sharing — set visibility: shared or drop watchme.share"). An absent `thredz:` block is fine — publish degrades to the local wiki store, a feature, not an error. Boolean/string `thredz:` shorthands (default-private) get NO issue in v1: publishing then lands private-visibility articles, which is legal single-agent behavior; this paragraph is the documentation of that choice.

Lowering: `IrWatchme` on the cli/channel/managed IR nodes beside `observability`, threaded through `lower()` with spread-return-`{}` discipline so empty specs compile byte-identically. The managed target emits an `accepted-but-unwired` CompileWarning in v1 (the sanctioned honest-vaporware channel); cli and channel are actually wired (env stamping at the same junctions the G26 stamps use).

### Knob-by-knob OPTIMIZABLE_PATHS exclusions

**Every `watchme.*` path is excluded from `OPTIMIZABLE_PATHS`** — the optimizer may never patch any of them. A comment block beside `OPTIMIZABLE_PATHS` in `packages/spec-patch/src/index.ts` mirrors this list; the whitelist guard test is untouched because no entries are added. Rationale, knob by knob:

- **`watchme.enabled` / `watchme.capture`** — the observer must not be tuned by the loop it observes. Letting the optimization loop toggle its own observation channel is self-referential optimization (an optimizer that learns to blind its own critic), and capture fidelity is additionally a consent/data-plane posture the human set deliberately.
- **`watchme.judge.model`** — the model roster is never auto-patched. That is a repo-wide invariant (the same reason counterfactual analysis hands off to `model right-size` instead of editing the roster).
- **`watchme.judge.sample_rate` / `watchme.judge.budget_usd`** — spend-class knobs, human-only. `sample_rate` multiplies judge calls, so an "optimization" that raises it directly raises the bill; two of three design judges independently rejected whitelisting even `sample_rate`.
- **`watchme.scope` / `watchme.share`** — privacy/trust-boundary knobs. `share` crosses the harness boundary to Thredz; `scope` enrolls the harness in a global registry. Neither is a quality lever the optimizer has any business moving.

### The paired advise rule (text-only, consistent with the exclusions)

`ruleWatchmeCoverage`, appended to `ADVICE_RULES`: when a harness has ≥ 10 sessions and the spec has no `watchme:` block, emit an advice-text finding recommending `crewhaus watchme start` / adding the block; when watchme IS active and the digest shows a persistent low-satisfaction intent cluster, emit advice text pointing at `watchme report`. No SpecPatch is attached — there is no whitelisted path to patch — and the rule degrades to zero findings on old-vintage logs.

## 5. Reconciliation with the shipped G26 `observability:` block

The G26 `observability:` block exists and ships today (`observabilityBlock` in `packages/spec`, attached to cli/channel/managed/crew; `IrObservability` in `packages/ir`). Every "when G26 lands" deferral in earlier drafts of this feature is stale; the reconciliation is decided now:

**`watchme:` is a SIBLING block, not an `observability:` sub-key.** `observability:` controls generic telemetry subscribers — ring buffer, printers, metrics, cost, alerts, otel. Watch-me is a learning feature with spec-synthesis outputs and its own store. Their interactions are exactly two:

- The capture subscriber is **independent of `observability.trace.level`** — that knob controls the ring buffer and printers only; the trace bus always exists and capture subscribes regardless. Turning trace output down does not blind watch-me, and turning watch-me off does not touch tracing.
- Watchme env stamping is added **at the same junctions the G26 stamps already use** — `applyRunObservabilityEnv` for the `crewhaus run` interpreter path, and target-channel-bot's existing boot-time env-stamp emitter for compiled channel bundles — so precedence semantics (spec vs ambient env) stay in one place per path. target-cli has no G26 env emitter today; it gets a minimal watchme-only stamp with a comment noting the interpreter/codegen sync. The resolver precedence is: ambient `CREWHAUS_WATCHME` wins, else the harness state file's watching flag, else the spec (`enabled && capture === "full"`).

A comment in `packages/runtime-core/src/observability.ts` records this decision in-code; this section supersedes all earlier "when G26 lands" language. If a future G26 revision wants to own trace persistence, `resolveWatchmeEnv` is the single junction to reconcile at (deferral 9, §10).

## 6. The turnNumber contract and joinConfidence

Every join in this feature — ratings to turns, judgments to turns, route decisions to quality — keys on `(sessionId, turnNumber)`. There is exactly ONE turnNumber authority: `deriveTurns` in `apps/cli/src/feedback.ts`, with its documented `synthetic: true` exclusion. The report module takes `deriveTurns` as an injected dependency rather than reimplementing turn segmentation, and a parity property test pins that the deriveTurns count equals the envelope-based count on fixtures including synthetic and tool_result-only turns.

Per-turn model/cost attribution has two grades, recorded per observation as `joinConfidence`:

- **`"exact"`** — the `.events.jsonl` sibling is present, so `model_response` events carry envelope `turnNumber` and each turn's model, usage, and cost attribute precisely.
- **`"ordered"`** — mirrors-only history (pre-watchme sessions, or `capture: mirrors`): durable `cost_accrual`/`model_meta` lines are correlated by insertion order, anchored by the turnNumber-carrying `model_route` lines. Ordered-confidence data is aggregated at SESSION level only, never per-turn — a deliberate honesty rule so that ordering ambiguity can never mislabel which turn a cost or model belongs to.

The routing feed (§9) and the judge sample only ever join on exact-or-rated turns; counterfactual totals work at whichever grade the session supports and say so in the report ("exact-vs-ordered attribution noted" is a rendered column, not an internal flag).

## 7. Capture kind-partition (mirrored vs bus-only) and PII posture

The TraceEventBus carries CONTENT, not just metadata: `user_message`/`assistant_message`/`tool_result` events flow over the same bus as the metadata-shaped `model_request`/`model_response`. A naive "persist the bus" would therefore create a second transcript store outside the session TTL. The capture subscriber avoids that by construction with a strict kind-partition:

- **Skipped: ephemeral kinds** — `model_stream_token`, `tool_stream_chunk`.
- **Skipped: mirrored kinds** — every kind the event log already persists durably to the session `.jsonl` (`user_message`, `assistant_message`, `tool_use`, `tool_result`, `error`, `run_failed`, `cost_accrual`, `model_meta`, `model_route`, `tool_stats`, `recovery`, `permission`, `compaction`, `context_evicted`, `user_feedback`, `mcp_stats`, …). A unit test pins ZERO kind-overlap between the two files on a fixture run, so the partition cannot silently drift.
- **Written: bus-only kinds** — `model_request`, `model_response`, `model_tier_route`, `permission_decision`, `eval_graded`, `judge_verdict`, `mcp_call_end`, span events, … — one JSON line each (envelope included: turnNumber/agentId/traceId) appended to `sessions/<id>.events.jsonl`, mode 0600, PIPE_BUF-atomic appends.

Consequences: the sibling is **metadata-grade by construction** — transcript content stays solely in the session `.jsonl` (the sole content store), so the sibling needs no transcript-grade redaction, carries exact per-turn model attribution via envelope turnNumber, and upgrades `sessions export --format trajectories` for free (the export path already reads `<id>.events.jsonl`; nothing wrote it until now).

The long-horizon store (`observations.jsonl`) holds only redacted digests: no transcript text except through the injected redact callback, and no pointers into raw transcripts — `sessionId` is provenance only, and every digest must stand alone after TTL eviction. Intent clusters are redacted upstream (`redactDigest`) before persistence or rendering.

Capture is gated on `CREWHAUS_WATCHME=1` (stamped per §5), attaches beside `attachAdvisorPersistence` inside the chat loop, tears down in the same finally block, and — because the bus swallows subscriber failures — can never crash a run.

## 8. Data layouts and lifecycles (TTL, lock, windows)

Per harness (`<cwd>/.crewhaus/`, standalone-harness convention; all new files mode 0600):

```
sessions/<sess_16hex>.jsonl          # existing durable event log (UNCHANGED; sole content store)
sessions/<sess_16hex>.events.jsonl   # NEW, live-written: one JSON line per BUS-ONLY TraceEvent;
                                     # co-evicted with its session by the TTL sweep; read by
                                     # sessions export + watchme report
watchme/state.json                   # WatchmeState (watching flag, watermark, window outcomes)
watchme/observations.jsonl           # append-only redacted digests + {agg:1} Welford lines; NO TTL
watchme/judgments.jsonl              # phase-2 judge verdicts (machine signal, OUT of feedback)
watchme/run.lock                     # advisory lock; window key watchme:<spec>:<floor(now/every)>
watchme/reports/<ISO-ts>/            # report.json + report.md + suggestions.json
                                     # + fewshot-candidates.json (abs path printed)
watchme/synthesized/<safeName>.yaml  # synthesized proposal specs; never auto-applied
feedback/watchme.jsonl               # ONLY under --emit-feedback: bare FeedbackRecords, source "watchme"
routing/arms.jsonl                   # existing scoreboard; gains SHADOW q:* delta lines ONLY
                                     # under --feed-routing (same line grammar)
```

Global root (`~/.crewhaus/watchme/`, override `CREWHAUS_WATCHME_ROOT` or `--root`; precedent: `~/.crewhaus/pricing`): `harnesses.json` — `{v:1, harnesses: HarnessEntry[]}`, tmp+rename, absolute dirs, upsert-by-dir, tolerant pruning on read (entries whose dir vanished are dropped and reported). Tests use `--root` exclusively (CI sandboxes; multi-user machines).

Lifecycles, honestly stated:

- **TTL.** Session transcripts keep their existing 30-day TTL. The eviction sweep today unlinks only `<id>.json` + `<id>.jsonl`; extending it to unlink the `.events.jsonl` sibling is a HARD REQUIREMENT of this feature (an earlier draft claimed the sibling was "co-evicted by the same sweep" — that was false, and the fix ships with a test: expired sessions lose all three files, pinned sessions keep all three). `observations.jsonl` deliberately has NO TTL — it is the long-horizon store, which is exactly why it holds only redacted, self-standing digests.
- **Lock.** All analysis runs under `watchme/run.lock` (the dream-engine advisory-lock pattern), so a cron-fired report and a manual one cannot interleave writes.
- **Windows.** Idempotency keys on `watchme:<spec>:<floor(now/every)>`; a window records `ok`, `model_refused_unpriced`, or `model_failed`. A judge refusal (unpriced model) consumes the window; a transient model failure does not — retrying a flaky provider is fine, silently re-billing a refused one is not. Running `report` twice in one window is a no-op (pinned by an integration test).
- **Compaction.** `observations.jsonl` folds old delta lines into Welford aggregate lines (`{v:1, agg:1, key, n, mean…, m2…}` — the scoreboard grammar clone) via write-then-rename `compact()`, so the file stays bounded without losing the running statistics; a test pins delta-vs-aggregate equivalence against hand-computed means.
- **Watermark.** `state.json` carries `{lastMtimeMs, lastSessionId}` so each report only digests new sessions; `watchme start` runs an immediate backfill digest over everything before the watermark exists.

## 9. Human-signal purity and the two opt-in bridges

The feedback flywheel (`rate`/`feedback`/`distill`/`optimize --ratings`) is a HUMAN-signal channel, and watch-me keeps it that way. The founding flaw of an earlier draft — machine judge verdicts flowing straight into the flywheel as FeedbackRecords — is resolved by physical separation: phase-2 judgments live in `watchme/judgments.jsonl` as `WatchmeJudgment` records, which distill/fewshot/lessons/optimize see NOT AT ALL by default.

Two bridges exist, both explicit per-invocation CLI opt-ins, both documented as the sanctioned crossing points:

1. **`watchme report --emit-feedback`** converts judgments to bare FeedbackRecords in `.crewhaus/feedback/watchme.jsonl` with the new source `"watchme"` (`FeedbackSource` gains the variant; readers are already tolerant of unknown sources, and `extractFeedbackRecords` accepts bare records). Nothing writes that source without the flag. Making downstream consumers source-aware/filtering is a named follow-up (deferral 5) that must land before any default flip is even discussed.
2. **`watchme report --feed-routing`** joins quality scores (judgments or normalized ratings, in [0,1]) to durable `model_route` decisions per `(sessionId, turnNumber)` and records scoreboard arms — but under SHADOW `q:`-prefixed routeKeys the runtime router never mints or reads (it mints hard/easy). The reward flows through the real `computeReward` with the new `RouteObservation.quality` field (success-path quality term `clamp01(obs.quality ?? 1)`; omitted quality is byte-identical to today's rewards), so shadow arms are directly comparable to live arms in `route status` and the report — without touching live routing. Dropping the `q:` prefix is a deliberate one-line policy flip deferred until field experience justifies it (deferral 3).

The same purity argument covers the report's counterfactual section: quality-hold evidence for a cheaper-model row is tiered — (a) scoreboard arms, (b) watchme's own judged/rated turns, (c) "unverified" with a machine-consumable `verify: {argv: ["crewhaus", "model", "right-size", …]}` — and verification is DELEGATED to right-size/model-scan. The roster is never patched from observation.

## 10. Deferred seams

Each deferral is a named seam — each one line to flip later — not an open question:

1. **research/crew carriers**: `watchmeBlock` is a shared const; attaching the key + IR threading per shape is the whole change; strict schemas reject loudly meanwhile.
2. **managed runtime wiring**: the `accepted-but-unwired` warning + a one-line env stamp in target-managed.
3. **Live routing feed**: `joinQualityToArms` emits `q:*` shadow keys; dropping the prefix is the policy flip after field experience.
4. **Daemon-scheduled digestion**: watchme-report's core is pure with injected clock/fs and the store has run.lock + windowKey; a `watchmeJanitorStep` (dreamJanitorStep mold, name `watchme_digest`) slots into the janitor registry in a follow-up (deterministic-only unattended, matching dream's no-unattended-spend policy).
5. **Default machine-feedback bridge**: `--emit-feedback` exists; making consumers source-aware/filtering is the follow-up before any default flip.
6. **Eval-verified counterfactuals**: report rows carry `verify.argv`; a future `watchme verify` drives FlywheelHooks.evalRun.
7. **G13 SSE/live dashboards**: `.events.jsonl` is poll-tailable with advanceSessionTail's cursor; no push channel built.
8. **Thredz-shared scoreboard arms**: arms.jsonl's free-string routeKeys + the wiki articles carry model-fit findings in v1.
9. **`observability.trace.persist` aliasing**: if a future G26 revision wants to own trace persistence, `resolveWatchmeEnv` is the single junction to reconcile at (documented).
10. **Docs-repo module brief (NNN-watchme-store.md) + demos walkthrough recipe**: separate follow-up PRs per the routing-store precedent — named in the factory PR body.

## 11. Alternatives considered

- **A `@crewhaus/watchme-engine` package** (analysis as a library). Rejected: the analysis is a composition of a dozen existing seams that all live in `apps/cli` today — `deriveTurns`, `clusterIntents`, the grader registry, the cost-tracker functions, `buildSuggestionsFile`, `harvestFewShot`, `applySpecEdits`, the wiki store wiring. Publishing an engine package would either duplicate those seams or force them all into public package APIs prematurely. The `watch.ts`/`dev.ts`/`feedback.ts` precedent — pure CLI modules with injected seams, colocated tests — gives the same testability with zero new public surface. The ONE new package is the zero-dep store, because durable state (long-horizon digests, the cross-harness registry) genuinely outlives the CLI process and the transcript TTL.
- **`watchme` as an `observability:` sub-key.** Rejected: `observability:` configures generic telemetry subscribers (ring/printers/metrics/cost/alerts/otel) — output plumbing. Watch-me is a learning feature with a store, reports, synthesis outputs, and privacy knobs. Folding it under `observability.` would entangle capture with `trace.level` semantics (they are deliberately independent, §5), would put trust-boundary knobs (`share`, `scope`) under a block whose other keys are freely tunable plumbing, and would make the eventual research/crew carrier story depend on observability's shape coverage. Sibling block, two documented interaction points, one junction per path.
- **Hooks as the data plane.** Rejected: hooks in this codebase are trigger-only lifecycle points, not a persistence channel. Building capture on hooks would mean shelling out per event (cost, ordering, failure isolation all worse than an in-process bus subscriber), would miss bus-only kinds that never correspond to a hook event, and would put user-configurable code in the middle of the data plane — exactly where an attacker-influenceable transcript should not flow. The durable files written by an in-process, failure-swallowed bus subscriber are the data plane; hooks remain available as triggers around it (e.g. a future post-run digest trigger) without ever carrying the data.
- **A separate always-fail grader package for factuality** (instead of de-stubbing in place). Rejected: `twelve.answerFaithfulness`/`answerRelevance`/`hallucinationRate` are RESERVED names with registered thresholds in `grader-12-metric-rubric`; a parallel package would fork the registry semantics and leave the stubs lying. De-stubbing in place keeps names, thresholds, registration order, and plugin-override semantics unchanged — at the cost of a loudly-documented behavior change (eval suites referencing the reserved names change verdicts; `(name, dataset)`-keyed baselines shift), which the CHANGELOG calls out.
- **Auto-applying learned improvements** (spec patches, roster changes, live routing writes). Rejected at every point where it came up: judge verdicts do not enter the flywheel by default, quality does not touch live arms by default, synthesized specs are new proposal files, counterfactuals delegate to `model right-size`, and every `watchme.*` knob is excluded from `OPTIMIZABLE_PATHS`. The feature's whole posture is: observe honestly, propose loudly, apply nothing silently.
