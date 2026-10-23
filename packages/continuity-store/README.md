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

**Unverified transitions** (0.8.0, design/0.8.0-provability-release.md
§6.3): `proveStep(…, { verification: "unverified" })` and
`updateGoal(…, { verification: "unverified" })` mark the record `proven`
without resolving anything — what tool-plan's `continuity.proof: off` uses
for harnesses with no event log. The cited refs are stored as
`UnverifiedRef`s (`unverified:` in the plan frontmatter / goal entry),
beside — never among — the frozen proofs; no session is pinned; and
`renderLadderStatus` / the handoff render `[proven (unverified)]`. A later
verified transition clears them; an unverified one never downgrades a
record already proven with verification. Records the ladder writes carry no
`unverified` key, so their bytes are unchanged. "Proven with verification"
means `isProvenVerified`: proven, not by assertion, with at least one frozen
proof. The store never writes a `proven` record without one, so a record
like that (a hand edit) is not treated as verified.

Nothing vouches for an unverified id, so the store bounds it: each id must
be one token of letters, digits, `_ . : -` up to 256 characters
(`UNVERIFIED_TOOL_USE_ID_REGEX`, which covers the ids providers mint) and a
cited session must be `sess_<16 hex>`. Otherwise the call is refused with
nothing written, so a citation cannot carry a newline and a forged
`[proven]` line into a render. A record holds at most `MAX_UNVERIFIED_REFS`
(32) refs. Re-citing a record already proven by assertion appends to its
refs; proving a reopened record replaces them, so the list always backs the
current proof.

**One line per record** (0.8.0): every surface that shows a plan or goal
is line-oriented, and a plan file is parsed by line, so the store keeps the
text it prints inside a line to that line. Plan and goal titles and goal
units collapse every whitespace run (newlines included) to a space, as step
text always has, and are capped (`MAX_TITLE_CHARS` 512, `MAX_UNIT_CHARS`
64; longer is refused with nothing written). Files an older store wrote are
read the same way. A plan's steps are read only below its last `## Steps`
heading, and focus.md's sections are found by their last header, so neither
a title nor a focus body can be read back as a step, a requirement or the
active-plan pointer.

**Proof mode in the handoff** (0.8.0): `createContinuityStore({ proofMode })`
takes `continuity.proof` (`"ladder"` by default) and only `handoff.md` reads
it. Under `"require"`, `countsAsProven` counts a record done only when
`isProvenVerified`: a step or goal proven by assertion, or `proven` with no
frozen proof, is rendered as open — the goal under Goals, the step as a
`Prove: …` next action and out of the proven count — because the require
tools still ask for a verified proof. The ladder and `"off"` render as
before. Transitions never read it; each call says how it verifies.

**Unreadable session logs** (0.8.0): a log that cannot be read to its end (a
torn last line from a crash mid-append, a malformed line, a link where the
log should be) is read up to that point, as provability's `checked` rung
reads it. An id found before the bad line resolves as usual; one that is not
resolves `missing`, with a detail naming the log, so `verifyEvidence` throws
an `EvidenceError` (and tool-plan audits the rejection) instead of a raw
event-log error. `onUnreadable` hears about each such log once per call.

**Guards** (0.8.0): `updateGoal(…, { guard })` runs `guard(next, previous)`
under the store lock on the merged record, before anything is written;
throwing refuses the update. tool-plan's `continuity.proof: require` uses it
so two sessions cannot each pass an at-target check on a stale read.

**Proof lifetime**: session transcripts are TTL-evicted, so on every verified
proven transition the store (a) appends a retention pin for the cited session to
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
