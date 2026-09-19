# @crewhaus/tool-flow

Deterministic control flow: the decisions a harness makes constantly and
should almost never pay a model to make.

Which arm to take. Whether an error is worth retrying. Whether the loop is
still moving. Whether there is time left for the thorough path. Which band a
score falls in. Whether N answers actually agreed. Which rep this lead
belongs to. What the flow can do next. None of these are judgement calls —
they all have right answers — and routing each one through a model costs
tokens, adds latency, and risks getting it wrong.

| Tool | Answers |
|---|---|
| `Branch` | which arm of an if/switch a value takes |
| `DecisionTable` | what an operator's policy table says, and which rows said it |
| `ErrorClassify` | what kind of error this is and what to do next |
| `DeadlineCheck` | how much of the time budget is left, and whether one more step fits |
| `ConsensusVote` | what N answers settled on, and how much they agreed |
| `StallDetect` | whether the loop is progressing, repeating, or oscillating |
| `RuleScore` | what this record scores, which band it lands in, and why |
| `LeadAssign` | which owner a record routes to, and why it was not one of the others |
| `SequenceRun` | which steps of a declared flow can run now, and what the rest are waiting on |

## One condition grammar

`Branch`, `DecisionTable`, `RuleScore`, `LeadAssign` and `SequenceRun` all
evaluate the same `checks` that `@crewhaus/tool-schema`'s `Assert` tool does,
through the same evaluator:

```yaml
when:
  - { path: "order.total", op: greaterThan, expected: 1000 }
  - { path: "customer.tier", op: oneOf, expected: [enterprise, strategic] }
```

There is deliberately no second vocabulary. An operator who learns
`startsWith` from `Assert` gets the same operator, with the same semantics,
in a branch and in a scoring rule.

## Determinism

Every library under `src/lib` is pure: the clock is a parameter, never a
call, and nothing here touches the filesystem, the network or a random
source. The same inputs give the same answer in a test, in a replay, and in
production.

Three tool wrappers read the real clock, because knowing the time is part of
their job:

- **`DeadlineCheck`** always — a model does not know what time it is, which
  is the whole reason the tool exists.
- **`ErrorClassify`** only to resolve a `Retry-After` given as an HTTP-date.
- **`SequenceRun`** only to decide whether a step's `after` gate has passed.

All three take an explicit `now` that overrides it. That is the only impurity
in the package, and passing `now` removes it.

Timestamps must carry a UTC offset. `2026-01-01T00:00:00` is rejected with an
explanation rather than guessed at, because per ECMAScript an offset-less
date-time string is *local* time while the date-only form is UTC — so the
same spec would mean different instants on two machines.

An epoch outside the ±8.64e15 ms a `Date` can represent is rejected by name
for the same reason: the field that parsed it is the only place that still
knows which of a spec's several instants was the bad one, and left to reach a
consumer it surfaces as a bare `RangeError: Invalid Date`.

## What it refuses

Three shapes are errors rather than conveniences, because each one reads as
working and does not:

- **An arm, row or owner with no conditions.** Under `all`, an empty
  condition list is vacuously true, so it silently swallows everything after
  it while looking like a rule. A catch-all is spelled `otherwise`, or
  `fallback` in `LeadAssign`. A `SequenceRun` step may omit `when` entirely —
  steps are not alternatives, so an unconditional one swallows nothing — but
  an explicitly empty list is still rejected, because it says "gated" and is
  not.
- **Two arms, rows, owners or steps sharing a name.** The name is the thing
  the caller routes on and the thing that appears in the audit trail.
- **A custom `ErrorClassify` rule with no conditions**, which would match
  every error and mask every builtin pack behind it.

`DecisionTable`'s `unique` and `priority` policies report an ambiguity as a
conflict rather than picking a winner — that ambiguity is the policy bug the
strict policy exists to find. `LeadAssign` does the same with two equally
specific territories, and with a roster that is missing a fact its strategy
needs: an owner with a capacity but no load has not been shown to have room,
and one with no load at all is not on zero. Neither of those falls through to
`fallback`, because "nobody is eligible" and "I cannot work out who is" are
different answers, and only the first one has a right owner to route to. The
per-owner report says the same thing one level down: such an owner comes back
`eligible: null` with the missing fact as the reason, never `eligible: true`.

