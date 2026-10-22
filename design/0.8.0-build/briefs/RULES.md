# Build rules for every 0.8.0 builder (read fully before touching code)

You are implementing part of CrewHaus factory **0.8.0 — the provability release** in the
git checkout at `/ABSOLUTE/PATH/TO/factory` (branch `release/0.8.0`). Other builders are working in
the SAME checkout at the same time on other files. The design is
`/ABSOLUTE/PATH/TO/factory/design/0.8.0-provability-release.md` — read the sections your brief names.

## Shared contracts (already committed — code against them, do not redesign them)

- `packages/ir/src/index.ts` — `IrProvability`, `IrProvabilityLevel` (search for `0.8.0`).
- `packages/provability/src/types.ts` — `ProofBundle`, `ProofClaim`, `ProofBinding`, `UnmetReason`,
  `EvidenceRecord`, `EvidenceIndex`, `ProofArtifact`, `ProofArtifactStore`, `VerifyOptions`,
  `ProvabilityGradedSummary`, `PROVABILITY_LEVELS`.
- `packages/proof-checker/src/types.ts` — `ProofChecker`, `CheckInput`, `CheckResult`, `SandboxLike`.
- `packages/runtime-core/src/index.ts` — `ProvabilityTurn`, `RunProvability`, and the
  `provability?: RunProvability` option on `RunChatLoopOptions` (typed only; the gate is wave 2).
- `packages/trace-event-bus/src/types.ts` — `ProvabilityGradedEvent` (`provability_graded`),
  `ProofCheckedEvent` (`proof_checked`). `packages/event-log` — the same two kinds.
  `packages/audit-log` — `provability_evaluated`. `packages/errors` — failure class
  `"provability"`, `EXIT_CODES.provability = 37`.

If a contract genuinely cannot work, you MAY make an additive change to it (a new optional
field, a new union member) and you MUST say so in your final report. Never remove or rename.

## File ownership

Your brief lists the files/packages you own. Edit only those. If something outside your list
must change for your work to compile, make the smallest change, and name it in your report.
Never revert, reformat or "clean up" files you do not own — another builder may be mid-edit.

## Hard rules

- Do NOT run `git commit`, `git stash`, `git checkout -- <file>`, `git reset`, or any history
  operation. The orchestrator commits between waves.
- Follow AGENTS.md: the three pillars. Absent config = byte-identical output (spread-return-`{}`
  lowering; emitters print nothing new when the IR key is absent). No model call anywhere in
  `claim-ledger`, `provability` or `proof-checker`. New tools set `scope`/`ioCapability`
  correctly (`readOnly`/`concurrencySafe`/`destructive`/`requiresSandbox` flags honestly).
- Every package owns its tests: colocated `src/*.test.ts`. Write real tests for what you build —
  happy paths, every failure reason, and the edge cases your docblocks mention.
- Comments explain WHY in the repo's voice (read a few docblocks near your code first) and cite
  the design section (e.g. `design §6.2`). No "TODO: implement" stubs left behind: if you cannot
  finish something, say exactly what is missing in your final report.
- Dependencies: internal deps only (`@crewhaus/*`). If you add one, add it to the package's
  `package.json` (keep keys sorted) AND its `tsconfig.json` `references`, then run `bun install`
  from the repo root (it updates `bun.lock`; that is expected). Do not add third-party npm deps.

## Commands (this machine: bun 1.4.2, 4 CPUs)

- Tests: `cd packages/<pkg> && bun test` (or `bun test src/<file>.test.ts`). NEVER use
  `bun run --filter` or root `bun run test` — on bun 1.4.x it hangs at exit.
  For `apps/cli`: `cd apps/cli && bun test src/<file>.test.ts` — the full apps/cli suite takes
  ~7+ minutes; run the files you touched plus any that import what you changed.
- Typecheck: `cd packages/<pkg> && bunx tsc -b` (builds its references). The orchestrator runs
  the full `bun run typecheck` at the end of the wave; you run it for your packages AND for every
  package that imports something you changed (grep for importers).
- Lint/format: `npx biome check --write <your files>` then `npx biome check <your files>` must
  report no errors. (`biome.json` is at the root.)

## Final report (your last message is returned to the orchestrator verbatim)

Plain text, no preamble:
1. FILES CHANGED — every path, one line each, with a few words on what changed.
2. TESTS — test files added/changed; the exact commands you ran and their pass/fail counts.
3. TYPECHECK/LINT — commands and results.
4. CONTRACT CHANGES — any additive change to a shared contract, or "none".
5. GAPS — anything in your brief you did not finish or deliberately deviated from, and why.
