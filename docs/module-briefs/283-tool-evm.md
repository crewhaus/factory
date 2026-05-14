# tool-evm

Status: implemented (slice 0)
Dependency phase: 3 - Model & Tool primitives
Catalog layer: R4 - Built-in Tool Implementations
Origin in ordering: §47 blockchain shapes (slice 0)
Workspace home: packages/tool-evm
Targets: cli, workflow, channel, graph, crew, research, batch (any shape that declares `chains[]`)
Test layers: T1, T3

## Purpose

Built-in read-only EVM tools. Each tool wraps a single JSON-RPC method exposed by `chain-adapter-evm` and presents it to the model as a typed, side-effect-free tool. Slice 0 ships `EvmCall`, `EvmGetLogs`, `EvmGetTransaction`, `EvmGetTransactionReceipt`, `EvmGetBalance`, `EvmBlockNumber`.

## Boundaries

Owns the tool definitions (Zod schemas + descriptions + the `readOnly: true` / `classifyOutput: true` flags) and the `EvmAdapterResolver` registration pattern that lets compiled bundles wire `chains[]` IR entries to concrete adapters at boot.

Does not own destructive tx tools (`tool-evm-tx` lands in slice 1, with `destructive: true` so the permission engine gates approval automatically). Does not own ABI decoding helpers (callers pass and receive raw hex; an ABI gateway lands as `tool-contract-gateway` in slice 1, generating typed tools at compile time).

## Inputs and Outputs

Inputs are `RegisteredTool` records (consumed by the codegen tool catalog) plus a boot-time `setEvmAdapterResolver()` call. Outputs are tool call results — hex strings for reads, JSON-stringified envelopes for receipts and log arrays.

## Dependency Notes

Depends on `@crewhaus/tool-builder`, `@crewhaus/tool-catalog`, `@crewhaus/chain-adapter-base`, `@crewhaus/chain-adapter-evm`, and `zod`. The compiled daemon resolves the adapter resolver from the IR's `chains[]` block — that wiring lands in each `target-*` emitter as part of slice 0's chain-init emit step.

## First Implementation Slice

Slice 0 ships the six read tools, the `EvmAdapterResolver` boot hook, and `EVM_TOOL_MAP` for codegen registration. Tests cover the readOnly flag enforcement, parameter forwarding (including optional `blockTag` and the `eth_getLogs` filter object), and the missing-adapter error message.

## Study References

`packages/tool-fs` and `packages/tool-bash` — same R4 tool-package shape (Zod input, `buildTool()`, RegisteredTool export). `packages/tool-mcp` — the namespace-by-protocol pattern (we use `Evm*` instead of `serverName__toolName` because EVM is one protocol family, not many MCP servers).

Research focus: which read methods are most useful to expose vs. delegated to MCP servers like Alchemy's MCP server. Slice 0 picks the smallest set that closes the read-side of every shape recipe (43–46).

## Validation Plan

Catalog tests: T1 (unit on each tool's input → adapter call mapping), T3 (integration — anvil fork harness in slice 2 once `target-onchain` lands). Primary risks: an agent attempting to use these tools without a configured resolver — covered by the descriptive error path.

Definition of done: tests green, every tool is readOnly + classifyOutput, descriptions explicitly note the slice-1 destructive counterparts (so model authors know not to expect writes here).
