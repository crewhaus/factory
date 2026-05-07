# CrewHaus Factory — Build Roadmap

> Status as of 2026-05-07. 39 of ~190 catalog modules implemented; Sections 1–10 complete, Sections 11–12 next.
> See `docs/MODULE-CATALOG.md` for full per-module specs and test layer references.

---

## Current baseline

The compiler pipeline (spec → IR → codegen) ships two target shapes (`cli`, `workflow`) and the runtime carries tools end-to-end with state-machine-driven turns and pre-turn compaction (snip → autocompact). The CLI exposes `compile`, `run`, `init`, and `doctor` subcommands; three built-in tool packages (`tool-fs`, `tool-bash`, `tool-todo`) are registered. Section 7 added recovery (Anthropic taxonomy with budgets), a layered permission engine (modes + 5 rule sources, with `bypass` locked to the CLI flag), and a parent/child abort tree with SIGINT integration. Section 8 added the partitioned tool layer: concurrent-safe read-only calls run via `Promise.all` while destructive calls run serially, repeated `(toolName, input)` pairs trigger a sliding-window loop warning, large outputs (>10 KB) are persisted to `.crewhaus/tool-results/<runId>/<toolUseId>.txt` with a preview marker the model can re-read, and `streaming: true` dispatches tools mid-stream via the SDK's `contentBlock` event. Section 9 added MCP host + tool-mcp + a `mcp_servers` block in the spec, so external MCP servers (filesystem, github, the everything-server reference, …) auto-spawn at boot and their remote tools register on the catalog under `<server>__<tool>`. Section 10 added persistence: every `crewhaus run` now creates (or `--resume`s) a session under `.crewhaus/sessions/`, transcripts append to a versioned JSONL event log, sessions older than 30 days evict on the next run, and a per-run `state-store` ships as the coordination surface for the hooks/skills work landing in Section 11.

What the current stack still cannot do — and Sections 11–12 unlock, in order:

1. **Be customized** — no hooks, no skills, no slash commands. The harness has no extension surface for users. *(Section 11)*
2. **Live in chat** — only CLI and workflow targets exist; no channel/messenger shape. *(Section 12)*

---

## Section 1 — Tool layer foundation

