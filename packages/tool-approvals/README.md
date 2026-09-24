# @crewhaus/tool-approvals

What is parked waiting for a human, what humans have been asked before, and the
permission rules that would stop the asking — as deterministic tools, with no
model call.

A headless run under `permissions.ask_mode: pause` cannot prompt. When a tool
call needs permission it writes a `PendingApproval` to the harness's
`approvals.jsonl` and **stops**. Nobody is told. The run is not failed, not
finished, and not progressing, and the only way anyone finds out is if somebody
looks. This package is that looking.

```yaml
tools:
  - approvalStatus
  - approvalsInbox
  - permissionsSuggest
```

| Tool | What it does |
|---|---|
| `ApprovalStatus` | One harness's approval ledger — what is parked now, what was decided, when and by whom |
| `ApprovalsInbox` | The fleet in one page: every harness under a root, with the tool and argument that parked each run |
| `PermissionsSuggest` | The rules that would stop the re-asking, each verified to match only the call it came from |

## Nothing here decides anything

No tool in this package grants, denies, resolves, expires, compacts or applies.

`PermissionsSuggest` **proposes** rules and writes nothing. Applying one is
`crewhaus permissions suggest --apply`, which is always an interactive human
confirm and refuses outright in a non-TTY. That is not an oversight: permissions
are deliberately excluded from the optimizer's writable paths, because an agent
must never be able to widen its own permissions. A tool that could apply a
permission rule would be that agent.

The reads are side-effect-free in a stronger sense than "they only read". The
sanctioned `PendingApprovalStore.list()` **compacts its backing file** as a
side effect — it drops expired and superseded lines and rewrites the log. An
inbox is polled; polling must never rewrite an operator's approvals ledger, and
compaction would also destroy the settled-decision history that half of
`ApprovalsInbox`'s job is to show. So every read here folds the JSONL directly,
last-wins by `id`, exactly the upsert rule `persist` documents. `index.test.ts`
proves it by hashing every file in the workspace before and after a call.

The same discipline applies to time: a pending record long past its TTL is still
reported as **pending**. Expiry is the runtime's decision, made when it re-reads
the store to resume a parked run. A reader that reported an old park as expired
would be answering a question it has no authority over, and an operator who
skipped it on that advice would leave a run blocked that a grant would have
resumed.

## The security property

**A suggested rule must mean only what it says.**

A suggestion is built out of values the harness *observed*: the tool a human was
asked about, and the argument they were asked about it with. The permission
matcher reads `*` and `?` in a pattern as wildcards, so a value spliced in raw
stops meaning itself:

```
approved once:   Read   file_path = "notes/*.md"
naive rule:      Read(notes/*.md)
actually means:  every .md file under notes/, forever
```

That is a summarising tool turning into a privilege-escalation tool, silently,
while showing the operator a pattern that *looks* like the file they approved.

`@crewhaus/tool-permission-matcher` owns the two facts that stop it —
`escapeGlobLiteral` (the escaping) and `OPERATIVE_ARG_FIELDS` (which input field
a rule constrains) — and `@crewhaus/harness-advice`'s `patternFor` already uses
both. This package does not re-derive either. It adds the check neither can
make: **`lib/rule-check.ts` verifies the finished rule by running the real
matcher over it**, against the approved call and against a generated set of
near-misses, and refuses any rule that reaches past the call it came from.

Refusing is always safe here. Nothing applies a rule, so a false refusal costs a
human writing one by hand; a false accept is a standing grant nobody meant to
give.

Three holes make the check worth having rather than ceremonial, and all three are
about the value that is easy to forget is observed — **the tool name**:

1. **An MCP tool's name is composed from strings a remote server declares.**
   `namespacedToolName` sanitises neither half, so a server can register
   `notes__read*`, and "always allow the tool you approved" compiles to a rule
   covering every tool whose name starts `notes__read`. Refused, with the
   reason, and never placed in the proposed diff.
