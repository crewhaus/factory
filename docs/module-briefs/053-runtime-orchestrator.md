# runtime-orchestrator

Status: implemented and tested
Dependency phase: 4 - Runtime core
Catalog layer: R1 - Runtime Core (the agent loop)
Origin in ordering: named in Part G
Workspace home: packages/runtime-core
Targets: All
Test layers: T1, T3, T4

## Purpose

The main agent/run loop: turn cycle (model->tool->model), recovery, termination. Streaming chat REPL with full `tool_use` loop - Zod->JSON-Schema for advertised tools, `tool-executor` for invocation, full content-block history so `tool_result` ids resolve. Recovery + compaction still pending.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are run messages, model events, tool events, cancellation, and recovery signals. Outputs are stream events, state transitions, and final run results.

## Dependency Notes

Build this after the stable contracts from phases 1 through 3. Within phase 4, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

The repo already has a tested slice for this module. The next slice should preserve the existing exported surface, add tests before widening behavior, and document any compatibility break in the catalog.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`claude-code/query.ts` (1730-line async-gen loop); `langgraph/.../pregel/_loop.py`; `agent-framework/.../_runner.py`; `openai-agents/.../runner.py`

Research focus: Async-gen vs reactive vs callback; state-machine vs free-form

## Validation Plan

Catalog tests: T1, T3, T4. Primary risk: accidental scope creep beyond the narrow responsibility listed in the catalog.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

