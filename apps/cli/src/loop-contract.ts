/**
 * Loop contract 0.4 (Batch A) — the interpreter-side threading helpers for
 * the new loop-contract spec keys (`limits:`, `agent.thinking`,
 * `agent.streaming`, `agent.rate_limits`, top-level `hooks:`, the compaction
 * tuning knobs) plus the compile-warning formatter. Side-effect-free so this
 * is unit-testable (the entry file runs an argv switch on import). The
 * codegen mirror lives in `@crewhaus/target-cli` (renderLimitsFields /
 * renderCompactionTuningFields / renderSpecHooks and the thinking/streaming/
 * rateLimits fields); keep the two in sync.
 *
 * Option-name contract (all real `RunChatLoopOptions` knobs — the return
 * type is a `Pick` over runtime-core's own options so a rename there fails
 * the build here): `limits.max_tool_iterations` → `maxToolIterations`,
 * `limits.max_concurrent_tools` → `maxConcurrentTools`, `limits.context_limit`
 * → `contextLimit`, `limits.deadline_ms` → `deadlineMs`, `limits.turn_timeout_ms`
 * → `turnTimeoutMs`, `limits.model_call_timeout_ms` → `modelCallTimeoutMs`,
 * `limits.loop_detection` → `loopDetection`, `agent.thinking` → `thinking`,
 * `agent.rate_limits` → `rateLimits`, `compaction.threshold` →
 * `compactionThreshold`, `compaction.snip_keep_head`/`snip_keep_tail` →
 * `snipKeepHead`/`snipKeepTail`, (0.6.0 PR 9a) `agent.temperature` →
 * `temperature`, and (0.6.0 PR 8b) `evaluation:` →
 * `evaluation` — since 0.8.0 together with `provability:` → `provability`,
 * through {@link gateRunOptions}.
 */
import type { CompileWarning } from "@crewhaus/compiler";
import {
  type GateProofTools,
  type WireEvaluationDeps,
  evaluationFragmentFromIr,
  wireEvaluation,
} from "@crewhaus/evaluation-service";
import type { HookDef } from "@crewhaus/hooks-engine";
import type {
  IrCompaction,
  IrEvaluation,
  IrHook,
  IrLimits,
  IrProvability,
  IrRateLimits,
  IrThinking,
} from "@crewhaus/ir";
import {
  type ModelWiringFragment,
  type ModelWiringRunOptions,
  type WireModelsDeps,
  modelWiringFragmentFromIr,
  wireModels,
} from "@crewhaus/model-service";
import type { RunChatLoopOptions } from "@crewhaus/runtime-core";

/**
 * The loop-contract fragment spread into `runChatLoop(...)` — a `Pick` over
 * runtime-core's own option names, so interpreter threading cannot drift
 * from the runtime contract without a type error.
 */
export type LoopContractRunOptions = Pick<
  RunChatLoopOptions,
  | "maxToolIterations"
  | "maxConcurrentTools"
  | "contextLimit"
  | "deadlineMs"
  | "turnTimeoutMs"
  | "modelCallTimeoutMs"
  | "loopDetection"
  | "thinking"
  | "temperature"
  | "rateLimits"
  | "compactionThreshold"
  | "compactionParams"
  | "snipKeepHead"
  | "snipKeepTail"
  | "evaluation"
>;

/** The IR slice `loopContractRunOptions` reads — structural, so both the
 *  cli variant and tests' hand-built fragments satisfy it. */
export type LoopContractIrSlice = {
  readonly limits?: IrLimits;
  readonly agent?: {
    readonly thinking?: IrThinking;
    /** 0.6.0 §4.1 — `agent.temperature` (or the primary's `$profile`). */
    readonly temperature?: number;
    readonly rateLimits?: IrRateLimits;
  };
  readonly compaction?: Pick<
    IrCompaction,
    "threshold" | "snipKeepHead" | "snipKeepTail" | "params"
  >;
};

/** Valid `--ask-mode` values, mirroring `VALID_PERMISSION_MODES`. */
export const VALID_ASK_MODES = ["pause", "deny"] as const;

export type AskMode = (typeof VALID_ASK_MODES)[number];

export function isValidAskMode(value: string): value is AskMode {
  return (VALID_ASK_MODES as ReadonlyArray<string>).includes(value);
}

