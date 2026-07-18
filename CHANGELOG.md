# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Loop contract 0.4, Batch A — the agent-loop knobs your spec always
  implied are now real spec keys, wired end to end.** One coordinated batch
  lands the spec grammar, the IR, every emitter, the `crewhaus run`
  interpreter, and the runtime enforcement for the loop-shaped controls:

  - **`limits:` — hard runtime ceilings for one agent loop**, accepted on
    cli/channel/managed/workflow/graph/crew/research/batch/browser:
    `max_tool_iterations` (now optimizer-reachable via `OPTIMIZABLE_PATHS`),
    `max_concurrent_tools`, `context_limit`, plus the new wall-clock timers
    `deadline_ms` (whole run), `turn_timeout_ms` (one turn) and
    `model_call_timeout_ms` (hung-stream watchdog). A tripped timer ends the
    run with the classified failure machinery: `run_failed` class
    `"timeout"`, exit code 34 (CrewHaus's own configured ceiling, beside the
    budget cap's 33). On the workflow shape `deadline_ms` binds the WHOLE
    run — each step both guards on the shared deadline stamp and arms the
    runtime timer with the *remaining* budget, so N steps can't each claim
    the full ceiling. The crew shape adds `limits.crew`
    (`max_activations` / `refusal_depth` / `max_a2a_depth`) orchestration
    ceilings.
  - **`limits.loop_detection` — the runaway-tool-loop escalation ladder**:
    tune `window`/`threshold` and pick `escalation: warn` (trace event only,
    the pre-0.4 behaviour and still the default), `justify` (the repeated
    call must pass the intent gate's justification check) or `abort` (end
    the run).
  - **`agent.thinking` — extended thinking as a portable spec key**: exactly
    one of `budget_tokens` (explicit, >= 1024) or `effort: low|medium|high`;
    also declarable per workflow step, per graph node and per crew role. The
    adapter layer translates per provider: Anthropic/Bedrock-Anthropic map
    `effort` through the shared `EFFORT_THINKING_BUDGET_TOKENS` presets,
    Gemini maps it onto `thinkingConfig`, and OpenAI reasoning models
    (o-series / gpt-5) get native `reasoning_effort` (an explicit budget
    picks the nearest effort bucket; non-reasoning models ignore the knob
    silently).
  - **`agent.rate_limits` — per-tool rate limits** on cli/channel/managed:
    tool name (or `"*"` catch-all) → `{ rpm, burst }`, enforced in the
    runtime tool dispatcher.
  - **`hooks:` — spec-declared lifecycle hooks**, the in-spec equivalent of
    `.crewhaus/settings.json` entries (same ten events; a cross-check test
    pins the spec's event list to hooks-engine's `HOOK_EVENTS` so they
    cannot drift). On every shape spec hooks layer BELOW the settings.json
    layers — spec first, then user → project, so the later-wins mutate
    merge keeps the user's/project's overrides authoritative, mirroring the
    permission RuleSet's settings-over-yaml precedence (all hooks still run;
    any deny wins regardless of layer).
  - **Graph control flow**: `edges[].when` declarative predicates over the
    shared state (`key` + `equals` value test or `exists: true`, evaluated
    in declaration order) and `parallel:` barrier groups lowered onto
    graph-engine's `addParallel`. The engine gains an optional
    `ParallelMergeReducer` for custom merges, and the default merge now
    detects same-key write collisions across branches and fails classified
    (`run_failed`, class `"config"`, exit 21) instead of silently
    last-write-wins.
  - **More shapes, fewer dead keys**: `mcp_servers` now boots a real
    wire-once MCP host on workflow/research/batch bundles (secret refs stay
    unresolved in the artifact, `disconnectAll()` on every exit path); graph
    node `tools:` registers the builtin catalog; crew gains
    `routing.kind: "llm"` (model-driven role handoffs with a deterministic
    parse ladder and entry-role fallback) and per-role `sub_agents`; batch
    queue adapters construct their backend from env at boot (`sqs` /
    `redis-streams` / `postgres`, each failing loudly with the missing
    variable's name) and durable backends keep the worker alive instead of
    fast-exiting on an empty queue; `agent.streaming`, compaction tuning
    (`threshold` / `snip_keep_head` / `snip_keep_tail`), `memory.embedder`
    and run-level `budget:` thread through everywhere the schema accepts
    them.
  - **`compile()` now returns warnings** (additive `CompileResult`; every
    existing `Bundle` consumer keeps compiling): declaring a key a shape
    accepts but whose emitter still drops it — e.g. `thredz` on
    channel/managed/research/crew, `continuity` on workflow/batch, voice
    `tools`/`mcp_servers` — emits an `accepted-but-unwired` diagnostic
    instead of shipping dead YAML silently. The validating ir-passes (graph
    edge/`when`/`parallel` referential integrity + reachability through
    parallel barriers, chain integrity) now run unconditionally inside
    `compile()`; they rewrite nothing, so bundle bytes are unchanged.

- **Loop contract 0.4, Batch B — the evaluate half of the loop: in-loop
  evaluation, judge gates, and the builder-facing contract surfaces.** One
  coordinated batch lands the spec grammar, the IR, the runtime seam, the
  affected emitters, the eval stack, the compiler-worker endpoints, and the
  CLI:

  - **`evaluation:` — in-loop output evaluation on cli/channel/managed**:
    `grader` (`llm_judge` with `criteria` + optional `model`, or the
    deterministic `contains`/`regex`), `threshold` (llm_judge only, default
    0.7), `on_fail: retry|halt|note` (default `retry`) and `max_retries`
    (default 1). Defaults resolve AT LOWER TIME into the IR; bundles
    construct a `RunEvaluation` and the runtime loop scores every completed
    assistant turn, publishing the new `eval_graded` trace event and
    retrying/halting/noting per spec. A below-threshold `halt` ends the run
    with the classified failure machinery: `run_failed` class
    `"evaluation"`, exit code 35 (CrewHaus's own configured quality floor,
    beside the budget cap's 33 and the timers' 34).
    `evaluation.threshold`/`evaluation.max_retries` join `OPTIMIZABLE_PATHS`
    on all three shapes (subset-guard test updated); the grader itself is
    deliberately NOT optimizer-reachable.
  - **`kind: "judge"` workflow steps + graph judge nodes** — LLM judge
    gates over upstream output: the gate scores the nearest earlier
    non-judge step's (or gated node's) output in [0,1] against `criteria`
    via `@crewhaus/eval-judge` on the step's resolved model (aux-model
    `cheapest` supported), with `threshold` / `on_fail`
    (`retry_previous` re-runs the gated step with the verdict's rationale
    as feedback) / `max_retries` resolved at lower time. Every scoring
    pass publishes the new `judge_verdict` trace event (both kinds ship
    pretty renderers in the structured event printer).
  - **Builder-facing contract surfaces (compiler-worker + spec)**:
    `GET /schema` serves the whole 14-target spec grammar as a JSON-Schema
    document (`specJsonSchema()` via zod-to-json-schema, ETag-cached) —
    per-target definitions carry the new `evaluation`/`limits` keys;
    `POST /loop` serves `projectLoop(ir)` (`@crewhaus/ir`), the canonical
    ring/canvas loop projection matching the studio's `LoopProjection`
    wire contract (goldens pin every IR variant byte-for-byte; canvas
    node kinds pin to the studio's `step|node|role|doc` union);
    `parseSpecIssues()` returns path-bearing structured diagnostics
    (including YAML syntax line/col) and backs the worker's
    /validate + /compile error payloads; `applySpecEdits()` in
    `@crewhaus/spec-patch` gives the builder an atomic, comment-preserving
    multi-edit author surface (one CST mutation batch, one `parseSpec`
    re-validation, all-or-nothing).
  - **The eval stack learns the loop**: `crewhaus eval --repeats K` runs k
    seed-offset trials per sample and reports `pass@k` / `pass^k` beside
    the canonical verdict (per-trial grades recorded; regression gating
    and report flips compare per-sample pass-RATES, so flakiness
    surfaces even when the canonical verdict is unchanged); per-sample
    loop metrics (tool-call accuracy, interventions, safety-violation
    counts by deny/egress/justify, model-call latency p50/p95) aggregate
    into the run summary, the CLI's `[eval] loop:` line and the report
    renderer; per-sample `failureClass` tallies print as
    `[eval] failure classes:`; `llm_judge` graders take their min-score
    cut from `.crewhaus/judge-calibration.json` when present (applied
    calibrations echoed per run); graders files may declare
    `type: registry` — the default grader registry (the six specialty
    grader packs) is constructed once and shared across single runs,
    matrix cells, `optimize` and the flywheel.
  - **CLI**: `crewhaus compile --emit-loop` prints the same loop
    projection the worker serves (`--json` for the raw wire shape,
    `--out` writes `loop.json` beside the bundle);
    `crewhaus sessions export --format trajectories` exports logged
    sessions as JSONL trajectory tuples for offline analysis and
    fine-tune-style pipelines.

- **Loop contract 0.4, Batch C — the observe-and-govern half of the loop:
  headless human-in-the-loop approvals, agent identity, the observability
  control surface, live run streaming, and failure triage.** One coordinated
  batch lands the spec grammar, the IR, the runtime seam, the affected
  emitters, the gateway protocol, the OTel exporter, and the CLI:

  - **`permissions.ask_mode: pause|deny` — what an `ask` does where no human
    is watching (G11).** On a non-interactive surface (single-turn / daemon /
    gateway) a tool permission that resolves to `ask` no longer silently
    collapses to a denial. `pause` (the DEFAULT, the safe direction) parks the
    turn: the runtime persists a `PendingApproval`, publishes the new
    `approval_requested` trace event, and ends the run with the classified
    failure machinery — `run_failed` class `"approval_pending"`, exit code 36
    (beside the budget cap's 33, the timers' 34 and the quality floor's 35) —
    plus a resume token, so a later `grant`/`deny` re-drives the parked tool
    call pre-resolved (publishing `approval_resolved`). `deny` restores the
    pre-0.4 collapse. `crewhaus approvals list|show|grant|deny <id>` resolves
    parked approvals over the session store
    (`.crewhaus/sessions/approvals.jsonl`; `--by` records the deciding
    identity); on the channel shape the daemon constructs a shared approval
    store, the gateway gains a `/<adapter>/actions` route
    (verify → resolve → ack → resume) and Slack posts an interactive
    Approve/Deny Block Kit message a click resolves in-thread. `ask_mode` is
    deliberately OUT of `OPTIMIZABLE_PATHS` — a safety / human-in-the-loop
    posture, not a quality knob.

  - **Agent identity — a stable, verifiable fingerprint (item 4).** An
    Ed25519 keypair auto-generated at first boot into `.crewhaus/identity.json`
    (private key mode 0600); its `agentId` — the SHA-256 fingerprint of the
    public key — is stamped onto every `TraceEvent` envelope and appended to
    audit records, so a trace event and its audit trail attribute to one
    agent. `loadOrCreateAgentIdentity` is idempotent and create-exclusive
    (concurrent first-boots can't clobber each other; first writer wins).
    `crewhaus doctor` prints the resolved identity line.

  - **`observability:` control surface (G26) — which subscribers a bundle
    wires, and how.** New `trace` (`off|ring|pretty|json`), `metrics`, `cost`,
    `alerts`, `incidents` and `otel.endpoint` sub-blocks join the existing
    `slo` (now carried on crew too). DEFAULTS SEMANTICS: spec ABSENCE is NOT
    `off` — cost accrual and the low-overhead trace ring are default-ON; the
    pretty/json printer, metrics, alerts, incidents and OTel export stay
    opt-in; an explicit `cost: { enabled: false }` / `trace: { level: off }`
    wins. The serving emitters stamp the env the runtime's subscriber layer
    reads (`CREWHAUS_COST_TRACKING ??= "1"`; `CREWHAUS_TRACE ??=` only for
    pretty/json, since the ring is bus-internal); `crewhaus run --trace
    <level>` overrides per run — the flag wins over the spec block and ambient
    env — keeping `crewhaus run` byte-consistent with the compiled bundles.

  - **Per-response cost, attributed per tool (item 7) + a labeled cost
    counter (G57).** A priceable response's cost is split evenly across the
    tool calls it authorized and stamped as `attributedCostUsdMicros` on each
    `tool_use`; the metrics-collector gains a labeled cost counter fed by
    `cost_accrual` events (microdollars by model/provider, `unpriced` accruals
    counted at zero).

  - **Live run streaming — `runs.subscribe` over SSE (item 3).** The gateway
    protocol adds the one streaming method: `runs.subscribe` upgrades to a
    long-lived `text/event-stream` (one trace event per `data:` frame,
    heartbeat/open marker as SSE comment frames) instead of a JSON envelope;
    the gateway server serves it — same admission + tenant fencing as every
    RPC, idle heartbeats, disconnect teardown — from an injected per-run event
    source. The managed daemon wires it end to end: a bounded, tenant-fenced
    per-run trace-bus registry whose resolver atomically replays the ring and
    live-subscribes the bus, so a client replays THIS run and streams it live
    with no gap. The cf-worker `/chat` streams now interleave the same
    TraceEvent vocabulary — each workflow step brackets a `step_start`/
    `step_end` pair with its real token usage + cost — all gated on
    `observability.trace` (an explicit `off` suppresses every frame; text and
    `done` still flow).

  - **OpenTelemetry gen-ai spans (G58).** The OTel exporter maps the trace
    vocabulary onto OpenTelemetry gen-ai semantic-convention spans (model
    calls, tool use, cost accrual, approval requested/resolved, alerts,
    circuit-state changes, A2A messages, coverage reports, …) for export to
    `observability.otel.endpoint` when set.

  - **`program_output` tool events (G59) + failure triage (G63).** The bash
    and code-execution tools publish one `program_output` trace event per
    invocation carrying the captured program output; `crewhaus failures report
    [--propose-taxonomy]` clusters `run_failed` + incident records by failure
    class and message so a run's failure modes read at a glance.

- **Loop contract 0.4, Batch E — richer memory recall, agent-shape RAG, and
  the active-context curator wired end to end.** One coordinated batch lands
  the spec grammar, the IR, the lowering, the runtime seams, the affected
  emitters and the trace/printer surface:

  - **`knowledge:` — agent-shape RAG on cli/channel/managed (G22).** A new
    optional block registers the existing `@crewhaus/tool-retrieve` (chunker →
    embedder → vector-store) as a citation-bearing `Retrieve` tool, ingesting
    `sources: [{ path | glob | url }]` at build/boot: `embedder?`,
    `vector_backend?` (the same backend enum as pipeline `retrieve`), `chunk?:
    { size?, overlap? }` and `default_k?` (1..50). It reuses target-pipeline's
    retrieve engine, so the backend/`default_k`/chunk knobs resolve to the same
    defaults (`in-memory` / 5 / 400 / 0). `knowledge.default_k` +
    `knowledge.chunk.size` + `knowledge.chunk.overlap` join `OPTIMIZABLE_PATHS`
    (the `sources` corpus stays human-owned).

  - **`memory.autoRecall` gains a cadence + `refreshEvery` (G21).**
    `autoRecall` now accepts `boolean | "session-start" | "per-turn"`;
    `"per-turn"` (or declaring `refreshEvery: <int>`) re-runs the recall
    closure against the latest user message every turn (or every N turns) and
    swaps the volatile recalled tail block WITHOUT re-injecting into the frozen
    cache prefix. `memory.refreshEvery` joins `OPTIMIZABLE_PATHS`; declaring it
    alongside `autoRecall: false` is a loud compile error.

  - **`memory.sessionRecall` (G77).** Opting in folds session summaries in as a
    third RRF ranker in the recall fusion (default false).

  - **Default change — recall + capture ON when `memory:` is present (G46,
    mildly breaking).** With the `memory:` block declared, `autoRecall` now
    defaults to `true` (`"session-start"`) and `autoCapture` to `true` (behind
    the existing `autoCaptureThreshold` gate) — both previously defaulted to
    `false`. The resolved booleans are stamped into the IR at lower time. **Opt
    back out with `autoRecall: false` / `autoCapture: false`.**

  - **Active-context curator wired (G19).** The pre-declared `compaction.curate`
    / `dedupeThreshold` / `relevanceTopK` keys now drive an actual pre-compaction
    pass (`@crewhaus/compaction-curator`) inside runtime-core's `maybeCompact`,
    threading the embedder from `memory.embedder ?? memory.wiki.embedder` (BM25
    lexical dedupe when none resolves). Every pass publishes the new `curate`
    trace event (`before`/`after`/`dropped`/`bytesSaved`/`embedded`), rendered
    by the structured event printer.

  - **Thredz emit-wired on channel + managed (G23).** The one-knob `thredz:`
    block, previously carried-with-note off the cli shape, now synthesizes the
    thredz backend and boots `connectThredz` on the channel + managed daemons
    (research + crew stay carried-with-note this batch). `compile()` no longer
    warns `accepted-but-unwired` for `thredz` on channel/managed.

  - **Embedder resolution order (G76), documented and coherent:** fact-store
    recall + the curator resolve `memory.embedder → memory.wiki.embedder →
    BM25-only`; the wiki tier resolves `memory.wiki.embedder → memory.embedder
    → BM25-only`; agent-shape RAG resolves `knowledge.embedder →
    memory.embedder → memory.wiki.embedder → the target's default embedder
    model`.

  - **Prompt-cache rotation now survives a restart (G78).** The §2.5
    cross-run seam runtime-core always exposed
    (`promptCacheLastRotatedAt` in, `onPromptCacheRotated` out) finally has
    its promised persistence: `@crewhaus/prompt-cache-manager`'s
    `createPromptCacheRotationStore` writes the last rotation timestamp to a
    per-spec JSON record (`.crewhaus/prompt-cache/<spec>.json`, atomic, mode
    0600, path-safe spec name). A long-running channel/managed daemon reads
    it at boot and threads it back, so `manage()` REUSES the still-warm
    cached prefix across restarts instead of force-rotating (and cold-starting
    the cache) on every boot; a missing or corrupt record safely force-
    refreshes rather than bricking boot.

- **Loop contract 0.4, Batch F — the deploy half of the loop: a
  platform-neutral loop core, real tools on the edge, the temporal
  (`schedule:`) contract, exactly-once resume, and the develop/deploy/observe
  CLI verbs.** One coordinated batch lands the runtime extraction, the spec
  grammar, the affected emitters, the durable-execution surface, and the CLI:

  - **G12 — the agent loop is now a platform-neutral core,
    `@crewhaus/worker-runtime`.** The pure loop (turn FSM, model-stream
    orchestration, tool dispatch + validation + permission gating,
    budget/limit enforcement, loop detection, trace emission) is extracted
    behind an injected `WorkerPlatform` (clock, unique-id, `fetch`, optional
    KV). The package imports **no** `node:*` builtin and calls neither
    `Date.now()` nor `Math.random()` (a source-grep AND a bundled-import-graph
    test enforce both), so it runs on a Cloudflare Worker. `runtime-core`
    CONSUMES it — re-exporting its contract as the single source of truth and
    supplying the Node `WorkerPlatform` (`createNodeWorkerPlatform`) — while
    `runChatLoop`'s node-coupled services (event-log, session-store,
    compaction, recovery, audit sinks) wrap the shared engine; the three
    `target-cf-worker-*` emitters call `runWorkerLoop` directly with a
    stateless platform. The re-exports are purely additive — every existing
    `runChatLoop` / `RunChatLoopOptions` consumer compiles unchanged. v1 scope
    is tools + budget + limits + trace; compaction/recovery stay Node-only and
    a context overflow ends an edge run with a classified `context_overflow`
    frame rather than compacting.
  - **cf-worker targets run real tools now (G12/G83).** The old blanket
    "cf-worker does not support tools" rejection is replaced by a precise
    edge-safety gate — `@crewhaus/worker-runtime/tool-policy` (the single
    source of truth the compiler imports via a subpath so its offline gate
    never drags the loop into the compiler-worker's own bundle) plus
    `assertCfWorkerToolsEdgeSafe`. Edge-safe builtins
    (`fetch`/`webFetch`/`webSearch`/`sendMessage`/`imageGenerate`/`todoWrite`)
    and any `mcp__*` tool compile and run on the edge; host tools
    (`bash`/`read`/`python`/filesystem/device/…) fail the compile with a
    category-specific reason; an unrecognised custom tool is permitted with an
    `edge-unsafe-tool` warning. The emitted worker streams the same `/chat`
    SSE trace vocabulary (`turn_start`/`model_request`/`model_response`/
    `cost_accrual`/`tool_call_start`/`tool_call_end`/`turn_end`) the Node loop
    does.
  - **`schedule:` — the temporal contract (G84)** on the daemon-able shapes
    (channel / managed / batch): `kind: cron` (5-/6-field, timezone-aware,
    Quartz-tolerant) or `kind: interval` (`every`), plus per-wake `jitter` and
    an optional wake `instructions` prompt — all durations normalized to ms at
    lower time into `IrSchedule`. `@crewhaus/durable-execution`'s `armSchedule`
    (cron arithmetic + jitter + self-rescheduling, injectable timing seams)
    is the one tested home the channel and batch daemons arm; the managed
    daemon arms a per-tenant `setInterval`/cron wake. `CREWHAUS_SCHEDULE=0`
    disarms the loop.
  - **Exactly-once resume (G61, item 7).** `@crewhaus/durable-execution` gains
    `withIdempotency` (dedups a node/step attempt by `(runId, name,
    attempt)`), `resumeFrom` (the checkpoint-chain resume hint), and a durable
    `FileIdempotencyStore` + env-driven `createIdempotencyStore`
    (`CREWHAUS_IDEMPOTENCY_STORE=memory|file[:<dir>]`) so a restart of the same
    run finds the prior attempt's cached result instead of re-running its side
    effects. The managed daemon's `runs.continue`-with-sessionId resume path
    and the browser driver's `--resume`/`--continue` wrap the turn in
    `withIdempotency`, so a duplicate resume (client retry / visibility-lease
    double-pull) returns the cached reply instead of re-driving the turn
    (best-effort exactly-once; a crash between the external effect and the
    store write still re-runs at-least-once).
  - **CLI develop / deploy / observe verbs**: `crewhaus dev <spec>` (compile
    in memory, run the emitted bundle as a supervised child, recompile +
    relaunch on every spec/authoring-dir change, trace streaming, `--once` for
    a credential-free CI boot check); `crewhaus sessions tail [<session>]` (a
    `tail -f` over a session's append-only event log); `crewhaus compile
    --emit-as cf-worker` (emit the Cloudflare-Worker bundle locally for
    cli|workflow|graph — the same bundle the compiler-worker's remote
    `POST /compile { emitAs }` serves); `crewhaus deploy <fly|render|railway|
    heroku> <spec>` (scaffold PaaS deploy manifests for a daemon shape, with a
    provider-token-gated `--live`); and `crewhaus runs resume <session>` (the
    dedicated verb for re-driving a session parked on a pending approval).
  - **managed `agent.tools` + `tool_config` (G81)** lower onto the managed IR,
    and every emitted cf-worker bundle now ships a generated `README.md`
    (item 42).

## [0.3.2] - 2026-07-16

### Fixed

- **Compiled `crewhaus` binaries no longer crash at startup.** The standalone
  binaries (Homebrew/Scoop/apt/winget, built with `bun build --compile`) threw
  `ENOENT: … '/$bunfs/skills/continuity/SKILL.md'` on *every* command — even
  `crewhaus --version` — because `@crewhaus/default-skills` `readFileSync`'d its
  builtin skill/command `.md` files from a package-relative path at module load,
  which resolves into the binary's virtual `/$bunfs` filesystem where the files
  were never embedded. The bodies are now embedded at build time via
  `with { type: "text" }` imports of the same canonical `.md` files (single
  source of truth, no drift; the interpreter/`bunx` path still reads them from
  disk). Builtin slash commands (`/plan`, `/handoff`, `/dream`, …) are now fed
  to `loadCommands` as pre-parsed `builtinCommands` (mirroring
  `discoverSkills({ builtinSkills })`) so they survive in a compiled binary
  instead of silently vanishing when the on-disk `commands/` dir is absent. A
  release-workflow step now *executes* the compiled `linux-x64` binary
  (`crewhaus --version`) so a boot-crashing binary can never ship green again.

- **Two documented eval run-history limitations closed.** (1) *Baseline
  name-collisions.* Run-index entries and baseline pins now record the spec's
  `specSource` (its resolved source path), and `crewhaus eval` warns when a
  run's `(specName, datasetName)` baseline was pinned by a *different* spec
  file — the real footgun when two distinct specs share a `name:`. The lineage
  is still keyed on `(name, dataset)` and never re-keyed, so an *edited* spec
  keeps gating against its pre-edit baseline (that is the whole point of the
  gate); only a genuine cross-spec collision warns. Additive and back-compat —
  baselines pinned by an older CLI (no `specSource`) simply skip the check.
  (2) *Matrix crash reasons.* `eval --models` still flags an all-errored cell
  as a crash (it produced no comparison data), but `cellCrashReason` now
  classifies the error — `billing` (quota/credit exhaustion, including the
  non-retryable OpenAI/Gemini 429), `systemic` (auth/config/model), or
  `transient` (rate limit / 5xx / timeout) — so a one-sample cell felled by a
  transient blip no longer reads identically to one felled by a bad credential
  or an out-of-funds account. The two "Known limitations" notes are removed
  from the CLI README.

## [0.3.1] - 2026-07-15

### Fixed

- **Compiled agent-loop bundles crashed at boot — the published
  `@crewhaus/default-skills` tarball was missing its runtime data files.**
  Continuity is default-on in 0.3.0, so every compiled cli/channel/managed/
  research/crew bundle imports `@crewhaus/default-skills`, whose `dist/index.js`
  `readFileSync`s `skills/<name>/SKILL.md` and `commands/<name>.md` at boot. The
  publish step (`scripts/release-prep.ts --for-publish`) hardcoded the packed
  `files` allowlist to `["dist", …]`, dropping every uncompiled data dir — so
  `@crewhaus/default-skills@0.3.0` shipped `dist/` but not `skills/`/`commands/`,
  and a compiled bundle died at boot with `ENOENT` before it ever reached the
  credential boundary (compile itself always succeeded). Six other packages that
  ship a `templates/` dir were affected the same way (`boundary-classifier`,
  `compliance-controls`, `cost-tracker`, `data-retention-engine`,
  `metrics-collector`, `migration-runner`). `--for-publish` now maps the existing
  `files` allowlist `src` → `dist` and **preserves every other entry**, so data
  dirs stay in the tarball; a `bun pm pack` smoke over the real
  `@crewhaus/default-skills` pins that its `skills/`/`commands/` files ship, and
  `scripts/` tests now run in CI. Recompiled or freshly installed bundles boot
  cleanly on 0.3.1.

- **`$0` cost and `0` tokens on an unpriced model.** `cost-tracker` used to
  early-return on a pricing-table miss and publish nothing, so a
  `model_response` for a model with no pricing row emitted no `cost_accrual` at
  all. Because the studio cost tile accrues both dollars AND tokens from
  `cost_accrual`, a single unpriced call zeroed the whole tile. `cost-tracker`
  now still publishes a `cost_accrual` on a miss — carrying `costUsdMicros: 0`
  (there is no rate to charge) and the REAL `inputTokens` / `outputTokens` /
  cache token counts, flagged with a new optional `unpriced: true` on
  `CostAccrualEvent` so consumers can tell "genuinely free" from "not priced".
  The token tally now survives an unpriced model, and this is exactly the shape
  `runtime-core`'s alert-watchdog already scanned for
  (`costUsdMicros === 0 && inputTokens + outputTokens > 0`) — its pricing-miss
  detector now actually fires, where before nothing emitted that event.
  Priced responses are unchanged (byte-identical accrual, `observed()` still
  counts only priced calls).
- **Pricing / capability / sunset tables refreshed to the current model
  families (2026-07-14).** The tables topped out at `claude-opus-4-7` /
  `claude-sonnet-4-6`, so `claude-opus-4-8`, `claude-sonnet-5`,
  `claude-fable-5` (and their Bedrock forms) either missed outright or resolved
  at a stale family-base rate. Added rows for the current Anthropic models
  (Opus 4.8 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50, per the
  Anthropic pricing reference), bumped OpenAI (`gpt-5.1`) and Google
  (`gemini-3-pro`) to current families, and added bare-family fallback rows
  (`claude-opus` / `claude-sonnet` / `claude-haiku` / `claude-fable`) so a
  future next-major id resolves at the current rate instead of silently
  missing. `DEFAULT_CAPABILITIES` and `KNOWN_SUNSETS` were updated in lockstep;
  the table `version` is now `2026-07-14`. Existing rows (including the legacy
  `claude-opus-4-7`/`4-6` $15/$75 lineage) are preserved for historical
  re-aggregation.

## [0.3.0] - 2026-07-14

v0.3.0 — **the memory release**: every agent-loop harness now remembers.
Continuity — persistent focus, plans, and goals with a claimed→proven proof
ladder, plus a verbatim requirements ledger that survives compaction — is ON
by default (`continuity: false` is the one-line opt-out that restores your
0.2.x bundle byte-for-byte). One knob — `thredz:` — flips the memory fabric
onto a hosted Thredz wiki; a `learning:` block turns any harness into a
self-teaching expert; `memory.dream` consolidates what was learned on a
schedule; and when a run dies it now says WHY — classified billing / auth /
rate-limit failures with remediation lines and meaningful exit codes instead
of "agent exited".

### Upgrade notes (0.2.x → 0.3.0)

- **Recompile your bundles.** Compiled 0.2.x artifacts keep running as-is,
  but everything in this release lands at compile time — recompile each spec
  (`crewhaus compile …`) to pick it up.
- **Continuity is default-on** on cli/channel/managed/research/crew:
  recompiling without any spec change wires the continuity fabric. Add
  `continuity: false` to restore your previous bundle byte-identically
  (pinned by the byte-diff suite). `crewhaus upgrade` prints this note — and
  the two below — for exactly the specs they apply to.
- **`crewhaus migrate memories [--dry-run]`** — optional, idempotent v2
  backfill for existing `.crewhaus/memories/*.jsonl` fact stores
  (provenance/TTL/status fields). Old stores keep reading without it.
- **Thredz needs `THREDZ_API_KEY`.** A spec with `thredz:` fails fast at
  boot (exit 21) when the variable is missing; the key resolves from the
  running process env and is never baked into compiled artifacts. The same
  applies to any `mcp_servers` env/headers `$VAR` refs, which are now
  secret-lowered (see the BREAKING note under Changed).
- **Exit codes are meaningful now**: 0 ok · 1 generic · 20 spec · 21 config ·
  30 auth · 31 provider funding · 32 quota/rate-limit · 33 crewhaus budget
  cap · 40 tool/MCP — the documented `EXIT_CODES` table in
  `@crewhaus/errors` (mirrored in the CLI reference). Update any automation
  that pattern-matched on a bare exit 1.

### Added

#### Continuity & planning

- **Continuity is ON BY DEFAULT — the release's one sanctioned behavior
  change (0.3.0 Goal 1, PR 11).** Every agent-loop harness — **cli, channel,
  managed, research, crew** — now compiles (and `crewhaus run`s) with the
  continuity fabric wired without any spec change: persistent focus/plans/
  goals with the claimed→proven proof ladder (FocusRead/FocusWrite,
  PlanRead/PlanUpdate/PlanComplete, Goal*, MemoryClear), the §2.3 verbatim
  requirements ledger, the deterministic teardown `handoff.md`, and the
  builtin `continuity` skill + slash commands merged at lowest precedence.
  **Opting out is one line — `continuity: false` — and restores your
  previous bundle byte-for-byte** (pinned by a byte-diff test suite against
  pre-PR-11 fixtures — default-on continuity is the only way recompiles
  differ). The new top-level `continuity:` block accepts the
  boolean shorthand or a strict object (`enabled`, `plan`, `proof:
  ladder|require|off`, `ledger`, `handoff`, `scope: auto|spec|session`,
  `focusMaxChars`); `scope: auto` resolves per shape at lower time —
  cli/research/crew → `spec`, channel → per-conversation `session` stores
  riding the session router's sessionId (heartbeat ticks read the daemon's
  own `spec`-scoped agenda), managed → `spec` + tenant fencing at boot.
  `proof: require|off` are carried (spec → `IrContinuity` → the wireMemory
  fragment) but degrade to the ladder with a boot note until tool-plan grows
  a proof-mode seam. workflow/batch/voice/browser specs may declare the
  block (NOT default-on there) and compile with the 0.2.3-convention
  `// note: continuity configured but ignored on <shape> in 0.3.0` comment;
  graph/pipeline/eval/onchain/onchain-game reject it loudly (strict union).
  Under `crewhaus eval` (and therefore the optimizer) every sample gets
  ephemeral stores namespaced inside its own artifact directory, pinned by a
  two-sample leak test — plan/focus/handoff from sample N never leaks into
  sample N+1 (§7.2). A validation-only `memoryIntegrityPass` joins the
  ir-passes DEFAULT_PIPELINE (`crewhaus lint`): wiki.recallK bounds, the ttl
  floor, session-scope-only-on-channel, and fragment JSON-serializability
  (the load-bearing copies of those rules live in `lower()` itself).

- **The runtime-core continuity seam: compaction can no longer eat a user's
  requirements (0.3.0 Goal 1, PR 8).** The release's motivating failure — a
  clarification answer living in the middle of message history was deleted
  by `snip`, paraphrased away by an unverified `autoCompact` summary, and
  the model re-asked the question — is now un-reproducible even when the
  model misbehaves, and the fix is deterministic infrastructure with zero
  model trust. New `RunChatLoopOptions.continuity` seam (injected closures,
  like `memory`): when present, runtime-core appends a **volatile tail** of
  system blocks (`<current_plan>` + `<requirements_ledger>`) AFTER the
  cache-marked frozen prefix, rebuilt on every model call (hard-capped at
  the exported `DEFAULT_CONTINUITY_TAIL_MAX_CHARS` = 4096 chars, ledger
  first, oldest-first truncation with markers) — prompt-cache-manager gains
  a `volatile: true` block flag that `manage()` never marks, plus a
  dedicated regression suite pinning that the tail sits after the marker
  and tail edits never strip or move it. **Requirements ledger (§2.3)**:
  before `snip` drops middle messages and before `autoCompact` replaces
  history, every evicted USER message is appended VERBATIM to the session
  event log as the new additive `context_evicted` kind and folded into the
  in-run ledger (16KB cap, oldest-first eviction, `[ledger truncated]`
  marker); evicted assistant text and tool findings are persisted as
  `context_evicted` too (episodic externalization — recall integration
  lands later). The ledger re-injects on every call, `--resume` rebuilds it
  deterministically from the logged events, the autocompact summarizer's
  prompt receives it as an anchor (nothing depends on the summary being
  right), and `compaction` event-log records now persist the **summary
  text** beside the before/after counts. The per-run `_runState`
  state-store gets its first consumer: plan-mutating tools set
  `"plan.dirty"` through the RuntimeBridge's new `runState` field and the
  loop re-renders the plan tail via `continuity.onPlanDirty` before the
  next model call. **Handoff (§2.8)**: `continuity.onHandoff` fires exactly
  once at teardown (the `memory.onCapture` finally slot) with a
  deterministic `HandoffInput` — plan snapshot, ledger entries, session id,
  stop reason; no model calls. **Cache-rotation bookkeeping (§2.5)**: a
  boot-time marker rotation now publishes the new `cache_rotation` trace
  event and invokes the new `onPromptCacheRotated(rotatedAt)` option, and a
  fresh `promptCacheLastRotatedAt` genuinely skips the force-rotation —
  the previously dead wiring is live (store persistence lands with
  memory-service/threading). An ABSENT seam is byte-identical to before:
  no tail blocks, no `context_evicted` events, an unchanged summarizer
  prompt — regression-pinned, alongside the motivating-failure
  reproduction test itself (evict the answer, force snip+autocompact,
  assert the next rendered model input still carries it verbatim, resume
  and assert again). Spec/IR/emitter threading is PR 11; this PR is the
  runtime seam only.

- **v0.3.0 continuity substrate (Goal 1, PR 7): `@crewhaus/continuity-store` +
  `@crewhaus/tool-plan`.** Two new packages carrying the memory release's
  focus/plans/goals layer — packages only; runtime/compiler/CLI wiring follows
  in the later PRs of the train.
  - `continuity-store`: human-readable artifacts under
    `.crewhaus/state/<spec>/` — marker-gated `focus.md` (capped body + the
    verbatim `REQ-nnn` requirements ledger + active-plan pointer),
    `plans/plan-NNNN-<slug>.md` (YAML frontmatter + numbered steps),
    `goals.yaml`, and a deterministic `handoff.md` render (no model calls).
    The `open → in_progress → claimed → proven` proof ladder is
    machine-checked: `proven` requires `toolUseId` evidence resolved against
    session event logs (sub-agent child sessions included via the
    `sub_agent_start` brackets); proven transitions pin cited sessions in
    `.crewhaus/retention.json` and freeze `{toolName, inputHash,
    resultDigest}` excerpts so evidence outlives the transcript TTL. Clearing
    goes through `.crewhaus/trash/<ts>/` with restore — never a hard delete
    (`moveToTrash` is exported for other stores to adopt). Writes are
    tmp+rename atomic under an advisory `.lock` (wait 2s → steal stale >30s
    with a warning → fail naming the holder pid). Session-scoped stores and
    fail-closed tenant path fencing follow the session-store rules.
  - `tool-plan`: the tool surface — `FocusRead`/`FocusWrite`, `PlanRead`/
    `PlanUpdate`/`PlanComplete`, `GoalWrite`/`GoalUpdate`/`GoalList`, and
    `MemoryClear` (destructive + `requireJustification`). `PlanComplete` is
    the proven transition and rejects unverifiable citations with an
    instructive error. Mutations emit the new additive event kinds
    `plan_update` / `goal_update` / `action_proof` through an injected
    `appendEvent` seam (no runtime-core dependency).
  - `event-log`: additive `plan_update`, `goal_update`, `action_proof` kinds +
    exported payload types (readers skip unknown kinds by design).
  - Docs-repo module briefs (292+) for the new packages are a follow-up in the
    docs repository.

- **Default skills and builtin slash commands** (`@crewhaus/default-skills` —
  PR 12 of the v0.3.0 memory train). The product now ships three skills:
  `continuity` (read the plan first, pin user requirements as verbatim REQ
  entries, claimed-vs-proven status honesty with `PlanComplete` toolUseId
  evidence, bias to action, accurate handoffs), `learning-loop` (the expert
  demo's ANSWER/STUDY/REFLECT/EXAM modes productized, templated at compile
  time via `renderSkill` with `{{domain}}`/`{{curriculum}}`/`{{sources}}` —
  strict both ways, so a missing or typo'd substitution throws), and `dream`
  (the consolidation playbook consumed by scheduled dream ticks). Bodies ship
  both as exported string constants (compile-time embeddable into bundles)
  and as real SKILL.md files (runtime-discoverable); either way they pass the
  same `skill`-TrustOrigin classification as any other skill, and a
  content-lint test pins every tool name they mention to the real v0.3.0
  tool vocabulary. `discoverSkills` gains a `builtinSkills` option merged at
  lowest precedence — `~/.crewhaus/skills` and `.crewhaus/skills` override
  builtins by name, and an empty-body override disables one. `loadCommands`
  gains builtin (`builtinDirs`) and user-level (`~/.crewhaus/commands`) roots
  below the existing project root, and eleven builtin commands ship: `/plan`,
  `/focus <text>`, `/next`, `/handoff`, `/clear-plan`, `/clear-focus`,
  `/forget <query>`, `/study`, `/reflect`, `/exam`, `/dream`. Emitter and
  interpreter wiring land in later PRs of the train.

- **Sub-agents are no longer memory-blind, and their failures are no longer
  swallowed (0.3.0 §7.1, PR 13).** `spawnSubAgent` threads four seams from
  the parent's bridge into child loops: `memory` — recall ON via the
  parent's own recall closure (recalled context reaches the child's system
  prompt through the same injected seam; `autoRecall` respects the parent's
  setting) and capture OFF by construction (the projected seam cannot carry
  the write closures — parents own memory writes); `skills` — children
  finally see the "Available skills:" prompt block, not just the
  catalog-inherited Skill tool; `failureTaxonomy` — child recovery consults
  the same named classes; and READ-ONLY `continuity` — `loadPlan` renders
  the `<current_plan>` tail in child loops while `onPlanDirty`/`onHandoff`/
  the ledger stay parent-side. Child terminal errors are CLASSIFIED at the
  spawner boundary instead of dissolving into a `[sub-agent error]` string:
  non-fatal classes surface as an `is_error` tool result carrying structured
  `{isError, failureClass, report}` content (the run continues), while a
  billing/auth-class failure inside a child rethrows `RunFailedError` after
  the `sub_agent_end` bracket bookkeeping — tool-executor, the streaming
  executor, and `recover()` all pass an already-classified report through
  verbatim, so a billing failure anywhere ends the whole run with the
  child's report (same `run_failed` event + coded exit as a top-level
  halt). Auto-capture finally SEES sub-agent findings: memory-store gains
  `turnsFromEventsWithChildren` (walks the parent log's `sub_agent_start`
  brackets into child session JSONLs — lazy reads, capped at
  `MAX_CAPTURE_EVENTS_PER_CHILD` = 2000 events per child) and
  `captureChildFacts` (child facts land with
  `provenance {sessionId: <childSessionId>}` plus a `subagent:<name>` tag);
  `crewhaus run`'s onCapture is wired (the target-cli emitter mirror is
  deferred to the memory-service refactor with a marked TODO). Attribution:
  `createIsolatedContext` stamps `agentIdentity {subAgentId: <name>}` on
  every child RunContext, and tool-plan's `plan_update`/`goal_update`/
  `action_proof` payloads record the formatted identity (e.g.
  `subagent=researcher`) when one is set. Spawning with none of the new
  options behaves exactly as before (regression-pinned).

- **`crewhaus init --interactive` is a real conversation** (v0.3.0 §2.9,
  PR 18 — the scene of the release's motivating failure, rebuilt). The model
  path is no longer a single-shot forced `emit_spec` call that read one
  stdin line and silently discarded everything else: it now boots a
  persisted, resumable `runChatLoop` session with TWO tools and NO forced
  toolChoice — `ask_user` (the clarifying question is surfaced on the
  terminal and the answer arrives as the next user message over the
  multi-turn REPL) and `emit_spec` (same `{ yaml }` contract; `parseSpec`
  failures return to the conversation as tool errors the model fixes
  in-context). The continuity fabric is ON for the interview itself — the
  same `wireMemory` composition-root call every harness makes, spec-scoped
  as `init-<dirname>` under the target directory — so REQ pinning
  (FocusWrite), the verbatim requirements ledger, compaction protection, and
  the teardown handoff protect the creator conversation too; the
  interviewer's system prompt is a focused variant of the continuity
  discipline (turn-1 verbatim REQ extraction echoed back, confirmed REQs
  never re-asked, a REQ → spec-field mapping listed before emitting, which
  the CLI prints after `wrote crewhaus.yaml`). New flags:
  `init --interactive --resume` restarts a saved interview — the first
  assistant message resumes from the ledger ("Resuming: N requirements
  confirmed, M open questions …") with no work redone — and `--yes` skips
  the conversation. A terminal failure mid-interview (billing/auth/token
  exhaustion) prints the classified FailureReport plus "Your interview is
  saved — `crewhaus init --interactive --resume` continues where it
  stopped." Without a TTY the conversational path is refused (the scripted
  questionnaire runs instead); the no-credentials scripted fallback is
  byte-identical to before (subprocess-pinned).

#### Memory & wiki

- **`memory:` is now emit-wired on channel, managed, research, and crew —
  and crew carries it for the first time (0.3.0 §9, PR 11).** The block was
  previously parsed and lowered on channel/managed/research but silently
  ignored by their emitters (only target-cli wired it); all four daemons now
  make the same single `wireMemory` composition-root call as target-cli —
  per turn with the conversation's `sessionScope` on channel, per turn with
  the request's tenant on managed (stores tenant-fenced, §2.7), once at boot
  on research (every branch shares the catalog) and crew (roles share the
  spec-scoped stores through the orchestrator's new crew-wide
  `extraTools`/`memory`/`continuity`/`skills` RunOptions — the plan IS the
  coordination surface). The block itself gains the §9 extensions, all
  optional and byte-neutral for existing specs: `backend: file|thredz`
  (thredz reserved until PR 16), `ttl` (explicit fact forgetting as a
  duration string — the shared duration grammar now accepts `d` for days,
  e.g. `90d`, with a 1h floor enforced at compile time; `heartbeat.every`
  accepts `d` too), and `wiki:` (`enabled`, `recallK`, `embedder`,
  `autoRecall`, `requireSources`) — `wiki.autoRecall: true` fuses the
  top-`recallK` wiki hits into the session-start recall bundle alongside
  fact recall.

- **memory-store v2 — explicit forgetting, provenance, and hybrid recall**
  (0.3.0 memory release, design §3.4). Memory entries gain additive JSONL
  fields: `schemaVersion` (2 on new writes; absent = v1, read lazily),
  `expiresAt` (TTL via `remember(…, { ttlMs })`), `supersededBy`, and
  `provenance { sessionId?, evidence?: toolUseId[] }`. Mixed v1/v2 files read
  correctly in both directions. New store APIs: `forget(id|query)` appends
  supersede tombstones (the file stays append-only — never a hard delete),
  `sweep()` tombstones TTL-expired entries (deterministic, idempotent),
  `compact()` rewrites the file dropping dead lines (atomic tmp+rename — the
  growth-bounding answer to the #53 F7 unbounded-growth TODO), and `list()`
  materializes lifecycle status. Auto-capture is now proof-linked: captured
  facts carry `provenance.sessionId` and the source turn's successful
  `tool_result` toolUseIds as `provenance.evidence`. Passing an `embedder`
  to `createMemoryStore` upgrades recall to a hybrid BM25 + embedding
  reciprocal-rank fusion in which tool-grounded facts get a documented rank
  boost; with no embedder the BM25 ranking is byte-identical to before
  (regression-guarded).
- **`MemoryForget` tool** (`@crewhaus/tool-memory`): explicit forgetting by
  id or query — destructive AND justification-gated (Pillar 3 intent gate).
  `Remember` accepts an optional `ttlDays`.
- **`crewhaus memory list|show <id>|forget <id|--query <q>>|sweep [--compact]`**:
  inspect the per-spec fact stores (id/age/tags/provenance/status), explicitly
  forget memories, and run the TTL sweep + compaction. Destructive verbs
  preview their match set and prompt unless `--yes`.
- **`crewhaus migrate memories [--dry-run]`**: idempotent v2 backfill over
  `.crewhaus/memories/*.jsonl` via the migration-engine chain — stamps
  `schemaVersion`, derives `provenance.sessionId` from v1 auto-capture tags,
  preserves every other line verbatim, and records the store version in
  `.crewhaus/meta.json`.

- **`@crewhaus/wiki-store` — the local wiki substrate** (0.3.0 memory
  release, design §3.1). Update-in-place semantic memory under
  `.crewhaus/wiki/<spec>/`: markdown articles with YAML frontmatter (slug,
  title, tags, confidence, verified, version, sources, supersedes,
  createdBy), immutable prior versions under `versions/<slug>/<n>.md`
  (supersede, never delete), and a rebuildable `index.json` carrying
  `[[wikilink]]` link graphs. `write()` upserts with the Thredz PATCH
  optimistic-concurrency contract — a stale `expectedVersion` throws a
  `stale_article_version`-coded conflict, so skills behave identically on
  both backends. Retrieval is hybrid BM25 + optional embedder via
  reciprocal-rank fusion over contextual chunks (title + tags prefixed),
  followed by one-hop link expansion with a documented half-weight re-rank
  rule — a linked-but-lexically-unrelated article surfaces on recall.
  Mutations run under the §7.6 advisory `.lock` (wait 2 s → steal >30 s
  stale → fail naming the holder pid) with tmp+rename atomic writes, and
  every path is tenant-fenced fail-closed.
- **`@crewhaus/tool-wiki` — the thredz-identical wiki tool vocabulary**
  (design §3.2): `wiki_recall`, `wiki_semantic_search`, `wiki_search`,
  `wiki_get`, `wiki_write`, `wiki_list`, `wiki_related`,
  `wiki_set_signals`, `wiki_stats`, `log_knowledge_gap` — exact thredz-mcp
  names and schemas, pinned by a parity test. `wiki_write`/`wiki_set_signals`
  are destructive + justification-gated; `log_knowledge_gap` is
  audit-and-allow and, standalone, records gaps as draft wiki articles
  under the reserved `gaps/` tag (an injected `logGap` callback reroutes it
  to the plan store in the composition root). With `requireSources: true`,
  `wiki_write` deterministically rejects bodies without a `## Sources`
  heading (design §3.3's write-path governance). Mutations emit the new
  additive `wiki_write` event kind through an injected append seam.
- **New `memory` TrustOrigin** (Pillar 3, design §7.4): recalled wiki
  bodies are classified at origin `"memory"` (block tier, like `"skill"`)
  before reaching the model and lineage-tagged for the egress fabric;
  redact verdicts return the redaction notice instead of the body. Origin
  registered across boundary-classifier, run-context, and
  egress-classifier; tool-wiki joins the doctor `--philosophy-alignment`
  boundary-site checks.
- **`crewhaus wiki list|show <slug>|search <q>|stats`**: inspect the
  per-spec local wikis — stalest-first listing with signals
  (verified/confidence), full frontmatter + body for one article, BM25
  keyword search, and corpus-health stats.

- **The memory fabric's composition root** (`@crewhaus/memory-service` —
  PR 10 of the v0.3.0 memory train; closes module catalog critical-path #2).
  `wireMemory(fragment, {catalog, cwd, tenant?, sessionScope?, appendEvent?,
  embedder?})` takes one serializable fragment (spec name + memory config
  incl. wiki + continuity config incl. scope — the shape the §9 IR lowers
  into in PR 11) and does everything the per-emitter memory codegen used to
  template: constructs the stores (file backends; `backend: "thredz"` is a
  reserved discriminator that fails fast until PR 16), registers the tools
  (Remember/Recall/MemoryForget for facts; Focus/Plan/Goal/MemoryClear for
  continuity, honouring `plan: false`; the ten thredz-vocabulary `wiki_*`
  tools, with `log_knowledge_gap` routed into the plan store as a `[gap]`
  goal when continuity is on), and returns spread-ready `RunChatLoopOptions`
  seams — recall/onCapture over the fact store with the §2.4
  provenance-stamping capture path, loadPlan/onPlanDirty/onHandoff over the
  continuity store with the §2.3 ledger flag threaded, and the builtin
  `continuity` skill + slash commands merged at lowest precedence via
  `discoverSkills({builtinSkills})`/`loadCommands({builtinDirs})`.
  `wireContinuity`/`wireWiki` ship as granular entry points; scope
  (`spec`/`session`) and tenant fencing pass through to every store.
  **target-cli** and the **`crewhaus run` interpreter** now make this one
  stable call instead of inlining store/seam wiring: specs without a
  `memory:` block compile to byte-identical bundles (test-pinned, incl. a
  new `cli-memory` smoke fixture), and memory specs keep behavioral
  equivalence (equivalence-pinned recall/capture round-trips) with two
  sanctioned §3.4/§2.4 upgrades — `MemoryForget` is registered alongside
  Remember/Recall, and compiled bundles gain the provenance-stamping capture
  the interpreter already had. The wait-2s/steal-30s/fail-with-pid advisory
  file lock that continuity-store and wiki-store each shipped on parallel
  branches is unified into `@crewhaus/infra-utils`
  (`acquireFileLock`/`withFileLock`); both stores keep their exact error
  types and message prefixes (pinned by their existing lock tests).

#### Thredz

- **Thredz — one knob (0.3.0 Goal 3, §4, PR 16).** A new top-level `thredz:`
  block on the five memory shapes (cli, channel, managed, research, crew):
  `thredz: true` (≡ `{api_key: "$THREDZ_API_KEY"}`), the string shorthand
  `thredz: $THREDZ_API_KEY`, or the object form (`api_key` required and
  credential-lowered fail-fast; `base_url`; `visibility` defaulting
  **private** — never Thredz's shared-by-default; `goals` mirror on/off,
  defaulting to "on when continuity goals are on"; `agents` to register an
  addressable handle at boot). On the emit-wired **cli** shape the compiler
  synthesizes an `mcp_servers.thredz` stdio entry (`npx -y thredz-mcp@0.2.0`
  with `THREDZ_API_KEY` as an `IrSecretRef` env value and
  `THREDZ_DEFAULT_VISIBILITY` enforced deterministically) riding the §4.2
  secret machinery end-to-end — the key never lands in compiled artifacts,
  the generated README lists `THREDZ_API_KEY` automatically, `compile
  --strict` stays green, and a missing key at boot renders the classified
  config report (exit 21). A user-declared `mcp_servers.thredz` **wins over
  synthesis** (explicit beats implicit — the vendored-server escape hatch;
  `crewhaus lint` warns with the new `thredz-override` rule). **Tool
  routing (§4.3):** the model keeps ONE vocabulary — the ten
  `wiki_*`/`log_knowledge_gap` tools plus `goal_*`/`task_*` register as
  bare-name MCP aliases via tool-mcp's new `registerMcpToolAliases`
  (collision-guarded; `scope: "external"`, `ioCapability: "network"`,
  boundary classification + lineage tagging identical to namespaced MCP
  tools; `wiki_write`/`wiki_set_signals` keep their justification gate),
  while the local tool-wiki twins are not registered and the local wiki
  store on disk stays untouched. memory-service's `wireWiki` flips on the
  thredz backend (replacing the reserved-backend error) and the auto-recall
  fusion routes `wiki_recall` through the already-connected McpHost client
  with the same recall-bundle line shape. **Goal mirroring (§4.4, resolved
  decision 5):** continuity goal writes mirror to Thredz
  `goal_write`/`goal_update` at the store's write/update sync points — spec
  scope ONLY, local write always authoritative, mirrored titles
  PII-redacted, idempotency-keyed creates, and Thredz-side failures
  skip-and-warn (a free-tier goal cap surfaces as a clear `thredz_quota`
  warning) without ever failing the local write. **Failure classes
  (§4.4):** `classifyThredzFailure` maps the thredz-mcp v0.2.0 error
  contract on status/code shapes (401/403 → `thredz_auth`, 403-disabled →
  `thredz_billing`, 402/quota codes → `thredz_quota`, 429 →
  `thredz_rate_limit`, else `thredz_unavailable`); boot failures degrade to
  the local backend with an `mcp_boot` warning — Thredz codes never kill a
  run. **`crewhaus doctor --probe`** gains a live `wiki_stats` round-trip
  through the spec's thredz server (disabled keys and plan caps surface
  before a long run degrades on them). The non-cli memory shapes carry the
  block with the 0.2.3-convention ignored-note comment until their wiring
  lands. The real published server contract is pinned by a read-only
  integration test against thredz-mcp v0.2.0's `server.ts`.

- **Secrets can now reach MCP server child processes.** `mcp_servers` stdio
  `env` and sse `headers` values route through the same `$UPPER_SNAKE`
  secret machinery as every other credential field: plain strings stay
  literals, `$VAR` lowers to an env reference resolved from the *running*
  process's environment at boot (never baked into the artifact), and a
  malformed `$…` ref under a credential-shaped key (`*_KEY` / `*_TOKEN` /
  `*_SECRET` / `*_PASSWORD`, or the `Authorization` / `x-api-key` headers)
  fails compilation instead of shipping a broken credential.
  `@crewhaus/mcp-host` gains `resolveSecretRef` / `resolveMcpServerConfig`
  (throwing a `ConfigError` that names the missing variable), and its stdio
  transport now merges explicit `env` on top of the SDK's
  `getDefaultEnvironment()` — previously the SDK's inherit allowlist
  dropped arbitrary keys, so **no** factory path could deliver a secret
  (e.g. `THREDZ_API_KEY`) into a spawned MCP server at all. The
  `target-claude-plugin` emitter renders env refs as Claude Code's
  `${VAR}` expansion syntax in `.mcp.json`.

#### Dream

- **Dream — scheduled memory consolidation (0.3.0 Goal 5, §6, PR 14).** A new
  `memory.dream` block (`every` in the shared duration grammar with a 5m
  floor, `mode: deterministic|full` defaulting to `full`, `budget_usd`,
  optional `instructions` playbook override) lowers to `IrMemoryDream
  {everyMs, mode, budgetUsd?, instructions?}` on every memory-carrying shape
  and wires the new **`@crewhaus/dream-engine`**. A dream run is two phases:
  **phase 1, deterministic** (always; idempotent; zero model spend) — fact
  TTL sweep + near-duplicate supersede + `compact()` growth bounding,
  staleness flags (facts >90d, wiki unverified >30d — `STALE_FACT_AFTER_MS`
  / `STALE_WIKI_UNVERIFIED_AFTER_MS` exported), sessions-index fold-in (the
  item-57 machinery, lifted into `@crewhaus/session-store` as
  `summarizeSessionIntoIndex`), proof-excerpt re-validation + retention-pin
  refresh for records citing sessions nearing TTL, focus/handoff
  next-actions refresh from open plans, and the trash purge past the 7-day
  undo window (`purgeTrash`, now in continuity-store) — and **phase 2, model
  synthesis** (`mode: full` AND `budget_usd > 0`): ONE bounded fresh session
  (`sessionTarget: "dream"`, singleTurn, capped tool loop) seeded with the
  builtin `dream` skill + phase-1 findings, acting ONLY through the normal
  registered tools (`wiki_write`/`wiki_set_signals`/`MemoryForget`/
  `PlanUpdate` — full justification/audit path), capped by the item-27
  `budget` option, and **refusing to run an unpriced model** (cost-tracker's
  `pricingMisses` would make the cap a silent no-op). State lands at
  `.crewhaus/dream/<spec>/state.json` (`lastRunAt`/`lastOutcome`/
  `phase1Counts`/`lastEvidence`) plus an additive `dream_run` event-log
  kind; runs are **window-idempotent** (`dream:<spec>:<floor(now/every)>`
  through durable-execution's `withIdempotency`, backed by a lock-honoring
  file store) so a janitor tick, a GH-Actions cron, and a CLI invocation can
  never double-fire — including under `fleet run` parallelism. Triggers:
  runtime-core's janitor gains a **pluggable step registry**
  (`createJanitor({ steps })`, replacing the closed step union;
  `janitor_action` trace events for free) and the channel daemon registers
  the full dream step (managed registers a per-tenant deterministic one)
  with the conventional `CREWHAUS_DREAM=0` / `CREWHAUS_DREAM_INTERVAL_MS`
  knobs; the cli shape runs a **boot-time deterministic catch-up** when
  overdue (`[dream] overdue — deterministic pass done; run 'crewhaus dream'
  for full consolidation`); and **`crewhaus dream run|status|init`** ships
  cron-safe verbs (`init` scaffolds `.github/workflows/crewhaus-dream.yml`
  on the odd-minute convention). With a dream schedule configured, the
  builtin `dream` skill and the `/dream` command join the gated set
  memory-service wires.

#### Learning

- **Learning — continual learning as a first-class capability (0.3.0
  Goal 2, §3.3, PR 17).** A new top-level `learning:` block on the five
  memory shapes (cli, channel, managed, research, crew): `domain`
  (required), `curriculum` (agent-editable ladder file), `sources`
  (allowlist hints — deliberately NOT optimizable, §7.5), `exam:
  {dataset, graders}` (spec-relative paths; existence is a runtime
  concern), and `study: {on_heartbeat, on_dream}` (unattended-study
  toggles, both defaulting ON — the block is the opt-in, the toggles are
  the opt-outs). Learning **requires a wiki**: `memory.wiki` (local) or
  `thredz:` (hosted) must be present — cross-field CompilerError otherwise,
  mirrored in ir-passes' `memoryIntegrityPass` — and the lowering stamps
  `memory.wiki.requireSources: true` so `wiki_write` deterministically
  rejects uncited bodies (an explicit `requireSources: false` alongside
  learning is rejected as a contradiction). **Skill substitution:**
  `wireMemory` renders the builtin `learning-loop` skill with
  `{{domain}}`/`{{curriculum}}`/`{{sources}}` resolved (documented
  fallbacks when curriculum/sources are omitted — never a literal token in
  a prompt) and gates in the `/study` `/reflect` commands; a user/project
  `learning-loop` skill still overrides by name. **First-class EXAM:** the
  demo-era shell-out-to-`crewhaus eval` hack is replaced by an injected
  `ExamRunner` seam (`wireMemory({ examRunner })`) driving a new `run_exam`
  tool — a programmatic eval invocation (eval-runner's new
  `createExamRunner`: `loadDataset` + `parseGradersConfig` + per-question
  fresh single-turn sessions grounded in the REAL wiki through the
  backend-invariant `wireWiki(...).recall` seam and runtime-core's
  classified memory-injection path; per-sample artifacts under
  `.crewhaus/evals/exam-<stamp>/`). No Bash permission is ever needed to
  sit the exam; `/exam` gates in only when the exam is actually runnable
  (config + runner). **Failed exam samples auto-log knowledge gaps** —
  Thredz tasks (`log_knowledge_gap`, PII-redacted) on a live hosted
  backend, plan-store `[gap]` goals locally — closing the gap→study
  flywheel edge. Wired on the `crewhaus run` interpreter AND compiled cli
  bundles (the emitted bundle constructs the same runner). **Unattended
  study:** with `study.on_heartbeat`, target-channel-bot bakes the
  study-rotation preamble (gaps first, ~3:1 study:reflect, bounded per
  tick — the expert demo's HEARTBEAT.md policy, productized) ahead of the
  operator's heartbeat instructions at codegen time; with `study.on_dream`,
  the dream model phase's seeded prompt gains the top open `[gap]` goals +
  the next unmastered curriculum rung, composed onto dream-engine's
  existing `DreamModelPhase` seam. Absent `learning:` block, every emitted
  bundle stays byte-identical (golden-pinned against the PR 16 emission).

#### Failure messaging

- **Failure-taxonomy core: out-of-funding, bad-credential, and rate-limit
  errors are now classified instead of misrouted (0.3.0 Goal 6, PR 1).**
  `recovery-engine.classify()` gains three buckets ahead of the existing
  ones: `billing` (HTTP 402; Anthropic's out-of-credit 400 "credit balance is
  too low"; OpenAI's 429 + `code: "insufficient_quota"`; Bedrock's
  `ServiceQuotaExceededException`), `auth` (401/403 at runtime), and
  `rate_limit` (any other 429 — retried with the provider's `Retry-After`
  honored for the delay, capped at 60 s). Billing and auth resolve to the new
  terminal `{ kind: "halt", report }` recovery action immediately — no more
  tombstone detour for an empty Anthropic account or five futile backoff
  retries against OpenAI's `insufficient_quota`; rate-limit exhaustion halts
  as class `rate_limit` instead of a generic fail. Reports are built from the
  new `BUILTIN_FAILURE_CLASSES` table (billing_exhausted, auth_invalid,
  rate_limited, mcp_boot_failure, crewhaus_budget), consulted after user
  `failure_taxonomy` entries (user overrides win) and before the generic
  buckets. `@crewhaus/errors` gains the `FailureReport` shape (class, title,
  raw provider text, remediation, coded exit status, optional docs URL), the
  documented `EXIT_CODES` table (0 ok · 1 generic · 20 spec · 21 config ·
  30 auth · 31 provider funding · 32 quota/rate-limit · 33 crewhaus budget
  cap · 40 tool/MCP), a dependency-free `formatRunFailure()` renderer, and
  `RunFailedError` — thrown by runtime-core on a `halt` verdict; it extends
  `RuntimeError`, so `crewhaus run` keeps printing a clean one-liner (now
  with the failure title and provider text). The `failure_taxonomy` `hint`
  field — declared since §55 and never consumed — finally reaches the user:
  a matched entry that resolves terminally carries its hint as the report's
  remediation line. Unmatched errors behave exactly as before. The
  `run_failed` trace event, coded process exits, and adapter-side error
  discrimination land in the follow-up PRs.

- **Adapter error discrimination: all four provider adapters now surface the
  billing / auth / rate-limit signals the classifier reads (0.3.0 Goal 6,
  PR 2).** adapter-openai stops conflating every 429 into `overloaded_error`:
  the API body envelope (with its `code` — `insufficient_quota` vs
  `rate_limit_exceeded`) and the response headers now ride the `AdapterError`
  wrapper, so an out-of-funds account halts immediately (exit 31) while a
  genuine rate limit retries honoring `retry-after`; 401/402/403 pass through
  on status. adapter-anthropic additionally copies the response headers
  (Retry-After on 429s); its credit-balance 400 / 401 / 403 envelopes already
  flowed through intact and are now pinned end-to-end. adapter-gemini parses
  the REST error envelope out of `ApiError.message`: a 429 RESOURCE_EXHAUSTED
  whose QuotaFailure names a per-day / free-tier quota is billing-class
  (envelope `code: "insufficient_quota"`), any other 429 is rate-limit-shaped
  with google.rpc.RetryInfo's `retryDelay` threaded as the retry delay, and
  passthrough statuses (401/403) carry the parsed body message instead of a
  JSON blob. adapter-bedrock keeps the original Smithy exception name on the
  wrapper so `ServiceQuotaExceededException` (a hard account quota, HTTP 400)
  classifies as billing instead of being fabricated into a 429/overloaded,
  while `ThrottlingException`/`TooManyRequestsException` stay
  rate-limit-shaped; 401/403 pass through on status. `recovery-engine`'s
  `classify()` now consults the top-level `code` and the envelope
  `error.code` independently — the wrapper's own `code` slot holds
  CrewhausError's ErrorCode (`"adapter"`) and no longer shadows the
  provider's billing code. `circuit-breaker` fails fast: a billing-class
  error (new exported structural check `isBillingError`, tunable via the new
  `isFatal` option) trips the breaker on first sight instead of counting
  toward the 5-failure threshold — a dead account no longer needs five
  identical failures before the failover chain routes around it. Plain 500s,
  overloads, and 400s behave exactly as before (regression-pinned per
  provider).
- **One failure report, every surface: the structured `run_failed` event,
  coded process exits, and the end of "agent exited" (0.3.0 Goal 6, PR 3).**
  runtime-core now publishes a first-class **`run_failed { class, message,
  remediation?, exitCode }`** trace event AND appends the matching
  `run_failed` session-log record immediately BEFORE every terminal throw —
  the classified `halt` path carries its `FailureReport` verbatim, and even
  the generic `fail` path synthesizes a best-effort report (class `unknown`,
  exit 1), so structured consumers finally see WHY a run died (the old
  `error_recovered {action:"fail"}` carried only an error name). `halt` also
  becomes a first-class `error_recovered` action (PR 1's interim halt→"fail"
  wire mapping is gone); alert-watchdog and the SLO monitor count both
  `fail` and `halt` as unrecovered, incident-collector auto-captures a
  bundle on `run_failed`, and the structured-event printer renders the event
  as the canonical multi-line report block. **Compiled bundles** — the exact
  "agent exited" fix: target-cli's emitted `await runChatLoop(...)` and the
  channel-bot / crew / research daemon mains are wrapped in a catch that
  prints `formatRunFailure()` to stderr and exits with the report's coded
  status (no more unhandled Bun stack + exit 1); channel-bot heartbeat ticks
  render the classified report without crashing the daemon, and the managed
  daemon logs it and keeps serving. **`crewhaus run`**: `die()` special-cases
  `RunFailedError` — an out-of-funding run now ends with the full report
  (title, provider text, `Fix:` line, and "Your session is saved —
  `crewhaus run --continue` resumes exactly where it stopped." when a
  session exists) and exit 31, while every other fatal keeps the classic
  one-liner + exit 1. **`fleet run`** decodes coded child exits into
  `✗ support-bot — provider account out of funding · exit 31` rows plus a
  class-keyed rollup in the summary (`2 failed (billing ×1, auth ×1)`). New
  **`crewhaus doctor --probe`**: an opt-in ~1-token live call per configured
  provider (spec model verbatim + cheap defaults) that catches unfunded or
  invalid keys before a long run, classifying failures as billing/auth via
  recovery-engine. Successful runs and non-terminal recoveries emit no
  `run_failed` (regression-pinned).

#### Eval

- **Memory quality is now measurable: continuity graders + the store-backend
  conformance suite (0.3.0 §7.3/§5, PR 19).** New package
  `@crewhaus/grader-continuity` ships five DETERMINISTIC (no-LLM) graders
  computed from a sample's session artifacts — the eval-runner's isolated
  per-sample session JSONLs + `.crewhaus/` state root (§7.2) — installable
  with one call, `registerContinuityGraders(registry)`, exactly like the
  12-metric rubric: `continuity.reAskRate` (question-shaped assistant
  sentences whose content-token set is already ≥60%-covered by an earlier
  user statement or a confirmed REQ ledger entry from an earlier session —
  gate: 0, the motivating failure), `continuity.reqRetention` (fraction of
  requirement-marker user sentences that survive to the final context:
  unevicted, or carried by a focus-ledger REQ entry), `continuity.proofHonesty`
  (past-tense done-claims vs plan steps with a VERIFIED `action_proof`
  event; a `prove_step` without one is a proven-without-evidence anomaly →
  score 0), `continuity.pickupSuccess` (two-session samples: does session
  2's first assistant turn act on the handoff — references a next-action/
  plan cue, no re-asking, no re-planning from scratch), and
  `continuity.costPerProvenOutcome` (`cost_accrual` USD per verified proven
  step, Infinity-safe when zero steps are proven). Cross-sample roll-ups
  (`summarizeContinuityMetrics`, p50/p95/p99 + pass fractions + threshold
  breaches, plus the cost ratio's own summarize) match the rubric's
  summarize shape, and `renderContinuitySummaryLines` emits the report
  lines. Eval configs opt in BY NAME via the new `type: registry` grader
  entry (`grader: continuity.reAskRate`), resolved against
  `RunEvalOptions.graderRegistry` with the same placeholder pattern
  `llm_judge` uses; the runner now stamps `RunResult.artifacts`
  (sampleDir/sessionId/transcriptPath/stateRootDir/specName) so artifact
  graders find a finished sample's files without ever touching live stores.
  A worked two-session fixture (`CONTINUITY_FIXTURE_SAMPLES` + a scripted
  mock-adapter invoker that plays the conversations through the REAL
  event-log/continuity-store/tool-plan code paths) pins the discrimination
  matrix in tests: one clean run passes every gate, a re-asker fails
  re-ask/retention/pickup, a claims-without-proof run fails honesty — end
  to end through `runEval`. And the §5 promise — "local and Thredz are
  contract-identical" is a test, not a convention — lands as
  `runWikiBackendConformance` (exported from `@crewhaus/memory-service`, a
  test-kit function, not a test file): upsert version-conflict semantics
  incl. the literal `stale_article_version`, recall bundle shape, signals
  metadata-only (+ verified reset on content writes), list staleness
  ordering, visibility DEFAULTING TO PRIVATE, and `log_knowledge_gap`
  behavior, run per-check against a fresh backend from a factory. The file
  backend enrolls today (wiki-store's test suite, with a last-write-wins
  negative control proving the suite discriminates); the Thredz backend
  (PR 16) runs the same suite against a stub server.

### Changed

- **Recompiling an agent-loop spec produces a different bundle than 0.2.x:
  continuity is default-on** (see the headline entry above; sanctioned by
  ROADMAP.md's pre-1.0 policy). Add `continuity: false` to restore the
  previous bytes exactly. No other spec compiles differently unless it
  declared a `memory:` block on channel/managed/research — that block was
  dead config on those shapes and is now wired as documented.

- **BREAKING (IR, pre-1.0):** `IrMcpStdioConfig.env` and
  `IrMcpSseConfig.headers` are now `Record<string, IrSecretRef>` instead of
  `Record<string, string>`. Emitters embed the unresolved config and
  compiled bundles resolve it at process start; `redundantMcpServerCollapse`
  compares env/headers structurally, so servers that differ only in
  credentials no longer collapse into one.

### Fixed

- **`crewhaus fleet run <sub>` works from the compiled binary again.** When the
  single-file executable (`bun build --compile`) fanned a read-only subcommand
  across the fleet, it re-invoked itself as `[execPath, process.argv[1], …sub]`.
  Inside a standalone binary Bun rewrites `argv[1]` to the embedded-FS sentinel
  (`/$bunfs/root/crewhaus-…`) AND re-injects that entry on every spawn, so the
  child read the sentinel as its subcommand — every harness failed with
  `unknown subcommand: /$bunfs/root/crewhaus-…` and `fleet run doctor` reported
  `0 passed, N failed`, exit 1. The runner now builds its self-invocation via
  `fleetSelfInvokeArgv`, which omits the entry when compiled (Bun supplies it)
  and keeps the real script path under `bun run`. Affects `fleet run` for
  `doctor` / `eval` / `security digest` / `audit verify` alike. The source CLI
  was never affected.

## [0.2.4] - 2026-07-08

A focused fix release: a truncated or malformed tool call no longer bricks the
turn.

### Fixed

- **A truncated or malformed tool call no longer bricks the turn.** The
  Anthropic adapter consumed the SDK's high-level `messages.stream()` helper,
  which accumulates and `partialParse`s each tool call's input JSON as events
  arrive. When the model was cut off at `max_tokens` mid-arguments (or emitted
  slightly invalid JSON), that internal parse threw from inside the SDK
  (`JSON Parse error: Expected '}'`) — bypassing the runtime's own guarded
  accumulation and surfacing as an unrecoverable `recovery failed: JSON Parse
  error`. The adapter now consumes the raw `messages.create({ stream: true })`
  event stream, so the tool-input parse happens in our guarded code
  (`streaming-tool-executor` / `consumeStream` set `{ __parse_error: true }`)
  and the `max_tokens` recovery strips the orphan `tool_use` and asks the
  model to continue. Behaviour is unchanged for well-formed responses.

[0.3.0]: https://github.com/crewhaus/factory/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/crewhaus/factory/compare/v0.2.3...v0.2.4

## [0.2.3] - 2026-07-07

A focused fix release: declared `failure_taxonomy` recovery classes now
fire on every single-agent-loop shape, not just cli/channel/managed.

### Fixed

- Shape emitters no longer silently drop `failure_taxonomy` ([#296]). The
  workflow, graph, pipeline, research, batch, and browser emitters now thread
  the spec's taxonomy into their generated `runChatLoop` calls, and crew runs
  it crew-wide via the new `crew-orchestrator` `RunOptions.failureTaxonomy`
  (same scope as `permissionMode`/`permissionRules`). Previously only the
  cli/channel/managed emitters rendered it, so declared recovery classes
  (e.g. retry-on-429, continue-on-tool-timeout) never fired on the other
  shapes. Shapes whose runtimes cannot consume the taxonomy yet (voice, eval,
  onchain, onchain-game, cf-worker-*) now surface a
  `// note: failure_taxonomy configured but … ignored` comment in the
  generated bundle instead of dropping it silently. Bundles without the block
  stay byte-identical.

[#296]: https://github.com/crewhaus/factory/pull/296
[0.2.3]: https://github.com/crewhaus/factory/compare/v0.2.2...v0.2.3

## [0.2.2] - 2026-07-06

The adaptive-routing completion release: `agent.model_pool` learns ONLINE
(ε-greedy exploration [#287] and a Thompson-sampling bandit [#292]), explains
itself (`crewhaus route explain`, backed by durable `model_route` events
[#287]), works everywhere the single-agent loop runs (`crewhaus run` [#288]
and the pipeline/research/batch/browser shapes [#291]), and closes the offline
loop (`crewhaus advise` mines the reward scoreboard into eval-gated pool-policy
patches [#290], [#294]). The `rankFallbacks` seam is deliberately retired with
the rationale recorded in-code ([#293]).

### Added — adaptive model routing (P3: offline learning)

- **`crewhaus advise` mines the `model_pool` reward scoreboard**
  (`.crewhaus/routing/arms.jsonl`) into three new findings: a **policy-upgrade
  SpecPatch** (flip `model_pool.policy` to `learned` once every candidate has
  cleared the sample floor in a difficulty band), a **candidate-demotion
  advisory** (a candidate past the floor that trails the band best by ≥0.3 mean
  reward in every measured band — advice-only, because the candidate roster is
  human-owned), and a **stale-exploitation SpecPatch** (a converged `learned`
  pool with `explorationRate` 0 and a non-`thompson` bandit hard-commits to the
  argmax forever — propose `learning.explorationRate: 0.05`, preserving the
  block's other fields). `optimize --from-advice` eval-gates the patches through
  the existing accept/compose loop — no new optimize surface needed.
- **`OPTIMIZABLE_PATHS` gains the pool POLICY knobs only** —
  `["agent","model_pool","policy"|"routing"|"learning"]` on cli/channel/managed.
  `["agent","model_pool"]` wholesale and `["agent","model_pool","candidates"]`
  stay rejected, mirroring the standing `["agent","model"]` exclusion: learning
  tunes selection within the declared set, never the set.
- **`specHasPath(yamlText, path)`** in `@crewhaus/spec-patch`: whether the YAML
  source textually carries a key (Zod-defaulted fields are always present on
  the parsed spec, but `applySpecPatch` needs `add` vs `replace` to match the
  document) — used by the advise rules to emit the correct op.
### Fixed

- **`crewhaus run` now honours `agent.model_pool`.** The interpreted cli run
  path threaded `model_tiers` / `model_fallbacks` into the runtime but silently
  dropped `model_pool`, so `crewhaus run` ignored adaptive routing while the
  compiled cli bundle honoured it. `run` now threads it identically (disabled by
  a `--model` override, like the other routing blocks).
### Added — adaptive model routing (P4)

- **Thompson sampling bandit for `agent.model_pool` (`policy: learned`)**: a new
  `learning.bandit: thompson` (default `epsilon-greedy`) replaces the ε-knob with
  Gaussian Thompson sampling — each arm is drawn from its reward posterior
  `Normal(meanReward, varReward / n)` and the highest draw wins, so uncertain
  arms self-explore and the policy needs no exploration-rate tuning. Same
  transcript-seeded RNG, so it replays exactly; runs only after the sample-floor
  warm-up, and `epsilon-greedy` remains the default.
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

### Documentation

- **The `rankFallbacks` seam is deliberately retired, and the decision is now
  recorded in the code.** A design review concluded the factory runtime must
  never auto-reorder `agent.model_fallbacks`: the declared order is a trust
  contract (cost/quality routing belongs to `agent.model_pool`), a boot-time
  cache-aware ranking is a mathematical no-op (no observed traffic to price —
  and a pricing-table miss would sort an unpriced model first), and fallback
  order only matters in rare multi-fallback outage windows. Tombstone notes
  added to the `rankFallbacks` docstring, the model-router README, the
  `model_fallbacks` spec docs ("order the list yourself; order = trust
  order"), and cost-tracker's `rankCandidates` header (caveats for any future
  library caller). Revisit trigger documented: trip-time re-ranking, only if
  durable per-model cache telemetry becomes default-on.

[0.2.2]: https://github.com/crewhaus/factory/compare/v0.2.1...v0.2.2
[#287]: https://github.com/crewhaus/factory/pull/287
[#288]: https://github.com/crewhaus/factory/pull/288
[#290]: https://github.com/crewhaus/factory/pull/290
[#291]: https://github.com/crewhaus/factory/pull/291
[#292]: https://github.com/crewhaus/factory/pull/292
[#293]: https://github.com/crewhaus/factory/pull/293
[#294]: https://github.com/crewhaus/factory/pull/294

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

## [0.1.7] - 2026-06-30

The Claude-driven optimizer learns from real per-sample failure signal, and
gains a concurrency knob for low-rate-limit tiers.

### Changed

- **Optimizer now learns from real failure signal.** The model-driven mutator (`prompt-optimizer-claude`) previously saw only the aggregate dev score stamped on raw dev inputs — its `selectFailures` was a v0 stub, so `crewhaus optimize --mutator claude` guessed at fixes and overfit. `FitnessFn` return is widened to `number | FitnessResult` (backward-compatible); `FitnessResult.grades` carries per-sample `{input, score, expected?, rationale}` which the loop threads to the mutator via the new optional `OptimizerState.bestGrades`. The CLI's `optimize` fitness closure now returns each dev sample's overall score **and the grader's rationale**, so the mutator targets the samples the prompt actually fails and addresses the named root cause (e.g. "no source cited") instead of a generic rewrite. Result: `optimize` reliably lands a generalizing patch where it used to overfit or find nothing.
- **CLI `optimize` gains `--concurrency N`** (mirrors `crewhaus eval`; default 4). Each iteration runs a full eval pass on the dev set; on a low provider rate-limit tier the previous fixed fan-out of 4 tripped 429s. The nightly-flywheel path sets `--concurrency 1`.

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

## [0.1.3] - 2026-06-15

The §55–§59 integration batch: failure taxonomy + arbiter, verifier
synthesis, the meta-harness optimizer, a typed graph DSL, two-pass contracts,
the Claude-plugin target, Cloudflare-Worker targets, cloud-deploy adapters, and
the plugin/marketplace system.

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

### Documentation

- `docs/MODULE-CATALOG-STATUS.md` updated with §55–§59 rows pointing at the new packages.
- Each new/changed source file carries an inline docstring citing the underlying arxiv paper or article (the canonical record of *why* each piece exists).

### Verification

- `bun run tsc -b`: clean.
- `bun run test:smoke`: 17/17 pass.
- Full unit suite: 6016 pass / 0 fail / 2 skip across 440 files.

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
