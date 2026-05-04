# OpenClaw Architecture Analysis

**Date:** 2026-04-04  
**Source:** `/home/node/.openclaw/workspace/projects/CrewHaurness/openclaw/src/`  
**Stats:** ~5,298 TypeScript files total, ~2,099 non-test files

---

## 1. Directory Structure (Top-Level)

```
src/
├── acp/                  # Agent Control Plane - session management, policy, spawning
├── agents/               # Core agent runtime (~280 non-test files) - THE BEAST
│   ├── auth-profiles/    # Multi-provider auth management
│   ├── cli-runner/       # CLI backend execution
│   ├── command/          # Command handling
│   ├── pi-embedded-helpers/  # Embedded agent helpers
│   ├── pi-embedded-runner/   # Embedded runner (skills, sandbox)
│   ├── skills/           # Skill loading and management
│   └── bash-tools.*      # Shell execution tooling
├── auto-reply/           # Heartbeat tokens, thinking modes
├── bindings/             # Session-channel bindings
├── bootstrap/            # First-run bootstrap
├── canvas-host/          # Canvas UI hosting
├── channels/             # Channel adapters (Telegram, Discord, etc.)
│   ├── plugins/          # Per-channel plugin implementations (~100 files)
│   ├── transport/        # Transport layer (stall watchdog)
│   └── web/              # Web channel
├── chat/                 # Chat message handling
├── cli/                  # CLI program, commands, arg parsing
├── commands/             # Slash commands
├── config/               # Configuration loading & schema
├── context-engine/       # Pluggable context management (7 files)
├── cron/                 # Cron/scheduled jobs system
│   ├── isolated-agent/   # Isolated agent for cron runs
│   └── service/          # Cron service ops, state
├── daemon/               # Daemon process management
├── flows/                # Multi-step flows
├── gateway/              # Gateway server (HTTP + WebSocket)
│   ├── server/           # Server implementation internals
│   ├── server-methods/   # RPC method handlers
│   └── protocol/         # Wire protocol
├── hooks/                # Plugin hooks system
├── i18n/                 # Internationalization
├── image-generation/     # Image gen tooling
├── infra/                # Infrastructure utilities (env, errors, git)
├── link-understanding/   # URL content extraction
├── logging/              # Structured logging
├── markdown/             # Markdown processing
├── mcp/                  # Model Context Protocol integration
├── media/                # Media handling
├── media-understanding/  # Image/media analysis
├── node-host/            # Node (device) hosting
├── pairing/              # Device pairing
├── plugin-sdk/           # Plugin SDK for third parties
├── plugins/              # Plugin system (~200+ files) - providers, hooks, capabilities
├── process/              # Process management (exec, child processes)
├── routing/              # Session routing, key resolution
├── secrets/              # Secret management
├── security/             # Security policies, sandboxing
├── sessions/             # Session ID, lifecycle, transcripts
├── shared/               # Shared utilities
├── tasks/                # Task management
├── terminal/             # Terminal UI
├── tts/                  # Text-to-speech
├── tui/                  # Terminal UI components
├── types/                # Shared type definitions
├── utils/                # General utilities
├── web-search/           # Web search implementations
├── wizard/               # Setup wizard
├── entry.ts              # Main CLI entry point
├── index.ts              # Library entry point
├── runtime.ts            # Runtime exports
└── global-state.ts       # Process-global singletons
```

---

## 2. Entry Points & Boot Flow

### CLI Entry (`entry.ts`)
1. Sets `process.title = "openclaw"`
2. Installs warning filters, process handlers
3. Handles `--version` and `--help` fast paths
4. Parses `--profile` and `--container` args
5. Delegates to `cli/run-main.js` → `runCli(argv)`

### Library Entry (`index.ts`)
- When imported (not main): lazily loads `library.ts` exports
- When main: runs `runLegacyCliEntry()` (backwards compat)

