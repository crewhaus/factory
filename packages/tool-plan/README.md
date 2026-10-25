# @crewhaus/tool-plan

v0.3.0 Goal 1 (design §2.4/§2.6): the continuity tool surface —
RegisteredTools over [`@crewhaus/continuity-store`](../continuity-store),
packaged like `tool-memory` (one factory bound to a spec name; the caller
registers the tools into the runtime catalog).

```ts
import { createPlanTools } from "@crewhaus/tool-plan";
import { defaultCatalog } from "@crewhaus/tool-catalog";

const bundle = createPlanTools({
  specName: "support-bot",
  appendEvent: (e) => eventLog.append(e), // plan_update / goal_update / action_proof
  proofMode: "ladder", // continuity.proof — "ladder" (default) | "require" | "off"
});
for (const tool of bundle.all) defaultCatalog.register(tool);
```

## The tool table

| Tool | Flags | What it does |
| --- | --- | --- |
| `FocusRead` | readOnly | Focus body + active plan pointer + REQ ledger — check first, never re-ask answered questions |
| `FocusWrite` | destructive (audit-and-allow, **no** justification — it's the hot loop) | Replace the focus body (capped at `focusMaxChars`) |
| `PlanRead` | readOnly | Numbered steps with ladder statuses; `claimed` rendered as unverified |
| `PlanUpdate` | destructive (audit-and-allow) | `create` / `add_step` / `set_step_status` (up to `claimed`) / `set_active` |
| `PlanComplete` | destructive | The **proven** transition: requires `evidence: [{toolUseId}]`, machine-checked against session event logs (child sessions included); recorded unchecked under `continuity.proof: off` |
| `GoalWrite` | destructive | Create a goal (`goals.yaml`) |
| `GoalUpdate` | destructive | Update a goal; `proven` requires evidence like a step |
| `GoalList` | readOnly | List goals with progress |
| `MemoryClear` | destructive + **requireJustification: true** | Clear focus/plans/goals/all — via trash, restorable, never hard-deleted |

The `proven` gate teaches instead of blocking silently: a bad citation
rejects with `no verified evidence for tu_…: run the action first, then
complete the step with its toolUseId.` — the *bias toward action*: narration
can never produce a ✓.

## Proof modes (`continuity.proof`)

`createPlanTools({ proofMode })` takes the spec's `continuity.proof`, which
memory-service passes through. The modes are enforced since 0.8.0
(design/0.8.0-provability-release.md §6.3); before that, `require` and `off`
ran the ladder and printed a boot note.

| Mode | `claimed` | `proven` | Completion below `proven` |
| --- | --- | --- | --- |
| `ladder` (default) | free | evidence verified against the session event log | — (the pre-0.8.0 proof behaviour and tool descriptions) |
| `require` | free — honest progress | verified, exactly as `ladder` | refused, with an error that teaches the proof |
| `off` | free | the cited toolUseIds are **recorded, not resolved** | — |

**`require`.** Nothing below `proven` completes anything. Plans have no
close operation: a plan is complete exactly when every step is proven, so a
claimed step leaves it open. Once nothing is left open or in progress, the
`PlanUpdate` and `PlanComplete` replies name the steps that still need proof
(`plan-0001 is not complete: step 3 is claimed, not proven — prove it with
PlanComplete({step, evidence: [{toolUseId}]}) first.`). The one way the
store could mark something achieved below `proven` is a goal's progress
(`current`, read as 0 when unset) reaching its `target`, which is how the
Thredz mirror completes a goal. So `GoalWrite` refuses a goal created at its
target (a `target: 0` goal included), and `GoalUpdate` refuses progress that
reaches it unless the same call proves the goal (`status: "proven"` with
evidence). `GoalUpdate`'s check runs inside the store lock on the record as
written, so two sessions cannot each pass it on a stale read. The tool
descriptions under `require` say that only a proven step or goal is done.

Two kinds of `proven` record count as below `proven` under `require` until a
verified proof replaces them: one proven by assertion in an earlier `off`
run, and one with no frozen proof at all. The store never writes the
second, so it is a hand edit, or a step line that a multi-line plan title
smuggled into a plan file before titles were kept to one line. Every surface
counts them the way the tools do (continuity-store's `countsAsProven`): such
a goal stays among the open goals in the `<current_plan>` tail and in
`handoff.md`, such a step of the active plan is named in the handoff's Next
actions as `Prove: …`, another plan holding one stays among the handoff's
open plans with the step left out of its proven count, and the Thredz goal
mirror does not complete the remote goal.
`createPlanTools` passes its `proofMode` to the store it builds, so that
store's handoff agrees with the tools.

**`off`** is for harnesses that keep **no session event log**, so there is
nothing to resolve a toolUseId against. `PlanComplete` and
`GoalUpdate({status: "proven"})` still require cited evidence, but record it
as unverified refs (never as frozen proofs) and pin no session for
retention. Each cited id must be one token (letters, digits, `_ . : -`, at
most 256 characters), and a record holds at most 32, so a citation cannot
inject a forged line into a render or inflate a state file. `PlanRead`,
`GoalList`, the `<current_plan>` tail and `handoff.md` show
`[proven (unverified)]`, never `[proven]`. A step already proven with
verified evidence keeps its ✓: an unverified proof never downgrades it.

**One line per record, in every mode** (0.8.0, the default `ladder`
included). A plan or goal title, and a goal unit, is stored as one line:
every whitespace run, newlines included, collapses to one space and the ends
are trimmed, as step text always was. A title over 512 characters
(`MAX_TITLE_CHARS`) or a unit over 64 (`MAX_UNIT_CHARS`) is refused with
nothing written. Before 0.8.0 a title was only trimmed and a unit kept as
given, so a multi-line title could carry a forged `[proven]` step line into
a plan file. The default mode can therefore refuse a `PlanUpdate`,
`GoalWrite` or `GoalUpdate` it accepted before (an oversized title or unit,
or a `GoalUpdate` title that is only whitespace, as a new title already
could not be), and a multi-line title now reads back on one line. See
continuity-store's "One line per record".

## Event emission (decoupled)

Mutations emit the additive event-log kinds `plan_update`, `goal_update`, and
`action_proof {planId, step, toolUseId, verdict}` through the **injected**
`appendEvent` callback — this package never imports runtime wiring; emitters
or memory-service decide where events land (session JSONL, trace bus, both).
Rejected proof attempts emit `action_proof` too (`missing` / `error_result`),
so the audit trail records proof pressure, not just wins; under
`proofMode: "off"` the verdict is `unverified` — recorded, never checked —
and a goal proven that way says `verification: "unverified"` on its
`goal_update`.

## Pillar 3 notes

Plan/focus/ledger content is user-authored working state (origin `"user"`
semantics, like tool-memory writes). All tools are `scope: "internal"`
(process-local files). `MemoryClear` carries the intent gate
(`requireJustification: true`) because model-initiated forgetting is rare and
destructive-by-intent; routine Focus/Plan updates are audit-and-allow so a
judge call per update doesn't drown the loop (§7.4).
