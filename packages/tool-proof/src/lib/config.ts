/**
 * The configuration the proof tools run under when nobody hands them one.
 *
 * The composition root (`@crewhaus/evaluation-service`) builds the tools with
 * the spec's lowered `provability:` block, so the gate and the tools agree on
 * the floor, the checkers, the artifacts root and the evidence. The builtin
 * instances — what a spec gets by listing `proofCheck` in `tools:` with no
 * `provability:` block — have no block to read, so they run under the
 * compiler's own defaults at the `grounded` floor: the values
 * `lowerProvability` resolves for a bare `provability: grounded`
 * (packages/compiler/src/index.ts, the IrProvability doc in
 * packages/ir/src/index.ts). Copied rather than imported: a tool package
 * does not import the compiler.
 */
import {
  type ProvabilityConfig,
  ProvabilityError,
  isProvabilityLevel,
} from "@crewhaus/provability";
import { expandToolSelectors } from "@crewhaus/tool-categories";

/** The floor the builtin instances preflight against (design §7). */
export const DEFAULT_FLOOR = "grounded" as const;

/**
 * `execution.allow`'s default, before the category grammar expands it
 * (compiler `PROVABILITY_DEFAULT_EXECUTION_ALLOW`): the read-only computations
 * and gates, less the one destructive verify tool (design §6.3).
 * `apps/cli/src/provability-default-allow.test.ts` holds the two copies equal.
 */
export const DEFAULT_EXECUTION_SELECTORS: ReadonlyArray<string> = [
  "all-compute",
  "all-verify",
  "-goldenUpdate",
];

/** The spec name proofs are filed under when neither the caller nor the run names one. */
export const DEFAULT_SPEC_NAME = "default";

/**
 * The lowered defaults at the `grounded` floor. Built on call, not at import:
 * the expansion walks the category registry, and the CLI imports every tool
 * package whether a spec lists it or not.
 */
export function defaultProvabilityConfig(): ProvabilityConfig {
  return {
    level: DEFAULT_FLOOR,
    onFail: "retry",
    maxRetries: 1,
    threshold: 1,
    scope: "session",
    assumptions: "allow",
    render: "footer",
    sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
    grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
    execution: {
      allow: [...expandToolSelectors(DEFAULT_EXECUTION_SELECTORS).tools],
      replay: true,
      maxReplays: 20,
    },
    formal: {
      checkers: ["builtin", "smt"],
      forbid: ["sorry", "axiom", "native_decide"],
      timeoutMs: 30_000,
    },
  };
}

/**
 * A config handed in by a caller, checked once at construction: a tool built
 * on a block with no valid floor would throw on every call instead, far from
 * the mistake. Only the floor is checked — `verifyDocument` reads the rest
 * and refuses what it cannot use, and the lowering already resolved it.
 */
export function assertConfig(config: ProvabilityConfig): ProvabilityConfig {
  if (!isProvabilityLevel(config?.level)) {
    throw new ProvabilityError(
      "config",
      `tool-proof: config.level must be one of cited, grounded, checked, proven (got ${JSON.stringify(
        (config as { level?: unknown } | undefined)?.level,
      )})`,
    );
  }
  return config;
}
