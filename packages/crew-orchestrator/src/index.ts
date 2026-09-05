/**
 * Catalog R10 `crew-orchestrator` — Section 22.
 *
 * Builds and runs a multi-role agent crew. Each role is its own
 * `runChatLoop`-backed agent; control passes between roles via
 * Section-22 primitives:
 *   - `Handoff` (`@crewhaus/agent-handoff`) for in-band baton-passes that
 *     stay in the same session (the receiver inherits the parent
 *     transcript via `resume`).
 *   - `SendMessage` (`@crewhaus/a2a-protocol`) for synchronous peer-to-
 *     peer queries that don't yield control.
 *
 * Trace topology: a single `RunContext` with one `TraceEventBus` is
 * shared across every role activation, so all spans nest under the same
 * `traceId`. `sendA2A` and `requestHandoff` annotate that bus with
 * `role_start` / `role_end` / `handoff` / `a2a_message` / `crew_done`
 * trace events. The same events also land on the JSONL `event-log` so
 * post-mortem replay can reconstruct the entire crew run.
 *
 * Refusal-loop guard: a `Handoff` chain that exceeds `refusalDepth`
 * (default 2) terminates with `HandoffRefusedError` rather than
 * looping forever.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type {
  CrewMailbox,
  SpawnSubAgentFn,
  SubAgentDefinition,
} from "@crewhaus/agent-context-isolation";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { CrewhausError } from "@crewhaus/errors";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import type { ModelProfile, RouteRule } from "@crewhaus/model-plan";
import { hasSideCallStrategy, wireSideCalls } from "@crewhaus/model-service";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import type { NamedFailureClass } from "@crewhaus/recovery-engine";
import { type RunContext, createRunContext, tagContent } from "@crewhaus/run-context";
import { type RunChatLoopOptions, runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type {
  A2AMessageEvent,
  CrewDoneEvent,
  HandoffEvent,
  RoleEndEvent,
  RoleStartEvent,
} from "@crewhaus/trace-event-bus";

import { createSendMessageA2ATool } from "@crewhaus/a2a-protocol";
import { createHandoffTool } from "@crewhaus/agent-handoff";

export class HandoffRefusedError extends CrewhausError {
  override readonly name = "HandoffRefusedError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

/**
 * Loop contract 0.4 (Batch A) — per-role extended-thinking selector.
 * IrThinking-shaped verbatim: exactly one of `budgetTokens` (explicit
 * Anthropic-style thinking budget) or `effort` (provider-preset tier,
 * converted through `EFFORT_THINKING_BUDGET_TOKENS` by the adapters).
 * Kept inline (no `@crewhaus/ir` dependency) exactly as the IR mirrors
 * runtime ids — keep the two in sync.
 */
export type RoleThinking =
  | { readonly budgetTokens: number }
  | { readonly effort: "low" | "medium" | "high" };

/** The pool option runtime-core accepts today (`RunChatLoopOptions.modelPool`). */
type RuntimeModelPool = NonNullable<RunChatLoopOptions["modelPool"]>;

/**
 * 0.6.0 §4.2 / §7.7 (PR 7b) — one candidate of a role's `model_pool` as the
 * role literal carries it: the routing identity runtime-core reads at boot
 * (`model` / `tags` / `enabled`) intersected with the per-candidate profile
 * settings the compiler lowers from a `$profile` (or inline) candidate —
 * `maxTokens`, `thinking`, `temperature`, `overlay`, `tools`, … (§4.1).
 * `@crewhaus/model-plan`'s `ModelProfile` is structurally the IR's
 * `IrModelPoolCandidate` by design (the compiler never imports it), so the
 * emitted `JSON.stringify(role.modelPool)` typechecks against this field
 * without a mirror to keep in sync — `@crewhaus/compiler` pins that
 * assignability at compile time (see the note under {@link RoleModelPool}).
 * runtime-core reads `model` / `tags` / `enabled` off a candidate today; the
 * per-candidate plan table that applies the rest lands with PR 9a, and
 * because the orchestrator forwards the candidate verbatim, nothing here
 * changes when it does.
 */
export type RoleModelPoolCandidate = RuntimeModelPool["candidates"][number] & ModelProfile;

/**
 * 0.6.0 §7.1 / §7.9 (PR 7b) — a role's `model_pool` as the role literal
 * carries it: runtime-core's pool option with per-candidate profiles
 * ({@link RoleModelPoolCandidate}), the scoped `routeKey` prefix and the
 * hybrid siblings the compiler lowers beside `routing` / `learning`.
 *
 * `scope` is the per-role arm namespace (§7.9): the spec may declare it, and
 * when it does not, `composeLoopTuning` stamps the ROLE NAME — the compiler
 * deliberately leaves `scope` unstamped at lower time so pre-0.6.0 pooled
 * role literals stay byte-identical, and the orchestrator is the caller that
 * knows which role a turn belongs to (the same name it already passes as
 * `toolsetScope`). The routing store keys arms by it from PR 10 on; until
 * then runtime-core ignores the key.
 *
 * `rules` is `@crewhaus/model-plan`'s `RouteRule` (its `evaluateRules` input,
 * §7.2.2). `classifier` / `strategy` / `reward` are opaque records here on
 * purpose: the orchestrator forwards them verbatim and never reads them, so
 * runtime-core's own option type is the single authority for their shape
 * once PRs 9b / 9d / 10 consume them — a second mirror would only drift.
 */
export type RoleModelPool = Omit<RuntimeModelPool, "candidates"> & {
  readonly candidates: ReadonlyArray<RoleModelPoolCandidate>;
  readonly scope?: string;
  readonly directives?: boolean;
  readonly rules?: ReadonlyArray<RouteRule>;
  readonly classifier?: Readonly<Record<string, unknown>>;
  readonly strategy?: Readonly<Record<string, unknown>>;
  readonly reward?: Readonly<Record<string, unknown>>;
};

/**
 * Compile-time pin (PR 7b): the widened pool stays a structural SUBTYPE of
 * what runtime-core accepts, so the `Partial<RunChatLoopOptions>` cast at
 * the two call sites never hides a shape the loop would reject. Test files
 * are excluded from `tsc -b`, which is why this lives in source: a drift in
 * either type fails this package's compile, not a generated bundle's run.
 * (The other direction — the IR's `IrModelPool` being assignable to this
 * type — is pinned in `@crewhaus/compiler`, the one package that legitimately
 * imports both `@crewhaus/ir` and `@crewhaus/model-plan`.)
 */
type AssertTrue<T extends true> = T;
type _RolePoolIsAcceptedByRuntime = AssertTrue<
  RoleModelPool extends RuntimeModelPool ? true : false
>;

