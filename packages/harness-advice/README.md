# @crewhaus/harness-advice

What a harness's own logs say it should change.

| Module | Answers |
|---|---|
| `advise-rules` | which routing, tool and context changes the session logs actually support |
| `shadow-lane` | which side of a shadow audition an arm was on |
| `doctor-checks` | whether this spec can run here: model credentials, channel env |
| `doctor-fix` | a doctor finding turned into the edit that closes it |
| `permissions-suggest` | permission rules drawn from the asks a human already answered |

Nothing here calls a model, and nothing here writes. Every rule is arithmetic
over what was persisted, so the same logs always produce the same findings —
which is what makes the advice reviewable, and what lets a deterministic tool
run it.

## A proposal is a validated patch, not prose

A finding's suggestion is either free-form advice or a `SpecPatch` that has
already been through `validatePatch`. A suggestion that cannot be expressed as
a patch says so rather than emitting one that would fail to apply.

Permissions are the deliberate exception to "just apply it": they are excluded
from the optimizer's writable paths, because an optimizer must never widen its
own permissions. `permissions-suggest` only ever proposes — read-only tools
get an `alwaysAllow` first (lowest blast radius), and a repeatedly *denied*
ask gets a tightening to `alwaysAsk`, never a blanket `alwaysDeny`: a human
denied that call, not every future one.

## Both sides of a shadow audition are in the same lane

A `strategy.shadow` audition records the candidate that never reached the user
and the incumbent it was judged against under one route key, and the
scoreboard snapshot does not carry the timestamp that tells them apart. So
`shadow-lane` does not guess. Guessing by observation count fails in the
ordinary case — each graded turn writes one observation per side, so the
counts move together and the incumbent wins the guess as often as the
candidate does. It resolves by the recorded stamp, then the spec's declared
candidate, then the single-arm case where there is nothing to confuse.

## Why this is a package

These modules grew inside the CLI, which put them out of reach of
`packages/tool-*` — a package may not depend on an app. Deterministic tools
needed exactly this logic, so it moved here and the CLI now imports it like
any other consumer.

## Testing

```
bun test packages/harness-advice/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects sibling packages whose names start the same way.

The tests that spawn `crewhaus advise` / `doctor` / `permissions suggest` stay
in `apps/cli`, next to the commands they exercise.