### Gateway Server (`gateway/server.ts` → `server.impl.ts`)
- HTTP + WebSocket server
- Routes: auth, chat, channels, cron, sessions, node events, plugins, models, control UI
- Re-exports `startGatewayServer()`

---

## 3. Tool System

### Tool Catalog (`agents/tool-catalog.ts`)
Tools are defined in a static `CORE_TOOL_DEFINITIONS` array with metadata:

**Core Tools (31 tools):**

| Section | Tools |
|---------|-------|
| **Files** | `read`, `write`, `edit`, `apply_patch` |
| **Runtime** | `exec`, `process`, `code_execution` |
| **Web** | `web_search`, `web_fetch`, `x_search` |
| **Memory** | `memory_search`, `memory_get` |
| **Sessions** | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status` |
| **UI** | `browser`, `canvas` |
| **Messaging** | `message` |
| **Automation** | `cron`, `gateway` |
| **Nodes** | `nodes` |
| **Agents** | `agents_list` |
| **Media** | `image`, `image_generate`, `tts` |

### Tool Profiles
Four profiles control which tools are available:
- **minimal**: `session_status` only
- **coding**: fs + runtime + web + memory + sessions + cron + image
- **messaging**: `sessions_list`, `sessions_history`, `sessions_send`, `session_status`, `message`
- **full**: all tools (no filter)

### Tool Registration
- Tools registered via `CORE_TOOL_DEFINITIONS` static array
- Plugin tools added via `externalToolSummaries` map at prompt-build time
- Tool groups: `group:openclaw`, `group:fs`, `group:runtime`, etc.
- Tool invocation: routed through gateway server methods and `bash-tools.exec.ts` for shell commands

### Tool Implementation Files (in `agents/`)
- `bash-tools.ts` / `bash-tools.exec.ts` — Shell execution (exec/process tools)
- `bash-tools.process.ts` — Background process management
- `channel-tools.ts` — Message sending tool
- `tool-catalog.ts` — Tool metadata and profiles
- `tool-display.ts` — Tool result formatting
- `tool-images.ts` — Image handling in tool results
- `tool-fs-policy.ts` — File system access policies
- `tool-loop-detection.ts` — Prevents tool call loops

---

## 4. System Prompt & Context Injection

### System Prompt (`agents/system-prompt.ts` — 720 lines)
The `buildAgentSystemPrompt()` function assembles the full system prompt. **This is the single biggest token overhead source.**

**Sections injected (in order):**
1. Identity line: "You are a personal assistant running inside OpenClaw."
2. **Tooling** — Tool list with summaries, tool call style guidance, exec approval guidance
3. **Safety** — Anthropic-inspired safety rules
4. **Skills** — Available skills list with scan instructions
5. **Memory** — Memory tool guidance (if available)
6. **Authorized Senders** — Owner identity (hashed or raw)
7. **Reply Tags** — `[[reply_to_current]]` instructions
8. **Messaging** — Cross-session, message tool, inline buttons guidance
9. **Voice/TTS** — TTS hints
10. **Documentation** — Docs path and links
11. **Current Date & Time** — Timezone info
12. **Workspace** — Working directory info
13. **Workspace Files** — Injected context files (AGENTS.md, TOOLS.md, etc.)
14. **Runtime** — Agent/host/model/channel metadata
15. **Reasoning** — Thinking mode hints
16. **Model Aliases** — Model switching instructions
17. **Reactions** — Emoji reaction guidance
18. **Extra System Prompt** — User-configured additions

### Bootstrap Files (`agents/bootstrap-files.ts`)
Context files loaded at session start:
- `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, `HEARTBEAT.md`, `MEMORY.md`
- Filtered per-session (subagents get less)
- Budget-limited with truncation warnings
- Cached in `bootstrap-cache.ts`

### Context Engine (`context-engine/`)
Pluggable system for managing conversation context:

