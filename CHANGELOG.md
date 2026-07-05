# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — adaptive model routing (P4)

- **Online ε-greedy exploration for `agent.model_pool` (`policy: learned`)**:
  a new `learning.explorationRate` (default `0`) makes the learned policy keep
  sampling non-best candidates a fraction of the time once every arm has
  cleared the sample floor — catching model drift and escaping a stale optimum
  instead of hard-committing to the argmax forever. The draw is seeded from the
  run + turn + band (from `learning.seed` when set, else the sessionId), so
  exploration differs run-to-run yet stays fully replayable from the transcript
  — no persisted RNG. `explorationRate: 0` is byte-for-byte the deterministic
  explore-then-exploit of 0.2.1.
- **`crewhaus route explain <session>`**: replays a run's routing decisions
  (turn, band, model, policy, explore/exploit, reason), backed by a new durable
  `model_route` event persisted per routing decision while a pool is active — a
  turn that runs tools routes more than once as the difficulty band shifts, so
  the same `turnNumber` can appear on consecutive rows. Non-conversational, so
  `--resume` is unaffected.
### Added — adaptive model routing on more shapes

- **`agent.model_pool` now works on the pipeline, research, batch, and browser
  targets** (previously cli/channel/managed only). These shapes' emitted
  runtimes each call `runChatLoop` with a single primary — exactly the cli
  execution model — so the pool routes (and, under `policy: learned`, keeps
  learning) there with zero runtime changes; the compiled bundle threads the
  lowered pool into `runChatLoop`, and specs without it compile
  byte-identically. Deliberately NOT extended to onchain/onchain-game (their
  emitted bundles are callable modules whose agent-loop wiring is still
  deferred, so the field would be inert) or to workflow/graph/crew (per-unit
  models — pool attachment there is a future design).

## [0.2.1] - 2026-07-05

