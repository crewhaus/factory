# tenancy

Status: planned
Dependency phase: 1 - Foundations
Catalog layer: R17 - Infrastructure & Cross-Cutting
Origin in ordering: inferred from catalog layer R17
Workspace home: not created yet; likely packages/tenancy unless folded into a target bundle
Targets: MGD
Test layers: T1, T3, T8

## Purpose

Multi-tenant isolation (tenant-id, quotas, billing).

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are config files, env, process state, runtime version, and host metadata. Outputs are normalized infrastructure services for higher layers.

## Dependency Notes

This is in the foundation phase. It should have minimal dependencies and must not pull in model SDKs, UI packages, or target-specific code.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`AI-Harness-Systems.md` section`tenant_id`; AgentCore tenant model

Research focus: Quota model

## Validation Plan

Catalog tests: T1, T3, T8. Primary risks: security boundaries and policy bypasses.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

