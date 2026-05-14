# Recipe 45 — DAO governance crew (parallel analysis → vote tx)

**Pillar:** Pillar 1 (parallel coordination via the existing `crew` shape, not a new IR variant).
**Catalog modules:** `crew-orchestrator` (R10), `target-crew` (F2), `tool-evm` (R4, brief 283), `tool-evm-tx` (R4, brief 285), `wallet-engine` (R8, brief 284).
**Target shape:** `crew` (the multi-role parallel-then-converge shape from §22) composed with the §47 cross-cutting blockchain blocks. Not a new IR variant.

## What this recipe shows

Shape 6 (DAO Governance) from the §47 proposal. DAO proposal analysis is parallelizable: legal review, treasury impact, technical risk, and governance-history analysis can all happen independently before a single voting recommendation lands. The `crew` shape already supports parallel roles with an `entry` role that routes the converged signal.

The §47 contribution is the *vote tx* phase. The crew converges to a recommendation; one role (or a follow-on `workflow`) calls `dao__castVote` (a contract-gateway tool from Recipe 44) to actually submit the vote.

## TL;DR — spec

```yaml
name: dao-voter
target: crew
model: claude-opus-4-7
entry: triage

chains:
  - id: ethereum-mainnet
    kind: evm
    rpcUrls: ["$ETH_RPC"]
    finality: { kind: confirmations, count: 12 }

wallets:
  - id: delegate
    chainId: ethereum-mainnet
    custody: user-controlled
    signingPolicy: explicit-user-approval

contracts:
  - id: governor
    chainId: ethereum-mainnet
    address: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529"  # Compound Governor Bravo
    abiRef: abi://governor-bravo

transaction_policy:
  defaultWriteApproval: required
  allowedContracts: [governor]
  simulationRequired: true

roles:
  triage:
    instructions: |
      Read the proposal id from the user. Hand off to the four analysts:
      treasury_impact, legal_review, technical_risk, governance_history.
      When all four reply, hand off to recommendation.
    tools: [evmCall]
  treasury_impact:
    instructions: |
      Use governor__proposals and EvmCall on referenced treasury contracts
      to compute the dollar impact of executing this proposal. Return a
      structured summary {impact_usd, confidence}.
    tools: [evmCall, evmGetLogs]
  legal_review:
    instructions: |
      Read the proposal's IPFS-hosted description (assume the description
      hash is in the proposal envelope). Flag any terms that imply
      regulated activity (securities issuance, KYC obligations, MSB
      activity). Return a structured summary {risk_level, citations}.
    tools: [evmCall]
  technical_risk:
    instructions: |
      Read the proposal's calldata bytes. Identify the target contract(s)
      and methods. Compute the bytecode hash for each target. Flag any
      upgradeable proxies. Return a structured summary {targets, risks}.
    tools: [evmCall]
  governance_history:
    instructions: |
      Use EvmGetLogs to fetch the last 10 ProposalCreated + ProposalExecuted
      events. Summarise the success rate, quorum trends, and the proposer's
      track record. Return a structured summary {pattern, anomalies}.
    tools: [evmGetLogs]
  recommendation:
    instructions: |
      Read the four analyst replies. Produce a single voting recommendation
      (For / Against / Abstain) with a one-paragraph rationale citing the
      analyst inputs. Stop after recommending; the user (or a follow-up
      workflow) submits the vote via governor__castVote.
```

## Why this is a recipe, not a new shape

The control flow is "parallel analysis → converge → recommend", which is exactly what `crew` shape exists for. The only §47 elements are the four cross-cutting blocks (`chains`, `wallets`, `contracts`, `transaction_policy`) and the choice of read tools (`EvmCall`, `EvmGetLogs`). Nothing about the topology is blockchain-specific — replace the analyst tools with `Read` / `Grep` and you have a legal-document review crew.

Pillar 1 says new orchestration topologies start at the IR. This isn't a new topology, so it doesn't get a new IR variant; it gets a recipe.

## Vote tx phase

After the crew converges, submit the vote as a separate step. Two options:

**Option A — inside the crew.** Add an `execute_vote` role that uses `tool-contract-gateway`-generated `governor__castVote` (`destructive: true`) and runs only when `recommendation` produces a clear For/Against. The crew router (defaults to "first role to mention `complete:` wins") handles dispatch.

**Option B — separate workflow.** Have the crew's `recommendation` role emit a JSON envelope that a follow-on `workflow` ingests and submits. Cleaner audit trail; the recommendation is committed before the signing flow starts.

In both cases, the wallet-engine two-gate flow applies: the user gets an approval prompt with the full simulation result, the contract is restricted to `governor` by `allowedContracts`, and the receipt is `classifyBoundary({origin: "chain"})`-wrapped before the model sees it.

## Pillar 3 — defense against malicious proposals

The proposal description is loaded from IPFS (or, in some DAOs, a contract storage slot). That content is attacker-controlled. The `crew` orchestrator already classifies sub-agent finalMessages — but the proposal text reaches the legal_review role through `EvmCall` → adapter → classifier. Both layers fire; an injection in the proposal description gets caught (`origin: "chain"` for the EvmCall path, `origin: "subagent"` for the crew handoff).
