# @crewhaus/tool-chainread

What the chain actually recorded, read over a public RPC endpoint you name.

| Tool | Answers |
|---|---|
| `EvmGetBlock` | what is in this block — by number, by tag, or by hash |
| `EvmBlockAtTimestamp` | which block was the chain at, at this moment |
| `EvmRpcHealth` | what is this endpoint, and what can it serve |
| `EvmNonceStatus` | is this account clear to send, or is something stuck |
| `EvmWaitForReceipt` | did it land, did it revert, or is it still pending |
| `EvmTransactionSummary` | what did this transaction actually move |
| `EvmEventScan` | every log matching this filter over this range |
| `OnchainTransactionsSync` | this address's history, as the rows a reconciler already reads |

`@crewhaus/tool-onchain` next door does the arithmetic offline — calldata, digests,
checksums, token units. This package is the half that dials.

## Nothing here signs or sends

No schema accepts a private key, a mnemonic, a keystore or a signed payload, and no
code path can reach `eth_sendRawTransaction`. That is not a promise about the
call sites: **every** method name goes through `assertReadOnlyMethod` from
`@crewhaus/chain-adapter-base` — the same allow-list the chain adapters use — before a
socket is opened, so a write method throws inside the transport whatever asks for it.
Both halves are asserted in `index.test.ts`: the schemas are walked for key-shaped
field names, and the stub endpoint's own request log is checked for anything that
sends.

## Three outcomes, not two

`EvmWaitForReceipt` exists because callers conflate three things that need three
different next moves:

| Outcome | What happened | What you do |
|---|---|---|
| `mined` + `status: "success"` | it landed and did what it said | carry on |
| `mined` + `status: "reverted"` | it landed and the call failed | fix the call — **do not** resend |
| `deadline` | still unmined when the clock ran out | wait longer, or speed it up |

A reverted transaction **has a receipt**, with `status: 0x0`. A tool that reports "no
receipt" for it tells the caller to broadcast again, and a failed transaction becomes
two. There is a fourth distinction inside the third: `knownToEndpoint` says whether
this endpoint is holding the transaction in its mempool or has never heard of it,
which is the difference between "slow" and "it never propagated, or it went to a
different chain".

A receipt that arrived but is not yet as deep as you asked for still reports as
`mined`, with `settled: false` — the clock running out does not un-mine anything.
`finality: "safe" | "finalized"` uses the chain's own tag instead of counting blocks;
an endpoint that does not serve that tag is a refusal, not a quiet fallback to
counting, because counting is not finality on a chain that reorganises in bursts.

There is one thing it deliberately does not do: explain a revert. Replaying the call
to recover the revert reason needs the state as it was at mining time, which needs an
archive node, and replaying it against the head instead produces a "reason" that is
sometimes right and always confident. Use `EvmRpcHealth` to find out whether your
endpoint keeps archive state, then replay it yourself if it does.

## The invariant `EvmBlockAtTimestamp` returns

> The returned block is the **last** block whose timestamp is `<= target`, and the
> block after it has a timestamp `> target`.

Half of that — "a block at or before the timestamp" — is satisfied by the genesis
block, which is why the second half is part of the contract. The result carries a
`certificate` with all three numbers so the invariant can be checked without another
call, and the block after is returned as `next`.

The boundaries are where a plausible wrong answer is indistinguishable from the right
one, so each one has a defined behaviour:

- **Before the first block.** Refused, naming the earliest block and its timestamp.
  Answering "block 0" would send a caller to read state from before the chain existed.
- **At or past the head.** Returns the head with `atHead: true`, `next: null` and a
  note that the answer will change as the chain advances. There is no block after the
  head to prove a boundary with, and pretending otherwise is the lie.
- **Several blocks sharing one timestamp.** Returns the highest of them. Ties resolve
  upward, because a caller reading state at the answer wants the state after
  everything that happened at that instant.
- **Timestamps that go backwards.** Refused, naming both blocks. A binary search over
  a non-monotonic sequence has more than one right answer, and every sample the search
  takes is compared against every other so the assumption is checked rather than
  assumed.
