# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.8] - 2026-08-27

### Added

- **The Hangar Advisor — every alert, suggestion, and optimization signal on
  one actionable surface** (#417). Each harness gains an Advisor tab and the
  fleet gains an Advisor board (worst-first: critical count, then open count,
  ties by name). The feed is derived, never invented: pure
  `deriveAdvisorItems` folds the signals other panels already read —
  preflight, the spec lint, eval health vs the pinned baseline, the cost
  fold vs the declared budget, incidents, parked approvals, overdue dreams,
  the advice feed — and its empty state IS the goal state ("running
  optimally"), not an error. Every item carries a hover tooltip saying what
  it means and when to act, plus a quick action: either a job queued through
  the existing job queue with argv from a CLOSED vocabulary
  (`ADVISOR_JOB_ARGV`), shown alongside its CLI twin, or a deep link to the
  screen that owns the fix — a suggestion is never an application, and spec
  writes stay on the spec write path. Decisions are records, not deletions:
  acting takes an optional comment, dismissing REQUIRES a reason, and both
  append to `<harness>/.crewhaus/advisor/decisions.jsonl` (reopen appends a
  superseding record). A trend strip folds the eval index so improvement
  toward optimal is visible at a glance; on-demand reports (model-usage,
  costs, usefulness, optimization) persist under
  `.crewhaus/advisor/reports/`; and an issue inbox turns a submitted issue
  into an update ready to run — queueing `optimize` (the eval→patch loop
  whose artifact is a reviewable spec patch), `eval`, `doctor`, `compile`,
  `advise`, or recording a `note` — with the issue text never reaching a
  command line. Routes ride the M3 grouped dispatch table (group
  `"advisor"`), inheriting every auth/id/body guard uniformly.

- **Library curation: the Hangar shows the harnesses you've added, not
  everything on disk** (#417). `hidden` is a first-class registry field
  (`setHidden` in `@crewhaus/harness-registry`; upsert refreshes never
  clobber it), surfaced on every `/api/harnesses` row and settable via
  `PUT /api/h/:id/visibility`, so the console folds hidden entries out of
  the default view — curation, not removal. `GET /api/registry/discover`
  walks the scan roots and reports harnesses NOT yet registered as
  candidates, registering nothing: the "find harnesses on this machine"
  flow, distinct from `POST /api/scan` (which registers everything it
  finds). Adding remains the default posture; discovery makes it a
  one-click one.

### Fixed

- **CI and the release path pin bun 1.3.11.** bun 1.4.0 (released
  2026-08-19) wedges `bun run --filter` on ubuntu-latest: every package
  suite completes and the parent process then never exits, idling until the
  6-hour job timeout while runner cleanup reports orphaned bun processes.
  ci.yml, release.yml, and smoke-runtime.yml — the PR bar and both release
  gates — now pin the last line this repo demonstrably completes under,
  re-floating together once a 1.4.x fixes the parent-exit hang.

- **hangar-ui's embedded-asset suite runs in its own test process.** bun's
  module registry keys modules by path and ignores import attributes, so a
  file first imported `with { type: "text" }` (the embed map) poisons a
  later plain-ESM import of the same path with its text stringification —
  and vice versa — in whichever order the suites load. The embed suite
  (renamed `src/embed-suite.ts`, off the default test glob) now runs as a
  second `bun test` invocation so neither import shape can see the other's
  cache.

## [0.5.7] - 2026-08-17

### Fixed

- **The default `llm_judge` works against the live Anthropic API again: the
  judge's pinned `temperature: 0` is no longer sent to models that reject
  the parameter** (#413). Claude 5-family models reject an explicit
  temperature with 400 `` `temperature` is deprecated for this model ``
  (Sonnet 5 rejects any non-default value; Opus 4.7+/Opus 5/Fable 5 reject
  the parameter outright), and `DEFAULT_JUDGE_MODEL` has been
  `claude-sonnet-5` since v0.4.2 — so every `crewhaus eval` with an
  `llm_judge` grader and no `--judge-model` override errored on ALL samples
  and read infrastructure-failed, masked in CI because judge tests use stub
  adapters. Three layers, mirroring the treatment `adapter-openai` already
  gives its reasoning models: `adapter-anthropic` gains
  `claudeRejectsTemperature(model)` (Opus ≥ 4.7 and the whole Claude 5
  family; search-matched so Bedrock `anthropic.`/regional prefixes survive,
  datestamps are never read as minor versions) and omits the mapping for
  those models — which also fixes the other pinned callers, e.g. the
  eval-runner's vision-OCR transcriber; the Anthropic-on-Bedrock body
  builder applies the same gate; and eval-judge adds a last line of defense
  for providers the gates don't know — on an error naming temperature as
  deprecated/unsupported, every judge path (scalar, categorical, pairwise)
  retries ONCE with the field omitted. The NEW-HUNT-2 pin is unchanged for
  every model that accepts it; on a model that rejects it there is no
  determinism to preserve — the parameter no longer exists there.

## [0.5.6] - 2026-08-14

### Fixed

- **`@crewhaus/runtime-core` declares `zod` as a runtime dependency.** 0.5.5
  shipped `list-tools.ts`, the first runtime-core source file to
  `import { z } from "zod"`, while `zod` sat in `devDependencies`. Inside the
  monorepo every import resolved through the workspace root, so the full suite
  and every release gate passed. `dist/index.js` imports `./list-tools`
  eagerly, so the gap bites wherever resolution honours a package's DECLARED
  dependencies: Bun's auto-install cache — the path a compiled bundle takes
  when it runs from a directory with no manifest — fails on load with
  `ENOENT while resolving package 'zod'`, and strict/isolated layouts fail the
  same way. A conventional hoisted `npm install` happens to survive it, because
  sibling packages (`tool-catalog`, `tool-builder`, `spec`) declare `zod` and
  hoist it to the top level; that is luck, not correctness. Two
  guards keep the class from recurring: a manifest test asserting that every
  external module runtime-core imports at runtime is a declared dependency,
  and a fix to the eval-bridge smoke so it resolves the IN-TREE packages the
  way its own documentation always claimed. It never did — an out-of-tree
  bundle in a manifest-free tmp dir resolved nothing, so Bun's auto-install
  quietly fetched `@crewhaus/*` from npm and the smoke measured the previous
  RELEASE instead of the working tree. That is both why 0.5.5 shipped green
  and why no release could be verified before it was published. The smoke now
  links the workspace beside each bundle and spawns with `--no-install`, so a
  missing link fails loudly instead of reaching for the registry; it is
  offline as a side effect.

- **The tool-concurrency test no longer measures the CI machine.** It budgeted
  105 ms of wall clock over 60 ms of tool work and failed routinely under
  load — 6/6 failures under CPU contention on the pre-0.5.5 tree, and it
  failed the v0.5.5 release run, which published nothing until the jobs were
  re-run. Widening the bound to 120 ms (the cost of SERIAL execution, the
  loosest bound that could still mean anything) failed on CI too, which
  settles it: on a loaded runner the concurrent path already costs what serial
  would, so no wall-clock number separates them. The assertions that prove
  overlap directly — both tools started before either finished — hold on any
  machine and are what the test keeps.

## [0.5.5] - 2026-08-14

### Added

- **`ListTools` — the runtime's live toolset, on demand** (#405). A session
  that enumerated its tools on one build, was parked, and resumed on a build
  with tools ADDED kept denying the new ones forever: the transcript's own
  stale enumeration beat the live schema attached to every request, and an
  agent declining to "fabricate" calls to tools it believes absent is
  behaviour we want, so arguing with it could not fix it. Two mechanisms break
  that deadlock. Every tool-carrying loop now advertises a builtin, read-only
  `ListTools` whose result is rendered from the tools bound to THAT request —
  names, read-only/destructive/gated flags, one-line descriptions, and a
  header stating outright that the conversation is the stale source, not this
  list. It joins the PascalCase bookkeeping family (`Skill`, `FocusRead`,
  `GoalList`) with a builtin `alwaysAllow`, so a headless run cannot park on
  the very tool that exists to break a deadlock. And on resume, when the
  advertised set differs from what the session last recorded, the runtime
  injects one synthetic `[system]` line naming exactly what was added and
  removed. The record is a new non-conversational `toolset` event written only
  on change (one line per session, not per turn), scoped per agent context so
  a crew's roles — which share one session log and legitimately carry
  different tools — never read each other's sets as a change, and skipped
  inside `a2a_turn_start`/`sub_agent_start` brackets for the same reason.
  Sessions predating the record get no marker on their first resume and are
  covered from then on. A zero-tool loop stays zero-tool, and a caller's own
  `ListTools` wins the name.

- **`mcp_servers.<name>.required: false` — optional MCP peers** (#406). A peer
  that could not be reached at boot took the whole daemon down with exit 40,
  which the supervisor's crash-backoff then escalated to `crash-looping`. That
  is correct for a tool the agent's instructions assume, and wrong for the
  peers whose absence is a normal state — above all two daemons that mount
  each other over `expose.mcp`, a topology where somebody must start second
  and therefore neither can start at all. Marking a server `required: false`
  makes a failed boot DEGRADE: the run continues without its tools and says
  so, naming the server. What follows depends on the shape, and the split is
  the honest one — the shapes that re-read their tool catalog per message, job
  or branch (channel daemons, batch workers, research runs) pick the peer's
  tools up whenever it finally connects, with no restart; the one-shot shapes
  (cli, crew, workflow, eval) freeze their tool list at boot, so they report
  the peer absent for that run and tear the connection down rather than leave
  it reconnecting behind finished work. Reconnection itself stays where it
  already lived, in `mcp-host`: the optional path watches for it to land
  instead of racing it with a second ladder. An unresolvable `$ENV` secret on
  an optional server degrades the same way instead of failing the boot, and
  preflight reports each optional server plus downgrades that secret from
  blocking to a warning. The default is unchanged and still fail-fast, and a
  spec without the opt-in compiles byte-identically.

## [0.5.4] - 2026-08-12

### Fixed

- **`expose.mcp` on a channel bundle now actually emits an MCP endpoint**
  (#394). A channel spec declaring `expose: { mcp: { transport: sse } }`
  lint-passed, compiled and booted, and served no MCP endpoint anywhere: the
  block was parsed, lowered to `IrExpose`, and read by NO emitter. Meanwhile
  `serve --mcp`'s refusal told operators a "channel/managed daemon
  self-exposes from its compiled bundle", the Hangar console computed a
  `"self"` projection state from the same unwired block, and the roadmap
  marked Batch G's `expose:` shipped — it was shipped for `cli` only, through
  `crewhaus serve --mcp`. A channel bundle now mounts its own endpoint at
  `/mcp` on the public port, delegating to the SAME `agent.runTurn` the
  adapters drive, so an MCP caller reaches the identical loop, memory fabric
  and permissions; boot prints the URL, the server closes on shutdown, and a
  spec without `expose` compiles byte-identically. The endpoint is
  AUTHENTICATED, unlike everything else on that port: the adapter routes are
  signature-verified per platform and `/healthz` is deliberately public, but
  MCP drives whole agent turns with the bundle's tools and credentials, so it
  takes the same bearer contract as `crewhaus.control.v1` —
  `CREWHAUS_MCP_TOKEN`, else a 32-byte token minted 0600 at boot, compared
  length-independently. Each MCP session maps to its own harness session, so
  two IDEs driving one daemon never share a transcript. Still honest about
  what is not wired: `expose.mcp` on MANAGED (its turn function is
  tenant-scoped, and which tenant an MCP caller drives is undecided),
  `transport: stdio` on a daemon, and `tools: "per-subagent"` on channel (the
  channel turn takes no routing argument, so N per-sub-agent tools would all
  drive the same undirected turn) now each WARN at compile time instead of
  looking live.
- **`mcp_servers: { … transport: sse }` reaches both HTTP MCP revisions**
  (#394). Our own two halves never agreed on the wire: `@crewhaus/mcp-server`
  serves MCP's 2025-03-26 **Streamable HTTP**, while the client built for
  `transport: "sse"` spoke only the 2024-11-05 **HTTP+SSE** revision — so a
  CrewHaus peer could never consume a CrewHaus `expose.mcp` endpoint. The
  legacy client's opening GET got `400 application/json`, which surfaced as
  `SSE error: Invalid content type` and made any A2A topology over MCP
  impossible. `sse` now means "HTTP, either revision": the client probes
  Streamable HTTP first, falls back to legacy, and remembers the winner so
  reconnects skip the probe. Third-party legacy servers — the reason the
  config value existed — are unaffected. A probe candidate's failure is the
  EXPECTED way the other wire is discovered, so it can no longer arm a
  reconnect that races the candidate about to succeed (the SDK fires
  `onclose` on a failed handshake before a caller can detach it, which left a
  healthy connection spontaneously reconnecting and orphaning live streams).
- **A one-shot approval grant can now satisfy a model-driven tool call**
  (#400). Grants are keyed on whole-input equality, which assumes the resumed
  run re-issues a BYTE-IDENTICAL call. It does not: resume re-drives the
  turn, `sanitizeOrphanToolUses` has stripped the parked `tool_use` from the
  replayed transcript, and the model generates the call fresh — so one
  re-worded argument moved the hash, the lookup missed, and the run parked
  again under a new id. Approve → regenerate → re-park, forever, which left
  `--always` (a STANDING allow on exactly the quota-spending and irreversible
  tools operators least want standing) as the only thing that landed a single
  call. When the exact key misses, the gate now runs THE INPUT THE OPERATOR
  APPROVED rather than the regenerated one — which is also what keeps the
  security property: an operator authorized a specific action shown to them,
  and that action is what executes. Guarded to the same session and tool, a
  grant from a PRIOR run, an unconsumed record that actually carries its
  input, and a decision made recently (the window tracks the approve→resume
  gap, so an unspent grant cannot be replayed onto an unrelated turn an hour
  later); approval ids are claimed synchronously so two concurrent calls
  cannot spend one grant; policy and the `pre-tool` hook are re-evaluated
  against the substituted input, and a deny wins. Both parties are told — the
  operator through a `permission_decision` event and a log line, the model
  through a note in the tool result, without which it would reason about an
  action that never happened. The exact-hash path is untouched.
- **A channel daemon no longer swallows an out-of-band grant** (#400). The
  emitted `resumeApproval` returned early with NO output when a granted
  approval had no captured inbound event — the state every `crewhaus
  approvals grant` and every post-restart grant lands in, since the resume
  map is in-memory. An operator saw nothing happen and could not tell a
  working grant from a broken one; it now says so, and states that the grant
  is live for the next message.

### Added

- **The nine Thredz agent-to-agent messaging tools, opt-in** (#401).
  thredz-mcp v0.3.0 advertises 27 tools and promises agent-to-agent
  messaging; `connectThredz` aliased 18, so an agent carrying `thredz:`
  reported `message_send` / `inbox_poll` / `agent_register` and the rest as
  absent — and with `expose.mcp` also unwired, a daemon fleet had no A2A
  fabric at all. The opt-in `thredz.messaging: true` had existed in the spec
  AND the IR since Batch G and nothing read it. The nine now register when
  the spec asks, and only then: `thredz:` is the MEMORY knob, and turning
  memory on must never silently widen the outward surface. Reads are
  readOnly, directory and mailbox mutations destructive, and `message_send`
  alone carries the Pillar 3 intent gate — it puts text in front of another
  agent, which is the visible-side-effect class the gate exists for, and
  gating the bookkeeping too would only train operators to wave it through.
  Wired on channel, managed, cli, and per-role on crew.

## [0.5.3] - 2026-08-12

### Added

- **Shared env files for a fleet** (#391). `loadEnvChain` read exactly
  `<harness>/.env` then `.env.local`, so sibling harnesses sharing one
  provider key had no first-class way to keep ONE env file — the working
  pattern was a `.env → ../.env` symlink per member, which works but is
  invisible convention (`harness show` and preflight reported the chain as
  if it were local, a copied harness silently carried a dangling symlink,
  and Windows symlinks are their own adventure). A harness now declares
  shared files in its own `.crewhaus/settings.json`
  (`{"manager": {"envFiles": ["../.env"]}}`); they load UNDER the
  harness-local chain, so precedence is unchanged (shared < harness-local <
  `process.env` < caller extras). The declaration is harness-local rather
  than a registry field because all harness state is cwd-local: an
  UNREGISTERED harness — the standalone-harness convention, and what
  `crewhaus daemon start` in a fresh directory is — behaves identically, and
  the declaration travels when the directory is copied. Resolution happens
  inside `loadEnvChain`, the one function `buildSpawnPlan` and the preflight
  gate both go through, so the env preflight checks stays the env the spawn
  receives by construction. A new `env` preflight area names every file in
  the chain (shared ones with the absolute path they resolved to) and WARNS
  — never blocks — on a declared file that is absent; `crewhaus daemon
  status` and `crewhaus harness show` render the same chain, in `--json`
  too, as files only and never a value; and the console's credential
  presence panel reads the same chain, so a key a fleet keeps in `../.env`
  no longer reads as "not set" while the daemon has had it all along.
- **Per-harness prep: opt-in recompile and operator hooks** (#388, #389).
  Two things a supervised fleet lost that the standalone `run.sh` wrappers
  it replaced already had. Nothing recompiled for you, and a stale bundle
  was only ever REPORTED — forget one recompile after a spec edit and the
  daemon restarts on the OLD bundle with no error. `crewhaus daemon
  start|restart|submit --compile` now recompiles IF the spec is newer than
  the bundle (the same spec-hash verdict the fleet views show, into the
  directory the current bundle lives in), runs `bun install --cwd <bundle>`,
  and only then preflights and spawns; `manager.autoCompile: true` makes it
  a harness's default so the console's Restart button gets it too. An
  inexact (`unstamped`/`unknown`) verdict never triggers a recompile. And
  there was no hook point at all: `daemon start` spawned the existing bundle
  directly, a console compile job silently discarded whatever the operator
  had patched into it, and `restart` rebuilt the spawn plan but never re-ran
  operator prep. Harnesses now declare their own steps —
  `manager.hooks.postCompile` / `manager.hooks.preSpawn` — run in the order
  `compile → postCompile → preflight → preSpawn → spawn`, inside the start
  slot so two managers cannot recompile one bundle at once. A hook that
  exits non-zero or times out REFUSES the start exactly like a blocking
  preflight finding, carrying the step's own output, scrubbed at the capture
  like the run log. A string declaration is one command and is NOT
  word-split; arrays are argv vectors; nothing goes through a shell. A new
  `hooks` preflight area discloses the commands a start will run (and warns
  when one failed last time, or has never run on a harness that HAS runs);
  `daemon status` reports the prep contract and each hook's last run, and
  `harness show` names the hooks. The console's compile job now runs
  `postCompile` too, so a manager-initiated compile and `start --compile`
  leave the same bundle — and a compile whose hook fails is a failed job,
  not a green row over an unpatched bundle.
- **`crewhaus daemon submit --brief-file` — crew targets under supervision**
  (#390). The supervisor classed `target: crew` as `daemon` and launched it
  detached with no stdin, but a compiled crew bundle REQUIRES its brief
  there and exits 2 without one — and 2 is not in the terminal code set, so
  the supervisor read that instant exit as a crash and walked the backoff
  ladder to `crash-looping`. With `crewhaus run` also refusing the shape, no
  supervised path could run a crew at all. The class was wrong (the emitted
  `daemon.ts` calls itself a one-shot in its own comment): `crew` is now the
  `one-shot` class — ledgered as a job, never restarted, no runfile — and
  `buildSpawnPlan` REFUSES a crew with no brief (remedy `submit-brief`), so
  nothing is spawned and the crash-loop is unreachable from either head.
  `crewhaus daemon submit <dir> --brief-file brief.md` runs one pipeline
  with the brief on stdin, tracked in the same run ledger with the same
  scrubbed capture. The brief travels as a PATH: `SpawnRequest.stdinFile`
  hands the child a read-only fd, so it never appears in argv and a detached
  run keeps its input after the manager exits. `submit` on a shape whose
  input is not a brief names the verb that harness does take, and the
  emitted bundle's own no-stdin message now carries the remediation.
- **Group-ordered bulk lifecycle** (#392). Fleets have dependency order —
  the secretary whose A2A door every other spec mounts boots first, the
  chief that supervises the rest last, and stops go the other way — and
  bringing one up was N commands or N clicks in an order the operator had to
  remember, with nothing recording it. Members now carry a boot order
  (`crewhaus harness group crew --add ./secretary --member-order 1`, with
  `--list` to print the walk), stored on the registry entry as
  `groupOrder[<group>]` and keyed by name so a group rename or a member
  removal cannot leave a dangling ordering. Undeclared members sort after
  the declared ones, each tier by spec name, so the walk is reproducible on
  every machine. `crewhaus daemon start|restart|stop --group <name>
  [--parallel]` walks it (REVERSED for stop), keeps going past a member that
  refuses, prints a per-member summary, and exits non-zero if any member
  failed; interactive and one-shot members are skipped WITH A NOTE rather
  than silently dropped, as is a member whose directory has vanished. The
  console gets the same thing plan-first: `GET
  /api/registry/groups/:name/proc/:verb` returns the walk without touching
  anything, `POST` runs it (207 when some members failed), `PUT
  /api/h/:id/groups {group, order}` sets a position, and the Runs board's
  new Groups strip renders the planned order and only acts on a second
  click.

### Fixed

- **`requireJustification` tools no longer deny every call: the justification
  contract is now advertised in the tool's model-facing schema** (#386). The
  Pillar 3 intent gate reads `input["justification"]`, but nothing told the
  model that field existed — tool-mcp forwards remote schemas verbatim and
  first-party gated tools don't declare it — and models conform tightly to
  advertised schemas, so every gated call was denied
  `justification too brief (0 chars)` (for MCP-registered gated tools such as
  the Thredz wiki aliases, the gate was effectively a hard-off switch). At
  request-build time `runChatLoop` now augments each gated tool's advertised
  input schema with a required, described `justification` string property
  (`withJustificationField` in `@crewhaus/tool-catalog`) unless the tool's
  own schema already declares one. For exactly those runtime-injected tools,
  every surface that reasons about what the tool DOES consumes the OPERATIVE
  input (justification stripped via `stripJustificationField`): the tool's
  validator/executor (remote MCP servers with `additionalProperties: false`
  and strict zod schemas never see a field their schema doesn't allow),
  arg-scoped permission-rule matching (`Tool(argGlob)` rules keep matching
  the way they did before the field existed), the headless approval
  `inputHash` (a one-shot grant stays consumable by a regenerated call whose
  re-worded justification would otherwise hash it apart), tool-loop-detection
  history (re-worded justifications can't hide a loop of identical calls),
  and the egress classifier (scans what is actually transmitted). Surfaces
  that record what the model DID keep the full input: the event log, trace
  bus, pre-tool hooks, the parked approval's display record, the
  justification gate itself, and the justification audit sink. Tools that
  declare the field in their own schema are untouched on every surface — for
  them the field is genuine tool input. The gate's deny message now also
  names the `justification` input field so a model that still omits it can
  recover.
- **`crewhaus harness preflight` checked `process.env` alone** (#391). A
  credential the daemon reads from the harness `.env` chain was reported as
  missing — preflight disagreeing with the spawn, in the direction that
  cries wolf. It now evaluates the merged spawn env, like every other gate.

## [0.5.2] - 2026-08-10

### Added

- **Standing "always allow" grants on the headless approval surfaces, and
  builtin allows for the runtime's own bookkeeping tools** (#383). Approval
  grants are one-shot and keyed on `(toolName, inputHash)` — the right shape
  for a sensitive one-off, and the wrong one for a tool the agent loop calls
  autonomously with varying input (`Skill`, the continuity focus/plan/goal
  tools, knowledge tools like thredz `log_knowledge_gap`): every call hashes
  fresh, so an operator's Approve could never satisfy the next call and a
  headless daemon parked in an endless approve loop. The only exit was an
  `alwaysAllow` rule in the spec plus a recompile and restart.

  Three things close that loop:

  - **`crewhaus approvals grant <id> --always`** (and a third **"Always
    allow"** button on the Slack approval message) records the grant AND
    persists `{ type: alwaysAllow, pattern: <toolName> }` into the harness's
    `.crewhaus/settings.json` — the `settings` rule source, which outranks the
    spec's `yaml` rules and needs no recompile. The RULE carries the standing
    behavior; the grant record itself stays one-shot (consumed on use like
    any grant), so deleting the rule fully revokes the allow. The record
    carries `always: true` for provenance (`approvals list` and the Hangar
    inbox show `granted-always`), and the `approval_resolved` trace/audit
    records carry the flag. In the Slack flow the rule is written before the
    resume re-drives the parked turn, so the re-driven run already loads it.
    When the approvals store was located via `CREWHAUS_SESSION_DIR`/a tenant
    scope, `--always` refuses to guess the harness root and asks for an
    explicit `--dir` (fail closed, before anything is recorded).
  - **`runChatLoop` now loads `.crewhaus/settings.json` permission rules on
    every surface** (new `settingsDir` option, defaulting to the working
    directory). Compiled bundles previously hardcoded `settings: []`, so the
    settings layer only existed for `crewhaus run`/`serve`; now a standing
    allow reaches a running daemon on its next turn. Rules the caller already
    passed are deduped on `(type, pattern)`; a malformed settings file fails
    closed, exactly like the CLI's own reader. Sub-agent child loops pass
    `settingsDir: null` and skip the load: a child's RuleSet is already
    narrowed from the parent's merged rules by `resolveChildPermissions`, and
    re-merging the harness file would let a standing allow (settings source)
    outrank a replace-mode child's explicit deny (yaml source).
  - **`BUILTIN_DEFAULT_RULES` now pre-allows the runtime's bookkeeping
    toolset** (new `BUILTIN_BOOKKEEPING_RULES`: `Skill`, `FocusRead`,
    `FocusWrite`, `PlanRead`, `PlanUpdate`, `PlanComplete`, `GoalWrite`,
    `GoalUpdate`, `GoalList`). Continuity is default-on and these are
    local-only reads/writes of the harness's own state — parking a daemon on
    its own default-on bookkeeping is never what an operator wants, and the
    reasoning is the same one that already pre-allowed `Read`/`Glob`/`Grep`.
    `MemoryClear` is deliberately excluded (it erases continuity state), and
    a spec-level `alwaysAsk`/`alwaysDeny` still overrides (`yaml` outranks
    `builtin`).

  A grant without `--always` behaves exactly as before (one-shot, consumed on
  use), the deny path is unchanged, and old approval records — which carry no
  `always` field — resolve identically.

## [0.5.1] - 2026-08-05

### Fixed

- **`crewhaus cloud deploy` was broken on every published channel**, and had
  been since at least 0.4.2 — it worked only from a source checkout.
  `@crewhaus/helm-chart` resolved its templates package-relative from
  `import.meta.url`, which fails two different ways once shipped: under
  `/$bunfs` in the compiled binary, where the chart was never embedded
  (`templates directory missing at /$bunfs/helm/crewhaus/templates`), and
  against the npm tarball, whose `files` array listed only `src` and so omitted
  `helm/` outright.

  The chart templates are now embedded with `with { type: "text" }` — the same
  mechanism that fixed the `default-skills` ENOENT in 0.3.2 — so rendering
  reads no files at all, and `helm/` joins `files` so a published consumer can
  still `helm install` the real chart from `chartRoot()`. Rendered output is
  byte-identical to the filesystem path it replaces.

  **This class of bug is invisible to CI**, which runs from a source checkout
  where `packages/helm-chart/helm/` is on disk — exactly how it shipped twice.
  The release workflow now renders a chart with the *compiled binary* and
  asserts a real Deployment manifest comes out, alongside the existing Hangar
  console smoke. The guard was verified against the shipped 0.5.0 binary: it
  fails there, and passes on this build.

## [0.5.0] - 2026-08-05

### Added

- **Four new packages carry the harness manager's library layers.**
  `@crewhaus/harness-registry` is the machine-wide registry file layer — one
  `harnesses.json` (format v2) under the registry root
  (`CREWHAUS_REGISTRY_ROOT`, default `~/.crewhaus`) listing every registered
  harness with a stable `hrn_` id plus user-managed groups/tags/pins, scan
  roots, and group definitions; writes are atomic tmp+rename with a
  read-merge-write retry loop, vanished directories are stamped
  `missingSince` rather than pruned, and the legacy watchme registry is
  seeded from and written through best-effort. `@crewhaus/harness-inventory`
  is the cross-harness discovery + inventory/health rollup + seam-injected
  bulk runner that previously lived inside the CLI as the `crewhaus fleet`
  core. `@crewhaus/preflight` is typed pre-spawn health checks — spec lint,
  a provider-credential matrix over the union of every model a spec can
  route to, the channel daemon's boot-gate env refs, MCP secret-ref dry-run,
  port bindability, bundle freshness, and durability warnings — every core
  function taking an injected `env` so the same checks serve the CLI, tests,
  and a fleet manager identically. `@crewhaus/harness-supervisor` is the
  process layer — spawn contracts per run class, the preflight gate, the
  supervision state machine with its restart window and exit classification,
  the byte-exact log pump, and adoption — over state that is entirely
  HARNESS-LOCAL under `<harness>/.crewhaus/run/` (runfile, append-only run
  ledger, captured logs + cursors, the minted control token). Nothing lives
  in a central manager directory, which is what lets the console and
  `crewhaus daemon` drive the same daemon from either side, and what makes a
  harness copied to another machine carry its own run history with it.

- **`run`, `compile`, `eval`, and `dev` now self-register the harness they
  touch.** After the spec resolves, each command records the cwd (the
  harness root per the standalone-harness convention) in the machine-wide
  registry with origin `run-hook`, so `crewhaus harness list` fills itself
  from normal use with no ceremony. The hook is best-effort by contract — it
  never throws, and a registry failure never fails the command that
  triggered it. `CREWHAUS_NO_REGISTRY=1` opts out of every registry write.
  Under the default registry root, a cwd inside the OS temp directory is not
  recorded (fixture compiles and scratch runs would otherwise accumulate
  guaranteed-dead rows the registry never auto-prunes); an explicit
  `CREWHAUS_REGISTRY_ROOT` registers every cwd.

- **`crewhaus harness` — the harness manager verb family.** `harness list
  [--group G] [--json]` renders every registered harness joined with the
  on-disk inventory (missing directories are flagged "relocate or remove",
  never auto-pruned); `harness show <dir|hrn_id>` adds the per-harness
  inventory row and health rollup; `harness add|remove|relocate` manage
  registration by hand (`add` warns rather than fails on a directory without
  a readable `crewhaus.yaml`; `remove` drops only the registry row);
  `harness group|tag|pin` manage the user-facing organization fields;
  `harness scan [--root <dir>]` walks the configured scan roots (an explicit
  `--root` is remembered as one) with the fleet discovery walk and upserts
  every harness found (origin `scan`), reporting added/refreshed/missing
  counts; `harness preflight <dir|id>` renders the typed will-it-boot report
  in the doctor's check-list style and exits 1 when blocking findings exist.
  `crewhaus fleet` gains the matching `--group <name>` filter on
  `list`/`status`/`run`, scoping the discovered set to registry-group
  members.

- **`crewhaus hangar` — the manager console.** `crewhaus hangar` (alias
  `hangar serve`) opens the local Hangar web console over the machine-wide
  registry: it seeds the registry from the legacy watchme store
  (best-effort), boots the loopback `@crewhaus/hangar-server` with the
  embedded `@crewhaus/hangar-ui` assets (default `127.0.0.1:4200`;
  `--port`/`--host` rebind, and `--host` REQUIRES auth), prints a boxed
  summary, and opens the browser at a single-use `<url>/boot/<nonce>` path
  that redirects to `<url>/#t=<token>` — the token travels as a URL FRAGMENT
  (never a query string, so it cannot land in server logs or referrer
  headers) and never as a command-line argument to the browser opener (argv
  is world-readable; a scraped nonce is already spent). `--no-open` skips
  the browser; `--no-auth` is loopback dev only. A single-instance lock at
  `<hangarRoot>/hangar.lock` (JSON pid/startedAt/port/url, written
  atomically, claimed with an exclusive create so two racing consoles cannot
  both win) refuses a second boot while the first pid is alive, replaces
  a stale lock left by a dead pid with a note, and is released on
  SIGINT/SIGTERM shutdown. `hangar status [--json]` reports
  lock/port/registry/token state without needing a running server, and
  `hangar open` re-reads the token file to rebuild the fragment URL for a
  running console. `hangar serve --smoke` boots on an ephemeral port and
  self-checks — healthz, the embedded UI shell, and `/api/harnesses` both
  with the bearer token (200) and without (401) — then exits; it is the
  release workflow's compiled-binary smoke entry.

- **The Hangar console became a driver, and `crewhaus daemon` is its
  terminal twin.** `@crewhaus/hangar-server` gained the M2 surface:
  `POST /api/h/:id/proc/{start,stop,restart,drain}` over
  `@crewhaus/harness-supervisor` (preflight gates every spawn and returns
  the typed refusal — with each blocking item marked acknowledgeable or
  not — instead of spawning), a run ledger plus a live `text/event-stream`
  run feed that opens with the durable replay and always terminates with a
  `done` frame, a `crewhaus.control.v1` proxy for wake/drain/status whose
  bearer is read server-side and never crosses the API boundary, the
  four-lane scheduler timeline (heartbeat / schedule / dream / janitor)
  merging spec-declared cadence with the phase only the daemon's own
  process can report, fleet-wide approvals and review inboxes that settle
  work through the same stores the CLI writes through, an activity digest
  built from stats rather than transcript reads, read-only deployment
  records, and a bounded job queue behind the dream-run / eval / doctor /
  compile action faces. The new `crewhaus daemon
  start|stop|restart|status|logs|wake|drain` family drives the same
  supervisor DIRECTLY, so it works with no console running — all
  supervision state is harness-local under `.crewhaus/run/`, and a daemon
  either head starts is adopted by the other.

- **The Hangar console gained its detail surface.** M3 adds 178 routes to
  `@crewhaus/hangar-server` and eight harness tabs plus three fleet screens to
  `@crewhaus/hangar-ui`, across six areas: the spec's write side (structured
  editing with trust tiers, diff interstitial, version pin/rollback, and the
  template/grader/dataset/MCP-connector builders), the memory fabric's write
  side (facts with forget/sweep, continuity trash + restore, the wiki editor,
  watch-me analytics/reports/intents/synthesize), the eval + dataset +
  feedback loops (matrix, trends, judge, graders, coverage, sentinel; the
  dataset registry with hygiene and growth; the fewshot/faq/lessons/advice
  feeds), credentials + channels + security (env-key presence, the fleet-wide
  provider matrix, channel provisioning and verification, egress/PII/
  compliance/on-chain/retention), a server-side Thredz proxy, and the raw
  store inspectors. The route contract was frozen ahead of the handlers and is
  EXECUTABLE from both sides: `hangar-ui`'s `routes.js` carries every route as
  pure data (which is also what generates the client wrappers instead of
  hand-writing 178 of them), and the server's contract test asserts the two
  tables are the same set — key, method and path — then drives each route
  against a live fixture server. One route is deliberately unimplemented and
  says so: `POST /api/h/:id/secrets/:name/rotate` needs
  `@crewhaus/secrets-manager`, which the server does not depend on.

  Every write on that surface goes through the layer that already owns it,
  never around it: spec edits through `applySpecEdits` with
  `restrictToOptimizable` (a human-owned path routes to `crewhaus propose`
  rather than being written), env through `upsertEnvVar` (values in, presence
  booleans out), no hard delete anywhere in the memory fabric (tombstones,
  trash directories and TTL sweeps only), wiki writes carrying
  `expectedVersion` with a first-class stale-version refusal, Thredz keys read
  server-side and never returned, and a confirm → typed-confirm →
  dry-run-first ladder in front of destructive verbs. Every M3 read answers
  `{present, note, verb}` alongside its payload, so an empty panel says why it
  is empty and which CLI verb fills it.

- **Compiled daemon bundles now serve `crewhaus.control.v1`.** Every daemon
  shape (channel, managed, crew, voice, batch) constructs a control plane at
  boot. It binds a loopback listener ONLY when `CREWHAUS_CONTROL_PORT` is
  set, so upgrading a bundle never opens a listener nobody asked for; when
  it does bind it answers `GET /control/v1/{healthz,status}` and `POST
  /control/v1/{wake,drain}` behind a bearer compared in constant time, taken
  from `CREWHAUS_CONTROL_TOKEN` or minted at boot into
  `<cwd>/.crewhaus/run/control-token` (0600) so a local manager can read it
  off disk without one ever entering argv. `CREWHAUS_CONTROL_BIND`
  (default `127.0.0.1`) moves the listener; a port of `0` lets the kernel
  choose and the daemon announces the number on stdout, which is the only
  place it exists. Every call appends a `gateway_request` record to the
  harness's hash-chained audit log when one is wired. **Independently of the
  control port**, the channel and managed daemons now answer a bare,
  UNAUTHENTICATED `GET /healthz` on their PUBLIC port — deployment scaffolds
  have always declared that health check and no daemon served it, and the
  liveness answer carries no state — and, once draining, shed every other
  request on that port with `503` + `Retry-After: 15` so a PaaS backs off
  instead of reaping a process mid-turn. A deployed bundle that sets no
  control env vars therefore gains exactly one new route — `/healthz` — and
  no listener, no token file, and no reachable control surface.

- **Binding the Hangar console beyond loopback now needs an explicit
  opt-in.** `crewhaus hangar --host <h>` has always required auth; it now
  additionally requires `CREWHAUS_HANGAR_ALLOW_REMOTE=1` whenever the host
  is not this machine. The console is machine control — it starts and stops
  processes, reads every transcript and writes credentials — behind a bearer
  token over plain HTTP with no TLS, no origin pinning and no rate limiting,
  which is a fine posture for `127.0.0.1` and a poor one for a LAN, so the
  fleet can no longer be exposed by muscle memory. Loopback is the whole of
  `127.0.0.0/8`, `::1` in any spelling (bracketed, expanded, or IPv4-mapped)
  and `localhost`; everything else needs the opt-in, including the two
  values that look the most harmless — `0.0.0.0` and `::` are the wildcards
  and bind every interface the machine has. Hostnames are never resolved to
  decide this: an unrecognised host fails closed. The refusal names the
  variable AND the answer, which is a private network (Tailscale, an SSH
  tunnel) rather than a port-forward.

- **CI runs the process layer on Windows.** `createWindowsProcessOps` —
  PowerShell `Get-Process` for liveness and start time, `taskkill /T` for
  the tree — shipped with the process layer, but only its output PARSERS
  were tested, against captured strings; the adapter itself had never
  executed on Windows, and the one `windows-latest` job in the release
  workflow verifies that the packaged `.exe` downloads rather than that the
  supervisor works. A new `windows-supervision` CI job runs the
  `@crewhaus/harness-supervisor` and `@crewhaus/hangar-server` suites on
  `windows-latest`, and the supervisor suite gains a Windows-only
  integration test that spawns one real child and asks the real adapter the
  three questions liveness is made of: is the pid alive, when did it start,
  and is it still running our argv. A wrong answer to any of them is what
  lets a restart spawn a second copy of a channel daemon (double message
  processing, double provider spend), so it is worth proving rather than
  asserting. **The job is GATING and Windows supervision is now verified**:
  its first run found six real bugs — none of them the predicted spawn
  problem, all path handling, and two of them containment checks written as
  `startsWith(root + "/")`, which never matches on Windows because `resolve`
  yields `D:\a\b\c`. One of those failed OPEN (a "refusing to trash the
  trash" guard that never fired). With those fixed both suites pass on
  `windows-latest`, so a Windows regression now stops a merge exactly like a
  POSIX one, and the interim win32 "unverified" notice is deleted — it was a
  statement about CI, and CI can now make the statement itself. Windows
  binaries ship through Scoop and winget, so the honest options were to
  prove it or to say so — not to leave "written but unrun" implied. Several suite-level POSIX
  assumptions were fixed along the way: `0600` file-mode assertions are
  POSIX claims (Windows reports `0666` for any writable file and carries the
  real permission in the ACL), and a fixture path fell back to `/tmp` when
  `TMPDIR` was unset, which is every Windows machine.

- **`scripts/pricing-audit.ts` — a hermetic guard that runs on every PR.** Zero
  network, zero secrets; picked up by the existing `bun test scripts` half of
  the root test script, so no CI change was needed. Checks golden prices for
  every shipping model, bare-family fallback coverage (including a next-major
  probe), capabilities/pricing coherence, sunset-replacement resolvability, and
  table freshness. Wall-clock freshness runs only from the CLI — `feed.test.ts`
  pins fixed clocks on purpose so the suite never reddens with time, which is
  why staleness needed a separate home.

- **`scripts/pricing-refresh.ts` — proposes, never applies.** Diffs the table
  against two independent public datasets (LiteLLM and OpenRouter, both public
  and unauthenticated, so CI needs no credentials). Two rules, both paid for
  empirically: two sources must agree, because LiteLLM alone lists
  `gemini-1.5-flash` at an output cost of exactly 0 and auto-applying would have
  zeroed a live row; and matching is EXACT-key only, because a naive prefix scan
  reported the *correct* `mistral.mistral-large` row as 2x drift by matching a
  different variant — AWS's own price list confirmed the committed value was
  right. Unmatched rows are surfaced for a human rather than resolved to a
  neighbour.

- **`.github/workflows/pricing-drift.yml`** — monthly (plus `workflow_dispatch`
  for launch days), fork-guarded. The hermetic audit fails the job; the fetching
  half is `continue-on-error`, because an upstream outage is not a reason to page
  anyone about our own table. Nothing is auto-committed.

- **Thredz wiki spaces — `thredz.space` scopes an agent's hosted memory to one
  space.** A space is a memory boundary *inside* a Thredz account: a `shared`
  space is readable by every wiki-enabled key on the account, an `individual`
  space only by the key that owns it. The lowered value becomes
  `THREDZ_DEFAULT_SPACE` on the synthesized stdio server, enforced the same
  deterministic way `visibility` already is — the server env is the single
  enforcement point, so no call site passes a per-call space. Declaring no space
  omits the key entirely, leaving unspaced bundles byte-identical to 0.4.x.

  **One `individual` space per API key is a hard Thredz limit**, so per-agent
  private memory means a per-agent `api_key` — today that is one `thredz:` block
  per spec, i.e. one harness process per agent. The `space` and `visibility`
  knobs stay independent: inside a space the space's *type* decides visibility,
  but the compiler still emits both, because the same bundle may be pointed at a
  different space later and silently dropping `visibility` would re-expose the
  Thredz shared-by-default footgun.

- **`wiki_space_list` and `wiki_space_create` join the Thredz alias set.** They
  are remote-only by construction — a space has no local twin — so they are
  deliberately NOT in `THREDZ_WIKI_TOOL_NAMES`, the local/remote parity list
  `backend-conformance` asserts `createWikiTools` matches exactly. Against a
  pre-0.3.0 server they come back in `registerMcpToolAliases`' `missing` list
  and `connectThredz` warns, never a hard failure. `wiki_space_create` carries
  the justification gate: it consumes plan quota and can 402/409.

- **Thredz is emit-wired on `target: crew`, with a per-role fan-out.** One
  Thredz API key owns at most ONE `individual` (private) wiki space, and
  `thredz-mcp` reads exactly one key per process — so per-role private memory
  is per-role keys is per-role server processes. `thredz.roles.<role>` gives a
  role its own `api_key` and `space`; every other field at that level is the
  default a role inherits and may override:

  ```yaml
  thredz:
    visibility: private          # inherited by both roles
    roles:
      researcher: { api_key: $THREDZ_KEY_RESEARCHER, space: researcher-notes }
      editor:     { api_key: $THREDZ_KEY_EDITOR,     space: editor-notes }
  ```

  A role with no override rides the crew-wide block, sharing one key, one space
  and one process — a crew with one brain stays the easy case. A server nobody
  rides is never synthesized, so a fully-overridden crew spawns no spare child.

  **The fan-out map lives under `thredz.`, not on the role, and that is
  load-bearing.** Two surfaces prefix-match on `["thredz"]`: the optimizer's
  `OPTIMIZABLE_PATHS.crew` allows whole-role replacement under `["roles"]`, and
  the hangar's spec editor denies the `thredz` prefix outright. Under
  `roles.<r>.thredz` a role's `api_key` would have become both
  optimizer-rewritable and browser-editable. Keeping it under `thredz.roles`
  inherits both protections with no new code.

  Each role's Thredz vocabulary is registered as BARE names into its OWN
  `ToolCatalog` — the alias collision guard is per-catalog, so two roles can
  both own `wiki_write`. Prefixing was rejected: `wiki_write` is a vocabulary
  five prompt sites and four policy surfaces match verbatim. Two new
  orchestrator seams, `roleExtraTools` and `roleMemory`, carry it, which also
  buys the agent-to-agent peer path for free and keeps `agent_<role>.ts`
  byte-stable.

### Changed

- **The `fleet` and `doctor`/`channel` cores are consumed from the new
  packages instead of living in the CLI.** `apps/cli/src/fleet.ts` re-exports
  `@crewhaus/harness-inventory` (the lift is byte-identical, and the CLI's
  fleet tests run unmodified against it); the doctor credential checks and
  the channel boot-gate/provider-gate checks now come from
  `@crewhaus/preflight`, message-identical, with only the compiler-dependent
  channel-IR extraction staying in the CLI. Internal rewire only — no
  behavior change to `fleet`, `doctor`, or `channel provision|verify`.

- **Every compiled bundle's `dist/package.json` now carries a provenance
  stamp**, `crewhaus: { specHash, compiledWith }` — the hash of the
  normalized `crewhaus.yaml` it was emitted from plus the crewhaus version
  that emitted it. It is what lets a manager answer "is this bundle current?"
  EXACTLY instead of comparing file mtimes, and the console labels which of
  the two answers it got. A bundle with no stamp is reported as unstamped,
  never as stale, so upgrading does not nag every harness that has not been
  recompiled yet. `compile --check` carries an existing stamp forward rather
  than dropping it. Bundles also gain `@crewhaus/gateway-protocol` in their
  dependency list (the control plane above), and the crew, voice and batch
  daemons additionally open the hash-chained audit log at boot, creating
  `<cwd>/.crewhaus/audit/` on first run — `CREWHAUS_SECURITY_AUDIT=0` opts
  out.

- **The channel daemon's session router signals every completed turn.** The
  `onTurnComplete` callback used to be emitted only when the spec declared a
  `gateway:` block; `crewhaus.control.v1` made it unconditional, because
  `/control/v1/status` reports `counters.turns` on every daemon shape and a
  counter that existed only alongside an optional spec block would make the
  control surface lie about a gateway-less bot. Observable through the
  control status route, which needs the control port bound.

- **`crewhaus fleet` and `crewhaus harness` now signpost each other.**
  `fleet` is KEPT indefinitely — it is a thin, golden-tested consumer of
  `@crewhaus/harness-inventory` whose maintenance cost is near zero, and it
  is a genuinely different entry point rather than a legacy one, so
  deprecating it would break scripts for no gain. What was missing was the
  axis, and each verb's help now states it and points across: `fleet` is
  FILESYSTEM-centric (walks `--root`, needs no registration, has no
  console), `harness` is REGISTRY-centric (the machine-wide list wherever
  the harnesses live, plus groups/tags/pins, preflight, and the console).
  Both `--help` screens and the top-level subcommand list say that both are
  supported and neither replaces the other, so an operator who found one
  first discovers the other from it.

- **The thredz-mcp pin moves to `thredz-mcp@0.3.0`** in both the compiler and
  `target-managed`, which spell it out separately. A new `thredz-pin-parity`
  test asserts the two literals match and that the pin is new enough to
  understand spaces — a drifted pin fails silently, sending every write to the
  unspaced legacy wiki instead of the space the spec asked for.

- **409s classify as `thredz_conflict`, not `thredz_unavailable`.** A stale
  version, an ambiguous slug across spaces, or an existing individual space are
  all things the *caller* can fix by retrying differently. Calling them outages
  sent every spaces conflict down the "backend is down, degrade to files" path.
  The 402 test deliberately stays ahead of the 409 test so
  `space_quota_exceeded` still classifies as quota.

- `@crewhaus/tool-wiki` accepts `space` on all nine wiki tools, a no-op over
  files, so a spec written for the Thredz backend runs unchanged over the local
  backend — the parity contract the schema-mirror test pins.

- **The crew-wide memory fabric no longer registers the wiki when roles carry
  their own.** Facts, continuity, plan and skills stay crew-wide; the wiki
  becomes per-role by definition. Without this a role's tool array carried the
  ten local wiki twins beside its ten aliased ones, and duplicate names in the
  array advertised to the provider are a 400.

- **Crew's `ACCEPTED_BUT_UNWIRED` row is deleted, not silenced**, and the
  emitted bundle's "thredz configured but ignored on crew" note is gone —
  the table's contract is that a row exists only while the shape really does
  ignore the block. `research` is now the only shape that still carries it.

- The continuity goal mirror rides the crew-default connection only. A pure
  fan-out crew gets `goals: false` forced with the mirror dropped rather than
  failing to compile: the continuity store is spec-scoped and shared, and
  mirroring one crew plan into N private spaces has no correct semantics.

- `connectThredz` takes a `serverName`, and every `[thredz]` log line now names
  its server. With N per-role servers an undifferentiated prefix leaves an
  operator unable to tell which role's key lapsed.

### Fixed

- **Hangar's preflight now evaluates the environment the spawn actually
  receives.** `mergedSpawnEnv` layered the harness `.env` chain ON TOP of
  the manager's process env, while `buildSpawnPlan` layers it UNDERNEATH —
  so the console could pass a check against a value the daemon would never
  see, the exact inversion of "it passed preflight and then died on a
  missing key". It now delegates to `buildSpawnEnv`, the function the plan
  builds `plan.env` with, so there is one encoding of the precedence and a
  test pins the two together.

- **The Hangar console masks and containment-checks every harness read, not
  just some.** Memory-fabric text (facts and their tags, wiki article bodies,
  continuity focus/goals/plans) and durable session summaries for evicted
  sessions went out unmasked — a credential an agent quoted into a fact or a
  note would render verbatim, even though transcripts and spec YAML were
  already masked. Every one of those payloads now passes the same
  credential masker, and the end-to-end test plants a fake-shaped key in each
  of them. Separately, only the wiki-article and eval readers enforced
  realpath containment: a symlink planted inside `.crewhaus/memories`,
  `state/plans`, `dream`, `watchme`, `sessions`, `sessions-index`, or
  `feedback` could pull a file from outside the harness into a response or a
  cost/rollup walk. All of those reads (and the evicted-session fall-through,
  which additionally derived its path from `dirname(sessionRoot)` rather than
  the harness directory) are now contained per file.

- **`crewhaus cloud deploy` no longer writes generated infrastructure into its
  own package directory.** Without `--working-dir`, `deployCloud` and
  `teardownCloud` defaulted to `<package>/recipes/.out/<cluster>` — resolved
  from `import.meta.url`, so it followed the code rather than the caller. In a
  source checkout that means every deploy leaves an untracked
  `packages/crewhaus-cloud/recipes/` in `git status` (the path is not covered
  by `.gitignore`); installed from npm it means writing terraform state
  scaffolding into `node_modules`, which may be read-only and is wiped on the
  next install. The default is now `.crewhaus/cloud/<cluster>` under the
  current working directory, matching the convention the rest of the workspace
  already uses for runtime artefacts (`.crewhaus/sessions`,
  `.crewhaus/compliance`, …) and gitignored along with them.

  The default stays a *stable* path rather than the temp dir the option's
  docstring used to promise, because `teardownCloud` has to find what
  `deployCloud` wrote — a fresh `mkdtemp` per call would break teardown. The
  docstring now says what the code does.

- **A pricing feed missing a provider silently zeroed that provider's billing —
  and an empty one zeroed everything.** A feed REPLACES the effective table
  (`pickNewestPricing` selects by version and deliberately does not merge, so a
  pinned historical table stays reproducible), but nothing checked that a feed
  actually covered the providers it was replacing. A document as small as
  `{"version":"2099-01-01","providers":{}}` parsed clean, won on version, and
  turned every model into a pricing miss — which `cost-tracker` charges at $0.
  One file in `~/.crewhaus/pricing/` was enough to zero all billing.
  `parsePricingFeed` now requires every known provider to carry at least one
  row, with `{ partial: true }` for callers that merge themselves. Rejecting
  rather than merging over `DEFAULT_PRICING` keeps the determinism contract
  intact.

- **Sixteen currently-shipping model ids billed $0, and three billed the wrong
  rate.** The bedrock table had no bare-family fallbacks, so an id no row spelled
  out matched *nothing* there (`anthropic.claude-haiku-4-5`,
  `anthropic.claude-fable-5`, any next major) rather than merely mispricing;
  `claude-mythos-5`, `o3`, `o4-mini` and the Gemini 3.x line had no rows at all.
  Separately, `claude-opus-4-5` fell through to the `claude-opus-4` legacy base
  and billed $15/$75 against a real $5/$25 — a 3x overcharge that coverage and
  freshness checks both pass. Bedrock now mirrors the first-party fallback
  convention, and every current family has an explicit row.

- **Two Gemini rows were materially wrong**, both undercharging:
  `gemini-2.5-pro` carried a $5 output rate against a real $10, and
  `gemini-2.5-flash` $0.15/$0.60 against $0.30/$2.50. `gemini-2.5-flash-lite`
  inherited the (wrong) flash row instead of its own $0.10/$0.40.

- **`claude-opus-4-7`/`4-6` corrected to $5/$25** from $15/$75. The old value
  contradicted the same file's "Opus 4.5+ is $5/$25" rule, and two independent
  public datasets plus the bundled `claude-api` reference agree. The
  `claude-opus-4` base stays $15/$75 — what it catches now is the genuinely
  legacy 4.0/4.1 lineage, which really did cost that. Historical re-aggregation
  is unaffected: that guarantee comes from `version` pinning, not from freezing
  rows in the current table. Fixtures that used a current Opus purely as an
  "expensive model" now name `claude-opus-4` explicitly.

- **`bedrock/meta.llama3-1` had capabilities but no resolvable price.** Both
  pricing keys (`…-70b`, `…-8b`) are longer, so longest-prefix matching never
  reached them and anything enumerated at that key priced at $0. The capability
  key is now split to match pricing granularity.

### Removed

- **`recipesRoot()` is gone from `@crewhaus/crewhaus-cloud`'s public API.** It
  returned `<package>/recipes`, and with the deploy default moved out of the
  package directory nothing reads or writes beneath that path any more. The
  package has never shipped a `recipes/` directory either — `files` in
  package.json does not list one — so the function returned a path that does
  not exist in an installed copy and, in a source checkout, existed only as a
  side effect of the bug above. Anything that needs to know where a deploy put
  its artefacts should read `workingDir` off the `deployCloud` result (or the
  `Working dir:` line `summariseDeploy` prints) rather than reconstructing a
  path from the package location.

## [0.4.2] - 2026-07-27

### Changed

- **Docs, starter templates and the default judge now name the current Claude
  models.** Every user-facing model string had drifted a generation behind:
  the README's six spec examples and the `crewhaus init` / `doctor --fix` /
  `watchme synthesize` scaffolds all handed a new user `claude-opus-4-7`, the
  issue template asked for repros on `claude-sonnet-4-6`, and
  `DEFAULT_JUDGE_MODEL` — what every `llm_judge` grader without an explicit
  `model:` resolves to — was still `claude-sonnet-4-5`. Scaffolds and the
  interactive `init` default now emit `claude-opus-5`; the judge default and
  the docs that quote it are `claude-sonnet-5`. Haiku references are
  unchanged, `claude-haiku-4-5` still being current.

  Two assertions that pinned the old strings as literals are now bound to
  `DEFAULT_JUDGE_MODEL` itself, since help text naming a stale default is the
  drift they exist to catch — pinning the literal is what let it drift.

  The model-router README's Bedrock row keeps its dated
  `claude-sonnet-4-5-20250929-v1:0` id: that row documents how the id
  *grammar* is parsed (inference-profile prefixes, family inference, the
  `-v1:0` snapshot suffix), and a suffix-free current id would stop
  illustrating it. Routing itself is version-agnostic — `claude-opus-5`,
  `claude-sonnet-5` and `vertex/claude-sonnet-5` all resolve unchanged.

### Fixed

- **A tool permission that lands on `ask` inside a sub-agent (`Task`) turn now
  parks like any other, instead of denying in place.** Three links were
  missing at once: `ParentRunHandle` carried no approval seam, the Task tool's
  hand-copied `parentHandle` projection could not have forwarded one, and the
  child `runChatLoop` was never given `askMode`/`approvals` — so a child was
  non-interactive with nothing to park against, and every `ask` collapsed to a
  denial regardless of the parent's `permissions.ask_mode`.

  A parked child also used to be SWALLOWED. The spawner escalates only
  terminal classes to the parent, and its predicate listed just
  `billing`/`auth`, so a park dissolved into an `is_error` tool result: the
  parent exited 0 with a `PendingApproval` on disk, and the model was free to
  retry the Task and re-fire `approvals.notify` for a decision already
  pending. `approval_pending` now escalates too — for the opposite reason to
  billing/auth: those are fatal, a park is RESUMABLE, and the parent run is
  the only thing that can be resumed. Every consumer keys on that classified
  report (`crewhaus failures` treats it as a non-failure, `fleet` renders
  "needs approval", the channel bot posts its approve/deny prompt), and none
  of it was reachable from an `is_error` string.

  The child shares the parent's store rather than a narrowed one — unlike the
  memory (recall-without-capture) and continuity (read-only) seams there is
  nothing to restrict, since a park is a run-level pause and the store is
  keyed on `(toolName, inputHash)` across sessions.
- **Pending approvals are swept on an unattended harness, so raw tool inputs
  stop outliving the sessions they came from.** `approvals.jsonl` had exactly
  one pruner — `list()` — whose only production callers are the human-invoked
  `crewhaus approvals list|show` verbs. A daemon or a cron'd run therefore
  never compacted it: a full park→grant→consume cycle appends three lines, a
  consumed or expired record makes the next identical call mint a fresh id and
  append again, and `get` re-folds the entire file on every `ask`, so ask
  latency degraded against a file nothing ever truncated.

  The retention angle is the sharper one. Every record embeds the tool input
  verbatim — by construction the calls a policy deemed sensitive enough to
  need a human, so exactly the ones likely to carry credentials, payloads or
  file contents — and nothing in the retention machinery could reach it:
  `evictExpiredSessions`, `SessionStore.delete()` and `crewhaus retention
  sweep|purge` all key on `sess_<16 hex>.json`, and the retention inventory
  classifies `approvals.jsonl` as "not a session artifact" and skips it. An
  operator could purge a session for compliance while the input that session
  tried to run survived indefinitely in a sibling file.

  `@crewhaus/session-store` now exports `evictExpiredApprovals`, mirroring
  `evictExpiredSessions`, and a run sweeps its own session root at boot beside
  the session eviction it already did. A record whose `createdAt` will not
  parse now counts as EXPIRED rather than immortal — the shape guard only
  demands a string, so a corrupted line would otherwise survive every
  compaction forever while still carrying its input.
- **A queue job that parks on an approval no longer burns its retry budget
  waiting for a human.** With `ask_mode` threaded into the batch worker, a
  tool permission resolving to `ask` throws `approval_pending` out of the
  queue handler — and `startConsumer` counted that as a job FAILURE. With the
  default `maxRetries: 3` and a visibility timeout in the tens of seconds, the
  budget was spent in under a minute, so a job dead-lettered long before
  anyone could run `crewhaus approvals grant`. The approval seam could never
  actually complete on this shape.

  A park is now a DEFER: the job is neither ack'd nor nack'd, its visibility
  lease is pushed out by `deferVisibilityMs` (default 60s), and the attempt is
  excluded from the retry budget. The consumer tracks parks per job and
  subtracts them from `job.attempt`, so a job that parked three times and then
  genuinely fails still gets its full `maxRetries` worth of real attempts —
  parking defers the deadline, it does not grant immortality.

  The lease push is the backoff, and it matters: returning a parked job
  straight to pending spins the consumer — pull, run a model turn, hit the
  same ungranted permission, park — burning a model call per lap while a human
  is still deciding.

  Deliberately implemented in the consumer rather than the queue protocol: it
  uses `extendVisibility`, which every adapter already implements, so
  in-memory, SQS, Redis-streams and Postgres all behave the same with no
  interface change. Detection is structural (`report.class`), not
  `instanceof` — the error crosses a package boundary and, in a compiled
  bundle, possibly a duplicated `@crewhaus/errors` instance, where an identity
  check would silently fall through to the failure path.

  Emitted batch bundles report a park as `status: "awaiting_approval"` with a
  `defers` count, rather than mislabelling it `status: "fail"` with an
  undefined reason.
- **The channel bot's Slack approve/deny surface is reachable code.** A
  compiled channel bot emitted a complete park → prompt → grant → resume
  flow — the router's `approval_pending` catch, `postApprovalPrompt`, the
  gateway's `/<adapter>/actions` route, `resumeApproval` — and none of it
  could ever run. Three independent breaks: the emitted turn threaded neither
  `askMode` nor `approvals`, so the runtime never threw; the catch queried a
  channel-side `ApprovalStore` that nothing in the emitted daemon ever wrote
  to, so it would have found nothing anyway; and that store was structurally
  incompatible with the runtime's, which is where a decision has to land.

  `@crewhaus/channel-adapter-base` now exports
  `createRuntimeBackedApprovalStore`, an `ApprovalStore` over the runtime's
  pending-approval store, and the emitted daemon builds ONE store with two
  faces: the runtime face for `runChatLoop` to park into, the channel face for
  the router and gateway. It has to be that way round — a granted approval is
  consumed when the re-driven turn re-asks runtime-core, which consults only
  its own store, keyed `(toolName, inputHash)`.

  Three consequences worth knowing:
  - `resolve` returns `null` on a SECOND decision. The gateway treats a
    non-null return as "I transitioned this" and uses it to ACK Slack and
    re-drive the turn, while the runtime's own `resolve` overwrites and
    returns the record regardless — so a Slack interaction retry would have
    driven the turn twice.
  - approval ids are now the runtime's `appr_<16 hex>`. The channel store
    minted 24 hex, which `session-store` rejects outright and which
    `crewhaus approvals grant` — the command the Slack prompt itself prints —
    would not accept either.
  - parks are DURABLE and cross-process. The in-memory store lost every park
    on restart, leaving a human staring at buttons wired to nothing.

  Covered by a test that EXECUTES the emitted router over the real store:
  every other approval test in that package asserts on emitted source text,
  which is precisely how a fully unreachable surface passed CI.

  Still open: a park raised inside a Task SUB-AGENT records the child's
  `sessionId`, so the router's session-scoped `list()` will not match it. The
  prompt is posted for top-level turns only; widening the query without a
  parent link would risk posting one thread's approval into another.

- **Compiled bundles honour `permissions.ask_mode` too.** The interpreter
  learned to park a headless `ask` rather than deny it in place, but every
  target emitter still passed neither `askMode` nor `approvals` into the
  `runChatLoop` it emitted — so the field stayed inert in generated code, and
  a compiled daemon, worker, workflow step or graph node refused a gated call
  with no way for anyone to approve it. Now threaded in
  `target-batch-worker`, `target-browser-driver`, `target-graph`,
  `target-managed`, `target-pipeline` (its `runForEval` entry only),
  `target-research-bundle`, `target-workflow`, and `target-crew` through
  `crew-orchestrator`'s `RunOptions`, each stamping a `surface` so
  `crewhaus approvals list` says where a park came from.

  Only NON-INTERACTIVE emitted paths are threaded. A REPL bundle prompts on
  stdin, so the interactive halves of `target-browser-driver` and
  `target-pipeline` are deliberately untouched, as is the channel bot's
  `dream` maintenance turn — an unattended janitor pass that must never hang
  waiting for a human nobody told to look.

  Specs with no `permissions:` block are what this matters most for: with no
  block every unmatched tool resolves to `ask`, and most of the existing
  permission-field renderers early-return in exactly that case. The approval
  fields are therefore emitted by a separate, unconditional renderer rather
  than folded into those.

  `target-managed` builds its store PER TURN rather than at module scope,
  because every turn runs inside `withTenant()` — a module-scope store would
  pool one tenant's parked approvals, which echo the raw tool input, into the
  process-global sessions directory.

  NOT included: the channel bot. Threading its loop alone would make
  `approval_pending` throwable while its session router queries a different,
  empty, structurally incompatible approval store that nothing writes to —
  a bot that parks with no Slack prompt and no way to grant, which is worse
  than the denial it replaces. That needs a store bridge, tracked separately.
- **A `target: graph` spec's `permissions:` block is no longer silently
  discarded.** `IrGraphV0` has always carried `permissions` and the compiler
  has always lowered it, but the graph emitter rendered no permission fields
  at all — so every node ran on runtime defaults and a spec's `alwaysDeny`
  rules were dropped on the floor. Found while threading `ask_mode` through
  the same emitter.

### Added

- **`driver.allowPrivateTargets` (browser specs, default false) — and with it,
  the browser runtime smoke is a HARD gate again.** The smoke serves its
  randomised magic-phrase page on `http://127.0.0.1:<port>`, which the SSRF
  floor refused in two independent layers (the Navigate pre-goto guard, and
  the chromium backend's DNS-pinning proxy) with no way for a spec to opt in.
  The shape therefore could not pass, and the advisory that hid that was the
  only thing keeping the job green. The fixture now opts in, the smoke passes,
  and `CREWHAUS_RUNTIME_SMOKE_BROWSER=1` promotes it back to a hard assertion.

  The flag waives ONLY the private/loopback/mDNS host checks, for a harness
  whose whole job is a private target the operator controls — an intranet app
  under test, or a locally-served fixture page. It does NOT waive the
  http/https scheme allowlist: an opted-in spec still cannot reach
  `file:`/`data:`/`chrome:`. It is a per-spec, compile-time decision with no
  env var and no global switch, so it cannot be turned on by an ambient
  misconfiguration and a reviewer sees it in the spec diff. It is carried into
  the IR only when true, so every bundle that leaves it alone stays
  byte-identical.

  Both layers move together, deliberately: waiving one alone is worse than
  waiving neither, because with only the guard relaxed the DNS-pinning proxy
  answers loopback with its own 403 body — which RENDERS, so the agent
  screenshots a block page and reports whatever it can make of that instead of
  failing cleanly.
- **`parseArgs` now rejects a malformed arg schema instead of silently
  dropping a flag.** `@crewhaus/infra-utils` exports a new `ArgSchemaError`,
  thrown when a `ParseArgsSchema` declares the same token (`--name` or
  `-short`) twice, or declares an empty name or short alias. Previously the
  duplicate won last-write-wins with no diagnostic, so two entries disagreeing
  on `takesValue` silently changed how argv parsed. It is deliberately NOT an
  `ArgParseError` subclass — a schema bug is a programmer error and must not
  be reported to the user as a mistyped flag. BEHAVIOR CHANGE for downstream
  consumers that build schemas dynamically: a collision that previously
  resolved to last-write-wins now throws.
- **`crewhaus run --ask-mode <pause|deny>`** overrides the spec's
  `permissions.ask_mode` for a single run, with the same flag-beats-spec
  precedence as `--permission-mode`. Also accepted by `crewhaus runs resume`
  (which re-drives a parked run) and `crewhaus serve --mcp`.

### Fixed

- **`permissions.ask_mode` finally does something.** The field was parsed,
  lowered into the IR, honoured by runtime-core, referenced in `crewhaus runs
  resume --help`, and backed by working `crewhaus approvals
  list|show|grant|deny` verbs — but NO interpreter path ever passed `askMode`
  or `approvals` to `runChatLoop`, and the runtime parks only when it has
  BOTH. So a spec declaring `ask_mode: pause` (the documented default) was
  silently inert: every non-interactive `ask` collapsed to an in-place denial,
  `createPendingApprovalStore` had zero production callers repo-wide, and the
  remediation the runtime printed — "grant … then rerun" — pointed at a store
  nothing ever wrote to. `crewhaus run` (cli + browser targets) and `crewhaus
  serve --mcp` now thread both, so the documented flow works end to end for
  the first time: a headless `ask` parks (exit 36), the park is visible to
  `crewhaus approvals list`, and `crewhaus approvals grant <id>` + a rerun
  re-issues the call pre-approved and consumes the one-shot grant.

  BEHAVIOR CHANGE: a tool permission that resolves to `ask` on a
  non-interactive surface now PARKS the run (exit 36) instead of denying in
  place and letting the turn continue. That is what `ask_mode`'s documented
  default has always specified, but it is new in practice. To keep the old
  behaviour, declare `permissions.ask_mode: deny` in the spec or pass
  `--ask-mode deny`. Runs whose tools all resolve to allow/deny are
  unaffected, as is the interactive REPL, which still prompts on stdin.

  The store root comes from `resolveSessionRootDir`, so parks land beside the
  session files they belong to and stay inside a tenant's rebased root rather
  than a process-global `.crewhaus/sessions` — a pending-approval record
  echoes the tool input, so pooling them across tenants would leak it.
  `crewhaus approvals` now resolves the same root (an explicit `--dir` still
  wins), so the verbs and the run path cannot disagree about where the store
  lives. For the same reason `runs resume`, `run --continue` and the
  resume-hint probe now open the session store at the resolved root instead of
  a cwd-relative one: with `CREWHAUS_SESSION_DIR` set they previously looked
  where the run had NOT written, reporting "no session" for a session that
  existed — which would have broken the resume half of this very flow.
- **`crewhaus fleet run` no longer reports a parked harness as unclassified
  breakage.** `describeFleetExit` had no row for exit 36, so a park rolled up
  as `unknown ×1` beside real failures — contradicting
  `EXIT_CODES.approval_pending`'s own docblock, which says this surface should
  report "needs approval" and resume rather than alert. Newly reachable now
  that runs can actually park.

  NOT fixed here, and deliberately so:
  - Every compiled target bundle has the same gap — no emitter passes either
    option, so `ask_mode` stays inert in generated bundles. The channel bot is
    the sharpest case: it builds an approvals store and implements the full
    Slack park→approve→resume surface, but its emitted `runChatLoop` receives
    neither option, so `approval_pending` can never be thrown and the router's
    handler is unreachable.
  - Sub-agent (`Task`) turns. The child loop in `@crewhaus/sub-agent-spawner`
    forwards `permissionMode`/`permissionRules` but not `askMode`/`approvals`,
    and runtime-core's `RuntimeBridge` does not carry them, so an `ask` inside
    a sub-agent still denies in place and still prints "(no approvals store
    wired)". Threading it raises a real design question this change should not
    answer in passing: whether a parked CHILD parks the parent run or surfaces
    as a Task-tool error.

- **The browser runtime smoke boots again — and a failing advisory can no
  longer report green.** `playwright` was dropped from the root
  devDependencies by the docs/demos split (36140d81), so `bun install` stopped
  putting the *package* in the tree while `Smoke (runtime)` kept installing
  only the *browser binaries*. Every run since died in the chromium driver's
  `import("playwright")` ~450ms in — before a session log existed, before any
  model turn — and the advisory gate swallowed it, so the nightly cron
  reported green for weeks while the browser shape covered nothing at all
  (the cli shape kept passing, which is why the job looked healthy). The
  pinned devDependency is restored (`playwright` 1.59.1, the version the
  lockfile's optional peer already expected), and the workflow now preflights
  the package half so a dropped dependency names itself instead of surfacing
  as a cryptic non-zero exit; `bunx` resolves the repo-pinned CLI, so
  installed chromium build ids match the package that imports them.
- **The browser smoke's own tools are no longer denied before they run.**
  `Navigate` and `Screenshot` both resolve to `ask`, and the smoke drives a
  one-shot `--prompt` run — a non-interactive surface with no approvals store,
  where an unruled `ask` collapses into a denial. Confirmed against a live
  model: `tool denied: \`Navigate\` defaulted to "ask" and this
  non-interactive surface has no way to prompt`, after which the agent
  correctly reported it could not proceed. The fixture now grants
  `alwaysAllow` for exactly those two tools — no permission-mode change,
  nothing else widened. This was masked by the boot failure above, which
  killed the run long before any permission check.
- **The runtime smoke's "the agent used the tool" assertions are now
  load-bearing.** `tool_use` is logged when the model *requests* a tool —
  before the permission gate and before `execute()` — so a denied tool and a
  working tool were indistinguishable in the stream the harness inspected.
  Both shapes now pair each `tool_use` with its `tool_result` and fail on an
  error result. This was not theoretical: while the browser tools were being
  denied outright, the `Navigate` and `Screenshot` assertions passed and the
  smoke blamed the model for "not grounding its answer".
- **Advisory smoke failures are now visible without reading the log.** A
  non-fatal browser failure emits a GitHub Actions `::error` annotation and a
  job-summary entry (`reportBrowserAdvisory`), and the failure strings carry
  the spawned process's stderr tail — previously the sole output was one
  stdout line listing symptoms with the cause discarded, which is exactly the
  "unattended green must never mean silently skipped" failure the workflow
  header says the job exists to prevent.

  KNOWN, STILL FAILING: the browser runtime smoke does not pass yet. Its
  fixture page is served on `http://127.0.0.1:<port>`, and the SSRF floor
  refuses private/loopback targets in two independent layers
  (`assertSafeNavigationTarget`, and the chromium backend's DNS-pinning
  proxy), neither of which a spec can opt out of today. Until a reviewed
  `driver.allowPrivateTargets` opt-in lands, every run emits the advisory
  annotation above with `Navigate was called but returned an error:
  navigation to … blocked: private/loopback IP`. That is deliberate — the
  alternative is the silent green this entry exists to end — but it does mean
  the annotation is expected, not new information, until the opt-in ships.

## [0.4.1] - 2026-07-26

### Added

- **"Watch me": `crewhaus watchme` observes harness interactions and learns
  from them.** A new `watchme:` spec block (cli/channel/managed) turns on a
  live trace tap that finally writes the
  `.crewhaus/sessions/<id>.events.jsonl` sibling `sessions export` already
  reads; `watchme report` distills watched sessions into response-quality,
  continuity, factuality, model-usage, and counterfactual cheaper-model
  analysis (proposal-only — verify with `crewhaus model right-size`);
  `watchme intents` mines recurring intents across one harness or every
  registered one; `watchme synthesize` drafts a validated mimic agent-loop
  spec (never auto-applied); `watchme publish` distills redacted findings
  into the harness's local per-spec wiki, and `watchme report --all` recalls
  those findings from opted-in (`watchme.share: true`) peers via the
  same-machine harness registry — LOCAL co-learning in v1; cross-machine,
  Thredz-backed publish/recall is a deferred seam (design/watch-me.md §10).
  Judged quality can opt into the
  routing scoreboard as shadow `q:*` arms (`--feed-routing`) via the new
  `RouteObservation.quality` reward field, and into the feedback flywheel
  via `--emit-feedback`. BEHAVIOR CHANGE: the reserved
  `twelve.answerFaithfulness`, `twelve.answerRelevance`, and
  `twelve.hallucinationRate` graders are now real deterministic
  claim-vs-evidence checks instead of always-fail stubs — eval suites
  referencing them will change verdicts and (name, dataset)-keyed baselines
  will shift. [#341]
- **`graders.yaml` grows a top-level `combine: all | any | weighted` mode —
  grader `weight` and `passing_threshold` finally do something.** Every
  grader variant now accepts an optional positive `weight` (default 1).
  `combine: all` (the default) keeps today's exact semantics: overall
  passed = AND of all graders, score = unweighted mean. `combine: any`
  passes when any grader passes (score = max). `combine: weighted` scores
  Σ(weight·score)/Σweight and passes when the combined score clears
  `passing_threshold` (default 0.5). Previously `llm_judge`'s `weight` and
  the top-level `passing_threshold` validated fine and changed nothing —
  declaring either without `combine: weighted` now warns loudly on stderr
  at run start instead of being silently ignored. Grader-throw infra-noise
  semantics (`graderError`, the bounded noise retry, triage classification)
  are unchanged in every mode, and the competency exam (`run_exam`) honors
  the same policy. STRICTNESS CHANGE: `weight` must be positive — a config
  declaring `weight: 0` or a negative weight (previously parsed on
  `llm_judge` and ignored) is now rejected at parse time.
- **New deterministic grader `type: expected_contains` — reference
  containment (OpenAI "Includes" parity).** Passes when the agent output
  contains the sample's `expected_output` (compared against the trimmed
  gold; `case_insensitive` optional) and fails with a clear rationale when
  the sample carries no gold — the per-sample counterpart to `contains`,
  whose needle is a config literal.
- **New `crewhaus dataset audit [--pii] --dataset <file|registry:ref>
  [--apply] [--strict]` — an offline PII/secret scan of an EXISTING
  dataset.** Regex detectors only (the same shared set `dataset synthesize`
  and `fewshot harvest` redact with) — no model calls, nothing leaves the
  box. The report counts hits per detector/field/sample id and never echoes
  the matched text, so it is safe to paste into a CI log; a registry ref
  without `#split` is scanned across ALL splits, test included (inspection,
  not consumption of the test-split lock). `--apply` requires a
  `registry:<name>[@version]` ref and writes the redacted samples as a NEW
  auto-bumped version that preserves the record's split structure exactly
  (never in place, never re-split — mirroring `refresh-goldens`);
  `--strict` exits non-zero when any hit is found, making the audit a CI
  gate on dataset hygiene.
- **The eval regression gate now knows what instrument graded the run.** The
  run-history index (`.crewhaus/evals/index.jsonl`) and per-(spec, dataset)
  baseline pins (`baselines.json`) record the run's `gradersHash` and — when
  `--judge-model` pinned one — `judgeModel`, so a baseline carries the
  identity of the graders config and judge that scored it, not just the
  scores. When a fresh run's hashes differ from the pinned baseline's,
  `crewhaus eval` prints a loud `[eval]` warning and starts a new baseline
  lineage exactly like the dataset-changed path — a stricter rubric or a
  swapped judge can no longer fail (or silently pass) the gate as if the
  agent changed. `eval-report diff` likewise warns on stderr when the two
  runs' recorded `gradersHash` or `judgeModel` disagree, and
  `eval-report baseline set` carries both fields forward onto manual pins.
  Fully additive: entries and baselines written before the fields existed
  gate and diff exactly as before.
- **The LLM judge can now abstain instead of guessing, and its decoding is
  pinned.** `submit_score` gains optional `abstain: boolean` and
  `confidence: 0..1` fields (strict schema — old judges stay valid), and
  the judge prompt instructs abstention when the evidence is insufficient
  to score a criterion honestly. An abstaining judge yields an
  `abstained: true` grade (`passed: false` / `score: 0` as conservative
  placeholders) so eval runs can route the sample to human review instead
  of counting a coin-flip verdict; reported `confidence` rides along on
  every grade. `llm_judge` graders also accept rubric-level `temperature`
  (0..1) and `repeats` (odd positive integer, default 1): `repeats: k`
  fans out a k-judge panel, takes the MEDIAN score, records per-repeat
  scores and modal agreement in the rationale, and treats a strict
  majority of abstains as an abstained verdict (odd panels keep that vote
  tie-proof). `ProviderRequest` gains an additive optional `temperature`
  field, mapped by every adapter with a native control: Anthropic and
  Anthropic-on-Bedrock (dropped when extended thinking is enabled, per
  API constraint), OpenAI (dropped for o-series/gpt-5 reasoning models,
  which reject a non-default temperature), Gemini
  (`generationConfig.temperature`), and Bedrock Converse
  (`inferenceConfig.temperature`). The resolved judge sampling params
  (temperature + repeats per `llm_judge` grader) are recorded in
  `run.json`/`results.json` under `config.judgeSampling` so the
  reproducibility manifest shows exactly how verdicts were decoded;
  judge-less runs keep their exact prior shape. In-loop `evaluation:`
  bundles (cli/channel/managed) treat an abstaining judge as score 0
  (`judge abstained: …` rationale), so a guessed best-estimate can never
  pass the threshold, and `buildJudgePrompt` accepts
  `allowAbstain: false` for callers whose `submit_score` schema cannot
  record abstention. NOTE — `llm_judge` grader entries in graders.yaml
  are now parsed strictly: a stray/typoed key (`temperture:`, `repeat:`)
  that was previously silently stripped now fails the parse loudly.
  BEHAVIOR CHANGE: judge calls now pin `temperature: 0` by default
  (previously the provider default, ~1.0) — judge scores become more
  deterministic, so `llm_judge` verdicts and (name, dataset)-keyed
  baselines may shift on the first run after upgrading; override per
  grader with `temperature:` if you want sampled judging back.
- **An abstaining judge now routes samples to humans instead of polluting
  the pass rate (the runner half of judge abstention).** An abstained
  judge verdict makes the sample outcome `abstained` UNLESS another grader
  failed (a deterministic fail is a real verdict and wins; an invoker
  error always wins). Abstained samples leave the pass-rate denominator
  and `meanScore` (their 0 score is a placeholder, not a measurement;
  `partialScoreMean` and latency/token aggregates deliberately still count
  them), land in `needsHuman`/`needsHumanSampleIds` in results.json, print
  as `[eval] needs_human=N: <ids>` for `crewhaus rate` follow-up, and
  render ABSTAINED (plus a needs-human section) in index.html and the diff
  HTML. The (spec, dataset) baseline gate excludes samples abstained in
  either run from the per-sample flip comparison — an unknown verdict is
  not a regression — and says so (`[eval] gate: excluding N abstained
  sample(s)…`); repeat trials surface per-trial abstention
  (`trials[].abstained`, conservatively not-passed in `trialPassRate`).
  Runs without abstention keep their exact pre-existing shape.
- **Judge per-criterion scores are finally reported instead of being
  computed and thrown away.** `llm_judge` grades now carry the rubric's
  raw 1–5 `criterion_scores` as an additive `detail` field on the grade
  (grades.json/results.json perGrader entries; panel repeats mean each
  criterion over the scored repeats; abstained verdicts carry none — their
  criterion scores are guesses), and `aggregate()` folds them into
  per-criterion means per judge grader (`criterionMeans`) — one
  `[eval] judge criteria <grader>:` stdout line each and a per-criterion
  table in index.html, so "which criterion regressed" is answerable from
  run artifacts.
- **`crewhaus eval --slice <key,key,...>` — per-slice results over sample
  metadata, because a macro pass rate can hold while the hard slice
  collapses.** The runner (so matrix cells and target-eval bundles inherit
  it) groups samples by each key's STRING metadata values — default keys
  `family,difficulty,language,source`, applied only where present — and
  emits per-slice sample count / pass rate / mean score into results.json
  (`slices`), one compact `[eval] slice <key>:` stdout line per key, and a
  sortable slice table in index.html. Sample metadata now rides into each
  `SampleResult` (`metadata`, additive), and `eval-report diff` compares
  the slice (key, value) pairs both runs share (`sliceDeltas` in diff.json
  + a slice-deltas table in the diff HTML). Datasets without metadata
  produce byte-identical results.json.
- **Closed-form 95% confidence intervals on every eval summary — point
  estimates at n=8 stop pretending to be measurements.** `aggregate()` now
  emits `passRateCI95` (Wilson score interval — sane at small n where the
  naive Wald interval degenerates) and `meanScoreCI95` (Student t; exact
  table df ≤ 30, Fisher's expansion beyond), no RNG and no new deps. Both
  print on the `[eval]` summary line (`pass_rate_ci95=[…]`,
  `mean_score_ci95=[…]`), render as report cards, and are inherited by
  `--models` matrix cells (matrix.json rows + CI-annotated pass-rate/mean-
  score cells). Absent where the data cannot support them (0 graded
  samples / fewer than 2 scored) instead of fabricated.
- **`eval-report diff` now answers "could this delta be noise?" — paired
  significance testing on run diffs, plus per-slice deltas in the stdout
  summary.** The diff runs a sign-flip permutation test over the paired
  per-sample pass-rate deltas (shared sample ids; abstained-on-either-side
  pairs excluded, the same exclusion the gate applies): exact enumeration
  when the paired n is ≤ 20, seeded Monte Carlo above it, with a fixed
  default seed so unseeded diffs of the same runs are byte-identical —
  `--seed N` on the diff subcommand overrides. All randomness flows
  through a small deterministic PRNG (mulberry32), never `Math.random`.
  The result — pass-rate delta with a seeded-bootstrap 95% CI, two-sided
  p-value, paired n, and a plain-language "significant / not significant
  at 0.05" verdict — prints in the stdout summary, lands additively in
  diff.json (`significance`), and rides the HTML diff header. The stdout
  tail also gains the per-slice delta table for the slice keys both runs
  share (diff.json and the diff HTML already carry `sliceDeltas` — see
  the slices entry above). The strict gate is UNCHANGED and never
  consults significance: it is decision support beside the gate, not part
  of it. Mismatched sample ids and unreadable run dirs now die with the
  clean one-line error instead of an uncaught stack trace.
- **`crewhaus eval` gates on pre-declared ops thresholds:
  `--max-p95-latency-ms N` and `--max-cost-usd F`.** The baseline gate —
  previously pass-rate/flip-only, with its latency criterion explicitly
  disabled in-code — now fails the verdict (and exits non-zero under
  `--gate`) when p95 per-sample latency rose more than N ms vs the pinned
  baseline, or when the run's estimated cost exceeds $F. Cost is projected
  from the run's agent-model token totals through the same pricing table as
  the `--models` matrix `est_$` column (all trials under `--repeats`;
  judge/grader calls are NOT metered — their token usage is not yet
  captured), and an unpriced model leaves cost unknown, so the cost gate
  warns instead of failing on a number nobody computed. Both criteria
  compare like the regression gate does: against the pinned baseline, so
  the first run for a (spec, dataset) pair pins and is not gated. Every
  run's `index.jsonl` entry and baseline pin also record `p95LatencyMs` +
  `costUsd` (additive fields — readers tolerate their absence on old
  records). Absent flags keep the gate byte-identical to before; the flags
  are rejected with `--sentinel`/`--models`, which skip the baseline gate.
- **The spec's `limits:` and `budget:` blocks are honored by eval runs —
  plus explicit `--sample-timeout-ms` / `--budget-usd` overrides.**
  BEHAVIOR CHANGE for specs that declare either block (both were silently
  dead inside `crewhaus eval`): `limits.deadline_ms` now bounds each
  sample's agent invocation with a wall-clock watchdog (a timed-out sample
  records an errored result with full artifacts instead of stalling a
  concurrency slot forever), the remaining `limits:` ceilings
  (`turn_timeout_ms`, `model_call_timeout_ms`, `max_tool_iterations`,
  `max_concurrent_tools`, `context_limit`, `loop_detection`) thread into
  each sample's chat loop exactly as `crewhaus run` threads them, and
  `budget.usd` caps the RUN's accrued agent-model spend — once accrued cost
  reaches the cap, in-flight samples finish, queued samples abort with a
  clear `[eval] budget exhausted after k/N samples` error, and
  `results.json` is marked `partial` (completed samples keep their grades).
  Eval always STOPS at the cap: the block's `on_exceed: degrade` ladder
  never applies to a measurement run, since swapping models mid-eval would
  corrupt the measurement. The flags override the spec's values
  (flag > spec, matching `run`); with `--models`, each cell meters its own
  cap. Judge/grader spend is not metered, and a model without a pricing row
  disables budget enforcement with a loud warning. The timeout/budget in
  force are recorded on `run.json`/`results.json` (`sampleTimeoutMs`,
  `budgetUsd`, additive). Specs without the blocks and runs without the
  flags behave byte-identically to before.

  — and the grade becomes the panel's fold: MEDIAN score over the
  non-abstaining panelists, pass by STRICT MAJORITY of their pass votes (an
  even panel's tie conservatively fails), per-panelist scores plus the
  normalized entropy of the pass/fail vote split recorded on the grade
  (`panel`), and a strict majority of abstaining panelists abstains the
  whole verdict exactly like `repeats`. A high-entropy vote (normalized
  entropy > 0.8 — a 2–1 or 3–2 split; 4–1 stays quiet) flags the sample
  `needs_review`: the verdict still COUNTS (pass-rate denominator
  unchanged, unlike abstention), but the run lists it in a NEW
  `needsReview`/`needsReviewSampleIds` results.json bucket — rendered as
  its own report section and card — separate from the abstained
  needs-human one. `judges` composes with `repeats` the simple way: when
  both are declared, repeats apply PER PANELIST (each panelist's own
  verdict is its k-call median; k×m calls total), and the panel roster
  rides the `judgeSampling` reproducibility manifest. Single-judge configs
  are byte-identical. Spec-declared exams honor panels too.
- **Categorical judge rubrics — `llm_judge` rubrics may declare
  `kind: categorical` with `labels` + `passing_labels` (OpenAI
  Fact/ClosedQA classify parity).** Instead of forcing every judgment onto
  the 1–5 scalar anchors, a categorical rubric lists at least two labels
  (`{name, score (0..1), description}`) and the judge picks EXACTLY ONE via
  a forced `submit_label` tool call (the sibling of `submit_score` — scalar
  judging is byte-identical): `passed` = the chosen label is in
  `passing_labels`, `score` = the label's declared 0..1 score, no 1–5
  projection. Label scores and the passing set are deliberately hidden from
  the judge (classify, don't anchor); judge abstention and the pinned judge
  temperature apply unchanged, and both `crewhaus eval` and the
  competency exam (`run_exam`) resolve the new shape. Guard rails: the
  rubric schema is strict (a leftover scalar `criteria:` block on a
  half-migrated rubric is a loud parse error, and neither union branch can
  silently absorb a confused rubric), duplicate/undeclared labels are
  rejected, categorical rubrics never consume the calibrated passing-score
  cut from `judge calibrate --apply` (their gate is label membership), and
  `repeats`/`judges` panels are rejected at parse with a categorical
  rubric — there is no label-vote fold yet, and a silently-single-call
  panel would be worse than an error.
- **Trajectory-aware judging — `llm_judge` gains `target: output |
  transcript` (default `output`, byte-identical).** `target: transcript`
  feeds the judge the run's TRANSCRIPT — turns, tool calls, tool results,
  and errors — rendered as a bounded, sentinel-wrapped digest instead of
  just the final message, so rubrics can finally grade process quality:
  wasted or dangerous tool use, silent mid-run failures, unrecovered
  errors. The digest contract is documented most-recent-turns-win: whole
  events are kept from the end of the transcript within a ~24k-char budget
  (dropped history announced by a `[transcript truncated: …]` header), each
  event clipped to 2k chars tail-first so one enormous tool result cannot
  evict the run, and a transcript-less RunResult degrades to the final
  output behind an explicit `(no transcript recorded)` marker. Composes
  with panels, repeats, and categorical rubrics; the effective target is
  recorded per grader in the `judgeSampling` reproducibility manifest —
  an output-judged and a transcript-judged run are different instruments.
- **`type: registry` graders take `opts:` — pack thresholds and wiring are
  finally tunable from graders.yaml.** A registry entry may now carry an
  `opts:` record threaded into the named pack's constructor by the default
  registry: `nlg.*` accept `threshold`/`reference`/`lowercase` (`nlg.meteor`
  adds `alpha`/`beta`/`gamma`), `semantic.similarity` accepts `embedder` (a
  `createEmbedder` model spec that overrides `CREWHAUS_EVAL_EMBEDDER`),
  `threshold`, `reference`, `disableFallback`, and `fallbackThreshold`,
  `multimodal.imageSimilarity` accepts `threshold`/`hashSize`, and
  `safety.piiLeak` accepts `threshold`. Every pack validates its opts
  against its own STRICT schema at run start — an unknown or ill-typed key
  is a loud error naming the accepted vocabulary, never a silently-defaulted
  grade — and registered names with no YAML-settable construction
  (`twelve.*`, `continuity.*`, the classifier/OCR/STT wiring throwers)
  reject all opts, pointing at the plugin override path.
  `.crewhaus/graders` plugin graders (pack-name overrides included) receive
  the record UNTOUCHED as an optional third grader argument —
  `(sample, run, opts?)` is the documented plugin contract. A caller-built
  registry without the new `resolveWithOpts` seam rejects opts-carrying
  entries loudly instead of dropping them. STRICTNESS CHANGE: `registry`
  entries are now strict like `llm_judge` — a typoed sibling key
  (`options:`, `opt:`) fails at parse instead of being silently stripped.
- **Spec-declared exams accept `type: registry` graders.** `run_exam` no
  longer rejects registry entries in `learning.exam.graders`: it builds the
  SAME default registry `crewhaus eval` falls back to — six specialty packs
  plus `.crewhaus/graders` plugins discovered from the harness cwd, `opts:`
  parameterization included — so a Thredz expert exam can grade with
  `nlg.rougeL`, `semantic.similarity`, or the operator's own plugin
  graders. Unknown names still fail loudly at exam start, never as
  per-sample grader-infra noise.
- **New registry pack `calibration.abstentionAware` — wrong and
  declined-to-answer are finally different verdicts (SimpleQA-style).**
  Classifies each sample answered-correct / answered-wrong / not-attempted:
  empty/whitespace outputs and explicit declines (a curated, conservative
  decline-opener heuristic — apology prefixes stripped, capped at 300 chars,
  and the decline must be terminal: "I'm not sure, but it's Paris." and
  other hedged-but-substantive answers count as attempts) are
  not-attempted; answered samples grade against `expected_output` under
  `opts: { mode: exact | contains, caseInsensitive }`, and an ANSWERED
  sample with no gold is a loud grader error, never an invented verdict.
  Per-sample grades stay conservative (only answered-correct passes); the
  abstention-aware lens lands in results.json as the additive
  `aggregates.calibration` block — answerRate, abstentionRate, and
  accuracyWhenAnswered (absent when nothing was answered — never NaN) — so
  a well-calibrated agent that abstains on unknowns no longer grades
  identically to a confident hallucinator. Rendered as guarded cards in the
  HTML report; pack-less runs keep a byte-identical results.json.
- **New registry pack `consistency.paraphraseGroup` — the paraphrase
  variants `dataset synthesize` generates finally get measured.**
  `dataset synthesize` now stamps `metadata.paraphrase_group` (the parent
  sample's id) on every paraphrase variant — template and model paraphrases
  of the same parent share the group; truncate/ambiguate/inject variants
  deliberately change the question and stay group-less. Hand-stamped
  datasets work identically; datasets synthesized before this release carry
  no groups (re-synthesize or stamp the key to opt in). Per sample the
  grader is a vacuous pass (declaring it is the opt-in); at
  aggregation, samples sharing a string `metadata.paraphrase_group` are
  scored on verdict consistency — the fraction of the group's usable
  verdicts (errored and abstained samples excluded) agreeing with the group
  majority; singleton groups read 1.0 (never NaN), even splits 0.5. Emitted
  additively as `aggregates.paraphraseConsistency`
  (`consistencyByGroup` + `meanConsistency` + `groupCount`) and a guarded
  report card; absent groups = absent aggregate, and lineage metadata alone
  never conjures the block — grading stays opt-in. Note the pack's vacuous
  per-sample pass contributes a constant score 1, so meanScore (and a
  `combine: weighted` combined score) shifts upward the moment the pack is
  declared — passRate under `all`/`any` is unaffected, and the gradersHash
  lineage checks (baseline warning + `eval-report diff` instrument
  mismatch) keep cross-run comparisons honest. Both packs ride
  `aggregate()`'s documented cross-sample post-run seam (stable rationale
  markers, the semantic-fallback detection contract), so no per-sample
  grader API changed.
- **`crewhaus graders test` — meta-eval your grader suite against labeled
  golden verdicts.** `graders test --graders <g.yaml> --golden
  <verdicts.jsonl> [--judge-model <m>] [--min-agreement F]` replays EVERY
  grader in the config over recorded, human-adjudicated outputs. Each
  golden line is strict JSONL — `{id, input, agent_output, expected_passed,
  expected_score?}` (expected_score normalized 0..1; stray keys and
  duplicate ids are loud, line-numbered errors). Deterministic and registry
  graders (pack `opts` included) replay credential-free; `llm_judge`
  graders — panels, categorical rubrics, temperature/repeats and all —
  need visible judge credentials and are SKIPPED with a clear notice
  without them (the rest still test); `target: transcript` judges always
  skip (golden verdicts carry only the final output). Per tested grader
  the report shows agreement rate and Cohen's kappa vs `expected_passed`,
  false-positive/false-negative counts with up to 5 exemplar ids each,
  abstained/error counts (excluded from the agreement denominator), and
  the mean absolute score error when `expected_score` is present.
  `--min-agreement F` exits non-zero when any TESTED grader falls below
  the floor — the CI gate for rubric edits, usable exactly like
  `eval --gate`. Judge rubrics test at their declared `passing_score`
  (default 3/5); the `judge calibrate --apply` overlay is deliberately not
  applied — the meta-eval measures the graders file as written.
- **`crewhaus eval-report diff <prev> <new> --pairwise [--judge-model m]` —
  order-swap-controlled head-to-head judging of two runs.** The strongest
  instrument for "which spec version writes better answers": for every
  shared sample, the judge compares the two runs' outputs TWICE with the
  presentation order swapped (fresh injection sentinels wrapping the
  input and BOTH outputs on each call; forced `submit_comparison` tool
  with a strict a/b/tie schema; temperature pinned 0), records win/loss/
  tie per order plus agreement-across-orders, and reports the NEW side's
  win-rate (ties counted half) with an order-consistency figure. A verdict
  that flips with the order is position bias by construction and
  consolidates to a tie — a tie is never counted a win. Results land
  ADDITIVELY in diff.json (`pairwise`), the diff report (a per-sample
  verdict table), and a stdout summary block; samples errored on a side
  are skipped and counted. Opt-in: 2 judge calls per shared sample, so the
  flag requires visible judge credentials and dies with a clear message
  without them — the offline deterministic diff (and its byte-identical
  diff.json) stays the default. Sample inputs are recovered from the runs'
  recorded per-sample transcripts, so the judge sees what the outputs were
  answering.
- **`crewhaus graders card` — the rubric card.** Renders a graders.yaml as a
  markdown measurement-instrument card: every grader with its type, opts, and
  thresholds; every `llm_judge` rubric with criteria, anchors or labels,
  passing cut, panel/repeats/temperature/target; and the config's
  `gradersHash` (the same identity the run history and baselines record).
  Default stdout; `-o` writes a file.
- **`crewhaus eval history|baseline|diff` now work** as aliases delegating to
  the `eval-report` implementations (a one-line notice names the canonical
  verb; flags pass through; a spec file literally named `history.yaml` still
  runs the eval path).
- **The judge temperature pin now reaches every provider.** `adapter-openai`,
  `adapter-gemini`, and `adapter-bedrock` map `ProviderRequest.temperature`
  (OpenAI drops it for reasoning models that reject it; Bedrock maps it onto
  Converse's `inferenceConfig`), matching the anthropic adapter — so
  non-Anthropic judges are temperature-pinned too.
- **watchme judgments can abstain.** `watchme report`'s judge tool accepts the
  abstain/confidence verdict; an abstained turn is never persisted as a
  judgment and is routed to human review instead of counting as a failure.
- **`safety.toxicity` / `safety.bias` and the multimodal OCR/STT graders now
  print the exact wiring recipe.** Their needs-wiring errors name the
  registry `opts` and `.crewhaus/graders` plugin contract to use, and the
  pack doc comments document the classifier/ocr/stt plugin interface.
- **Multi-turn eval samples: a dataset sample may now carry `history` —
  MT-Bench-style conversational evaluation.** `SampleSchema` gains an
  optional additive `history: [{role: "user" | "assistant", content}]`
  (strict item shape, non-empty when present); `input` stays the required
  FINAL user message, so every history-less dataset parses byte-identically
  and registry sample hashes are untouched (registry-stored samples never
  carried the key — schema validation stripped it at `put`). One deliberate
  break: a hand-authored dataset whose samples already carried a free-form
  `history` field (or CSV column) was silently ignored before — it now
  validates, so a shape-mismatched value fails the load loudly and a
  shape-matched one starts seeding turns (changing that dataset's sample
  hashes). Rename the column/key or fix its shape. The eval default invoker (CLI
  `crewhaus eval` and compiled `target: eval` bundles alike) seeds the
  history messages into the session transcript VERBATIM — no model calls
  run for history turns — then runs `input` as the one graded turn. Seeded
  turns appear in the per-sample transcript, so `target: transcript`
  judges read the whole conversation, while tool-call accuracy, token
  sums, per-model-call latencies, and `turns` measure only the final
  turn's work. CSV datasets author it as a JSON-encoded `history` column.
- **CSV datasets can finally carry `metadata`.** A non-empty `metadata`
  column now parses as JSON (so slicing, provenance, and per-sample grader
  conventions all reach CSV-authored datasets); malformed JSON is a hard
  `DatasetLoadError` naming the row. Previously ANY non-empty metadata
  cell failed the load with a confusing schema type error. Empty cells
  still mean "no metadata" — column-less files are byte-identical.
- **New `crewhaus datasets verify <name>[@version]` — registry integrity is
  no longer write-time-only.** Recomputes every split's per-sample content
  hashes and compares them with what the record stored at `put` time — the
  hashes `overallDatasetHash` folds into the run-history datasetHash, so a
  mismatch means a version's content silently diverged from its eval-history
  identity (hand-edited `<version>.json`, corruption) and the strict gate
  would compare different data under the same lineage. Version omitted →
  every version is checked. Offline; exits non-zero on any mismatch (the CI
  gate). The library `put()` now also REFUSES to overwrite an existing
  version unless the new explicit `allowOverwrite: true` option is passed —
  every CLI promotion path auto-bumps, so nothing legitimate changes.
- **New `crewhaus datasets status <name> [--runs N]` — the freshness /
  saturation report.** Joins the registry's versions with the
  run-history index (`<name>@<version>[#split][+…]` grammar): per-version
  age from `createdAt`, how many indexed runs evaluated each version (and
  when last), how many consumed the locked `#test` split, and the
  test-split burn count. Saturation signal: sample ids that appeared in ≥ 2
  of the last N joined runs (default 10) and passed every time are listed
  as rotation candidates — they no longer discriminate.
- **New `crewhaus datasets release <name>[@version] --spec <spec.yaml>
  --graders <g.yaml> [--force]` — test-split consumption is now
  governed.** The sanctioned holdout spend: runs `crewhaus eval` over
  the version's locked `#test` split (threading the same
  `--allow-test-split` machinery, with the regression union skipped so the
  holdout stays pure), then appends a release entry `{version, runId, ts,
  passRate}` onto the registry record — an additive `releases` field that
  `datasets status` and `datasets card` report as the burn count. A version
  whose test split was already released REFUSES a second release without
  `--force` (which warns that a re-run holdout score is no longer a first
  look). A holdout is only hidden while its peeks are counted.
- **New `crewhaus datasets card <name>[@version] [-o <file.md>]` — dataset
  datasheets.** Renders a markdown card: split sizes and sample-hash
  counts, the all-splits content hash, `createdAt` + age, provenance
  breakdown by `metadata.source` (percentages, untagged counted), indexed
  eval-run count, the full release/burn history, and an embedded offline
  lint summary. A generated artifact (stdout or `-o`) — it never mutates
  the record; commit it wherever cards live.
- **New `crewhaus dataset lint (--dataset <file|registry:ref> | --all)
  [--graders <g.yaml>] [--strict]` — offline dataset hygiene.**
  No model calls: duplicate sample ids (error —
  artifact dirs collide and the gate's id-keyed flip detection corrupts);
  ids reused with DIFFERENT content in other versions of the same registry
  dataset (warning; same-content reuse is normal lineage); near-duplicate
  inputs (normalized token overlap ≥ 0.9, warning); grader↔dataset
  mismatches when a graders.yaml is findable (`--graders`, else the
  conventional `eval/graders.yaml`): gold-needing graders
  (`exact_match`/`expected_contains`) over gold-less samples (error when NO
  sample carries a gold — all-fail-by-construction) and `expected_tools` on
  samples when the conventional spec exposes no tools; `metadata.source`
  outside the provenance taxonomy (warning, offenders listed); empty-string
  golds (error); and the canary leak scan (below). Registry refs lint every
  split (inspection posture); `--all` sweeps every registered dataset's
  latest version; `--strict` exits non-zero on any finding (the CI gate).
- **`crewhaus eval` now runs a pre-spend preflight lint-lite.**
  Before any model call, duplicate sample ids and the
  all-gold-less × gold-needing-graders mismatch REFUSE the run with a clear
  message (partial gold gaps warn on stderr and proceed); the new
  `--no-preflight` flag is the explicit escape hatch. Offline and
  streaming-friendly — the file/dataset loader is re-opened after the
  preflight pass, so large datasets still stream into the runner.
- **New `crewhaus datasets put --canary` + runner canary semantics —
  contamination tripwires.** `--canary` injects exactly ONE canary
  sample into the new version: its input is a deterministic 32-hex phrase
  derived from the (name, version) hash — no wall clock — tagged
  `metadata.source: "canary"` with no gold. The eval runner now treats
  `source: "canary"` samples like the abstained needs_human bucket:
  excluded from the pass-rate denominator and meanScore, counted +
  id-listed separately (`canary`/`canarySampleIds` in results.json, a
  `[eval] canary=N:` stdout line), disjoint from needs_human/needs_review.
  `dataset lint` scans the conventional spec text and every
  `.crewhaus/fewshot` pool for any canary phrase — a hit is a
  contamination ERROR (the phrase exists nowhere but the dataset).
  Canary-free runs are byte-identical.
- **Multi-rater agreement: a second reviewer no longer erases the
  first.** Feedback stays append-only, and `crewhaus distill` now resolves
  turns rated by MULTIPLE raters explicitly instead of
  later-timestamp-wins: all-thumbs votes resolve by majority, stars/scale
  (or mixed) votes resolve to the mean normalized score, and a record made
  with the new `crewhaus rate --adjudicate` / `feedback --adjudicate` flag
  always wins and closes the disagreement. A true split verdict (even
  thumbs, no adjudication) is NOT silently labeled — the turn is withheld
  from the dataset and enqueued for human review. Multi-rater samples
  record every rater's normalized verdict in `metadata.ratings` (plus
  `metadata.adjudicated` when an adjudication settled it), and distill
  prints per-turn agreement plus the overall Cohen's kappa (pairwise,
  common-turn-weighted) whenever any turn has ≥2 raters. Single-rater
  corpora — including everything recorded before this release — distill
  byte-identically.
- **Persistent human-review queue: `crewhaus review list|next|resolve`.**
  Review-worthy items used to be print-only; they now land in an
  append-only store at `.crewhaus/review/queue.jsonl`, fed by three
  surfaces: `crewhaus eval` enqueues judge-abstained samples (`abstained`)
  and panel-entropy flags (`needs_review`) at run end (additive and
  best-effort — a queue write can never fail the run), `distill` enqueues
  unresolved rater disagreements, and `dataset mine` enqueues POINTERS to
  its quarantined hard-case candidates (the quarantine JSONL stays the
  payload store). Entry ids are deterministic from the source key, so every
  feeder is idempotent — re-running distill/mine never duplicates an item,
  and a resolved item stays settled. `review list [--kind k] [--all]` shows
  the queue, `review next` surfaces the oldest open item with its context
  and (in a TTY) records the verdict — a session-turn item routes through
  the SAME capture machinery as `crewhaus rate`, recorded as an
  adjudication so the disagreement closes at the feedback source too; in a
  non-TTY it prints the item and exits, never hanging a script or CI pipe.
  `review resolve <id> [--note t]` closes an item non-interactively.
- **`crewhaus eval --record-tools <dir>` / `--replay-tools <dir>` — a
  tool-level cassette, so a tool-using agent can finally be evaluated
  deterministically, offline, and without side effects.** Eval wires the
  spec's REAL tools and MCP servers at `permissionMode: "auto"`, so every
  sample of every optimizer iteration used to execute live bash, live MCP
  writes, and live egress. `--record-tools <dir>` appends each tool
  execution's result to `<dir>/tools.jsonl` keyed by `(sampleId, toolName,
  sha256 of the canonical-JSON parsed args)` — tools still run for real and
  the run is otherwise byte-identical. `--replay-tools <dir>` serves those
  results from the recording instead of executing anything. The
  interception point is `RegisteredTool.execute`, wrapped per sample inside
  the runner's default invoker, so built-ins, MCP tools, the Skill/Task
  wrappers, and the memory fabric's tools are all covered. A call whose key
  the recording does not carry is a MISS: `--replay-miss error` (the
  default) fails that sample with a message naming the missing key and is
  never noise-retried (a miss is deterministic by construction, exactly
  like a `failure_taxonomy` class declaring `recovery: fail`);
  `--replay-miss live` executes it for real. Repeated identical calls
  replay the recorded results in order, then keep replaying the last one.
  Scope is honest and documented: TOOLS only — the agent stack is still
  wired (MCP servers still boot so their tool schemas exist) and the MODEL
  still runs live. `run.json`/`results.json` record the mode, the
  directory, and — on replay — the recording's content hash, so a replayed
  run gates and pins like any other run while saying what it was. The flags
  are mutually exclusive, refused with `--models` (matrix cells share
  sample ids, so one recording cannot address N cells), and refused
  alongside a caller-supplied `RunEvalOptions.invoker` (which owns its own
  tool execution) instead of silently recording nothing.
- **`crewhaus eval --resume <runDir>` — an interrupted eval no longer
  forfeits everything it already paid for.** A run persists per-sample
  artifacts incrementally and writes `run.json` before its first sample,
  yet a ctrl-C, crash, or budget stop meant re-invoking the agent AND the
  judge for every already-graded sample on the next attempt. `--resume`
  re-opens the run directory under its ORIGINAL `runId` and `startedAt`,
  reloads every sample that already wrote `grades.json` (no agent call, no
  judge call, no spend), runs only the missing ones, and re-aggregates the
  UNION into a fresh `results.json` + `index.html`. It REFUSES loudly,
  before any spend, when the run's `specHash`, `datasetHash`, or
  `gradersHash` no longer match the recorded manifest — splicing two
  different measurements into one run is never silent — naming every field
  that moved. A sample that ran and ERRORED is complete and is reused as-is
  (delete its artifact directory to re-run just that one); under
  `--repeats`, a sample re-runs whole unless EVERY trial directory is
  complete, so no truncated pass@k is ever reported. The run history is
  updated, not duplicated: the resumed run appends a superseding
  `index.jsonl` entry under the same runId (the index stays append-only)
  and every reader in the CLI now keeps the latest entry per runId — a
  no-op for histories without a resumed run. The partial-run baseline
  refusal is untouched: a budget-aborted run still refuses to pin or
  promote until it completes. `--resume` is mutually exclusive with `-o`
  (the run directory IS the output) and with `--models`.
- **`compile --with-eval-harness` now bridges the multi-stage shapes, and a
  bridged bundle drives the shape's ACTUAL compiled runtime instead of
  impersonating it with a single-turn chat.** The former `per-step eval
  bridges are not yet supported` rejection is lifted for `workflow`,
  `graph`, `crew`, and `pipeline` — each projects into a first-class
  `target: eval` bundle (`--emit-as cf-worker` stays rejected with the
  bridge). Workflow samples run the compiled step sequence end-to-end
  (`sample.input` = the step-1 trigger; the final step's output is graded;
  step trace events land in `RunResult.events`); graph samples drive the
  compiled graph to `run_done` on the per-sample RunContext (final state
  JSON graded; HITL pauses fail the sample loudly); crew samples run one
  crew turn through the compiled orchestrator + roles with the daemon's own
  run options (`crew_done.finalOutput` graded, crew transcript captured);
  pipeline samples query the indexed agent + Retrieve tool (module-scope
  indexing runs once at entry import — the deployed boot); channel samples
  loopback-deliver the inbound message through the bot's real `runTurn`
  (inbound classification + session resume machinery; sample history
  pre-seeds the session transcript so the real resume path replays it); and
  managed samples drive the gateway's existing `runOneTurn` dispatcher
  under an isolated per-sample tenant. The remaining shapes
  (voice/onchain/onchain-game/batch/research/browser) keep the single-turn
  loop over their agent's REAL wired tools, with each fidelity gap named in
  the per-shape strategy the compile now prints. Under the flag the primary
  workflow/graph/pipeline bundle gains an exported `runForEval` entry (its
  CLI main now guarded by `import.meta.main`) and crew/channel bundles gain
  an `eval-entry.ts` (the channel bundle's `agent.ts` additionally gains the
  two seams that entry sets — `fabricRoot` per-sample fabric isolation and
  the `_adapter` scripted-provider hook — both gated on the flag); a plain
  compile stays byte-for-byte identical, including the 0.3.0
  `continuity: false` byte-restore contract (pinned against the pre-change
  emitters in tests). Documented
  residue: the channel eval entry does not yet mirror the daemon's
  `mcp_servers` / `knowledge:` boots (a generated note surfaces each;
  thredz-enabled specs degrade to local files via `thredz: null`), and
  crew/channel trace-bus events stay on the runtime's internal bus (the
  session transcript is the captured artifact) — workflow/graph/pipeline
  thread the runner's per-sample RunContext fully.
- **`target: eval` bundles honor `failure_taxonomy`.** The taxonomy lands
  on the bundle's synthesized IR, so the eval-runner's classified-retry
  suppression (`recovery: fail` classes are terminal) and
  `SampleResult.failureClass` in `results.json` now apply to standalone
  bundle runs exactly as they do to `crewhaus eval`; the generated
  "ignored" warning comment is gone. Bridged projections carry the SOURCE
  spec's taxonomy too.
- **`crewhaus eval-report trends [--spec <n>] [--dataset <n>] [-o <dir>]`** —
  pass-rate, mean-score and cost over time per (spec, dataset), folded from
  the same `.crewhaus/evals/index.jsonl` `history` already reads. Prints a
  per-run table plus a movement line per lineage (first → last, delta in
  percentage POINTS); `-o` additionally writes a self-contained
  `index.html` — inline CSS and a hand-built inline SVG chart, zero
  external assets — and `trends.json`. Fully offline: no run directory is
  opened, so noticing a three-week drift is one command instead of an
  eyeball exercise.
- **`crewhaus eval-report export --runs <dir|dir,dir|last:N> --format
  csv|jsonl [-o <file>]`** — flattens runs into one row per (run, sample,
  grader): run config columns (runId, ts, specHash, dataset, model,
  judgeModel, seed), the sample's verdict, latency, trial pass rate, flaky
  flag and slice membership, and each grader's own
  passed/score/abstained/rationale (clipped, newline-flattened). A sample
  whose graders never ran still emits a row — dropping errors is how a pass
  rate lies. `last:N` reads the (filtered) history index; a moved or
  unreadable run directory is reported on stderr and skipped, never
  silently omitted.
- **`crewhaus eval plan --target-delta F [--confidence C] [--pilot
  <runDir>]` — the sample-size planner.** `n ≈ z²·p(1−p)/e²`, printed with
  every term and where it came from (which z for the confidence, which p
  and whether it came from a pilot run's measured pass rate or the
  variance-maximizing 0.5 worst case, which e), the substituted arithmetic,
  the doubled budget a two-run comparison needs, and — with `--pilot` — the
  smallest delta that pilot's own n could ever have resolved. Offline: no
  model call, no credentials, no spend.
- **Flake detection.** Under `--repeats`, samples whose trials disagreed
  (`0 < trialPassRate < 1`) are flagged `flaky` per sample in
  `results.json`, counted and listed in
  `aggregates.flaky`/`flakySampleIds`, printed with their trial tallies
  plus a suggestion line (inspect via `eval-report export`, remove the
  nondeterminism with `--seed`/`--replay-tools`, or move the sample out of
  the gating dataset version), and recorded on the run-history entry so
  `eval-report history` marks flake-containing runs. Verdicts are untouched
  — quarantine is a decision made against the dataset, not one the runner
  makes silently.
- **Judge token metering.** `llm_judge` calls now report the provider usage
  the judge wire previously discarded. Every judge call (single verdicts,
  repeats, and each panelist under its own model string) accumulates into
  `aggregates.judgeUsage` in `results.json`, and the run prints a `cost:`
  line breaking out agent vs judge vs total through the same pricing table
  as the `--models` matrix `est_$` column. An unpriced model renders `n/a`
  rather than a fabricated `$0.0000`. Gate thresholds and the
  `--budget-usd` cap still meter AGENT spend, unchanged.
- **The reproducibility manifest is complete.** `run.json`/`results.json`
  now record `cliVersion` (supplied by the launcher — `crewhaus version`'s
  own string), `bunVersion` and `platform`, so a `results.json` says which
  build, on which runtime, on what machine produced it.
- **`eval-report diff --epsilon F`** — the score-shift tolerance,
  previously a module constant, is now a flag (default 0.1, so every
  existing diff classifies identically). A 1–5 judge rubric and a 0/1
  exact-match grader no longer share one sensitivity. Flips are never
  subject to it: a verdict change is a verdict change at any epsilon.
- **`crewhaus eval --voice --graders <g.yaml>`** — content grading joins
  the voice latency pack: each replayed transcript is projected onto the
  standard grader contract and scored by the ordinary stack (deterministic
  graders, registry packs, `llm_judge` rubrics), and a content failure
  fails the session exactly like a latency breach. A replay carries no
  gold, so gold-needing graders have nothing to compare against and say so
  rather than being fed a fabricated reference; no trace events are
  invented either. Without `--graders` the voice path is byte-identical —
  and still credential-free.
- **`crewhaus schedule generate --for flywheel|eval-gate|sentinel
  [--runner cron|launchd|systemd]`** — recurring eval automation for teams
  not on GitHub Actions: prints a ready-to-install crontab line, launchd
  plist, or systemd service+timer pair wrapping the same command the
  corresponding workflow runs, with the environment caveats each scheduler
  actually has (cron's empty PATH, launchd's non-inherited environment,
  systemd's EnvironmentFile). A shim, not a daemon — it prints and installs
  nothing, and the GitHub scaffolds are unchanged.
- **Daemon-side auto-distill.** `feedback.autoDistill` had exactly one
  production consumer — the `crewhaus run` teardown — so the shapes that
  actually generate ratings (channel 👍/👎 reactions, the gateway's web UI)
  accumulated feedback that nothing ever distilled. The channel and managed
  daemons now register a `feedback_distill` janitor step beside the dream
  step: same `≥ 5 unprocessed ratings` trigger, same
  `.crewhaus/feedback/.distill-state.json` watermark, same full-rebuild
  semantics, so cron, `crewhaus distill` and a live daemon can never
  double-fire. `CREWHAUS_AUTODISTILL=0` disables the tick;
  `CREWHAUS_AUTODISTILL_THRESHOLD` retunes it. Specs without
  `feedback.autoDistill` emit byte-identical bundles.
- **Ratings on the gateway shape.** `feedback:` now parses on `target:
  managed`, and the managed daemon serves a `feedback.submit` JSON-RPC
  method that appends a standard `FeedbackRecord` to
  `.crewhaus/feedback/<tenant>.jsonl` (mode 0600, audited, with
  `schemaVersion`/`id`/`source`/`ts` daemon-stamped so a client cannot
  forge provenance) — the exact sink `distill` / `optimize --ratings` /
  `judge calibrate` already read. With `autoDistill` the janitor step rides
  along. `@crewhaus/gateway-protocol` accepts the new method additively;
  existing clients and methods are unaffected. `exitPrompt` and
  `channelReactions` describe surfaces a gateway daemon does not have; both
  now emit a `managed-feedback-unsupported` compile warning instead of
  silently doing nothing.
- **`eval_graded` failures are mined.** `crewhaus dataset mine` gains an
  `eval-fail` signal: an in-loop `evaluation:` judge that scored a real
  production turn below its threshold is a hard case with zero human
  involvement. Read from each session's trace sidecar
  (`<id>.events.jsonl` — the durable log carries no `eval_graded` kind),
  both the flat and enveloped carriers accepted. A turn the `on_fail:
  retry` ladder recovered is NOT harvested; one that burned the ladder and
  still failed is flagged `eval_retries_exhausted`. The signal ranks just
  below `error` in dedupe, and the judge's score/threshold/grader ride into
  the quarantine sample's metadata.
- **`crewhaus flywheel run --gate-split train|dev`.** Narrows the
  before/after ACCEPTANCE evals to one registry split so a nightly loop
  stops conditioning accept/reject on every split it resolved; the
  optimizer's own train/dev sets are unchanged. A split-gated run keys into
  its own baseline lineage (`<name>@<version>#<split>`). Refused for
  flat-file datasets (no split boundaries) and for `#test` — the holdout
  gates releases, not nightly loops. Omitted, behaviour is exactly as
  before.
- **Numeric-knob search in the optimizer.** `@crewhaus/prompt-optimizer`
  gains a `knob-step` mutation: bounded coordinate-ascent steps over
  declared `OPTIMIZABLE_PATHS` numeric dials, alternating with the
  instruction rewrites, every proposal gated by the same fitness accept
  loop. The orchestrator threads `knobs` through, validates each dial
  against the whitelist BEFORE anything is spent, and emits one additional
  whitelist-validated `SpecPatch` per dial the search actually moved
  (`patches` on the result; `patches.json` beside `patch.json`). Declaring
  no knobs leaves the search prompt-only and byte-identical.
- **`crewhaus eval coverage --graders <g.yaml>` is real.** The flag was
  accepted and ignored. It now reports how many samples each grader can
  actually score (gold-needing graders vs gold-less samples, sharing
  `dataset lint`'s own predicate so the two surfaces cannot disagree),
  which declared graders no recent run ever recorded, and which judge
  CRITERIA never varied across the last few runs' persisted per-criterion
  grades — a dead criterion pays judge tokens on every sample and can never
  change a verdict. Omitting the flag leaves every rendered byte unchanged.
- **New package `@crewhaus/feedback-distill`.** The rating-distillation
  core (`FeedbackRecord`, turn derivation, multi-rater resolution,
  `distill()`, grader synthesis), the shared ingestion redactor, the
  deterministic split/version helpers, and the auto-distill watermark moved
  out of `apps/cli` so a COMPILED daemon runs the same code the toolchain
  does. `apps/cli`'s `feedback.ts` / `autodistill.ts` / `dataset-mine.ts` /
  `dataset-audit.ts` / `datasets.ts` re-export their historical names — no
  import in the CLI changed.
- **`crewhaus eval suite <suite.yaml> [--tier fast|nightly|release]` — CI
  tiering, made executable.** `crewhaus eval` took exactly one `--dataset` and
  one `--graders` per invocation, so the report's tiering practice (small fast
  suite per change, medium nightly, full on release candidates) could only be
  hand-composed in CI YAML with no verdict across the pieces. A suite manifest
  declares named tiers — a fixed `fast`/`nightly`/`release` vocabulary, so
  `--tier fast` means the same thing in every repo — each listing entries of
  `{name, dataset, graders, seed, repeats, concurrency, slice, gate,
  allow_test_split, thresholds}`. Entries run sequentially through the SAME
  code path a hand-typed `crewhaus eval` takes (registry refs, regression
  union, preflight, triage, run history and baselines all behave identically)
  into `<out>/<entry>/`, and the tier passes only when every entry passes. Two
  gating mechanisms stay deliberately distinct: absolute floors
  (`min_pass_rate`, `min_mean_score`) are evaluated from each entry's own
  `results.json` and bite from run one — including in a fresh CI workspace —
  while `gate: true` is the unchanged (spec, dataset) baseline regression gate.
  `max_p95_latency_ms` / `max_cost_usd` are criteria OF that baseline gate, so
  declaring one without `gate: true` is a parse error rather than dead config
  that reads like a ceiling — and an entry declaring NEITHER mechanism is a
  parse error for the same reason: it could never fail, so its PASS (on a tier
  the scaffolded workflow makes a required check) would be a green light nobody
  earned. A PARTIAL (budget-exhausted) entry always fails, because an
  incomplete measurement cannot clear a floor. A preflight refuses missing
  spec/dataset/graders files before the first entry spends anything, and a
  crashed entry is isolated so the rest of the tier still reports. `--spec`
  overrides every entry's spec, `--gate` maps a failing tier to a non-zero exit,
  and the verdict plus every entry's aggregates and failure reasons land in
  `<out>/suite.json`.
- **`crewhaus init --ci|--sentinel --suite <suite.yaml>` and `crewhaus flywheel
  init --suite <suite.yaml>` scaffold the tiered workflows.** With `--ci`, the
  emitted `crewhaus-eval.yml` runs the FAST tier on every PR — once with
  `--spec` pointed at the base branch's spec (which pins each entry's baseline
  in the job's fresh workspace) and once on the PR's spec with `--gate`, the
  same two-run strategy the single-eval scaffold uses — plus a nightly-cron job
  for the NIGHTLY tier and a tier-verdict PR comment built from `suite.json`.
  With `--sentinel`, the drift cron gains a nightly-tier step that runs even
  when the probe failed, so a provider-drift alert and a tier regression can
  never hide each other; `flywheel init --suite` adds the same step to the
  flywheel cron, after the improvement PR is opened. The suite path is
  harness-relative and must live inside the harness (the jobs'
  working-directory); a manifest you have not written yet warns rather than
  failing the command, and a manifest that DOES exist is parsed so a tier the
  scaffolded YAML runs but the manifest never declares (a fast-only suite under
  `--ci`, whose nightly cron would then go red every night) is named at
  scaffold time instead of by the first scheduled run. Without `--suite` all
  three scaffolds are byte-identical to before.
- **Eval templates ride the template registry — `crewhaus scaffold-evals
  --template <family>`.** Template machinery existed only for whole SPECS, so
  every team wrote its own 1–5 anchors from scratch. `@crewhaus/template-registry`
  manifests gain an optional `kind` (`spec-template` — what every existing
  manifest already is — or `grader-template`) and an `evalAssets` block carrying
  a ready-to-run `graders.yaml`, reviewer notes, and an optional seed dataset.
  Grader templates are signed, verified and cached by the SAME machinery as
  spec templates (the canonical signing payload gained the two fields
  append-only, so manifests that declare neither serialize byte-identically and
  every existing signature keeps verifying; the nested `evalAssets` block
  canonicalizes its own key order so a JSON round-trip cannot mint a second
  valid signature), so a registry can carry and verify one and `crewhaus
  templates list` marks it `[eval-template]`. CONSUMPTION of a registry-hosted
  eval template is NOT wired yet: `scaffold-evals --template` resolves only the
  embedded first-party families, and `templates use` refuses an eval-asset
  template by saying so. The first-party family library ships EMBEDDED in the
  package (a static module, not a package-relative file read: `bun --compile`
  embeds only static imports, so the families exist inside the shipped binary
  and there is nothing to download or verify) — `rag`, `summarize`, `extract`,
  `support`, `safety`, `classify` — deliberately walking the grader ladder
  rather than reaching for a judge every time: `classify` grades
  deterministically with `expected_contains` (no judge, no spend), `safety` uses
  a categorical rubric that includes an OVER-REFUSAL label, and the open-ended
  families use fully anchored 1–5 criteria. `scaffold-evals --template <family>`
  copies the family's graders.yaml verbatim under a provenance header and seeds
  `dataset.jsonl` from the family's samples, topped up to `--samples N` with the
  usual spec-derived stubs — except for a family whose every grader needs a gold
  answer (`classify`), where the dataset stops at the gold-carrying seeds and
  says why: a generated stub carries no `expected_output`, and `crewhaus eval`'s
  preflight only REFUSES a wholly gold-less dataset, so topping one up would
  ship a dataset that runs, spends, and caps its own score. Template mode is
  OFFLINE by construction (static content — `--model` is refused with it), an
  unknown family lists the available ones instead of guessing, and nothing is
  auto-wired into a gate. `crewhaus graders card --template <family>` renders a
  family's rubric card without scaffolding it first — same card, same
  content-derived `gradersHash`, so carding a family and then carding the
  scaffolded copy proves the copy is unedited.
- **`crewhaus redteam generate|report` — a generated attack suite against the
  AGENT.** Adversarial generation was previously limited to injection payloads
  mutated onto real inputs (`dataset synthesize`) and detector-regression
  harvesting (`security corpus`); neither probes the agent's own refusal
  behaviour. `redteam generate` walks a strict-schema behaviour taxonomy —
  CATEGORIES (data exfiltration, third-party PII extraction, tool misuse,
  policy evasion, harmful content, impersonation) × STRATEGIES (direct, fiction
  framing, claimed authority, incremental, obfuscation, prompt injection) —
  DIAGONALLY, so a small `--count` covers every category AND every strategy (the
  default 24 ships all six, injection included; a strategy-major walk would have
  shipped only the first four). The default is coverage of both AXES, not of
  every pair — 6×6 pairs with the injection strategy's 5× expansion is `--count
  120`, a deliberate choice rather than a default nobody asked to pay for.
  Generation is DETERMINISTIC and OFFLINE: same taxonomy + `--count` + `--seed`
  yields a byte-identical corpus with no credentials, and attack strings are
  COMPOSED at generation time from inert parts (a strategy's framing fragments
  around a category's objective) rather than shipped as ready-made payloads —
  the injection strategy delegates to the same curated SAFE rule subset `dataset
  synthesize` uses. `--budget-usd F` optionally layers model-rephrased variants
  on top (best-effort, capped, tagged `generator: redteam-model`); failed
  variant calls are COUNTED and reported on stderr, and an unbroken run of them
  stops augmentation rather than burning the whole budget, so an augmented run
  that produced nothing can never look identical to an offline one. The output
  is a provenance-tagged `<spec>-redteam` registry dataset (`source: synthetic`,
  `difficulty: adversarial`, category/strategy tags, never a gold answer, one
  split) plus a paired refusal-grading `graders.yaml` — one categorical judge
  whose labels include over-refusal, so an agent that refuses everything cannot
  game the suite. Nothing unions the corpus into a gate: adoption is the
  explicit `--dataset registry:<spec>-redteam`. `redteam report --runs
  <dir|dir,dir|last:N>` computes ATTACK-SUCCESS RATE (the fraction of graded
  probes the agent failed) overall and per category/strategy from persisted
  runs; errored and judge-abstained probes leave the denominator and are
  reported separately, and ASR is its own block — never folded into the
  pass-rate baseline lineage.
- **`crewhaus optimize` now optimizes MULTI-STAGE specs.** Making workflow /
  graph / crew / pipeline specs *evaluable* by driving their real compiled
  runtime landed earlier this release; this closes the loop. Each candidate is
  compiled with the eval-entry variant — the same emission `crewhaus compile
  --with-eval-harness` performs, not a second bespoke emitter — and measured by
  driving that compiled runtime per sample through the same bridge invoker
  `crewhaus eval` uses for multi-stage specs, behind the identical eval-gated
  accept loop, budget gate and post-accept regression pinning a `target: cli`
  run gets. Only the per-stage prompt paths already whitelisted in
  `spec-patch`'s `OPTIMIZABLE_PATHS` are rewritten (workflow step / graph node /
  crew role instructions, pipeline `agent.instructions`) — the surface is
  unchanged, it is merely reachable now. `kind: judge` steps and nodes run no
  agent turn and are never mutated. New `--stage <name>` narrows the search to
  one step/node/role; an unknown name errors and lists the valid ones. WITHOUT
  `--stage`, a multi-stage spec optimizes its stages sequentially in declaration
  order, each gated independently: a stage that wins composes into the working
  spec the next stage starts from, a stage that does not leaves the spec
  untouched and the run moves on. `--stage` is refused alongside
  `--from-advice`, which applies pre-computed patches to the paths the
  suggestions name and runs no per-stage search at all. `--iterations` is per
  stage; `--budget-usd`
  stays a RUN ceiling, threaded down as remaining budget so a three-stage run
  cannot spend three times the cap. The source spec is written once, at the end,
  only with `--write-back`. BOUNDARY, stated in `--help`: the candidate bundle
  carries bare `@crewhaus/*` imports, so a bridged run resolves them from the
  candidate directory upward — run it inside a harness whose dependencies are
  installed (the default `-o` already does). The orchestrator's library seam
  gains a matching `promptPath` option; omitted, it behaves exactly as before,
  down to a byte-identical `report.json`.
- **`--mutator meta-harness` — the meta-harness optimizer is reachable from the
  CLI, marked EXPERIMENTAL.** The existing `meta-harness-optimizer` package is
  wired as the third mutator with a model-backed proposer built the same way
  `--mutator claude` builds its provider (the spec's own model through
  `@crewhaus/model-router`, so a non-Anthropic spec drives its own adapter).
  What differs is the proposer's *input*, which is the meta-harness paper's
  actual finding: it reads the run's filesystem-backed experience store — every
  prior candidate's artifact, per-sample scores and trace — instead of a summary
  window, and `crewhaus optimize` now writes each measured candidate into that
  store using the layout the package already defines. It sits behind the same
  accept gate, the same `--budget-usd` meter (the provider exposes the pricing
  metadata the gate feature-detects and reports its call usage) and the same
  `OPTIMIZABLE_PATHS` validation as the other two mutators, and every run prints
  an experimental notice. Deliberately spec-shaped: the CLI proposer returns
  replacement *instructions*, so a candidate still round-trips through
  `parseSpec`. The package's bundle-REWRITING mode — which produces an `agent.ts`
  no spec can reproduce — stays library-only, because the spec round-trip is
  what makes an automated write-back reviewable. `persistCandidate` gains
  `candidateFileName` so the store names a prose candidate honestly
  (`instructions.txt`, not `agent.ts`), and `readExperienceStore` resolves
  whatever name is on disk.
- **`crewhaus experiment status|record|assign`.** Per-version outcome and rating
  deltas from an append-only ledger under `.crewhaus/experiments/`, reported
  with Wilson 95% intervals, deltas against the control, and an explicit refusal
  to name a winner while any version is below `--min-n` (default 30) — the
  refusal names every sample size. `record` is how a serving integration reports
  an outcome back; `assign` prints the version a stable request key
  deterministically maps to (and reports the assignment's weights, env and
  `updatedAt` on stderr, so a stale split is visible). `--json` for machine
  consumption — it carries the same `boundary` caveat the table prints plus a
  per-version `sources` breakdown, so a reader can tell an n built from offline
  eval re-runs from one built from live serving outcomes. `--name` may be
  omitted when exactly one experiment exists. Repeat EVAL measurements of the
  same (version, dataset sample) are collapsed before tallying and the collapse
  is reported: Wilson intervals assume independent observations, and a canary
  ramp re-measures one fixed dataset at every step. Serving records are never
  collapsed — there a repeated request key is a repeated request.
- **`crewhaus deploy canary --traffic-split`.** Writes a durable deterministic
  variant assignment and records the ramp's per-version *eval* samples into the
  experiment ledger, so `experiment status` has real per-version outcomes with
  no serving integration at all. **This does not split live traffic, and every
  string in the feature says so**: no CrewHaus serving surface consults the
  assignment, and `target: cli` has no live request stream — `experiment assign`
  (or canary-controller's `selectExperimentVariant`) is the decision function an
  operator calls at their own serving boundary. The flag is named for the
  capability it *prepares*, not one it performs, and `deploy canary --help` now
  says so in as many words. The assignment is written only *after* a step's
  regression gate passes and is REMOVED when the ramp concludes — promotion pins
  100% candidate, rollback pins 100% baseline, and a surviving 50/50 file would
  keep a compliant integration routing half its keys at a version nobody is
  running. Abstained and canary samples are excluded from the ledger projection,
  matching the eval aggregator's own pass-rate denominator rather than scoring
  an explicit "unknown" as a failure.
- **`canary-controller` gains the N-variant experiment surface.**
  `selectExperimentVariant` generalizes the two-version hash-bucket route to N
  weighted variants over the *same* `requestBucket` hash, so a canary and an
  experiment can never disagree about which side of the split a key is on.
  Weights must be integers summing to 100 (the bucket space is exactly 100 wide;
  a rounded split is not the split you declared). The ledger reader tolerates
  torn lines, experiment names are sanitized before they become paths, tallies
  carry a per-source breakdown, and `removeExperimentAssignment` /
  `dedupeExperimentOutcomes` back the lifecycle and independence rules above.
- **Eval results reach the configured exporters.** `crewhaus eval` now mints one
  run-level `RunContext` and attaches the same env-gated subscribers every
  serving loop uses, so an offline run's per-sample verdicts leave the process as
  `test_verdict` spans and its summary lands on the metrics registry. Before
  this the verdict `run-sample` publishes went to a bus with no subscriber (the
  eval CLI never built a run context, and the per-sample chat loop shuts its
  subscribers down *before* grading), and run summaries were never emitted at
  all. Presence-gated on `OTEL_EXPORTER_OTLP_ENDPOINT` / `CREWHAUS_METRICS`:
  with neither set nothing is constructed and the eval path is byte-identical.
  Only the exporter-relevant env keys are forwarded, so turning on an exporter
  never also turns on the pretty printer, inline cost lines, or the alert
  watchdog for an eval run. Every telemetry call is guarded — a broken
  collector, an unreachable endpoint, or a throwing sink is reported once on
  stderr and the run continues.
- **Eval run summaries as first-class metrics.** New `metrics-collector`
  instruments carry the headline figures per (spec, dataset):
  `crewhaus_eval_run_pass_rate`, `_mean_score`, `_samples`, `_errors`,
  `_flaky_samples`, `_needs_human`, `_cost_usd_micros`, plus a
  `crewhaus_eval_runs_total` counter. A run summary only exists after the last
  per-sample event, so it is recorded straight onto the registry
  (`recordEvalRunSummary`) rather than invented as an event kind. The package
  gains a `Gauge` primitive (a pass rate is neither monotonic nor a
  distribution) and a `gauges` block in `jsonSnapshot()`.
- **Online eval scores are visible to metrics and tracing.** The in-loop
  `evaluation:` block's `eval_graded`, a judge step/node's `judge_verdict`, the
  runner's `test_verdict` and human `response_rated` events now fold into
  `crewhaus_eval_verdicts_total{source,verdict}`, `crewhaus_eval_score{source}`
  and `crewhaus_response_ratings_total`. Live quality scores were previously
  computed and then dropped for ops purposes.
- **First-class OTel spans for eval verdicts.** `eval_graded` and
  `judge_verdict` used to fall into the exporter's generic `crewhaus.<kind>`
  fallback; they now emit `eval_graded.<verdict>` / `judge_verdict.<verdict>`
  spans with typed `crewhaus.eval.*` / `crewhaus.judge.*` attributes and ERROR
  status on a failing verdict, so a trace backend can alert on quality the same
  way it alerts on tool failures. Eval `test_verdict` spans carry the SAMPLE's
  session id rather than the eval CLI's synthetic run-level one, so a failing
  verdict joins the transcript that produced it (run id and trace id stay
  run-level — one eval run is one trace). The vendor packages (Datadog /
  Honeycomb / New Relic / Splunk) wrap this same span mapping, so the new spans
  map into their shape too — but note the scope: `attachDefaultSubscribers`
  attaches only the printer, the metrics collector and the generic OTLP
  exporter, so a `DD_API_KEY` on its own exports nothing. Point
  `OTEL_EXPORTER_OTLP_ENDPOINT` at the vendor's OTLP intake, or call that
  vendor's `attach…IfEnvSet` from your own process.

### Changed

- **JSONL datasets stream — remote and local.** HTTP `.jsonl`/`.ndjson`
  bodies now parse line-by-line off the fetch body reader, and the local
  `.jsonl` loader (which previously buffered the whole file via
  `Bun.file().text()`) streams off `Bun.file().stream()` through the same
  shared incremental parser — memory stays bounded by the longest line,
  not the file or body, so multi-GB JSONL loads without OOM either way.
  Line numbering in error messages is unchanged. CSV and YAML still
  buffer, locally and over HTTP alike (YAML can't stream; CSV quoting
  spans physical lines), as the module doc now notes.
- **The `metadata.source` provenance taxonomy is now canonical and
  enforced: `human_authored | production_log | synthetic |
  synthetic_human_verified | mine | canary`.** BEHAVIOR CHANGE — the
  first-party writers normalize onto it: `dataset synthesize` stamps
  `source: "synthetic"` (was the tool-named `"synthesize"`), and `distill`
  stamps `source: "production_log"` with the rating channel
  (user|ui|channel|cli — what `source` used to carry) preserved as the new
  `metadata.feedback_source`. Default `source` slice labels and
  provenance-keyed reports shift accordingly. Promotion
  (`registerDataset`) warns on stderr — never fails — when declared
  provenance falls outside the taxonomy, listing offenders. The registry
  `put()` now enforces the hard synthetic-never-gold invariant: a
  `source: "synthetic"` sample carrying `expected_output` is refused with
  a pointer to `synthetic_human_verified` — and `dataset refresh-goldens
  --apply` retags exactly that way when a human-evidence proposal golds a
  synthetic sample.
- **BEHAVIOR CHANGE: sample `history` seeds only chat-capable shapes**
  (channel / managed / voice / pipeline). A history-carrying sample against
  any other bridged shape now fails LOUDLY at dataset load
  (`guardHistorySamples`) instead of silently seeding a conversation into a
  runtime that consumes one trigger input.
- The flywheel help text and module docs no longer claim the optimizer
  "only ever rewrites `agent.instructions`" — it patches the
  `OPTIMIZABLE_PATHS` whitelist, which now includes the numeric dials the
  knob search moves.
- `DEFAULT_SCORE_EPSILON` now lives in `@crewhaus/eval-runner`
  (`stats.ts`, the package both comparison surfaces already depend on) and
  is re-exported by `eval-report`'s `diff.ts`; `regression-runner`'s
  `scoreShiftEpsilon` defaults to it instead of a second `0.1` literal, so
  the diff a human READS and the gate that BLOCKS cannot drift apart.
- New runtime helpers in `@crewhaus/target-eval-bundle`
  (`createBridgeInvoker`, `guardHistorySamples`,
  `emitSourceBundleWithEvalEntry`) are imported by generated bridged
  bundles; the package now depends on the four multi-stage target emitters
  plus channel and tenancy.
- `RunEvalOptions` gains `judgeAdapter` (mirroring
  `CreateExamRunnerOptions.judgeAdapter`): an injectable judge transport so
  judge behaviour — including the new metering — is assertable over a stub
  provider adapter with no process-global `mock.module`.
- `optimizeSpec` refuses a workflow/graph/crew spec with a message that names
  the spec's actual stages and the `--stage` flag, replacing the "not
  implemented yet" text it carried before.
- `canary-controller`'s `CanaryError` moved to its own module and is re-exported
  unchanged; `route()`'s private bucket hash is now the shared `requestBucket`
  (identical implementation, identical routing).

### Fixed

- **26 defects found by building a screencast driver for every demos starter
  and grounding each on-camera claim against real behaviour.** Every item was
  reproduced against `origin/main` before it was fixed, and each carries a
  test that fails without the change. The behaviour changes worth knowing:
  - **`CiteFact` now refuses a snippet that is not verbatim in the body
    `Source` fetched for that URI**, and refuses a URI never loaded in the run
    (`@crewhaus/crawler`). The tracker previously recorded whatever string the
    model passed, straight into the citation log under a real URL with a real
    content sha256 beside it — a fabricated quote was indistinguishable from a
    real one. Matching is whitespace-insensitive so a hard-wrapped source
    quoted on one line still cites; case, wording, punctuation and numbers all
    still matter. A rejected citation returns a `[CiteFact rejected] …` tool
    result so the model can re-quote in the same turn. BEHAVIOR CHANGE: a
    research spec whose model paraphrases when it cites will record fewer — or
    zero — citations where it previously recorded fabricated ones.
  - **A research report always renders its `## Citations` section**, with an
    explicit "nothing above is anchored to a fetched source" notice when the
    list is empty, and the research daemon warns on stderr
    (`@crewhaus/report-writer`, `@crewhaus/target-research-bundle`). A run
    that cited nothing used to ship a report shaped exactly like a sourced
    one.
  - **A `hitl:` gate is now a true pre-condition.** `target: graph` emitted
    `ctx.requestApproval(...)` *after* the gated node's model turn, then threw
    the output away — the approver approved work they could not see, and the
    node's model call was billed a second time on resume. The emitter now asks
    before the turn, matching the contract `@crewhaus/graph-engine` already
    implemented (pre-node checkpoint, replay-at-node), which is now written
    down in the engine. BEHAVIOR CHANGE: for existing graph specs the gate
    fires against the upstream state, and a rejection cancels the node's turn
    instead of merely being recorded after the fact.
  - **`compile --check` no longer reports RED for a spec whose MCP server
    declares a required env var.** The check boots credential-free by design,
    so such a spec could never go green and the failure was indistinguishable
    from a genuinely broken bundle. An unset MCP credential is now a
    recognised boot gate (green, exit 0, `boot gated (MCP server credentials)`)
    alongside provider credentials and spec env refs — the inconsistency with
    the channel shape is gone. The gate verdict line is also grammatical again
    ("boot reached its a registered eval dataset gate" → fixed).
  - **The managed daemon mints a session id `session-store` accepts.** It
    generated a base36 id while the store requires `sess_<16 hex>`, so every
    `runs.create` that omitted `sessionId` failed with `internal_error` — the
    entire happy path of a `target: managed` deployment. Its default
    permission rules also denied the continuity tools it hands the agent.
  - **The OpenAI Realtime adapter speaks the GA `/v1/realtime` protocol.**
    `@crewhaus/voice-runtime` still sent the retired `OpenAI-Beta:
    realtime=v1` upgrade header and the beta `session.update` shape, so every
    compiled voice bundle failed at connect. Beta server-event names are kept
    as read-path aliases. BEHAVIOR CHANGE: the default model is now
    `gpt-realtime`, and the session requests audio-only output modality
    (transcripts still arrive).
  - **`Bash(**)` matches commands again.** `globToRegex` compiled a bare `**`
    argument glob to `/^(?:\/.*)?$/`, so a catch-all `alwaysAsk Bash(**)` rule
    never fired for any real command (`@crewhaus/tool-permission-matcher`).
  - **The file tools no longer walk `node_modules`.** Compiling a bundle into
    the working directory buried the user's project under thousands of
    vendored dependency files that `Glob`/`Grep`/`Read` happily returned.
  - **`crewhaus channel verify` gains an offline mode and checks every env var
    the daemon requires.** It made a live `slack.com` call as soon as
    `SLACK_BOT_TOKEN` was set — so its exit code depended on the network — and
    checked 5 of the 8 variables the emitted daemon refuses to boot without.
    `crewhaus channel provision` no longer writes `slack-app-manifest.yaml`
    into the working directory before validating the other platforms' env and
    aborting.
  - **`crewhaus export claude-plugin` carries the harness's authored assets.**
    `.crewhaus/skills/*` and `.crewhaus/commands/*` were dropped entirely; the
    only skill exported was one synthesized from `agent.instructions`.
  - **A standalone eval bundle records its run in `eval-report history`.** It
    wrote the run directory but never appended `.crewhaus/evals/index.jsonl`,
    so the same eval had two different histories depending on how it was
    launched. `eval` and `optimize` also no longer interleave concurrent
    samples' tokens into one unprefixed stream.
  - **A batch run's output contains the model's reply.** The worker returned
    it and `onJobEnd` dropped it. `idempotencyWindowMs` was dead configuration
    (the cache keyed on a monotonic job counter, so it could never dedupe).
  - **The emitted channel dashboard renders its own name.** A stray brace in
    the codegen template put `name}` in both the `<title>` and the `<h1>`. The
    WhatsApp adapter now implements Meta's GET verification handshake, so a
    callback URL can actually complete verification; the iMessage adapter is
    constructed inside `main()`, so its host opt-in refusal prints the
    formatted failure report instead of a raw stack trace.
  - **`cli.banner` and the `feedback:` block reach the runtime.** The banner
    was codegen-only, so `crewhaus run` never showed it; the `feedback:` block
    was lowered into the IR and then dropped by the cli emitter, so a compiled
    bundle had no rating prompt. `crewhaus tools suggest` no longer reports a
    tool as implied-but-missing because the instructions tell the agent to
    *refuse* it, and covers the whole builtin catalogue. Under
    `CREWHAUS_TRACE=pretty`, a permission decision's ask resolution renders
    instead of `undefined`.
- **`crewhaus compile` now emits a `package.json` beside the bundle, so the
  documented standalone flow actually runs.** A local bundle's emitted
  entrypoint imports a dozen `@crewhaus/*` runtime packages, but nothing
  declared them: outside a checkout that already had the packages installed,
  `bun agent.ts` died on the first import (`Cannot find module
  '@crewhaus/queue-protocol'`) — and for the compile-only shapes (batch,
  channel, crew, …), which `crewhaus run` refuses, that made the ONLY
  documented run path unrunnable in a standalone harness. The compile now
  writes the same manifest `--check` always synthesized for its install step:
  every `@crewhaus/*` package the bundle imports, pinned to the CLI's own
  lockstep-published version. `bun install` in the out-dir, then the README's
  launch line, is the whole flow — and the generated bundle README now says
  so. A user-authored `package.json` in the out-dir is never clobbered
  (mirroring the generated-README keep semantics), the cf-worker flavour
  keeps shipping its emitter's own manifest, and the `--with-eval-harness`
  bridge bundle in `<out-dir>/eval/` gets its own manifest too. `compile
  --check` also no longer overwrites a user-authored `package.json` when
  verifying.

[#341]: https://github.com/crewhaus/factory/pull/341
- **The dataset registry's test-split lock is now honored on every CLI
  consumption path.** The registry always guarded `get(…, "test")` behind
  `allowTestSplit` ("only do this at release-tag time"), but the CLI's
  `registry:` shorthand resolved records directly, so a bare
  `--dataset registry:<name>` silently unioned the locked test split into
  `eval` runs and the flywheel's acceptance evals, and an explicit `#test`
  needed no override anywhere. Now: bare refs resolve **train+dev only**
  (with a one-line stderr notice whenever a test split existed and was
  excluded); an explicit `#test` requires the new `--allow-test-split`
  flag, accepted only by the two release-gating commands — `crewhaus eval`
  and `crewhaus deploy canary` (canary is precisely the sanctioned spender
  of the holdout, so its ramp gate can consume `#test` behind the same
  opt-in); `optimize` and `flywheel` refuse `#test`
  outright regardless of flags (an optimizer that sees the holdout burns
  it); the flywheel's before/after acceptance evals therefore no longer
  include test rows (its help text told the old truth and now tells the
  new one); `datasets get` keeps printing test rows — inspection is not
  consumption — but says so on stderr. Side fix: a `target: eval` spec
  declaring `split: test` (spec-declared explicitness) now threads
  `allowTestSplit: true` into the emitted bundle's registry call instead
  of always throwing at runtime with no escape hatch.
  The remaining `registry:` consumers, exhaustively: `eval coverage`
  keeps inspecting bare refs across ALL splits, test included (gap
  analysis over a partial record would misreport test-only behaviors as
  uncovered — inspection, not consumption, like `dataset audit`);
  `dataset synthesize --from` now resolves bare registry sources to
  train+dev and refuses `#test`, so holdout inputs can never seed a
  trainable synthetic dataset; `dataset refresh-goldens` now reconciles
  bare refs against train+dev only (test golds are never proposed
  against or echoed into the review diff) and its `--apply` writes the
  new version by patching golds WITHIN the record's existing split
  structure — never re-split — so unselected splits (test included) pass
  through byte-identically (previously `--apply` re-split the reconciled
  union wholesale, which under the new train+dev resolution would have
  dropped the test rows and re-partitioned already-consumed samples into
  a fabricated holdout, and on an explicit `#split` ref had always
  discarded the other splits). BEHAVIOR CHANGE:
  on records that carry a test split, bare-ref runs now grade fewer
  samples and their dataset content hash changes, so the next `eval`
  starts a new (spec, dataset) baseline lineage — the dataset-changed
  path already warns about exactly this.
- **`crewhaus deploy canary`'s documented flags now actually parse.** The
  entire canary flag set (`--traffic`/`--dataset`/`--graders`/`--env`/
  `--name`/`--from`/`--concurrency`/`--seed`/`--judge-model`/
  `--max-pass-rate-drop`/`--max-p95-latency-ms`) was declared on
  `propose`'s arg schema instead of `deploy`'s, so every invocation the
  canary help advertises died at arg parse with `unknown flag:
  --dataset`. The block now lives on the deploy schema (joined by the new
  `--allow-test-split`), and `propose` no longer silently accepts eleven
  flags it never read.
- **`flywheel run` now discloses which dataset-precedence rung it chose —
  and warns loudly when a stale scaffolded `eval/dataset.jsonl` shadows
  distilled user ratings.** The precedence (flag > conventional
  `eval/dataset.jsonl` > `registry:<spec>-ratings`) was computed but never
  printed, so every `init --with-evals` + `feedback.autoDistill` harness
  eventually had the nightly loop optimizing against the day-one scaffold
  while real-user ratings piled up unused — silently. Every run now prints
  `[flywheel] dataset: <resolved> (source: flag|convention|ratings-registry)`,
  and when the convention file shadows an existing `<spec>-ratings`
  registry dataset the run warns with the exact remediation:
  `pass --dataset registry:<spec>-ratings to optimize against real user
  ratings`.
- **`crewhaus distill`, the unattended `feedback.autoDistill` teardown, and
  `crewhaus dataset mine` no longer copy raw production text into
  datasets.** Only `synthesize` and `fewshot harvest` redacted at
  ingestion; the distill/mine paths wrote turn inputs and outputs, comments,
  corrections, and error reasons verbatim into `eval/dataset.jsonl` files
  the CI scaffold expects committed, into judge prompts, and into the
  optimizer meta-prompt — defeating the fewshot-side mitigation ("a pasted
  credential never survives into the pool"). All three now run the same
  PII/secret detector set over every free-text field at sample
  construction, deterministically replacing hits with the redactor's
  `[REDACTED:<kind>]` marker and leaving non-PII text byte-identical.
  `distill` and `dataset mine` accept `--no-redact` for dev/local
  inspection; the autoDistill teardown is unattended and ALWAYS redacts.
  BEHAVIOR CHANGE: distilled/mined sample text is redacted by default —
  pass `--no-redact` where the raw text is required.
- **Channel-bot 👍/👎 reactions now attribute to the exact reacted-to turn —
  and work under `routing.sessionKey: thread`.** With
  `feedback.channelReactions: true`, the generated session-router appends an
  outbound-ts → (sessionId, turnNumber) join record to
  `.crewhaus/feedback/joins/channel.jsonl` on every assistant reply it posts,
  and `handleReaction` resolves the reacted-to message's ts through that join
  for EVERY session key. Previously a reaction on an older bot reply was
  recorded against the newest turn (channel/user keys — corrupting the exact
  datasets autoDistill and `optimize --ratings` consume), and under
  `sessionKey: thread` every reaction was silently discarded while the Slack
  manifest still requested the reaction scopes. On a join miss (a reply
  posted by an older build, or an adapter whose `sendReply` returns no
  message-ts receipt) channel/user keys keep the old last-turn fallback and
  thread drops the reaction rather than guessing; the `fb_` idempotency-key
  hashing is unchanged, so platform redeliveries still collapse to one
  record. `crewhaus compile` prints a one-line `channel-reactions-join`
  warning when `channelReactions` is enabled explaining that attribution
  needs the join file to accumulate — messages posted by older builds cannot
  be attributed. Bundles without `channelReactions` are byte-identical.
- **Slack adapter `sendReply` now returns the `chat.postMessage` receipt**
  (`{ messageTs }`, mirroring `postApproval`), so the join store actually
  accumulates with the production Slack adapter. The `ChannelAdapter`
  contract widened backward-compatibly to
  `Promise<{ messageTs?: string } | void>` — receipt-less adapters keep
  resolving void and their replies take the per-key fallback.
- **`compile --strict` does not escalate the informational
  `channel-reactions-join` warning.** It fires on a fully wired,
  correctly configured feature (no spec edit can clear it), so it prints
  but never fails a strict build; remediable codes (`accepted-but-unwired`,
  `edge-unsafe-tool`) still escalate, and `compile --help` now lists all
  three codes.
- **`semantic.similarity`'s silent ROUGE-L fallback is now loud at run
  level.** When the embedder errors (quota, network, missing key) the
  grader still degrades per sample to a ROUGE-L verdict with the rationale
  prefix it always carried — but the run now ALSO reports the instrument
  swap: results.json gains an additive `aggregates.semanticFallback`
  block ({sampleCount, sampleIds, embedderError}) and the runner prints
  `[eval] warning: N sample(s) graded by ROUGE-L fallback …` on stderr,
  from `runEval` itself so `crewhaus eval`, compiled target-eval bundles,
  and exams surface it identically. Scores from such a run are not
  comparable with embedder-graded runs; `opts: { disableFallback: true }`
  on the graders.yaml entry turns embedder errors into loud grader
  failures instead (previously the opt-out was code-API-only).
- **`judge calibrate --dataset` is now real — the documented flag was
  silently ignored.** The flag was declared and shown in help but never
  read: calibration always used ambient session ratings regardless of what
  you passed. It now ADDS calibration pairs from the golden verdicts a
  distilled dataset carries, combined with the session-ratings pairs
  (which stay the default path). The contract is exactly what `crewhaus
  distill` records: a sample pairs when `metadata.user_rating` is a number
  in [0,1] AND `expected_output` is the non-empty answer that rating was
  placed on; samples whose gold is NOT the rated answer are skipped as
  mis-paired (`metadata.correction` — the gold is the human's correction —
  and `metadata.gold_refreshed` — `dataset refresh-goldens` replaced the
  gold after the rating), and samples already paired from the scanned
  sessions are dropped as duplicates. A `--dataset` that yields zero
  usable pairs dies loudly with the contract spelled out (parse, don't
  ignore); registry refs resolve train+dev on a bare ref and the locked
  test split stays locked. Also: with a `--graders` file whose only
  `llm_judge` entries are categorical, calibrate now explains that a
  label-gated rubric has no scalar cut to calibrate instead of failing
  with a confusing rubric-shape error.
- **`crewhaus dataset audit` now scans — and `--apply` preserves —
  multi-turn `history`.** The audit's field walk predated the new
  `Sample.history` field: PII inside prior conversation turns was never
  scanned, and `--apply` rebuilt samples from a fixed field list, silently
  DROPPING `history` (a redacted multi-turn sample came back single-turn).
  History message contents now scan as `history[<i>].content` fields and
  `--apply` keeps every turn — roles verbatim, contents redacted with the
  same shared detector set.
- **`optimize --few-shot` can no longer hand a dev sample its own gold as a
  demonstration.** The few-shot pool and ratings-derived eval datasets are
  mined from the same rated turns, so a pool example could be one of the
  dev samples being measured — its input + known-good output verbatim in
  the prompt, silently inflating candidate fitness. Injection now runs
  after the dataset is materialized and drops every pool example whose
  (sessionId, turnNumber) provenance appears in the eval dataset's
  `metadata.sessionId`/`metadata.turnNumber` stamps (the `--ratings`
  inline distill reports the same pairs), printing
  `[optimize] few-shot: excluded N pool turn(s) overlapping the eval
  dataset` — counted, logged, never silent. A dataset with no provenance
  metadata excludes nothing and behaves exactly as before; if EVERY pool
  example overlaps, the run refuses rather than injecting nothing.
- The eval bridge's default grader was unrunnable: the projected default
  was `substring_match`, not a real grader type, so every default bridged
  bundle failed grader parsing at boot. The default is now
  `expected_contains` (the deterministic gold-substring built-in).
- `crewhaus judge calibrate --apply` writes
  `.crewhaus/judge-calibration.json` atomically (temp file + rename)
  instead of truncate-then-write. The eval runner reads that file at run
  start to gate `llm_judge` graders that declare no `passing_score`, and a
  malformed read only warns — so a torn file silently mis-gated a whole
  run. A truncated calibration file was observed mid-run in a shared
  checkout.

## [0.4.0] - 2026-07-18

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

- **Loop contract 0.4, Batch G — the interoperate half of the loop: the agent
  as an MCP server, an A2A federation peer, a plugin host, a Claude-Code plugin,
  and portable tool/model routing.** One coordinated batch lands the spec
  grammar, the IR, the affected emitters, the runtime seams, the gateway
  protocol, two new packages, and the CLI:

  - **`expose:` — project a compiled agent AS an MCP server (Item 1 / G30).**
    The new `@crewhaus/mcp-server` registers a bundle's turn function as a
    `chat` tool (one per sub-agent under `tools: per-subagent`) over `stdio`
    or Web-Standard SSE. `crewhaus serve --mcp <spec> [--sse] [--port]`
    projects a `target: cli` agent so Claude Code / an IDE / another CrewHaus
    runtime calls it as a tool (each call runs one interpreter turn); the
    `expose.mcp` block (`transport: stdio|sse`, `tools: chat|per-subagent`)
    lowers onto cli/channel/managed IR, and the channel/managed daemons
    self-expose from their gateway's `fetch` path. Absent `expose:` → the
    bundle is byte-identical to pre-Batch-G.

  - **A2A federation — an agent as a peer (Item 2 / G31).** The new
    `@crewhaus/federation-protocol` builds a real A2A **Agent Card**; a
    federation-configured gateway serves `GET /.well-known/agent-card.json`,
    the `GET /.well-known/crewhaus.json` discovery alias (carrying the
    cert-pin fingerprint the card omits), and the inbound `POST /federation`
    handler (decode → app-level `authorize` → Pillar-3 classify at origin
    `"federation"` → `dispatch` → A2A reply). The managed daemon always emits
    the peer surface, env-gated at RUNTIME (`CREWHAUS_FEDERATION_*`; unset ⇒
    the routes answer 404, an empty allowlist DENIES every inbound call), so
    any deployment becomes a peer by setting env — no recompile. A
    `sub_agents.<name>.federation.url` routes that helper's `Task` call
    through `@crewhaus/federation-router` to the remote peer. mTLS is the
    operator's transport floor; authentication ≠ authorization ≠
    classification.

  - **Plugins — the zero-caller load path, wired (Item 3 / G32).** A
    `plugins:` list on cli/channel activates installed plugins through
    `@crewhaus/plugin-loader`'s `activatePlugins`, which re-verifies each
    manifest's Ed25519 signature + entrypoint digest against the trust
    anchors and buckets the imported module's contributions. `runChatLoop`
    gains a `plugins: { tools }` option: plugin-contributed tools are
    normalised through `buildTool` and APPENDED to the advertised catalog,
    with first-party tools winning any name collision (a plugin augments but
    cannot silently shadow a built-in). Absent the option → the run is
    byte-identical to a pre-G32 runtime (same `tools` reference). Item 10
    (G89) pins the canonical default module-registry index URL the
    marketplace clients resolve against.

  - **`crewhaus export claude-plugin <spec> [--out <dir>]` (Item 4 / §59).**
    The new `@crewhaus/target-claude-plugin` emits an Anthropic-compatible
    Claude Code plugin directory from any shape: `.claude-plugin/plugin.json`
    (author-stamped), a `.mcp.json` when the IR carries `mcp_servers`, and
    per-shape skill/agent files. A `smokeCheckClaudePluginBundle` pass
    validates the emitted `plugin.json`/`.mcp.json` before write.

  - **Portable tool schemas + per-role model routing (Item 9 / G37).** The
    new `@crewhaus/tool-schema-sanitizer` inlines every `$ref`/`$defs` and
    projects a tool's `input_schema` onto each provider's accepted subset —
    `sanitizeGeminiSchema` (Gemini's OpenAPI-3.0 `Schema`: `nullable`,
    `oneOf`→`anyOf`, unsupported `format`s dropped) and `sanitizeBedrockSchema`
    (Converse's `toolSpec.inputSchema.json`) — so a `$ref`-heavy MCP tool
    schema no longer 400s the request; `adapter-gemini` and `adapter-bedrock`
    now sanitize each tool at translate time. `model_pool` / `model_tiers` /
    `model_fallbacks` / `circuit_breaker` land on workflow steps and per crew
    role, emitting onto the `RoleDefinition`; the crew orchestrator forwards a
    role's routing into its `runChatLoop` turns so each role's `PolicyRouter`
    decision shares the `@crewhaus/routing-store` scoreboard. A role/step
    without routing stays byte-identical.

  - **Smaller surfaces**: `thredz.messaging` (Item 5 / G44, object-form,
    default-off) lowers onto `IrThredz.messaging`; the voice shape now
    ACCEPTS `tools:` and carries it with the 0.2.3-convention ignored-note
    (G33, short-term) instead of rejecting the key.

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