export type RoleDefinition = {
  readonly model: string;
  readonly instructions: string;
  /** Per-role tools (in addition to the auto-injected Handoff + SendMessage). */
  readonly tools?: ReadonlyArray<RegisteredTool>;
  /** Override max tokens for this role's runChatLoop. Defaults to 2048. */
  readonly maxTokens?: number;
  /** Override single-turn behaviour. Defaults to true (one user→assistant turn per activation). */
  readonly singleTurn?: boolean;
  /** Loop contract 0.4 (Batch A) — extended-thinking selector forwarded to
   *  this role's turns (primary activations AND inline A2A peer turns). */
  readonly thinking?: RoleThinking;
  /** 0.6.0 §4.1 — sampling temperature forwarded to this role's turns
   *  (exclusive with `thinking` by spec construction). */
  readonly temperature?: number;
  /** Section 13 (Batch A, G34) — inline sub-agent definitions surfaced to
   *  this role's `Task` tool. Forwarded to the role's runChatLoop together
   *  with the run-level `spawnSubAgent` injection (see RunOptions). */
  readonly subAgents?: ReadonlyMap<string, SubAgentDefinition>;
  /**
   * 0.6.0 (PR 3, design §7.7) — per-role model routing, the runtime twins of
   * the spec's `roles.<r>.{model_fallbacks, circuit_breaker, model_tiers,
   * model_pool}`. `@crewhaus/target-crew` has emitted these onto the role
   * literal since 0.4 (item 9 / G37), but until 0.6.0 this type had no such
   * fields and `composeLoopTuning` never forwarded them, so per-role routing
   * was dead config: every role turn ran on `model` alone. They now ride the
   * same `composeLoopTuning` fragment as `thinking`/`subAgents` into BOTH the
   * primary activation and the inline A2A peer turn, so runtime-core builds
   * the failover chain / tier router / PolicyRouter per role exactly as it
   * does for a cli agent. Typed by indexing `RunChatLoopOptions` rather than
   * mirrored locally so the emitted literal is checked against what the
   * runtime actually accepts — a drift there fails this package's compile,
   * not a generated bundle's.
   *
   * 0.6.0 (PR 7b) — `modelPool` is the WIDENED pool ({@link RoleModelPool}):
   * each candidate carries its per-candidate profile settings (§4.2) and the
   * pool its scoped `routeKey` prefix (§7.9), so a `$profile` candidate on a
   * role reaches the role's turns with its settings intact instead of being
   * flattened to `{model, tags}`. `composeLoopTuning` stamps `scope` with the
   * role name when the spec declared none.
   */
  readonly modelFallbacks?: RunChatLoopOptions["modelFallbacks"];
  readonly circuitBreaker?: RunChatLoopOptions["circuitBreaker"];
  readonly modelTiers?: RunChatLoopOptions["modelTiers"];
  readonly modelPool?: RoleModelPool;
};

export type RouterArgs = {
  readonly input: string;
  readonly lastRole: string | undefined;
  readonly activation: number;
  /** Run-scoped passthrough for model-backed routers (`routing.kind: "llm"`):
   *  the run's session root, so a router's classify turn persists beside the
   *  crew session instead of the process-global default. */
  readonly sessionRootDir?: string;
  /** Test injection backdoor mirroring `RunOptions._adapter` — forwarded to
   *  the router each consult so a generated llm router's classify turn stays
   *  scriptable through the same seam as every role turn. */
  readonly _adapter?: ProviderAdapter;
};

/**
 * Routing decision, consulted after every role turn that queued no handoff.
 * Loop contract 0.4 (Batch A, G08) — may return a Promise so model-backed
 * routers (the generated `routing.kind: "llm"` classify turn) can await a
 * runChatLoop call; plain string returns keep working unchanged.
 */
export type RouterFn = (args: RouterArgs) => string | Promise<string>;

export type CrewEvent =
  | { kind: "role_start"; role: string; activation: number }
  | { kind: "role_end"; role: string; activation: number; output: string; durationMs: number }
  | { kind: "handoff"; from: string; to: string; reason: string; depth: number }
  | {
      kind: "a2a_message";
      from: string;
      to: string;
      payload: string;
      traceparent: string;
    }
  | {
      kind: "crew_done";
      finalRole: string;
      finalOutput: string;
      activations: number;
      durationMs: number;
    };

/**
 * Loop contract 0.4 (Batch A) — hard per-turn runtime ceilings (IrLimits-
 * shaped, minus the crew-only `crew` block whose caps map onto the dedicated
 * RunOptions fields). `maxToolIterations`/`maxConcurrentTools`/`contextLimit`
 * forward onto runtime-core's existing typed knobs; the remaining 0.4
 * enforcement knobs (`deadlineMs`/`turnTimeoutMs`/`modelCallTimeoutMs`/
 * `loopDetection`) ride the forward-compat spread in `composeLoopTuning`
 * until runtime-core's loop-contract options land.
 */
export type CrewLoopLimits = {
  readonly maxToolIterations?: number;
  readonly maxConcurrentTools?: number;
  readonly contextLimit?: number;
  readonly deadlineMs?: number;
  readonly turnTimeoutMs?: number;
  readonly modelCallTimeoutMs?: number;
  readonly loopDetection?: {
    readonly window?: number;
    readonly threshold?: number;
    readonly escalation?: "warn" | "justify" | "abort";
  };
};