/**
 * Loop contract 0.4 (Batch C, G11) — resolve how a tool permission that lands
 * on `ask` behaves where there is no interactive surface to prompt on.
 *
 * Precedence mirrors `--permission-mode` exactly: an explicit valid flag wins,
 * then the spec's `permissions.ask_mode`, then the documented default
 * `"pause"`. An INVALID flag is not this function's problem — the caller
 * validates and `die()`s first, so this stays pure and unit-testable.
 *
 * Returned as a concrete value rather than left to the runtime's own
 * `askMode ?? "pause"` default so the resolved disposition is explicit in the
 * options object. `"pause"` only PARKS when an approvals store is also wired
 * (runtime-core requires both); the caller builds that store, because it needs
 * a session root this module deliberately does not know about.
 */
export function resolveAskMode(flag: unknown, specAskMode: AskMode | undefined): AskMode {
  if (typeof flag === "string" && isValidAskMode(flag)) return flag;
  return specAskMode ?? "pause";
}

/**
 * Build the loop-contract options fragment from a lowered IR. Every key is
 * absent-when-omitted (spread-return-{} discipline) so an empty spec spreads
 * NOTHING into `runChatLoop` and the runtime defaults stay authoritative —
 * exactly the byte-identity posture of the target-cli codegen mirror.
 */
export function loopContractRunOptions(ir: LoopContractIrSlice): LoopContractRunOptions {
  const limits = ir.limits;
  const compaction = ir.compaction;
  const rateLimits = ir.agent?.rateLimits;
  return {
    ...(limits?.maxToolIterations !== undefined
      ? { maxToolIterations: limits.maxToolIterations }
      : {}),
    ...(limits?.maxConcurrentTools !== undefined
      ? { maxConcurrentTools: limits.maxConcurrentTools }
      : {}),
    ...(limits?.contextLimit !== undefined ? { contextLimit: limits.contextLimit } : {}),
    ...(limits?.deadlineMs !== undefined ? { deadlineMs: limits.deadlineMs } : {}),
    ...(limits?.turnTimeoutMs !== undefined ? { turnTimeoutMs: limits.turnTimeoutMs } : {}),
    ...(limits?.modelCallTimeoutMs !== undefined
      ? { modelCallTimeoutMs: limits.modelCallTimeoutMs }
      : {}),
    ...(limits?.loopDetection !== undefined ? { loopDetection: limits.loopDetection } : {}),
    ...(ir.agent?.thinking !== undefined ? { thinking: ir.agent.thinking } : {}),
    ...(ir.agent?.temperature !== undefined ? { temperature: ir.agent.temperature } : {}),
    ...(rateLimits !== undefined && Object.keys(rateLimits).length > 0 ? { rateLimits } : {}),
    ...(compaction?.threshold !== undefined ? { compactionThreshold: compaction.threshold } : {}),
    // 0.6.0 §4.2 — the compaction profile's pinned request params, honoured
    // by `@crewhaus/compaction-autocompact`'s summarisation call. Mirror:
    // the cli / channel-bot emitters render `compactionParams` beside
    // `compactionModel`.
    ...(compaction?.params !== undefined ? { compactionParams: compaction.params } : {}),
    ...(compaction?.snipKeepHead !== undefined ? { snipKeepHead: compaction.snipKeepHead } : {}),
    ...(compaction?.snipKeepTail !== undefined ? { snipKeepTail: compaction.snipKeepTail } : {}),
  };
}

