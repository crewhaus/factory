# target-onchain

Status: implemented (slice 2)
Dependency phase: 2 - IR & Compiler
Catalog layer: F2 - Compiler & Codegen
Origin in ordering: §47 blockchain shapes (slice 2)
Workspace home: packages/target-onchain
Targets: ONCHAIN
Test layers: T1, T3

## Purpose

Codegen for the §47 `onchain` event-driven daemon. Emits a single `agent.ts` from `IrChainV0` carrying the configured chains, wallets, contracts, triggers, transaction policy, and the boilerplate that boots a chain adapter, dedupes inbound events by `(txHash, logIndex)` within `idempotencyWindowMs`, classifies decoded event payloads via `classifyBoundary({origin: "chain"})`, and dispatches one agent turn per accepted event.

## Boundaries

Owns the codegen output (the single `agent.ts` file with exported constants + helpers), the secret-rewriting for `rpcUrls` and `keyRef` (via `IrSecretRef`), and the validation that triggers reference declared chains. Does not own the runtime event-subscription loop, the `runChatLoop` dispatcher, or any chain-specific RPC mechanics (those are in `chain-adapter-evm`, `wallet-engine`, and the runtime that consumes the generated bundle).

Slice 2 scope: emit the metadata + boot helpers. The full event-subscription loop (poll for new logs, dedupe, dispatch to the agent, await receipt) lands in a follow-up slice once the runtime accepts structured payloads directly. Until then, the emitted bundle is a callable module that the slice-2 integration tests import and exercise piecewise.

## Inputs and Outputs

Inputs: `IrChainV0`. Outputs: a `Bundle` with one file (`agent.ts`) containing exported constants (`SPEC_NAME`, `AGENT_MODEL`, `AGENT_INSTRUCTIONS`, `CHAINS`, `WALLETS`, `CONTRACTS`, `TRIGGERS`, `TRANSACTION_POLICY`, `IDEMPOTENCY_WINDOW_MS`) plus two helpers (`buildAdapters()`, `acceptOrRedact()`).

## Dependency Notes

Depends on `@crewhaus/errors`, `@crewhaus/infra-utils`, `@crewhaus/ir`. The generated `agent.ts` imports `@crewhaus/boundary-classifier` and `@crewhaus/chain-adapter-evm` at runtime; those become workspace deps of any bundle that ships an `onchain` target. No new compiler-level deps.

## First Implementation Slice

Slice 2 ships the emitter + tests covering: happy-path metadata, env-secret rewriting, literal-secret rendering, all three trigger kinds (`event` / `block` / `address`), `transaction_policy` literal rendering, empty-chains rejection, empty-triggers rejection, undeclared-chainId trigger rejection. Follow-up slices wire the event-subscription loop and the anvil-fork integration tests.

## Study References

`packages/target-channel-bot` — the daemon-style emitter analog (also event-driven, also classifies inbound payloads, also runs one agent turn per accepted event). `packages/target-batch-worker` — the queue-consumer analog (also dedupes by idempotency key, also signals JSON events to stdout).

## Validation Plan

Catalog tests: T1 (unit on every emit branch), T3 (integration — anvil-fork roundtrip in a follow-up slice). Primary risks: an emitter that forgets to call `classifyBoundary` on inbound event payloads (the test asserts the generated `acceptOrRedact()` helper exists and is wired); a trigger that references an undeclared chainId (caught by the emitter's validation step before any bundle is produced).

Definition of done: tests green, the `crewhaus doctor --philosophy-alignment` audit treats `target-onchain` as a §41 boundary site (the generated bundle calls `classifyBoundary({origin: "chain"})`), and Recipe 47 walks the spec → IR → bundle → daemon flow end-to-end.
