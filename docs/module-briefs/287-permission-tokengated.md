# permission-tokengated

Status: implemented (slice 1)
Dependency phase: 4 - Permissions & Policy
Catalog layer: R8 - Permission, Policy, Safety
Origin in ordering: §47 blockchain shapes (slice 1)
Workspace home: packages/permission-tokengated
Targets: All shapes that wish to gate tool access on token ownership
Test layers: T1, T8

## Purpose

Token-gated entitlement resolver. Reads a `TokenGatedSpec` (chain, contract, requirement, wallet, allowTools) plus the on-chain state, emits a concrete `PermissionRule[]` (`alwaysAllow` if the requirement holds; `alwaysDeny` otherwise). The runtime calls `resolveTokenGatedRules()` at session boot and folds the result into `RuleSet.builtin`; from then on the standard `permission-engine.evaluate()` makes the per-call decision synchronously.

Supports three requirement kinds: `balanceOf` (ERC-20 minimum balance), `ownerOf` (specific ERC-721 tokenId), `hasAny` (ERC-721 balanceOf > 0).

## Boundaries

Owns the resolver, the calldata for `balanceOf(address)` and `ownerOf(uint256)`, the result decoding, and the fail-closed semantics on chain failure. Does not own the rule evaluator itself (`permission-engine` is unchanged), the chain RPC (delegated to `ChainAdapter`), or per-call gating (synchronous evaluation against the resolved rules is the existing R8 path).

The architectural reason this lives outside `permission-engine`: chain lookups are async, `evaluate()` is sync, and adding a chain dep to `permission-engine` would pull R5 (`chain-adapter-base`) upstream of R8's permission core. Keeping the resolver separate keeps the dep arrow `R5 / R8 (tokenGated) → R8 (permission-engine)` rather than introducing a back-edge.

## Inputs and Outputs

Inputs: `TokenGatedSpec[]` plus a chainId→ChainAdapter resolver. Outputs: a flat `PermissionRule[]` (typed `alwaysAllow` / `alwaysDeny`, sourced as `"builtin"`). Throws `TokenGatedError` on configuration mismatch (chainId mismatch, missing adapter) — fail-closed; never silently grant.

## Dependency Notes

Depends on `@crewhaus/chain-adapter-base`, `@crewhaus/errors`, `@crewhaus/permission-engine` (types only — the resolver produces `PermissionRule` records but never imports the evaluator). Used by the runtime at session boot before the first user message; the resolved rules are static for the duration of the session.

## First Implementation Slice

Slice 1 ships the three requirement kinds (`balanceOf`, `ownerOf`, `hasAny`), the batched `resolveTokenGatedRules()` resolver, the fail-closed missing-adapter path, and the deterministic calldata builders for `balanceOf` and `ownerOf`. Tests cover every requirement kind, the chainId-mismatch path, the ownerOf-revert path (non-existent token → alwaysDeny), and the batched-resolution path. Time-windowed requirements (token held at block X) are deferred.

## Study References

EAS attestations, gitcoin passport, and Lit Protocol all encode similar "wallet-met-requirement" → "session has capability" mappings. The §47 slice-1 resolver picks the smallest surface that supports Shape 9 (Tokenized Access) and the credential-check half of Shape 12 (DID).

## Validation Plan

Catalog tests: T1 (per requirement kind), T8 (fail-closed paths: missing adapter, chainId mismatch, ownerOf revert). Primary risks: a malicious RPC node returning a manipulated balance — defeated by `chain-adapter-base.classifyChainPayload` upstream of this resolver; a stale balance check at session start that changes mid-session — out of scope for slice 1 (every session re-resolves; long-lived sessions need a re-resolution policy in slice 2 if real workloads demand it).

Definition of done: tests green, the three requirement kinds are documented in the resolver source, the rule-emission contract matches `permission-engine.PermissionRule` exactly so no downstream changes are needed, and the integration story with the session-boot path is documented (runtime calls the resolver before the first user message; the result is frozen for the session).
