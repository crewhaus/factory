# chain-adapter-base

Status: implemented (slice 0)
Dependency phase: 3 - Model & Tool primitives
Catalog layer: R5 - MCP & Protocol Hosts
Origin in ordering: §47 blockchain shapes (slice 0)
Workspace home: packages/chain-adapter-base
Targets: All (cross-cutting subsystem; consumed by any shape that declares `chains[]`)
Test layers: T1, T8

## Purpose

Defines the `ChainAdapter` interface, the read-only JSON-RPC method allowlist, and the `classifyChainPayload` wrap-on-read helper. Concrete adapters (`chain-adapter-evm`, future `chain-adapter-solana`) implement the interface; everyone calls `classifyChainPayload` before any byte from an external node reaches a model context or tool result.

## Boundaries

Owns the abstract contract for chain access, the slice-0 read-method allowlist (`eth_call`, `eth_getLogs`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`/`Hash`, `eth_blockNumber`, `eth_chainId`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_estimateGas`, `eth_feeHistory`, `eth_gasPrice`, `net_version`), and the Pillar 3 classifier wrapper with `origin: "chain"`.

Does not own concrete RPC dispatch (that's `chain-adapter-evm`), wallet/signing (that's `wallet-engine` in slice 1), nor any tool definitions (that's `tool-evm`). Anything that writes to a chain (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_sign`, etc.) is intentionally absent from the read allowlist — signing flows must route through `wallet-engine` and the permission engine, not through chain adapters.

## Inputs and Outputs

Inputs are `ChainAdapterConfig` records (chainId, rpcUrls, rpcPolicy, finality, reorgTolerant). Outputs are `ChainAdapter` instances (constructed by concrete adapters) plus the `classifyChainPayload` / `assertReadOnlyMethod` / `orderRpcUrls` helpers used by adapters and tools.

## Dependency Notes

Depends on `@crewhaus/errors` and `@crewhaus/boundary-classifier`. Build this after phase 2 stable contracts. The §47 IR pass (slice 1) will additionally validate that no spec references a chain `kind` that has no concrete adapter registered.

## First Implementation Slice

The slice-0 cut ships the `ChainAdapter` interface, the read-method allowlist, the `classifyChainPayload` chokepoint, and the `orderRpcUrls` helper for single/quorum/fallback policies. Tests cover the read/write split (signing methods throw), the malicious-payload redaction path, and the URL-ordering policies.

## Study References

`packages/channel-adapter-base` — same adapter-base pattern for §33 inbound channels. Both define an abstract interface, both delegate verification + classification to dedicated subsystems, both leave concrete protocol mechanics to per-protocol packages.

Research focus: keeping the abstract contract dependency-light so non-EVM adapters can land later without dragging the whole stack.

## Validation Plan

Catalog tests: T1 (unit on the interface and helpers), T8 (security — write-method allowlist, classifier integration). Primary risks: a future adapter forgetting to call `classifyChainPayload` before returning bytes — this is enforced by code-review and the `crewhaus doctor --philosophy-alignment` audit (which grep's for `classifyBoundary` / `classifyChainPayload` inside every `chain-adapter-*` package).

Definition of done: tests green, the read-method allowlist is documented inline, and the `crewhaus doctor --philosophy-alignment` audit treats every `chain-adapter-*` package the same way it treats `tool-mcp` / `sub-agent-spawner` (boundary site that must classify).
