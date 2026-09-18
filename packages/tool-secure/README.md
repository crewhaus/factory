# @crewhaus/tool-secure

Deterministic security, privacy and policy tools. Same input, same bytes: no
clock, no randomness, no network. Most are pure; three read files, always
through workspace containment.

## Read this first

**Every detector in this package is a heuristic.** Pattern matching can show
that something *is* present. It cannot show that nothing is.

The failure mode that actually hurts people is not a missed match. It is a
harness that reads `{"findings":[]}` as "this document is safe to publish"
and ships a spreadsheet of customer records, or reads a low injection score
as permission to let a fetched page steer an agent.

So every scanning tool here returns two things beyond its findings:

- `rulesRun` / `typesRun` / `checked` — what was actually looked for, so an
  empty result reads as a *scope* rather than a verdict.
- `note` — a sentence saying what the absence of findings does not mean.

Those fields are not decoration. They are the difference between a tool that
helps a reviewer and a tool that replaces one.

Two things in this package are stronger than heuristics, and they are called
out as such: the IBAN check digits (ISO 7064 mod-97-10) and the credit-card
check digit (Luhn) are real arithmetic, verifiable offline. They prove a
string is a well-formed instance of its format. They do not prove the account
exists, or that it belongs to anyone in particular.

```yaml
tools:
  - all-secure        # every tool below
  - -Depseudonymize   # ...except this one
```

| Tool | What it does |
|---|---|
| `AllowlistCheck` | Is this URL, email domain or path inside the operator's declared list, and which rule matched |
| `ContentPolicyCheck` | Required phrases present, forbidden phrases absent, claim patterns queued for review |
| `Depseudonymize` | Put original values back, listing tokens the mapping did not cover |
| `EntropyScore` | Shannon entropy in bits per character, with the alphabet's ceiling beside it |
| `HashChainVerify` | Verify a hash-linked record sequence and report the first break |
| `HomoglyphNormalize` | Fold confusable Unicode to ASCII, reporting every change and every mixed-script run |
| `InvisibleCharScan` | Zero-width, bidi, tag, control and unusual-space characters, plus unbalanced bidi per line |
| `PiiRedact` | Replace detected personal data with a placeholder or a keyed HMAC pseudonym |
| `PiiScan` | Find likely personal data with a type, a location, a confidence and the rule that matched |
| `PromptInjectionScan` | Score untrusted content for instruction-override attempts |
| `Pseudonymize` | Replace values with consistent tokens from a caller-supplied mapping |
| `RedactForExport` | PII redaction and secret masking together, with an evidence record |
| `SecretScan` | Credentials in text, a file or a tree — reported masked, never echoed |
| `SignPayload` | HMAC a payload with a key named by environment variable |
| `UrlSafetyCheck` | Structural analysis of a URL without fetching it |
| `VerifyPayload` | Constant-time HMAC verification |

## Masking is a hard requirement

`SecretScan` never puts a credential in its result. Every value is masked to
at most two leading and two trailing characters, and only when the value is
long enough that those four characters are a small fraction of it; anything
shorter is masked whole. A scanner that prints what it found has moved the
secret from a file into a transcript, a log and a model's context window —
three more places it has to be rotated out of.

`src/index.test.ts` asserts that scanning a known credential produces a
result that does not contain it, and `src/lib.test.ts` pins the masking
function itself.

## What each detector actually proves

### Personal data

| rule | proves |
|---|---|
| `email.addr-spec-subset` | dot-atom local part, dotted domain, TLD of 2+ letters. Not quoted local parts, not IP-literal domains, not internationalized addresses |
| `phone.e164` | `+` then 8–15 digits with common separators, taken as the longest whole-group run in that range. Where the next number is grouped the same way, the two are genuinely indistinguishable and the span runs long |
| `phone.national.XX` | a national dialling shape for AU, CA, DE, FR, GB, IN or US — the only countries implemented. An unsupported hint is refused, not approximated |
| `ssn.us-format` | `NNN-NN-NNNN`, excluding groups the SSA has never issued. **Not validity**: an SSN has no public check digit, and this package does not pretend otherwise |
| `iban.iso7064-mod97` | the check digits are correct and, where the country is known, so is the length. A real check |
| `card.luhn` | the Luhn check digit is correct. A real check. A digit run that fails it is not reported at all, because it is an order number far more often than a mistyped card. Candidates are whole digit GROUPS of 12–19 digits, so `4111111111111111 123-45-6789` finds the card instead of failing Luhn on the 19 digits a greedy run produces and reporting nothing |
| `ip.v4-dotted` / `ip.v6-parsed` | a parseable address literal. Ranges from the IANA special-purpose registry are labelled by the prefix they come from — `private`, `loopback`, `link-local`, `shared-address-space` (100.64/10), `documentation` (the three TEST-NETs), `benchmarking` (198.18/15), `reserved` — because those are usually not personal data |
| `dob.labelled` / `date.calendar` | a calendar date. Only a nearby birth-date label, or a `referenceDate` that makes the age plausible, raises it above `possible` |
| `address.us-street-suffix` / `address.us-city-state-zip` | a US-style street line or city/state/ZIP tail. US conventions only |