/**
 * 0.6.0 PR 8a (plan §2 stance 4, §4.4 "interpreter parity") — the primary
 * agent's model-routing fragment (`model_fallbacks` + `circuit_breaker`,
 * `model_tiers`, `model_pool`) for `runChatLoop(...)`, through THE composition
 * root: `@crewhaus/model-service`'s `wireModels`. A compiled cli bundle's
 * rendered routing fields evaluate to exactly this object (pinned in
 * model-service), so `crewhaus run` and the bundle are one code path rather
 * than a mirror. Both interpreter sites (the REPL run and the `serve`
 * single-turn runtime) spread this same call.
 *
 * PR 8b: the same call now also yields the model-directed pair — the
 * `hybridTools` (`Consult` / `Escalate`) and the `escalation` latch — when the
 * pool declares `strategy.model_directed: true`; runtime-core appends the
 * tools to the effective list and consumes the latch, so the interpreter
 * spreads the fragment and adds nothing by hand. `deps` carries the session
 * facts the nested consult loops persist under (the spec name).
 *
 * PR 9e closes the parity gap those constructions opened. `hybridTools` /
 * `escalation`, `routeClassifier` (9b) and `sideCalls` (9d) are CLOSURES, so
 * they cannot ride the pool blob a bundle renders — for two waves the
 * interpreter had them and a compiled bundle did not. The emitters now render
 * `...wireHybrid(<pool blob>, { sessionName })` beside the literal fields,
 * which is precisely the slice `wireModels` appends here; `hybrid-parity.test.ts`
 * evaluates the emitted text and compares the two option sets key for key.
 *
 * PR 9f finishes the reach: every pool-bearing shape renders that call, for
 * every closure family plan §11.3 marks **E** on its row
 * (`HYBRID_FAMILIES_BY_SHAPE` in model-service). The interpreter passes no
 * `hybridFamilies` and so keeps building every family a pool declares — it
 * serves whatever shape it is handed and is not the thing §11.3 constrains;
 * an emitter passes its shape's row, and the ONE restriction that exists
 * today (`pipeline` declines the Consult / Escalate pair) travels into the
 * bundle verbatim, so the two paths stay comparable key for key.
 *
 * "The interpreter" is TWO call sites, and 9f fixed the second: `crewhaus
 * run` accepts `cli` and `browser` (every other shape is compile-only, and
 * `serve --mcp` is cli-only), and until this row the browser path spread none
 * of this — a browser spec routed and consulted when compiled and did neither
 * when run. Both `runRunCli` and `runRunBrowser` now spread this call, so the
 * key-for-key claim above holds for every shape an interpreter accepts.
 *
 * `modelOverride` is the raw `--model` flag value: a string is an explicit
 * routing decision authored against a different primary, so the spec's
 * chain, tiers and pool (and with it the hybrid tools) are dropped (the
 * breaker stays — declared alone it wraps whichever primary serves);
 * anything else (absent, a bare flag) is not an override. Spread-return-`{}`
 * like every helper here: a spec with no routing spreads NOTHING.
 *
 * The return type is the `LoopContractRunOptions` discipline applied to the
 * routing seam: `Pick<RunChatLoopOptions, keyof ModelWiringRunOptions>` —
 * the `tsc -b`-checked pin that every `wireModels` key is a `runChatLoop`
 * option with an assignable value type (model-service carries the same pin
 * since PR 8b made runtime-core one of its dependencies).
 */
export type ModelRoutingRunOptions = Pick<RunChatLoopOptions, keyof ModelWiringRunOptions>;

export function modelRoutingRunOptions(
  agent: ModelWiringFragment,
  modelOverride: unknown,
  deps: Omit<WireModelsDeps, "modelOverride"> = {},
): ModelRoutingRunOptions {
  return wireModels(modelWiringFragmentFromIr(agent), {
    ...deps,
    ...(typeof modelOverride === "string" ? { modelOverride } : {}),
  });
}

/** The IR slice {@link evaluationRunOptions} reads. */
export type EvaluationIrSlice = {
  readonly name?: string;
  readonly evaluation?: IrEvaluation;
  readonly agent: { readonly model: string };
};

/**
 * 0.6.0 PR 8b (plan §4.4 "interpreter parity") — the in-loop `evaluation:`
 * option for `runChatLoop(...)` alone, built by THE gate composition root
 * (`@crewhaus/evaluation-service`'s `wireEvaluation`, 0.8.0 §4.4) from the
 * resolved IR — the call a compiled bundle's boot line makes, so `crewhaus
 * run` grades, retries, halts and meters judge spend exactly like the bundle:
 *
 *   - `llm_judge` grades through `gradeWithJudgePanel` on the run bus the
 *     runtime hands the grader (`role: "judge"`, priced and counted under
 *     `budget.judge_share`), honouring a declared panel / repeats /
 *     temperature / target / profile params; the judge defaults to the
 *     shape's primary and `judgeModel` names the instrument;
 *   - `contains` / `regex` are pure (score 1|0, threshold 1).
 *
 * `threshold`, `onFail`, `maxRetries` and the cascade's `escalateTo` are the
 * IR's resolved values. Async since 0.8.0 (the composition root is). The two
 * interpreter sites use {@link gateRunOptions}, which also builds the
 * provability gate and its tools; this is its evaluation-only face.
 * Spread-return-`{}`: a spec without `evaluation:` spreads NOTHING.
 */
