# W2-D — enforce `continuity.proof: require | off` (design/0.8.0 §6.3, §15; the 0.3.0 deferral in design/0.3.0-memory-release.md §2.4 and its "Deferred out of 0.3.0" list)

You own: `packages/tool-plan/**`, `packages/continuity-store/**`, `packages/memory-service/**`
(only the proof-mode plumbing and the boot note), `packages/grader-continuity/**` tests only if
they pin the old degrade. Read design/0.3.0-memory-release.md §2.4 and the "Deferred out of
0.3.0" bullet, design/0.8.0-provability-release.md §6.3 and §15, `packages/tool-plan/src/index.ts`
(PlanUpdate / PlanComplete / Goal tools), `packages/continuity-store/src/index.ts` +
`evidence.ts`, and `packages/memory-service/src/index.ts` (~line 935: the
"carried but not enforced yet" boot note; `ContinuityWiringFragment.proof`).

Today `proof: require | off` is carried spec → IR → the wireMemory fragment, but tool-plan has no
proof-mode seam, so both degrade to the default `ladder` with a boot note. Close it:

- `createPlanTools({ …, proofMode?: "ladder" | "require" | "off" })` (default `"ladder"` —
  byte-for-byte today's behaviour).
- `ladder` — unchanged: `claimed` is free, `proven` requires verified evidence (PlanComplete).
- `require` — plan/goal COMPLETION below proven is refused: any operation that would mark a
  plan done/closed, or a goal achieved/complete, while one of its steps (or the goal) is below
  `proven`, is refused with a teaching error ("step 3 is claimed, not proven — prove it with
  PlanComplete({step, evidence:[{toolUseId}]}) first"). Read the store to find every
  completion path (status transitions, `set_step_status`, goal status updates, plan close).
  `claimed` remains settable (it is honest progress), it just cannot complete anything.
- `off` — no verification: `PlanComplete` marks the step proven WITHOUT resolving evidence
  (it still records the cited toolUseIds as unverified refs, and the `action_proof` event says
  `verdict: "unverified"` — add that verdict value additively if needed), and nothing pins
  sessions for retention. Document that `off` exists for harnesses with no event log.
- memory-service passes `cont.proof` into `createPlanTools` and DELETES the boot note; the
  handoff/plan renders keep distinguishing claimed vs proven (under `off`, render proven-by-
  assertion distinctly, e.g. "proven (unverified)").
- The `continuity` default skill text (`@crewhaus/default-skills`) — if it describes proof
  modes, keep it accurate (you may edit that one skill body; report it).

Tests: tool-plan tests for each mode (require refuses each completion path and allows claimed;
off accepts a missing toolUseId and records unverified; ladder unchanged — every existing test
passes unmodified), memory-service test that the mode reaches the tools and that the boot note
is gone. CHANGELOG is NOT yours (the orchestrator writes it) — put the user-facing behaviour
change in your report so it can be written up.

Verify: `bunx tsc -b` + `bun test` in tool-plan, continuity-store, memory-service,
grader-continuity, default-skills; biome.
