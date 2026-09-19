# @crewhaus/tool-chaincall

Ask a contract what it knows, and what a call would cost.

| Tool | Answers |
|---|---|
| `EvmMulticall` | many view calls, one request, one block height |
| `ContractInspect` | is there code here, is it a proxy, what does it claim |
| `EvmSimulateBundle` | what would this sequence of calls do |
| `GasMarketRead` | what the fee market is doing, and which fee market this is |

All four are read-only. No private key is accepted anywhere, nothing is
signed, and no transaction is submitted — `eth_sendRawTransaction` and
`eth_sendTransaction` are not reachable from this package, because every
method it dispatches passes `chain-adapter-base`'s read-only allowlist at a
single chokepoint. Simulating a transaction is a read: the node evaluates it
and throws the result away.

## One block, or it is not a table

A hundred separate reads land at a hundred different block heights. The
answers look like a table and do not add up — a pool's reserves from one
block and its fee from another price a swap that was never available.

`EvmMulticall` packs the calls into a single `aggregate3` through
Multicall3 (the encoder is `@crewhaus/tool-onchain`'s, not a second copy), so
one `eth_call` answers all of them at one height. When a batch is too large
for one request it is split — and then the single-block promise needs
defending. The block is pinned by riding a Multicall3 self-call to
`getBlockNumber()` in the first batch: one extra slot instead of an extra
round trip, and, unlike asking `eth_blockNumber` first, the number it returns
is the block that batch actually executed at, so the head cannot move between
the two reads. Every later batch asks for that exact height.

If the block cannot be pinned and the batch has to be split, the call is
**refused**. Answering from two heights and presenting it as one table is the
bug this tool exists to prevent.

**A sub-call that reverts is a row**, with its reason decoded — `Error(string)`,
a `Panic` with the Solidity code's meaning, or the raw hex for a custom error
nobody can name. One bad token does not lose the other ninety-nine. What
throws is the *batch* failing, which means there are no rows at all.

**An empty return is flagged, never decoded.** Calling an address with no code
SUCCEEDS in the EVM and returns nothing. Decode that as `uint256` and you get
zero, which reads as a balance. Every such row is marked `emptyReturn` and
left undecoded, and the result says how many there were.

## Verified, and claimed

`ContractInspect` splits its answer in two, because they are different kinds
of fact.

**`verified`** is read out of state. Code size from `eth_getCode`. The EIP-1967
implementation, admin and beacon slots, and the EIP-1822 `keccak256("PROXIABLE")`
slot, from `eth_getStorageAt`. The EIP-1167 minimal-proxy target out of the
runtime bytecode itself. A storage slot is not an opinion.

**`claimed`** is the contract answering questions about itself. `supportsInterface`
is self-reported: a contract can claim an interface it does not implement and
implement one it does not claim. So is `implementation()`, which on a proxy is
answered by the implementation through the delegate.

The compliance check is the part that is usually skipped. ERC-165 requires a
contract to answer **false** for the reserved id `0xffffffff`. A contract whose
fallback returns a non-zero word answers *true* to every `supportsInterface`
call ever made — so its claims carry no information, and a list of eleven
interfaces it "supports" is eleven wrong facts with nothing to spot them by.
When the sentinel fails, the claims are **dropped entirely**, not returned as
an empty list, and the reason is given.

Proxy detection has no single specification, so the tool reports signals and
then tries to reconcile them:

- two mechanisms naming **different** implementations → unresolved, both
  addresses shown. Picking one sends the caller to the wrong ABI;
- a **beacon** whose `implementation()` will not answer → unresolved, naming
  the beacon;
- an ERC-165 claim of **EIP-2535 DiamondLoupe** → unresolved, because a diamond
  routes every selector to a different facet and there is no single
  implementation. A claim is allowed to withdraw an address here, never to
  supply one;
- a slot that is set but does **not** hold an address — an EIP-1822
  implementation contract stores its UUID there — is reported as raw storage
  rather than masked down to its low 20 bytes.

Only the canonical EIP-1167 bytecode matches. The optimized variants that push
a shorter address do not, and a near-match is reported as no match: those 45
bytes are the one place a target can be read with no second call, so a pattern
that is almost right is a target that is almost right.

The probes go out as one Multicall3 batch. Where Multicall3 is not deployed
the batch fails and they are made one at a time instead — `reads` says which
happened, because ten sequential round trips against a rate-limited endpoint
is not the same thing as one.

A probe that **reverts** is an answer: a contract that is not ERC-165 reverts
on `supportsInterface`, one that is not a proxy reverts on `implementation()`.
A probe the node could not answer at all — it is down, it is rate-limiting, it
pruned the block — is not, and the two are counted separately. When *every*
probe fails that way the whole read is **refused**, because the report it would
otherwise produce ("not a proxy, not ERC-165") is a set of claims about a
contract nobody managed to ask.

The same line is held one probe at a time. When it is the `0xffffffff`
sentinel that the node would not answer, the claims are still dropped — but
`claimed.erc165` carries `established: false` and says *why*, because "this
contract does not implement ERC-165" is a fact about the contract and nothing
here established it.

## The honest-degradation case

A bundle asks what an ordered sequence of calls would do **with state chained**:
the approve, then the swap that sees it. That needs `eth_simulateV1`, and many
endpoints do not implement it.

`eth_call` cannot chain. Every call it makes starts from an unmodified block,
so the swap is evaluated against a world where the approval never happened.
That is a different question. So the fallback says so, in the result, in three
ways at once:

- `mode: "eth_call-fallback"` and `chained: false`;
- **no `logs` key on any call**, and **no `balanceChanges` key** — absent, not
  empty. An empty log list reads as "this emitted no events", which is the
  reading a policy gate acts on and is wrong about;
- a `limitations` list naming each thing the answer is missing.

The fallback also **pins the height once** before it starts: a block tag sent
once per `eth_call` is resolved once per `eth_call`, and a head that moves
mid-loop puts rows from two blocks into one table. One
`eth_getBlockByNumber` resolves the tag, `blockNumber` reports the height the
calls actually ran at, and a tag that cannot be resolved is reported as
unpinned — the limitation then says the calls may not share a block, rather
than asserting one they may not.

The degradation is narrow in both directions. `-32601` and the strings
providers use instead of it mean the method is unimplemented. A **timeout**,
a **rejected parameter**, a **rate limit** and a **revert** do not — degrading on
any of those would turn a transient fault into a permanently weaker answer
that still reads like an answer. A timed-out simulation is a refusal that says
so, and no `eth_call` is attempted after it.

`allowFallback: false` refuses instead of answering the lesser question.

### Deltas from the chain's own accounting

`trackBalances` brackets the bundle with Multicall3 balance reads placed
*inside* the simulation, so before and after are both measured in the chained
state. Native balances come from `getEthBalance`, token balances from
`balanceOf` — not from summing `Transfer` logs, which miss fee-on-transfer and
rebasing tokens and miss native value moved inside internal frames.

### Absence is not emptiness, in the primary path too

The same rule governs a successful `eth_simulateV1`. A node can implement the
method and still return no log list for a call, and no `gasUsed` figure. Those
rows come back with **no `logs` key and no `gasUsed` key** rather than `[]` and
`"0"`, and a `limitations` entry counts them: an empty list is the fact "this
call emitted nothing", and the two must not arrive looking the same. A call
result carrying **neither a status nor an error** is refused outright, because
an outcome the node never stated is not an outcome that held.

In fallback mode `trackBalances` is **refused**: there is no after-state to
difference against, and a plausible delta is worse than none. If the
bracketing read itself does not execute — Multicall3 not deployed — no deltas
are reported rather than partial ones, and a single token that cannot be read
is reported as unreadable rather than as zero.

## Which fee market is this

Chains disagree. `GasMarketRead` reports the mechanism rather than assuming
one:

- a block with no `baseFeePerGas` is a **legacy** chain, priced from
  `eth_gasPrice`, with no 1559 projection at all;
- a node without `eth_feeHistory` is reported as such — no percentiles, rather
  than percentiles from somewhere else;
- a base fee that is **identical in every sampled block** is flagged. Several
  chains hold it at a floor and price congestion elsewhere; that is not a
  quiet market;
- an `atPercentile` the node did not answer is **named**, not substituted in
  silence: `planned` carries both `requestedPercentile` and the
  `atPercentile` it was actually priced at, with a caveat. Pricing a request
  for the 90th at the 10th without saying so is how a caller under-tips.

The next block's base fee is computed by the EIP-1559 rule from the block's
**integer** `gasUsed` and `gasLimit` — never from `feeHistory`'s
`gasUsedRatio`, which is a JSON float that has already lost the low bits — and
then **compared against the node's own figure**. A disagreement is reported as
a disagreement: this chain's elasticity or change denominator is not the
vanilla one, and the node's number is the one to trust.

Blob fees are read from the node's tail entry and not recomputed, because
EIP-4844 prices blob gas with an exponential rather than the 1559 linear rule.

Every report carries the rollup caveat, and it is not a guess: the tool checks
whether the OP-stack `GasPriceOracle` predeploy has code at
`0x420…0F`. Where it does, the L1 data fee is a real cost — frequently the
larger share — that **this tool does not price**. It does not read the oracle
and does not implement the post-Ecotone blob-scalar formula, so every figure
it returns is execution gas.

## What it refuses

A tool that cannot say no is not finished. These say no, with the reason:

- **a split batch whose block could not be pinned**, rather than reading from
  two heights into one table;
- **a result blob whose row count does not match the calls sent** — from
  Multicall3 or from `eth_simulateV1` — because results are positional and
  nothing in them names the call they answer;
- **a call giving both `data` and `signature`**, which would encode to two
  different things with no way to tell which was meant, and one giving
  neither;
- **a proxy whose mechanisms disagree**, and a **diamond**, which get no
  implementation address at all;
- **a simulation that timed out or was rejected**, which is never degraded
  into a fallback, and **a simulated call whose outcome the node did not
  state** — no status and no error — which is never read as a success;
- **balance tracking without a chained simulation**;
- **fee percentiles that are not strictly ascending**, which `eth_feeHistory`
  requires, and a **block the node does not have**;
- **an address that is not 20 hex bytes**, before anything is dialled. A
  lowercase address is answered, with `checksumVerified: false` attached,
  because EIP-55 can only verify a checksum that is there.

## Numbers

No chain quantity is ever a JS number. Wei, balances, gas and block numbers
are `bigint` in memory and **decimal strings** on the way out. A uint256 is 78
digits and a double carries about 15; the difference is lost silently, and it
is money.

That includes figures merely *derived* from wei. `baseFeeChangeBps` is a
decimal string too: a chain sitting at a one-wei base-fee floor that then
spikes produces a ratio past 2^53, and `Number()` renders it `1e+34` — neither
an integer nor the value that was computed.

## Wiring

The transport is bound once at boot, per chain, from the spec's `chains[]`
block — the same shape `@crewhaus/tool-evm` uses. No caller supplies a URL
anywhere in this package, and there is no endpoint list inside it.

```ts
import { setChainRpcResolver, chainRpcFromAdapter } from "@crewhaus/tool-chaincall";

setChainRpcResolver((chainId) => {
  const adapter = adapters.get(chainId);
  return adapter === undefined ? undefined : chainRpcFromAdapter(adapter);
});
```

`_setRpc` is the test seam beside it: one transport for every chain id,
`undefined` to restore. Every test in this package drives it, and nothing in
the suite resolves a name or opens a socket.

`timeoutMs` bounds the **tool**, not the socket. `ChainAdapter.rpcRead` takes
no `AbortSignal`, so a transport built on one cannot be cancelled; the deadline
is raced against the call so the tool returns on time, and the request
underneath it may still be in flight. That is the honest limit of a seam whose
other side does not accept a signal — and it is better than a `timeoutMs` that
bounds nothing. A cancellation is never mistaken for something else: it is not
a missing Multicall3 deploy, and it is not a node that cannot simulate.
