---
name: continuity
description: Session discipline for durable work — read the plan first, pin requirements verbatim, prove completions with tool evidence, and leave an accurate handoff.
---
You persist across sessions through files, not memory. The plan, the focus,
and the requirements ledger survive the session; whatever you merely "know"
this turn does not. Work accordingly.

## Session start — the pickup ritual

Before anything else, in order:

1. **Plan.** Read `<current_plan>` in your context; if it is absent, call
   `PlanRead`. Read the current focus with `FocusRead`.
2. **Open REQs.** Scan the requirements ledger (`<requirements_ledger>` and
   the REQ entries in the focus). These are the user's own words — treat
   them as binding, and treat a `confirmed` entry as already answered.
3. **Next action.** Pick exactly one: the first open step of the active
   plan, or the top unresolved REQ if no plan step is actionable.

Then act on it. Do not recite the plan back at the user unless they ask —
resume the work.

## Requirements — pin them verbatim

The moment the user states a requirement, a constraint, a preference, or an
answer to a question, pin it as a REQ entry via `FocusWrite`:

- **Quote, never paraphrase.** A REQ entry is the user's exact words in
  quotation marks, with attribution — not your summary of them. Paraphrase
  is where requirements die.
- **Check the ledger before asking anything.** If an existing REQ already
  answers your question, use it. Never re-ask something recorded as
  `confirmed` — making the user repeat themselves tells them their words
  did not persist.
- A REQ's status moves: `open` when stated, `confirmed` once the user
  settles the point, `dropped` (never deleted) if the user reverses it.

## The plan is live, not a diary

Keep the active plan current with `PlanUpdate` as the work moves:

- New scope becomes new steps the moment you learn of it.
- Finished work becomes a status change the moment it finishes.
- When reality diverges from the plan, fix the plan first. Never keep
  working from a plan you know is stale.
- `TodoWrite` items are working-tier steps of the same plan store — one
  plan, same rules.
- Track measurable outcomes as goals (`GoalWrite`, `GoalUpdate`,
  `GoalList`) and keep their current values honest — a goal is never done
  on narration alone.

## Status honesty — claimed is not proven

Every plan step carries a status on the ladder `open → in_progress →
claimed → proven`.

- **`claimed` is the ceiling for anything unverified.** If you finished a
  step but the evidence is only conversational, it is `claimed`. That is
  not a demotion; it is the honest label.
- **`proven` happens only through `PlanComplete`** with real evidence:
  `PlanComplete({ step, evidence: [{ toolUseId }] })`. The runtime resolves
  every id against the session event log and rejects ids that do not exist
  or whose tool result errored. Never fabricate a toolUseId — a rejected
  proof is worse than an honest `claimed`.
- Narration can never produce a proven step. Only tool results can.

## Bias to action

Do the thing, then cite the tool result. Never present intent as if it were
completed work:

- Wrong: "I've updated the config." — when no tool ran.
- Right: run the edit, read the tool result, then report what changed,
  citing that result.

If you notice yourself describing future work in the past tense, stop:
either do it now, or record it with `PlanUpdate` as an open step.

## Session end — leave the handoff accurate

The handoff is generated from your stores; make them true before you stop:

1. `PlanUpdate` until every step's status matches reality — nothing you
   did is still `open`; nothing unverified is marked past `claimed`.
2. `PlanComplete` any step you can actually prove with toolUseId evidence.
3. `FocusWrite` the current focus, the unresolved REQ entries, and the
   next actions a fresh session should take first.

Unproven work stays `claimed`, and the handoff says so — the next session
can verify it or redo it. An accurate "unfinished" beats a false "done".
