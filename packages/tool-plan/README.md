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
| `PlanComplete` | destructive | The **proven** transition: requires `evidence: [{toolUseId}]`, machine-checked against session event logs (child sessions included) |
| `GoalWrite` | destructive | Create a goal (`goals.yaml`) |
| `GoalUpdate` | destructive | Update a goal; `proven` requires evidence like a step |
| `GoalList` | readOnly | List goals with progress |
| `MemoryClear` | destructive + **requireJustification: true** | Clear focus/plans/goals/all — via trash, restorable, never hard-deleted |

The `proven` gate teaches instead of blocking silently: a bad citation
rejects with `no verified evidence for tu_…: run the action first, then
complete the step with its toolUseId.` — the *bias toward action*: narration
can never produce a ✓.

## Event emission (decoupled)

Mutations emit the additive event-log kinds `plan_update`, `goal_update`, and
`action_proof {planId, step, toolUseId, verdict}` through the **injected**
`appendEvent` callback — this package never imports runtime wiring; emitters
or memory-service decide where events land (session JSONL, trace bus, both).
Rejected proof attempts emit `action_proof` too (`missing` / `error_result`),
so the audit trail records proof pressure, not just wins.

## Pillar 3 notes

Plan/focus/ledger content is user-authored working state (origin `"user"`
semantics, like tool-memory writes). All tools are `scope: "internal"`
(process-local files). `MemoryClear` carries the intent gate
(`requireJustification: true`) because model-initiated forgetting is rare and
destructive-by-intent; routine Focus/Plan updates are audit-and-allow so a
judge call per update doesn't drown the loop (§7.4).
