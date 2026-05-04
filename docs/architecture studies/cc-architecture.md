# Claude Code Architecture Research

**Source:** Recovered source tree from npm bundle + source map (leaked 2026-03-31)
**Scale:** ~1,900 files, 512,000+ lines of TypeScript
**Runtime:** Bun, React + Ink (terminal UI)

---

## 1. Entry Point & Startup (`src/main.tsx`)

4,684 lines. Commander.js program with `preAction` hook pattern:

```
main() → run() → program.hook('preAction', async () => {
  await init()          // trust, telemetry, settings
  runMigrations()       // versioned sync migrations (CURRENT_MIGRATION_VERSION = 11)
  loadRemoteManagedSettings()  // enterprise, non-blocking
  loadPolicyLimits()
})
```

**Key startup optimizations (worth stealing):**
- Side-effect imports at top of file fire MDM subprocesses and keychain reads in parallel with module loading (~135ms of imports)
- `startDeferredPrefetches()` — defers non-critical work (git status, user context, tips, model capabilities) to AFTER first render
- `eagerLoadSettings()` — parses `--settings` flag before init() to ensure settings are filtered from start
- `profileCheckpoint()` throughout for startup profiling

**Execution paths:**
- Interactive REPL: `launchRepl()` → React/Ink terminal UI
- Non-interactive (`-p`/`--print`): headless `ask()` / `QueryEngine`
- SDK: `QueryEngine.submitMessage()` async generator
- Feature-gated: `COORDINATOR_MODE`, `KAIROS` (assistant), `SSH_REMOTE`, `DIRECT_CONNECT`

## 2. Conversation State

### Message Types (`src/types/message.ts`)
Messages are a discriminated union:
- `UserMessage` — user input, tool results, meta messages
- `AssistantMessage` — model responses (with `message.content` blocks, `usage`, `stop_reason`)
- `SystemMessage` — subtypes: `compact_boundary`, `api_error`, `local_command`, `warning`
- `ProgressMessage` — tool progress updates
- `AttachmentMessage` — CLAUDE.md injections, skill attachments, structured output
- `TombstoneMessage` — signals to remove orphaned messages from UI

### State Management (`src/state/`)

**Zustand-style store** at `src/state/store.ts` (40 lines, dead simple):
```typescript
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // referential equality skip
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener: Listener) => { ... }
  }
}
```

**AppState** (`src/state/AppStateStore.ts`) — monolithic state object:
- `toolPermissionContext` — permission mode, allow/deny rules, additional working dirs
- `mcp` — MCP clients, tools, resources
- `messages` (in REPL mode)
- `mainLoopModel`, `thinkingConfig`, `effortValue`
- `speculation` — speculative execution state
- `fileHistory`, `attribution`
- `fastMode`, `verbose`, `settings`
- `denialTracking`, `sessionHooks`
- `toolPermissionContext.mode` — `'default' | 'plan' | 'auto'` (PermissionMode)

**Pattern:** `getAppState()` / `setAppState(prev => ({...prev, ...}))` passed through `ToolUseContext` everywhere. Immutable updates with spread.

### Session Storage (`src/utils/sessionStorage.ts`)
- Transcript persisted to disk as JSONL
- `recordTranscript(messages)` — fire-and-forget for assistant messages, awaited for user messages
- Session recovery via `loadConversationForResume()`
- Eager flush for cowork/desktop (process can be killed anytime)

### Context Window Management
**Multi-layer compaction system:**
1. **Snip** (`services/compact/snipCompact.ts`) — removes old middle messages, keeps head+tail
2. **Microcompact** (`services/compact/`) — cached, operates by tool_use_id
3. **Context Collapse** (`services/contextCollapse/`) — read-time projection over full history
4. **Auto-compact** — full conversation summary when approaching token limits
5. **Reactive compact** — emergency compaction on 413 (prompt too long) errors
6. **Tool result budget** (`utils/toolResultStorage.ts`) — per-message budget on aggregate tool result size

