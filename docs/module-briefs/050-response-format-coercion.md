# response-format-coercion

Status: planned
Dependency phase: 3 - Model & Tool primitives
Catalog layer: R2 - Model Layer
Origin in ordering: inferred from catalog layer R2
Workspace home: not created yet; likely packages/response-format-coercion unless folded into a target bundle
Targets: All
Test layers: T1, T2, T9

## Purpose

Force structured/JSON output; schema validation; retry-on-malformed.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are normalized messages, tool schemas, model policy, credentials, and budget constraints. Outputs are model responses, usage data, and routing decisions.

## Dependency Notes

Build this after the stable contracts from phases 1 through 2. Within phase 3, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`dspy/.../predict/`; `openai-agents/.../agent_output.py`; `openclaw/.../agents/anthropic-payload-policy.ts`

Research focus: Provider-native vs prompted JSON; coercion ladders

## Validation Plan

Catalog tests: T1, T2, T9. Primary risks: contract drift with providers or protocols; edge cases best caught by fuzz or property checks.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