- **Milliseconds.** Refused by name. `Date.now()` pasted in would otherwise resolve to
  "at or past the head" and answer with the head block, every time, looking entirely
  ordinary.

The search is plain bisection: about 25 probes over a twenty-million-block chain, and
`fromBlock`/`toBlock` cut both the bracket and the probe count. Interpolating from an
average block time would converge faster on a chain with a steady block time and badly
on one that changed — Ethereum before and after the Merge is two different chains by
that measure — and the failure mode of a bad estimate is a wrong bracket, so the
faster thing is not the safer thing here.

## `EvmEventScan` refuses rather than under-reporting

Public endpoints cap log queries and disagree about how. Three behaviours, three
answers:

1. **An error naming a smaller range.** The suggested range is parsed out of the error
   and used directly, clamped so a suggestion can only ever narrow the request — an
   endpoint answering "try 10000 blocks" to a 500-block query is describing its own
   limit, not this request. Only the first 512 characters of the message are read, and
   the parser's quantifiers are bounded: this string is the one field in the exchange a
   provider fills in freely, inside a body allowed sixteen megabytes, and an unbounded
   digit run costs quadratic time to fail to match. When nothing usable is in the
   message, the span is halved.
   The decision to narrow is made on the *shape* of the failure (a JSON-RPC error, an
   oversized body, a timeout), never by matching error text: providers phrase the same
   cap five ways. A 401, 403 or 429 never narrows, because retrying a rate limit in
   halves turns one rejected request into sixteen.
2. **An error about the result count.** Same path.
3. **Silent truncation.** The endpoint returns the first N logs of a range that held
   more, with a 200 and a well-formed array and nothing saying it is short. This is
   the one that matters, because a harness that scans for `Transfer` and finds nothing
   concludes the transfer did not happen.

Truncation is caught by proof, not by a heuristic about round numbers. A chunk whose
count reaches `suspectAt` (default 1000) is split and re-queried; if the halves
together hold more logs than the whole did, the whole was truncated. The recovered set
is returned with `paging.silentTruncations` and a warning saying the endpoint will do
it again — and the working span is narrowed so the rest of the scan does not
rediscover the same cap chunk after chunk.

When the split cannot go further because the chunk is a single block, there is nothing
left to prove it with, and the scan **refuses**. So does a result larger than `maxLogs`
— slicing it here would produce exactly the indistinguishable-from-complete set the
rest of this is about. Three more refusals: a log from outside the range that was
asked for, a log marked `removed`, and the same block height coming back with two
different hashes, which is the chain reorganising mid-scan.

`complete: true` is the only value that field ever has. The alternative is an error.

The range is resolved to numbers before the first query, so `toBlock: "latest"` is
pinned once; a scan whose upper bound keeps moving is not one anybody can call
complete. `confirmations` keeps the whole range behind the head by that many blocks.

## `OnchainTransactionsSync` borrows the row shape rather than inventing one

The rows it returns are `@crewhaus/tool-money`'s `Transaction` — the same shape
`StatementParse` produces and `LedgerReconcile` consumes — imported, not
re-declared. A second declaration of it is a shape that drifts the first time a
field is added, and an onchain history that cannot be matched against a bank
statement is the whole point of the tool gone.

That shape has one field this package would never have written: `amountMinor` is
a JS `number`. A uint256 is not, and `Number.MAX_SAFE_INTEGER` is about nine
thousandths of one coin in wei — so a plain payment does not fit in the field at
all. Nothing is rounded to make it. A movement that cannot be written exactly is
**parked**, in an `unrepresentable` list, with the raw amount and the reason:

| Reason | What it means |
|---|---|
| `exceedsSafeInteger` | the amount is past what the row's number field holds. Name the asset's `decimals` and the ledger's `minorUnitDecimals` and it scales into range |
| `belowMinorUnit` | 1.234567 USDC against a ledger kept in cents. No rounding of it is the amount that moved |
| `timestampOutOfRange` | the block's timestamp is past what a calendar date can express, so the row has no date |
| `undecodable` | a log carrying the Transfer topic without a Transfer's topics |

