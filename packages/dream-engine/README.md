# @crewhaus/dream-engine

v0.3.0 Goal 5 (design §6): **scheduled memory consolidation** — "consolidation
on a schedule, not every turn". A dream run is two phases:

- **Phase 1 — deterministic** (always, idempotent, zero model spend): fact TTL
  sweep + near-duplicate supersede (+`compact()` growth bounding), staleness
  flags (facts unrecalled >90d, wiki unverified >30d — constants exported),
  sessions-index fold-in, proof-excerpt re-validation + retention-pin refresh,
  focus/handoff next-actions refresh, trash purge (>7 days).
- **Phase 2 — model synthesis** (`mode: full` AND `budget_usd > 0`): ONE
  bounded fresh session (`sessionTarget: "dream"`, singleTurn, capped tool
  loop) seeded with the dream playbook + phase-1 findings, acting ONLY through
  the normal registered tools (`wiki_write`, `wiki_set_signals`,
  `MemoryForget`, `PlanUpdate`) — the full justification/audit path. The
  engine **refuses** an unpriced model: cost-tracker's `pricingMisses` would
  turn the item-27 budget cap into a silent no-op.

Schedule state lives at `.crewhaus/dream/<spec>/state.json`
(`{lastRunAt, lastOutcome, phase1Counts, lastEvidence}`); runs are
**window-idempotent** (`dream:<spec>:<floor(now/everyMs)>` through
durable-execution's `withIdempotency`, backed by a lock-honoring file store),
so a janitor tick, a GH-Actions cron, and a CLI catch-up can never
double-fire. `dreamJanitorStep(engine)` registers into runtime-core's janitor
step registry with the `CREWHAUS_DREAM=0` / `CREWHAUS_DREAM_INTERVAL_MS` env
knobs.

The model session is an injected seam (`DreamModelPhase`) — the CLI verb and
daemon emitters build it from `runChatLoop`; this package stays
runtime-core-free. Composition happens in `@crewhaus/memory-service`'s
`wireDream` / `runDreamBootCatchUp` / `createDreamJanitorStep`; the user
surface is `crewhaus dream run|status|init`.
