# @crewhaus/tool-defi

What is it worth right now — with provenance, and an explicit unpriced bucket.

| Tool | Answers |
|---|---|
| `PriceQuote` | what does the market say this is worth, and which market said it |
| `OraclePriceRead` | what does this feed say, and what does its own freshness signal say |
| `DefiPositionRead` | what is this position, in units that are labelled |
| `PortfolioValuation` | what is all of it worth, and what could not be priced |

Nothing here signs or sends. The RPC method set is `eth_call`, `eth_getBalance`,
`eth_blockNumber` and `eth_getBlockByNumber`, checked first against
`@crewhaus/chain-adapter-base`'s shared read-only chokepoint. No schema has a
field to pass a private key, a mnemonic or a keystore to, and a test asserts
that over every schema in the package rather than trusting this paragraph.

## "Stale" means two different things, so there is no `stale` field

Collapsing them is how a wrong oracle verdict ships, so each feed reports its
own signal under its own name.

**Chainlink** updates on its heartbeat **or** on a deviation threshold. A feed
whose price has not moved legitimately sits past its heartbeat, so elapsed time
alone is not a halt:

| Field | What it is |
|---|---|
| `answeredInRoundBehindRoundId` | `answeredInRound < roundId`. The real incomplete-round fact: a round has opened that no answer has been carried into. |
| `updatedAtZero` | the round has never been completed at all |
| `answerNotPositive` | a price feed answering zero or less is broken, not cheap |
| `secondsSinceUpdate` | `now - updatedAt`, from an **injected** clock — `null` when there is no age to take |
| `updatedAtInFuture` | `updatedAt` is ahead of the clock by more than block-timestamp skew |
| `updatedAtOutOfRange` | `updatedAt` is not a plausible unix second at all |
| `beyondHeartbeat` | `null` unless you supply the heartbeat **and** there is an age — see below |

A heartbeat is a property of the feed's deployment and the aggregator will not
tell you what it is, so `beyondHeartbeat` is `null` rather than `false` when you
do not supply one. A tool that guessed a heartbeat would be inventing the
threshold it then judges against. When you do supply one, read the answer as a
question: past the heartbeat with a complete round is the ordinary quiet-market
case, and there is a test for exactly that shape.

`beyondHeartbeat` is **also** `null` when the age cannot be taken — a feed dated
in the future, or one whose `updatedAt` is not a timestamp. `false` is a claim
("this feed is inside its heartbeat"), and a threshold that could not be
evaluated must never be reported as one that held: a feed stamped a year from
now otherwise passes every freshness gate downstream of it. Timestamps are
carried as exact decimal **strings**, because a uint256 through a double prints
as `5.8e+76`, which is neither the value nor a time.

`description()` is contract-supplied text, and you reached the feed with an
address somebody gave you. It is capped at 128 characters and stripped of
control characters before it appears in a result, and both facts are said in
`notes` when they apply — a real aggregator's label is `"ETH / USD"`, so a long
one is a reason to check the address, not a label. The same scrub runs over
revert strings, which are free text a contract chooses too.

**Pyth** is a different quantity in different units. Its signal is
`confidenceToPriceBps` — the width of the confidence interval relative to the
price. A Pyth price two seconds old with a 400 bps band is worse than one a
minute old with a 3 bps band, and no single boolean can say that.

Every reading also carries the feed's own `description()` (`"ETH / USD"`), which
is the cheapest available check that a pinned address is the pair you meant.

## Every price carries its provenance

Which source, which round or which fixing date, and **how it was derived**:

- `direct` — the provider publishes this pair.
- `inverted` — the provider publishes the other direction; the price is 1/theirs,
  rounded half-even once, at 18 places, and the leg names the pair that was
  actually published.
- `cross` — no provider publishes it, so two prices were composed. The result
  names the intermediate and carries **both** legs with their own provenance.
- `oracle-direct` — read onchain at a stated block, with the round id.

A composite is only as dated as its least dated leg, so a cross with one
undated leg has `asOf: null` rather than the other leg's date.

## Coinbase publishes no timestamp, so `asOf` is null

`/v2/prices/{pair}/spot` returns `{ "data": { base, currency, amount } }` — that
is the whole document. There is no timestamp field, so the reading carries
`asOf: null` and `asOfSource: "none"`. Stamping it with the time the response
arrived would make every price look fresh by construction.