`specific` ranks a territory by the conditions it *requires*, not by the ones
a particular record happened to satisfy — an owner with `match: any` insists
on exactly one however many hold, so counting the holders would send two leads
in the same territory to two different reps over a field neither territory
asked for.

## What it does not do

- **It does not invoke anything.** These tools decide; they do not act on the
  decision. `Branch` hands back the arm's declared `result`, and the caller
  acts. `SequenceRun` is the same promise at flow scale: it returns the steps
  that can run now, each with the parameters to run it with, and runs none of
  them — invoking a tool needs the executor, which no tool package has.
  Chaining tool calls without a model turn needs the `kind: tool` step, which
  does not exist yet.
- **It does not persist anything.** `StallDetect` takes the history as an
  argument rather than keeping one, `SequenceRun` takes `completed` and
  `failed`, and `LeadAssign` takes the loads and hands the advanced rotation
  cursor back. Durable cursors and counters are `@crewhaus/tool-state`.
- **It does not wait.** Nothing here sleeps, polls, or blocks. `ErrorClassify`
  reports the wait a server asked for, and `SequenceRun` reports how long a
  step has left before it is due; honouring either is the caller's job. There
  is deliberately no `WaitForEvent`: blocking needs an event source to block
  on and an abort signal to stop on, and a tool named for a wait that returned
  immediately would be believed.
- **It does not ask a human.** Approvals and questions need a channel and a
  resumable id, which belong to the harness runtime.
- **It does not validate against JSON Schema.** That is `JsonSchemaValidate`,
  and the path-assertion gate is `Assert`, both in `@crewhaus/tool-schema`.

## Error classification

`ErrorClassify` maps any combination of status, exit code, signal, errno or
provider code, message text and `Retry-After` onto one of 19 stable classes
and one of 9 next actions. Precedence is: caller rules, then status, then
signal, then exit code, then code, then message text.

Two details worth knowing:

- **`retryable` follows the action, not the class.** An OOM kill is class
  `capacity`, which is retryable in general — but that particular one
  resolves to `escalate`, and a caller reading the boolean would otherwise
  re-run the identical command and be killed identically.
- **Message matching uses substrings, not regular expressions.** That text
  comes from a remote server, and a pattern with nested quantifiers there is
  a denial of service waiting to happen. Caller-supplied rules may use a
  regex; the builtin packs never do.

Exit code `1` is deliberately unclassified. It is the generic "it failed" and
says nothing about why, so claiming a class for it would be inventing
information.

## A known limitation: regex denial of service

The `matches` and `notMatches` ops compile a caller-supplied pattern and run
it against caller-supplied text. JavaScript's regex engine backtracks, so a
pattern with nested quantifiers against text that *nearly* matches can take
seconds of CPU:

```
^(([a-z])+.)+[A-Z]([a-z])+$   against 60 lowercase letters   ~2.7s
```

This is a property of the shared check grammar in `@crewhaus/tool-schema`,
not of this package — the `Assert` tool has the same exposure, and both are
reachable with operator-written or model-written patterns matched against
text a harness fetched from somewhere else.

Two things reduce it, neither of which is a fix:

- `ErrorClassify` matches `message` and `code` **separately** rather than
  joining them. A pattern anchored with `$` against a joined string can never
  match, and a pattern that can never match is precisely the worst case for a
  backtracking engine — joining the fields manufactured that for free.
- `ErrorClassify`'s builtin packs use substrings, never patterns, so the
  default path compiles no regex at all.

A real fix has to live in the shared evaluator: reject nested-quantifier
patterns before compiling them, or match with an engine that does not
backtrack. Until then, treat `matches` as trusted-pattern-only, and prefer
`contains`, `startsWith` and `endsWith` — which are linear — where they will
do.
