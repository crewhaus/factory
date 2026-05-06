# ir-passes

Status: planned
Dependency phase: 2 - IR & Compiler
Catalog layer: F1 - Spec & IR
Origin in ordering: named in Part G
Workspace home: not created yet; likely packages/ir-passes unless folded into a target bundle
Targets: All
Test layers: T1, T4

## Purpose

Optimization passes: dead-tool elimination, profile pruning, edge fusion, prompt-cache prefix sorting, redundancy collapse.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are spec text, schema versions, includes, and references. Outputs are validated typed spec or IR objects.

## Dependency Notes

Build this after the stable contracts from phase 1. Within phase 2, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`claude-code/.../services/compact/grouping.ts` (sort pattern); `dspy/.../teleprompt/` pass style

Research focus: Pass ordering; idempotence; pluggable pass registry

## Validation Plan

Catalog tests: T1, T4. Primary risk: accidental scope creep beyond the narrow responsibility listed in the catalog.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

