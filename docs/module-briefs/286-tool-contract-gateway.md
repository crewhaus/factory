# tool-contract-gateway

Status: implemented (slice 1)
Dependency phase: 4 - Permissions & Policy
Catalog layer: R4 - Built-in Tool Implementations
Origin in ordering: §47 blockchain shapes (slice 1)
Workspace home: packages/tool-contract-gateway
Targets: cli, workflow, channel, graph, crew (any shape that declares `contracts[]`)
Test layers: T1, T9

## Purpose

Compile-time ABI → typed-tool generator. Given a parsed ABI plus a contract binding, emits one `RegisteredTool` per function: `view`/`pure` mutability → `readOnly: true` tools that delegate to a `ReadExecutor` (`tool-evm.EvmCall` semantics); everything else → `destructive: true` tools that delegate to a `WriteExecutor` (`tool-evm-tx.EvmSendTransaction` semantics through the wallet-engine).

## Boundaries

Owns the ABI → tool-record mapping and the two executor protocols. Does not own ABI parsing (callers supply a parsed ABI; `abi://erc20` resolution lives in the §47 spec layer when slice 1 is wired through codegen), runtime dispatch (delegated to the executors), or calldata encoding (slice 1 leaves encoding to the executors so we don't pull a full ABI encoder into the compile-time path — a follow-up slice may add deterministic encoding for `uint256`, `address`, `bool`, and `bytes` primitives, which cover the common cases).

Tool names are `<contractId>__<methodName>` — same `serverName__toolName` convention `tool-mcp` already uses for MCP-namespaced tools.

## Inputs and Outputs

Inputs: `{ contract: ContractBinding, abi: AbiItem[], readExecutor, writeExecutor }`. Outputs: an array of `RegisteredTool` records in ABI order. Tools `expect()` consumes them via the standard tool-catalog registration path.

## Dependency Notes

Depends on `@crewhaus/tool-builder`, `@crewhaus/tool-catalog`, `@crewhaus/errors`, `zod`. No runtime deps on `tool-evm` / `tool-evm-tx` / `wallet-engine` — the executors abstract those bindings, so the gateway stays a pure compile-time helper.

## First Implementation Slice

Slice 1 ships the function-loop generator, the read/write split by `stateMutability`, the walletId-required check on write tools, and the parameter forwarding in ABI order. Events are skipped (codegen for event-subscription tools is a slice-2 concern alongside `target-onchain`). Tests cover the four mutability paths against the ERC-20 ABI and the walletId-missing failure mode.

## Study References

`packages/tool-mcp` — same compile-time tool-discovery shape applied to a different protocol. Same namespacing convention. The MCP host runs at runtime; the contract gateway runs at compile time — but the resulting `RegisteredTool[]` records are interchangeable in the tool catalog.

## Validation Plan

Catalog tests: T1 (unit per ABI mutability path), T9 (idempotence — the same ABI always produces the same tool set in the same order). Primary risks: an ABI with unnamed inputs (handled via the `arg0`/`arg1` fallback); a `payable` function (handled via the optional `value` field on the write tool's input schema).

Definition of done: tests green, the read/write split is exhaustive over `stateMutability` ∈ `pure | view | nonpayable | payable`, and the tool names follow the `<contractId>__<methodName>` convention so the tool catalog can group + filter by contract.