The exact uint256 also travels beside every row it *did* fit, in `detail`, keyed
by the row's id. A reconciler reads `rows`; an auditor reads `detail`.

### Three sources, and the ones there are not

A public endpoint has no index by address, so a history has to be reconstructed:

1. **Logged token transfers**, from `eth_getLogs` with the address in the from
   or the to topic position — two scans, merged and deduped. Paged by the same
   `scanLogs` that `EvmEventScan` uses, so the silent-truncation proof, the
   reorg check and the refusal-rather-than-a-prefix behaviour are the tested
   ones and not a second implementation of them.
2. **Native value and gas**, by hydrating every block in the range and picking
   out the transactions this address was a party to. That is one request per
   block, so the range is bounded by `maxHydratedBlocks` and a range past it is
   a **refusal** — returning the token rows alone and calling it a history would
   leave every coin payment out of a statement that says it is complete.
3. Nothing else, and the output says so rather than the docs alone:
   **internal native transfers** need a trace, **ERC-1155** puts its parties in
   topic positions this filter does not look at and its batch amounts in data no
   filter reaches, and **token metadata** is never read off a token contract —
   an airdrop whose `decimals()` returns 2 turns dust into a five-figure row, so
   decimals arrive from the caller or the raw base units are used unchanged.

`tokens` is an allow-list, and it is applied twice: in the `eth_getLogs` filter,
so an airdrop is never fetched, and again against the logs that come back. A
filter is a request, not a proof — an endpoint that ignores it answers with every
token that ever touched the wallet, and those rows would land in a
reconciliation under a `coverage` line saying they were never scanned for.

The block path has its own version of the truncation trap. An endpoint that
ignores `fullTransactions: true` answers with a list of hashes; filtering hashes
on `from` matches nothing, and that empty result is indistinguishable from a
block this wallet was never in. It is refused by name.

### What the blocks held, checked against the nonce

A block is one response and cannot be re-asked in halves, so the split-and-
compare proof the log scan uses has nothing to work with here. The account's own
nonce is the oracle instead: it rises once per transaction sent, so its rise
across the range is how many of them those blocks must contain.

Fewer is a **refusal** — each one missed is a fee row and possibly a payment.
More is not: a rollup's system and deposit transactions appear in blocks without
raising an ordinary nonce, and nothing is missing in that direction. A pruned
endpoint that will not serve a historical nonce leaves the check unrun, and
`sentProof` says `unproved` with the reason rather than reporting a completeness
nothing established. What the address *received* has no such oracle at all, and
`coverage.nativeTransfers` says so in the output.

### The things that double-count

**Gas is charged once per transaction.** A wallet can appear in a dozen logs of
one swap, and a fee attributed per log charges the gas a dozen times — the
reconciliation is then off by exactly that. Fee rows come only from the block
path, keyed on the transaction, so it cannot happen.

**A reverted transaction moved nothing.** Its value transfer is discarded with
the rest of its state changes and only the fee is charged, so a receipt is read
for every matching transaction — for the status as much as for the fee. A mined
transaction whose receipt this endpoint does not have is a refusal, because
booking the movement either way is a guess.

**A transfer to oneself is not a row.** It changes no balance; one row would be
a debit that never happened.

### The cursor names where it stopped

`cursor.nextFromBlock` is the pinned upper bound plus one — not the head at the
end of the run, which has moved, and a cursor set from it skips every block
mined while the sync ran. `confirmations` keeps the whole range behind the head.

Dates are UTC calendar dates, because a block timestamp is UTC and nothing on
the chain knows the ledger's timezone. `balanceMinor` is always `null`: there is
no opening balance here to run one from, and a computed one is a number a
reconciliation would trust.

## `EvmRpcHealth` says unknown when it means unknown

Archive support is decided by reading a historic balance and interpreting what comes
back, and the interesting case is the third one:

- the read succeeds → `yes`
- it fails with a pruning error (`missing trie node`, `state is not available`, …) → `no`
- anything else → `unknown`, with the error as the evidence

