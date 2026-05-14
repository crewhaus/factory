# wallet-engine

Status: implemented (slice 1)
Dependency phase: 4 - Permissions & Policy
Catalog layer: R8 - Permission, Policy, Safety
Origin in ordering: §47 blockchain shapes (slice 1)
Workspace home: packages/wallet-engine
Targets: All shapes that declare `wallets[]` + `transaction_policy`
Test layers: T1, T8

## Purpose

Custody + sign-request orchestration. Every destructive transaction lands in `requestSignAndBroadcast()`, which simulates first (when the policy requires it), enforces static-checkable invariants (allowed contracts, value caps, simulationRequired), routes through the approval gate, hands the request to a custody adapter keyed by `wallet.custody`, broadcasts, then fetches and classifies the receipt.

## Boundaries

Owns the sign-and-broadcast flow, the `CustodyProvider` interface, the test-only `createLocalSignerStub()`, and the runtime-side defense-in-depth re-check of policy invariants the §47 IR pass also enforces at compile time.

Does not own raw key custody (KMS/HSM/WalletConnect bridges land as separate `wallet-custody-*` packages); does not own the user-facing approval prompt (the runtime maps the wallet-engine's `ApprovalResolver` to the §7 permission engine or the CLI HITL bridge); does not own ABI encoding (callers pass raw 0x-prefixed calldata; the §47 `tool-contract-gateway` produces calldata for typed tools at compile time).

## Inputs and Outputs

Inputs: `UnsignedTx` (chainId, walletId, to, data, optional value/gasLimit, optional contractId), `WalletConfig`, `TransactionPolicy`. Outputs: a `BroadcastReceipt` (tx hash + block + status + Pillar 3 boundary verdict on the receipt body) or a thrown `WalletEngineError` when policy or approval rejects the call.

## Dependency Notes

Depends on `@crewhaus/boundary-classifier`, `@crewhaus/chain-adapter-base`, `@crewhaus/errors`. The chain adapter is supplied via the `resolveAdapter` callback (the runtime binds it at boot from the IR's `chains[]` block). Approval resolution is decoupled by the same pattern — tests inline a deterministic resolver; the runtime wires the permission engine or CLI prompt.

## First Implementation Slice

Slice 1 ships the engine, the `CustodyProvider` interface, the `LocalSignerStub` for tests, and runtime defense-in-depth checks. Tests cover the happy path, policy rejection paths (missing contractId, contractId not in allowedContracts, approval=none without automated custody), simulation gating (failure aborts; required=false skips the eth_call/eth_estimateGas pair), the approval-denied path, and the missing-wiring failure modes. KMS / HSM / WalletConnect custody adapters are deferred to follow-up packages.

## Study References

`packages/permission-engine` — the adjacent R8 module; the wallet-engine layers on top of permissions, not parallel to. The `ApprovalResolver` callback signature mirrors how the runtime threads permission decisions today.

Research focus: what flow primitives MetaMask, WalletConnect, and the Safe transaction service all need (simulate → policy → approval → sign → broadcast → receipt) — the engine encodes the minimum common contract.

## Validation Plan

Catalog tests: T1 (unit on every policy branch), T8 (security — defense-in-depth re-check, fail-closed missing-wiring). Primary risks: an adapter that bypasses `classifyBoundary` on the receipt body — the engine always calls the classifier on the receipt before returning. A custody provider that silently fails — surfaced as a `WalletEngineError` with the underlying cause attached.

Definition of done: tests green, every `destructive: true` tool in the repo that signs transactions routes through this engine (slice 1 ships `@crewhaus/tool-evm-tx` as the first consumer), and the `crewhaus doctor` audit treats `wallet-engine` as the canonical R8 chokepoint for transaction signing.
