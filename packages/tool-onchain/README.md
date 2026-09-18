# @crewhaus/tool-onchain

The onchain arithmetic, offline.

| Tool | Answers |
|---|---|
| `AbiEncodeCall` | what are the exact bytes of this contract call |
| `AbiDecode` | what does this returned hex actually say |
| `FunctionSelector` | what is this function's selector, or this event's topic |
| `AddressCheck` | is this address well-formed, and does its checksum hold |
| `TypedDataHash` | what digest would a wallet sign for this message |
| `TokenUnits` | what is this amount in base units, exactly |
| `DefiMath` | minimum out, maximum in, price impact, share, health factor |

No RPC, no network, no keys. These are the calculations that must be right
*before* a transaction is composed — and a transaction is irreversible, so
"plausible" is not good enough.

## Nothing here signs

No private key is accepted, read or handled anywhere in this package, and a
test asserts that no schema has a field one could be passed to.

`TypedDataHash` computes the digest a wallet *would* sign. That is the useful
half, because it lets a signature request be checked **before** it is
approved: hash the message a human was actually shown and compare it against
what the dapp asked for. A malicious dapp's whole trick is the gap between
those two.

## Verified against published vectors, not against itself

A codec tested only against its own output agrees with itself and with
nothing on a chain. So:

- ABI encoding is checked against real ERC-20 `transfer` calldata, byte for
  byte, and selectors against the ones every block explorer shows.
- EIP-712 is checked against the specification's own worked example — the
  type hash, the domain separator, the struct hash and the final digest.
- EIP-55 is checked against the addresses in that specification.
- Keccak-256, in `@crewhaus/tool-encode`, is checked against the standard
  vectors. It is **not** SHA3-256: same permutation, different padding, and
  substituting one gives a plausible digest that is wrong for every Ethereum
  purpose. WebCrypto offers neither, which is exactly the trap.

## The mistakes it exists to prevent

- **A misplaced offset.** Dynamic values move to a tail and leave an offset
  behind, relative to the start of the enclosing tuple — not the call. A
  wrong offset produces calldata a node accepts and a contract misreads.
- **Alignment.** Fixed bytes are left-aligned, integers right-aligned.
  `bytes4` and `uint32` holding "the same" value are different words.
- **A canonical signature that differs from what was typed.** `uint` is
  `uint256` in the string the selector is hashed over, so writing `uint` and
  hashing it literally gives a selector no contract answers to.
- **Precision.** A `uint256` does not fit in a double; a balance read as a
  number loses its low digits, and two balances one wei apart become the same
  value. Integers are `bigint` or decimal strings throughout, and a number
  past the safe range is refused rather than accepted after it has already
  lost precision.
- **`0.1 * 1e18`.** `TokenUnits` is string arithmetic, and it refuses an
  amount with more decimal places than the token has rather than dropping the
  extra digits.
- **The direction of a rounding error in a bound.** A minimum is rounded
  down and a maximum up; the other way round rejects a swap that was inside
  tolerance or accepts one that was not. Slippage is basis points, never a
  percentage, because a percentage invites a decimal and a decimal invites a
  float.

An address with no checksum is reported as valid **and** as unverifiable,
rather than letting `valid: true` be read as "no typo". A position with no
debt has no health factor rather than an infinite one — `Infinity` would read
as safe to a caller comparing against a threshold.

## What it does not do

- **It does not reach a chain.** No RPC calls, no balances, no gas estimates,
  no broadcasting. Those need a node and belong elsewhere.
- **It does not sign or hold keys.**
- **It does not know what a contract does.** `AbiDecode` decodes the types
  you name; naming the wrong ones produces confident nonsense, which is why
  data that ends early is an error rather than a short answer.
- **It does not fetch an ABI.** Signatures come from the caller.
- **It does not price anything.** `DefiMath` computes against a reference you
  supply; where that reference came from is your problem.