"We could not tell" and "it does not" lead to different decisions, and only one of them
means find another endpoint. The probe block must be more than 128 blocks behind the
head, because that is how much state a plain full node keeps: a successful read inside
that window distinguishes nothing, and a short-lived devnet is entirely inside it —
also reported as `unknown`, saying so.

Head age comes from an injected clock, and a head stamped in the *future* is reported
as `clockSkewSuspected` rather than as a very fresh chain. `compareWith` probes several
endpoints and flags the one thing that is never survivable: two endpoints reporting
different chain ids, which is a misconfiguration that otherwise shows up as data that
cannot be reconciled.

No latency is measured. One sample from behind a load balancer says nothing, and a
verdict that depends on it is a verdict that changes between two identical runs.

## `EvmNonceStatus` will not guess

`eth_getTransactionCount(address, "pending")` is not a standard. Plenty of endpoints do
not track a public mempool and answer it with the mined count, so `pending == latest`
means either "nothing is queued" or "this endpoint cannot see what is queued" — and a
confident `clear` from the second is how a harness broadcasts a duplicate.

Hand it the transaction hashes you broadcast and it can decide instead of guessing:

- a transaction this endpoint admits is unmined, on an account whose pending nonce has
  not moved, proves the pending view is not mempool-aware → `mempoolVisible: false`,
  verdict `unknown`
- a transaction waiting at a nonce above the pending nonce proves a hole at the pending
  nonce, which nothing after can be mined past → verdict `gap`
- a hash the endpoint has forgotten, at a nonce the account has already passed, was
  replaced or superseded by something else (pass the `nonce` you sent it with, or the
  two are indistinguishable)
- a pending nonce *below* the latest nonce cannot be true of one node — two sequential
  calls were answered by different machines — so both numbers are reported as unusable
  rather than subtracted

With no hashes supplied, `gapDetection` says so: a gapped transaction sits in a node's
queued pool and is invisible to both nonce counts.

## `EvmTransactionSummary` says what it cannot see

A receipt contains logs and nothing else. Native value moved by a **contract** during
the call leaves no log — it is only visible in a trace, and `debug_traceTransaction` is
neither on a public endpoint's free tier nor on this package's read-only allow-list. So
`netDeltas.complete` is `false` and `completeness.internalNativeTransfers` is
`"excluded"`, in the output rather than only here. A net delta that claims to be
complete and is not is worse than no net delta: it reconciles.

A **reverted** transaction moved nothing. Its value transfer is discarded with the rest
of its state changes and only the fee is charged, so `netDeltas.nativeWei` is `0` and
`netDeltas.reverted` is `true`. A receipt with neither status nor revert — a
pre-Byzantium one, carrying a state root instead — does not record whether the call
reverted at all: the value is counted as moved, and `completeWhy` says that this is a
convention rather than a reading.

Fees are computed from the fields the receipt actually has, not from a chain-id table
that goes stale every time a rollup ships. An OP-stack receipt carries `l1Fee`, which is
charged *separately* from gas — leaving it out understates a Base transaction by most of
its cost. An Arbitrum receipt carries `gasUsedForL1`, whose gas is *already inside*
`gasUsed` — adding anything would double-count. The model that was applied travels with
the number.

Token amounts are raw base units. Resolving symbol and decimals costs an `eth_call` per
token and a token contract is free to report whatever it likes; `TokenUnits` in
`@crewhaus/tool-onchain` will format them against decimals you trust.

## The endpoint is vetted before the socket opens

Every other networked package here builds its URLs from constants, so a model never
picks a host. This one cannot — reading the chain you name means you name the RPC URL —
and an unguarded `fetch(input.rpcUrl)` is a server-side request forgery primitive with a
model steering. `http://169.254.169.254/` is the cloud metadata service.

