# infra-utils

Status: implemented and tested
Dependency phase: 1 - Foundations
Catalog layer: R17 - Infrastructure & Cross-Cutting
Origin in ordering: named in Part G
Workspace home: packages/infra-utils
Targets: All
Test layers: T1

## Purpose

Common: paths, env, fs, json, retry, time, ids.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are config files, env, process state, runtime version, and host metadata. Outputs are normalized infrastructure services for higher layers.

## Dependency Notes

This is in the foundation phase. It should have minimal dependencies and must not pull in model SDKs, UI packages, or target-specific code.

## First Implementation Slice

The repo already has a tested slice for this module. The next slice should preserve the existing exported surface, add tests before widening behavior, and document any compatibility break in the catalog.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`openclaw/.../infra/`,`shared/`,`utils/`; `claude-code/.../utils/`; `agent-framework/.../utils/`

Research focus: API stability

## Validation Plan

Catalog tests: T1. Primary risk: accidental scope creep beyond the narrow responsibility listed in the catalog.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

