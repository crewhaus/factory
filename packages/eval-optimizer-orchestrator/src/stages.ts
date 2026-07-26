/**
 * Evals Wave 5, cluster O (D36 — optimize half) — stage enumeration for
 * MULTI-STAGE specs.
 *
 * Wave 4 lifted the eval-side rejection: workflow / graph / crew / pipeline
 * now bridge to their REAL compiled runtimes. This module is the optimize-side
 * half: it names the per-stage prompt paths a search may rewrite, and every
 * path it returns is ALREADY inside `spec-patch`'s `OPTIMIZABLE_PATHS`
 * whitelist (`["steps"]` / `["nodes"]` / `["roles"]` cover their descendants
 * by prefix; pipeline's `["agent","instructions"]` is an exact entry). Nothing
 * here widens the optimizer's surface — it only makes the already-whitelisted
 * surface reachable.
 *
 * What is NOT a stage:
 *   - `kind: judge` workflow steps and graph nodes. They run no agent turn and
 *     carry no `instructions` (the spec schema rejects the key), so there is
 *     nothing to rewrite. They still execute inside the bridged run — the
 *     judge gate is measured, just not mutated.
 *
 * Stage ORDER is the spec's own declaration order (workflow: step order;
 * graph/crew: YAML key order as the parser preserved it), so a sequential
 * multi-stage run walks the flow the way an author reads it.
 */
import type { Spec } from "@crewhaus/spec";
import { OPTIMIZABLE_PATHS } from "@crewhaus/spec-patch";

/** The stage noun each multi-stage shape uses in its spec + diagnostics. */
export type StageKind = "step" | "node" | "role" | "agent";

/** One rewritable prompt inside a spec. */
export type OptimizableStage = {
  /** The stage's name as the author wrote it (pipeline: the literal `agent`). */
  readonly name: string;
  readonly kind: StageKind;
  /**
   * The `spec-patch` path to this stage's instructions, e.g.
   * `["steps", "0", "instructions"]` / `["nodes", "plan", "instructions"]`.
   * Numeric segments are strings — `applySpecPatch`'s CST coerces them for
   * sequences (see `SpecEdit`'s path docs).
   */
  readonly path: ReadonlyArray<string>;
  /** The stage's current instructions — the search's starting prompt. */
  readonly instructions: string;
};

/**
 * Whether a target has more than one rewritable prompt (and therefore needs
 * `--stage` / sequential gating). Pipeline is bridged like the multi-stage
 * shapes but carries exactly ONE prompt, so it is deliberately excluded.
 */
export const MULTI_PROMPT_TARGETS: ReadonlySet<Spec["target"]> = Object.freeze(
  new Set<Spec["target"]>(["workflow", "graph", "crew"]),
);

/**
 * Enumerate the prompts a search may rewrite in `spec`.
 *
 * Single-agent shapes return exactly one stage at `["agent","instructions"]`
 * — the historical optimize surface, expressed as a one-element list so the
 * CLI has one code path. Multi-stage shapes return one entry per agent-running
 * step/node/role.
 */
export function listOptimizableStages(spec: Spec): ReadonlyArray<OptimizableStage> {
  switch (spec.target) {
    case "workflow": {
      const out: OptimizableStage[] = [];
      spec.steps.forEach((step, i) => {
        // Judge gates run no agent turn — nothing to rewrite.
        if (!("instructions" in step)) return;
        out.push({
          name: step.name,
          kind: "step",
          path: Object.freeze(["steps", String(i), "instructions"]),
          instructions: step.instructions,
        });
      });
      return Object.freeze(out);
    }
    case "graph": {
      const out: OptimizableStage[] = [];
      for (const [name, node] of Object.entries(spec.nodes)) {
        if (!("instructions" in node)) continue;
        out.push({
          name,
          kind: "node",
          path: Object.freeze(["nodes", name, "instructions"]),
          instructions: node.instructions,
        });
      }
      return Object.freeze(out);
    }
    case "crew": {
      const out: OptimizableStage[] = [];
      for (const [name, role] of Object.entries(spec.roles)) {
        out.push({
          name,
          kind: "role",
          path: Object.freeze(["roles", name, "instructions"]),
          instructions: role.instructions,
        });
      }
      return Object.freeze(out);
    }
    default:
      return Object.freeze([
        {
          name: "agent",
          kind: "agent" as const,
          path: Object.freeze(["agent", "instructions"]),
          instructions: spec.agent.instructions,
        },
      ]);
  }
}

/** `draft, polish` — the vocabulary an unknown-stage error prints. */
export function formatStageNames(stages: ReadonlyArray<OptimizableStage>): string {
  return stages.map((s) => s.name).join(", ");
}

/**
 * Resolve a `--stage <name>` request against the enumerated stages. Returns
 * `undefined` when the name matches nothing — the caller owns the error text
 * (the CLI's `die()` vs the orchestrator's `OptimizeSpecError`), but
 * {@link formatStageNames} keeps the vocabulary line identical on both.
 */
export function findStage(
  stages: ReadonlyArray<OptimizableStage>,
  name: string,
): OptimizableStage | undefined {
  return stages.find((s) => s.name === name);
}

/**
 * Guard rail for the enumeration above: every emitted path must be inside the
 * target's `OPTIMIZABLE_PATHS` whitelist by the same prefix rule `validatePatch`
 * applies. Exported so the CLI and the tests can assert it cheaply without
 * re-deriving spec-patch's matcher; `validatePatch` remains the authority on
 * the real patch.
 */
export function stagePathIsWhitelisted(
  target: Spec["target"],
  path: ReadonlyArray<string>,
): boolean {
  const allowed = OPTIMIZABLE_PATHS[target];
  for (const ok of allowed) {
    if (path.length < ok.length) continue;
    let match = true;
    for (let i = 0; i < ok.length; i++) {
      if (ok[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
