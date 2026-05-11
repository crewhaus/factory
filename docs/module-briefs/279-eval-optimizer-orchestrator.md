# Module brief 279 — `eval-optimizer-orchestrator`

**Catalog layer:** F-eval.
**Pillar:** Pillar 2 — closes the active optimisation loop.
**Source:** [`packages/eval-optimizer-orchestrator/src/index.ts`](../../packages/eval-optimizer-orchestrator/src/index.ts).

## Responsibility

The glue that ties `prompt-optimizer` (search), `spec-patch` (structured mutation), and a caller-supplied fitness function (typically backed by `eval-runner`) into a single user-facing workflow. Drives the `crewhaus optimize` CLI subcommand.

Without this package, `prompt-optimizer` is an orphaned search function with no way to turn its winning candidate back into a YAML change the user can commit.

## Public surface

```ts
export type OptimizeSpecOptions = {
  readonly specPath: string;
  readonly fitness: FitnessFn;
  readonly trainSet: ReadonlyArray<Sample>;
  readonly devSet: ReadonlyArray<Sample>;
  readonly mutator?: MutationProvider;
  readonly iterations?: number;
  readonly improvementThreshold?: number;
  readonly outDir?: string;
  readonly writeBack?: boolean;
  readonly runId?: string;
  readonly seed?: number;
};

export type OptimizeSpecResult = {
  readonly runId: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly improvement: number;
  readonly applied: boolean;
  readonly patch: SpecPatch;
  readonly patchedYaml: string;
  readonly writtenTo?: string;
  readonly outDir: string;
  readonly trajectory: ReadonlyArray<Candidate>;
};

export async function optimizeSpec(opts: OptimizeSpecOptions): Promise<OptimizeSpecResult>;

// Re-exports for caller convenience
export { applySpecPatch, validatePatch } from "@crewhaus/spec-patch";
export type { SpecPatch } from "@crewhaus/spec-patch";
```

## Behaviour

1. Reads the source `crewhaus.yaml`.
2. Locates the agent's current `instructions` block via `extractCurrentPrompt(spec)` — supports every single-agent target shape (`cli`, `channel`, `managed`, `pipeline`, `research`, `batch`, `voice`, `browser`, `eval`).
3. Drives `prompt-optimizer.optimize()` with the caller-supplied fitness function.
4. Converts the winning prompt into a `SpecPatch` against `["agent", "instructions"]`.
5. Validates the patch via `validatePatch` (cross-target + `OPTIMIZABLE_PATHS` check).
6. Applies the patch via `applySpecPatch` (CST round-trip — comments preserved).
7. Persists `patch.json`, `report.json`, `trajectory.json`, `best.json` under `outDir`.
8. Optionally writes the patched YAML back to disk with a leading header comment when `writeBack: true` and `improvement >= improvementThreshold`.

## v0 limitations

- Only `agent.instructions` is mutated. Workflow / crew / graph shapes (with nested prompts) raise `OptimizeSpecError` pointing at a follow-up for `--path <step.instructions>` support.
- The fitness function is the caller's responsibility. The CLI's `crewhaus optimize` wraps `eval-runner.runEval()` to provide one; the package itself stays decoupled so test harnesses can supply synthetic fitness.
- No budget cap on Claude-driven runs (the CLI flag is reserved as `--budget-usd N`; the wiring through `cost-tracker` is a follow-up).

## Depends on

- `@crewhaus/errors`
- `@crewhaus/eval-dataset` (Sample type)
- `@crewhaus/prompt-optimizer` (114) — search loop
- `@crewhaus/spec` — parser
- `@crewhaus/spec-patch` (278) — mutation

## Unblocks

- `crewhaus optimize` CLI subcommand
- Future Studio panel for "Optimise this spec"
- Plugin-extensible optimisation paths (different `MutationProvider`s)

## Tests

- `end-to-end.test.ts` — synthetic fitness function, verifies score delta + patch shape + persistence
- `write-back.test.ts` — confirms YAML CST round-trip preserves comments under `writeBack: true`
- `applied-threshold.test.ts` — confirms `applied: false` when improvement is below threshold
- `target-restriction.test.ts` — confirms workflow/graph/crew targets raise the v0 error

## Risk markers

🟡 (medium risk) — depends on prompt-optimizer's search loop semantics. If the search loop changes shape (e.g. introduces parallel candidates), the orchestrator's `result.improvement` arithmetic needs to be re-derived. The trajectory test asserts the current contract.
