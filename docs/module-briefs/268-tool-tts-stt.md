# tool-tts-stt

Status: planned
Dependency phase: 20 - Specialized + per-shape final modules
Catalog layer: R4 - Built-in Tool Implementations
Origin in ordering: expanded from voice-specific extras
Workspace home: not created yet; likely packages/tool-tts-stt unless folded into a target bundle
Targets: CHN, VOICE
Test layers: T1, T2, T7

## Purpose

TTS + speech-to-text tools.

This module should be the single owner for that concern. Keep the boundary small enough that generated targets can compose it without inheriting unrelated runtime policy.

## Boundaries

Owns the behavior named above, its typed public contract, and the fixtures needed to prove it. It should expose boring, explicit APIs rather than requiring callers to know internal storage or provider details.

Does not own neighboring concerns from the same phase unless the catalog explicitly says so. If implementation pressure suggests merging modules, keep the module names visible as exported interfaces so the catalog can still map to code.

## Inputs and Outputs

Inputs are tool definitions or tool-call payloads. Outputs are registered tools, validated inputs, permission decisions, and normalized tool results.

## Dependency Notes

Build this after the stable contracts from phases 1 through 19. Within phase 20, earlier numeric briefs are the preferred stabilization order, but independent modules can still be developed in parallel if their write sets do not overlap.

## First Implementation Slice

Start with a minimal typed interface, an in-memory or no-op implementation where possible, and focused tests for the catalog responsibility. Wire it to one nearby consumer only after the contract is stable.

A good first PR should include package metadata, the public entrypoint, unit tests for happy and failure paths, and one README or doc comment showing how the next layer imports it.

## Study References

`openclaw/tts/`; `openai-agents/.../voice/`; `openclaw/.../realtime-voice/`,`realtime-transcription/`

Research focus: Codec choice; streaming

## Validation Plan

Catalog tests: T1, T2, T7. Primary risks: load, long-run behavior, and storage pressure; contract drift with providers or protocols.

Definition of done: tests are green, public types are exported from the intended workspace, failure modes use typed `CrewhausError`-style errors where applicable, and the catalog status can be updated without hand-waving.