The survey that proposed these tools assumed every provider had a timestamp to
stamp `asOf` from. This one does not, and two things follow from saying so:

1. **A historical crypto quote is refused.** The spot endpoint echoes no date,
   so an answer from it cannot be told apart from today's price — and a price
   that cannot be distinguished from today's must not be labelled as last
   Tuesday's. The refusal names what to do instead: read a Chainlink round at a
   pinned block, or quote the asset against a currency the ECB publishes.
2. **A fiat rate is a different story.** Frankfurter republishes the ECB's daily
   reference rates, one fixing per TARGET business day at about 16:00 CET. Ask
   for a Saturday and the answer comes back stamped with Friday's fixing — that
   returned date is the `asOf`, and it is what makes a reconciliation reproduce.

One smaller honesty: Frankfurter publishes its rates as bare JSON **numbers**,
which `JSON.parse` turns into doubles before anything here sees them, while
Coinbase publishes strings. Each leg says which it was in `literal`. Five
significant digits survive a double intact; twenty would not, and the field is
there so nobody has to guess which case they are in.

## The unpriced bucket

`PortfolioValuation` returns three separate fields, and the middle one is not
the sum of the other two:

```
total     the value of the PRICED holdings, and it says so in the payload
priced[]  one row per holding with an amount, a price, a value, a weight
          and the provenance of that row's own price
unpriced[] one row per holding that could not be priced: the asset, the
          amount when it is known, and WHY
```

A total that silently drops the assets it could not price is a number somebody
will put in a report, and it will be wrong in the direction that looks good. So
a holding goes to `unpriced[]` — never to zero, never to absence — when:

- it names no price source, or more than one;
- it names more than one **amount** source (`amount`, `baseUnits`, `token`,
  `native`) — preferring one silently would hide which figure the row is;
- its amount and its price between them need more decimal places than this
  carries, so the product is refused (one row's arithmetic is one row);
- its oracle's round is incomplete, or the feed answered zero or less;
- its Pyth confidence band is past the bound you supplied;
- its token's `decimals()` could not be read and none was given (defaulting to
  18 on a six-decimal token is a factor of a trillion);
- a provider refused, rate-limited, or answered in the wrong currency.

`weightBps` is a share of the **priced** total, which is stated in the payload
too — the weights of an incomplete portfolio still sum to 10000, and that is
only honest if the reader knows what they are a share of.

`minValue` flags small rows as dust and summarises them. It does **not** remove
them from the total: a floor that took value out of a total would be the same
silent loss as an unpriced asset wearing a different hat.

### One block, or a refusal

Every read in one answer shares one block tag. When no block is given, the head
is pinned with `eth_blockNumber` first and every read uses that — two reads
tagged `latest` a second apart can land on different blocks, and the valuation
is then a number that never existed at any height.

A historical valuation must pin **both** ends:

| `blockNumber` | `at` | Quote-provider prices? | |
|---|---|---|---|
| — | — | yes | live balances, live prices |
| set | — | none | balances and oracle prices at the same block |
| set | set | yes | balances at the block, prices at the date |
| — | set | — | **refused** — resolving a date to a block is `EvmBlockAtTimestamp` |
| set | — | yes | **refused** — a historical balance at today's price |

## Positions: each protocol's own basis, labelled

`aave-v3`, `compound-v3` and `erc4626`. Everything else is refused by name with
what reading it would take — `morpho-blue` needs the market's own oracle read at
the same block, a Uniswap v3 LP position needs tick math, a Maker vault is an
urn addressed by ilk. An unpinned protocol is refused, never probed.

- **Aave v3** answers in the price oracle's base currency. The base unit is a
  market parameter, not a constant, so `baseCurrencyDecimals` is an input with a
  default of 8 (what the USD markets use) and a `baseCurrencyDecimalsAssumed`
  flag saying whether the default was taken. Its health factor for a debt-free
  account is `type(uint256).max`, which read as a wad is 1.15e59 and prints as a
  spectacularly safe position — so it is reported as `null` with a reason.
- **Compound v3** has one borrowable asset, so a supply balance and a borrow
  balance are mutually exclusive, and both are in base-token units. Its
  liquidation verdict comes from the protocol's own `isLiquidatable(address)`
  rather than being derived, because Comet's collateral factors are per asset
  and a derived answer would disagree with the protocol UI.
