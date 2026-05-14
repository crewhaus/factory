# tool-evm-tx

Status: implemented (slice 1)
Dependency phase: 4 - Permissions & Policy
Catalog layer: R4 - Built-in Tool Implementations
Origin in ordering: §47 blockchain shapes (slice 1)
Workspace home: packages/tool-evm-tx
Targets: cli, workflow, channel, graph, crew, batch (any shape that declares `wallets[]` + `transaction_policy`)
Test layers: T1, T3, T8

## Purpose

Destructive EVM transaction tools. `EvmSendTransaction` (destructive) signs and broadcasts a transaction through the §47 wallet-engine flow; `EvmSimulate` (read-only) provides a pre-flight check the agent can run before requesting approval.

## Boundaries

Owns the two destructive transaction tools and the boot-time resolver registrations (`setWalletResolver`, `setTransactionPolicyResolver`, `setWalletEngineResolver`). Does not own simulation logic (delegated to `wallet-engine.simulate`), approval prompting (the wallet-engine's `ApprovalResolver` callback is supplied by the runtime), or contract ABI encoding (callers pass raw 0x-calldata; `tool-contract-gateway` is the compile-time path for typed contract methods).

The two-gates-by-design property is the load-bearing safety invariant: the §7 permission engine gates *whether* the tool may run; the wallet-engine gates *what the transaction may do*. Both must approve; either can refuse. Slice 1 takes care to keep the gates independent — a permission rule that blanket-allows `EvmSendTransaction` does not bypass `transaction_policy.allowedContracts`.

## Inputs and Outputs

Inputs are `EvmSendTransaction({walletId, contractId?, to, data, value?, gasLimit?})` and `EvmSimulate({walletId, to, data, value?})`. Outputs are JSON-stringified receipts (sendTransaction) or sim envelopes (simulate). Errors propagate as thrown `Error`s with the wallet-engine's contextual message.

## Dependency Notes

Depends on `@crewhaus/tool-builder`, `@crewhaus/tool-catalog`, `@crewhaus/chain-adapter-base`, `@crewhaus/wallet-engine`, `zod`. The runtime binds the three resolver callbacks before the tool catalog is consulted; tests inline.

## First Implementation Slice

Slice 1 ships `EvmSendTransaction` (`destructive: true`, `classifyOutput: true`) and `EvmSimulate` (`readOnly: true`). Tests cover the happy path receipt-return, contractId allowlist enforcement, approval-denied bypass, and simulate-only branch. Future slices may add `EvmSendBatch` (for L2 batchers) and `EvmEstimateGas` if call sites demand them.

## Study References

`packages/tool-fs` (destructive: true on Write/Edit; the permission engine integration is already wired generically — this package just needs the boolean set correctly). `packages/tool-mcp` (namespace-by-protocol naming convention).

## Validation Plan

Catalog tests: T1 (unit on each tool's wallet-engine dispatch), T3 (integration — anvil fork in slice 2 once `target-onchain` lands), T8 (security — destructive flag set, approval and contract-allowlist gates fire independently). Primary risks: an agent passing a `contractId` not in `transaction_policy.allowedContracts` — the wallet-engine refuses, but the tool should also publish a clear error message so the agent can self-correct.

Definition of done: tests green, the two-gates invariant has at least one test asserting that a permission-engine allow does not bypass wallet-engine refusal, and the catalog brief notes the runtime contract for the three boot-time resolvers.
