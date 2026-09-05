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
 * `snipKeepHead`/`snipKeepTail`.
 */
import type { CompileWarning } from "@crewhaus/compiler";
import type { HookDef } from "@crewhaus/hooks-engine";
import type { IrCompaction, IrHook, IrLimits, IrRateLimits, IrThinking } from "@crewhaus/ir";
import {
  type ModelWiringFragment,
  type ModelWiringRunOptions,
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
  | "rateLimits"
  | "compactionThreshold"
  | "snipKeepHead"
  | "snipKeepTail"
>;

/** The IR slice `loopContractRunOptions` reads — structural, so both the
 *  cli variant and tests' hand-built fragments satisfy it. */
export type LoopContractIrSlice = {
  readonly limits?: IrLimits;
  readonly agent?: {
    readonly thinking?: IrThinking;
    readonly rateLimits?: IrRateLimits;
  };
  readonly compaction?: Pick<IrCompaction, "threshold" | "snipKeepHead" | "snipKeepTail">;
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
    ...(rateLimits !== undefined && Object.keys(rateLimits).length > 0 ? { rateLimits } : {}),
    ...(compaction?.threshold !== undefined ? { compactionThreshold: compaction.threshold } : {}),
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
 * `modelOverride` is the raw `--model` flag value: a string is an explicit
 * routing decision authored against a different primary, so the spec's
 * chain, tiers and pool are dropped (the breaker stays — declared alone it
 * wraps whichever primary serves); anything else (absent, a bare flag) is
 * not an override. Spread-return-`{}` like every helper here: a spec with no
 * routing spreads NOTHING.
 */
export function modelRoutingRunOptions(
  agent: ModelWiringFragment,
  modelOverride: unknown,
): ModelWiringRunOptions {
  return wireModels(
    modelWiringFragmentFromIr(agent),
    typeof modelOverride === "string" ? { modelOverride } : {},
  );
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