Order: `snip → microcompact → context_collapse → autocompact`

**Token budget tracking** (`query/tokenBudget.ts`): +500k auto-continue feature, separate from API `task_budget`.

## 3. Tool System

### Tool Interface (`src/Tool.ts`)

~500 lines defining the `Tool` type. Key methods:

```typescript
type Tool<Input, Output, Progress> = {
  name: string
  inputSchema: ZodSchema          // Zod v4 for input validation
  call(args, context, canUseTool, parentMessage, onProgress?)
  description(input, options)      // Dynamic description based on context
  prompt(options)                  // System prompt contribution
  checkPermissions(input, context) // Tool-specific permission logic
  validateInput?(input, context)   // Pre-permission validation
  
  // Behavior flags
  isConcurrencySafe(input): boolean   // Can run in parallel?
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'
  
  // UI rendering (React/Ink)
  renderToolUseMessage(input, options): ReactNode
  renderToolResultMessage?(content, progress, options): ReactNode
  renderToolUseProgressMessage?(progress, options): ReactNode
  
  // Permission system
  preparePermissionMatcher?(input): (pattern: string) => boolean
  
  // For ToolSearch deferred loading
  shouldDefer?: boolean
  alwaysLoad?: boolean
  searchHint?: string
  
  maxResultSizeChars: number  // Infinity for tools like Read
}
```

**`buildTool()` factory** — fills in safe defaults (fail-closed):
```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,  // assume not safe
  isReadOnly: () => false,         // assume writes
  isDestructive: () => false,
  checkPermissions: (input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',
  userFacingName: () => '',
}
```

### Built-in Tools (`src/tools.ts`, `src/tools/`)

Core tools always present:
- `BashTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`
- `GlobTool`, `GrepTool` (excluded when embedded search tools available)
- `AgentTool` (subagent spawning)
- `WebFetchTool`, `WebSearchTool`
- `TodoWriteTool`, `NotebookEditTool`
- `AskUserQuestionTool`, `SkillTool`
- `EnterPlanModeTool`, `ExitPlanModeV2Tool`

Feature-gated tools (via `bun:bundle` `feature()` for dead code elimination):
- `REPLTool` (ant-only), `WebBrowserTool`, `SleepTool`, `CronTools`
- `MonitorTool`, `SnipTool`, `WorkflowTool`, `TerminalCaptureTool`
- `ToolSearchTool` — deferred tool loading, keyword search

**Tool assembly pipeline:**
```
getAllBaseTools() → filterToolsByDenyRules(tools, permissionContext) → getTools()
                                                                          ↓
MCP tools → filterToolsByDenyRules() → assembleToolPool() [sorted: builtins prefix, MCP suffix]
```

Sort order matters for **prompt cache stability** — built-ins are a contiguous prefix.

### Tool Orchestration (`src/services/tools/toolOrchestration.ts`)

**Partitioned execution:**
```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  // Groups consecutive concurrency-safe tools into parallel batches
  // Non-concurrent tools get their own serial batch
}
```