export type RunOptions = {
  /** Permission mode for every role's runChatLoop. Default "default". */
  readonly permissionMode?: PermissionMode;
  /** Permission rules for every role's runChatLoop. Default builtin floor. */
  readonly permissionRules?: RuleSet;
  /** Item 23 — failure taxonomy for every role's runChatLoop. Default none (built-in classify). */
  readonly failureTaxonomy?: ReadonlyArray<NamedFailureClass>;
  /**
   * v0.3.0 PR 11 — crew-wide extra tools appended to EVERY role's tool set
   * (after the role's own tools, before the orchestrator-owned Handoff/
   * SendMessage pair). The memory fabric threads its Remember/Recall/Plan/
   * Goal/wiki tools here: roles share the spec-scoped stores — the plan IS
   * the coordination surface (design §2.7).
   */
  readonly extraTools?: ReadonlyArray<RegisteredTool>;
  /** 0.5.0 — per-role tools, merged AFTER the role's own tools and BEFORE the
   *  crew-wide {@link extraTools}. Keyed by role name; a role with no entry is
   *  unaffected.
   *
   *  The crew shape uses this for per-role Thredz vocabularies: each role's
   *  aliases live in its OWN `ToolCatalog`, so two roles may both own
   *  `wiki_write` without tripping the alias collision guard (which is
   *  per-catalog, not global). Doing the merge HERE rather than in codegen
   *  buys the A2A peer path for free and keeps `agent_<role>.ts` byte-stable. */
  readonly roleExtraTools?: Readonly<Record<string, ReadonlyArray<RegisteredTool>>>;
  /** 0.5.0 — per-role override of the {@link memory} seam, falling back to it
   *  when a role has no entry. Lets each role auto-recall from its own Thredz
   *  space instead of one crew-wide corpus. */
  readonly roleMemory?: Readonly<Record<string, RunOptions["memory"]>>;
  /** v0.3.0 PR 11 — the memory seam (auto-recall/auto-capture), threaded
   *  verbatim into every role's runChatLoop. Constructed by memory-service. */
  readonly memory?: RunChatLoopOptions["memory"];
  /** v0.3.0 PR 11 — the continuity seam (plan tail/ledger/handoff), threaded
   *  verbatim into every role's runChatLoop. Constructed by memory-service. */
  readonly continuity?: RunChatLoopOptions["continuity"];
  /** v0.3.0 PR 11 — skills advertised in every role's system prompt (the
   *  caller registers the matching Skill tool via `extraTools`). */
  readonly skills?: RunChatLoopOptions["skills"];
  /**
   * Loop contract 0.4 (Batch C, G11) — how a tool permission that resolves to
   * `ask` behaves on a role turn. Crew turns are single-turn by construction,
   * so there is never a stdin prompter: `"pause"` parks the run against
   * `approvals` below, `"deny"` keeps the pre-0.4 collapse-in-place. Left
   * undefined the runtime applies its own `"pause"` default — which still only
   * parks once a store is wired (it requires BOTH).
   */
  readonly askMode?: "pause" | "deny";
  /**
   * Loop contract 0.4 (Batch C, G11) — the pending-approval seam, threaded
   * verbatim into every role's runChatLoop. Crew-wide on purpose: one store
   * across all roles means an out-of-band grant resolves the park no matter
   * which role (or which role's A2A peer) raised the ask.
   */
  readonly approvals?: RunChatLoopOptions["approvals"];
  /** Cap on consecutive handoffs before HandoffRefusedError fires. Default 2. */
  readonly refusalDepth?: number;
  /** Cap on the total number of role activations. Default 16 — keeps runaway crews bounded. */
  readonly maxActivations?: number;
  /** Cap on A2A recursion depth (peer-asks-peer-asks-peer). Default 3. */
  readonly maxA2ADepth?: number;
  /**
   * Loop contract 0.4 (Batch A) — per-turn loop ceilings (spec `limits:`
   * minus the crew-only block), forwarded to EVERY role's runChatLoop.
   * The crew-LEVEL orchestration caps (`limits.crew`) map onto the
   * dedicated `maxActivations`/`refusalDepth`/`maxA2ADepth` options above
   * instead — they bound the orchestrator, not a single loop.
   */
  readonly limits?: CrewLoopLimits;
  /** Item 27 / loop contract 0.4 — run-level spend cap + degradation
   *  ladder, forwarded verbatim to every role's runChatLoop (the always-on
   *  cost meter accrues each role turn's spend against the same cap). */
  readonly budget?: RunChatLoopOptions["budget"];
  /** Section 11 / loop contract 0.4 — spec-declared lifecycle hooks,
   *  forwarded verbatim to every role's runChatLoop. */
  readonly hooks?: RunChatLoopOptions["hooks"];
  /** Section 13 (Batch A, G34) — sub-agent spawner injection, the same
   *  inverted-DI seam as runChatLoop's own option: codegen passes
   *  `spawnSubAgent` from `@crewhaus/sub-agent-spawner`; the orchestrator
   *  forwards it to every role turn so roles that declare `subAgents` can
   *  dispatch their `Task` tool. */
  readonly spawnSubAgent?: SpawnSubAgentFn;
  /** Optional stable session id; defaults to `runContext.sessionId`. */
  readonly sessionId?: string;
  /** Override session root dir. Defaults to runtime-core's default `.crewhaus/sessions`. */
  readonly sessionRootDir?: string;
  /** Test injection backdoor: scripted ProviderAdapter shared by every role. */
  readonly _adapter?: ProviderAdapter;
  /**
   * 0.6.0 (PR 3) — test injection backdoors for the per-role routing seams,
   * mirroring runtime-core's own (`_failoverAdapters` / `_tierAdapters` /
   * `_poolAdapters`, keyed by spec model string; `_scoreboard`, the pool's
   * reward store). Forwarded verbatim to every role turn beside `_adapter`
   * so a test can prove a role's `modelPool`/`modelTiers`/`modelFallbacks`
   * reach the loop without resolving real credentials or touching
   * `.crewhaus/routing`. Production callers leave all four undefined.
   */
  readonly _failoverAdapters?: RunChatLoopOptions["_failoverAdapters"];
  readonly _tierAdapters?: RunChatLoopOptions["_tierAdapters"];
  readonly _poolAdapters?: RunChatLoopOptions["_poolAdapters"];
  readonly _scoreboard?: RunChatLoopOptions["_scoreboard"];
  /** 0.6.0 PR 9d — test injection for a role's shadow / committee judge. */
  readonly _judgeAdapter?: ProviderAdapter;
};

export type RunnableCrew = {
  /** Yields `CrewEvent`s in temporal order; resolves the iterator when the crew is done. */
  run(input: string, opts?: RunOptions): AsyncIterable<CrewEvent>;
};

export type CrewBuilder = {
  addRole(name: string, def: RoleDefinition): CrewBuilder;
  setEntry(name: string): CrewBuilder;
  setRouting(router: RouterFn): CrewBuilder;
  /** Crew name surfaced in trace events + the persisted session record. */
  setName(name: string): CrewBuilder;
  compile(): RunnableCrew;
};

const DEFAULT_REFUSAL_DEPTH = 2;
const DEFAULT_MAX_ACTIVATIONS = 16;
const DEFAULT_MAX_A2A_DEPTH = 3;
const DEFAULT_MAX_TOKENS = 2048;