So: the scheme must be http(s), credentials in the URL are refused, the host is checked
against the loopback, private, link-local, carrier-grade-NAT and multicast ranges —
through every `inet_aton` spelling, because `0177.0.0.1`, `0x7f000001` and `2130706433`
are all `127.0.0.1` — the name is resolved, the resolved address is checked too, and the
connection is pinned to the address that was vetted so a rebinding resolver cannot hand
back a different one at connect time. Error messages carry the origin only: provider
keys live in the path.

IPv6 is classified by expanding the address to its eight groups and doing arithmetic on
them, never by matching its text. One address has many spellings and the one a check is
written against is rarely the one that arrives: `http://[::ffff:169.254.169.254]/` never
reaches a guard in that form, because the URL parser re-serialises the embedded quad and
hands over `::ffff:a9fe:a9fe`. Every transition mechanism that carries an IPv4 address —
IPv4-mapped, IPv4-translated, NAT64's `64:ff9b::/96` (which is exactly what a DNS64
resolver answers for an IPv4-only name), 6to4's `2002::/16`, the deprecated
IPv4-compatible form — is resolved to the IPv4 it carries and judged on that.

With no configuration these tools may dial any public RPC origin. A spec narrows that
to a list, and a compiled bundle, `crewhaus run` and `crewhaus eval` apply it at boot:

```yaml
tool_config:
  chainread:
    allowed_origins: [https://mainnet.base.org]   # the ONLY origins these tools dial
```

A spec cannot open loopback or the private ranges: `allow_private_hosts` in the block
is refused, because a spec can come from a template or a pull request. A local anvil
or hardhat node is the casualty; a host that runs one opens it in code:

```ts
import { setRpcEndpointPolicy } from "@crewhaus/tool-chainread";

setRpcEndpointPolicy({ allowPrivateHosts: true }); // a local devnet
```

Neither is a field in any tool's input schema: a gate a model can open for itself is
not a gate. `EvmRpcHealth` reports the policy it is operating under.

This is a narrower guard than `@crewhaus/tool-fetch`'s `assertNotSsrf`, which is the
repo's canonical one and is not a dependency of this package. It covers the same ground
for the one shape of request made here — a single origin, no redirects followed, no
credentials attached — and a redirect is refused rather than followed, because only the
first URL is ours.

## Quantities

Every chain quantity crosses this boundary as a **decimal string**: wei, token amounts,
nonces, gas, block numbers, timestamps. A uint256 does not fit in a double, and reading
a balance as a number silently loses its low bits. Block numbers get the same treatment
even though today's heads fit — they are compared, subtracted and used as search bounds
all over this package, and one accidental `Number(...)` in that chain is a bug that only
shows up on a chain nobody tested against.

Inputs accept a decimal string, a `0x` hex string or a safe integer. A number past
`Number.MAX_SAFE_INTEGER` is refused rather than rounded: by then it has already lost
its low digits, and accepting it would be accepting a value the caller can no longer
see is wrong.

## Testing

No test in this package opens a socket or sends a DNS query. Three seams, all exported
beside the tools:

```ts
import { _setClock, _setDnsLookup, _setFetch, virtualClock } from "@crewhaus/tool-chainread";
import { makeChain, rpcStub } from "./fixtures"; // src/fixtures.ts, beside the tools

_setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
_setFetch(rpcStub(makeChain({ blocks: 500 }), { silentLogCap: 10 }).fetch);
_setClock(virtualClock());
```

`rpcStub` (in `src/fixtures.ts`) serves a recorded chain and takes the misbehaviours as knobs: a block-span cap
that errors with a suggested range, a result cap that errors, a result cap that
truncates silently, pruned archive state, an endpoint with no mempool view, no finality
tags, an HTTP rate limit, an unreachable host. Every request is recorded, so a test can
assert what a tool actually asked for — that a scan halved its range, that a search spent
the probes it claimed, that a poll stopped when it said it did.

`virtualClock` makes the deadline paths instant and deterministic: `EvmWaitForReceipt`'s
fifteen-minute wait costs microseconds, and the assertion is on the poll count and the
reason rather than on elapsed time.

Each seam restores its production implementation when passed `undefined`, and a suite
that sets one must restore it — the next file in the same bun process inherits it
otherwise.