```typescript
interface ContextEngine {
  bootstrap(params)     // Initialize for session
  maintain(params)      // Post-turn maintenance
  ingest(params)        // Add single message
  ingestBatch(params)   // Add message batch
  afterTurn(params)     // Post-turn lifecycle
  assemble(params)      // Build model context under token budget
  compact(params)       // Reduce token usage (summarization)
  prepareSubagentSpawn  // Setup for child agents
  onSubagentEnded       // Cleanup after child
  dispose()             // Cleanup
}
```

- Registry: process-global singleton (`Symbol.for("openclaw.contextEngineRegistryState")`)
- Default engine: "legacy" (resolved via plugin slots)
- Session key compat: massive Proxy wrapper for backwards compatibility with old engines that don't accept `sessionKey` param (~200 lines of compat code)
- Resolution: `config.plugins.slots.contextEngine` → default slot → factory → wrap with compat

### Token Overhead Analysis
**Estimated system prompt size: 3,000-5,000+ tokens per turn** depending on config:
- Tool list + summaries: ~800 tokens
- Tool call style + safety: ~400 tokens  
- Messaging section: ~300 tokens
- Workspace files (AGENTS.md, TOOLS.md): ~2,000-10,000+ tokens (user-dependent)
- Runtime info: ~100 tokens
- Skills list: ~200 tokens
- Reply tags, reactions, voice, docs: ~300 tokens

---

## 5. Skill System

### Architecture (`agents/skills/`)
- **Location:** Skills live in `<workspace>/skills/<skill-name>/SKILL.md`
- **Loading:** `local-loader.ts` — scans skill directories, reads `SKILL.md` files
- **Frontmatter:** YAML frontmatter in SKILL.md defines metadata (name, description, invocation policy)
- **Bundled skills:** `bundled-dir.ts`, `bundled-context.ts` — pre-packaged skills
- **Plugin skills:** `plugin-skills.ts` — skills from installed plugins
- **Filtering:** `filter.ts` — per-session skill filtering
- **Serialization:** `serialize.ts` — skills serialized into the system prompt as `<available_skills>` block

### Skill Invocation Pattern
1. System prompt includes list of available skills with descriptions
2. Agent scans skill descriptions before each reply
3. If a skill matches, agent reads `SKILL.md` via the `read` tool
4. Agent follows instructions in SKILL.md
5. **Lazy loading** — skill content is NOT included in system prompt, only names/descriptions

### Token Impact
- Skill list in system prompt: ~50-200 tokens (just names + descriptions)
- Full SKILL.md read: charged as tool use (1 tool call + file content)
- This is efficient — avoids bloating system prompt with all skill content

---

## 6. Cron / Heartbeat System

### Cron Service (`cron/service.ts`)
- `CronService` class wrapping stateful `ops` module
- Operations: start, stop, status, list, add, update, remove, run, enqueueRun, wake
- Jobs stored in `CronStoreFile` (JSON, version 1)

### Schedule Types (`cron/types.ts`)
```typescript
CronSchedule = 
  | { kind: "at"; at: string }          // One-shot
  | { kind: "every"; everyMs: number }   // Interval
  | { kind: "cron"; expr: string; tz? }  // Cron expression
```

### Session Targets
- `"main"` — run in main session
- `"isolated"` — isolated agent session
- `"current"` — current session
- `"session:<key>"` — specific session

### Delivery System
- Modes: `none`, `announce`, `webhook`
- Channel routing: any configured channel or `"last"`
- Failure alerts with cooldown
- Delivery status tracking (delivered/not-delivered/unknown)

### Heartbeat Flow
1. Heartbeat is a special cron job with `kind: "systemEvent"` payload
2. `heartbeat-policy.ts` — determines if heartbeat output should be delivered or suppressed
3. `HEARTBEAT_OK` token — agent returns this when nothing needs attention
4. Heartbeat delivery is skipped if output is just `HEARTBEAT_OK` (via `shouldSkipHeartbeatOnlyDelivery`)

