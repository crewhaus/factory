# @crewhaus/memory-service

The **composition root of the CrewHaus memory fabric** (v0.3.0 design §1
principle 1, module catalog critical-path #2). Every consumer — compiled
bundles, the `crewhaus run` interpreter, and (PR 13) sub-agent bridges —
makes one stable call instead of templating store/tool/seam wiring per
emitter:

```ts
import { wireMemory } from "@crewhaus/memory-service";
import { defaultCatalog } from "@crewhaus/tool-catalog";
import { runChatLoop } from "@crewhaus/runtime-core";

const wired = await wireMemory(
  { specName: "support-bot", memory: { autoRecall: true }, continuity: {} },
  { catalog: defaultCatalog, cwd: process.cwd() },
);

await runChatLoop({
  model, instructions,
  tools: defaultCatalog.list(),
  ...wired.options, // memory + continuity seams, skills, slash commands
});
```

Before this package, `renderMemory` codegen lived only in target-cli and the
"keep in sync" mirrors in other emitters were fiction; extending memory to 14
target shapes under that pattern would have multiplied the duplication.
Emitters now emit **one line** (typed IR in, one call out — Pillar 1) and
runtime-core stays store-free (injected closures via `RunChatLoopOptions`,
the #53 inverted-DI pattern). Every future memory feature lands here, not in
codegen.

## The map of the memory fabric

The 0.3.0 memory stack is a tiered, externalized, provenance-carrying hybrid
(design §0). This package is where the tiers meet; each lives in its own
module:

| Tier | Package | Storage | Tools | Runtime seam |
|---|---|---|---|---|
| Episodic facts | [`@crewhaus/memory-store`](../memory-store) (v2: TTL, supersede tombstones, hybrid BM25+embedding recall, provenance) | `.crewhaus/memories/<spec>.jsonl` | `Remember` / `Recall` / `MemoryForget` (via [`@crewhaus/tool-memory`](../tool-memory)) | `options.memory` — autoRecall injection + provenance-stamping auto-capture |
| Working memory | [`@crewhaus/continuity-store`](../continuity-store) (focus, REQ ledger, plans with the claimed→proven proof ladder, goals, handoff, trash/restore) | `.crewhaus/state/<spec>/` | `FocusRead/FocusWrite`, `PlanRead/PlanUpdate/PlanComplete`, `GoalWrite/GoalUpdate/GoalList`, `MemoryClear` (via [`@crewhaus/tool-plan`](../tool-plan)) | `options.continuity` — `loadPlan`/`onPlanDirty` (the §2.5 mutable tail), the §2.3 `ledger` flag, `onHandoff` |
| Semantic knowledge | [`@crewhaus/wiki-store`](../wiki-store) (versioned articles, supersede-never-delete, optimistic concurrency, one-hop link expansion) | `.crewhaus/wiki/<spec>/` | the ten thredz-vocabulary `wiki_*` tools (via [`@crewhaus/tool-wiki`](../tool-wiki)) | tools only (wiki auto-recall threads in PR 11) |
| Model discipline | [`@crewhaus/default-skills`](../default-skills) | compile-time-embedded SKILL.md / command bodies | — | `options.skills` / `options.slashCommands`, merged at lowest precedence |

Consumers: [`@crewhaus/target-cli`](../target-cli) emits the call into
compiled bundles; `apps/cli`'s `crewhaus run` makes the identical call on the
interpreter path. [`@crewhaus/runtime-core`](../runtime-core) consumes the
seams without ever importing a store.

## `wireMemory(fragment, deps)`

### The fragment

A **serializable** description of what to wire — emitters embed it as a JSON
literal; the interpreter builds it with `memoryFragmentFromIr(ir)`. It is the
shape the future `IrMemory`/`IrContinuity` (design §9) lower into; PR 11 owns
that threading, so nothing here imports `@crewhaus/ir`.

```ts
type MemoryWiringFragment = {
  specName: string;
  memory?: {
    enabled?: boolean;             // block presence implies true
    backend?: "file" | "thredz";  // "thredz" reserved — fails fast until PR 16
    ttlMs?: number;                // TTL stamped on auto-captured facts (§3.4)
    autoCapture?: boolean;
    autoCaptureThreshold?: number;
    autoRecall?: boolean;
    recallK?: number;
    wiki?: {
      enabled?: boolean;
      embedder?: string;           // embedder factory grammar, e.g. "mock/deterministic"
      requireSources?: boolean;    // §3.3 write governance (the learning: lowering sets it)
    };
  };
  continuity?: {
    enabled?: boolean;
    plan?: boolean;                // false ⇒ only FocusRead/FocusWrite + MemoryClear
    ledger?: boolean;              // §2.3 requirements ledger flag
    handoff?: boolean;             // deterministic teardown handoff.md
    scope?: "spec" | "session";   // "auto" is resolved by the compiler, not here
    focusMaxChars?: number;
  };
};
```

The fragment carries **only knobs this root actually wires** — no dead
config. §9 fields whose engines land later join with their PRs: `dream`
(PR 14), wiki `recallK`/`autoRecall` and continuity `proof: require|off`
(PR 11), `backend: "thredz"` implementations (PR 16).

### The deps

```ts
type WireMemoryDeps = {
  catalog: { register(tool: RegisteredTool): void }; // defaultCatalog, or a shim
  cwd: string;                    // stores live under <cwd>/.crewhaus/
  tenant?: Tenant;                // §2.7 — re-roots + fences every store
  sessionScope?: string;          // session id for continuity scope "session"
  appendEvent?: (e: ContinuityEvent | WikiEvent) => void | Promise<void>;
  embedder?: { embed(texts) };    // beats memory.wiki.embedder
  log?: (line: string) => void;   // "[memory] …" status lines (interpreter)
  homeDir?: string;               // skill/command discovery override (tests)
  now?: () => Date;
};
```

### The output

```ts
type WiredMemory = {
  stores: { memory?, continuity?, wiki? };  // for CLI verbs, tests, dream ticks
  tools: RegisteredTool[];                  // everything registered, in order
  options: {                                // spread into runChatLoop(...)
    memory?; continuity?; skills?; slashCommands?;
  };
};
```

`options` keys exist only for wired features, so the spread never clobbers a
caller's own `skills`/`slashCommands` unless continuity took ownership of
them (in which case they are the FULL merged set — builtins at lowest
precedence, then `~/.crewhaus`, then `<cwd>/.crewhaus` — and replace the
caller's own discovery).

## Granular entry points

`wireContinuity(fragment, deps)` and `wireWiki(fragment, deps)` expose the
individual slices (returning `null` when their block is absent/disabled) for
callers that need only one tier — e.g. a dream tick that wants the stores
without the chat-loop seams. `wireMemory` composes them and additionally:

- routes `log_knowledge_gap` into the plan store as a `[gap]` goal when both
  wiki and continuity are wired (§3.2);
- assembles the skills/commands surface (the builtin `continuity` skill;
  `/plan /focus /next /handoff /clear-plan /clear-focus`, plus `/forget` when
  facts are on). `/study /reflect /exam /dream` stay out until their
  skills/engines are wired (PR 14/17).

## Scoping, tenancy, backends

- **Scope (§2.7):** `continuity.scope: "session"` nests working state under
  `<spec>/sessions/<sessionScope>/` (channel daemons get per-conversation
  focus). Facts and wiki stay spec-scoped always (§14.5).
- **Tenancy:** with `deps.tenant`, continuity/wiki construct under the tenant
  root with their own fail-closed path fencing; the fact store is created
  inside `<tenantRoot>/memories`. Commingling tenants' stores is a
  data-isolation bug, not a gap.
- **Backends (§4):** `backend: "file"` is implemented. `backend: "thredz"`
  is a reserved discriminator that fails fast with a clear error; PR 16
  flips it to Thredz-via-McpHost store implementations behind these same
  interfaces.

## Equivalence guarantees (the PR 10 refactor contract)

- Specs **without** a `memory:` block compile to **byte-identical** bundles
  (pinned by target-cli's emit tests + the smoke matrix's no-memory cli
  fixture).
- Specs **with** a `memory:` block keep behavioral equivalence with the
  retired inline codegen: same recall lines, same captured fact texts/tags,
  same seam flags (pinned by `src/equivalence.test.ts` and target-cli's
  emitted-fragment round-trip test). Two sanctioned upgrades, both from the
  design: `MemoryForget` is now registered alongside Remember/Recall (§3.4),
  and compiled bundles gain the provenance-stamping capture path the
  interpreter already had (§2.4).
