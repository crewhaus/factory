# CrewHaus Factory — Build Roadmap

> Status as of 2026-05-05. 21 of ~190 catalog modules implemented.
> See `docs/MODULE-CATALOG.md` for full per-module specs and test layer references.

---

## Current baseline

The compiler pipeline (spec → IR → codegen) and a minimal streaming chat runtime are complete. Generated agents run a multi-turn REPL with prompt caching but cannot call tools, manage context limits, or be invoked without a prior `compile` step. The sections below unlock each of those capabilities in dependency order.

---

## Section 1 — Tool layer foundation

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

Update docs/MODULE-CATALOG.md with everything that is complete and create a pull request with all updates.
```
