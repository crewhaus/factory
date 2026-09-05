/**
 * @crewhaus/model-service — the composition root for model routing
 * (0.6.0 plan §2 stance 4, module brief 308; the `wireMemory` precedent in
 * `@crewhaus/memory-service`).
 *
 *   const routing = wireModels(modelWiringFragmentFromIr(ir.agent), {});
 *   await runChatLoop({ model, instructions, tools, ...routing });
 *
 * ONE call turns the lowered model-routing IR into the `RunChatLoopOptions`
 * fragment runtime-core consumes. Before this package, ten emitters and two
 * interpreter sites each hand-mirrored the same four-field rendering
 * (`modelFallbacks` / `circuitBreaker` / `modelTiers` / `modelPool`) with a
 * "keep the N copies in sync" comment; the copies had already drifted (the
 * single-turn interpreter path dropped `circuitBreaker` under `--model`, the
 * REPL path kept it). Every later routing feature — per-candidate adapters,
 * chains and breakers, the scoreboard and priors, the PolicyRouter with rules
 * / classifier / eligibility, the per-candidate plan table, judge metering,
 * the guide / shadow / committee closures, the Consult / Escalate tools —
 * lands HERE (PRs 8b, 9a–9d, 10), never in codegen. runtime-core keeps
 * receiving injected closures and stays store-free.
 *
 * PR 8a (this file's first cut) WRAPPED what the emitters already rendered,
 * byte-identically: {@link renderModelWiringFields} reproduces the legacy
 * emitter strings exactly so every existing bundle is unchanged, and
 * `wireModels` and the renderer are pinned equal by test (`index.test.ts`):
 * evaluating the rendered fields yields the same object `wireModels` returns.
 *
 * PR 8b adds the first runtime CONSTRUCTION: under
 * `model_pool.strategy.model_directed: true` the root builds the `Consult`
 * and `Escalate` tools from `@crewhaus/tool-consult` and returns them as the
 * `hybridTools` / `escalation` options (plan §7.2.4, §7.5). The Consult
 * runner is a nested single-turn `runChatLoop` on the allowlisted roster
 * sibling — through `runChatLoop`, never `adapter.stream`, so
 * `model_request` / `model_response`, `cost_accrual` and budget metering all
 * hold — minted with its OWN child `RunContext` and child `TraceEventBus`
 * (the side-call isolation contract, §7.6) whose model events are re-published
 * on the parent bus so the parent's meter counts them. The reply is classified
 * at TrustOrigin "consult" (`classifyBoundary` + `tagContent`) INSIDE the tool
 * package, exactly once; this root only builds the call. A pool without the
 * strategy key, or any `--model` override, wires no hybrid tool — the
 * pre-0.6.0 fragment stays byte-identical.
 *
 * REACH, stated honestly: in 8b the pair reaches the `crewhaus run` / `serve`
 * interpreter (`apps/cli/src/loop-contract.ts`'s `modelRoutingRunOptions` IS
 * this call). A compiled bundle does NOT register it yet — every emitter
 * still renders {@link renderModelWiringFields}, which never renders
 * {@link HYBRID_WIRING_KEYS}, and no bundle imports this package at boot.
 * Since 8b this package depends on `@crewhaus/runtime-core` (the nested
 * Consult loop), so a bundle cannot import it at boot without a cycle; the
 * compiler's `model-plan-pending-runtime` warning on `strategy.model_directed`
 * says exactly that, and target-cli's test pins the deferred state.
 *
 * PR 9a (the per-candidate plan table) therefore builds the plans INSIDE
 * runtime-core, at boot, from the widened `modelPool` option this root hands
 * it — `@crewhaus/model-plan`'s pure `buildRequestParams` /
 * `buildAdvertisement` do the derivation, runtime-core owns the selection —
 * rather than constructing them here: the same blob a bundle renders and the
 * interpreter spreads yields the same plans on both paths, which keeps the
 * one-code-path contract without a boot-time import. What this root DOES add
 * in 9a is the emit-side scope twin {@link scopedModelWiringFragment}.
 *
 * `wireModels` is per RUN, not per process: the escalation latch it returns
 * is bounded "per run", so a host that serves many runs from one process
 * (`crewhaus serve`) calls it once per run — never caches the fragment.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type {
  IrCircuitBreaker,
  IrModelPool,
  IrModelTiers,
  IrSubAgentDefinition,
} from "@crewhaus/ir";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { type RunChatLoopOptions, runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type ConsultRunner,
  type EscalationLatch,
  createConsultTool,
  createEscalateTool,
  createEscalationLatch,
  resolveRosterTarget,
  rosterFromPool,
  strongestOf,
} from "@crewhaus/tool-consult";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

// ---------------------------------------------------------------------------
// The fragment — the serializable slice of a lowered agent / step / role /
// node block this root consumes
// ---------------------------------------------------------------------------

/**
 * The model-routing slice of ONE lowered model-bearing block (an `IrV0`
 * agent, a workflow step, a crew role, a graph node, a pooled single-agent
 * block). Every IR block that carries routing already satisfies this shape
 * structurally, so emitters and the interpreter pass the block itself —
 * typed IR in (Pillar 1), one call out. Every key is optional and
 * absent-when-omitted: an empty fragment wires NOTHING.
 *
 * `modelPool` is the whole `IrModelPool`, not an allow-list of its keys: the
 * pool travels to runtime as ONE blob (`JSON.stringify(modelPool)` in a
 * bundle, the object itself in the interpreter), so every per-candidate
 * setting, rule, strategy and reward key the compiler lowers reaches
 * `runChatLoop` verbatim. The `index.test.ts` "one new key per level"
 * fixture pins that nothing between the IR and the option object drops a
 * key (plan §17).
 */
