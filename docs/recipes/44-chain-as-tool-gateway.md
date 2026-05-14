# Recipe 44 — Chain as typed-tool gateway (ABI → tools)

**Pillar:** Pillar 1 (the compiler is the protagonist — typed surfaces at compile time, not runtime).
**Catalog modules:** `tool-contract-gateway` (R4, brief 286), `tool-evm` (R4, brief 283), `tool-evm-tx` (R4, brief 285).
**Target shape:** any (the gateway runs at compile time; the generated tools work in `cli`/`workflow`/`channel`/`graph`/`crew`).

## What this recipe shows

Shape 3 (Smart-Contract Tool Gateway) and the read half of Shape 2 (On-Chain Verifier), Shape 5 (Multi-Chain Router), and Shape 7 (Proof-Carrying Agent). The contract gateway converts an ABI into typed `RegisteredTool` records at compile time: `view` / `pure` functions become `readOnly: true` tools that delegate to `EvmCall`; `nonpayable` / `payable` functions become `destructive: true` tools that delegate to `EvmSendTransaction` (and therefore go through the `wallet-engine` two-gate flow).

The naming convention is `<contractId>__<methodName>` — the same `serverName__toolName` pattern `tool-mcp` uses for MCP-namespaced tools.

## TL;DR — at compile time

```ts
import { generateContractTools } from "@crewhaus/tool-contract-gateway";

const tools = generateContractTools({
  contract: { id: "usdc", chainId: "base-mainnet", address: "0x833...913" },
  abi: erc20Abi,  // parsed JSON ABI
  readExecutor: async ({ chainId, to, methodName, inputs }) => {
    // Wire to tool-evm.EvmCall under the hood.
    return await evmCall({ chainId, to, data: encode(methodName, inputs) });
  },
  writeExecutor: async ({ walletId, chainId, contractId, to, methodName, inputs, value }) => {
    // Wire to tool-evm-tx.EvmSendTransaction under the hood.
    return await evmSendTransaction({
      walletId, contractId, to, data: encode(methodName, inputs), value,
    });
  },
});

// `tools` now contains:
//   usdc__balanceOf        readOnly: true
//   usdc__allowance        readOnly: true
//   usdc__transfer         destructive: true
//   usdc__approve          destructive: true
```

## How read tools work

Each generated read tool's `execute()` calls the supplied `readExecutor` with the ABI-named inputs collected from the model. The executor encodes calldata (out of scope for the gateway — slice 1 leaves encoding to the executor so we don't pull a full ABI encoder into the compile-time path) and dispatches `EvmCall`, which in turn goes through `chain-adapter-evm` → `classifyChainPayload(origin: "chain")` → JSON-RPC parse. The classifier verdict short-circuits malicious node responses.

## How write tools work

Each generated write tool requires a `walletId` field on top of the ABI args. The `writeExecutor` calls `tool-evm-tx.EvmSendTransaction` with the resolved contract address, the encoded calldata, and the optional `value` (only for `payable` methods). `EvmSendTransaction` is itself `destructive: true`, so:

1. The §7 permission engine fires the approval prompt for the **generated tool name** (`usdc__transfer`), not for `EvmSendTransaction`.
2. The `wallet-engine` runs the full flow (simulate → policy → custody → broadcast → boundary-classify receipt).

This means a permission rule `alwaysAllow: usdc__balanceOf` allows reads but not writes, and a rule `alwaysAsk: usdc__transfer` gives per-call approval prompts named after the contract method — much friendlier than `EvmSendTransaction` as a generic name.

## Proof-Carrying (Shape 7) — artifact discipline

The gateway tools return raw hex by default. To produce proof artifacts (e.g., "Wallet 0x123 held at least 100 USDC at block 20123456"), wrap a read tool's result with a citation:

```ts
const balance = await usdc__balanceOf({ owner: "0x123" });
return JSON.stringify({
  claim: `Wallet 0x123 held at least ${minBalance} USDC at block ${block}`,
  proof_type: "on_chain_balance",
  chain: "base-mainnet",
  contract: "usdc",
  method: "balanceOf",
  result: balance,
  verifier: "evm_call",
});
```

The §41 `citation-tracker` integration treats this envelope as a citation; the §47 `tool-evm` read path already classifies the chain payload, so the resulting artifact is provenance-tagged.

## Multi-chain (Shape 5)

Generate tools for the same contract id on multiple chains by passing different `ContractBinding` records to `generateContractTools`. The tool name carries the contract id, not the chain, but the executor receives `chainId` and routes to the right adapter. To route by user intent ("Pay this invoice in USDC"), have the agent call `usdc__balanceOf` on each chain to find the wallet's funded balance, then call the write tool on the chosen chain.
