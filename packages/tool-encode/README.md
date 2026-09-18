# @crewhaus/tool-encode

Deterministic encoding, hashing and identifier tools. Same input, same bytes,
every time: no filesystem, no network, no clock, no ambient randomness.

Where a value would normally come from the environment, it is an input
instead. A tool that needs "now" takes the instant as an argument. A tool that
needs entropy takes a `seed`. That is what makes a retried step, a replayed
run and a test produce the same answer — and it is why the one tool that does
reach for the system CSPRNG announces itself.

```yaml
tools:
  - all-encode        # every tool below
  - -jwtVerify        # ...except this one
```

`all-encode` resolves once `encode` is registered as a leaf category in
[`@crewhaus/tool-categories`](../tool-categories); this package does not
register itself. Until then, name the tools individually.

| Tool | What it does |
|---|---|
| `Hash` | SHA-256/1/384/512 or MD5 of text, as hex, base64 or base64url |
| `Hmac` | Keyed HMAC, with an optional constant-time comparison against an expected value (compared as bytes, so case and padding do not matter) |
| `Checksum` | CRC-32 or Adler-32 — corruption detection, not tamper detection |
| `Base64Encode` | Standard or URL-safe alphabet, padding on or off, hex input for binary |
| `Base64Decode` | Tolerates missing padding, both alphabets and PEM line breaks |
| `HexEncode` | Hex, optionally uppercase and separated |
| `HexDecode` | Tolerates `0x`, `:`, `-`, `_` and whitespace |
| `UrlEncode` | Component, whole-URI or form encoding |
| `UrlDecode` | The inverse of each |
| `UrlParse` | Scheme, host, port, path segments, query pairs, fragment |
| `UrlBuild` | The inverse, encoding each part for where it lands |
| `UrlNormalize` | Canonical form: sorted query, no default port, no dot segments, optional tracking-parameter stripping |
| `Uuid` | v5 and v3 from a namespace and name, v4 from a seed, or v4 from the CSPRNG |
| `Ulid` | Time-sortable ids for an explicit instant, entropy from a seed |
| `NanoId` | Compact URL-safe ids from a seed, unbiased |
| `Slugify` | URL-safe slugs with Latin transliteration |
| `JwtDecode` | Header and payload **without** verification |
| `JwtVerify` | HS256/384/512 signature, plus `exp`, `nbf`, `iss`, `aud`, `sub` |

## The one non-deterministic path

`Uuid` with `version: "v4"` and no `seed` draws from the platform CSPRNG, so
two identical calls return different ids. That is the point of a v4, and it is
occasionally what a harness genuinely needs — so it exists, the result carries
`"deterministic": false` and a warning, and the same tool offers two
deterministic alternatives: `seed` for a reproducible v4, or `version: "v5"`
with a namespace and a name for an id derived from the data itself.

A seeded id is reproducible, which means it is **not unpredictable**. Never use
one as a session token, a reset nonce or anything else whose safety rests on
being unguessable. The seeded stream is cyrb128 into sfc32 — fast and
well-distributed, not cryptographic.

## Time in, time out

`Ulid`, `JwtDecode` and `JwtVerify` take the instant as an argument, and this
package parses it itself rather than handing it to `Date.parse`. That matters
for one reason: ECMAScript says a date-time with no offset — `2026-09-17T09:00:00`
— is **local** time, so the same spec would mint different ids and reach
different expiry verdicts on a laptop in Los Angeles and on a runner in UTC.

So the grammar is fixed and narrow: `YYYY-MM-DD`, or
`YYYY-MM-DDTHH:MM[:SS[.fff]]` with an optional `Z` or `±HH:MM`, or a run of
digits read as epoch seconds or milliseconds depending on the field.
**An instant with no offset is read as UTC.** A date that does not exist
(`2026-02-31`) and a format only some engines accept (`Sep 17 2026`) are both
refused by name rather than guessed at.

## What these tools are honest about

**Decoding is not verification.** `JwtDecode` reads a token's claims without
checking anything; every field it returns is attacker-controlled. It says so in
its description, and again in every result.

**MD5 and SHA-1 are broken.** They are here because other people's data uses
them — legacy ETags, artifact manifests, UUID v3. `Hash` returns a warning
alongside those digests. `Hmac` offers the SHA family only.

**CRC-32 and Adler-32 are not hashes.** They detect accidental corruption and
are trivially forged. The result says that too.

**`JwtVerify` supports HS256, HS384 and HS512 only.** RS\*, PS\*, ES\* and EdDSA
need asymmetric verification, which this package does not do — it refuses them
rather than pretending. `alg: none` is refused unconditionally, and the
expected algorithm comes from the caller, never from the token's own header.

**`Slugify` does not romanize non-Latin scripts.** Accented Latin folds to its
base letter by Unicode decomposition, plus an explicit table for the letters
that have no decomposition (ß, ø, þ, ł, đ and friends). Cyrillic, Greek, Arabic
and CJK are kept only with `allowUnicode`; otherwise they are dropped and the
result says the slug came out empty.

**URL handling is the WHATWG parser's**, the same one a browser uses, so the
results agree with what a request would do: lowercased scheme and host,
punycode for international hosts, default ports dropped, dot segments resolved.
It does not rewrite `%7E` to `~`, because unreserved-character decoding is not
safe in every component. `UrlNormalize` sorts query parameters by default, by
UTF-16 code unit rather than by locale — `?B=1&a=2` stays in that order on
every machine, which `localeCompare` would not guarantee. Turn sorting off for
a signed URL whose signature covers the order.

**A password in a parsed URL is masked**, in `href` as well as in the
`password` field.

**The base64 and hex decoders are tolerant, not validating.** They accept both
base64 alphabets, missing padding, PEM line breaks and `0x`/`:`/`-`/`_`
separators, and they ignore the leftover bits of a non-canonical final
character — so `YQ` and `YR` both decode to `a`. Use them to read data, not to
decide whether a string was well-formed.

**A name-based UUID cannot be batched.** `count` works for `v4`, seeded or not,
because each id comes from its own seed. For `v3`/`v5` the id *is* the hash of
the name, so `count: 2` from one name is refused rather than answered with the
ids of an invented `name0` and `name1`. Seeded batches always index from zero,
so a batch of one and a batch of ten agree about the first id — a retry that
batches differently does not renumber.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. Vectors come from the specifications
rather than from this implementation: RFC 1321 for MD5, FIPS 180 for SHA,
RFC 4231 and RFC 2202 for HMAC, the published UUID v3/v5 and ULID examples,
and the jwt.io sample token. MD5 additionally gets a differential test against
Bun's own implementation across three hundred input lengths, which is what
catches a padding bug at a block boundary, and the seeded stream is checked
against an independent transcription of cyrb128 and sfc32 as well as pinned to
its first draws — a seeded id is only reproducible if the stream never moves.

`src/index.test.ts` also scans this package's own source for `Date.now`,
`new Date()`, `Date.parse`, `Math.random`, `localeCompare`, `toLocale*`,
`Intl`, `process.env`, a node builtin import and `fetch`, and asserts the
CSPRNG is reached from exactly one file. A future tool that quietly reads the
clock, the locale or the environment fails the suite rather than the harness.

## Safety flags

All eighteen are `readOnly`, non-destructive, `scope: "internal"`, and declare
no io capability, because none of them crosses a process or network boundary.
`src/index.test.ts` asserts that for every tool, so a future addition that
reaches outside has to change the assertion deliberately.