export function Crew(): CrewBuilder {
  const roles = new Map<string, RoleDefinition>();
  let entry: string | undefined;
  let router: RouterFn | undefined;
  let crewName = "(unnamed-crew)";

  const builder: CrewBuilder = {
    addRole(name, def) {
      if (!name || name.length === 0)
        throw new CrewhausError("config", "addRole requires a non-empty name");
      if (roles.has(name)) throw new CrewhausError("config", `role "${name}" already added`);
      roles.set(name, def);
      return builder;
    },
    setEntry(name) {
      if (!roles.has(name)) {
        throw new CrewhausError(
          "config",
          `setEntry: unknown role "${name}". Known: ${[...roles.keys()].join(", ") || "(none)"}`,
        );
      }
      entry = name;
      return builder;
    },
    setRouting(r) {
      router = r;
      return builder;
    },
    setName(n) {
      crewName = n;
      return builder;
    },
    compile() {
      if (roles.size === 0) {
        throw new CrewhausError("config", "Crew requires at least one role");
      }
      if (entry === undefined) {
        // Default: the first role added. Map preserves insertion order;
        // the size > 0 guard above proves there's a first key.
        const firstKey = roles.keys().next().value;
        if (firstKey === undefined) {
          throw new CrewhausError("config", "Crew requires at least one role");
        }
        entry = firstKey;
      }
      const compiled = compileCrew({ roles, entry, router, crewName });
      return compiled;
    },
  };
  return builder;
}

type CompileArgs = {
  roles: ReadonlyMap<string, RoleDefinition>;
  entry: string;
  router: RouterFn | undefined;
  crewName: string;
};

function compileCrew(args: CompileArgs): RunnableCrew {
  const roleNames = [...args.roles.keys()];
  return {
    run(input, opts = {}) {
      // Drive the crew via async-generator + queue: events emitted from
      // any control-flow point land in the iterator in temporal order.
      return driveCrew({ ...args, input, opts, roleNames });
    },
  };
}

