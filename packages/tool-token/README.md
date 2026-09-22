# @crewhaus/tool-token

Which token is this, and how much of it is there.

| Tool | Answers |
|---|---|
| `TokenResolve` | which address does this symbol actually mean — and is there more than one |
| `Erc20Balance` | how much of this token does this account hold, scaled by the contract's own decimals |
| `Erc721TokenInfo` | who owns this NFT, what standard is it really, and what does its URI say |

## Ambiguity is a refusal, not a best guess

A symbol is not an identifier. Nothing stops a second contract from calling
itself USDC with six decimals and a convincing name, reputable token lists
routinely carry different addresses for the same ticker, and a harness that
sends funds to the first match of a symbol is the accident this package exists
to prevent.

So `TokenResolve` never returns a most-likely. When a query could mean more
than one address it returns **every** candidate with `resolved: false`, each
flagged with what is wrong with it — no code at the address, a total supply of
zero, a symbol the contract does not agree with, a ticker only one list has
ever heard of. Choosing between two contracts that both say "USDC" is a
decision with a wrong answer that costs money, and a string match is not
entitled to make it.

`Erc20Balance` will not take a symbol at all. It takes a contract address, and
says so when handed anything else. There is no path through this package that
reads a balance from a ticker nobody resolved.

### Homoglyphs widen the set; they never pick a different address

"USDC" and "USD**С**" — the second with a Cyrillic С — land on the same
comparison key, so an impostor a literal match would have missed becomes an
*ambiguity you have to look at*. The fold is deliberately small: the common
Latin/Cyrillic/Greek lookalikes, invisible formatting characters, and two digit
shapes. It is not UTS-39, and a symbol that survives it is not thereby safe.

That looseness is affordable because of the direction it is used in. Folding
only ever **adds** candidates, and a wider set can only move the answer towards
a refusal — it can never resolve a query to a different address. A query that
is *itself* confusable is the one case widening cannot help with, so that is
refused outright, before anything is read.

This is exactly the property ENS normalisation does not have, and why
`EnsResolve` is **not** in this package: there, a fold that is wrong by one
codepoint resolves a name to the wrong address and sends funds there. That
needs the real UTS-46 table (`@adraffy/ens-normalize`), not a hand-rolled one,
and it is parked pending that dependency decision rather than shipped
half-done.

## Decimals come from the contract, never from a default

`decimals()` reverting is reported as **unknown**. It is not 18. Every balance
still comes back as exact base units; what is withheld is the decimal form,
because scaling by a number nobody supplied is how a six-decimal transfer
becomes a trillion-fold one.

Every quantity here is a `bigint` or a decimal string, end to end. A `uint256`
does not fit in a double, and eighteen digits of precision silently become
fifteen. The scaling itself is `@crewhaus/tool-onchain`'s, not a second
implementation — as is EIP-55, so there is one checksum in this repository and
it is the one checked against the EIP's own vectors.

### Tokens that predate the standard still work

- `symbol()` and `name()` returning a **`bytes32`** — MKR and other 2017-era
  contracts, deployed before the ABI settled — are decoded, and the answer says
  the encoding was `bytes32` rather than pretending it was a string.
- A call that returns **nothing** is reported as `absent`. `""` and "we could
  not read it" are different facts, and showing the first where the second
  belongs puts a blank where a warning goes.
- Bytes that are not valid UTF-8 come back as `undecodable` with the raw hex,
  never as a row of replacement characters.
- An address with **no code** is refused. Every call to it answers `0x`, which
  decodes as a zero balance for everyone and an empty symbol — it is somebody's
  wallet, or a typo.

## NFT metadata is read only where it costs no trust

`tokenURI()` returns a string chosen by whoever deployed the contract. Fetching
it because a contract said so is a server-side request forgery with extra
steps. So:

| URI | What happens |
|---|---|
| `data:` | decoded in-process — many NFTs are entirely on-chain |
| `ipfs://` | rewritten onto a gateway **you** named, and re-checked to still be inside it |
| `https://` | fetched only from a host **you** allow-listed |
| `http://`, `ar://`, anything else | skipped, with the reason in the answer |