- **ERC-4626** shares are worth `convertToAssets(shares)`, not
  `totalAssets()/totalSupply()`. The two differ for any vault with an entry or
  exit fee, and the second is the one that looks right.

### No liquidation price

`collateralDropToLiquidationBps` instead: how far the whole collateral basket
may fall before the health factor reaches 1. A liquidation *price* for an
aggregate position is not a fact — it depends on which collateral you assume
moves, and picking one produces a number that looks authoritative and disagrees
with the protocol UI. The drop needs no assumption and is what the liquidation
price was being used to approximate. A position already below 1 reports 0 rather
than a negative number.

## Configuration

Endpoints and pinned feeds come from the `defi` `tool_config` block (a
compiled bundle and `crewhaus run` register it at boot), or from
`registerDefiConfig(...)`. **No caller ever supplies a URL** — that is
what keeps the network surface short: there is no model-chosen host to defend,
so no allow-list to widen and no SSRF gate to get subtly wrong, and an
operator's own node on `127.0.0.1:8545` is a first-class endpoint rather than
something a private-address rule has to be argued out of.

```jsonc
{
  "rpc":        { "1": "$ETH_RPC_URL" },
  "multicall3": { "1": "0xcA11bde05977b3631167028862bE2a173976CA11" },
  "feeds": {
    "eth-usd": {
      "chain_id": "1",
      "kind": "chainlink",
      "address": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
      "heartbeat_seconds": 3600
    }
  }
}
```

A provider keeps its API key in the RPC URL's path, so write the endpoint as a
`$VAR` reference: the bundle reads it from the environment when it starts, and
the key never sits in the spec, the spec registry or the compiled bundle. An
unset variable stops the start and names it.

A per-call block **replaces** the boot registration rather than merging into it,
which is the same replace semantics every other tool_config block here has.
`multicall3` is an optimisation, not a requirement: with it, forty reads are one
round trip; without it, they are forty reads at the same pinned block. A chain
that predates Multicall3 works either way, and a test runs the same scenario
both ways and compares the answers.

An endpoint appears in output and in refusals as its **origin only**. Provider
RPC URLs carry the API key in the path, and a refusal is not the place to put
one into a transcript.

That holds for borrowed strings too, which is the harder half: a dialler that
reports `unable to connect to <url>`, or a node that quotes your project path
back at you in its own error, is handing over the credential inside a message
this package only concatenates. The URL, its path and its query are redacted
out of every such message before it becomes a failure — the host stays, because
a refusal naming no host is unactionable.

## What is borrowed, and what is not

- **The ABI coder is `@crewhaus/tool-onchain`'s**, and the Multicall3 packing is
  its `encodeAggregate3`/`decodeAggregate3`. The handful of selectors this
  package issues are constants here — there is no Keccak in its dependency set —
  and every one of them is put through tool-onchain's `FunctionSelector` in the
  suite, alongside every encoder and decoder against `AbiEncodeCall` and
  `AbiDecode`. A hand-rolled decoder tested against a hand-rolled encoder agrees
  with itself about any mistake the two share.
- **Addresses are shape-checked, not checksum-verified.** EIP-55 needs Keccak.
  Run `AddressCheck` in `@crewhaus/tool-onchain` on an address before pinning it
  — reading the wrong contract is not an error this package can detect, it is a
  wrong answer.
- **The currency table is `@crewhaus/tool-math`'s** `CURRENCY_MINOR_UNITS`, which
  is what sets the default decimal places for a total: a yen is not divisible,
  so two places there would be an invented precision.
- **The decimal arithmetic is local**, in `src/lib/decimal.ts`, because
  tool-math's kernel is module-private behind its entrypoint. Every rounding
  case in it is pinned against tool-math's `Round` tool — through that public
  surface — on the ties and modes where two implementations diverge if they ever
  will.

## Testing

Two seams, both exported beside the tools: `_setFetch` replaces the dialler and
`_setClock` replaces the clock. Every test drives them, several assert that
nothing was dialled at all, and nothing in the suite resolves a name or opens a
socket — a test that reached a public RPC would fail on a runner with no egress
and flake on somebody else's rate limit, and one that reached a price provider
would assert today's Bitcoin price.

`src/fixtures.ts` holds the recorded chain and the two recorded provider
documents. The fixture node really implements Multicall3 — it decodes the
`aggregate3` calldata, dispatches each sub-call against the same routing table
and re-encodes the results — so the batch path is the path production takes
rather than a special case that proves nothing.
