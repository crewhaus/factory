# W2-C — `@crewhaus/tool-proof`: ProofCheckers, ProofCheck, ProvabilityPreflight (design §7, §6.4; PR train 7 tools)

You own: `packages/tool-proof/**`, plus the edits `scripts/wire-tool-package.ts` makes (it edits
`packages/tool-categories/src/registry.ts`, `packages/target-cli/src/index.ts` BUILTIN_TOOL_MAP,
`apps/cli/src/index.ts` loadToolMap, `apps/cli/src/tools-cli.ts`, tsconfig.json and two
package.json files) and the regenerated `packages/tool-registry-manifest` data
(`bun run scripts/gen-tool-registry.ts`). Read AGENTS.md "New tool?" and the "built-in tool also
has to be registered in five places" paragraph, `packages/tool-text` (the reference package for
tool layout: pure logic in `src/lib/`, thin wrappers in `src/index.ts`, a package-wide safety
flags test), `scripts/wire-tool-package.ts`, and `packages/tool-plan/src/index.ts` (a factory
that binds tools to runtime state). `@crewhaus/proof-checker` and `@crewhaus/provability` were
built in wave 1 — read their `src/index.ts`.

## Tools
1. `ProofCheckers` — readOnly, concurrencySafe, internal. Lists the checkers this harness can use
   (`available()` probed, with the reason when not) and each one's `language` paragraph, in the
   configured preference order. The model should never have to guess what it can prove with.
2. `ProofCheck` — input `{ checker, claim, statement, proof }` (zod, bounded sizes). Runs the
   checker, persists a `ProofArtifact` (via provability's `createFileArtifactStore` +
   `newProofId`) — ACCEPTED OR REJECTED (a rejected proof is persisted too: proof pressure is
   signal) — returns `{ ok, id, assumptions, axioms, counterexample?, reason?, output }` as JSON
   text with a one-line instruction: on ok, "cite it as `[n]: proof:<id>`". Publishes a
   `proof_checked` trace event on the run's bus (find how a tool reaches the bus —
   `ctx.runContext`; tool-code-execution's `resolveEventBus(ctx)` is a precedent) and appends a
   `proof_checked` event-log line if the runtime exposes an append seam to tools (if it does not,
   the trace event is enough — document). Flags: `destructive: true` (it writes a file), scope
   internal, NOT `requiresSandbox` at the tool level (the builtin checker needs no sandbox; the
   sandbox checkers refuse themselves when no sandbox backend is available — document why the
   flag is per-checker, not per-tool). Unknown checker id → a refusal naming the available ones.
3. `ProvabilityPreflight` — readOnly, concurrencySafe, internal. Input `{ draft }`. Runs the
   EXACT gate verifier (`verifyDocument`) over the draft against the live evidence index and
   returns the bundle summary + per-claim table + the nudge text, without gating. Same verifier
   options the gate uses (config, artifacts, purity/replay off is acceptable for a preflight —
   decide and document; never call the waiver judge from preflight).

## Binding to runtime state
Export `createProofTools(opts)`:
`{ config?: IrProvability; specName?: string; proofsRoot?: string; workspaceRoot?: string;
checkers?: ProofChecker[]; sessionRootDir?: string; evidence?: (ctx) => Promise<EvidenceIndex>;
now? }` → `{ proofCheckers, proofCheck, provabilityPreflight, all }`. Defaults for the builtin
instances (registered via the wire script, used when a spec lists `proofCheck` in `tools:`
without a `provability:` block): config = a `grounded` floor with the compiler's defaults (copy
them from the IR doc), proofsRoot = `<cwd>/.crewhaus/proofs/<specName or "default">` (read the
spec name from `ctx.runContext` if it carries one), checkers = `createDefaultCheckers` with the
builtin always and the sandbox checkers when `CREWHAUS_SANDBOX` / a sandbox is available
(follow tool-code-execution's lazy sandbox), evidence = session log of
`ctx.runContext.sessionId` via `evidenceFromSessionLog`. `@crewhaus/evaluation-service` (built
next) will call `createProofTools` with the real gate config so the gate and the tools agree on
config, artifacts root and evidence.

## Wiring
Write a manifest and run `bun run scripts/wire-tool-package.ts <manifest.json>`: package
`tool-proof`, category `proof` (title: "Prove claims: list proof checkers, check a proof and
persist it, and preflight a draft against the provability gate"), rolled up under `safety`
(which already includes `verify` — confirm the manifest's `rollUp` semantics), tools
`proofCheckers`, `proofCheck`, `provabilityPreflight` with keywords. Then regenerate the tool
registry manifest. `apps/cli/src/tool-registry.test.ts` must pass both directions.

## Tests
A package-wide safety-flags test (tool-text precedent); every tool's happy path and refusals
with the builtin checker (no sandbox) and a fake sandbox for smt; artifact persisted for
accepted AND rejected proofs; `proof_checked` published; preflight returns the same verdict
the gate would (run `verifyDocument` directly and compare); bounded inputs; unknown checker.

Verify: `bunx tsc -b` + `bun test` in tool-proof, tool-categories, tool-registry-manifest,
target-cli (`bun test`), and in apps/cli run `bun test src/tool-registry.test.ts
src/tools-cli.test.ts` (and any other test the wire script's edits touch). biome.
