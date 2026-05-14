# chain-adapter-evm

Status: implemented (slice 0)
Dependency phase: 3 - Model & Tool primitives
Catalog layer: R5 - MCP & Protocol Hosts
Origin in ordering: §47 blockchain shapes (slice 0)
Workspace home: packages/chain-adapter-evm
Targets: All (consumed by any shape that declares `chains[]` with `kind: "evm"`)
Test layers: T1, T3, T8

## Purpose

Concrete EVM JSON-RPC adapter. Implements `ChainAdapter` from `chain-adapter-base` for any EVM-compatible chain (Ethereum, Base, Arbitrum, Optimism, Polygon, …). Dispatches read-only methods, applies the configured `rpcPolicy` (single / fallback / quorum), and routes every response through the §41 boundary classifier with `origin: "chain"` before parsing the JSON-RPC envelope.

## Boundaries

Owns the EVM JSON-RPC wire format, the multi-URL dispatch policies, the network-error → adapter-error mapping, and the classifier-on-text-before-parse ordering (so a malicious payload can never reach the JSON parser even if the JSON would itself look benign).

Does not own non-EVM chains (separate adapters), wallet/signing (`wallet-engine` in slice 1), nor ABI-encoded calldata construction (callers pass `data` ready to send). Quorum semantics are strict-majority over `JSON.stringify(result)`; that's deliberate to defeat malicious nodes that return slightly-different shaped data.

## Inputs and Outputs

Inputs are `ChainAdapterConfig` records plus an optional `fetchImpl` override for tests. Outputs are `ChainAdapter` instances whose `rpcRead(method, params)` returns the decoded JSON-RPC result after classifier approval.

## Dependency Notes

Depends on `@crewhaus/chain-adapter-base`, `@crewhaus/boundary-classifier`, `@crewhaus/errors`. No runtime dep on `@crewhaus/ir` — the runtime instantiates this adapter from the IR's `chains[]` block via the `wallet-engine` resolver path (slice 1) or the compiled daemon's boot code.

## First Implementation Slice

Slice 0 ships the `createEvmAdapter()` factory, JSON-RPC dispatch with single/fallback/quorum policies, the classifier wrap-on-text, and JSON-RPC error envelope mapping to typed `ChainAdapterError`. Tests cover the read/write split, fallback retry, quorum strict-majority and quorum-threshold-failure paths, and the malicious-payload refusal path.

## Study References

`packages/channel-adapter-slack` — concrete adapter for a single protocol following the same shape (config in, classify boundary on inbound bytes, typed errors on misuse). Same pattern translated from "messaging" to "RPC."

Research focus: how viem / ethers / web3.js handle multi-URL fallback and reorg awareness. (We deliberately do NOT depend on any of those — slice 0 stays zero-deps so the adapter is auditable end-to-end.)

## Validation Plan

Catalog tests: T1 (unit on policies + classifier path), T3 (integration — anvil fork harness in slice 2 once `target-onchain` lands), T8 (security — write-method refusal + classifier integration). Primary risks: a non-EVM RPC node returning unexpected shapes (defeated by JSON-parse-after-classify), a single misbehaving node poisoning quorum (defeated by strict-majority over JSON-equal results).

Definition of done: tests green, three policies have direct coverage, the classifier path has a malicious-input test, and the `crewhaus doctor` audit notes `chain-adapter-evm` as a §41 boundary site.
