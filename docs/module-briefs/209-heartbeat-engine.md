# heartbeat-engine

Status: planned
Dependency phase: 16 - Scheduling
Catalog layer: R14 - Scheduling & Background
Origin in ordering: named in Part G
Workspace home: not created yet; likely packages/heartbeat-engine unless folded into a target bundle
Targets: CHN
Test layers: T1, T3

## Purpose

Periodic system event for "anything to do?"; HEARTBEAT_OK suppression.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are schedules, queue messages, retry state, and background work intents. Outputs are enqueued runs, wakeups, and progress records.

## Dependency Notes

Build this after the stable contracts from phases 1 through 15. Within phase 16, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`openclaw/.../cron/heartbeat-policy.ts`

Research focus: Suppression logic

## Validation Plan

Catalog tests: T1, T3. Primary risk: accidental scope creep beyond the narrow responsibility listed in the catalog.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