Names, free-text detail, medical or financial narrative, and every non-US
identifier format are **not covered at all**.

### Secrets

Two kinds of rule. **Vendor** rules key on a published prefix (`AKIA…`,
`ghp_…`, `sk-ant-…`); precise, and they go stale when a provider changes its
format. **Structural** rules key on shape: a PEM block, a JWT, a URL with a
password in its authority, an assignment to something called `password`.

The high-entropy rule is context-gated by default — a high-entropy string
with no credential-ish word near it is not reported, because commit hashes,
UUIDs, base64 images and minified code are all high entropy and a scanner
that cries wolf on them gets switched off. Pass `requireContext: false` to
see them anyway.

One scan produces both the report and the redaction spans. `SecretScan`'s
masked findings and the spans `RedactForExport` removes come from the same
function with the same options, so the set of rules named in `rulesRun` is
exactly the set that runs — a finding cannot be reported and then left in the
document. Where a rule captures the secret in a group (`scheme://user:pass@`,
`password = "…"`), the group's offset comes from the match indices, never
from searching the match for the group's own text: that search finds the
username's copy of the password and redacts the wrong eight characters.

### Prompt injection

A smoke detector, not a defence. The rules are in this repo, which is public,
so an attacker can write around every one of them in a minute. The score sums
each *distinct* rule's weight once, capped at 100 — repeating a phrase forty
times does not make a document forty times more suspicious, and rewarding
repetition would make the score trivially inflatable.

Base64 blobs are decoded once and rescanned. Depth is one, by construction:
content inside a decoded blob is never decoded again.

Hit excerpts are attacker-controlled text. Show them to a person; do not feed
them back to a model as if they were instructions.

The actual defences are architectural: untrusted content stays data, tool
calls need permission, side-effectful actions are confirmed, and a model's
instructions never come from the content it is reading.

### Confusables

The fold is a four-step pipeline, per code point, with source offsets
preserved: ASCII passes through, then a hand-curated confusable table
(Cyrillic, Greek and a few symbol blocks), then NFKD with combining marks
dropped when what remains is printable ASCII, then anything left is reported
as `unfolded` and passed through.

This is an approximation of UTS #39, not an implementation of it. Whole-script
imitations — a domain written entirely in Cyrillic — fold to nothing and show
up only in `mixedScriptRuns`.

### URLs

Structural only. No DNS, no request, no reputation data. A URL with no
findings is structurally unremarkable, which is all. `host.numeric` is
checked against the URL *as written*, because the parser has already turned
`http://2130706433/` into `127.0.0.1` by the time `hostname` is readable.

`checked` lists rule ids in the same vocabulary as `issues[].rule`, so the
two can be joined: an empty `issues` beside a `checked` naming
`scheme.active` means that check ran and did not fire.

### Evidence

The hash-chain convention is stated in every result:

```
hash = H(prevHash + separator + data)
```

with `H` defaulting to SHA-256, `separator` to `"\n"` and the genesis
`prevHash` to `""`. All three are inputs, because chains in the wild differ on
all of them and a verifier that guesses is a verifier that returns a
confidently wrong "valid". `data` must already be canonical: this package
will not serialize an object for you, because two JSON encoders disagree
about key order and a chain that verifies under one and not the other is
worse than no chain.

An intact chain proves the records are internally consistent. It does not
prove who wrote them or when, and whoever can rewrite the whole sequence can
produce a valid chain.

`VerifyPayload` compares `HMAC(key, expected)` with `HMAC(key, provided)`
rather than the signatures themselves, so the comparison is constant time
even when the supplied signature is the wrong length.

