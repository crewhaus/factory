# codegen-templates

Status: implemented and tested
Dependency phase: 2 - IR & Compiler
Catalog layer: F2 - Compiler & Codegen
Origin in ordering: inferred from catalog layer F2
Workspace home: packages/target-cli
Targets: All
Test layers: T1

## Purpose

Templates per target (e.g. Bun + Ink CLI, FastAPI service, Rust microservice).

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are canonical IR plus target/profile options. Outputs are generated bundle files, manifests, or packaging metadata.

## Dependency Notes

Build this after the stable contracts from phase 1. Within phase 2, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

The repo already has a tested slice for this module. The next slice should preserve the existing exported surface, add tests before widening behavior, and document any compatibility break in the catalog.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`gstack-main/.../templates/`; `claude-code/.../components/` Ink templates

Research focus: Template engine choice (Handlebars/Jinja/string); diff-friendly emit

## Validation Plan

Catalog tests: T1. Primary risk: accidental scope creep beyond the narrow responsibility listed in the catalog.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

