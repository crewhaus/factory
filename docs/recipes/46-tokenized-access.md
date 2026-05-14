# Recipe 46 — Tokenized access & DID-gated entitlements

**Pillar:** Pillar 1 (permission rules are first-class; the chain-state check is an async resolver that emits standard rules, not a new evaluator).
**Catalog modules:** `permission-tokengated` (R8, brief 287), `permission-engine` (R8, brief 097), `chain-adapter-evm` (R5, brief 282).
**Target shape:** any (session-boot extension to the permission engine; no new IR variant).

## What this recipe shows

Shape 9 (Tokenized Access) and the credential-check half of Shape 12 (Decentralized Identity). The agent gates tool availability on on-chain ownership — "only users holding ≥1 of the membership NFT may use the analytics tool," "only DAO delegates may run the governance-search tool," "only accredited credential holders may view the financial reports."

The §47 contribution is the `permission-tokengated` resolver. It runs at session boot, queries the chain (`balanceOf` / `ownerOf` / `hasAny`), and emits standard `alwaysAllow` / `alwaysDeny` rules that the runtime folds into `RuleSet.builtin` before the first user message. The standard `permission-engine.evaluate()` makes the per-call decision synchronously.

## TL;DR — boot wiring

```ts
import { resolveTokenGatedRules } from "@crewhaus/permission-tokengated";
import { createEvmAdapter } from "@crewhaus/chain-adapter-evm";

// At session boot, after the spec is lowered and the wallet is connected:
const userWallet = "0x..."; // from WalletConnect / Safe / etc.
const adapters = new Map([
  ["base-mainnet", createEvmAdapter({
    chainId: "base-mainnet",
    rpcUrls: [process.env.BASE_RPC!],
    rpcPolicy: "single",
    finality: { kind: "confirmations", count: 12 },
    reorgTolerant: true,
  })],
]);

const tokenGatedSpecs = [
  // Membership NFT — required for the analytics tools.
  {
    allowTools: ["AnalyticsQuery", "AnalyticsExport"],
    chainId: "base-mainnet",
    contractAddress: "0xMembershipNFT",
    walletAddress: userWallet,
    requirement: { kind: "hasAny" as const },
  },
  // Stable-coin holding ≥ 10000 USDC — required for high-value financial tools.
  {
    allowTools: ["TreasuryRebalanceProposal"],
    chainId: "base-mainnet",
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    walletAddress: userWallet,
    requirement: { kind: "balanceOf" as const, minBalanceWei: "10000000000" },
  },
];

const tokenRules = await resolveTokenGatedRules(
  tokenGatedSpecs,
  (chainId) => adapters.get(chainId),
);

// Fold into the RuleSet.builtin source — lowest priority, so any explicit
// flag/settings/yaml/hook rule still overrides.
const ruleSet = {
  ...emptyRuleSet,
  builtin: [...BUILTIN_DEFAULT_RULES, ...tokenRules],
};

// permission-engine.evaluate(toolCall, "default", ruleSet) now consults
// these rules per call, synchronously, just like any other rule type.
```

## Why this isn't a new permission RuleType

`permission-engine.evaluate()` is sync — the entire R8 pipeline is, by design. Adding async chain lookups inline would force every site that calls `evaluate()` to await, which means turning the runtime's whole permission-decision call into an async path. We don't want that.

Instead: do the chain query once at session boot (`resolveTokenGatedRules` is async), emit `alwaysAllow`/`alwaysDeny` records (the existing `RuleType`s), and from then on the evaluator stays sync. The architectural dependency arrow stays `R5/R8(tokenGated) → R8(permission-engine)` — no back-edge from R8 to R5.

## Fail-closed behavior

`resolveTokenGatedRules` throws `TokenGatedError` when:

- A directive references a chainId with no registered adapter.
- A chain call fails outright (`ownerOf` reverts is treated as "not the owner" → alwaysDeny; an RPC outage throws).
- A directive has `allowTools: []`.

The boot path catches these errors and refuses to start the session — never silently grants entitlements when the chain is unreachable.

## DID / credential variants (Shape 12)

For credentials issued via EAS attestations or other on-chain attestation registries, write a small wrapper that converts an attestation-existence check into a `balanceOf` query against the attestation contract. The same `permission-tokengated` resolver handles it; only the contract address + minBalanceWei differ.

For off-chain DIDs (DID:web, DID:key), see the §11 skills recipe for a session-binding pattern that records the DID claims and lets permission rules pattern-match on them. The chain-state path is for *on-chain attestations only*.

## Pillar 3 — defending against malicious nodes

`resolveTokenGatedRules` reads balance / ownership via `ChainAdapter.rpcRead`, which already routes through `classifyChainPayload({origin: "chain"})`. If a node returns a malicious response embedded in a `balanceOf` return value (extraordinarily contrived but possible), the adapter throws before the resolver sees the value — the session boot then throws, and the user is refused.