- Concurrent-safe tools run in parallel (up to `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, default 10)
- Non-concurrent tools run serially
- Context modifiers from concurrent tools are queued and applied after batch completes

### Streaming Tool Executor (`src/services/tools/StreamingToolExecutor.ts`)

Executes tools AS they stream in (before full response):
- Tracks tool status: `queued → executing → completed → yielded`
- Child abort controller — sibling abort on Bash error (doesn't abort parent query)
- `addTool(block, assistantMessage)` — called during streaming
- `getCompletedResults()` — yields completed results in order
- `getRemainingResults()` — async generator for remaining after stream ends
- `discard()` — abandons all on streaming fallback

## 4. Query Loop (`src/query.ts`)

~1,730 lines. The core agentic loop as an **async generator**:

```typescript
async function* query(params): AsyncGenerator<StreamEvent | Message, Terminal> {
  while (true) {
    // 1. Apply tool result budget
    // 2. Snip compact
    // 3. Microcompact  
    // 4. Context collapse
    // 5. Auto-compact
    // 6. Stream from API (callModel)
    // 7. Execute tools (streaming or post-stream)
    // 8. Handle recovery: max_output_tokens, prompt_too_long, media errors
    // 9. Handle stop hooks
    // 10. Continue or return Terminal
  }
}
```

**Recovery mechanisms:**
- `max_output_tokens`: escalate to 64k tokens, then multi-turn recovery (up to 3 attempts) with meta message "Resume directly — no apology, no recap"
- `prompt_too_long`: collapse drain → reactive compact → surface error
- Media size errors: reactive compact strip-retry
- Model fallback: `FallbackTriggeredError` → switch model, retry with tombstoned orphan messages

**State machine pattern:** `State` object carried between iterations, `Continue` transitions for different recovery paths.

## 5. QueryEngine (`src/QueryEngine.ts`)

Class wrapping the query loop for SDK/headless use:
```typescript
class QueryEngine {
  private mutableMessages: Message[]
  private abortController: AbortController
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache
  
  async *submitMessage(prompt, options): AsyncGenerator<SDKMessage> {
    // 1. processUserInput (slash commands, attachments)
    // 2. Build system prompt (fetchSystemPromptParts)
    // 3. Record transcript
    // 4. for await (const message of query({...})) { yield normalized }
    // 5. Yield final result message
  }
}
```

**SDK message types:** `SDKMessage` union with `type` discriminator — `system`, `assistant`, `user`, `result`, `stream_event`, `tool_use_summary`.

## 6. Permission System (`src/utils/permissions/`)

**Permission modes:** `'default' | 'plan' | 'auto' | 'bypass'`

**Layered permission rules** (`ToolPermissionRulesBySource`):
- Sources: `command`, `settings`, `claudemd`, `hook`, `policySettings`
- Rule types: `alwaysAllow`, `alwaysDeny`, `alwaysAsk`
- Pattern matching via `preparePermissionMatcher()` — e.g. `Bash(git *)` matches `git push`

**Permission flow:**
1. Tool-level `validateInput()` — schema/context validation
2. `checkPermissions()` — tool-specific permission logic
3. General permission system (`permissions.ts`) — deny rules, allow rules, ask rules
4. Auto-mode classifier (`yoloClassifier.ts`) — ML-based auto-approve for safe operations
5. User prompt (interactive) or auto-deny (non-interactive)

**Denial tracking** (`denialTracking.ts`): counts consecutive denials, falls back to prompting after threshold.

## 7. Context & System Prompt (`src/context.ts`)

**Two context layers:**
- `getSystemContext()` — git status (branch, recent commits, status), memoized per session
- `getUserContext()` — CLAUDE.md content, current date, memoized per session

CLAUDE.md discovery: walks directory tree, loads `.claude/` files, respects `--bare` mode.

**System prompt assembly:**
```
defaultSystemPrompt + memoryMechanicsPrompt? + appendSystemPrompt?
  → prependUserContext(messages, userContext)  // injected before first user message
  → appendSystemContext(systemPrompt, systemContext)  // appended to system prompt
```

## 8. MCP Integration (`src/services/mcp/`)

- Config parsing from multiple sources (project, user, enterprise)
- stdio and SDK transports
- OAuth and XAA authentication paths
- Server connection manager with reconnection
- Tool/resource/command discovery
- `getMcpToolsCommandsAndResources()` — unified loader
- MCP tools merged into tool pool via `assembleToolPool()`

## 9. Multi-Agent / Subagent System

**AgentTool** (`src/tools/AgentTool/`):
- Spawns subagents with filtered tool sets
- Agent definitions loaded from `.claude/agents/` directory
- Built-in vs custom agents with different tool restrictions
- `createSubagentContext()` — forks context with no-op `setAppState` for async agents

**Teammate/Swarm system** (`src/utils/swarm/`):
- Backends: tmux, iTerm, in-process runners
- Permission sync across teammates
- Reconnection handling

**Coordinator mode** (feature-gated `COORDINATOR_MODE`):
- Multi-agent coordination with task assignment
- Workers get filtered tool sets

## 10. Streaming Architecture

**API streaming** via Anthropic SDK's streaming messages:
- `callModel()` yields `StreamEvent` messages as they arrive
- Events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- `StreamingToolExecutor` starts tool execution during streaming (before full response)
- Tombstone mechanism for orphaned messages during model fallback

**Generator composition:**
```
query() → yields StreamEvent | Message
  ↓
QueryEngine.submitMessage() → transforms to SDKMessage
  ↓  
print.ts or REPL.tsx → renders to terminal or yields to SDK consumer
```

## 11. Key Patterns Worth Stealing

### A. Async Generator Query Loop
The entire query loop is an async generator. This enables:
- Streaming results to multiple consumers (REPL, SDK, print)
- Clean cancellation via `abortController`
- State machine transitions without complex callback chains
- Composable recovery (each recovery path is just a `continue` with new state)

### B. Tool Concurrency Partitioning
Automatically batch concurrent-safe tools for parallel execution. Simple `isConcurrencySafe(input)` flag per tool, orchestrator handles batching.

### C. Immutable State Store
Dead-simple 40-line store with referential equality check. No framework needed. Functional updates with spread. Listeners for React integration.

### D. buildTool() Factory with Defaults
Fail-closed defaults (assume not concurrent, assume writes). Single factory function ensures all tools have consistent interface without boilerplate.

### E. Feature Flags via Build-Time Elimination
`bun:bundle` `feature()` in if/ternary conditions → dead code eliminated at build time. Conditional `require()` inside feature checks.

### F. Multi-Layer Context Management
Not one compaction strategy — five layers that compose: snip → microcompact → collapse → autocompact → reactive. Each handles different scenarios.

### G. Deferred Tool Loading
`ToolSearchTool` + `shouldDefer` flag — tools can be deferred from initial prompt to save tokens. Model uses ToolSearch to find tools by keyword when needed.

### H. Content Replacement State
Tool results exceeding `maxResultSizeChars` are persisted to disk with a preview sent to model. Prevents context window bloat from large outputs.

### I. Startup Parallelism
Fire-and-forget subprocess spawns at import time, `await` them just before they're needed. Deferred prefetches after first render.

### J. Prompt Cache Stability
Tools sorted with built-ins as contiguous prefix, MCP tools as suffix. Content-hash temp file paths instead of random UUIDs to avoid cache busting.

## 12. File Index

| File | Purpose |
|------|---------|
| `src/main.tsx` | Entry point, CLI setup, 4,684 lines |
| `src/Tool.ts` | Tool interface + buildTool factory |
| `src/tools.ts` | Tool registry, assembly, filtering |
| `src/query.ts` | Core agentic query loop (async generator) |
| `src/QueryEngine.ts` | SDK/headless query lifecycle manager |
| `src/context.ts` | System/user context (git, CLAUDE.md) |
| `src/state/store.ts` | 40-line Zustand-style store |
| `src/state/AppStateStore.ts` | Monolithic app state type |
| `src/services/tools/toolOrchestration.ts` | Concurrent/serial tool batching |
| `src/services/tools/StreamingToolExecutor.ts` | Stream-time tool execution |
| `src/services/tools/toolExecution.ts` | Individual tool execution |
| `src/services/compact/` | Multi-layer compaction |
| `src/utils/permissions/` | Permission system (14 files) |
| `src/services/mcp/` | MCP protocol integration |
| `src/tools/AgentTool/` | Subagent spawning |
| `src/utils/swarm/` | Multi-agent teammate system |
| `src/bootstrap/state.ts` | Session-scoped global state |