The answer lists what was read and what was skipped, both. The document itself
is third-party content: it is byte-capped, digested, and reported rather than
merged into the tool's own fields, and the URLs *inside* it (`image`,
`animation_url`, …) are listed and never followed — an image URL is the same
untrusted string one level deeper.

Two ERC corners it gets right: the `{id}` placeholder is substituted with the
**64-hex-digit, zero-padded, lowercase** form the spec requires (the decimal id
returns a 404 or somebody else's metadata), and ERC-1155 has no `ownerOf`, so
ownership is answered as `balanceOf(owner, id)` or reported as unanswerable —
never as a `null` that reads like "nobody owns it". A `balanceOf` that reverts
is unanswerable in the same way, with the revert reason, rather than a null
that reads like "this account holds none". A contract that claims to
support the invalid interface id `0xffffffff` says yes to everything, so its
other ERC-165 answers are discounted and the standard is inferred from what
actually replied.

## One block, not a hundred

Reads are batched through Multicall3 by default, because a hundred balances
read one at a time are a hundred balances from up to a hundred different
blocks. `getBlockNumber()` rides along in the same batch, so the answer says
which block it is a snapshot of, and native balances go through Multicall3's
own `getEthBalance` to stay in that snapshot. `batch: false` reads them
one at a time for chains with no Multicall3 deployment, and says in the answer
that the result is not a snapshot.

A sub-call inside that batch is a contract call like any other, and one that
does not answer is **not a zero**. A `getEthBalance` that came back empty —
an aggregator without the helper, a sub-call out of gas — is reported as
`raw: null` with the reason, never as `0`, because "this wallet is empty" is a
sentence a gas check acts on. The same holds for a batch whose
`getBlockNumber()` did not answer: the calls still share one `eth_call`, but
the answer says it cannot be pinned to a block rather than leaving the field
quietly null.

## Nothing here signs or sends

No schema in this package has a field a private key could be passed to, and no
code path composes or submits a transaction. The JSON-RPC methods it can emit
are exactly three — `eth_call`, `eth_getBalance`, `eth_getCode` — refused at a
single gate if anything else is asked for. Both halves are asserted by a test,
not promised by this paragraph.

## No dialling code at all

There is no RPC client and no HTTP client in this package. Both boundaries are
injected:

```ts
import { _setChainReader, chainReaderFromAdapters, _setMetadataFetch } from "@crewhaus/tool-token";

_setChainReader(chainReaderFromAdapters((chainId) => adapters.get(chainId)));
_setMetadataFetch(async ({ url, maxBytes, signal }) => /* your redirect + SSRF policy */);
```

Which means the test suite cannot reach the network even by accident — there is
nothing under the seam to reach it with. Every test drives recorded answers,
and the Multicall3 stub does a real ABI round trip through `tool-onchain`'s
codec rather than a hand-written fake of one.

## What it refuses

A tool that cannot say no is not finished. These say no, with the reason:

- a symbol that means more than one address — `ambiguous-symbol`, with all of them
- a query whose own characters are confusable — `confusable-query`, before any read
- a symbol with no list to resolve it against — `no-lists`
- an address that is on none of the supplied lists — `unlisted` (opt out with `policy: "allow-unlisted"`)
- an address whose EIP-55 checksum does not hold — `invalid-address`
- the zero address — whether it was pasted as the query or carried by a list
- an address with no contract at it
- a token list entry whose `address` field is not an address — `invalid-list-address`
- a contract whose decimals disagree with the list's — `decimals-mismatch`
- more candidates than it was allowed to confirm — `too-many-candidates`
- a symbol where `Erc20Balance` wants an address, pointing at `TokenResolve`
- an `ipfs://` URI that resolves outside the gateway it was given
- an `https://` metadata host nobody allow-listed, and any `http://` URI
- a metadata document over the byte cap — refused rather than parsed as a prefix
- a Multicall3 address that answers with something other than results
- a block tag that is not one, and a token id that is not a `uint256`