export async function evaluationRunOptions(
  ir: EvaluationIrSlice,
): Promise<Pick<RunChatLoopOptions, "evaluation">> {
  if (ir.evaluation === undefined) return {};
  const { evaluation } = await wireEvaluation(
    { specName: ir.name ?? "", primaryModel: ir.agent.model, evaluation: ir.evaluation },
    { cwd: process.cwd() },
  );
  return evaluation !== undefined ? { evaluation } : {};
}

/** The IR slice {@link gateRunOptions} reads. */
export type GateIrSlice = {
  readonly name: string;
  readonly agent: { readonly model: string };
  readonly evaluation?: IrEvaluation;
  readonly provability?: IrProvability;
};

/** The gate options for `runChatLoop` — a `Pick` over runtime-core's own names. */
export type GateRunOptions = Pick<RunChatLoopOptions, "evaluation" | "provability">;

/**
 * 0.8.0 (design/0.8.0-provability-release.md §4.4, §8) — both in-loop gates
 * for the interpreter, through the composition root every emitter renders a
 * call to: `options` spreads into `runChatLoop` (`evaluation` and/or
 * `provability`, only the keys the spec declares), and the proof tools under
 * `provability:` go into the run's tool list: the caller hands the whole
 * result to `mergeGateTools`, which adds `tools` (what the level adds) and
 * swaps the bound twin in for any proof tool the spec also listed, from
 * `proofTools` (all three) — before the plugin tools, so first-party still
 * wins. `deps` is the
 * run's: its cwd, a catalog view over the run's tool list (so `checked`
 * replay finds the pure tools the run registered) and where the proof footer
 * goes (`"stream"` on the REPL, `"reply"` when the run's returned text is
 * what gets printed or sent). Neither block → `{ options: {}, tools: [],
 * proofTools: [] }`.
 */
export async function gateRunOptions(
  ir: GateIrSlice,
  deps: WireEvaluationDeps,
): Promise<GateProofTools & { readonly options: GateRunOptions }> {
  const fragment = evaluationFragmentFromIr(ir);
  if (fragment === undefined) return { options: {}, tools: [], proofTools: [] };
  const gates = await wireEvaluation(fragment, deps);
  return {
    options: {
      ...(gates.evaluation !== undefined ? { evaluation: gates.evaluation } : {}),
      ...(gates.provability !== undefined ? { provability: gates.provability } : {}),
    },
    tools: gates.tools,
    proofTools: gates.proofTools,
  };
}

/**
 * Concatenate spec-declared hooks BELOW the settings.json layers: spec hooks
 * first, then `loadHooks()`' user → project entries. Mirrors the permission
 * RuleSet's settings-over-yaml precedence — hooks-engine's
 * `aggregateDecisions` shallow-merges `mutate` later-wins, so a settings.json
 * hook overrides a spec hook's mutate keys, and result ordering keeps the
 * more-local layers last. All hooks still RUN (any deny wins regardless of
 * layer). `IrHook` is field-compatible with `HookDef` (camelCase `timeoutMs`,
 * the closed HookEvent union), so the concat is a plain spread. Returns the
 * settings array UNCHANGED (same reference) when the spec declares none.
 */
export function mergeSpecHooks(
  specHooks: ReadonlyArray<IrHook> | undefined,
  settingsHooks: ReadonlyArray<HookDef>,
): ReadonlyArray<HookDef> {
  if (specHooks === undefined || specHooks.length === 0) return settingsHooks;
  return [...specHooks, ...settingsHooks];
}

/**
 * Resolve the run's `streaming` option: the `--streaming` flag forces it on;
 * otherwise the spec's declared `agent.streaming` is carried verbatim
 * (true OR false — declared ≠ absent); undefined means the spec omitted it
 * and the caller spreads nothing, leaving the runtime default (false)
 * authoritative.
 */
export function resolveStreaming(
  flagOn: boolean,
  specStreaming: boolean | undefined,
): boolean | undefined {
  if (flagOn) return true;
  return specStreaming;
}

/**
 * One compile warning as the one-line `code + path + message` form the
 * compile command prints (and `--strict` escalates):
 * `warning[<code>] <path>: <message>`.
 */
export function formatCompileWarning(w: CompileWarning): string {
  return `warning[${w.code}] ${w.path}: ${w.message}`;
}