export type ModelWiringFragment = {
  /** Ordered fallback model strings (spec `model_fallbacks`). */
  readonly modelFallbacks?: readonly string[];
  /** Breaker tuning (spec `circuit_breaker`) — with or without fallbacks. */
  readonly circuitBreaker?: IrCircuitBreaker;
  /** The two-tier turn-difficulty router (spec `model_tiers`). */
  readonly modelTiers?: IrModelTiers;
  /** The N-candidate pool (spec `model_pool`), carried whole. */
  readonly modelPool?: IrModelPool;
};

/**
 * The `runChatLoop(...)` options fragment `wireModels` returns — the four
 * routing options under runtime-core's own option names, mirrored
 * STRUCTURALLY from the IR types, plus (PR 8b) the two hybrid-tool options
 * the root constructs under `strategy.model_directed`. Since PR 8b this
 * package DOES depend on `@crewhaus/runtime-core` (the Consult runner is a
 * nested `runChatLoop`), so the whole type is pinned assignable to
 * `Pick<RunChatLoopOptions, keyof ModelWiringRunOptions>` right here
 * ({@link _ModelWiringRunOptionsPin}) — a rename or reshaping in runtime-core
 * fails `tsc -b` in this package, and `apps/cli/src/loop-contract.ts`'s
 * `modelRoutingRunOptions` carries the same pin at the interpreter seam (the
 * `LoopContractRunOptions` discipline). Later PRs widen this type
 * (`_poolAdapters`, `_scoreboard`, …) as the root constructs more.
 */
export type ModelWiringRunOptions = {
  readonly modelFallbacks?: readonly string[];
  readonly circuitBreaker?: IrCircuitBreaker;
  readonly modelTiers?: IrModelTiers;
  readonly modelPool?: IrModelPool;
  /**
   * 0.6.0 §7.2.4 — `Consult` + `Escalate`, present only when the (non-
   * overridden) pool declares `strategy.model_directed: true`. runtime-core
   * appends them to the effective tool list (first-party wins a collision).
   */
  readonly hybridTools?: ReadonlyArray<RegisteredTool>;
  /** The `Escalate` tool's latch — the loop consumes it at its next model call. */
  readonly escalation?: EscalationLatch;
};

/**
 * The compile-time pin: every key of {@link ModelWiringRunOptions} is a
 * `runChatLoop` option with an assignable value type. Never read.
 */
type _ModelWiringRunOptionsPin = ModelWiringRunOptions extends Pick<
  RunChatLoopOptions,
  keyof ModelWiringRunOptions
>
  ? true
  : never;
const _MODEL_WIRING_RUN_OPTIONS_PIN: _ModelWiringRunOptionsPin = true;
void _MODEL_WIRING_RUN_OPTIONS_PIN;

/**
 * The runtime dependencies `wireModels` composes over: the interpreter's
 * `--model` override, the session facts the nested consult loops persist
 * under, and the test injection seams for the consult side call. The
 * adapters, scoreboard root, bus and tool catalog join as the root grows.
 */
