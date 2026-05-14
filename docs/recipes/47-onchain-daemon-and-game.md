# Recipe 47 — Onchain event daemon & game-playing agent

**Pillar:** Pillar 1 (two new IR variants for two genuinely new control flows).
**Catalog modules:** `target-onchain` (F2, brief 288), `target-onchain-game` (F2, brief 289), `chain-adapter-evm` (R5), `wallet-engine` (R8), `permission-tokengated` (R8).
**Target shape:** **`onchain`** (event-driven daemon) and **`onchain-game`** (perceive-act-perceive loop) — the two new IR variants from §47 slice 2.

## What this recipe shows

The two §47 shapes whose control flow is genuinely new:

- **`onchain`** covers Shape 8 (Escrow / Milestone) and Shape 10 (Autonomous Treasury Monitor) from the §47 proposal. Long-running daemon driven by on-chain triggers; per-trigger output is a transaction, an alert, or both.
- **`onchain-game`** covers fully on-chain games (the Lucky Machines / onchaingames.com style). Perceive-act loop against a game contract; the model reads state, proposes a move, the daemon broadcasts the move, awaits confirmation, re-reads state.

These are the only §47 shapes that needed new IR variants. Every other §47 shape (1, 2, 3, 4, 5, 6, 7, 9, 11, 12) is a recipe over existing shapes plus the §47 cross-cutting subsystem — see recipes 43-46.

## TL;DR — onchain daemon

```yaml
name: treasury-monitor
target: onchain
agent:
  model: claude-opus-4-7
  instructions: |
    You watch the treasury for unusual transfers. When an event fires,
    classify it as routine / notable / suspicious. For suspicious
    transfers, draft an alert and (if the policy allows) call
    EvmSendTransaction to pause the contract.

chains:
  - id: ethereum-mainnet
    kind: evm
    rpcUrls: ["$ETH_RPC"]
    finality: { kind: confirmations, count: 12 }

wallets:
  - id: pauser
    chainId: ethereum-mainnet
    custody: kms
    keyRef: "$PAUSER_KEY_ARN"
    signingPolicy: policy-gated

contracts:
  - id: treasury
    chainId: ethereum-mainnet
    address: "0xtreasury"
    abiRef: abi://safe

transaction_policy:
  defaultWriteApproval: policy
  allowedContracts: [treasury]
  simulationRequired: true

triggers:
  - kind: event
    chainId: ethereum-mainnet
    contract: treasury
    event: ExecutionSuccess
  - kind: address
    chainId: ethereum-mainnet
    address: "0xtreasury"
    direction: out
  - kind: block
    chainId: ethereum-mainnet
    scanIntervalMs: 60000  # one scan per minute

idempotencyWindowMs: 300000  # 5 minutes; dedup by (txHash, logIndex)
```

The compiler lowers this to `IrChainV0` ([packages/ir/src/index.ts](../../packages/ir/src/index.ts)). The `target-onchain` emitter produces `agent.ts` with the configured chains/wallets/contracts/triggers as exports, plus a `buildAdapters()` helper and an `acceptOrRedact()` defense-in-depth chain-payload classifier.

## TL;DR — onchain game

```yaml
name: dark-forest-agent
target: onchain-game
agent:
  model: claude-opus-4-7
  instructions: |
    You play Dark Forest. Read the board state, identify near-by enemy
    planets, and order moves that prioritize defending owned planets
    while expanding strategically. Never reveal owned coordinates in
    your reasoning.

chain:
  id: gnosis-chain
  kind: evm
  rpcUrls: ["$GNOSIS_RPC"]
  finality: { kind: finalized }

wallet:
  id: player
  chainId: gnosis-chain
  custody: local
  keyRef: "$PLAYER_KEY"
  signingPolicy: automated

game:
  contract:
    id: darkforest
    chainId: gnosis-chain
    address: "0xdarkforest"
    abiRef: abi://darkforest-v0.6
  stateReader: "5c975abb"   # precomputed 4-byte selector
  turnSemantics: real-time
  moveTimeoutMs: 30000      # 30s per move
  objective: |
    Maximise owned-planet energy while minimising captured-planet loss
    over the next 10 minutes.

transaction_policy:
  defaultWriteApproval: none  # automated wallet — moves are auto-signed
  allowedContracts: [darkforest]
  simulationRequired: true
```

The compiler lowers this to `IrChainGameV0`. The `target-onchain-game` emitter produces `agent.ts` with the single chain/wallet/contract as exports, plus a `buildAdapter()` helper, a `readAndClassifyState()` view-call helper, and a placeholder selector resolver.

Critical config notes:

- **`turnSemantics: real-time`** requires `moveTimeoutMs` (the emitter throws if it's missing). For `turn-based` games (chess-like), omit `moveTimeoutMs` and the daemon waits indefinitely between moves. For `async` games, the daemon subscribes to a state-change event and runs one turn per inbound mutation.
- **`signingPolicy: automated` + `defaultWriteApproval: none`** is only valid when every wallet uses an automated custody (KMS / HSM / local with a stored key). The §47 IR pass refuses any other combination at compile time.
- **`stateReader`** is a 4-byte hex selector for now. A follow-up slice ships a keccak-256 helper that accepts ABI method names directly.

## Why two new IR variants

| | `onchain` | `onchain-game` |
|---|---|---|
| Control flow | event-driven (triggers fire → one agent turn per event) | perceive-act loop (read state → think → broadcast → wait → re-read) |
| Closest existing analogue | `channel` (inbound webhook → agent turn) | `browser` / `voice` (perceive-act loop with shape-specific concerns) |
| Why distinct from analogue | channel adapters are messaging-shaped; on-chain events are `(txHash, logIndex, decodedEvent, confirmations)` shaped | game state + move-confirmation + turn semantics + finality are domain-specific |

Pillar 1 says new orchestration topologies start at the IR. Both shapes pass that test: the control loops differ from every existing variant. Each is a small, narrowly-scoped IR variant that closes its real use cases (escrow, treasury monitoring, on-chain games) and stops there.

## Pillar 3 — chain content is classified

Both targets call `classifyBoundary({origin: "chain"})` on event payloads (`onchain`) and game state payloads (`onchain-game`) before injecting into the model's user message. The chain adapter already classified the RPC envelope upstream; the second classification is the §41 defense-in-depth pattern (zero-cost cache hit; catches any decoded-event content the upstream pass missed).

## Pillar 2 — what's optimizable

`OPTIMIZABLE_PATHS` ([packages/spec-patch/src/index.ts](../../packages/spec-patch/src/index.ts)) lists for `onchain`: `agent.instructions`, `chains`, `triggers`, `transaction_policy`, `idempotencyWindowMs`. For `onchain-game`: `agent.instructions`, `game` (including `moveTimeoutMs`), `transaction_policy`. `crewhaus optimize` can tune the cadence of `block`-kind triggers, the value cap, the move timeout for real-time games, etc.

## Verification

Slice 2 ships the codegen. Follow-up slices wire the emitted bundles end-to-end against an anvil fork and add the runtime trigger-subscription / game-loop dispatchers. The slice-2 PR ships the IR variants, the spec schemas, the lower/emit cases, and the target-package skeletons; integration tests against a real EVM fork land in a follow-up.
