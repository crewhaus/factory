# target-onchain-game

Status: implemented (slice 2)
Dependency phase: 2 - IR & Compiler
Catalog layer: F2 - Compiler & Codegen
Origin in ordering: §47 blockchain shapes (slice 2)
Workspace home: packages/target-onchain-game
Targets: ONCHAIN-GAME
Test layers: T1, T3

## Purpose

Codegen for the §47 `onchain-game` perceive-act-perceive loop. Emits a single `agent.ts` from `IrChainGameV0` carrying the single chain/wallet/contract bindings, the game configuration (state reader, turn semantics, optional move timeout, optional objective), the transaction policy, and the boilerplate that boots a chain adapter, reads game state via the configured `stateReader`, classifies the state payload, runs an agent turn to propose a move, and broadcasts the move via the `wallet-engine` flow.

Supports three turn semantics: `turn-based` (wait for opponent), `real-time` (move-timeout-bounded), `async` (subscribe to state-change event, run one turn per inbound mutation).

## Boundaries

Owns the codegen output for the game-loop daemon, the cross-field validation (`wallet.chainId === chain.id`, `game.contract.chainId === chain.id`, `real-time` requires `moveTimeoutMs`), and the placeholder `selectorOf()` helper. Does not own the full game-loop dispatcher (slice 2 emits the perceive helpers; the runtime's loop driver lands in a follow-up slice once a real game like tic-tac-toe is on-chain in CI).

The single-chain / single-wallet design choice is deliberate: games are bound to one chain and one player at a time. Multi-chain games are rare; if a real use case emerges, the variant extends additively without breaking existing specs.

## Inputs and Outputs

Inputs: `IrChainGameV0`. Outputs: a `Bundle` with one file (`agent.ts`) containing exported constants (`SPEC_NAME`, `AGENT_MODEL`, `AGENT_INSTRUCTIONS`, `CHAIN`, `WALLET`, `GAME`, `TRANSACTION_POLICY`) plus three helpers (`buildAdapter()`, `readAndClassifyState()`, `selectorOf()`).

## Dependency Notes

Depends on `@crewhaus/errors`, `@crewhaus/infra-utils`, `@crewhaus/ir`. The generated bundle imports `@crewhaus/boundary-classifier` and `@crewhaus/chain-adapter-evm` at runtime.

## First Implementation Slice

Slice 2 ships the emitter + tests covering: happy-path metadata, env-secret rewriting for wallet keyRef, transaction-policy literal rendering, cross-field validation (wallet vs chain mismatch, contract vs chain mismatch, real-time without moveTimeoutMs). Follow-up slices ship the game-loop runtime, the keccak-256 selector helper (so spec authors can pass method names instead of precomputed 4-byte hex), and the anvil-fork integration test against a real game contract (tic-tac-toe in CI, larger games in production fixtures).

## Study References

`packages/target-voice` and `packages/target-browser-driver` — the two existing perceive-act-loop emitters. Same shape: read a structured input (audio frames / screenshots / game state), run the agent, dispatch a structured output (audio reply / click+type / move tx). The voice variant's barge-in controller is the closest analog to the game variant's `moveTimeoutMs` — both bound the model's per-step spend in a realtime loop.

## Validation Plan

Catalog tests: T1 (unit per emit branch + cross-field validation), T3 (anvil-fork integration in a follow-up). Primary risks: an emitter that produces a bundle whose `readAndClassifyState()` bypasses the §41 classifier (test asserts `classifyBoundary` appears in the generated text and is called with `origin: "chain"`); a real-time game spec without `moveTimeoutMs` (emitter rejects).

Definition of done: tests green, the bundle's `readAndClassifyState()` is provably wired to `classifyBoundary({origin: "chain"})`, and Recipe 47 walks both the Treasury Monitor (`onchain`) and the Dark Forest-style game (`onchain-game`) examples end-to-end.