export type WireModelsDeps = {
  /**
   * A caller-forced primary model (the interpreter's `--model` flag). A
   * flag-forced model is an explicit routing decision, and the spec's
   * fallback chain, tiers and pool were authored against the SPEC's primary
   * — so they are dropped (and with the pool, its hybrid tools).
   * `circuitBreaker` is kept: declared alone it breaker-wraps whichever
   * single primary serves, override or not.
   */
  readonly modelOverride?: string;
  /**
   * The harness / spec name the nested consult loops label their sessions
   * with (`<name>:consult`). Defaults to `"consult"`.
   */
  readonly sessionName?: string;
  /**
   * Root under which the nested consult loops persist their session and
   * event-log files (a consult is its own single-turn run, like a Task
   * child). Defaults to the runtime's default (`.crewhaus/sessions`, or
   * `CREWHAUS_SESSION_DIR`).
   */
  readonly sessionRootDir?: string;
  /**
   * Test injection — pre-built adapters for consult targets keyed by their
   * SPEC model string (the `_poolAdapters` contract), so a consult runs
   * offline through `runChatLoop({ _adapter })`. Production callers leave it
   * undefined: the nested loop resolves the target through the model-router.
   */
  readonly _consultAdapters?: ReadonlyMap<string, ProviderAdapter>;
  /**
   * Test injection — replace the nested-`runChatLoop` runner entirely with a
   * scripted one. Production callers leave it undefined.
   */
  readonly _consultRunner?: ConsultRunner;
};

/** The routing keys, in the order every emitter and the interpreter have
 *  always written them. `wireModels` returns them in this order and
 *  {@link renderModelWiringFields} renders them in this order. */
export const MODEL_WIRING_KEYS = [
  "modelFallbacks",
  "circuitBreaker",
  "modelTiers",
  "modelPool",
] as const;

/** The hybrid-tool keys `wireModels` appends after {@link MODEL_WIRING_KEYS}
 *  when the pool declares `strategy.model_directed: true`. Never rendered by
 *  {@link renderModelWiringFields}: they are runtime constructions. */
export const HYBRID_WIRING_KEYS = ["hybridTools", "escalation"] as const;

/**
 * Pick the routing slice out of a lowered block EXACTLY as the retired
 * per-emitter renderers read it — only declared keys are carried, and an
 * EMPTY `modelFallbacks` array is treated as absent (the emitters' and the
 * interpreter's `length > 0` guard), so a spec that declares no chain wires
 * no chain. Values are carried by reference, never copied or re-shaped:
 * the pool blob's key order is a byte contract (`model` then `tags` first,
 * every 0.6.0 key after — the compiler's key-order guard).
 */
export function modelWiringFragmentFromIr(block: ModelWiringFragment): ModelWiringFragment {
  const fallbacks = block.modelFallbacks;
  return {
    ...(fallbacks !== undefined && fallbacks.length > 0 ? { modelFallbacks: fallbacks } : {}),
    ...(block.circuitBreaker !== undefined ? { circuitBreaker: block.circuitBreaker } : {}),
    ...(block.modelTiers !== undefined ? { modelTiers: block.modelTiers } : {}),
    ...(block.modelPool !== undefined ? { modelPool: block.modelPool } : {}),
  };
}

/**
 * 0.6.0 §7.9 (PR 9a) — the emit-side twin of `@crewhaus/crew-orchestrator`'s
 * `scopeRolePool`: a block's fragment with its pool's `scope` defaulted to
 * the host's name (a workflow step, a graph node) when the spec pinned none.
 * The compiler deliberately leaves `scope` unstamped at lower time (the IR
 * blob is what README / loop projections read), so the emitter that knows
 * which step or node a `runChatLoop` call belongs to stamps it where the
 * loop options are assembled — runtime-core stamps the result on
 * `model_route.scope`, and the routing store keys arms by it from PR 10 on.
 * A declared `scope` always wins; a fragment without a pool is returned
 * untouched (object identity kept), so un-pooled steps and nodes stay
 * byte-identical.
 */
export function scopedModelWiringFragment(
  block: ModelWiringFragment,
  scope: string,
): ModelWiringFragment {
  const pool = block.modelPool;
  if (pool === undefined || pool.scope !== undefined) return block;
  return { ...modelWiringFragmentFromIr(block), modelPool: { ...pool, scope } };
}

// ---------------------------------------------------------------------------
// wireModels — the composition root
// ---------------------------------------------------------------------------

