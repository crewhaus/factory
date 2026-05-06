# target-eval-bundle

Status: planned
Dependency phase: 2 - IR & Compiler
Catalog layer: F2 - Compiler & Codegen
Origin in ordering: inferred from catalog layer F2
Workspace home: not created yet; likely packages/target-eval-bundle unless folded into a target bundle
Targets: **EVAL**
Test layers: T1, T5

## Purpose

Codegen for eval harness: dataset loader, runner, graders, report writer.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are canonical IR plus target/profile options. Outputs are generated bundle files, manifests, or packaging metadata.

## Dependency Notes

Build this after the stable contracts from phase 1. Within phase 2, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`lm-evaluation-harness/lm_eval/`, `helm/benchmark/`, `ragas/.../evaluate.py`

Research focus: Task spec format; reproducibility

## Validation Plan

Catalog tests: T1, T5. Primary risks: quality regressions that only show up through eval or trace grading.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

