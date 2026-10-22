# W3-C2 — the eval layer: graders, eval flag, optimizer paths, advice, watch-me (design §9; PR train 11)

You own: `packages/grader-provability/**`, `packages/eval-runner/**` (the RunArtifacts/bundle
capture), `packages/eval-grader/src/types.ts` (an additive `RunArtifacts.proof?` field),
`packages/eval-dataset/**` (the `metadata.provability` reading, if typed there),
`packages/spec-patch/**`, `packages/harness-advice/**`, `packages/watchme-store/**`,
`apps/cli/src/watchme-report.ts` (+ test), and the `eval` command's flag handling in
`apps/cli/src/index.ts` / `apps/cli/src/arg-schemas.ts` / `apps/cli/src/usage-text.ts` (shared
files — re-read before each edit, keep edits minimal). Read design §9 fully and the committed
contracts. `@crewhaus/provability` exports the bundle type, `summarizeBundle`, `levelRank`.

1. `@crewhaus/grader-provability` — register like `grader-continuity` / `grader-12-metric-rubric`
   (read how they register into `grader-registry`, how thresholds are declared, and how eval-runner
   auto-registers built-in graders). Six deterministic graders over `run.artifacts.proof`
   (a run with no bundle → a clear "no proof bundle (is provability: declared?)" result, decide
   pass/fail semantics and document): `provability.claimCoverage` (score = bundle score at the
   declared floor; ≥0.95), `provability.rungAchieved` (normalized levelRank(achieved)/4, passes
   when achieved ≥ the floor — sample `metadata.provability.level` overrides the floor),
   `provability.citationValidity` (defined markers / markers, ≥0.99), `provability.assumptionRate`
   (assumptions/claims, ≤0.1, lower is better — the reAskRate precedent), 
   `provability.replayIntegrity` (replayed executions that matched / replayed, =1.0; vacuous pass
   when none replayed), `provability.costPerProvenClaim` (gate-caused spend per met claim; no
   threshold — reported). `metadata.provability.expected_sources` (array of origins) asserts each
   is among the bundle's ok source origins. Roll-up helper like `summarize12MetricRubric` if cheap.
2. `RunArtifacts.proof?: ProofBundle` (eval-grader types) and eval-runner capturing the gate's
   final bundle per sample (the runner runs harnesses through runtime-core — compose
   `onBundle`, or read the persisted bundle path from the `provability_graded` event — whichever
   the runner's architecture supports; read it first).
3. `crewhaus eval --provability <level>` — runs the ladder graders at a floor without editing
   the spec (inject/override the IR's provability level for the eval run, or grade bundles at
   the given floor; make the semantics exact and documented in usage text).
4. `OPTIMIZABLE_PATHS` (`packages/spec-patch/src/index.ts`): add `["provability","threshold"]`,
   `["provability","max_retries"]`, `["provability","grounded","coverage"]`,
   `["provability","grounded","window_tokens"]` for cli/channel/managed (and research for
   threshold/grounded if its schema accepts them) — every path must round-trip through
   `parseSpec` (the guard test checks) with a comment-preserving round-trip test. Add the
   knob-by-knob EXCLUSION comment block (design §9.2 — level, on_fail, assumptions,
   max_assumptions, scope, render, sources.*, execution.*, formal.*, judge.*), and add
   `provability.level` (and on_fail) to `OPTIMIZER_REFUSED_LEAVES` so a wholesale block patch
   cannot move the floor.
5. `ruleProvabilityPressure` appended to `ADVICE_RULES` (packages/harness-advice): when ≥20% of
   gated turns (from `provability_graded` event-log lines) end failing after retries, emit a
   finding with a whitelisted `max_retries` patch and advice text keyed to the dominant unmet
   reason (`not_fetched` → add a fetch/read-capable tool; `no_citation` → the skill/instructions;
   …); it must NEVER suggest lowering `level` and says why. Degrades to zero findings on logs
   without the kind. Tests in advise-rules.test.ts style.
6. Watch-me: `WatchmeObservation.factuality` gains `provability?: { level, achieved, unmet }`
   (watchme-store types, additive); `apps/cli/src/watchme-report.ts`'s factuality section
   consumes `provability_graded` lines when present (exact per turn) and falls back to the
   existing heuristic roll-up otherwise. Tests.

Verify: `bunx tsc -b` in every package touched + apps/cli; `bun test` in grader-provability,
eval-runner (relevant files), spec-patch, harness-advice, watchme-store, and in apps/cli the
eval/watchme/optimize/advise test files you affected; biome.
