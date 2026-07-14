# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