### Isolated Agent Execution (`cron/isolated-agent/`)
- Full isolated agent run for cron jobs
- Auth profile propagation from parent
- Model formatting, lane management
- Session reaper for cleanup

### Token Impact
- Each heartbeat costs a full turn: system prompt + bootstrap files + heartbeat prompt
- `HEARTBEAT_OK` suppression saves delivery costs but not inference costs
- Lightweight context mode (`lightContext: true`) reduces bootstrap to just `HEARTBEAT.md`

---

## 7. Channel System

### Registry (`channels/registry.ts`)
- Channels registered as plugins via `getActivePluginRegistry().channels`
- Normalization: `normalizeChannelId()` and `normalizeAnyChannelId()`
- Built-in channel IDs defined in `channels/ids.ts`

### Channel Plugin Architecture (`channels/plugins/`)
~100+ files covering:
- **Plugin types** (`types.ts`, `types.core.ts`, `types.plugin.ts`, `types.adapters.ts`)
- **Binding system** — channels bind to sessions via conversation bindings
- **Setup wizards** — per-channel setup flows (`setup-wizard.ts`)
- **Message actions** — reactions, edits, deletes (`message-actions.ts`)
- **Directory adapters** — contact/group resolution (`directory-adapters.ts`)
- **Pairing** — device pairing for mobile channels (`pairing.ts`, `pairing-adapters.ts`)
- **Media** — per-channel media limits and payloads (`media-limits.ts`, `media-payload.ts`)

### Channel Features
- **Draft stream controls** — streaming responses with edit-in-place
- **Typing lifecycle** — typing indicators
- **Mention gating** — respond only when mentioned
- **Allowlists** — per-channel sender allowlists
- **Model overrides** — per-channel model selection
- **Inbound debounce** — batching rapid messages
- **Thread bindings** — thread-per-conversation support

### Channel Configuration
- Channels configured in `openclaw.yaml` under `channels:` section
- Channel config schema validated at `channels/plugins/config-schema.ts`
- Runtime channel detection via `runtimeInfo.channel`

### Supported Channels (inferred from code)
- Telegram, Discord, Slack, WhatsApp, Signal, BlueBubbles, Web
- Each has its own plugin in `channels/plugins/` (bundled via `bundled.ts`)

---

## 8. What Works Well

1. **Skill system (lazy loading)** — Only skill descriptions in system prompt; full content loaded on-demand. Efficient.
2. **Context engine pluggability** — Clean interface, registry pattern, factory-based creation. Good extensibility.
3. **Tool catalog with profiles** — Clean separation of tool availability per use case.
4. **Cron delivery system** — Rich delivery options with failure handling and cooldown.
5. **Bootstrap file caching** — Avoids re-reading workspace files on every turn.
6. **Plugin architecture** — Consistent patterns for channels, providers, hooks.
7. **Session key routing** — Clean routing to main/isolated/subagent sessions.

---

## 9. What's Wasteful (Token-Wise)

### Critical Token Sinks
1. **System prompt bloat (~3K-5K+ tokens baseline)**
   - `system-prompt.ts` (720 lines) generates massive prompt every turn
   - Includes messaging guidance, reply tags, exec approval guidance, reaction guidance even when irrelevant
   - Tool summaries repeated every turn (never changes within session)

2. **Workspace files injected every turn**
   - `AGENTS.md` is enormous (the one in this workspace is ~8KB+)
   - `TOOLS.md` grows unbounded as notes accumulate
   - These are re-injected as system prompt content on every single turn
   - No diff/delta mechanism — full content every time

3. **Context engine compat layer** (`context-engine/registry.ts`)
   - ~200 lines of Proxy-based backwards compat for `sessionKey`/`prompt` params
   - Every method call goes through error-catch-retry-strip logic
   - Runtime overhead per context engine call

4. **Heartbeat token cost**
   - Full system prompt + bootstrap even for "nothing to do" heartbeats
   - Lightweight mode helps but isn't default