## Keys are named, never passed

Every tool that needs a key takes `keyEnvVar` — the *name* of an environment
variable — and reads it itself. The key never appears in an argument, a
result, an error message or a transcript. An unset variable is refused by
name, loudly.

Pseudonym tokens come in two flavours, and the difference is reported in
every result that uses them. **Keyed** tokens are `HMAC-SHA256(key,
"<type>:<canonical>")` truncated: stable across documents, and unlinkable
without the key. **Unkeyed** tokens are a SHA-256 prefix: stable, convenient,
and reversible by enumeration for any identifier space small enough to hash
exhaustively. Unkeyed results carry `reversibleByEnumeration: true` and a
warning, so nobody mistakes them for anonymization.

## Bounds

Every entry point is bounded, and every bound is a *memory* bound rather than
a complaint after the fact.

| Bound | Value |
|---|---|
| Text scanned per call | 2,000,000 characters |
| File read | size checked on the open descriptor *before* any bytes are buffered; 1 MiB default, 16 MiB ceiling |
| Tree walk | 2,000 files, 12 levels, both reported when they bite |
| Mapping | 5,000 entries, 200,000 key characters |
| Policy rules | 200, with 20 reported locations per rule and an exact count |
| Chain | 50,000 records |
| Base64 decode | 100,000 candidate characters, depth 1 |
| Reported hits | 200 per result, with the true total alongside |

## A tree scan says what it did not open

`SecretScan` on a directory does not read everything under it, and the result
says so in the same breath as the findings. Skipped by default:

| reason | what it covers |
|---|---|
| `hidden` | every dot-file and dot-directory — **including `.env`**. Pass `includeHidden: true` to scan them |
| `excluded-directory` | `.git`, `.hg`, `.svn`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `.venv`, `__pycache__` |
| `symlink` | never followed, for containment and to make cycles impossible |
| `binary` | a NUL byte in the first 8 KiB |
| `too-large` | over the per-file cap |
| `unreadable` | a permission error, or not a regular file |

Every one is named in `skipped` with its reason, `skippedByReason` tallies
them, and `skippedTotal` is exact even when the list is truncated. A scanner
that quietly drops `.env` and `node_modules/` and then reports `skipped: []`
is claiming coverage it does not have, and that is the failure in this package
that would actually get someone hurt.

## Containment

Every caller-supplied path goes through `src/paths.ts`'s `resolveSafe`, which
refuses anything resolving outside `process.cwd()` — including via a symlink
inside the workspace. Files are opened `O_NOFOLLOW`, closing the window
between the check and the open. Directory symlinks are never followed, which
makes cycles impossible rather than merely unlikely.

## What is deliberately not here

Anything whose core is judgement. There is no "is this content harmful", no
"is this person's data sensitive", no classifier and no model call. `RuleClassify`-style
decisions belong to the operator: `ContentPolicyCheck` evaluates rules a
person wrote, and `review_pattern` is the rule kind that says "a human looks
at this". A rule whose regex does not compile is reported as `error` and
**fails** the check — an unevaluated rule is not a passed one. Those regexes
are operator-supplied and run untimed, so a pattern with a nested unbounded
quantifier can stall on text it fails to match; write them anchored.

There is also no network. Nothing here resolves a domain, checks a
reputation feed, or calls a breach database — which is why `UrlSafetyCheck`
is honest about being structural, and why the whole package can be run on
content that must not leave the machine.

## Determinism

Listings are sorted with plain string comparison; `localeCompare` would make
the same tree list differently on two hosts. Every comparator is a total
order, because `sort` may reorder elements a comparator calls unequal in both
directions. Nothing samples a clock or a random source — `PiiScan`'s age
plausibility test takes `referenceDate` as an input for exactly that reason.
Entropy is rounded to four decimal places, half-up towards positive infinity.
`src/integration.test.ts` asserts that every one of the sixteen tools returns
identical bytes for identical input.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. A bug in the Luhn implementation reads
better as a failing unit than as a tool call that returned one fewer finding.

## Safety flags

All sixteen are `readOnly`, non-destructive, `scope: "internal"`, and declare
no io capability: nothing here writes, spawns a process or opens a socket.
`src/index.test.ts` asserts that for every tool, so a future addition that
breaks the property fails the suite rather than the deployment.
