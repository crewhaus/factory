# @crewhaus/control-records

The file layer under the shared control core ([#507](https://github.com/crewhaus/factory/issues/507),
[#513](https://github.com/crewhaus/factory/issues/513)). Every control fact about a harness is a
file inside that harness. This package decides how those files are appended to, how an exactly-once
fact is settled, how a large file is read from its newest end, and how a reader resumes without
missing or repeating a line.

The design is in [module brief 324](https://github.com/crewhaus/docs/blob/main/module-briefs/324-control-records.md).
It is light and node-only: it imports `@crewhaus/control-contract`, `@crewhaus/infra-utils`,
`@crewhaus/tool-safety/fs` and Node built-ins, and it spawns no process, so a compiled daemon can
import it. `surface.test.ts` holds that.

Primitives land here ahead of their callers. One caller is wired today, Hangar's approvals inbox, and
each export names its first consumer below.

## Files

`controlPaths(harnessDir)` spells these, relative to the harness, so no caller does; its first consumers
are the run ledger and the receipts. Directories are created only on a write path, `0700`; files are
`0600`. A file appears when a write first needs it, never at boot or on a read.

| Under `<harness>/.crewhaus/run/control/` | What it is |
|---|---|
| `lock` | the lock that orders fold-then-append sequences |
| `claims/<kind>/<name>.json`, `claims/gen/<object>/<n>.json` | one file per exactly-once fact: `{v, claim, at, seg, record}` |
| `<ledger>/NNNNNN.jsonl`, `<ledger>/watermark.json` | a segmented ledger, and `{v, seg, at}` for what has been dropped |
| `<ledger>.jsonl` | a single-file ledger, which never rolls; its positions are at segment `0` |
| `keys/digest.key` | the harness's digest key: 64 lowercase hex and a newline |
| `leases/mutating.json` | `{v, pid, startedAt?, host, head, kind, acquiredAt, leaseRef}` |
| `operator.json` | whether intake is paused and the deployment disabled |
| `approvers.json` | the harness's copy of who may decide what |

Every primitive takes a containment root plus record paths relative to it, so the same code serves a
harness directory, a session root and the Hangar root.

## Ledgers and claims

A ledger is `{root, records: {dir} | {file}, lock, claims, machine?}`, each path relative to `root`;
`harnessLedger(harnessDir, records, {machine?})` fills in the shared lock and claims (first consumers:
the run ledger and the receipts). `machine` is set only for an object on a
control-contract machine. A record's lifecycle fields are its top-level `id` and `state`.

A claim file, published whole and exclusively, **decides** an exactly-once fact. The lock only orders
appends: the shared lock policy steals any lock older than 30 seconds, so a writer paused across a
laptop sleep can wake to find another inside. A crash between claim and append is repaired on the
next touch, and that repair can race a slow but live winner, so a claim's record can land twice.
**Every fold counts one record per `claim` value, the first line, and only the caller answered
`won: true` may perform the effect.**

| Export | Contract | First consumer |
|---|---|---|
| `append(ledger, record)` | One `O_APPEND` line, no lock and no read. A line of 4,096 bytes or more, its `\n` counted, is refused with `too-large`. | the run rows |
| `withLedgerLock(ledger, fn)` | `fn` runs under the lock with a locked append that first seals a torn final line. | the run ledger and the receipts |
| `publishClaim(ledger, claim, record)`, `readClaim(ledger, claim)` | `<kind>/<name>` or `gen/<object>/<n>`; a second publish answers `code: "exists"`; anything else is refused. | session-store's `decide` |
| `appendClaim(ledger, {claim, record})` | Publish, then append stamped with `claim`. Answers `{won: true}` or `{won: false, winner}`. A claim whose `seg` is below the watermark is never repaired. | decisions, idempotency, receipts |
| `casAppend(ledger, id, expectState, next)` | Fold, check, publish `gen/<id>/<g+1>`, append `{...next, id, gen}`. Answers `{applied: true}` or `{applied: false, current, illegal?}`. Generation claims are never removed. | activation, `dec_` decisions, attention overlays |
| `foldStates(ledger)` | Every retained segment, uncapped, through the machine. An illegal row is kept, returned as an anomaly `{id, from, to, at}` and never applied. | the run ledger and the receipts |
| `dropSegmentsBefore(ledger, seg)` | Under the lock: the watermark first, then the files. It only rises, and the newest segment is never dropped. | the scheduler's retention |

Generation claims are keyed by `id` alone, so ledgers that share a claims directory must not reuse an
id. A refused publish or append answers tool-safety's `SafeFsFailure`. A lock that cannot be taken rejects
with `withFileLock`'s own error, its message intact.

**Segments.** A writer appends to the highest-numbered `NNNNNN.jsonl`. Past 8 MiB, the writer targets
the next number and creates it exclusively; a racing roller appends to the same new file. Nothing is
renamed, so an appender that opened a rolled segment can still land a late line. Every segment below
the watermark is evicted, even one not yet unlinked.

## Readers

| Export | Contract | First consumer |
|---|---|---|
| `readTail(root, given, {maxLines, maxBytes, followLeafSymlink?})` | Reads backwards, at most `maxBytes` plus one chunk. The newest complete lines in file order, `truncated`, `gaps`, `torn`. An absent file and a refused open are distinct answers. | Hangar's approvals inbox |
| `readPage(ledger, {limit, before?})` | Newest first across segments down to the watermark: `{items, next?, snapshotAt, gaps}`. `snapshotAt` is taken first and bytes past it are ignored, so "list, then resume from `snapshotAt`" has no gap and no duplicate. | the v1 lists |
| `snapshotAt(sources)` | A vector at the end of each source's last complete line, holding up to its newest two segments. | the resumable streams |
| `resume(sources, vector, {maxLines, maxBytes})` | `{items, next, waiting}`; items are `line`, `gap` or `reset`. Never throws on what a client sends. | the resumable streams |

A torn final line waits. A complete line that does not parse to a JSON object is a gap, and reading
goes on. A vector's position is control-contract's `CursorPosition`: `off` is the next unread complete
line and `tail` is the first 8 hex of sha256 over the up-to-64 bytes before it. A mismatch, a shorter
file or a mid-line offset is a `reset`; a position below the watermark is an `evicted` gap. `next` holds
the last two segments read into, so a line landing in the previous segment just after a roll is
delivered, and always passes `encodeCursor`. The wire string is control-contract's codec, called by
the HTTP layer.

## Safety records

Both readers are synchronous, take no lock, create nothing and consult no environment variable. Each
caches for one second per path by an injected clock, through its `create…Reader`. Absent is not an error. A file that is empty, torn, over its cap, a
link, a directory or otherwise not the record is **unreadable**, and the reason names the file and the
fault, never a value from it.

| Export | Contract | First consumer |
|---|---|---|
| `readOperatorRecord(harnessDir)`, `createOperatorReader({now})` | `operator.json`: `{v, rev, intake, deployment, desired}`, cap 64 KiB. | the supervisor's start gate |
| `operatorVerdict(read)` | `{intake, start, unreadable}`. Disabled wins over paused. Unreadable is paused and refused. | the supervisor's start gate |
| `readApproverProjection(harnessDir)`, `createApproverReader({now})` | `approvers.json`, cap 1 MiB. Absent is single-owner mode, present is enforced, unreadable fails closed. An answer goes straight to `verifyDecision`. Unknown keys stay on it. | the runtime's consume check |
| `intakeVerdict(harnessDir, {read?})` | `{state: "open"}` or `{state: "closed", reasons, notice, code, retryAfter?}`. Read `state`, `code`, `notice` and `retryAfter`; never switch exhaustively on `reasons[].kind`. A record both paused and disabled lists both reasons, so lifting one never lifts the other. The SLO gate's file is not a reason. | the doors that admit work, and `assertRunnable` |
| `assertRunnable(harnessDir, {mode, ignorePause?, read?})` | One answer per CLI entry point. It never exits or throws for an operator state; `exitName` names the exit code. | the CLI's entry points |

`notice` in the operator record is a string to show, `null` for a pause recorded as quiet, or absent
for the fixed text.

| Record | `interactive` | `run` | `start` |
|---|---|---|---|
| absent, or open | ok | ok | ok |
| intake paused | ok | `paused`, or ok with `pauseIgnored` when `ignorePause` | ok |
| deployment disabled (wins over paused) | `disabled` | `disabled` | `disabled` |
| unreadable | ok | `paused`, reason `unreadable`; `ignorePause` does not lift it | `disabled`, reason `unreadable` |

## Keyed digests

| Export | Contract | First consumer |
|---|---|---|
| `readDigestKey(harnessDir)` | `{state: "absent"}`, `{state: "present", hmac}` or `{state: "unreadable", reason}`. Creates nothing. | the decision log |
| `ensureDigestKey(harnessDir)` | For writers. Publishes exclusively; a racing creator reads the winner's key. An unreadable key is refused, never replaced. | the decision log |
| `keyedDigest(key, label, parts)` | HMAC-SHA256, lowercase hex, over the UTF-8 of `JSON.stringify([label, ...parts])`. | the decision log |

Stored digests join forever, so this format is a pin. The label keeps two purposes from joining.

## The mutating lease

| Export | Contract | First consumer |
|---|---|---|
| `acquireMutatingLease(harnessDir, {head, kind}, {waitMs, probe, now, sleep})` | Publishes exclusively. A contender polls until `waitMs`, then answers `{ok: false, holder}` naming kind, head, pid, host and since. | Home's job runner and the CLI's long mutating verbs |
| `withMutatingLease(harnessDir, who, fn, options)` | Runs `fn` holding the lease, and releases it when `fn` returns or throws. | Home's job runner and the CLI's long mutating verbs |
| `readMutatingLease(harnessDir)` | A pure read. | Home's job runner and the CLI's long mutating verbs |

Only a provably dead holder loses the lease: the same host, and `isAlive(pid) === false`, or a recorded
start time more than 2 seconds from the probe's. A probe that cannot answer means held, a foreign host
is always held, and there is no age rule, because an eval holds it for an hour. An unreadable lease
file is held, with a refusal that says how to clear it. The default probe is `kill(pid, 0)` with an
unknown start time, so holders it records carry no `startedAt`; a caller that may spawn injects
harness-supervisor's `ProcessOps`. This package never imports harness-supervisor.

## Rules

1. Reads take no lock, create nothing, and never compact or repair. Repair, sealing, retention and key
   creation are writer steps.
2. Every path is resolved inside its root through `@crewhaus/tool-safety/fs`. Nothing is written
   through a link planted at a record's name.
3. No `mkdirSync({recursive: true})` on a record path. Directories are made one contained component at
   a time, and the lock is handed a physical path.
4. Time, sleep, process probes and the roll threshold are injected or seamed, so tests count work and
   never wait on a clock.
5. Every refusal is typed and names its reason.

**What records hold.** These shapes carry ids, states, actors, digests and refs. The operator's `reason`
and `notice` are the one operator-typed text. An actor in a record is a `prn_`, a `sys:` name or
`local:#<keyed digest>`, never a raw `local:<user>@<host>`; writers own that rule. No field name is one
the Hangar masker would redact as a credential: `digestKeyFile`, never `digestKey`.

## Limits

- **A lock stolen inside a lease break.** The lock orders breakers and the exclusive publish decides the
  holder, but a breaker whose lock is stolen between its re-read and its removal can remove a lease it
  no longer judged.
- **A line two rolls late.** `next` holds two segments, so a line landing in a segment two rolls behind
  the reader is not delivered.
- **A crash-torn line in a lock-free ledger.** `append` never seals, so the next row joins a torn line
  into one malformed line: one reported gap, and that row with it. A locked append seals first.
- **Local filesystems with hard links only.** A claim is exclusive because it is published by hard link.
  Without hard links the publish falls back to check-then-rename, where two publishers can both
  succeed, and a network filesystem is not supported.
