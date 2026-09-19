# @crewhaus/tool-secrets

Answering questions about secrets without handing one over.

| Tool | Answers |
|---|---|
| `SecretLookup` | does this reference resolve, from where, and is it the same secret as that one |
| `EnvFileUpsert` | put this value in that `.env`, in place, without telling anyone what it is |
| `SecretRotate` | replace a stored secret and prove the new one reads back before retiring the old |

## A tool result never contains a secret

Not on success, not in an error, not in a diff, not behind a flag. A tool
result is read by a model, and from there it is in a transcript, a trace, a log
export and a support ticket; a secret that enters that path has to be treated as
rotated whether or not anybody noticed.

So `SecretLookup` reports **that** a reference resolves, **which backend**
answered, and a **fingerprint** — never the plaintext. There is deliberately no
`reveal` option, because the option is the vulnerability: the moment one exists,
a model under pressure to "just check the value" will pass it. If you need to
see a secret, you have a terminal.

This is the same line `@crewhaus/tool-notify` already draws: its SMTP
credentials arrive already resolved from an environment variable NAME, and its
transcript records `AUTH PLAIN <redacted>`.

## What a fingerprint is, and what it is not

The first 12 hex characters of a domain-separated SHA-256. Domain separation (a
fixed prefix and a NUL) means it is not the number `sha256sum` prints, so a
fingerprint that escapes into a log cannot be looked up in a table somebody
computed for another purpose. 48 bits is far more than enough to tell two
credentials apart or to notice a rotation.

It is **not** a way to hide a low-entropy secret. A four-digit PIN or a
dictionary password can be confirmed against its own fingerprint by anyone who
can guess it, and the reported `length` narrows the guessing. These tools are
for high-entropy credentials — API keys, tokens, generated passwords. That is a
deliberate trade: `length` and `trailingNewline` are what actually diagnose a
broken credential, and a report that omitted them would send operators back to
`echo $TOKEN`, which is the thing this package exists to replace.

## References name a place, never a value

```
SLACK_TOKEN                     the local chain: environment, .env.local, .env, .crewhaus/secrets/
env:SLACK_TOKEN                 this process's environment
file:.crewhaus/secrets/token    a file inside the workspace
envfile:.env#SLACK_TOKEN        one key in one .env
keychain:acme-api#deploy        macOS login keychain (security)
pass:acme/deploy                password-store
libsecret:service=acme-api      the Linux session keyring (secret-tool)
op://Private/Acme/credential    1Password CLI
```

A **bare name** searches the whole chain rather than stopping at the first
answer, because the interesting bug is not "it is missing", it is "it is
defined in three places with two different values and the one you are editing
is not the one that wins". That comes back as `alsoDefinedIn`, with fingerprints
that say the values differ without saying what either of them is.

## `.env` is a file a human edits

`EnvFileUpsert` is a splice, not a re-serialization. Comments, blank lines, key
order, the `export ` prefix and CRLF line endings all survive; an existing
assignment is rewritten where it stands, and a `# KEY=` stub is promoted in
place rather than shadowed by a second assignment appended lower down. A key the
file assigns twice is **refused** with both line numbers, because the later one
is what the reader takes and rewriting either would be a guess.

Every edit in one call lands in one atomic write, or none of them do. The file
is written through a temp file created at mode 0600 — `writeFileSync`'s `mode`
applies at creation only, and a chmod afterwards is a race the plaintext loses —
and a `.env` never comes back more permissive than it went in.

### There is no `.env` quoter here, on purpose

This repo has already shipped the bug a second `.env` codec causes: a writer
escaped `\` and `"` whenever it quoted, the readers did not unescape, and
`K="a\"b"` came back as `a\"b`. factory#452 fixed it by making
`unquoteEnvValue` in `@crewhaus/harness-supervisor` the single canonical
**reader**, which is what this package imports.

The matching **writer**, `encodeEnvValue`, exists twice — privately in
`@crewhaus/hangar-server` and again in `@crewhaus/service-setup` — and is
exported from neither. So this package does not have one and does not write one.
It writes only values that need no quoting at all, and it proves that with the
canonical reader rather than with a charset guess: the candidate line is handed
to `parseEnvText` and the result must equal the value byte for byte.

A value containing whitespace, a quote or a `#` is therefore **refused**, with a
message naming the export that would remove the limitation. That is a real gap —
write such a value by hand until `encodeEnvValue` is exported — and it is the
honest one. A refusal an operator can act on beats a secret silently rewritten.

## Rotation, in the order that matters

If a rotation half-succeeds, the operator is locked out of their own service. So
`SecretRotate` runs a fixed sequence and names every step in the result:

| Step | What it guarantees |
|---|---|
| `lock` | two callers cannot rotate the same secret at once; the second is refused, not queued |
| `read-current` | there is something to roll back to, and we know its fingerprint |
| `interval-guard` | a policy's "not more often than" is checked against the local journal |
| `new-value` | generated here, or read from another reference; identical-to-current is refused |
| `keep-previous` | the old value is preserved **before** anything is replaced |
| `write-new` | the new value goes in — on stdin for command backends, never in argv |
| `verify` | the reference is **re-read** and its fingerprint compared; a mismatch rolls back |
| `record` | the journal is written before any retirement, so a rotation cannot go unrecorded |
| `retire-previous` | only now, and only if you asked |

A failure at any step leaves the old value working and says which step failed.
If the new value was already written when verification failed, the old one is
written back through the same path, and the result reports whether that took —
including the unhappy case, where you get `rolledBack: false`, the previous
fingerprint, and where the kept copy is.

`dryRun` walks the same code path and stops at each syscall instead of making
it, so `write-new` reports the outcome the real plan would produce
(`uncommented`, not a guess at `appended`).

**It does not revoke anything at a provider.** Rotating `envfile:.env#STRIPE_KEY`
changes what your harness sends; the old key stays valid at Stripe until you
revoke it there. Every rotation result says so.

### What cannot be rotated, and why

| Backend | Why |
|---|---|
| `env:` | an environment variable belongs to a process that is already running |
| `keychain:` | `security add-generic-password` takes the password as an argv element, and `ps` shows argv to every user on the machine |
| `op://` | writing a field needs the item's schema (`op item edit`); guessing it edits the wrong field |

`file:`, `envfile:`, `pass:` and `libsecret:` rotate — the last two because they
accept the new value on **stdin**.

## No shell, and no bare word that could be a flag

Every command is an argv array handed straight to the OS. Beyond that, this repo
has already shipped argument injection once — `gitBranchCreate({name:"-D"})` ran
`git branch -D victim` — so any reference component beginning with `-` is
refused before an argv is built. For `pass`, `secret-tool` and `op` that refusal
is load-bearing (the value is a bare positional word). For `keychain` it is
belt-and-braces: the value is the argument of `-s`/`-a`, which getopt(3) consumes
unconditionally — verified against the real binary. `op` gets a `--` terminator
because cobra honours one; `pass` and `secret-tool` do not, because whether their
getopt(1) wrapper and GOption consume a bare `--` could not be verified here, and
a terminator a helper does not understand turns every lookup into an error.

Credential helpers inherit a named forward list (`PATH`, `HOME`, the D-Bus and
password-store locations, the `OP_*` tokens) and `LC_ALL=C` — not the harness's
environment. Your Anthropic key has no business inside `op`.

## "It did not resolve" is three different situations

- **absent** — the helper works and there is no such secret. Fix the name.
- **unavailable** — the helper is not installed here. Fix the machine.
- **error** — a locked keychain, no D-Bus session, a gpg key that cannot
  decrypt, an expired `op` session. *Nothing is known about whether the secret
  exists*, and reporting "absent" here is the lie that sends an operator off to
  rename a secret that was there all along.

A timeout and a truncated read are errors with their own reasons, never absent.
So is a probe that could not run: a file whose `stat` fails with anything but
`ENOENT` (a directory you may not traverse, a symlink loop), a helper that died
without a message, and a place in the bare-name chain that outranks the winner
and could not be read — that last one is reported as `couldNotCheck`, because
the value below it is only the winning value if the place above holds nothing.

A `SecretLookup` that is cancelled part-way reports `requested` alongside
`checked` and withdraws `allResolved`, rather than making a claim about
references it never looked at.

For `SecretRotate`, the same rule applies to the things it cannot know:

- `minIntervalHours` on a journal that cannot be read, or an entry whose
  timestamp cannot be parsed, is REFUSED — an interval that cannot be measured
  has not been met. With no interval asked for, a broken journal is reported
  and the rotation proceeds.
- a failed `write-new` re-reads the secret before saying anything about it. A
  helper can store the value and still exit non-zero (`pass insert` writes the
  entry, then git-commits it), so `oldValueStillInPlace` is verified, and is
  `"unknown"` when the read-back cannot settle it either.
- a rotation lock whose age cannot be established — empty, truncated, or
  carrying no `startedAt` — is not broken as stale. The lock is created with
  `open(wx)` and written separately, so a concurrent caller can catch it
  zero-byte; "I could not read it, so I took it" would let both rotations run.

## Testing

Every parser takes its input through `_setRunner`, and every test drives it from
recorded output in `src/fixtures.ts` — macOS `security` (captured on this
machine), `pass`, `secret-tool` and `op` (transcribed, and labelled as such),
plus LF and CRLF `.env` files. The clock (`_setClock`), the environment
(`_setEnv`) and the CSPRNG (`_setRandomBytes`) are seams for the same reason.

Exactly one test touches the real host, and it asserts shape only.