async function* driveCrew(
  args: CompileArgs & { input: string; opts: RunOptions; roleNames: string[] },
): AsyncIterable<CrewEvent> {
  const refusalDepth = args.opts.refusalDepth ?? DEFAULT_REFUSAL_DEPTH;
  const maxActivations = args.opts.maxActivations ?? DEFAULT_MAX_ACTIVATIONS;
  const maxA2A = args.opts.maxA2ADepth ?? DEFAULT_MAX_A2A_DEPTH;

  const permissionMode: PermissionMode = args.opts.permissionMode ?? "default";
  // Item 23 — the spec-declared taxonomy applies to every role's runChatLoop
  // (same crew-wide scope as permissionMode/permissionRules).
  const failureTaxonomy =
    args.opts.failureTaxonomy !== undefined && args.opts.failureTaxonomy.length > 0
      ? args.opts.failureTaxonomy
      : undefined;
  // Always grant the orchestrator-owned tools (Handoff + SendMessage). Crew
  // bundles wire the user's spec rules under `yaml`; we add Handoff +
  // SendMessage allowances under `flag` so they apply regardless of the
  // user's mode + rule choices. Without this, "default" mode treats them
  // as "ask" and single-turn runChatLoop denies (no interactive prompter).
  const baseRules: RuleSet = args.opts.permissionRules ?? {
    ...emptyRuleSet,
    builtin: BUILTIN_DEFAULT_RULES,
  };
  const permissionRules: RuleSet = {
    ...baseRules,
    flag: [
      ...baseRules.flag,
      { type: "alwaysAllow", pattern: "Handoff", source: "flag" },
      { type: "alwaysAllow", pattern: "SendMessage", source: "flag" },
    ],
  };

  // Single RunContext shared across every role activation so the entire
  // crew nests under one traceId.
  const runContext: RunContext = createRunContext(
    args.opts.sessionId !== undefined ? { sessionId: args.opts.sessionId } : {},
  );

  // Open a single event-log handle for the crew session. Every role's
  // runChatLoop opens its own handle against the same path; the
  // append-sync-per-line guarantee on POSIX keeps interleaving safe.
  const eventLog: EventLog = await openEventLog(
    runContext.sessionId,
    args.opts.sessionRootDir !== undefined ? { rootDir: args.opts.sessionRootDir } : {},
  );

  const queue: CrewEvent[] = [];
  type NextResolver = (ev: CrewEvent | "done" | "error") => void;
  let resolveNext: NextResolver | null = null;
  let driveError: unknown;

  function push(ev: CrewEvent): void {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(ev);
    } else {
      queue.push(ev);
    }
  }

  // Mirror every CrewEvent onto the trace bus + JSONL event log so OTel
  // and post-mortem replay both see them.
  async function recordEvent(ev: CrewEvent): Promise<void> {
    const bus = runContext.eventBus;
    if (ev.kind === "role_start") {
      bus.publish({
        ...bus.envelope(),
        kind: "role_start",
        role: ev.role,
        activation: ev.activation,
      } satisfies RoleStartEvent);
      await eventLog.append({
        kind: "role_start",
        payload: { role: ev.role, activation: ev.activation },
      });
    } else if (ev.kind === "role_end") {
      bus.publish({
        ...bus.envelope(),
        kind: "role_end",
        role: ev.role,
        activation: ev.activation,
        finalMessageBytes: Buffer.byteLength(ev.output, "utf8"),
        durationMs: ev.durationMs,
      } satisfies RoleEndEvent);
      await eventLog.append({
        kind: "role_end",
        payload: {
          role: ev.role,
          activation: ev.activation,
          outputBytes: Buffer.byteLength(ev.output, "utf8"),
          durationMs: ev.durationMs,
        },
      });
    } else if (ev.kind === "handoff") {
      bus.publish({
        ...bus.envelope(),
        kind: "handoff",
        from: ev.from,
        to: ev.to,
        reason: ev.reason,
        depth: ev.depth,
      } satisfies HandoffEvent);
      await eventLog.append({
        kind: "handoff",
        payload: { from: ev.from, to: ev.to, reason: ev.reason, depth: ev.depth },
      });
    } else if (ev.kind === "a2a_message") {
      bus.publish({
        ...bus.envelope(),
        kind: "a2a_message",
        from: ev.from,
        to: ev.to,
        messageKind: "question",
        payloadBytes: Buffer.byteLength(ev.payload, "utf8"),
        traceparent: ev.traceparent,
      } satisfies A2AMessageEvent);
      await eventLog.append({
        kind: "a2a_message",
        payload: {
          from: ev.from,
          to: ev.to,
          payloadBytes: Buffer.byteLength(ev.payload, "utf8"),
          traceparent: ev.traceparent,
        },
      });
    } else if (ev.kind === "crew_done") {
      bus.publish({
        ...bus.envelope(),
        kind: "crew_done",
        finalRole: ev.finalRole,
        totalActivations: ev.activations,
        durationMs: ev.durationMs,
      } satisfies CrewDoneEvent);
      await eventLog.append({
        kind: "crew_done",
        payload: {
          finalRole: ev.finalRole,
          activations: ev.activations,
          durationMs: ev.durationMs,
        },
      });
    }
  }

  // Pending handoff state (set by `requestHandoff`, drained by drive loop).
  type PendingHandoff = { target: string; reason: string; context?: unknown };
  let pendingHandoff: PendingHandoff | undefined;
  let currentRoleName = args.entry;
  let a2aDepth = 0;

  // Track activation order and total activation count.
  let activations = 0;
  let lastAccessedFrom = "(none)";
  let firstTurn = true;
  let lastOutput = "";

  // Mailbox shared across every role's runChatLoop. The orchestrator
  // mutates `currentRoleName` between activations; tools observe it via
  // `currentRole()` to stamp envelopes.
  const mailbox: CrewMailbox = {
    knownRoles: args.roleNames,
    currentRole: () => currentRoleName,
    currentTraceparent: () => runContext.eventBus.currentTraceparent(),
    requestHandoff: (target, reason, context) => {
      // Validation duplicated here in case a tool with a stale config calls in.
      if (!args.roleNames.includes(target)) {
        throw new CrewhausError("runtime", `requestHandoff: unknown target "${target}"`);
      }
      if (target === currentRoleName) {
        throw new CrewhausError("runtime", "requestHandoff: cannot hand off to self");
      }
      pendingHandoff = { target, reason, ...(context !== undefined ? { context } : {}) };
    },
    sendA2A: async (toRole, payload) => {
      if (!args.roleNames.includes(toRole)) {
        throw new CrewhausError("runtime", `sendA2A: unknown target "${toRole}"`);
      }
      if (toRole === currentRoleName) {
        throw new CrewhausError("runtime", "sendA2A: cannot send to self");
      }
      if (a2aDepth >= maxA2A) {
        return `[A2A error] depth limit ${maxA2A} reached — refusing further peer calls`;
      }
      const traceparent = runContext.eventBus.currentTraceparent();
      const fromRole = currentRoleName;
      push({ kind: "a2a_message", from: fromRole, to: toRole, payload, traceparent });
      await recordEvent({ kind: "a2a_message", from: fromRole, to: toRole, payload, traceparent });

      const peerDef = args.roles.get(toRole);
      if (peerDef === undefined) {
        return `[A2A error] missing role definition for "${toRole}"`;
      }
      a2aDepth += 1;
      const savedRole = currentRoleName;
      currentRoleName = toRole;
      // Bracket the peer's inline `runChatLoop` with a2a_turn_start /
      // a2a_turn_end markers in the shared session log. A later role's
      // `replayMessageHistory` uses these to skip the peer's nested
      // user/assistant messages — otherwise the parent role's `tool_use`
      // (SendMessage) ends up separated from its `tool_result` by the
      // peer's seed + reply, and Claude API rejects the unpaired
      // `tool_use` on the next resume. These markers are internal to
      // replay; they bypass `recordEvent` (which only surfaces
      // user-visible CrewEvent kinds to the trace bus) and append
      // directly to the JSONL — mirroring sub-agent-spawner's pattern.
      await eventLog.append({
        kind: "a2a_turn_start",
        payload: { from: savedRole, to: toRole },
      });
      // Pillar 3 cross-agent boundary site — classify the sender-supplied
      // payload before it becomes the peer's seed, redacting on a malicious
      // verdict and tagging an allowed one (mirrors the handoff path).
      const safePayload = await classifyCrossAgentText(runContext, payload);
      try {
        const reply = await runChatLoop({
          model: peerDef.model,
          instructions: peerDef.instructions,
          runContext,
          sessionName: args.crewName,
          sessionTarget: "crew",
          // #405 — every role appends to ONE crew session log with its own
          // tools; scoping the toolset record per role is what keeps a
          // handoff from reading as "your capabilities changed".
          toolsetScope: toRole,
          ...(args.opts.sessionRootDir !== undefined
            ? { sessionRootDir: args.opts.sessionRootDir }
            : {}),
          singleTurn: true,
          seedMessages: [
            {
              role: "user",
              content: `[A2A from ${savedRole} → ${toRole}]\n\n${safePayload}`,
            },
          ],
          tools: composeRoleTools({
            role: toRole,
            roles: args.roleNames,
            roleTools: peerDef.tools ?? [],
            ...(args.opts.roleExtraTools?.[toRole] !== undefined
              ? { roleExtraTools: args.opts.roleExtraTools[toRole] }
              : {}),
            ...(args.opts.extraTools !== undefined ? { extraTools: args.opts.extraTools } : {}),
          }),
          permissionMode,
          permissionRules,
          ...(failureTaxonomy !== undefined ? { failureTaxonomy } : {}),
          // v0.3.0 — the memory fabric's seams/skills, crew-wide (§2.7).
          // 0.5.0 — except `memory`, which a role may override so it recalls
          // from its OWN Thredz space.
          ...((args.opts.roleMemory?.[toRole] ?? args.opts.memory) !== undefined
            ? { memory: args.opts.roleMemory?.[toRole] ?? args.opts.memory }
            : {}),
          ...(args.opts.continuity !== undefined ? { continuity: args.opts.continuity } : {}),
          ...(args.opts.skills !== undefined ? { skills: args.opts.skills } : {}),
          // Loop contract 0.4 (Batch C, G11) — a peer turn is as headless as a
          // primary activation, so it gets the same ask disposition + park
          // store. Omitting them here would let a tool the crew would have
          // parked for be silently denied just because a peer asked for it.
          ...(args.opts.askMode !== undefined ? { askMode: args.opts.askMode } : {}),
          ...(args.opts.approvals !== undefined ? { approvals: args.opts.approvals } : {}),
          // Loop contract 0.4 (Batch A) — run-level ceilings + the peer
          // role's own selectors, identical to a primary activation; the
          // cast is composeLoopTuning's documented forward-compat seam.
          // 0.6.0 (PR 7b) — the peer's pool is scoped to the PEER role.
          ...(composeLoopTuning(peerDef, args.opts, toRole) as Partial<RunChatLoopOptions>),
          ...composeSideCalls(peerDef, args.opts, toRole, args.crewName),
          installSigintHandler: false,
          maxTokens: peerDef.maxTokens ?? DEFAULT_MAX_TOKENS,
          crewMailbox: mailbox,
          // A2A is in-band: treat every call after the first as a resume
          // so the peer sees the prior crew transcript.
          ...(firstTurn ? {} : { resume: { sessionId: runContext.sessionId } }),
          ...composeAdapterSeams(args.opts),
        });
        firstTurn = false;
        return reply;
      } finally {
        // Close the bracket BEFORE restoring orchestrator state — the
        // marker must land in the log even if `runChatLoop` threw.
        await eventLog.append({
          kind: "a2a_turn_end",
          payload: { from: savedRole, to: toRole },
        });
        currentRoleName = savedRole;
        a2aDepth -= 1;
      }
    },
  };

  const t0 = performance.now();

  void (async () => {
    try {
      let messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: args.input },
      ];
      let consecutiveHandoffs = 0;

      while (true) {
        if (activations >= maxActivations) {
          throw new CrewhausError(
            "runtime",
            `crew exceeded maxActivations=${maxActivations}; last role was "${currentRoleName}"`,
          );
        }

        const def = args.roles.get(currentRoleName);
        if (def === undefined) {
          throw new CrewhausError("config", `unknown role "${currentRoleName}"`);
        }

        push({ kind: "role_start", role: currentRoleName, activation: activations });
        await recordEvent({ kind: "role_start", role: currentRoleName, activation: activations });

        // Reset pending handoff before each activation so the previous
        // role's request — already consumed — can't bleed in.
        pendingHandoff = undefined;

        const tStart = performance.now();
        const output: string = await runChatLoop({
          model: def.model,
          instructions: def.instructions,
          runContext,
          sessionName: args.crewName,
          sessionTarget: "crew",
          // #405 — see the A2A site: per-role scope, so a handoff between
          // roles with different tools is not reported as a toolset change.
          toolsetScope: currentRoleName,
          ...(args.opts.sessionRootDir !== undefined
            ? { sessionRootDir: args.opts.sessionRootDir }
            : {}),
          singleTurn: def.singleTurn ?? true,
          seedMessages: messages.map((m) => ({ role: m.role, content: m.content })),
          tools: composeRoleTools({
            role: currentRoleName,
            roles: args.roleNames,
            roleTools: def.tools ?? [],
            ...(args.opts.roleExtraTools?.[currentRoleName] !== undefined
              ? { roleExtraTools: args.opts.roleExtraTools[currentRoleName] }
              : {}),
            ...(args.opts.extraTools !== undefined ? { extraTools: args.opts.extraTools } : {}),
          }),
          permissionMode,
          permissionRules,
          ...(failureTaxonomy !== undefined ? { failureTaxonomy } : {}),
          // v0.3.0 — the memory fabric's seams/skills, crew-wide (§2.7).
          // 0.5.0 — except `memory`, which a role may override so it recalls
          // from its OWN Thredz space.
          ...((args.opts.roleMemory?.[currentRoleName] ?? args.opts.memory) !== undefined
            ? { memory: args.opts.roleMemory?.[currentRoleName] ?? args.opts.memory }
            : {}),
          ...(args.opts.continuity !== undefined ? { continuity: args.opts.continuity } : {}),
          ...(args.opts.skills !== undefined ? { skills: args.opts.skills } : {}),
          // Loop contract 0.4 (Batch C, G11) — headless ask disposition + the
          // park store, crew-wide. Kept out of composeLoopTuning: that
          // fragment mixes RUN-level ceilings with per-ROLE selectors, and
          // these two are neither — they are a run-wide policy every role
          // shares verbatim.
          ...(args.opts.askMode !== undefined ? { askMode: args.opts.askMode } : {}),
          ...(args.opts.approvals !== undefined ? { approvals: args.opts.approvals } : {}),
          // Loop contract 0.4 (Batch A) — run-level ceilings (limits/budget/
          // hooks/spawner) + this role's selectors (thinking/subAgents); the
          // cast is composeLoopTuning's documented forward-compat seam.
          // 0.6.0 (PR 7b) — this role's pool is scoped to this role.
          ...(composeLoopTuning(def, args.opts, currentRoleName) as Partial<RunChatLoopOptions>),
          // 0.6.0 PR 9d — this role's guide / shadow / committee closures.
          ...composeSideCalls(def, args.opts, currentRoleName, args.crewName),
          installSigintHandler: false,
          maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
          crewMailbox: mailbox,
          ...(firstTurn ? {} : { resume: { sessionId: runContext.sessionId } }),
          ...composeAdapterSeams(args.opts),
        });

        firstTurn = false;
        lastOutput = output;
        const durationMs = performance.now() - tStart;
        push({
          kind: "role_end",
          role: currentRoleName,
          activation: activations,
          output,
          durationMs,
        });
        await recordEvent({
          kind: "role_end",
          role: currentRoleName,
          activation: activations,
          output,
          durationMs,
        });

        activations += 1;

        // `pendingHandoff` is set by the `requestHandoff` closure during the turn
        // above. Control-flow analysis can't see that mutation, so it narrows the
        // variable to the pre-turn `undefined` reset; assert the declared shape back.
        const handoff = pendingHandoff as PendingHandoff | undefined;
        if (handoff !== undefined) {
          consecutiveHandoffs += 1;
          if (consecutiveHandoffs > refusalDepth) {
            throw new HandoffRefusedError(`handoff refused (depth=${consecutiveHandoffs})`);
          }
          const ho: HandoffEventInternal = {
            from: currentRoleName,
            to: handoff.target,
            reason: handoff.reason,
            ...(handoff.context !== undefined ? { context: handoff.context } : {}),
          };
          push({
            kind: "handoff",
            from: ho.from,
            to: ho.to,
            reason: ho.reason,
            depth: consecutiveHandoffs,
          });
          await recordEvent({
            kind: "handoff",
            from: ho.from,
            to: ho.to,
            reason: ho.reason,
            depth: consecutiveHandoffs,
          });
          lastAccessedFrom = ho.from;
          currentRoleName = ho.to;
          messages = await buildHandoffSeed(runContext, ho);
          continue;
        }

        // No pending handoff — optionally consult the routing function.
        // The default behaviour (no router) is to terminate after the
        // current role's `end_turn`. Awaited since 0.4 (G08): model-backed
        // routers return a Promise; plain string routers resolve untouched.
        if (args.router !== undefined) {
          const next = await args.router({
            input: output,
            lastRole: currentRoleName,
            activation: activations,
            ...(args.opts.sessionRootDir !== undefined
              ? { sessionRootDir: args.opts.sessionRootDir }
              : {}),
            ...(args.opts._adapter !== undefined ? { _adapter: args.opts._adapter } : {}),
          });
          if (next !== currentRoleName && args.roleNames.includes(next)) {
            consecutiveHandoffs = 0; // a router move is not a refusal
            push({
              kind: "handoff",
              from: currentRoleName,
              to: next,
              reason: "[router] move",
              depth: 0,
            });
            await recordEvent({
              kind: "handoff",
              from: currentRoleName,
              to: next,
              reason: "[router] move",
              depth: 0,
            });
            lastAccessedFrom = currentRoleName;
            currentRoleName = next;
            messages = [{ role: "user", content: output }];
            continue;
          }
        }

        // Crew done.
        const totalDuration = performance.now() - t0;
        push({
          kind: "crew_done",
          finalRole: currentRoleName,
          finalOutput: output,
          activations,
          durationMs: totalDuration,
        });
        await recordEvent({
          kind: "crew_done",
          finalRole: currentRoleName,
          finalOutput: output,
          activations,
          durationMs: totalDuration,
        });
        break;
      }
    } catch (err) {
      driveError = err;
    } finally {
      await eventLog.close().catch(() => {});
      // `resolveNext` is set by the consumer's Promise executor (a sibling closure);
      // CFA narrows it to the initial `null` inside this drive loop, so assert the
      // declared resolver-or-null shape back before draining it.
      const pending = resolveNext as NextResolver | null;
      if (pending) {
        resolveNext = null;
        pending(driveError !== undefined ? "error" : "done");
      } else {
        // Mark sentinel by pushing a synthetic terminal so the consumer
        // exits the loop on next iteration.
        queue.push(SENTINEL_DONE);
      }
    }
    void lastAccessedFrom; // referenced for diagnostics; silence unused
    void lastOutput;
  })();

  while (true) {
    if (queue.length > 0) {
      const ev = queue.shift();
      if (ev === undefined) continue;
      if (ev === (SENTINEL_DONE as unknown as CrewEvent)) {
        if (driveError !== undefined) throw driveError;
        return;
      }
      yield ev;
      continue;
    }
    const next = await new Promise<CrewEvent | "done" | "error">((resolve) => {
      resolveNext = resolve;
    });
    if (next === "done") return;
    if (next === "error") {
      if (driveError !== undefined) throw driveError;
      return;
    }
    yield next;
  }
}

