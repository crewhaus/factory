# prompt-optimizer

Status: shipped (rule-based search v0). The model-driven mutation provider lives in [`prompt-optimizer-claude`](280-prompt-optimizer-claude.md) (brief 280); the orchestration that closes the active-optimisation loop lives in [`eval-optimizer-orchestrator`](279-eval-optimizer-orchestrator.md) (brief 279). User-facing entry: [`crewhaus optimize`](../../apps/cli/src/index.ts) ([recipe 42](../recipes/42-active-optimization.md)).
Dependency phase: 9 - Telemetry & eval
Catalog layer: R15 - Telemetry, Tracing, Eval
Origin in ordering: named in Part G
Workspace home: `packages/prompt-optimizer/`
Targets: EVAL, CLI (advanced)
Test layers: T1, T5

## MutationProvider seam (added under Pillar 2 remediation)

The original v0 of this package shipped 4 rule-based mutations hard-coded into the `optimize()` loop. The realignment refactored these into a `MutationProvider` interface so the search loop is decoupled from the mutation source:

```ts
export interface MutationProvider {
  readonly name: string;
  next(state: OptimizerState): Promise<ProviderMutation>;
}
```

Two providers ship today:

- `RuleBasedMutationProvider` (this package; default) — deterministic, seeded, ships the original 4 mutations.
- `ClaudeMutationProvider` (`@crewhaus/prompt-optimizer-claude`; opt-in via `--mutator claude`) — model-driven rewriting that closes the L91 comment's gap.

Future providers (a DSPy-bridge variant, an OPRO implementation, a domain-specific mutator) plug in via the same interface without touching the search loop.

## Purpose

DSPy-style automatic prompt optimization (MIPRO, BootstrapFewShot).

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are traces, metrics, datasets, grader configs, and run records. Outputs are spans, metrics, replay data, grades, and reports.

## Dependency Notes

Build this after the stable contracts from phases 1 through 8. Within phase 9, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`dspy/.../teleprompt/`,`dspy/.../predict/`,`dspy/.../optimization/`; `adk-python/.../optimization/`

Research focus: Optimizer choice; budget

## Validation Plan

Catalog tests: T1, T5. Primary risks: quality regressions that only show up through eval or trace grading.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