5. **Channel-specific guidance in system prompt**
   - Reply tags section (~100 tokens) sent even when channel doesn't support it
   - Messaging section (~300 tokens) sent even for coding-only sessions

### Moderate Waste
6. **Tool descriptions embedded in system prompt text**
   - Model providers support native tool descriptions, but OpenClaw also puts them in system prompt prose
   - Double-counting tool information

7. **Safety section repeated every turn**
   - Static content (~400 tokens) that never changes
   - Could be cached at the provider level

---

## 10. Pain Points

1. **`agents/` directory is monolithic** — 280+ non-test files in one directory. Navigation nightmare.

2. **system-prompt.ts is a god function** — 720 lines, single function builds entire prompt. Hard to test individual sections, hard to optimize selectively.

3. **No clear separation between "framework" and "application"** — config, channels, tools, agents all tightly coupled.

4. **Plugin system complexity** — `plugins/` has 200+ files. Registration, discovery, hooks, providers, capabilities all interleaved.

5. **Gateway server sprawl** — `gateway/` has 150+ files covering auth, channels, chat, cron, sessions, nodes, plugins, models. Each concern is a separate file but they're all in one directory.

6. **Test file proliferation** — ~3,200 test files (60% of codebase). Tests are co-located in same directories, making navigation harder.

7. **Legacy compat cruft** — session key compat proxy, auth profile migration, startup matrix migration, legacy CLI entry, backward-compat aliases throughout.

8. **No token budget awareness in system prompt** — System prompt is built without knowing how much budget remains for actual conversation context. Bootstrap budget analysis exists (`bootstrap-budget.ts`) but only for workspace files, not the prompt itself.

---

## 11. Key Architectural Patterns

### Process-Global Singletons
```typescript
const STATE = Symbol.for("openclaw.contextEngineRegistryState");
const state = resolveGlobalSingleton(STATE, () => ({ engines: new Map() }));
```
Used for: context engine registry, plugin registry, global state.

### Plugin Registration
```typescript
registerContextEngine(id, factory)     // → registered in global map
getActivePluginRegistry().channels     // → channel plugins
```

### Session Identity
```
agent:<agentId>:main                   // Main session
agent:<agentId>:subagent:<uuid>        // Subagent
agent:<agentId>:cron:<jobId>           // Cron job
```

### Config-Driven Everything
All behavior configured via `openclaw.yaml`:
- Channels, agents, tools, skills, cron, auth, models, hooks, plugins

---

## 12. Files to Study Further

| Area | Key Files |
|------|-----------|
| System prompt assembly | `agents/system-prompt.ts` (720 lines) |
| Tool execution | `agents/bash-tools.exec.ts`, `agents/bash-tools.process.ts` |
| Agent runner | `agents/pi-embedded-runner.ts`, `agents/pi-embedded.ts` |
| Context assembly | `context-engine/legacy.ts`, `agents/compaction.ts` |
| Gateway core | `gateway/server.impl.ts`, `gateway/server-chat.ts` |
| Cron execution | `cron/service/ops.ts`, `cron/isolated-agent.ts` |
| Channel plugins | `channels/plugins/bundled.ts`, `channels/plugins/registry.ts` |
| Config schema | `config/config.ts` |
| Session management | `acp/session.ts`, `sessions/session-id.ts` |

---

## 13. Recommendations Summary

### Keep
- Context engine interface (clean, pluggable)
- Skill lazy-loading pattern
- Tool catalog with profiles
- Cron service architecture
- Plugin SDK approach

### Fix
- System prompt: break into composable sections, add token budget awareness
- Bootstrap files: implement delta/caching at provider cache level
- Agent directory: split into sub-domains (tools/, context/, auth/, runner/)
- Heartbeat: default to lightweight context mode

### Drop
- Context engine sessionKey compat proxy (200 lines of legacy compat)
- Redundant tool descriptions (in both system prompt prose and native tool schemas)
- Channel-specific prompt sections when not relevant to current channel
- Static safety section repetition (use provider system caching)