// Sentinel object (NOT a real CrewEvent) used to wake the consumer loop
// when the queue path needs an explicit terminal marker.
const SENTINEL_DONE = Object.freeze({ kind: "__crew_done_sentinel__" }) as unknown as CrewEvent;

type HandoffEventInternal = {
  from: string;
  to: string;
  reason: string;
  context?: unknown;
};

/**
 * Pillar 3 cross-agent boundary site. In-crew handoffs and A2A sends carry
 * sender-supplied strings (reason / context / payload) straight into the
 * receiving role's seed — a compromised crew member could otherwise inject
 * instructions into a peer, the lateral vector sub-agent-spawner already
 * closes on `finalMessage`. Classify with the cross-agent `"subagent"`
 * origin (reused so this stays in-package), redact on a malicious verdict
 * before the text becomes the receiver's seed, and tag a non-blocked
 * verdict so the receiver's egress checks see the provenance.
 */
async function classifyCrossAgentText(ctx: RunContext, text: string): Promise<string> {
  const boundary = await classifyBoundary(text, { origin: "subagent" });
  if (boundary.action === "redact" && boundary.redacted !== undefined) {
    return boundary.redacted;
  }
  tagContent(ctx, text, "subagent");
  return text;
}

function serialiseContext(context: unknown): string {
  if (typeof context === "string") return context;
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return String(context);
  }
}

