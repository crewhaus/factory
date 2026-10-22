# W3-A — provability on the remaining surfaces: managed gateway envelope, research report gate, sub-agent threading (design §5.4, §8; PR train 9)

You own: `packages/gateway-protocol/**`, `packages/gateway-server/**` (only the run-result
path), the provability-specific parts of `packages/target-managed/src/**`,
`packages/report-writer/**`, `packages/target-research-bundle/**`, `packages/citation-tracker/**`
(read-only unless an accessor is missing), `packages/sub-agent-spawner/**`. Channel bots are
already wired (the gate's `footerTarget: "reply"` appends the footer to the reply text the bot
sends — verify that with one channel compile+runTurn test in target-channel-bot, which you may
add, and honour `render: none`).

Read design §5.3–§5.4, §8 (the per-shape table), §12 (deferred seams — do not build those).
`@crewhaus/provability`, `@crewhaus/evaluation-service`, and the runtime gate exist (earlier
waves) — read their exports; `RunProvability.onBundle(bundle, bundlePath)` is how a surface sees
a bundle.

1. **Managed / gateway**: `RunsCreateResult` and `RunsContinueResult`
   (`packages/gateway-protocol/src/index.ts`) gain an OPTIONAL `proof` field carrying the
   `ProofBundle` (additive, `.optional()`, protocol version unchanged; validate it with a zod
   schema for the bundle shape — keep it permissive on unknown future fields only if the
   protocol's other schemas are; match the file's `.strict()` posture). The managed daemon's
   run path captures the bundle of the run's final turn (via `onBundle`, which the emitter can
   compose with the one `wireEvaluation` returns — or have `wireEvaluation` accept an
   `onBundle` dep; coordinate by reading what W2 built) and returns it in the result envelope.
   SSE subscribers already receive bus events (`provability_graded`) — verify, don't rebuild.
   Tests in gateway-protocol (schema accepts/omits proof) and target-managed (compile a managed
   spec with `provability:` and assert the result path carries `proof`).
2. **Research report gate**: the research bundle writes a report via `report-writer` from the
   `citation-tracker`'s per-run cache (sha256-pinned fetched bodies). When `ir.provability` is
   present on `IrResearchV0`: build an `EvidenceIndex` from the tracker's fetch records + cached
   bodies (each fetched URL is a record whose body is the cached content), run `verifyDocument`
   over the rendered report markdown (the report's `[N]` markers + `## Citations` block are the
   citation grammar — confirm `citationDefinitions` reads `[N] url` lines; if the report's
   citation list is not in `[N]: url` definition form, render an additional definitions block
   or adapt the report format additively so the gate can read it — keep the existing
   byte-identical report when provability is absent), append `renderMarkdownSection(bundle)`
   as a `## Provability` section after `## Citations` (UNCONDITIONALLY when the block is on —
   the NO_CITATIONS_NOTICE posture), add `proof` to the JSON report, persist the bundle, and
   apply `onFail`: `halt` → classified failure exit 37 (FailureReport class "provability"),
   `note` → report stands. (retry/escalate were already lowered to note with a warning on this
   shape.) Tests in report-writer and target-research-bundle (absent → byte-identical report).
3. **Sub-agent threading** (design §8 row): when the parent has provability on, children
   spawned through `sub-agent-spawner` receive the provability skill text (read-only guidance so
   researcher children cite with `[n]` + definitions) — follow how 0.3.0 threaded a read-only
   continuity view into children (design/0.3.0-memory-release.md §7.1, and the spawner's
   options). Only the PARENT's final text is gated; the parent's evidence index already walks
   child session logs (`evidenceFromSessionLog` includeChildren). Child returns stay classified
   at `subagent` (do not add a pass). Test that a child's system prompt carries the guidance
   only when the parent's provability is on.

Verify: `bunx tsc -b` + `bun test` in every package you touched; biome.
