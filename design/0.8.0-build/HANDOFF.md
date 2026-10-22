# 0.8.0 build handoff (cloud → local, 2026-10-22)

This directory is a working handoff, not release content. Do not merge `design/0.8.0-build/`
into `main`; delete it when the build is done.

## Branches

| Branch | State |
|---|---|
| `release/0.8.0` | Clean. Cut from `main` at `1f21a309`. Carries the design doc, the scaffold of all eight new packages and every shared contract (commit `abbb522e`), and an IR doc fix (`cff6e172`). Full typecheck and biome were green at `abbb522e`. |
| `release/0.8.0-wip` | `release/0.8.0` plus one commit with this directory and the PARTIAL, UNREVIEWED output of two Wave 1 builders that were stopped mid-task. |
| `docs/0.8.0-provability-plan` (PR #498, draft) | The design doc alone. Superseded by `release/0.8.0`, which carries the same file. |

## What the partial Wave 1 code is

Two of the four Wave 1 builders had started when the cloud session stopped; neither finished,
and no reviewer ran:

- **claim-ledger (brief W1-A)** — new modules `citations.ts`, `markdown.ts`, `sentences.ts`,
  `tokens.ts` under `packages/claim-ledger/src/`. The hoist out of tool-verify and the graders
  had not happened yet; no claim-ledger tests exist.
- **spec + compiler (brief W1-B)** — the `provability:` block in `packages/spec/src/index.ts`
  (~350 lines), lowering in `packages/compiler/src/index.ts`, and `IrProvability.judge.allowSelfJudge`.
  Lint rules and tests had not been written.

`bunx tsc -b` passes in spec, compiler and claim-ledger on this branch. Tests were not run.
Treat it as a head start to review, not as done work: either continue from it or rerun the two
briefs from `release/0.8.0`.

## The plan

The design is `design/0.8.0-provability-release.md`. The build was split into three waves of
builders, each followed by an independent adversarial reviewer and a fixer. Builders work in one
checkout at once, so each brief lists the files it owns. The briefs are in `briefs/`:

- `RULES.md` — the rules every builder follows (contracts, ownership, commands, report format).
- **Wave 1:** W1-A claim-ledger · W1-B spec/compiler/lint · W1-C provability verifiers (after
  W1-A) · W1-D proof-checker + the two sandbox-image packages.
- **Wave 2:** W2-A runtime gate · W2-C tool-proof (before W2-B, both touch target-cli) · W2-B
  evaluation-service composition root · W2-D `continuity.proof` enforcement.
- **Wave 3:** W3-A managed/research/sub-agent surfaces · W3-B Z3 + Lean 4 images and a release
  job · W3-C1 default skill + `init` · W3-C2 eval layer · W3-D `crewhaus provability` CLI,
  doctor, Hangar. W3-D, W3-C1 and W3-C2 all edit `apps/cli/src/index.ts`, so run them in sequence.
- Then: an adversarial review of the whole diff, docs (CHANGELOG, README, ROADMAP, AGENTS.md,
  PACKAGES.md, package READMEs, module briefs in `crewhaus/docs`), and the release.

`wave-1-workflow.js` is the Workflow script that ran Wave 1. The briefs and the script use the
placeholder `/ABSOLUTE/PATH/TO/factory` for the repo root — replace it with your checkout's path
before running them.

## Facts the cloud session established

- `main` holds 0.7.1 work (`a6514e0d` and later fixes) that was never released: the version is
  still 0.7.0 and there is no `v0.7.1` tag. Cutting 0.8.0 ships it. The CHANGELOG's
  `[Unreleased]` section is written as 0.7.1 release notes and needs folding into 0.8.0.
- chvm resolves versions from the npm registry (`crewhaus`), so chvm availability follows npm.
- The Release workflow publishes npm (OIDC, falling back to the `NPM_TOKEN` secret), Homebrew,
  Scoop, apt, winget and GHCR from a `v*` tag. A brand-new npm name needs a token for its first
  publish, and `publish-workspace.ts` refuses the `crewhaus` CLI if any dependency fails. 0.8.0
  adds eight new names, and `@crewhaus/tool-capability` and `@crewhaus/tool-registry-manifest`
  (0.7.1) are not on npm yet, so check that `NPM_TOKEN` is valid before tagging.
- Existing sandbox images point at public upstream images and nothing builds their Dockerfiles.
  Z3 and Lean 4 have no suitable upstream image, so W3-B adds a `sandbox-images` release job
  that pushes `ghcr.io/crewhaus/sandbox-{z3,lean4}`. Do not add them to `docker-images`'
  TARGET_SHAPES: `record-image-digests` rejects non-shapes.
- CI pins bun 1.3.14. On bun 1.4.x, `bun run --filter` (root `bun run test`) hangs at exit, so
  run `bun test` per package.
- In the cloud container, Docker needed `dockerd --iptables=false` and builds needed proxy and
  CA settings. Neither applies locally if Docker Desktop or a normal daemon is running.
