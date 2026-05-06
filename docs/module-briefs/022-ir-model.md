# ir-model

Status: implemented and tested
Dependency phase: 2 - IR & Compiler
Catalog layer: F1 - Spec & IR
Origin in ordering: named in Part G
Workspace home: packages/ir
Targets: All
Test layers: T1

## Purpose

Canonical typed IR: agents, nodes, edges, events, tools, policies, memory, evals, channels, schedule. Runtime-agnostic. `IrV0` currently carries name, target, agent, and `tools: readonly string[]`.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are spec text, schema versions, includes, and references. Outputs are validated typed spec or IR objects.

## Dependency Notes

Build this after the stable contracts from phase 1. Within phase 2, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

The repo already has a tested slice for this module. The next slice should preserve the existing exported surface, add tests before widening behavior, and document any compatibility break in the catalog.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`AI-Harness-Systems.md` sectionIR schema; `agent-framework/.../_workflow_builder.py`; LangGraph graph IR; ADK declarative IR

Research focus: Single IR vs multiple? Event encoding (envelope vs typed message); type system depth

## Validation Plan

Catalog tests: T1. Primary risk: accidental scope creep beyond the narrow responsibility listed in the catalog.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