/**
 * Build the receiving role's seed for a handoff. The sender-supplied
 * `reason` and `context` are classified at the `"subagent"` boundary (see
 * `classifyCrossAgentText`) before they land in the seed.
 */
async function buildHandoffSeed(
  ctx: RunContext,
  ho: HandoffEventInternal,
): Promise<ReadonlyArray<{ role: "user" | "assistant"; content: string }>> {
  const safeReason = await classifyCrossAgentText(ctx, ho.reason);
  const parts: string[] = [`[Handoff from ${ho.from}]\n\nReason: ${safeReason}`];
  if (ho.context !== undefined) {
    const safeContext = await classifyCrossAgentText(ctx, serialiseContext(ho.context));
    parts.push(`Context:\n${safeContext}`);
  }
  parts.push(
    "You now own the conversation. Continue the work end-to-end, calling tools as needed, and respond directly to the user when you are done.",
  );
  return [{ role: "user", content: parts.join("\n\n") }];
}

/**
 * Loop contract 0.4 (Batch A) — fold the run-level ceilings (`opts.limits`,
 * `opts.budget`, `opts.hooks`, the `spawnSubAgent` injection) and the
 * role-level selectors (`thinking`, `subAgents`, and — 0.6.0 PR 3 — the
 * per-role routing quartet `modelFallbacks`/`circuitBreaker`/`modelTiers`/
 * `modelPool`) into one runChatLoop options fragment, applied IDENTICALLY
 * to primary role activations and inline A2A peer turns. Only declared
 * fields are present — the runtime owns every default, so a knob-less run
 * stays byte-identical to pre-0.4. `roleName` is the role the turn belongs
 * to (0.6.0 PR 7b): it becomes the pool's `scope` when the spec pinned none
 * (see {@link scopeRolePool}) and is required precisely so neither call site
 * can forget it — the 0.5.5 `toolsetScope` lesson.
 *
 * The returned fragment is spread into each call site behind a
 * `Partial<RunChatLoopOptions>` cast: `maxToolIterations`/
 * `maxConcurrentTools`/`contextLimit`/`budget`/`hooks`/`subAgents`/
 * `spawnSubAgent` are pre-existing runtime options, while the 0.4
 * enforcement knobs (`deadlineMs`/`turnTimeoutMs`/`modelCallTimeoutMs`/
 * `loopDetection`/`thinking`) are typed locally until runtime-core's
 * loop-contract options land — the cast is the forward-compat seam that
 * compiles (and forwards compatibly) on both sides of that landing; a
 * runtime without the knobs simply ignores the extra keys. Drop the cast
 * once runtime-core carries them (the `LoopTuningFragment` intersection then
 * self-checks: a shape drift between these local members and the landed
 * runtime options turns the member type impossible and fails this file's
 * compile). Exported for direct unit coverage of the mapping.
 */
export type LoopTuningFragment = Pick<
  RunChatLoopOptions,
  | "maxToolIterations"
  | "maxConcurrentTools"
  | "contextLimit"
  | "budget"
  | "hooks"
  | "subAgents"
  | "spawnSubAgent"
  | "modelFallbacks"
  | "circuitBreaker"
  | "modelTiers"
> & {
  readonly deadlineMs?: number;
  readonly turnTimeoutMs?: number;
  readonly modelCallTimeoutMs?: number;
  readonly loopDetection?: CrewLoopLimits["loopDetection"];
  readonly thinking?: RoleThinking;
  readonly temperature?: number;
  /** 0.6.0 (PR 7b) — the WIDENED pool, a structural subtype of runtime-core's
   *  option (per-candidate profiles + `scope` + hybrid siblings ride verbatim). */
  readonly modelPool?: RoleModelPool;
};