Publishes the Claude-Code-parity runtime (#282) and adaptive model routing
(#280) to npm and every install channel — npm 0.2.0 predates the new
`bashOutput`/`killShell` tools, so specs using them could not compile from the
published CLI until this release — plus a batch of CLI and documentation fixes.

### Added — Claude-Code-parity runtime features

- **Parallel read-only sub-agent fan-out**: multiple `Task` calls batched in
  one assistant turn now execute CONCURRENTLY when the dispatched sub-agent's
  entire tool set is read-only + concurrency-safe + non-destructive (e.g. a
  `[Read, Glob, Grep]` explorer); command/write-capable workers still
  serialize. Built on a new per-call `concurrencyClassifier` hook on
  `RegisteredTool` (static flags can't express per-dispatch safety) and
  bounded by a new `runChatLoop({ maxConcurrentTools })` option (default 4),
  honored by both the batch and streaming executors.
- **Background shells**: `Bash` gains `background: true` — detaches the
  command, returns a `bash_id` immediately, and keeps it running across
  turns. New companion tools `bashOutput` (incremental stdout/stderr since
  the last poll + running/exited/killed status) and `killShell` (SIGKILL by
  id). Live background processes are killed at host exit; per-stream output
  is capped with truncation reporting. Registered across the compile/run
  tool maps (spec keys `bashOutput`, `killShell`).
- **`crewhaus run --prompt <text>` one-shot mode for `target: cli`**: runs a
  single non-interactive turn, prints the final reply, and exits (no REPL) —
  for scripting/CI; composes with `--resume`/`--continue`. Previously the
  flag was silently ignored for cli targets.

### Added — adaptive model routing

- **`agent.model_pool`** ([#280]) — declare a set of candidate models and a
  per-turn selection `policy` (`static` | `heuristic` | `learned`). The runtime
  picks a model for each turn and, under `learned`, improves the choice the more
  the harness runs by folding each turn's success/latency/cost into a durable
  per-`(route, model)` reward scoreboard (new package `@crewhaus/routing-store`).
  Every decision is published as a `model_route` trace event; inspect or reset
  the accumulated scoreboard with **`crewhaus route status|reset`**. Opt-in and
  mutually exclusive with `model_tiers`/`model_fallbacks`; specs without it
  compile byte-identically.

### Fixed

- **`compaction.model` is now wired**: `crewhaus run` and the compiled
  cli/channel bundles thread `ir.compaction.model` into the runtime's
  `compactionModel` option, so auto-compaction actually summarizes on the
  spec's chosen (typically cheaper) model instead of always using the
  primary. Previously the field was parsed and lowered but inert on every
  execution path (only `doctor --models` / `model right-size` read it).
- Corrected the compiled-bundle banner comment claiming `CREWHAUS_RESUMED=1`
  is "set by `--continue`/`--resume`" (nothing in the toolchain sets it; it
  is an external-wrapper hook), and the `ToolCatalog` quarantine doc comments
  that described a runtime notice-injection wiring that doesn't exist (the
  shipped path reads `.crewhaus/mcp/quarantine.json` and filters by name
  prefix in the CLI).
- Declared the `doctor --detect`/`--no-probe`/`--fix` and `init
  --interactive`/`--detect` flags that those commands already honored but the
  argument parser rejected ([#283]).
- Corrected stale `egress_decision` "no writer" claims in `crewhaus security
  digest` ([#281]).

### Documentation

- Documented the (shipped) provider-failover chain and two-tier turn-difficulty
  router in the `@crewhaus/model-router` README ([#284]), and clarified in the
  `rankFallbacks` docstring that its cache-aware fallback-ranking seam is
  currently caller-less/unwired ([#285]).

[0.2.1]: https://github.com/crewhaus/factory/compare/v0.2.0...v0.2.1
[#280]: https://github.com/crewhaus/factory/pull/280
[#281]: https://github.com/crewhaus/factory/pull/281
[#283]: https://github.com/crewhaus/factory/pull/283
[#284]: https://github.com/crewhaus/factory/pull/284
[#285]: https://github.com/crewhaus/factory/pull/285

## [0.2.0] - 2026-07-03

The automation release: CrewHaus harnesses now build their own evals, tune
themselves from real usage, heal their own operations, and stay safe — with
manual control preserved everywhere. This lands all 69 items from the
automation audit (`AUTOMATION-OPPORTUNITIES.md`) across ~18 PRs. Every addition
is additive and opt-in: existing specs parse and compile byte-identically, and
every automation is a default or flag over controls that still work by hand.

### Added — the self-building eval flywheel

- **`crewhaus flywheel init|run`** ([#262]) packages the nightly loop
  (compile → eval → optimize → gate → write-back) as one in-process command,
  accept-then-write so a spec is only touched when a regression-gated candidate
  strictly improves. **Eval run-history + auto-baseline + `--gate`** ([#258])
  records every run under `.crewhaus/evals`, auto-diffs against the pinned
  baseline, and fails CI on regressions. **`crewhaus datasets` + `distill
  --register`** ([#258]) give datasets the versioned registry the CLI already
  gives specs, with a `registry:<name>[@ver][#split]` shorthand for eval/optimize.
- **Datasets, graders, and judges that build themselves from usage**:
  `scaffold-evals`/`init --with-evals`, `graders suggest`, `eval coverage`,
  `dataset mine`/`synthesize` (PII- and secret-redacted, injection-payload
  stress variants that never touch human-gold splits), `dataset refresh-goldens`,
  and `judge calibrate` ([#266]). **Regression pinning** ([#258]) makes every
  accepted fix a permanent test, and the **failure arbiter** ([#258]) auto-triages
  failing samples (noise retry, bad-gold exclusion) so the optimizer stops
  burning budget on flaky/mis-specified cases. **`eval --models a,b,c`** ([#258])
  benchmarks models on one command. **`feedback.autoDistill`** ([#262]) closes
  the ratings→dataset loop at run teardown; a one-keystroke exit-rating prompt
  captures CLI signal.

### Added — the observer/advisor (suggestions beyond the prompt)

- **`crewhaus advise`** ([#263]) mines durable session telemetry (a new
  persistence layer for recovery/tool/permission/model events) into typed,
  eval-validated `SpecPatch` suggestions — and **`optimize --from-advice`**
  ([#263]) applies them through the real regression gate. **`doctor
  --context-pressure`** ([#263]) plus `permissions suggest`, a `tools`
  namespace (list/suggest/audit + a compile↔runtime map-sync guard that caught a
  real `python`/`shell` tool-resolution bug), learned `failure_taxonomy`/loop
  rules, and sub-agent-split suggestions ([#267]).

### Added — model & cost automation

- **Spec-declared provider failover** (`agent.model_fallbacks` + `circuit_breaker`)
  ([#264]), a **`switch-model` recovery action** ([#264]), and **run-level budget
  caps** (`budget: { usd, on_exceed: stop|degrade }`, `run --budget-usd`) ([#264]).
  **Model market scan + `doctor --models` + `pricing sync`**, **right-sizing**
  with a sunset-aware `cheapest` sentinel, a **two-tier turn-difficulty router**,
  and **cache-hit-aware candidate ranking** ([#268], [#257]).

### Added — self-healing operations

- **`crewhaus deploy canary`** with a real regression gate + unattended ramp +
  auto-rollback, **`eval --sentinel`** provider-drift detection, a **baseline-
  derived alert watchdog**, and **auto-assembled incident bundles** ([#270]).
  **`observability.slo`** block with a sustained-breach mitigation ladder
  (alert → pause-intake → last-known-good rollback) and **`crewhaus mcp doctor`**
  (health scoring, tool-schema drift watch, runtime auto-quarantine) ([#274]).
  **`crewhaus loadtest`** concurrency benchmark + deploy gate ([#273]).

### Added — DX & lifecycle

- **`doctor --detect/--fix`**, **`init --interactive`** spec authoring,
  **`crewhaus lint --fix` + `compile --watch`**, and a **spec `version:` field +
  `crewhaus upgrade`** migration assistant ([#265]). Every compiled bundle now
  ships a **generated README** ([#257]); compile/write-back **auto-register**
  spec versions with distilled changelogs (`spec log`) ([#257]); **`crewhaus
  state backup|restore`** transports a harness's `.crewhaus` state and folds
  deployed feedback back into the dev loop ([#257]).

### Added — safety that learns

- **`crewhaus security digest`**, **scope-audit drift watch**
  (`doctor --philosophy-alignment --baseline`), and **`crewhaus channel
  provision|verify`** ([#261]). **Security regression corpus** + candidate
  detector rules, **egress triage** (with the previously-missing `egress_decision`
  audit writer), **HMAC-hashed PII allowlist tuning**, and **justification-judge
  calibration** ([#272]).

### Added — memory, knowledge & fleets

- First-class spec **`memory:` block** with auto-capture/recall, a golden
  **few-shot pool** (`optimize --few-shot`), an auto-discovered **FAQ skill**,
  auto-maintained **LESSONS.md** + per-user prefs, and **summarize-before-evict**
  session indexing ([#269]) — recalled/injected content is boundary-classified
  and redacted. **`crewhaus fleet`** (cross-harness inventory/status/bulk-ops),
  **approval-gated promotion** + `crewhaus propose`, a **marketplace CLI**
  (`plugins`/`templates` + publish loop), **cross-harness knowledge sync**, and
  **`crewhaus retire`** ([#271]). **Auto-generated eval bridges** unlock
  eval/optimize for non-cli shapes; **voice replay evals**, an **onchain policy
  tuner + spend sentinel**, and an **intent analytics digest** ([#273]).

### Added — release & CI/CD

- **Per-shape container images published to GHCR** on release with the
  `docker/digests.json` loop closed, a **nightly runtime-smoke schedule + release
  gate**, and **`crewhaus compile --check`** ([#260]). Plus **`crewhaus audit
  verify`**, **`crewhaus retention` sweep/export/purge**, and a **boot-time
  self-heal janitor** for daemon shapes ([#256]).

[0.2.0]: https://github.com/crewhaus/factory/releases/tag/v0.2.0
[#256]: https://github.com/crewhaus/factory/pull/256
[#257]: https://github.com/crewhaus/factory/pull/257
[#258]: https://github.com/crewhaus/factory/pull/258
[#260]: https://github.com/crewhaus/factory/pull/260
[#261]: https://github.com/crewhaus/factory/pull/261
[#262]: https://github.com/crewhaus/factory/pull/262
[#263]: https://github.com/crewhaus/factory/pull/263
[#264]: https://github.com/crewhaus/factory/pull/264
[#265]: https://github.com/crewhaus/factory/pull/265
[#266]: https://github.com/crewhaus/factory/pull/266
[#267]: https://github.com/crewhaus/factory/pull/267
[#268]: https://github.com/crewhaus/factory/pull/268
[#269]: https://github.com/crewhaus/factory/pull/269
[#270]: https://github.com/crewhaus/factory/pull/270
[#271]: https://github.com/crewhaus/factory/pull/271
[#272]: https://github.com/crewhaus/factory/pull/272
[#273]: https://github.com/crewhaus/factory/pull/273
[#274]: https://github.com/crewhaus/factory/pull/274

## [0.1.8] - 2026-07-01

Response ratings → self-improving evals/graders/datasets.

### Added

- **Rate agent responses, then distill the ratings into eval artifacts.** New
  `crewhaus rate` (thumbs/stars/score) and `crewhaus feedback` (comment or
  `--correction`, a better answer) record a human rating on a session turn as a
  resume-safe `user_feedback` event in the session JSONL. `crewhaus distill`
  pairs ratings with their exchanges and emits the two artifacts the eval stack
  already consumes: a `Sample[]` dataset (positively-rated turns become gold
  samples — the correction wins when present; low-rated turns become
  mutation-target hints) and a `graders.yaml` with exactly one synthesized
  grader. `crewhaus optimize --ratings <session>|all` feeds distilled samples
  into the existing optimize loop with no optimizer change, so real usage
  signal drives spec patches (Pillar 2).
- **`crewhaus distill --judge [--judge-model <m>]`** emits an `llm_judge`
  grader instead, its rubric seeded from the praised-vs-criticized feedback
  comment themes (quoted as data; runs one judge call per sample under
  `crewhaus eval`).
- **Slack 👍/👎 reactions become ratings.** With the new spec block
  `feedback: { channelReactions: true }`, the compiled channel bot maps
  `reaction_added` on a bot reply (`+1`/`thumbsup`/`-1`/`thumbsdown`, including
  skin-tone variants) to a `user_feedback` event on the reacting session
  (channel/user session modes; other emojis and the bot's own status reactions
  are ignored).
- **Cross-cutting `feedback:` spec block** (`modality`, `scale`, `storage`,
  `autoDistill`, `channelReactions`) on the cli and channel shapes, lowered to
  `ir.feedback` (Pillar 1); deliberately *not* in `OPTIMIZABLE_PATHS`.
- **`response_rated` trace event** wired through the pretty printer and OTel
  exporters; the web UI (`@crewhaus/ui`) gains a per-turn rating bar that
  persists to `.crewhaus/feedback/feedback.jsonl`.

### Fixed

- Runtime-injected recovery nudges (loop warning, continue, tombstone) are now
  logged `synthetic: true` so turn numbering agrees across the CLI, web UI,
  runtime, and `distill` even after a mid-session recovery.

## [Unreleased] - §55–§59 integration batch (2026-05-26)

External sources synthesized for this batch:

- **AutoHarness** (Lou et al., Google DeepMind, March 2026; arxiv 2603.03329) — code-as-harness via Thompson-sampled tree search.
- **Natural-Language Agent Harnesses** (Pan et al., Tsinghua, March 2026; arxiv 2603.25723) — contracts + roles + stages + adapters + state semantics + failure taxonomy as portable executable artifacts.
- **Meta-Harness** (Lee et al., Stanford/MIT/KRAFTON, March 2026; arxiv 2603.28052) — filesystem-backed full-history coding-agent optimizer.
- **AgentFlow** (Liu et al., UCSB et al., April 2026; arxiv 2604.20801) — typed graph DSL + four runtime feedback channels.
- **Meta-Engineering Harnesses** (Sengupta et al., HireNimbus, May 2026; arxiv 2605.25665) — two-pass contracts, four-way failure arbiter, specialization records.
- **TDS 12-Metric Framework**, **OpenAI Prompt-Injection Defense**, **Identity Governance**, **Stop Wasting Money on AI Context** — four blog-style studies cross-checked against shipped v0.2.x packages.
- **ECC**, **Understand-Anything**, **claude-plugins-official** — three reference repos providing patterns for rule packs, skill-as-orchestrator, and the Anthropic minimal plugin format.

### Added

- **§55 Track A** — `spec.failure_taxonomy` block (cross-cutting; added to every IR variant). `recovery-engine` consults user-named classes before falling back to its built-in taxonomy. `failure_taxonomy` added to `OPTIMIZABLE_PATHS` for every target. Source: NLAH (arxiv 2603.25723).
- **§55 Track B** — Four-way failure arbiter in `eval-optimizer-orchestrator/failure-arbiter`. Classifies failing samples into `bug | spec-gap | noise | contract-ambiguity` and maps each to a corrective `ArbiterAction`. Tie-break favors process-correcting actions. Source: Meta-Engineering Harnesses (arxiv 2605.25665).
- **§55 Track C** — Coverage cross-check test for `grader-12-metric-rubric`: 12 metrics in 4 categories, threshold constants pinned to the published values. Source: TDS 12-Metric Framework.
- **§55 Track D** — New `packages/tool-harness-synthesizer`. Thompson-sampled tree search over candidate verifier functions; `VerifierMutationProvider` plugs into the existing optimizer. Source: AutoHarness (arxiv 2603.03329).
- **§56 Track E** — New `packages/meta-harness-optimizer`. **BREAKING (opt-in).** Coding-agent proposer with filesystem-backed full history. Ships the experience-store layout + `MetaHarnessMutationProvider` adapter, consumable programmatically via `optimizeSpec({ mutator: new MetaHarnessMutationProvider(...) })`. The proposer is a caller-supplied `ProposerFn` so the package stays pure and testable. Bundle output diverges from spec; `formatBreakingChangeHeader()` prepends a warning. CLI `--mutator meta-harness` wiring is a follow-up — the CLI currently exposes `rule-based` and `claude` only. Source: Meta-Harness (arxiv 2603.28052).
- **§57 Track F** — Typed graph DSL: `IrMessageSchema`, `IrSchemaRef`, optional `messageSchemas` on `IrCrewV0`/`IrGraphV0`; edge `schema` on `IrGraphEdge`. New `wellFormednessCheck` pass in `ir-passes` (graph connectivity, edge resolution, schema reference resolution). Four new TraceEventBus event kinds: `test_verdict`, `program_output`, `coverage_report`, `sanitizer_report`. Source: AgentFlow (arxiv 2604.20801).
- **§58 Track G** — New `packages/specialization-registry` (payments, auth, booking built-ins + project-local JSON overrides) and `packages/contract-compiler` (two-pass: completeness + ambiguity). Source: Meta-Engineering Harnesses (arxiv 2605.25665).
- **§59 Track H** — New `packages/target-claude-plugin` emitter. Transforms any IR variant into an Anthropic-compatible Claude Code plugin directory (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md` + optional `agents/`, `.mcp.json`). Source: claude-plugins-official.
- **§59 (post-batch)** — Browser-deployable `packages/compiler-worker` and new `packages/target-cf-worker-cli`, `packages/target-cf-worker-graph`, `packages/target-cf-worker-workflow` emitters for shipping compiled bundles as Cloudflare Workers.
- **§44 Cloud adapters** — One-click deploy adapters for `packages/cloud-adapter-flyio`, `packages/cloud-adapter-heroku`, `packages/cloud-adapter-railway`, `packages/cloud-adapter-render`.
- **§41 Plugin system** — New `packages/plugin-sdk` (typed surface for third-party extensions) and `packages/plugin-loader` (runtime activation with sandboxed import + signature verification).
- **§42 Plugin registry + marketplace** — New `packages/plugin-registry` (discovery, pinning, signature verification) and `packages/module-marketplace-client` (search / install / update / publish over the registry).
- **Cross-cutting (Track 10)** — `RunContext.agentIdentity` (skillId / subAgentId / roleId) + `formatAgentIdentity` helper. New `packages/rules-engine` reads multi-language rule packs from `rules/{common,typescript,python,...}` with `CREWHAUS_RULES_PROFILE=core|standard|full` gating. Sources: Identity Governance, ECC §4.1.

### Changed

- **`DEFAULT_PIPELINE`** in `ir-passes` now has 6 passes (added `wellFormednessCheck` before `promptCachePrefixSort`).
- **`OPTIMIZABLE_PATHS`** in `spec-patch` extended with `failure_taxonomy` for every target.
- **Optimizer now learns from real failure signal.** The model-driven mutator (`prompt-optimizer-claude`) previously saw only the aggregate dev score stamped on raw dev inputs — its `selectFailures` was a v0 stub, so `crewhaus optimize --mutator claude` guessed at fixes and overfit. `FitnessFn` return is widened to `number | FitnessResult` (backward-compatible); `FitnessResult.grades` carries per-sample `{input, score, expected?, rationale}` which the loop threads to the mutator via the new optional `OptimizerState.bestGrades`. The CLI's `optimize` fitness closure now returns each dev sample's overall score **and the grader's rationale**, so the mutator targets the samples the prompt actually fails and addresses the named root cause (e.g. "no source cited") instead of a generic rewrite. Result: `optimize` reliably lands a generalizing patch where it used to overfit or find nothing.
- **CLI `optimize` gains `--concurrency N`** (mirrors `crewhaus eval`; default 4). Each iteration runs a full eval pass on the dev set; on a low provider rate-limit tier the previous fixed fan-out of 4 tripped 429s. The nightly-flywheel path sets `--concurrency 1`.

### Documentation

- `docs/MODULE-CATALOG-STATUS.md` updated with §55–§59 rows pointing at the new packages.
- Each new/changed source file carries an inline docstring citing the underlying arxiv paper or article (the canonical record of *why* each piece exists).

### Verification

- `bun run tsc -b`: clean.
- `bun run test:smoke`: 17/17 pass.
- Full unit suite: 6016 pass / 0 fail / 2 skip across 440 files.

## [0.1.6] - 2026-06-26

Distribution + CLI quality-of-life fixes.

### Fixed

- **Homebrew installs on Apple Silicon under Rosetta no longer warn about AVX.** An
  x86_64 Homebrew running under Rosetta 2 matched the formula's Intel branch and
  installed `crewhaus-macos-x64`, which runs under Rosetta (a pre-AVX CPU) while
  Bun's macOS x64 runtime needs AVX2 — printing "CPU lacks AVX support" on every
  command. The formula now selects by physical CPU (`Hardware::CPU.physical_cpu_arm64?`)
  so Apple Silicon always gets the native arm64 binary. Linux/Windows x64 binaries
  now compile against Bun's AVX-free `-baseline` runtime. ([#250](https://github.com/crewhaus/factory/pull/250))
- **Flaky `channel-adapter-slack` signature test.** The "tampered signature" case
  mutated the signature by `slice(0, -2) + "00"`, a no-op ~1/256 of the time
  (whenever the timestamp-derived HMAC already ended in "00"); it now flips the
  final hex digit so the tamper is always a real change.

### Added

- **Working indicator during silent CLI waits.** ([#251](https://github.com/crewhaus/factory/pull/251))
- **`crewhaus init` emits a standalone next-step hint** (`cd <dir> && crewhaus run crewhaus.yaml`). ([#252](https://github.com/crewhaus/factory/pull/252))

## [0.1.4] - 2026-06-17

Small CLI/compiler/runtime fixes, each retiring a documented "gotcha" by fixing the
underlying footgun.

### Fixed

- **Compiler — malformed credential env-refs fail fast.** A new `lowerCredential()` rejects
  a `$`-prefixed value that is not valid `$UPPER_SNAKE_CASE` on credential fields (channel
  `botToken`/`signingSecret`/`appToken`, Telegram/Discord/WhatsApp secrets, `retrieve.apiKey`)
  with a clear compile error instead of silently baking it into the bundle as a literal. The
  lenient literal fallback survives only for iMessage path fields (`chatDbPath`/`cursorPath`),
  where a literal `$HOME/...` is legitimate. The `compile` `--emit-ir` and strict-gate catches
  now route the `CrewhausError` family through `die()`, so it renders as a clean `crewhaus:`
  one-liner on every path.
- **CLI — `crewhaus --help`/`-h` exit 0 to stdout** (matching subcommand help); a bare
  `crewhaus` with no args still exits 1. Safe in `set -e` health checks.
- **secrets-manager — file backend `rotate()` auto-creates its root dir** (recursive, `0o700`)
  instead of crashing with a raw `ENOENT` on a fresh project.
- **CLI — `secrets --backend vault` errors clearly** instead of silently degrading to the
  env-var backend; unknown backends are rejected; help text lists only `--backend env-var|file`.
- **runtime-core — `cost_accrual` is mirrored into the session JSONL** when
  `CREWHAUS_COST_TRACKING` is set (gated; the FR-003 terminal aggregate is skipped to avoid
  double-counting), added to the event-log `EventKind` union, and ignored by
  `replayMessageHistory`, so `crewhaus cost-summary --session` sums a tracked run's spend.

### Added

- **Channel reactions for Telegram and WhatsApp.** `react()` is now implemented for Telegram
  (`setMessageReaction`, status emoji mapped to Telegram's allowed set) and WhatsApp
  (`type:"reaction"` targeting the inbound message id), joining Slack. Discord (whose inbound
  is an interaction, not a message) and iMessage (no scriptable reaction API) remain
  unimplemented; the session router still skips them silently (best-effort).

### Changed

- **vad-engine** — `DetectorOptions.sampleRate` is documented as reserved / no-resample.
- **spec** — the Slack `appToken` field carries a Zod `.describe()` marking it reserved for a
  future Socket Mode path (parsed but unused by the v0 webhook daemon).

## [0.1.0] - 2026-05-15

### Added

- Initial public release of the factory meta-harness compiler.
- Compiler pipeline (`parseSpec → lower → applyPasses → emit`) in `packages/compiler`.
- IR discriminated union covering CLI, workflow, channel, graph, managed, pipeline, crew, research, batch, voice, browser, eval, onchain, and onchain-game target shapes (`packages/ir`).
- Target emitters under `packages/target-*` for each IR variant.
- IR-level optimization passes in `packages/ir-passes` (e.g. redundant MCP server collapse).
- Active optimization loop: `packages/eval-runner`, `packages/prompt-optimizer`, `packages/prompt-optimizer-claude`, `packages/spec-patch`, and `packages/eval-optimizer-orchestrator`, exposed via `crewhaus optimize`.
- Security fabric via `packages/boundary-classifier` with `TrustOrigin` metadata and a content-hash LRU cache, wired into MCP, sub-agent, channel, federation, skill, compaction, and tool boundaries.
- `crewhaus doctor --philosophy-alignment` audit for the three architectural pillars.
- CLI app (`apps/cli`), Helm chart (`packages/helm-chart`), and single-binary CLI build. IDE extensions (VS Code, JetBrains) live in the sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) repo.
- Example specs and recipes in the [demos repo](https://github.com/crewhaus/demos) under `smoke/` and `walkthroughs/`.
- Module catalog and build roadmap in the standalone [docs repo](https://github.com/crewhaus/docs).
