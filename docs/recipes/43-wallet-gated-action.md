# Recipe 43 — Wallet-gated action (sign-and-broadcast with HITL approval)

**Pillar:** Pillar 1 (compiler is the protagonist), Pillar 2 (optimizable policy knobs), Pillar 3 (chain content is classified).
**Catalog modules:** `wallet-engine` (R8, brief 284), `tool-evm-tx` (R4, brief 285), `chain-adapter-evm` (R5, brief 282), `permission-engine` (R8, brief 097).
**Target shape:** `workflow` (or `cli`/`crew`/`graph` — wallet-gated actions are a recipe over existing shapes, NOT a new IR variant).

## What this recipe shows

Shape 1 (Wallet-Gated Action) and Shape 11 (Contract Deployment) from the §47 proposal. Both compose the §47 cross-cutting subsystem onto a `workflow` shape: declare `chains`, `wallets`, `contracts`, `transaction_policy`; let the user prepare and simulate a transaction; gate the broadcast behind explicit approval.

The two-gate invariant is the load-bearing safety property: the §7 permission engine gates *whether* `EvmSendTransaction` may run; the `wallet-engine` gates *what the transaction may do* (allowed contracts, max value, simulation required). Both must approve; either can refuse.

## TL;DR — spec

```yaml
name: usdc-payout
target: workflow
model: claude-opus-4-7

chains:
  - id: base-mainnet
    kind: evm
    rpcUrls: ["$BASE_RPC"]
    finality: { kind: confirmations, count: 12 }

wallets:
  - id: treasury
    chainId: base-mainnet
    custody: user-controlled         # WalletConnect / MetaMask / Safe
    signingPolicy: explicit-user-approval

contracts:
  - id: usdc
    chainId: base-mainnet
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    abiRef: abi://erc20

transaction_policy:
  defaultWriteApproval: required
  maxValueUsd: 10000
  allowedContracts: [usdc]
  simulationRequired: true

permissions:
  rules:
    - { type: alwaysAllow, pattern: EvmSimulate }
    - { type: alwaysAsk,  pattern: EvmSendTransaction }

steps:
  - name: simulate
    instructions: |
      Run EvmSimulate against the USDC transfer call. Surface the
      gasUsed, return data, and any revert reason. Do NOT send the
      transaction.
    tools: [evmSimulate]
  - name: review-and-send
    instructions: |
      Summarise the simulation result for the user in 1-2 sentences.
      Then call EvmSendTransaction with the same args. The approval
      prompt will fire; quote the simulation summary in the prompt so
      the user can decide informed.
    tools: [evmSendTransaction]
```

Tool names in the `tools:` list use the lowercase registration name (`evmSimulate`, `evmSendTransaction`); permission-engine rules pattern-match against the runtime tool name (`EvmSimulate`, `EvmSendTransaction`) — the case difference is the existing convention shared with `read`/`Read`, `bash`/`Bash`, etc.

## How the layers compose

1. **Spec → IR.** The compiler's `lowerChainSubsystem()` ([packages/compiler/src/index.ts](../../packages/compiler/src/index.ts)) routes `$BASE_RPC` through the env-var rewriter so secrets stay out of the bundle. The blockchain blocks ride along on `IrWorkflowV0`.
2. **IR pass.** `transactionPolicyEnforcement` ([packages/ir-passes/src/index.ts](../../packages/ir-passes/src/index.ts)) validates `allowedContracts ⊆ contracts[].id` and refuses `defaultWriteApproval: none` for non-automated wallets. Compile-time refusal — the bundle never emits when invalid.
3. **Runtime.** The generated workflow runs `simulate` first (no approval needed; `EvmSimulate` is `readOnly: true`). The model's terminal output for step 1 is threaded into step 2's user message. Step 2 calls `EvmSendTransaction`:
   - The §7 permission engine sees `destructive: true` + `alwaysAsk` rule → prompts for approval.
   - User approves → `wallet-engine.requestSignAndBroadcast()` runs again (defense in depth): simulates (required), validates `contractId ∈ allowedContracts`, calls the user's custody provider (WalletConnect), broadcasts, fetches the receipt, classifies the receipt with `origin: "chain"`, returns.

## What happens if a gate fires

- `EvmSendTransaction` called with `contractId: "uniswap-router"` → wallet-engine throws `WalletEngineError: contract id "uniswap-router" not in transaction_policy.allowedContracts`. Permission engine would have allowed; wallet engine refuses.
- `EvmSendTransaction` called via a permission rule `alwaysAllow` → permission engine allows; wallet engine still simulates and gates on the simulation result. If sim reverts, `requestSignAndBroadcast` refuses.
- Native-token transfer over `maxValueUsd` → wallet engine refuses pre-approval.

## Pillar 2 — what's optimizable

`OPTIMIZABLE_PATHS` ([packages/spec-patch/src/index.ts](../../packages/spec-patch/src/index.ts)) lists `chains` and `transaction_policy` as tunable for `workflow`. `crewhaus optimize` against a labelled dataset can adjust `transaction_policy.maxValueUsd`, `chains[*].finality.count`, and `simulationRequired` without rewriting prompts.
