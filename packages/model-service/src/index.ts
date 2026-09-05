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
 * PR 8a (this file's first cut) WRAPS what the emitters already rendered,
 * byte-identically: it constructs nothing at runtime yet, and
 * {@link renderModelWiringFields} reproduces the legacy emitter strings
 * exactly so every existing bundle is unchanged. `wireModels` and the
 * renderer are pinned equal by test (`index.test.ts`): evaluating the
 * rendered fields yields the same object `wireModels` returns.
 */
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { IrCircuitBreaker, IrModelPool, IrModelTiers } from "@crewhaus/ir";

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
 * STRUCTURALLY from the IR types rather than `Pick`ed off
 * `RunChatLoopOptions`. This package publishes `src/` as its types and does
 * not depend on `@crewhaus/runtime-core` (only its tests do), so a type
 * import here would resolve in the workspace and fail (TS2307) for every
 * consumer of the published tarball — the 0.5.5 publish-only break class.
 * Assignability to `Pick<RunChatLoopOptions, keyof ModelWiringRunOptions>`
 * is pinned where runtime-core IS a declared dependency and `tsc -b` checks
 * it: `apps/cli/src/loop-contract.ts`'s `modelRoutingRunOptions` returns
 * that `Pick`, so a rename in runtime-core still fails the build (the
 * `LoopContractRunOptions` discipline); `index.test.ts` carries the same
 * pin the `@crewhaus/memory-service` tests do. Later PRs widen this type
 * (`_poolAdapters`, `_scoreboard`, …) as the root starts constructing them.
 */
export type ModelWiringRunOptions = {
  readonly modelFallbacks?: readonly string[];
  readonly circuitBreaker?: IrCircuitBreaker;
  readonly modelTiers?: IrModelTiers;
  readonly modelPool?: IrModelPool;
};

/**
 * The runtime dependencies `wireModels` composes over. PR 8a needs only the
 * one run-context fact the interpreter already threads; the adapters,
 * scoreboard root, bus and tool catalog join as the root grows.
 */
export type WireModelsDeps = {
  /**
   * A caller-forced primary model (the interpreter's `--model` flag). A
   * flag-forced model is an explicit routing decision, and the spec's
   * fallback chain, tiers and pool were authored against the SPEC's primary
   * — so they are dropped. `circuitBreaker` is kept: declared alone it
   * breaker-wraps whichever single primary serves, override or not.
   */
  readonly modelOverride?: string;
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

// ---------------------------------------------------------------------------
// wireModels — the composition root
// ---------------------------------------------------------------------------

/**
 * THE one stable call. Returns the spread-ready `RunChatLoopOptions` slice
 * for a fragment: every key present only when the fragment declares it
 * (spread-return-`{}` discipline — an empty fragment yields `{}` and the
 * runtime defaults stay authoritative), values by reference, keys in
 * {@link MODEL_WIRING_KEYS} order.
 *
 * Synchronous and construction-free in PR 8a by design (plan §13 row 8a,
 * §17): the runtime still resolves candidate adapters, opens the scoreboard
 * and builds the PolicyRouter inside `runChatLoop` from these four options,
 * exactly as it did when each emitter rendered them by hand. Moving that
 * construction here is PR 9a/10's job; landing the seam first, pinned
 * byte-identical, is this PR's.
 */
export function wireModels(
  fragment: ModelWiringFragment,
  deps: WireModelsDeps,
): ModelWiringRunOptions {
  const overridden = typeof deps.modelOverride === "string";
  const fallbacks = fragment.modelFallbacks;
  return {
    ...(!overridden && fallbacks !== undefined && fallbacks.length > 0
      ? { modelFallbacks: fallbacks }
      : {}),
    ...(fragment.circuitBreaker !== undefined ? { circuitBreaker: fragment.circuitBreaker } : {}),
    ...(!overridden && fragment.modelTiers !== undefined
      ? { modelTiers: fragment.modelTiers }
      : {}),
    ...(!overridden && fragment.modelPool !== undefined ? { modelPool: fragment.modelPool } : {}),
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