> Status: ✅ complete (PR #6).

**Catalog modules:** `tool-catalog`, `tool-builder`, `tool-validate`, `tool-executor`, `tool-permission-matcher` (all R3)

The current runtime handles only text streaming. Every useful agent shape needs tools. This section builds the execution framework that all tool implementations will sit on top of; nothing in Sections 2–6 can land without it.

### Build order within this section

`tool-catalog` must be defined first — it owns the registry interface that every other module in this section depends on. Once its interface is stable, the remaining four modules can be built in parallel.

```
tool-catalog  ──►  tool-builder
                   tool-validate          (parallel)
                   tool-executor
                   tool-permission-matcher
```

### What to build

**`packages/tool-catalog`**
- `ToolDefinition<TInput>` interface: `name`, `description`, `inputSchema` (Zod), `concurrencySafe: boolean`, `readOnly: boolean`, `destructive: boolean`
- `ToolCatalog` class: `register()`, `get()`, `list()`, `has()`
- Export a default singleton `defaultCatalog`
- References: `claude-code/Tool.ts` + `tools.ts`, `openclaw/agents/tool-catalog.ts`

**`packages/tool-builder`** *(parallel after catalog interface is stable)*
- `buildTool<TInput>(def: ToolDefinition<TInput>): RegisteredTool` factory
- Applies fail-closed defaults: `concurrencySafe: false`, `readOnly: false`, `destructive: false` unless explicitly set
- References: `claude-code/Tool.ts` `buildTool` factory

**`packages/tool-validate`** *(parallel)*
- `validateToolInput(tool: RegisteredTool, rawInput: unknown): Result<TInput, ValidationError>`
- Uses the tool's `inputSchema` (Zod) to parse; maps errors to typed `ToolValidationError`
- References: `claude-code/Tool.ts` `validateInput`, `openai-agents/tool.py` schema validation

**`packages/tool-executor`** *(parallel)*
- `executeTool(tool, validatedInput, context): Promise<ToolResult>`
- Orchestrates: validate → permission-check → invoke → normalize result
- `ToolResult` type: `{ toolUseId, content: string, isError: boolean }`
- References: `claude-code/services/tools/toolExecution.ts`, `openai-agents/agent.py` tool exec

**`packages/tool-permission-matcher`** *(parallel)*
- `compilePattern(pattern: string): CompiledPattern`
- `matchesPattern(compiled: CompiledPattern, toolName: string, input: unknown): boolean`
- Supports glob-style patterns: `Bash(git *)`, `Read`, `Write(**/src/**)`
- References: `claude-code/utils/permissions/preparePermissionMatcher`

### Tests
Each package gets a unit test file (`T1`) covering the happy path, malformed inputs, and edge cases. `tool-executor` also needs an integration test (`T3`) wiring catalog + validate + permission + a mock tool.

---

## Section 2 — Thread tools through the full pipeline

> Status: ✅ complete (PR #7).

**Catalog modules:** `spec-schema` expansion, `ir-model` expansion, `compiler-core` update, `target-cli-bundle` update, `runtime-orchestrator` update (updates to existing packages)

With the tool framework in place, the compiler pipeline needs to carry tool declarations from spec YAML all the way through to the generated agent, and the runtime needs to handle `tool_use` stream events. This section is mostly sequential because each layer depends on the one above it.

### Build order within this section

```
spec-schema (add tools[])  ──►  ir-model (add tools field)  ──►  compiler-core (thread tools)
                                                                   ──►  target-cli-bundle (emit tool setup)
                                                                   ──►  runtime-orchestrator (handle tool_use blocks)
```

The last two (target-cli-bundle and runtime-orchestrator updates) can be done in parallel once the compiler threads tools through.

### What to build

**`packages/spec`** — extend Zod schema
- Add optional `tools?: string[]` to the spec (list of tool names to enable)
- Keep backward compat: existing specs without `tools` are valid

**`packages/ir`** — extend IrV0
- Add `tools: readonly string[]` field to `IrV0`
- `Bundle` type unchanged

**`packages/compiler`** — thread tools
- `lower()` maps `spec.tools ?? []` → `ir.tools`
- No other changes

**`packages/target-cli`** — emit tool registration
- `renderAgent()` template emits an import for each tool in `ir.tools` and calls `catalog.register()` before `runChatLoop()`
- The generated `agent.ts` shebang file gains a `tools` section

**`packages/runtime-core`** — handle tool_use
- Extend `runChatLoop()` to handle `tool_use` blocks in the stream
- After streaming completes, if there are pending tool calls: execute them (via `tool-executor`), append tool results to message history, and recurse into the next model turn
- Add `tools?: RegisteredTool[]` to `RunChatLoopOptions`
- References: `claude-code/query.ts` (the main query loop, ~1730 lines)

### Tests
Update existing tests for spec, ir, and compiler to cover the new `tools` field. Add a new integration test in `packages/compiler` that compiles a spec with `tools: [read, write]` and verifies the emitted `agent.ts` contains tool registration calls. Add a `runtime-core` unit test that drives a mock stream with a `tool_use` block and verifies the tool is called and the result appended.

---

## Section 3 — First built-in tool implementations

> Status: ✅ complete (PR #8).

**Catalog modules:** `tool-fs`, `tool-bash`, `tool-todo` (R4)

These three tools unlock the primary CLI coding-agent use case. They can all be built in parallel — each is an independent package that registers itself against the tool framework from Section 1.

### Build order within this section

All three are parallel. Each package depends only on `tool-catalog` and `tool-builder` (Section 1), not on each other.

```
tool-fs     ──►  (register in default catalog)
tool-bash       (parallel)
tool-todo
```

### What to build

**`packages/tool-fs`**
- Tools: `Read(path)`, `Write(path, content)`, `Edit(path, oldString, newString)`, `Glob(pattern)`, `Grep(pattern, path?)`
- Enforce path-traversal defense: all paths must resolve within the workspace root (`process.cwd()`)
- `Read` returns file content as string; `Write` is atomic (write to temp, rename); `Edit` performs exact-string replacement and errors if the string appears zero or more-than-once
- References: `claude-code/tools/FileReadTool`, `FileWriteTool`, `FileEditTool`, `openclaw/agents/bash-tools.*`

**`packages/tool-bash`**
- Tool: `Bash(command, timeout?)`
- Spawns via `Bun.spawn`, captures stdout+stderr, enforces 30s default timeout
- Returns `{ stdout, stderr, exitCode }` formatted as a readable string
- Does NOT execute in background by default; add `background: true` flag for long-running processes
- References: `claude-code/tools/BashTool`, `openclaw/process/exec.ts`

**`packages/tool-todo`**
- Tool: `TodoWrite(todos: Array<{id, content, status, priority}>)`
- Maintains a per-session todo list; overwrites entire list on each call
- Returns a formatted markdown checklist of current todos
- References: `claude-code/tools/TodoWriteTool`

### Tests
Each tool package gets `T1` unit tests and `T3` integration tests. The `tool-bash` tests must cover timeout enforcement and non-zero exit codes. The `tool-fs` tests must cover the path-traversal defense.

---

## Section 4 — Turn state machine + context management

> Status: ✅ complete (PR #9).

**Catalog modules:** `turn-state-machine`, `run-context`, `token-budget`, `compaction-snip`, `compaction-autocompact` (R1, R2, R6)

As conversations grow, the runtime needs to manage token budgets and compact history before hitting the 200k context limit. This section formalizes the turn lifecycle into an explicit state machine and adds the two most important compaction strategies. `turn-state-machine` and `run-context` can be built in parallel; compaction modules depend on `token-budget`.

### Build order within this section

```
turn-state-machine  ──►  (integrate into runtime-core)
run-context             (parallel)
token-budget        ──►  compaction-snip     (parallel after token-budget)
                         compaction-autocompact
```

### What to build

**`packages/turn-state-machine`**
- Explicit state type: `NeedModel | NeedTools | NeedCompaction | NeedRecovery | Done`
- Pure transition functions: `transition(state, event): TurnState`
- No I/O — just the state machine logic
- References: `claude-code/query.ts` `State`/`Continue` pattern

**`packages/run-context`**
- `RunContext` object threaded through orchestrator, tool executor, and permission matcher
- Fields: `runId`, `sessionId`, `turnNumber`, `abortSignal`, `logger`
- Constructed once per `runChatLoop()` invocation
- References: `claude-code/Tool.ts` `ToolUseContext`, `openai-agents/run_context.py`

**`packages/token-budget`**
- `estimateTokens(messages: Message[]): number` — heuristic estimator (character-count / 4 fallback; exact tokenizer optional)
- `TokenBudget` class: tracks running input/output totals; `isApproachingLimit(threshold?: number): boolean`
- References: `claude-code/query/tokenBudget.ts`, `claude-code/utils/tokenEstimation.ts`

**`packages/compaction-snip`** *(parallel after token-budget)*
- `snip(messages: Message[], keepHead: number, keepTail: number): Message[]`
- Removes middle messages to bring the conversation under a token budget
- Inserts a system note at the snip point: `[Context compacted: N messages removed]`
- References: `claude-code/services/compact/snipCompact.ts`

**`packages/compaction-autocompact`** *(parallel after token-budget)*
- `autoCompact(messages: Message[], client: Anthropic, model: string): Promise<Message[]>`
- When `token-budget` signals the limit is approaching, calls the model to summarize the conversation so far, replaces history with a single summary message
- References: `claude-code/services/compact/autoCompact.ts`

Integrate both compaction strategies into `runtime-core`: check token budget at the start of each turn; apply snip first (free), then autocompact if still over budget.

### Tests
`turn-state-machine` gets property tests (`T9`) over all state transitions. `token-budget` gets unit tests. `compaction-snip` and `compaction-autocompact` get replay tests (`T4`) with a fixture conversation to verify the compacted output stays stable.

---

## Section 5 — CLI subcommand expansion

> Status: ✅ complete (PR #10).

**Catalog modules:** `spec-cli` additions — `init`, `run`, `doctor` subcommands (F4)

The CLI currently only has `compile`. These three new subcommands turn `crewhaus` into the full developer CLI. They can be built in parallel once Sections 1–4 are in place, since they are independent entry points into the already-built pipeline.

### Build order within this section

All three are parallel — each is a new subcommand handler in `apps/cli/src/index.ts`.

```
crewhaus init    ──►  (no deps beyond spec-schema)
crewhaus run         (depends on sections 1–4 being complete)
crewhaus doctor      (no deps beyond infra-utils + logging)
```

### What to build

**`crewhaus run <spec.yaml>`**
- Parse spec → compile to IR in-process → execute `runChatLoop()` directly (no disk write)
- Accepts `--model <model>` override flag
- This makes `compile + bun run dist/agent.ts` a single command for development
- References: `adk-python/cli/`, `openclaw/cli/`

**`crewhaus init [name]`**
- Scaffold a `crewhaus.yaml` in the current directory (or a named subdirectory)
- Prompts for target shape (CLI for now) and model; writes a minimal valid spec
- If directory already has a `crewhaus.yaml`, error with a clear message
- References: `openclaw/wizard/`, gstack `setup`

**`crewhaus doctor`**
- Check environment health: `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` set, Bun version ≥ 1.2, `crewhaus.yaml` present in cwd if invoked from a project directory
- Print a green/red checklist; exit 1 if any check fails
- References: `claude-code/cli/` doctor-style health checks

### Tests
Each subcommand gets an integration test (`T3`) via `Bun.spawn` on the CLI binary: verify `init` writes a valid YAML, `run` executes without error against the `examples/hello-cli` spec, `doctor` exits 0 in a healthy environment and 1 with a missing API key.

---

## Section 6 — Second target shape: workflow

> Status: ✅ complete (PR #11).

**Catalog modules:** `target-workflow`, `ir-model` expansion (IrWorkflow), `spec-schema` expansion (workflow shape), `codegen-templates` additions (F2, F1)

With the tool framework, context management, and CLI in place, the pipeline is mature enough to support a second target shape. A `workflow` target compiles a spec with named sequential steps into a generated runtime that runs them in order, passing state between steps. This builds directly on everything from Sections 1–5.

### Build order within this section

The spec and IR changes are prerequisites. The compiler and codegen can be built in parallel after the IR is defined. A new example spec (`examples/hello-workflow/`) is the acceptance test.

```
spec-schema (workflow target + steps[])  ──►  ir-model (IrWorkflowV0)  ──►  compiler-core (dispatch workflow)
                                                                               target-workflow (codegen)  (parallel)
                                                                         ──►  examples/hello-workflow/
```

### What to build

**`packages/spec`** — add workflow target
- New discriminated union: `target: "workflow"` with `steps: Array<{ name, instructions, tools? }>`
- Each step is an independent agent turn with its own instructions and optional tool set

**`packages/ir`** — add `IrWorkflowV0`
- `IrWorkflowV0`: `version: 0`, `name`, `target: "workflow"`, `steps: Array<{ name, instructions, tools }>`
- `IrNode` union: `IrV0 | IrWorkflowV0`

**`packages/compiler`** — dispatch workflow
- `lower()` detects `spec.target === "workflow"` and produces an `IrWorkflowV0`
- `emit()` dispatches `IrWorkflowV0` to `target-workflow`

**`packages/target-workflow`** *(parallel with compiler update)*
- Emits a generated `agent.ts` that runs each step sequentially
- Between steps, the output of step N is prepended as context for step N+1
- Uses `runChatLoop()` from `runtime-core` per step with step-specific tools
- References: `crewAI/flow/`, `llama_index/workflow`, `adk-python/flows/`

**`examples/hello-workflow/crewhaus.yaml`**
- Two-step workflow: step 1 researches a topic (Bash + Read tools), step 2 writes a summary (Write tool)
- `bun run compile:hello-workflow` and `bun run run:hello-workflow` scripts in root `package.json`

### Tests
`target-workflow` gets unit tests (`T1`) verifying the generated code structure and an integration test (`T3`) compiling the `hello-workflow` spec and confirming it executes step 1 before step 2.

---

## Section 7 — Hardening: recovery, permission engine, abort

> Status: ✅ complete (PR #12).

**Catalog modules:** `recovery-engine` (R1), `permission-engine` (R8), `abort-controller` (R1)

Three independent packages built in parallel, then integrated into `runtime-core`:

- **`recovery-engine`** — pure decision function. Anthropic-error taxonomy: `prompt_too_long → compact`, `max_output_tokens → continue`, `overloaded/5xx → retry` (exponential backoff capped at 30 s + jitter), `invalid_request → tombstone`, with per-turn budgets (5 retries, 1 compact, 3 continues, 1 tombstone) and a fixture-based replay test.
- **`permission-engine`** — modes (`default`/`plan`/`auto`/`bypass`) over a 5-source `RuleSet` walked in priority order `flag → settings → yaml → hooks → builtin`. Built on `tool-permission-matcher`. **Security**: `mode: bypass` is rejected at parse time from yaml/settings sources — only the `--permission-mode` CLI flag may select it.
- **`abort-controller`** — parent/child abort tree with WeakRef cascade so abandoned children don't pin parents; sibling-independent; T3 spawns `sleep 30` and verifies SIGTERM cascade.

Runtime integration: each model stream call is wrapped in try/catch that delegates to `recover()`; each tool call evaluates through `permission-engine.evaluate()` before exec (REPL mode prompts via stdin on `ask`, single-turn mode treats `ask` as deny); the abort tree is rooted at the `runContext.abortSignal`, with a turn-level child for the model stream and a per-tool grandchild forwarded into `Bun.spawn({ signal })`. A SIGINT handler in REPL mode aborts the active turn on the first press and exits the process on the second within the same turn. The Anthropic SDK now honors `ANTHROPIC_BASE_URL` to support the smoke-test mock at `scripts/smoke-mock-anthropic.ts`.

Spec/CLI surface: `crewhaus run` accepts `--permission-mode <default|plan|auto|bypass>`; specs may declare a `permissions` block (`mode` + `rules[]`); `.crewhaus/settings.json` is parsed when present. Generated `agent.ts` bundles thread the IR's permissions into `runChatLoop`. Bypass is rejected at every parse boundary (spec, settings, schema enum) — a defense-in-depth lockdown verified by the T8 security test.

### Tests
`recovery-engine`: 33 unit + replay tests (T1, T4) over a fixture of 10 representative SDK error shapes. `permission-engine`: 22 unit + property + security tests (T1, T9, T8) including a property test over 200 random rule sets and three bypass-lockdown checks. `abort-controller`: 10 cascade + WeakRef + child-process tests (T1, T3) including a real `Bun.spawn(["sleep", "30"], { signal })` SIGTERM-cascade integration test.

---

## Section 8 — Tool layer enrichment

> Status: ✅ complete (PR #13).

**Catalog modules:** `tool-orchestrator`, `tool-loop-detection`, `tool-result-store`, `streaming-tool-executor` (all R3)

Four independent packages built in parallel, then integrated into `runtime-core`:

- **`tool-orchestrator`** — `partitionToolCalls(calls, lookup)` returns `{ concurrent: ToolUse[][], serial: ToolUse[] }`. A call is concurrent-safe iff `tool.concurrencySafe && tool.readOnly && !tool.destructive`; consecutive safe calls collapse into one batch and the runtime runs them via `Promise.all`. T9 property test fuzzes 100 random tool/flag mixes and asserts no destructive call ever lands in a concurrent batch.
- **`tool-loop-detection`** — `detectLoop(history, windowSize=10, threshold=3)` over a sliding window of canonical-JSON `(toolName, input)` signatures. Returns `{ signature, toolName, count, … }` when any signature reaches threshold inside the window; canonical encoding sorts object keys recursively so `{a:1,b:2}` and `{b:2,a:1}` collapse to the same signature.
- **`tool-result-store`** — `storeAndPreview(result, { runId, toolUseId, … })` persists outputs over 10 KB to `.crewhaus/tool-results/<runId>/<toolUseId>.txt` (write-exclusive flag for idempotent retry) and returns a preview = first 100 lines + `[truncated, full output at <fullPath>]`. Path-traversal guards reject any `runId`/`toolUseId` containing `/`, `\`, `..`, or `\0`.
- **`streaming-tool-executor`** — `executeStreaming(stream, opts)` subscribes to the SDK's `contentBlock` event so each `tool_use` block dispatches as soon as it completes. A `canExecute()` gate runs concurrent-safe tools in parallel and serialises destructive ones; sibling-abort fires on a destructive tool error (overridable via `shouldAbortOnError`). Accepts a `runTool` callback so the runtime can plumb permission gating + per-tool abort + result-store wrapping through the same path as the post-stream batch executor. T7 load test fires 50 synthetic `tool_use` blocks and confirms ordering + completion under 1 s.

Runtime integration: `runtime-core.runOneTurn` now calls `partitionToolCalls`, runs concurrent batches via `Promise.all`, and runs serial calls one at a time. Each tool flows through `executeOneToolUse(tu)` which combines permission gating (Section 7) with the per-tool abort tree, `executeTool`, and `storeAndPreview`. After each batch (or after `executeStreaming` returns), `detectLoop()` scans the per-run `toolUseHistory`; on a hit it appends a synthetic user message warning the model and dedups by signature so the warning fires at most once per signature for the lifetime of the run. Behind `streaming: true` on `RunChatLoopOptions`, the loop swaps to `executeStreaming` with the same `executeOneToolUse` callback, collapsing `NeedTools` into the `NeedModel` branch (tools have already executed by the time `finalMessage` resolves).

End-to-end smoke against the live model (OAuth via `ANTHROPIC_AUTH_TOKEN`): concurrency log shows the tool partition splitting Read/Bash; loop warning fires at count = 3 of repeated `Bash {command:"date"}`; reading `bun.lock` (22 KB) persists to disk and the agent re-reads the stored path on the next turn; `streaming: true` shows `kind:"tool-started"` debug events firing during the stream, with `durationMs` matching a real `sleep 1` before `turn end`.

### Tests
`tool-orchestrator`: 9 unit + T9 property tests over 100 random partitions (no destructive call ever in a concurrent batch). `tool-loop-detection`: 18 unit tests including object-order canonicalisation, window slicing, and threshold edge cases. `tool-result-store`: 11 unit tests with temp-dir per case, covering UTF-8 byte-length, idempotent retry, error-result persistence, and path-traversal rejection. `streaming-tool-executor`: 9 unit + T7 load (50 partial blocks under 1 s, results in input order). `runtime-core`: 4 new integration tests for the partitioned, loop-warning, large-result, and streaming paths.

---

## Section 9 — MCP host

> Status: ✅ complete (PR pending).

**Catalog modules:** `mcp-host` (R5), `tool-mcp` (R4)

Two new packages plus a `mcp_servers` block threaded through `spec → ir → compiler → target-cli`, so any YAML spec can declare external MCP servers and have them spawned + registered automatically at boot. The entire MCP ecosystem (filesystem, github, sentry, the official `@modelcontextprotocol/server-everything` reference) is now available without per-server code.

### Sequential build order

```
errors (mcp code) → tool-catalog/tool-builder (jsonSchema field) → runtime-core (honor jsonSchema)
                                ↓
mcp-host (uses errors) → tool-mcp (uses mcp-host + tool-builder + tool-catalog)
                                ↓
spec → ir → compiler → target-cli, target-workflow (warning), apps/cli (mirror), examples/mcp-smoke
```

### What was built

- **`mcp-host`** — `McpClient` / `McpHost` shell over `@modelcontextprotocol/sdk` (`Client` + `StdioClientTransport` + `SSEClientTransport`). Hand-rolling the wire format (NDJSON over stdin/stdout) was rejected: the SDK already implements the JSON-RPC 2.0 framing, versioned `initialize` handshake, capability negotiation, and notification semantics. State machine: `idle → connecting → connected → disconnected → connecting → connected` with `closed` as the terminal sink. Reconnect uses exp backoff (1 s → 30 s cap, ±10% jitter, no max attempts). New `callTool` calls during disconnect await a `connectedDeferred` (queue cap 16); in-flight calls reject with `McpConnectionError`. `addServer()` is synchronous (config + uniqueness check); `connect()` runs explicitly inside `registerMcpServer()` so all I/O concentrates in one boot-time `Promise.all`. Both transports are implemented; SSE gets unit-test coverage and stdio gets the smoke runbook + a gated T2 contract test against the everything-server.
- **`tool-mcp`** — `registerMcpServer(host, serverName, catalog, opts?)` calls `listTools()` and builds one `RegisteredTool` per remote tool via `@crewhaus/tool-builder`, namespaced as `<serverName>__<toolName>`. Per-tool flag overrides (`concurrencySafe`/`readOnly`/`destructive`) win over `defaults`; final fallback is `(false, false, false)`. Remote tool names are validated against `[a-zA-Z0-9_-]+`; descriptions are stripped of C0 control chars.
- **Schema passthrough** — extends `RegisteredTool` (and `ToolDefinition`) with an optional `jsonSchema?: unknown` field. `runtime-core.runChatLoop` prefers `t.jsonSchema` over `zodToJsonSchema(t.inputSchema)` when present, so MCP tools can carry their server-authoritative JSON Schema verbatim instead of going through a lossy Zod round-trip. MCP tools use `z.unknown()` as the local validator; the MCP server itself validates arguments on the wire, and any `isError: true` result becomes a thrown `McpError` that flows through the existing `executeOneToolUse` error path.
- **Pipeline threading** — spec adds `mcp_servers?: Record<string, McpServerConfig>` (discriminated on `transport: "stdio" | "sse"`, strict-mode rejection of stray fields). IR mirrors with `IrMcpServers` types on both `IrV0` and `IrWorkflowV0`. `compiler.lower()` normalises `args ?? []` so target-cli emits without `?? []` guards. `target-cli` emits an `McpHost` boot block before `runChatLoop` and wraps the call in `try/finally` with `disconnectAll()` cleanup; `apps/cli` mirrors the same wiring in `runRun` so `crewhaus run` stays parity-equivalent with `compile && bun agent.ts`. `target-workflow` is unchanged in behaviour but emits a one-line warning comment when `mcp_servers` is non-empty so the silent ignore is visible to the user.
- **Errors** — new `ErrorCode = "mcp"` plus `McpError` / `McpConnectionError` / `McpProtocolError` for clean log filtering and recovery dispatch.

### Limitations (v0)

- `notifications/tools/list_changed` is ignored — the catalog is built once at boot. A future section can add a `RuntimeCatalog` + watcher.
- Non-text content blocks (image, audio, resource) reduce to `[image: <mime>]` / `[audio: <mime>]` / `[resource: <uri>]` placeholders for the model.
- `target-workflow` ignores `mcp_servers` (warning comment in the emitted bundle); follow-up will wire it up the same way as `target-cli`.

### Tests
`mcp-host`: 19 unit + integration + security tests (T1, T3, T8) plus a gated T2 contract test (`CREWHAUS_RUN_MCP_CONTRACT=1`) against `npx @modelcontextprotocol/server-everything` covering connect → listTools → callTool → disconnect on a real subprocess. `tool-mcp`: 9 integration tests (T3) over a mock McpHost confirming namespaced registration, schema-bytes round-trip, default + per-tool flag override semantics, and `isError` → `McpError` conversion. End-to-end smoke against the live model (OAuth via `ANTHROPIC_AUTH_TOKEN`): boot logs registered 13 namespaced tools (`everything__echo`, `everything__add`, etc.); model called `everything__echo` with `{ message: "hello mcp" }` and got `Echo: hello mcp` back; `kill -9` on the npx child triggered `mcp.transport_closed` → `mcp.reconnect_scheduled` (delayMs ≈ 1078) → `mcp.connected`; hello-cli + hello-workflow regressions clean (no MCP plumbing emitted when `mcp_servers` is omitted).

---

## Section 10 — Persistence: state, sessions, event log

> Status: ✅ complete (PR pending).

**Catalog modules:** `state-store` (R7), `session-store` (R7), `event-log` (R7)

Three independent R7 packages plus a runtime-core integration that creates (or `--resume`s) a session at the start of every `runChatLoop`, appends every meaningful event to a versioned JSONL transcript, and evicts sessions older than 30 days as a side-effect of the next start. The user-facing payoff is the `--resume <sessionId>` flag on `crewhaus run`: a session that learned `parsnip` in one process can recall it in the next, proving the event-log replay reconstructs the message history exactly.

### What was built

- **`state-store`** — tiny zustand-style container: `createStore<T>(initial)` returns `{ get, set, subscribe, select }`. `set(partial | (s) => partial)` shallow-merges; root listeners fire on every actual change, and `select(selector)` returns a derived view whose listeners fire only when `Object.is(selector(next), selector(prev)) === false` (referential equality on the projected output, like zustand's `subscribeWithSelector`). Listener exceptions are isolated via `console.error` so a misbehaving subscriber can't poison its siblings. The runtime instantiates one `Store<Record<string, unknown>>({})` per `runChatLoop` invocation as the coordination surface for the hooks/skills/tools landing in Section 11; Section 10 ships the plumbing only. Tests: T1 unit + T9 property over 100 random `set` sequences (model state matches store state; selector fires == count of distinct projections).
- **`session-store`** — file-backed JSON metadata at `.crewhaus/sessions/<id>.json`. Session shape: `{ id, createdAt, updatedAt, name, target, model, lastTurnIndex }`. API is `createSessionStore({rootDir, ttlDays, now})` returning `{ create, get, list, update, delete }`. Ids are `sess_<16 hex>` (8 random bytes); `validateId` enforces the regex on every read path so `../escape`/`etc/passwd`/missing-prefix all throw `RuntimeError` before any filesystem access. Atomic writes go through `<id>.json.tmp` + `rename`. `list()` evicts (`unlink`s the `.json` AND the sibling `.jsonl`) any file whose **mtime** is older than `ttlDays * 86_400_000` ms — mtime, not the in-file `updatedAt`, so `touch -t YYYYMMDD0000 <id>.json` is a sufficient way to test or force expiry from the shell. Tests: T1 CRUD unit + T3 backdate-mtime-then-list-evicts integration over a `mkdtempSync` rootDir.
- **`event-log`** — append-only JSONL transcript at `.crewhaus/sessions/<sessionId>.jsonl`. `openEventLog(sessionId, {rootDir, now})` returns `{ append, read, close }`. Each event lands as one line: `{ ts, version: 1, kind, payload }` where `kind` is one of `user_message | assistant_message | tool_use | tool_result | error | compaction`. Append uses `appendFileSync(...)` with mode `0o600` (owner-only, mirroring `claude-code/utils/sessionStorage.ts:2579`); synchronous append on POSIX is atomic per line so concurrent runs cannot interleave partial JSON. `read({since, until})` opens `fs.createReadStream` + `node:readline`, parses each line as JSON, and yields events in insertion order; missing files yield zero, malformed lines throw `RuntimeError` carrying the line number. Tests: T1 round-trip across all six kinds + filtering + the malformed-line guard, plus T7 load test that appends 10 000 events and reads them back in <5 s.

### Runtime integration (`runtime-core`)

`runChatLoop` now does the following at the top of every invocation:

1. Construct a `SessionStore` rooted at `opts.sessionRootDir` (or `CREWHAUS_SESSION_DIR` env, useful for tests) and call `sessionStore.list()` once for housekeeping — old sessions evict here without any explicit user action.
2. Resolve the `sessionId`: if `opts.resume` is set, load the existing session and replay its event log via the new exported `replayMessageHistory(eventLog)` helper, which walks the JSONL and pushes one `MessageParam` per `user_message`/`assistant_message` event (tool_use/tool_result/error/compaction events are audit-only). If `opts.resume` is unset, call `sessionStore.create({ id: opts.runContext?.sessionId, name, target, model })` so the run-context's id (already `sess_<16 hex>` by construction — `run-context` was updated to match) becomes the persisted file name.
3. `openEventLog(sessionId)` for the rest of the run; `runChatLoop`'s `finally` block calls `sessionStore.update(sessionId, { lastTurnIndex: runContext.turnNumber })` and `eventLog.close()` for both the REPL and singleTurn paths.
4. Instantiate a fresh `state-store` (consumed in Section 11+; held in scope today).

Throughout the loop, every message-mutation site emits a corresponding event — the REPL prompt push, every assistant turn (streaming + non-streaming), every post-tool batch, every loop-warning user message, the recovery branch's compact/continue/tombstone paths, and `executeOneToolUse` (which now logs both `tool_use` at start and `tool_result` at end). `maybeCompact` and `forceCompact` accept an optional `onCompaction` callback so the audit `compaction` event captures the snip-vs-autocompact distinction without duplicating the cost-estimation logic.

### CLI + bundle

`crewhaus run` now accepts `--resume <sessionId>`; the format is validated against `/^sess_[0-9a-f]{16}$/` before any I/O. `apps/cli` also forwards `sessionName: ir.name` and `sessionTarget: ir.target` so persisted metadata is human-meaningful. The `target-cli` codegen path emits the same two fields into the generated `agent.ts`, keeping bundles parity-equivalent with the in-memory CLI run.

### End-to-end smoke (live model via `ANTHROPIC_AUTH_TOKEN`)

1. `bun run run:hello` with input `remember the magic word is parsnip` — assistant acknowledged. `.crewhaus/sessions/sess_72c5cd39db1f9219.json` showed `name: "hello"`, `target: "cli"`, `model: "claude-sonnet-4-6"`, `lastTurnIndex: 1`. `.jsonl` contained one `user_message` + one `assistant_message` event at `version: 1`.
2. `bun apps/cli/src/index.ts run examples/hello-cli/crewhaus.yaml --resume sess_72c5cd39db1f9219` with input `what was the magic word?` — the loop logged `messages:3` (proving the [u, a, u] history reached the model unchanged) and the assistant responded "The magic word is `parsnip`."
3. `touch -t 202604010000 .crewhaus/sessions/<id>.json` then a fresh `crewhaus run` — the housekeeping `list()` purged both the `.json` and the sibling `.jsonl`; only the new session remained on disk.

### Tests
`state-store`: 14 unit + property tests (T1 + T9). `session-store`: 15 unit + integration tests (T1 + T3, including the mtime-eviction case). `event-log`: 8 unit + load tests (T1 + T7, with the 10 K-event round-trip in <1 s). `runtime-core`: 5 new tests in the `runChatLoop — Section 10 persistence` block (T3 lastTurnIndex on exit, T4 replay determinism, resume integration, missing-session error, mutual-exclusion guard, event-log capture). Existing 29 runtime-core tests still pass with `process.env.CREWHAUS_SESSION_DIR` routed to a `mkdtempSync` root via `beforeAll`/`afterAll`.

---

## Section 11 — Hooks, skills, slash commands

> Status: not started.

**Catalog modules:** `hooks-engine` (R9), `skills-registry` (R9), `slash-commands` (R9)

These three modules give users an extension surface — the difference between a fixed harness and a customizable one. `hooks-engine` is the structural primitive both other modules build on; `skills-registry` and `slash-commands` are user-facing features that depend on it.

### Build order within this section

```
hooks-engine  ──►  skills-registry      (parallel after hooks-engine)
                   slash-commands
```

### What to build

**`packages/hooks-engine`**
- Lifecycle events: `session-start`, `pre-tool`, `post-tool`, `pre-compact`, `post-compact`, `stop`, `pre-model`, `post-model`
- Hook def: `{ event, matcher?: string, command: string }` — runs an arbitrary shell command via `Bun.spawn`, passing event payload as JSON on stdin and reading a JSON decision from stdout
- Decision shape: `{ decision: "allow" | "deny" | "block", reason?, mutate?: object }`
- Loaded from `.crewhaus/settings.json` (project) and `~/.crewhaus/settings.json` (user); user settings stack under project settings
- API: `loadHooks()`, `runHooks(event, payload): Promise<HookResult[]>`
- References: `openclaw/hooks/`, `claude-code/hooks/`

**`packages/skills-registry`** *(parallel after hooks)*
- A "skill" is a directory containing `SKILL.md` with frontmatter (`name`, `description`, `triggers?`, `tools?`)
- Discovery order: `~/.crewhaus/skills/`, `<project>/.crewhaus/skills/`, plugin-bundled skills
- Lazy load: list all skills at boot (just frontmatter), inject the *names + descriptions* into the system prompt; load full body only when the model calls the `Skill` tool with that name
- Adds a built-in `Skill(name)` tool to the default catalog when skills are present
- References: `openclaw/agents/skills/`, `claude-code/skills/`

**`packages/slash-commands`** *(parallel after hooks)*
- A slash command is a markdown file in `.crewhaus/commands/<name>.md` with optional frontmatter (`description`, `argument-hint`)
- When the user input starts with `/<name>`, expand the markdown body (with `$ARGUMENTS` substitution) into the user message and submit
- API: `loadCommands(): Map<string, SlashCommand>`, `expand(input: string, commands): { handled: boolean, expanded: string }`
- Hook integration: fires a `pre-slash` hook event before expansion so users can intercept
- References: `openclaw/commands/`, `claude-code/commands.ts`

### Integration into `runtime-core` and `apps/cli`
- `runChatLoop` fires hook events at the right moments (`pre-tool` before each tool execution, `post-tool` after, etc.); a `deny` decision short-circuits with the hook's reason as the result
- `apps/cli/src/index.ts` `run` subcommand checks for slash commands on each user input before sending to the model
- System prompt builder gets a new section that lists available skills

### Tests
`hooks-engine`: integration test (`T3`) with a fixture hook that returns `deny` and verifying the tool is blocked; security test (`T8`) verifying hook commands inherit a restricted env. `skills-registry`: unit test (`T1`) for frontmatter parsing; integration test (`T3`) verifying full skill body is only loaded on tool call. `slash-commands`: property test (`T9`) over `$ARGUMENTS` substitution edge cases.

---

## Section 12 — Third target shape: channel bot

> Status: not started.

**Catalog modules:** `target-channel-bot` (F2), Slack adapter (R-channels), `tool-message-channel` (R4); transitively depends on `mcp-host` (Section 9), `session-store` + `event-log` (Section 10), `hooks-engine` (Section 11)

A channel bot lives in a long-running daemon that listens to inbound messages from Slack/Telegram/Discord and runs a session per thread. This is the third major target shape and the first that requires the persistence and extension stack from Sections 10–11. We ship the framework + one channel (Slack); other channels follow the same shape.

### Build order within this section

```
target-channel-bot                   ──►  channel-adapter-slack
spec schema (channel target)               tool-message-channel        (parallel after framework)
ir-model (IrChannelV0)                     examples/hello-channel/
```

### What to build

**`packages/spec`** — add `channel` target
- `target: "channel"` with: `agent: { model, instructions, tools? }`, `channels: { slack?: { botToken: string, signingSecret: string, ... } }`, `routing: { sessionKey: "thread" | "user" | "channel" }`

**`packages/ir`** — add `IrChannelV0`
- Mirrors the channel spec; carries channel configs and routing rules

**`packages/target-channel-bot`**
- Codegen for a long-running daemon: HTTP server (`Bun.serve`) accepting webhooks per channel; gateway dispatching incoming events to a session router; per-session `runChatLoop()` instances driven by inbound messages instead of stdin
- Generated bundle is a multi-file artifact (`gateway.ts`, `daemon.ts`, `session-router.ts`, `agent.ts`) — first time the codegen produces more than one file
- References: `openclaw/gateway/`, `openclaw/daemon/`, `openclaw/channels/`

**`packages/channel-adapter-slack`**
- Implements: webhook signature verification (`X-Slack-Signature` HMAC), event parsing (`message`, `app_mention`), reply-to-thread API, typing indicator, file uploads
- Shape: `createSlackAdapter(config): ChannelAdapter` where `ChannelAdapter` has `verify`, `parseInbound`, `sendReply`, `setTyping`
- References: `openclaw/channels/slack/`

**`packages/tool-message-channel`**
- Tool: `SendMessage(channel, text)` — lets the agent send messages to other channels/threads/DMs
- Permission-gated by default; requires explicit allow via `permission-engine` rules
- References: `openclaw/agents/channel-tools.ts`, `claude-code/tools/SendMessageTool`

### Session routing
- `session-store` keyed by `slack:<workspaceId>:<channelId>:<threadTs>` (when `routing.sessionKey: "thread"`)
- Each inbound message resumes the session via `--resume`-equivalent in-process logic, appends the message, and runs one turn
- Hooks fire as normal (so users can plug in approval flows for channel tools)

**`examples/hello-channel/crewhaus.yaml`**
- A Slack bot that mentions trigger an agent reply in-thread, with `tool-fs` and `tool-bash` available via permission rules
- Add `compile:hello-channel` and `run:hello-channel` scripts to the root `package.json`

### Tests
`target-channel-bot`: unit test (`T1`) on generated bundle structure; integration test (`T3`) compiling `hello-channel` and starting the daemon, posting a fake Slack webhook, and asserting a reply is sent. `channel-adapter-slack`: contract test (`T2`) against a recorded Slack event corpus; security test (`T8`) for signature verification with tampered payloads. `tool-message-channel`: permission test (`T8`) verifying the tool fails closed without explicit allow rule.

---

## Kickoff prompts

Use these prompts with Claude Code from the project root (`/Users/bots/Developer/crewhaus-factory`). Each prompt is self-contained.

---

### Section 1 — Tool layer foundation

```
Read docs/build-roadmap.md Section 1 and docs/MODULE-CATALOG.md Layer R3 entries for tool-catalog, tool-builder, tool-validate, tool-executor, and tool-permission-matcher.

Also read the following for patterns to follow:
- packages/errors/src/index.ts (error hierarchy style)
- packages/infra-utils/src/index.ts (utility style)
- packages/runtime-core/src/index.ts (how the current runtime is structured)

Build the five R3 foundation packages in this order:
1. packages/tool-catalog — ToolDefinition interface + ToolCatalog registry class + defaultCatalog singleton
2. Then in parallel: packages/tool-builder, packages/tool-validate, packages/tool-executor, packages/tool-permission-matcher

Each package should follow the existing pattern: type: "module", main: "src/index.ts", bun test src. Add each as a workspace package in the root package.json workspaces array. All packages should use @crewhaus/ scope naming.

Write tests for each package. tool-executor needs both unit tests and an integration test that wires catalog + validate + permission + a mock tool.

Do not modify runtime-core yet — that comes in Section 2.

End-to-end smoke test before opening the PR:
- ANTHROPIC_AUTH_TOKEN is in .env (Bun auto-loads .env; the runtime supports OAuth tokens with the sk-ant-oat prefix)
- This section adds no user-visible behavior. Run the existing regression: `bun run compile:hello && echo "say hi" | bun run run:hello` and verify the agent replies — confirms nothing in the foundation packages broke the baseline runtime.
- No persistent artifacts to clean up.
```

---

### Section 2 — Thread tools through the pipeline

```
Read docs/build-roadmap.md Section 2. Also read these files in full before making any changes:
- packages/spec/src/index.ts
- packages/ir/src/index.ts
- packages/compiler/src/index.ts
- packages/target-cli/src/index.ts
- packages/runtime-core/src/index.ts

Extend the pipeline to carry tools from spec YAML through to the generated agent and runtime:

1. packages/spec — add optional tools?: string[] to the Zod schema
2. packages/ir — add tools: readonly string[] to IrV0
3. packages/compiler — thread spec.tools ?? [] into ir.tools in the lower() function
4. packages/target-cli — update renderAgent() to import and register each tool from ir.tools before calling runChatLoop()
5. packages/runtime-core — extend runChatLoop() to:
   - Accept tools?: RegisteredTool[] in RunChatLoopOptions
   - After each streaming response, check for tool_use blocks
   - Execute them using tool-executor, append tool_result messages, and loop back to the model

Update existing tests. Add an integration test in packages/compiler that compiles a spec with tools: [read] and checks the emitted code. Add a runtime-core test with a mock Anthropic client that returns a tool_use block, verifying the tool is called and the conversation continues.

End-to-end smoke test before opening the PR:
- ANTHROPIC_AUTH_TOKEN is in .env (Bun auto-loads .env; the runtime supports OAuth tokens with the sk-ant-oat prefix)
- Create a temporary spec with tools: [Read] (use a stub Read tool registered by the test, or skip if Section 3 hasn't landed yet — in that case use a no-op tool registered inline)
- Compile and run; from stdin send: "what tools do you have? call one." and verify the model emits a tool_use block, the tool runs, the conversation continues, and you get a coherent reply
- Confirm without tools the existing examples/hello-cli still works (regression)

Update docs/MODULE-CATALOG.md with everything that is complete and create a pull request with all updates.
```

---

### Section 3 — First built-in tools

```
Read docs/build-roadmap.md Section 3. Also read:
- packages/tool-catalog/src/index.ts (the ToolDefinition interface)
- packages/tool-builder/src/index.ts (the buildTool factory)
- packages/tool-executor/src/index.ts (how tools are executed)

Build three new packages in parallel — they do not depend on each other:

1. packages/tool-fs
   - Tools: Read(path), Write(path, content), Edit(path, oldString, newString), Glob(pattern), Grep(pattern, path?)
   - All paths must resolve within process.cwd() — throw ToolPermissionError for traversal attempts
   - Write must be atomic: write to a temp file, then rename
   - Edit must error if oldString appears 0 or >1 times in the file

2. packages/tool-bash
   - Tool: Bash(command, timeout?: number)
   - Use Bun.spawn, capture stdout+stderr, default 30s timeout
   - Return formatted string with both streams and exit code

3. packages/tool-todo
   - Tool: TodoWrite(todos: Array<{id: string, content: string, status: "pending"|"in_progress"|"completed", priority: "low"|"medium"|"high"}>)
   - Store current list in a module-level variable (per-session)
   - Return a markdown checklist

Each package: @crewhaus/tool-fs etc., type: "module", workspace:* deps on tool-catalog and tool-builder. Include T1 unit tests and T3 integration tests. tool-bash timeout test: verify the process is killed after timeout. tool-fs path-traversal test: verify ../../../etc/passwd is rejected.

End-to-end smoke test before opening the PR:
- ANTHROPIC_AUTH_TOKEN is in .env (Bun auto-loads .env)
- Create a smoke spec with tools: [Read, Bash, TodoWrite] in a temp dir; compile and run
- Drive these prompts and verify each tool actually executes against the live model:
  1. "list the files in . using the Bash tool" — expect a Bash tool_use, real ls output, then a summary
  2. "read the package.json and tell me the name field" — expect Read tool_use, JSON content, correct extracted name
  3. "make a 3-item todo list for tonight" — expect TodoWrite tool_use, markdown checklist back
- Verify the path-traversal defense at runtime: prompt the agent to "Read ../../../etc/passwd" and confirm the tool returns a permission error rather than file content
- Clean up the temp dir

Update docs/MODULE-CATALOG.md with everything that is complete and create a pull request with all updates.
```

---

### Section 4 — Turn state machine + context management

```
Read docs/build-roadmap.md Section 4. Also read:
- packages/runtime-core/src/index.ts (the current runChatLoop implementation)
- docs/MODULE-CATALOG.md Layer R1 entry for turn-state-machine and R2 entry for token-budget
- docs/MODULE-CATALOG.md Layer R6 entries for compaction-snip and compaction-autocompact

Build five packages. Start turn-state-machine and run-context in parallel. Then build token-budget. Then build compaction-snip and compaction-autocompact in parallel.

1. packages/turn-state-machine
   - Pure state machine (no I/O): NeedModel | NeedTools | NeedCompaction | NeedRecovery | Done
   - transition(state, event): TurnState
   - Property tests (T9) over all valid and invalid transitions

2. packages/run-context
   - RunContext type: { runId: string, sessionId: string, turnNumber: number, abortSignal: AbortSignal, logger: Logger }
   - createRunContext(opts): RunContext factory

3. packages/token-budget
   - estimateTokens(messages): number (character-count / 4 heuristic)
   - TokenBudget class with add(inputTokens, outputTokens) and isApproachingLimit(threshold = 0.85): boolean

4. packages/compaction-snip
   - snip(messages, keepHead, keepTail): Message[] — removes middle messages
   - Inserts a [Context compacted: N messages removed] assistant message at the snip point
   - Does NOT call the model — pure transformation

5. packages/compaction-autocompact
   - autoCompact(messages, client, model): Promise<Message[]>
   - Calls the model to summarize the conversation; returns [systemMessage, summaryMessage]

After all five packages are built, integrate them into packages/runtime-core:
- Thread RunContext through runChatLoop
- Use turn-state-machine for the turn loop
- Check token-budget at the start of each turn
- Apply snip first (free), then autocompact if still over 85% of limit

End-to-end smoke test before opening the PR:
- ANTHROPIC_AUTH_TOKEN is in .env (Bun auto-loads .env)
- Regression: `bun run compile:hello && echo "tell me a haiku" | bun run run:hello` still completes successfully
- Force compaction in a real run: temporarily lower the token-budget threshold (env var or const override) so the limit triggers within a few turns, then have a 6-turn conversation. Confirm in stderr/logs that snip fires first and autoCompact fires when snip alone is insufficient. Confirm the model still produces coherent replies after compaction.
- Restore the original threshold before opening the PR

Update docs/MODULE-CATALOG.md with everything that is complete and create a pull request with all updates.
```

---

### Section 5 — CLI subcommand expansion

```
Read docs/build-roadmap.md Section 5. Also read:
- apps/cli/src/index.ts (current CLI with compile subcommand)
- packages/infra-utils/src/index.ts (parseArgs implementation)
- packages/spec/src/index.ts (spec schema — needed for init)

Add three new subcommands to apps/cli/src/index.ts. These can be developed in parallel as separate handler functions.

1. crewhaus init [name]
   - Write a crewhaus.yaml to the current directory (or ./name/ if name is given)
   - Template: name from arg or cwd basename, target: cli, model: claude-opus-4-7, a placeholder instructions string
   - Error if crewhaus.yaml already exists

2. crewhaus run <spec.yaml> [--model <model>]
   - Parse spec, compile to IR in-process (do not write to disk)
   - Execute runChatLoop() directly from runtime-core
   - Accepts --model flag to override the model in the spec

3. crewhaus doctor
   - Check: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is set, bun --version >= 1.2.0, crewhaus.yaml exists in cwd
   - Print a human-readable checklist with ✓/✗ per check
   - Exit 1 if any check fails, 0 if all pass

Update the help text at the top of the file to list all four subcommands (compile, run, init, doctor).

Write integration tests using Bun.spawn for each subcommand. The run test should use examples/hello-cli/crewhaus.yaml with a mock input that closes stdin immediately.

End-to-end smoke test before opening the PR:
- ANTHROPIC_AUTH_TOKEN is in .env (Bun auto-loads .env)
- In a temp dir: `bun apps/cli/src/index.ts init smoke-bot` → confirm crewhaus.yaml exists and parses cleanly
- `bun apps/cli/src/index.ts doctor` in the temp dir → confirm exits 0 (token present, bun version OK, yaml present)
- Unset ANTHROPIC_AUTH_TOKEN inline (`env -u ANTHROPIC_AUTH_TOKEN bun apps/cli/src/index.ts doctor`) → confirm exits 1 with a missing-credential message
- `echo "say hi in 5 words" | bun apps/cli/src/index.ts run smoke-bot/crewhaus.yaml` → confirm a real reply from the model
- Clean up the temp dir

Update docs/MODULE-CATALOG.md with everything that is complete and create a pull request with all updates.
```

---

### Section 6 — Workflow target shape

```
Read docs/build-roadmap.md Section 6. Also read:
- packages/spec/src/index.ts
- packages/ir/src/index.ts
- packages/compiler/src/index.ts
- packages/target-cli/src/index.ts (as a template for how a codegen backend is structured)
- packages/runtime-core/src/index.ts

Add a second target shape — workflow — to the full pipeline:

1. packages/spec — add workflow target to the discriminated union:
   target: "workflow" with steps: z.array(z.object({ name: z.string(), instructions: z.string(), tools: z.array(z.string()).optional() })).min(1)
   The existing CLI union becomes: z.discriminatedUnion("target", [cliSchema, workflowSchema])

2. packages/ir — add IrWorkflowV0 type:
   { version: 0, name: string, target: "workflow", steps: Array<{ name: string, instructions: string, tools: string[] }> }
   Export IrNode = IrV0 | IrWorkflowV0

3. packages/compiler — detect workflow target in lower() and produce IrWorkflowV0; dispatch to target-workflow in emit()

4. packages/target-workflow (new package)
   - emitWorkflow(ir: IrWorkflowV0): Bundle
   - Generated agent.ts runs each step sequentially via runChatLoop()
   - Each step receives a new system prompt (step.instructions); the final assistant message from step N is prepended to the user message of step N+1 as context
   - Accepts input from stdin only for the first step

5. examples/hello-workflow/crewhaus.yaml
   - A two-step workflow: step 1 uses Bash to list files in the current directory, step 2 summarizes what it found
   - Add compile:hello-workflow and run:hello-workflow scripts to the root package.json

Tests: unit tests for target-workflow verifying the generated code structure. Integration test compiling hello-workflow and confirming it produces a bundle with step-sequencing logic.

End-to-end smoke test before opening the PR:
- ANTHROPIC_AUTH_TOKEN is in .env (Bun auto-loads .env)
- `bun run compile:hello-workflow && bun run run:hello-workflow`
- Verify in the output that step 1 ran first (lists files via Bash), step 2 ran second (summary), and the step-2 prompt clearly received step-1's output as context
- Re-run the existing CLI example (`bun run run:hello`) to confirm the discriminated-union spec change did not break the cli target

Update docs/MODULE-CATALOG.md with everything that is complete and create a pull request with all updates.
```

---

### Section 7 — Hardening: recovery, permission, abort

```
Read docs/build-roadmap.md Section 7. Also read:
- packages/runtime-core/src/index.ts (where recovery + permission + abort all integrate)
- packages/tool-permission-matcher/src/index.ts (the existing pattern matcher to build on)
- packages/tool-executor/src/index.ts (where permission gates apply)
- docs/MODULE-CATALOG.md Layer R1 entries for recovery-engine and abort-controller, Layer R8 entry for permission-engine

Build three packages in parallel — they have no dependencies on each other:

1. packages/recovery-engine
   - Classify Anthropic errors into a recovery taxonomy (prompt_too_long → compact, max_output_tokens → continue, overloaded/5xx → exponential backoff, invalid_request → tombstone)
   - recover(error, state): RecoveryAction where RecoveryAction is a discriminated union: { kind: "compact" } | { kind: "retry", delayMs } | { kind: "continue" } | { kind: "tombstone", messageId } | { kind: "fail", reason }
   - No I/O — pure decision function

2. packages/permission-engine
   - Modes: default | plan | auto | bypass
   - Rule sources, in priority order: command-line flag → .crewhaus/settings.json → crewhaus.yaml permissions block → hook decisions → built-in defaults
   - Rule types: alwaysAllow | alwaysDeny | alwaysAsk
   - evaluate(toolCall, mode, rules): "allow" | "deny" | "ask"
   - Build on top of @crewhaus/tool-permission-matcher for pattern primitives
   - SECURITY: bypass mode must NOT be settable from a YAML file — only via command-line flag. Add a unit test asserting this.

3. packages/abort-controller
   - createAbortTree(parent?: AbortSignal): { signal, abort, child(): AbortTree }
   - Parent abort cascades to all children; siblings are independent
   - First SIGINT cancels current turn; second exits the process

After all three are built, integrate into packages/runtime-core:
- Wrap each model call in try/catch that delegates to recovery-engine; honor RecoveryAction (retry, compact, continue, tombstone, fail)
- Run every tool through permission-engine.evaluate() before tool-executor; in default/auto modes, prompt the user via stdin for "ask" decisions
- Thread the abort tree through runChatLoop and into Bun.spawn calls in tool-bash via the signal option

Tests:
- recovery-engine: T1 unit tests per error class; T4 replay test over a fixture of recorded errors
- permission-engine: T9 property tests over rule precedence; T8 security test on bypass-mode lockdown
- abort-controller: T3 integration test verifying child-tool processes receive SIGTERM on parent abort

End-to-end smoke test before opening the PR (against the live model via ANTHROPIC_AUTH_TOKEN in .env):
1. Recovery: temporarily point the runtime at an unreachable Anthropic base URL (env override) for one turn so the model call fails with a network/5xx error; confirm recovery-engine drives a retry with backoff and the run eventually succeeds when you restore the URL. Then revert.
2. Permission (default mode): run a spec with tools: [Bash], prompt "run rm -rf /tmp/crewhaus-smoke" and confirm the runtime asks for approval on stdin; type "n" and confirm the tool is denied with a clean message in the assistant reply.
3. Permission (bypass via flag): with --permission-mode bypass on the command line, the same tool call runs without prompting. Verify bypass set in crewhaus.yaml is REJECTED at parse time (security check).
4. Abort: start a long-running prompt ("count slowly to 200, one number per line"), press Ctrl-C once. Confirm the current turn aborts cleanly, no orphan child processes (`ps` should show no leftover bash from the smoke run), and the process is still alive accepting input. Press Ctrl-C again — confirm clean exit.
- Clean up any /tmp/crewhaus-smoke artifacts

Update docs/MODULE-CATALOG.md and docs/build-roadmap.md with everything that is complete and create a pull request with all updates.
```

---

### Section 8 — Tool layer enrichment

```
Read docs/build-roadmap.md Section 8. Also read:
- packages/runtime-core/src/index.ts (the inline tool loop to be replaced)
- packages/tool-executor/src/index.ts (where streaming variant slots in)
- packages/tool-catalog/src/index.ts (the metadata flags driving partition)
- docs/MODULE-CATALOG.md Layer R3 entries for tool-orchestrator, tool-loop-detection, tool-result-store, streaming-tool-executor

Build four packages in parallel — they have no dependencies on each other:

1. packages/tool-orchestrator
   - partitionToolCalls(calls, catalog): { concurrent: ToolUse[][], serial: ToolUse[] }
   - Tools that are concurrencySafe && readOnly batch together (run via Promise.all)
   - Anything destructive or with side effects goes serial
   - Property test (T9): no two destructive tools in same concurrent batch

2. packages/tool-loop-detection
   - Sliding-window hash of (toolName, input) pairs
   - detectLoop(history, windowSize=10, threshold=3): LoopDetection | null
   - When triggered, return the loop signature + count; runtime injects a warning tool-result and continues

3. packages/tool-result-store
   - Persist outputs > 10KB to .crewhaus/tool-results/<runId>/<toolUseId>.txt
   - storeAndPreview(result, opts): { previewContent: string, fullPath: string }
   - Preview = first 100 lines + "[truncated, full output at <fullPath>]"

4. packages/streaming-tool-executor
   - Parse partial tool_use blocks from the stream and start execution before message_stop
   - Track per-tool-use-id partial-args parsing state; fire executeTool() when args are complete-and-valid
   - Sibling abort: if a sibling tool errors and the strategy demands it, abort still-running tools

After all four are built, integrate into packages/runtime-core:
- Replace inline tool execution with tool-orchestrator.partitionToolCalls() then Promise.all on concurrent batches
- Run tool-loop-detection.detectLoop() after each batch; on hit, append a system warning and continue
- Wrap every tool result through tool-result-store.storeAndPreview() before appending to message history
- Behind a streaming: true flag on RunChatLoopOptions, swap tool-executor for streaming-tool-executor

Tests: T1 unit tests per package; T7 load test for streaming-tool-executor with 50 partial tool_use blocks.

End-to-end smoke test before opening the PR (against the live model via ANTHROPIC_AUTH_TOKEN in .env):
1. Concurrency: spec with tools: [Read, Bash] (Read is concurrencySafe + readOnly, Bash is not). Prompt "read package.json AND run pwd in parallel" — confirm in logs/timing that Read calls batch concurrently while Bash runs serially.
2. Loop detection: prompt the agent in a way that nudges it to repeat the same tool call (e.g. "keep running `date` over and over, don't stop"). Confirm tool-loop-detection injects a warning system message and the agent stops looping.
3. Result store: prompt "Read /usr/share/dict/words" (or another large file). Confirm the message history contains a preview-only tool result, the full output is on disk under .crewhaus/tool-results/<runId>/, and a follow-up prompt "find the longest word in that file" still works (agent reads the stored path).
4. Streaming: with streaming: true on the run, confirm via timing logs that a Bash tool starts executing before the assistant message_stop event fires.
- Clean up .crewhaus/tool-results/ artifacts

Update docs/MODULE-CATALOG.md and docs/build-roadmap.md with everything that is complete and create a pull request with all updates.
```

---

### Section 9 — MCP host

```
Read docs/build-roadmap.md Section 9. Also read:
- packages/tool-catalog/src/index.ts (where MCP tools register)
- packages/tool-builder/src/index.ts (the buildTool factory used to wrap MCP tools)
- packages/spec/src/index.ts (extend with mcp_servers block)
- packages/ir/src/index.ts and packages/compiler/src/index.ts and packages/target-cli/src/index.ts (thread mcp_servers through the pipeline)
- docs/MODULE-CATALOG.md Layer R5 entry for mcp-host and Layer R4 entry for tool-mcp

Build sequentially — tool-mcp depends on mcp-host:

1. packages/mcp-host (build first)
   - Transports: stdio (Bun.spawn child process with NDJSON over stdin/stdout) and SSE (HTTP + EventSource)
   - McpClient class: connect() / listTools() / callTool(name, args) / disconnect()
   - Connection lifecycle: spawn → initialize handshake → capability poll; reconnect with exponential backoff (max 30s)
   - McpHost registry: addServer(name, config) / getClient(name) / disconnectAll()
   - Server config: { command, args?, env? } for stdio | { url, headers? } for SSE

2. packages/tool-mcp (build after mcp-host)
   - registerMcpServer(host, serverName, catalog): Promise<void>
   - Calls listTools() on the server; for each remote tool, builds a RegisteredTool via @crewhaus/tool-builder and registers as <serverName>__<toolName>
   - Tool invocation delegates to host.getClient(serverName).callTool(...)
   - Default flags: concurrencySafe: false, readOnly: false, destructive: false (caller can override per-server)

3. Thread mcp_servers through the pipeline:
   - packages/spec: add optional mcp_servers?: Record<string, McpServerConfig>
   - packages/ir: add mcp_servers field on IrV0 (and IrWorkflowV0, IrChannelV0 if in flight)
   - packages/compiler: pass through unchanged
   - packages/target-cli: emit boot code that constructs McpHost, calls addServer per entry, then awaits Promise.all(entries.map(e => registerMcpServer(host, e.name, catalog))) before runChatLoop()

Tests:
- mcp-host: T2 contract test against the official MCP everything-server reference; T3 stdio reconnect after kill; T8 schema-validator escape attempt
- tool-mcp: T3 wiring a mock McpHost + catalog and round-tripping a remote tool call

End-to-end smoke test before opening the PR (against the live model via ANTHROPIC_AUTH_TOKEN in .env):
1. Stdio MCP: write a smoke spec with `mcp_servers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] } }`. Compile and run.
2. On boot, confirm the runtime logs that it connected to the server and registered each remote tool under the namespaced name (e.g. `everything__echo`, `everything__add`).
3. Prompt: "use the everything__echo tool to echo back the string 'hello mcp'". Confirm the tool call round-trips through the MCP server and the model receives 'hello mcp' as the result.
4. Reconnect: while the agent is running, find the spawned npx child PID and `kill -9` it. Confirm mcp-host detects the disconnect, reconnects with backoff, and a follow-up tool call succeeds.
5. Verify nothing in the existing examples (hello-cli, hello-workflow) regressed when no mcp_servers are configured.

Update docs/MODULE-CATALOG.md and docs/build-roadmap.md with everything that is complete and create a pull request with all updates.
```

---

### Section 10 — Persistence: state, sessions, event log

```
Read docs/build-roadmap.md Section 10. Also read:
- packages/runtime-core/src/index.ts (where all three integrate)
- packages/run-context/src/index.ts (RunContext gains sessionId)
- apps/cli/src/index.ts (run subcommand gains --resume flag)
- docs/MODULE-CATALOG.md Layer R7 entries for state-store, session-store, event-log

Build three packages in parallel — they have no dependencies on each other:

1. packages/state-store
   - createStore<T>(initial: T): Store<T> — zustand-style
   - API: get() / set(partial) / subscribe(listener) / select(selector)
   - Listener fires only on actual change (referential equality on selector output)
   - Property test (T9) over subscribe ordering and equality

2. packages/session-store
   - File-backed persistence at .crewhaus/sessions/<sessionId>.json
   - Session shape: { id, createdAt, updatedAt, name, target, model, lastTurnIndex }
   - API: create(opts) / get(id) / list() / update(id, patch) / delete(id)
   - On list(), evict any session older than 30 days

3. packages/event-log
   - Append-only JSONL at .crewhaus/sessions/<sessionId>.jsonl
   - Event shape: { ts, version: 1, kind: "user_message" | "assistant_message" | "tool_use" | "tool_result" | "error" | "compaction", payload }
   - API: open(sessionId): EventLog / append(event) / read({ since?, until? }): AsyncIterable<Event> / close()

After all three are built, integrate into packages/runtime-core:
- On runChatLoop start: create or resume session via session-store; open event-log; create state-store bound to this run; thread sessionId through RunContext
- After every model response and tool result: append to event log
- On runChatLoop exit: update session lastTurnIndex; close event log

Then in apps/cli/src/index.ts:
- Add --resume <sessionId> flag to crewhaus run that replays the event log into message history before continuing

Tests:
- state-store: T9 property tests
- session-store: T3 integration test for create + list + 30-day eviction
- event-log: T7 load test with 10K events; T4 replay test confirming --resume produces an identical message history

End-to-end smoke test before opening the PR (against the live model via ANTHROPIC_AUTH_TOKEN in .env):
1. Run `bun run run:hello`, send: "remember the magic word is `parsnip`", then exit (Ctrl-D).
2. Confirm `.crewhaus/sessions/<id>.json` exists with the session metadata, and `.crewhaus/sessions/<id>.jsonl` contains user_message + assistant_message events.
3. Capture the sessionId, then run: `bun apps/cli/src/index.ts run examples/hello-cli/crewhaus.yaml --resume <id>` and ask "what was the magic word?". Confirm the model recalls "parsnip" — proving event-log replay reconstructed the prior conversation.
4. Trigger eviction: backdate one session file's mtime to 31 days ago (`touch -t YYYYMMDD0000 ...`) and run `crewhaus run` again — confirm the old session is purged from `list()`.
5. Clean up `.crewhaus/sessions/` after the smoke run.

Update docs/MODULE-CATALOG.md and docs/build-roadmap.md with everything that is complete and create a pull request with all updates.
```

---

### Section 11 — Hooks, skills, slash commands

```
Read docs/build-roadmap.md Section 11. Also read:
- packages/runtime-core/src/index.ts (where hooks fire)
- packages/tool-catalog/src/index.ts (skills add a Skill tool)
- apps/cli/src/index.ts (where slash commands intercept)
- docs/MODULE-CATALOG.md Layer R9 entries for hooks-engine, skills-registry, slash-commands

Build sequentially — skills-registry and slash-commands both depend on hooks-engine:

1. packages/hooks-engine (build first)
   - Lifecycle events: session-start | pre-tool | post-tool | pre-compact | post-compact | stop | pre-model | post-model
   - Hook def: { event, matcher?: string (glob), command: string }
   - Runtime: spawn the command via Bun.spawn, write event payload as JSON on stdin, parse JSON decision from stdout
   - Decision shape: { decision: "allow" | "deny" | "block", reason?, mutate?: object }
   - Load from .crewhaus/settings.json (project) and ~/.crewhaus/settings.json (user); user settings stack under project settings
   - API: loadHooks() / runHooks(event, payload): Promise<HookResult[]>
   - SECURITY: hook commands inherit a restricted env (drop PATH except known-safe entries; no AWS/GCP creds)

2. packages/skills-registry (parallel with slash-commands after hooks-engine)
   - A skill = directory with SKILL.md + frontmatter (name, description, triggers?, tools?)
   - Discovery order: ~/.crewhaus/skills/, <project>/.crewhaus/skills/, plugin-bundled
   - Lazy load: at boot, list skills (frontmatter only) and inject names + descriptions into the system prompt
   - Adds a built-in Skill(name) tool to the default catalog when skills are present; full body loads only when this tool is invoked

3. packages/slash-commands (parallel with skills-registry after hooks-engine)
   - A slash command = .crewhaus/commands/<name>.md with optional frontmatter (description, argument-hint)
   - When user input starts with /<name>, expand the markdown body (with $ARGUMENTS substitution) into the user message and submit
   - API: loadCommands(): Map<string, SlashCommand> / expand(input, commands): { handled: boolean, expanded: string }
   - Fires a pre-slash hook event before expansion

After all three are built, integrate:
- packages/runtime-core: fire hook events at the right moments; a "deny" decision short-circuits with the hook's reason as the result
- apps/cli/src/index.ts run subcommand: check for slash commands on each user input before sending to the model
- system-prompt construction in target-cli + target-workflow: add a section listing available skills

Tests:
- hooks-engine: T3 fixture hook returning "deny"; T8 verifying restricted env
- skills-registry: T1 frontmatter parsing; T3 verifying full skill body loads only on Skill tool call
- slash-commands: T9 property test over $ARGUMENTS substitution edge cases

End-to-end smoke test before opening the PR (against the live model via ANTHROPIC_AUTH_TOKEN in .env):
1. Hooks: in a temp project, write `.crewhaus/settings.json` with a pre-tool hook for Bash that returns `{"decision":"deny","reason":"smoke test deny"}`. Run the agent and prompt "run `whoami`". Confirm the assistant reply surfaces the deny reason and Bash never executed (no `whoami` output).
2. Skills: place `.crewhaus/skills/say-pirate/SKILL.md` with frontmatter (name, description: "respond like a pirate") and a body of pirate-speak instructions. Run the agent; confirm the system prompt lists "say-pirate" as available. Prompt "use the say-pirate skill and greet me" — confirm the agent calls Skill("say-pirate") and the reply is in pirate voice.
3. Slash commands: place `.crewhaus/commands/explain.md` with body "Explain $ARGUMENTS in two sentences." Run the agent; type `/explain quicksort`. Confirm the input was expanded before being sent (the model reply should be a quicksort explanation, not a meta-comment about a slash command).
4. Clean up the temp project.

Update docs/MODULE-CATALOG.md and docs/build-roadmap.md with everything that is complete and create a pull request with all updates.
```

---

### Section 12 — Channel bot target shape (Slack)

```
Read docs/build-roadmap.md Section 12. Also read:
- packages/target-cli/src/index.ts and packages/target-workflow/src/index.ts (codegen patterns to follow)
- packages/session-store/src/index.ts and packages/event-log/src/index.ts (Section 10 — required prereqs)
- packages/hooks-engine/src/index.ts (Section 11 — required prereq)
- packages/mcp-host/src/index.ts (Section 9 — used by generated daemon)
- docs/MODULE-CATALOG.md Layer F2 entry for target-channel-bot, R4 entries for tool-message-channel

Build the channel target as follows. The spec/IR additions are sequential prereqs; everything else is parallel.

1. packages/spec — add channel target to the discriminated union:
   target: "channel" with:
   - agent: { model, instructions, tools? }
   - channels: { slack?: { botToken, signingSecret, appToken? } }
   - routing: { sessionKey: "thread" | "user" | "channel" }

2. packages/ir — add IrChannelV0 mirroring the spec; export IrNode = IrV0 | IrWorkflowV0 | IrChannelV0

3. packages/compiler — detect target: "channel" in lower(); dispatch to target-channel-bot in emit()

4. packages/target-channel-bot (parallel with adapter)
   - First codegen target that emits multiple files: gateway.ts, daemon.ts, session-router.ts, agent.ts
   - daemon.ts boots Bun.serve(), wires gateway routes per channel, instantiates McpHost
   - gateway.ts dispatches inbound webhooks to session-router via the appropriate channel adapter
   - session-router.ts maps inbound message → sessionId (per routing.sessionKey), resumes via session-store + event-log, runs one runChatLoop turn per inbound message
   - agent.ts wraps runChatLoop config (similar to target-cli)

5. packages/channel-adapter-slack (parallel with target-channel-bot)
   - createSlackAdapter(config): ChannelAdapter
   - ChannelAdapter shape: { verify(req): boolean, parseInbound(req): InboundEvent, sendReply(threadKey, text), setTyping(threadKey) }
   - HMAC verification of X-Slack-Signature using signingSecret with timestamp tolerance ±5min
   - Event handling: message, app_mention; ignore bot_id matching self

6. packages/tool-message-channel (parallel with adapter)
   - Tool: SendMessage(channel, text)
   - Permission-gated by default — requires explicit allow rule via permission-engine
   - Delegates to the appropriate channel adapter

7. examples/hello-channel/crewhaus.yaml + scripts
   - Slack bot: app_mention triggers an agent reply in-thread, with tool-fs and tool-bash available via permission rules
   - Add compile:hello-channel and run:hello-channel scripts to the root package.json

Tests:
- target-channel-bot: T1 generated bundle structure; T3 compile hello-channel, start daemon, post a fake Slack webhook, assert reply
- channel-adapter-slack: T2 contract test against a recorded Slack event corpus; T8 signature verification with tampered payloads
- tool-message-channel: T8 verifying fail-closed without explicit allow

End-to-end smoke test before opening the PR (against the live model via ANTHROPIC_AUTH_TOKEN in .env):
- The model side runs against the live Anthropic API. The Slack side is exercised with a synthetic webhook (no real Slack workspace required). Note in .env.example that real-Slack smoke needs SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET, but they are NOT required for this smoke.
1. Compile hello-channel with placeholder Slack creds and start the daemon: `bun run run:hello-channel &` — capture the PID.
2. Compute a valid X-Slack-Signature for a fixture app_mention payload using the placeholder signing secret and POST it to the daemon's /slack/events endpoint. Confirm the daemon: parses the event, resolves a session via session-store keyed on thread_ts, runs one turn against the live model, and emits a sendReply call (mock the Slack outbound HTTP with a local listener and assert the body).
3. POST the SAME signed payload twice and confirm the daemon does not double-process (idempotency on Slack event_id).
4. POST a payload with a tampered signature and confirm the daemon rejects it with 401 — no model call made.
5. Kill the daemon (clean shutdown; no orphan processes).

Update docs/MODULE-CATALOG.md and docs/build-roadmap.md with everything that is complete and create a pull request with all updates.
```