2. **A name containing a parenthesis re-splits.** `compilePattern` takes
   everything before the first `(` as the tool glob, so a tool named `Fetch(x)`
   yields a rule about the *different* tool `Fetch` — one nobody approved, and
   one that really does reach the network. Refused.
3. **A name containing a backslash is not the name it spells.** The glob grammar
   reads `\` as an escape lead-in, so a tool registered as `notes__read\*`
   produces a pattern whose text *equals* its name and whose `*` is *not* an
   unescaped wildcard — both earlier guards pass — while it compiles to
   `/^notes__read\*$/`: a rule that never fires for the tool it came from and
   governs the different name `notes__read*` instead. No string comparison can
   see this, which is why the tool half is put to the **matcher** as well
   (check `1b`), not just to `===`. Refused.

### An argument constraint covers the approved call, not its aliases

Before 0.7.1, four built-ins (`Read`, `Write`, `Edit`, `Grep`) had more than one
operative field and the matcher accepted the argument in *any* of them, so
`Read(notes/a.md)` also covered `{ file_path: "notes/a.md", path: "/etc/shadow" }`,
and every such suggestion carried a `WIDER THAN THE APPROVED CALL` line. Since
0.7.1 an allow rule needs *every* operative value of the call to match, and the
file tools declare the one field they read, so that call is not covered and the
line is gone.

`adversarial.test.ts` drives the property end to end with the path
`notes/a*b?c[d]{e}\nsecret.md` (a `*`, a `?`, a `[`, a `{` and a newline, in one
value): it asserts the emitted rule matches that path, that **every**
single-character variation of it is refused, that each named decoy a raw splice
would have let through is refused, and that a decoy input field cannot satisfy
the rule either.

### Blanket grants are labelled

Three situations make a proposal cover the whole tool rather than the approved
call. `rankSuggestions` explains one of them; this package says all three out
loud, prefixed `BLANKET GRANT`, because the value of a suggestion is that a
human can see what they are agreeing to:

- several distinct inputs were observed (harness-advice's own note);
- the one approved input contains a parenthesis, which the `Tool(arg)` grammar
  cannot escape, so the argument constraint is dropped;
- the tool has no operative-argument field at all — every MCP and custom tool —
  so no rule about it can constrain arguments.

Each suggestion also carries `argConstrained`, the single field that separates
"allow this call" from "allow this tool for anything".

## "Could not determine" is not "nothing is parked"

An approvals file that is **absent** means no run ever parked here. One that
**cannot be opened** means nobody knows what is parked here, and a run may be
blocked right now. Those are different answers, and this package never collapses
them: a count it could not establish is `null` in the result, with an entry in
`unknown[]` naming the field, the read that was tried, and why it did not answer.

That covers, specifically:

- an approvals ledger that is a directory, is unreadable, or vanished mid-read →
  `total: null`, `counts: null`, not `0`;
- a ledger read that hit the size cap, or that contained lines which did not
  parse → the count is reported as a **floor**;
- a harness in the fleet whose ledger could not be read → it lands in
  `unreadableHarnesses`, `totalsAreComplete` goes false, and the fleet totals
  are declared a floor. One bad mount never reports the fleet as idle;
- a walk stopped by its depth cap, its count cap, or a directory it could not
  list → every reason is named, and the fleet totals become a floor with
  `totalsAreComplete: false`. A harness the walk never reached is as absent from
  the totals as one whose ledger would not open, so a capped walk must never
  answer "pending: 0" and call it complete;
- an approvals ledger that is not at `<harness>/.crewhaus/sessions/` because the
  harness relocates its session root (`CREWHAUS_SESSION_DIR`, which moves the
  approvals log with it) → the harness is reported as unreadable with that
  reason rather than as parking nothing. This package reads the one conventional
  path; it does not resolve the override (that is hangar-server's
  `resolveSessionRoot`), it only refuses to mistake an absent file there for an
  empty inbox;
- an `approvalId` that is absent from a ledger whose read was **partial** (size
  cap, or a line that did not parse) → `found: null`, not `false`. The record
  may be in the part that was not read;
- a session log that could not be read or was truncated → the ask/deny counts
  are a floor, so a "never denied, safe to grant" verdict is not silently an
  artefact of the lines that went missing;
- a `settings.json` that does not parse → **no diff is offered at all**. A file
  that does not parse is not a file with no rules, and diffing against an empty
  baseline would propose additions that may already exist;
- a `settings.json` holding a rule entry the reader does not recognise → the
  additions are still reported, but `diff.merged` is withheld. See below;
- `readOnly` on a suggestion, when the caller did not supply `readOnlyTools` →
  `null`, never `false`, with a line in the evidence saying that harness-advice's
  fail-closed "not read-only" is a default and not an observation.

`index.test.ts` walks every result of every tool and fails if any `null` lacks
its `unknown` entry, so the rule cannot rot.

### Why `diff.merged` can be withheld

`existingSettingsRules` is deliberately tolerant: an entry that is not an object,
or whose `type` it does not know, is skipped. That is right for reading. It is
dangerous for writing, because `diffPermissions` then builds
`merged = [...existing, ...additions]` and `applyToSettingsRoot` writes `merged`
as the *whole* `rules` array — so every entry the reader skipped is gone. A
settings file with a typo'd rule type, or a rule from a newer CrewHaus, comes
back from a round trip one rule shorter, and if the dropped one was an
`alwaysDeny`, the round trip quietly removed a guard.

Nothing here writes, so this package cannot cause that. What it can do is refuse
to hand back a `merged` list that is not the file's rules plus the additions.
When the declared entry count and the recognised rule count disagree, `merged` is
`null` and the reason is named.

## Determinism

Listings sort with plain string comparison, never `localeCompare`. The fleet walk
sorts each directory before descending, because `readdir` order is
filesystem-defined. Session recency uses mtime with the **filename** as the
tiebreak, so two logs written in the same millisecond do not order differently on
two hosts. Every ordering is pinned and named:

- `operator` (the default): pending first, **oldest pending first** — the park
  blocking a run longest is the one to settle — then settled, most recently
  decided first;
- `oldest` / `newest`: plain creation order, for a ledger read.

Ties break on `id`, and a record whose timestamps do not parse sorts to the *end*
of its group rather than to an arbitrary place.

Time comparisons parse first and compare the parsed instants, never the strings.
`2026-09-19T00:30:00+02:00` is *earlier* than `2026-09-18T23:00:00Z`, and a
lexical compare says the opposite — which would put the wrong park at the top of
an inbox and include the wrong side of a `since` boundary. The ISO shape is gated
before `Date.parse`, because `Date.parse`'s acceptance of non-ISO input is
implementation-defined.

The one place a clock could enter is how long something has been parked, and it
is an explicit `now` input. Omit it and rows carry no age at all.

## Filters run before the limit

`ApprovalListFilter` does not support filtering by tool or by time, so both are
applied after the fold — and therefore **before** the limit. Pushing a limit into
the read and filtering afterwards is how "show me the Bash parks" returns zero
rows in a ledger whose newest twenty records are `Read` parks. Whenever the match
set is larger than the page, `moreMatchedThanReturned` says so.

A `tool` filter is an **exact** name match, not a glob and not a prefix: a filter
that quietly globbed would make "every `Read` park" also show `ReadSecrets`.

## What a row shows, and what it does not

A row carries the record's identity (`id`, `runId`, `sessionId`, `surface`,
`inputHash`), its status and decision, and the **operative argument** — the input
field a permission rule would constrain for that tool, read from the matcher's
own `OPERATIVE_ARG_FIELDS`. That is the value an approver is actually judging,
and showing any other field would show them a value no rule they write will be
checked against.

Every *other* input key is reported by **name and type only**, never by value.
`@crewhaus/hangar-server` renders inputs verbatim behind `maskDeep`, which
composes key-based redaction, value-shape masking and the harness's own env
scrubber; those live in `@crewhaus/spec-patch` and `@crewhaus/harness-supervisor`,
neither of which is a dependency here. Rather than ship a weaker masker under the
same promise, this package does not print the values it cannot mask. The
operative value itself *is* printed, capped at 2000 characters with the cut
flagged — an approver cannot judge a call they cannot see.

## Containment

Every caller-supplied path goes through `resolveSafe`, copied verbatim from
`@crewhaus/tool-pkg`: it refuses anything resolving outside `process.cwd()`,
including through a symlink that lives inside the workspace and points out of it,
and including a dangling link, which is still a door. A NUL in a path is refused
on the string the caller wrote, before any syscall sees it. The harness directory
being contained is not enough on its own, so `.crewhaus/sessions` inside it is
re-checked — it may itself be a link out of the workspace.

The fleet walk never follows a directory symlink, never descends into
`node_modules` or a harness's own `.crewhaus/`, and stops at each harness, since
a nested `crewhaus.yaml` is a fixture or a template rather than a peer.

## What this package re-states rather than imports

`@crewhaus/session-store` owns the `PendingApproval` record and
`@crewhaus/hangar-server` owns the fleet fold and the harness walk. Neither is a
dependency of this package, and adding one would pull a server and a store into a
tool package. So three things are re-stated here, each deliberately small and
each pointing at its owner:

- the record shape, declared **structurally** — only the fields these tools
  project, with the same seven required strings `isPendingApprovalShape` checks,
  so a store that grows a field does not make this reader reject its records;
- the fold and the status rule (`granted-always` beats `consumed`, mirroring both
  the CLI and the hangar);
- the harness walk, which mirrors `crewhaus fleet` and
  `@crewhaus/harness-inventory`'s skip set.

Everything that is a *rule* rather than a shape comes from the packages that own
it: `aggregateAsks`, `rankSuggestions`, `patternFor`, `diffPermissions`,
`existingSettingsRules`, `hasUnescapedWildcard` and `parseJsonlObjects` from
`@crewhaus/harness-advice`; `escapeGlobLiteral`, `OPERATIVE_ARG_FIELDS`,
`compilePattern` and `matchesPattern` from `@crewhaus/tool-permission-matcher`.

The JSONL reader is the one place this package deliberately differs from
hangar-server's: that one reads the **head** of a capped file, which for an
append-only log keeps the oldest records and loses the newest. For an approvals
ledger that is backwards — the pending park an operator is looking for is the
most recent line — so this reader takes the **tail** and drops the torn leading
fragment. Either way the cut is reported.

## What these tools cannot tell you

They read a harness's ledger and its logs. They do not reach a running process,
so "nothing is parked" is not "the run is healthy" — it is only "nothing is
waiting on a permission decision". They do not reach the tool registry, so
`readOnly` is a caller's claim (`readOnlyTools`) or it is unknown; it is never
guessed from a name. And a suggestion mined from twenty sessions describes twenty
sessions: the thresholds are visible in the result, and widening a permission on
that evidence is a human's call, which is why it stays one.

They also read one session root — `<harness>/.crewhaus/sessions`. That root can
be moved (`CREWHAUS_SESSION_DIR`, per-tenant roots), and the approvals ledger
moves with it. Resolving the override belongs to `hangar-server`'s
`resolveSessionRoot`, which is not a dependency here, so this package instead
looks for *evidence* of a relocation (the variable in the process env, or the key
in the harness's `.env` / `.env.local`) and, when an expected ledger is absent
under that evidence, reports the harness as unreadable rather than as idle. The
probe is one-directional: a hit is evidence, a miss is not proof — a shared
`manager.envFiles` entry or a tenant-scoped root is outside what it can see.

Finally: `mined.available` and the `sessions: N` window count **session
transcripts only**. The `approvals.jsonl` ledger and the `<id>.events.jsonl`
watch-me sibling share that directory and are excluded, because ranking by mtime
would otherwise let the ledger — written the moment a run parks — take the
newest slot and push out the history the ask counts come from.
