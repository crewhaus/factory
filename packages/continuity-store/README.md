# @crewhaus/continuity-store

v0.3.0 Goal 1 (design §2.2–§2.7): the continuity substrate. Human-readable,
user-clearable focus/plans/goals/handoff artifacts under
`.crewhaus/state/<specName>/`, with the **claimed → proven proof ladder**
machine-checked against session event logs. No model call anywhere in this
package — everything is deterministic infrastructure.

## Storage layout

```
.crewhaus/state/<spec>/
  focus.md                  # marker-gated (<!-- crewhaus:focus -->), body capped
                            # at focusMaxChars; carries the REQ-nnn requirements
                            # ledger and the active-plan pointer
  plans/plan-NNNN-<slug>.md # YAML frontmatter + numbered steps with ladder
                            # statuses and frozen proof excerpts
  goals.yaml                # {id, title, status, target?, current?, unit?}
  handoff.md                # deterministic teardown render (same inputs →
                            # identical bytes)
  .lock                     # advisory single-writer lock
```

Why files + markers: matches project-memory's `LESSONS.md` precedent — a
user-authored `focus.md`/`handoff.md` without the crewhaus marker is **never
overwritten**. Why JSONL-adjacent formats: everything is inspectable with
`cat`/`git diff`, and every write is tmp+rename atomic.

```ts
import { createContinuityStore } from "@crewhaus/continuity-store";

const store = createContinuityStore({ specName: "support-bot" });
await store.writeFocus("Ship CSV export");
await store.createPlan({ title: "Ship CSV export", steps: ["Parse", "Export"] });
await store.setStepStatus("plan-0001", 1, "claimed");            // always free
await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_…" }]);  // machine-checked
await store.writeHandoff({ lastSessionId: "sess_…" });
```

## The proof ladder (§2.4)

Statuses: `open → in_progress → claimed → proven`.

- `claimed` never requires anything — zero friction, no gaming pressure.
- `proven` is earned: `proveStep` / `updateGoal({status: "proven"})` resolve
  each cited `toolUseId` against the append-only session JSONLs — including
  **sub-agent child sessions**, discovered by walking the `sub_agent_start`
  bracket events (`childSessionId`). Missing ids and `isError: true` results
  reject with instructive errors (`no verified evidence for tu_…: run the
  action first, then complete the step with its toolUseId.`).

**Proof lifetime**: session transcripts are TTL-evicted, so on every proven
transition the store (a) appends a retention pin for the cited session to
`.crewhaus/retention.json` (the pin contract session-store and
`crewhaus retention` honor) and (b) freezes a `{toolName, inputHash,
resultDigest}` excerpt into the plan/goal record — evidence outlives the
transcript.

## Requirements ledger (§2.3)

`appendRequirement({text, source: {sessionId, turn}, status?})` records the
user's words **verbatim** (there is deliberately no paraphrase field) as
`REQ-nnn` entries with `(user, sess_…, turn N)` attribution inside `focus.md`.
Updating an existing id requires the identical text — paraphrase attempts are
rejected. The ledger is byte-capped (16 KB) with oldest-first eviction and a
`[ledger truncated]` marker.

## Clearing (§2.6): trash + undo, never hard-delete

`clear("focus" | "plans" | "goals" | "all")` moves files to
`.crewhaus/trash/<ISO-ts>/…` preserving relative paths; `restore(ts)` puts
them back (fail-closed on conflicts); `listTrash()` enumerates snapshots.
The `moveToTrash(paths, crewhausDir)` helper is exported for other `.crewhaus`
stores to adopt the same clearing story.

## Locking (§7.6)

Mutations take an advisory `.lock` (O_EXCL create): wait up to 2 s → steal if
the lock's mtime is >30 s stale (a `lock_stolen` warning is recorded) → fail
with an error naming the holder pid. Reads never lock; atomic writes keep
readers consistent regardless.

## Scoping + tenancy (§2.7)

- `scope: {kind: "spec"}` (default) — one store per spec.
- `scope: {kind: "session", sessionId}` — nests under
  `<spec>/sessions/<sessionId>/` for per-conversation state (channel daemons).
- Tenant contexts (ambient `withTenant` or an explicit `tenant` option) apply
  the same fail-closed path fencing session-store enforces: any resolved path
  outside the tenant's root throws (CWE-1230).

## Consumers

`@crewhaus/tool-plan` wraps this store as RegisteredTools (FocusRead/Write,
PlanRead/Update/Complete, Goal*, MemoryClear). Runtime wiring (the mutable
tail block, `context_evicted` externalization, handoff-at-teardown) lands in
the runtime-core continuity PR; CLI verbs (`crewhaus memory clear|restore|show`)
in the apps-cli PR.