/**
 * 0.6.0 §7.9 (PR 7b) — the pool a role turn hands runtime-core: the role's
 * declared pool with `scope` defaulted to the ROLE NAME when the spec did
 * not pin one. Stamped here (not at lower time) so a pre-0.6.0 pooled role
 * literal stays byte-identical while every role's arms still get their own
 * namespace once the routing store keys by scope (PR 10) — one shared
 * `arms.jsonl` must not pool a crew's planner and workers into two arms. A
 * declared `scope` always wins; the candidates and every other key are
 * forwarded verbatim (object identity kept when nothing is stamped).
 */
export function scopeRolePool(pool: RoleModelPool, roleName: string): RoleModelPool {
  return pool.scope !== undefined ? pool : { ...pool, scope: roleName };
}

/**
 * 0.6.0 PR 9d (§7.4, §7.6, §7.8) — a role's side-call closures, built by the
 * composition root from the role's SCOPED pool at every activation (one
 * activation is one single-turn run, so a committee is legal here) and
 * spread at BOTH role call sites (primary activation + inline A2A peer turn,
 * the 0.5.5 `toolsetScope` lesson). The test seams ride along: the role's
 * `_poolAdapters` double as the nested side-call adapters, `_judgeAdapter`
 * as the judge. Spread-return-`{}`: a role whose pool declares no guide /
 * shadow / committee hands runtime-core exactly the options it got before.
 */
export function composeSideCalls(
  def: RoleDefinition,
  opts: RunOptions,
  roleName: string,
  crewName: string,
): Pick<RunChatLoopOptions, "sideCalls"> {
  if (def.modelPool === undefined || !hasSideCallStrategy(def.modelPool)) return {};
  return wireSideCalls(scopeRolePool(def.modelPool, roleName), {
    sessionName: crewName,
    ...(opts._poolAdapters !== undefined ? { _consultAdapters: opts._poolAdapters } : {}),
    ...(opts._judgeAdapter !== undefined ? { _judgeAdapter: opts._judgeAdapter } : {}),
  });
}

export function composeLoopTuning(
  def: RoleDefinition,
  opts: RunOptions,
  roleName: string,
): LoopTuningFragment {
  const limits = opts.limits ?? {};
  return {
    ...(limits.maxToolIterations !== undefined
      ? { maxToolIterations: limits.maxToolIterations }
      : {}),
    ...(limits.maxConcurrentTools !== undefined
      ? { maxConcurrentTools: limits.maxConcurrentTools }
      : {}),
    ...(limits.contextLimit !== undefined ? { contextLimit: limits.contextLimit } : {}),
    ...(limits.deadlineMs !== undefined ? { deadlineMs: limits.deadlineMs } : {}),
    ...(limits.turnTimeoutMs !== undefined ? { turnTimeoutMs: limits.turnTimeoutMs } : {}),
    ...(limits.modelCallTimeoutMs !== undefined
      ? { modelCallTimeoutMs: limits.modelCallTimeoutMs }
      : {}),
    ...(limits.loopDetection !== undefined ? { loopDetection: limits.loopDetection } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    ...(def.thinking !== undefined ? { thinking: def.thinking } : {}),
    // 0.6.0 §4.1 — the role's sampling temperature rides beside `thinking`.
    ...(def.temperature !== undefined ? { temperature: def.temperature } : {}),
    ...(def.subAgents !== undefined ? { subAgents: def.subAgents } : {}),
    ...(opts.spawnSubAgent !== undefined ? { spawnSubAgent: opts.spawnSubAgent } : {}),
    // 0.6.0 (PR 3, §7.7) — per-role model routing. Presence-gated like every
    // other selector: a role without routing hands runtime-core exactly the
    // options it got before, so the single-model path is untouched.
    ...(def.modelFallbacks !== undefined ? { modelFallbacks: def.modelFallbacks } : {}),
    ...(def.circuitBreaker !== undefined ? { circuitBreaker: def.circuitBreaker } : {}),
    ...(def.modelTiers !== undefined ? { modelTiers: def.modelTiers } : {}),
    // 0.6.0 (PR 7b, §7.7/§7.9) — the widened pool, per-candidate profiles
    // intact, scoped to this role when the spec pinned no scope.
    ...(def.modelPool !== undefined ? { modelPool: scopeRolePool(def.modelPool, roleName) } : {}),
  };
}

/**
 * 0.6.0 (PR 3) — the test-injection seams, folded once and spread at BOTH
 * role call sites (primary activation + inline A2A peer turn). One helper
 * rather than two hand copies: the 0.5.5 `toolsetScope` lesson was that a
 * per-turn option added to only one of the two sites silently splits crew
 * behaviour between a handoff and a peer ask. Presence-gated so a run with
 * no injection passes runtime-core no `_`-keys at all. The router consult
 * (`RouterArgs._adapter`) is a different seam and keeps its own forward.
 * Exported for direct unit coverage.
 */
export function composeAdapterSeams(
  opts: RunOptions,
): Pick<
  RunChatLoopOptions,
  "_adapter" | "_failoverAdapters" | "_tierAdapters" | "_poolAdapters" | "_scoreboard"
> {
  return {
    ...(opts._adapter !== undefined ? { _adapter: opts._adapter } : {}),
    ...(opts._failoverAdapters !== undefined ? { _failoverAdapters: opts._failoverAdapters } : {}),
    ...(opts._tierAdapters !== undefined ? { _tierAdapters: opts._tierAdapters } : {}),
    ...(opts._poolAdapters !== undefined ? { _poolAdapters: opts._poolAdapters } : {}),
    ...(opts._scoreboard !== undefined ? { _scoreboard: opts._scoreboard } : {}),
  };
}

function composeRoleTools(args: {
  role: string;
  roles: ReadonlyArray<string>;
  roleTools: ReadonlyArray<RegisteredTool>;
  roleExtraTools?: ReadonlyArray<RegisteredTool>;
  extraTools?: ReadonlyArray<RegisteredTool>;
}): ReadonlyArray<RegisteredTool> {
  const handoff = createHandoffTool({ from: args.role, targets: args.roles });
  const a2a = createSendMessageA2ATool({ from: args.role, targets: args.roles });
  // Spec-supplied tools first so explicit user choices win in any future
  // catalog dedup; crew-wide extras (the memory fabric, v0.3.0) follow;
  // Handoff/SendMessage are appended last and never collide (no spec-side
  // tool today is named "Handoff" or "SendMessage" in a CRW bundle —
  // channel-bot's SendMessage lives in a different target shape).
  // Order: the role's own spec tools, then ITS per-role extras (the Thredz
  // vocabulary it alone owns), then the crew-wide extras, then Handoff/A2A.
  return [
    ...args.roleTools,
    ...(args.roleExtraTools ?? []),
    ...(args.extraTools ?? []),
    handoff,
    a2a,
  ];
}

export { createHandoffTool, createSendMessageA2ATool };
export type { CrewMailbox } from "@crewhaus/agent-context-isolation";