/**
 * THE one stable call. Returns the spread-ready `RunChatLoopOptions` slice
 * for a fragment: every key present only when the fragment declares it
 * (spread-return-`{}` discipline — an empty fragment yields `{}` and the
 * runtime defaults stay authoritative), values by reference, keys in
 * {@link MODEL_WIRING_KEYS} order, then {@link HYBRID_WIRING_KEYS} when the
 * pool declares `strategy.model_directed: true`.
 *
 * Still synchronous. The runtime resolves candidate adapters, opens the
 * scoreboard and builds the PolicyRouter inside `runChatLoop` from the four
 * routing options exactly as it did when each emitter rendered them by hand
 * (moving that construction here is PR 9a/10's job). What this root DOES
 * construct today is the model-directed pair: the `Consult` tool over a
 * nested-`runChatLoop` runner on the roster, and the `Escalate` tool with the
 * latch the loop consumes — see {@link wireModelDirected}.
 */
export function wireModels(
  fragment: ModelWiringFragment,
  deps: WireModelsDeps,
): ModelWiringRunOptions {
  const overridden = typeof deps.modelOverride === "string";
  const fallbacks = fragment.modelFallbacks;
  const pool = !overridden ? fragment.modelPool : undefined;
  return {
    ...(!overridden && fallbacks !== undefined && fallbacks.length > 0
      ? { modelFallbacks: fallbacks }
      : {}),
    ...(fragment.circuitBreaker !== undefined ? { circuitBreaker: fragment.circuitBreaker } : {}),
    ...(!overridden && fragment.modelTiers !== undefined
      ? { modelTiers: fragment.modelTiers }
      : {}),
    ...(pool !== undefined ? { modelPool: pool } : {}),
    ...(pool !== undefined && pool.strategy?.modelDirected === true
      ? wireModelDirected(pool, deps)
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Model-directed: Consult + Escalate (plan §7.2.4, §7.5)
// ---------------------------------------------------------------------------

/**
 * Build the `Consult` / `Escalate` pair for a pool that declares
 * `strategy.model_directed: true`. The roster is the pool's ENABLED
 * candidates; the escalation target is `strategy.cascade.escalateTo`
 * resolved against the roster (a tag, profile or model string), else the
 * strongest candidate (first `routing.strongTag`-tagged, else the last
 * declared — the router's `escalation()` convention); `strategy.
 * max_escalations` bounds the latch (default 1). A pool the compiler let
 * through with no enabled candidate wires nothing rather than throwing.
 */
export function wireModelDirected(
  pool: IrModelPool,
  deps: WireModelsDeps,
): Pick<ModelWiringRunOptions, "hybridTools" | "escalation"> {
  const roster = rosterFromPool(pool);
  if (roster.length === 0) return {};
  const strongTag = pool.routing?.strongTag;
  const escalateTo = pool.strategy?.cascade?.escalateTo;
  const target =
    (escalateTo !== undefined ? resolveRosterTarget(roster, escalateTo, strongTag) : undefined) ??
    strongestOf(roster, strongTag);
  const latch = createEscalationLatch({
    target,
    ...(pool.strategy?.maxEscalations !== undefined
      ? { maxEscalations: pool.strategy.maxEscalations }
      : {}),
  });
  const run = deps._consultRunner ?? buildConsultRunner(deps);
  const consult = createConsultTool({
    roster,
    run,
    ...(strongTag !== undefined ? { strongTag } : {}),
  });
  const escalate = createEscalateTool({ latch });
  return { hybridTools: [consult, escalate], escalation: latch };
}

/** The consulted model's system prompt — it sees the question, nothing else. */
export const CONSULT_INSTRUCTIONS =
  "You are being consulted by another model of the same harness on one question. Answer it directly and concisely, using only the question and the context you are given. You have no tools and cannot see the rest of the conversation; if the question cannot be answered from what you were given, say exactly what is missing.";

/**
 * The nested single-turn side call (plan §7.5 / §7.6). Runs the roster
 * target through `runChatLoop({ singleTurn: true, tools: [], sessionTarget:
 * "consult", modelRole: "consult" })` — never `adapter.stream` — on a CHILD
 * run context whose bus inherits the parent's trace and whose
 * `model_request` / `model_response` events are re-published on the PARENT
 * bus under the parent's envelope, so the parent's cost-tracker prices them
 * (`role: "consult"`), its `budgetMeter` counts them under `judge_share`, and
 * its session mirror persists them. The child is minted (own runId /
 * sessionId, the parent's abort signal, an origin stack ending in "consult")
 * rather than reusing the parent's context because the singleTurn path
 * mutates `runContext.turnNumber` — a shared context would inject phantom
 * turns into the parent (§7.6). The child persists its own session file
 * like a Task child does; whether side calls should persist at all is plan
 * §16 Q6, decided with the other side-call closures in PR 9d.
 *
 * Returns the raw reply text — classification at TrustOrigin "consult"
 * (`classifyBoundary` + `tagContent`) is the tool's job in
 * `@crewhaus/tool-consult`, exactly once.
 */
export function buildConsultRunner(deps: WireModelsDeps): ConsultRunner {
  return async ({ target, question, context, runContext: parent, signal }) => {
    const childRunId = `run_${randomUUID().slice(0, 8)}`;
    const childSessionId = `sess_${randomBytes(8).toString("hex")}`;
    const childBus = new TraceEventBus({
      runId: childRunId,
      sessionId: childSessionId,
      ...(parent !== undefined
        ? {
            inheritTraceId: parent.eventBus.traceId,
            inheritParentSpanId: parent.eventBus.currentSpanId,
            logger: parent.logger,
          }
        : {}),
    });
    const child: RunContext = createRunContext({
      runId: childRunId,
      sessionId: childSessionId,
      ...(signal !== undefined
        ? { abortSignal: signal }
        : parent !== undefined
          ? { abortSignal: parent.abortSignal }
          : {}),
      ...(parent !== undefined ? { logger: parent.logger } : {}),
      eventBus: childBus,
      originStack: [...(parent?.originStack ?? []), "consult"],
    });
    // Re-publish the child's model calls on the parent bus so the parent's
    // meter, cost-tracker and session mirror see them (`role: "consult"` is
    // stamped by the child loop's `modelRole`; re-stamped here defensively).
    const unsubscribe =
      parent !== undefined
        ? childBus.subscribe((event: TraceEvent) => {
            if (event.kind !== "model_request" && event.kind !== "model_response") return;
            parent.eventBus.publish({ ...event, ...parent.eventBus.envelope(), role: "consult" });
          })
        : undefined;
    const injected = deps._consultAdapters?.get(target.modelString);
    const content =
      context !== undefined && context.trim().length > 0
        ? `${context.trim()}

---

Question: ${question}`
        : question;
    try {
      const text = await runChatLoop({
        model: target.modelString,
        instructions: CONSULT_INSTRUCTIONS,
        tools: [],
        singleTurn: true,
        seedMessages: [{ role: "user", content }],
        runContext: child,
        sessionName: `${deps.sessionName ?? "consult"}:consult`,
        sessionTarget: "consult",
        modelRole: "consult",
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
        // A child's rules are the parent's business, not the disk's: the
        // consult runs no tools, so there is nothing to merge.
        settingsDir: null,
        ...(deps.sessionRootDir !== undefined ? { sessionRootDir: deps.sessionRootDir } : {}),
        ...(injected !== undefined ? { _adapter: injected } : {}),
      });
      return { text };
    } finally {
      unsubscribe?.();
    }
  };
}

// ---------------------------------------------------------------------------
// The codegen twin — what an emitter writes into a bundle
// ---------------------------------------------------------------------------

/**
 * Render the routing fields of a fragment as object-literal source for a
 * generated `runChatLoop({...})` (or crew `RoleDefinition`) call — the
 * codegen twin of {@link wireModels}, byte-for-byte the string the ten
 * emitters used to build by hand:
 *
 *   `\n<indent>modelFallbacks: ["a", "b"],`
 *   `\n<indent>circuitBreaker: {"failureThreshold":2},`
 *   `\n<indent>modelTiers: {"fast":"…","default":"…"},`
 *   `\n<indent>modelPool: {"candidates":[…],"policy":"heuristic"},`
 *
 * Model strings pass through `escapeJsonString` (user-controlled spec values
 * landing in generated source); the breaker / tiers / pool blocks are
 * validated numbers, strings and closed-literal unions, safe to
 * `JSON.stringify` as plain object literals. Returns `""` when the fragment
 * declares nothing, so pre-existing bundles stay byte-identical. `indent`
 * is the caller's field indentation (two spaces for target-cli's top-level
 * call, eight inside a channel `createAgent` body, …).
 *
 * Evaluating the rendered fields yields exactly `wireModels(fragment, {})`
 * — pinned in `index.test.ts` — which is what makes a compiled bundle and
 * the `crewhaus run` interpreter one code path rather than a mirror.
 */
export function renderModelWiringFields(fragment: ModelWiringFragment, indent: string): string {
  const pieces: string[] = [];
  const fallbacks = fragment.modelFallbacks;
  if (fallbacks !== undefined && fallbacks.length > 0) {
    pieces.push(
      `\n${indent}modelFallbacks: [${fallbacks.map((m) => escapeJsonString(m)).join(", ")}],`,
    );
  }
  if (fragment.circuitBreaker !== undefined) {
    pieces.push(`\n${indent}circuitBreaker: ${JSON.stringify(fragment.circuitBreaker)},`);
  }
  if (fragment.modelTiers !== undefined) {
    pieces.push(`\n${indent}modelTiers: ${JSON.stringify(fragment.modelTiers)},`);
  }
  if (fragment.modelPool !== undefined) {
    pieces.push(`\n${indent}modelPool: ${JSON.stringify(fragment.modelPool)},`);
  }
  return pieces.join("");
}

/**
 * 0.6.0 §7.7 — render one `IrSubAgentDefinition` as the single-line TS object
 * literal the emitted `__subAgents` Map holds (a runtime
 * `SubAgentDefinition`). ONE renderer for the three emitters that register
 * the Task tool (cli, channel-bot, crew) — until PR 11 each carried a
 * hand-mirrored copy with a "keep the three in sync" comment.
 *
 * Byte contract: the seven fields a 0.5.x definition has (`name`,
 * `description`, `instructions`, `tools`, `model`, `permissions`,
 * `inherit_bypass`) render exactly as the copies did, in that order; every
 * 0.6.0 key (`modelProfile`, `overlay`, the params, the routing quartet,
 * `budgetShare`, `inheritRouting`, `allowedProfiles`) is appended AFTER them and ONLY when
 * present, so a spec whose sub-agents carry only today's fields emits a
 * byte-identical bundle. The 0.6.0 keys use the runtime `SubAgentDefinition`
 * names (camelCase, identical to the IR's) — `inherit_bypass` keeps its
 * legacy spelling.
 */
export function renderSubAgentDef(d: IrSubAgentDefinition): string {
  const lines: string[] = [];
  lines.push(`name: ${escapeJsonString(d.name)}`);
  lines.push(`description: ${escapeJsonString(d.description)}`);
  lines.push(`instructions: ${escapeJsonString(d.instructions)}`);
  lines.push(`tools: ${JSON.stringify(d.tools)}`);
  if (d.model !== undefined) lines.push(`model: ${escapeJsonString(d.model)}`);
  if (typeof d.permissions === "string") {
    lines.push(`permissions: ${escapeJsonString(d.permissions)}`);
  } else {
    lines.push(
      `permissions: { allow: ${JSON.stringify(d.permissions.allow)}, deny: ${JSON.stringify(d.permissions.deny)} }`,
    );
  }
  lines.push(`inherit_bypass: ${d.inheritBypass}`);
  if (d.modelProfile !== undefined) lines.push(`modelProfile: ${escapeJsonString(d.modelProfile)}`);
  if (d.overlay !== undefined) lines.push(`overlay: ${escapeJsonString(d.overlay)}`);
  if (d.thinking !== undefined) lines.push(`thinking: ${JSON.stringify(d.thinking)}`);
  if (d.maxTokens !== undefined) lines.push(`maxTokens: ${d.maxTokens}`);
  if (d.temperature !== undefined) lines.push(`temperature: ${d.temperature}`);
  if (d.modelFallbacks !== undefined && d.modelFallbacks.length > 0) {
    lines.push(`modelFallbacks: ${JSON.stringify(d.modelFallbacks)}`);
  }
  if (d.circuitBreaker !== undefined) {
    lines.push(`circuitBreaker: ${JSON.stringify(d.circuitBreaker)}`);
  }
  if (d.modelTiers !== undefined) lines.push(`modelTiers: ${JSON.stringify(d.modelTiers)}`);
  if (d.modelPool !== undefined) lines.push(`modelPool: ${JSON.stringify(d.modelPool)}`);
  if (d.budgetShare !== undefined) lines.push(`budgetShare: ${d.budgetShare}`);
  if (d.inheritRouting !== undefined) lines.push(`inheritRouting: ${d.inheritRouting}`);
  if (d.allowedProfiles !== undefined) {
    lines.push(`allowedProfiles: ${JSON.stringify(d.allowedProfiles)}`);
  }
  return `{ ${lines.join(", ")} }`;
}
