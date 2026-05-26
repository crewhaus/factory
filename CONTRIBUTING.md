# Contributing to CrewHaus Factory

Thanks for considering a contribution. CrewHaus is an open source project; we move deliberately and prioritize clarity over speed.

This document covers:

1. How to file good bugs and feature requests
2. How to submit a pull request
3. The architectural rules contributions must follow
4. The Developer Certificate of Origin (DCO)
5. The maintainer ladder

## 1. Filing issues

### Bug reports

Use the [Bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). A good bug report includes:

- The commit SHA of factory you're on (run `git rev-parse HEAD`). Once `@crewhaus/cli` is on npm, the version of `@crewhaus/cli` (run `crewhaus --version`) — see [`PACKAGES.md`](PACKAGES.md) for publish status.
- Your `spec.yaml` (or a minimal reduction of it)
- What you ran (`crewhaus compile`, `crewhaus run`, etc.)
- What you expected to happen
- What actually happened, with the full error output
- Your environment: Bun version, OS, anything notable

We close low-signal bug reports without explanation. The bar is "could someone reproduce this from your report alone?"

### Feature requests

Use the [Feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the problem you're trying to solve, not the solution you think you want.

Some feature ideas need an RFC before any code is written; see Section 3.

## 2. Pull requests

### Before writing code

For anything more than a typo fix or a small bug, **open an issue or RFC first**. We will close PRs that didn't get pre-aligned, even if the code is good — because the change might conflict with planned architecture and we don't want to spend your time.

The exceptions are:
- Typo / grammar fixes in docs
- Adding a test for an existing-but-untested case
- Bumping a dependency to a patch version

### Submitting a PR

1. Fork the repo
2. Create a branch: `git checkout -b feat/short-description` or `fix/short-description`
3. Make your changes
4. Add tests in `__tests__/` next to the code
5. Run locally:
   ```bash
   bun install
   bun run tsc -b
   bun run biome check
   bun test
   ```
6. Sign off your commits (see DCO below):
   ```bash
   git commit -s -m "feat(target-cli): add support for streaming"
   ```
7. Push and open a PR using the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

We use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages. The prefix tells the changelog generator what kind of change it is:

- `feat:` — a new feature (minor version bump)
- `fix:` — a bug fix (patch version bump)
- `docs:` — documentation only
- `refactor:` — code change that doesn't fix a bug or add a feature
- `perf:` — performance improvement
- `test:` — adding/correcting tests
- `chore:` — tooling, dependencies, etc.
- `feat!:` or `fix!:` — breaking change (major version bump pre-1.0; minor pre-1.0)

### What we look for in PR review

- **Tests pass.** Both new tests for your change and the existing suite.
- **Type-check clean.** `bun run tsc -b` exits 0.
- **Lint clean.** `biome check` exits 0.
- **Respects the three pillars.** See Section 3.
- **Doesn't expand the public API casually.** Pre-1.0, every public export is a maintenance commitment.
- **Documentation updated.** If the change affects how someone uses CrewHaus, the docs need updating.

### What gets rejected

- PRs that add a new target shape without an IR variant (see Pillar 1)
- PRs that bypass the boundary classifier for performance (see Pillar 3)
- PRs that introduce a runtime feature without first adding the IR/spec affordance
- PRs that significantly grow the surface area without an RFC
- PRs that add features outside the scope of the compiler/runtime/eval/security core (those should be separate packages or community artifacts)

## 3. The three architectural pillars

Every change in this repo must respect three invariants. These come from [`AGENTS.md`](AGENTS.md) — read that first for the full versions.

### Pillar 1: The compiler is the protagonist

CrewHaus is a meta-harness compiler, not "yet another agent loop." Specs flow through `parseSpec → lower → applyPasses → emit`. The IR is a discriminated union; each target shape consumes its own typed variant.

**Rules:**

- New target shapes start at the IR. Add an `Ir<Target>V0` type to the discriminated union, add a `lower` case, add an `emit<Target>` function, register it.
- Targets receive their typed IR variant, never the raw spec. Reaching into `spec.foo` from an emitter breaks the polymorphism.
- IR-level optimizations live in `packages/ir-passes/` as `(IrNode) → IrNode` functions.
- The `assertNever(ir)` exhaustive check is non-negotiable.
- Add the shape to the smoke matrix: drop a fixture at `packages/smoke-harness/src/fixtures/<shape>.yaml` and an entry in `packages/smoke-harness/src/assertions.ts`. Coverage tests fail if either is missing — this is how CI catches emitter drift.
- The runtime smoke track (`bun run test:smoke:runtime`) drives real Anthropic API calls against the compiled bundles (`cli`, `browser`, `batch`) and asserts each agent actually used its tools. Gated on `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`; runs via the `Smoke (runtime)` workflow (manual dispatch + daily cron) so per-PR CI stays key-free.
- Service-backed shapes (`channel`, `onchain`, `voice`) are scaffolded but skip until their specific tokens + infra are wired. See [`packages/smoke-harness/RUNTIME-ACTIVATION.md`](packages/smoke-harness/RUNTIME-ACTIVATION.md) for what each shape needs and the activation checklist.

### Pillar 2: Eval is active, not passive

Eval failures must produce spec patches, not just HTML reports.

**Rules:**

- New spec parameters that should be optimizable go in `OPTIMIZABLE_PATHS` (`packages/spec-patch/src/index.ts`).
- Patches mutate the spec, never the IR.
- The rule-based `MutationProvider` stays the default in tests for determinism.
- Eval reports without a patch are passive grading — fine for canary gates, but the system's promise is *active* optimization.

### Pillar 3: Security is a fabric, not a perimeter

Every untrusted ingress is classified before content reaches a model call.

**Rules:**

- Any new module that ingests external content registers a `TrustOrigin` in `packages/boundary-classifier/src/origins.ts`.
- Authentication ≠ classification. Classify after authenticating.
- The content-hash cache is not bypassed for performance.
- Severity defaults: malicious → replace with redaction notice; suspicious → keep + log + emit `permission_decision` trace event.

### RFCs for big changes

The following changes require an RFC before any code:

- New target shape (IR variant)
- New trust boundary site
- Changes to the eval optimization loop
- Schema changes that affect existing specs
- Cross-package architectural shifts
- Governance changes

Open an RFC issue using the [RFC template](.github/ISSUE_TEMPLATE/rfc.yml). Template:

```markdown
# RFC: Title

## Problem
What problem are we solving?

## Proposed solution
The shape of the change.

## Alternatives considered
What else did you consider, and why is this the right call?

## Compatibility impact
Breaking? Migration story?

## Security impact
Any new trust boundaries? Any privilege changes?

## Open questions
What needs resolving before this can ship?
```

The project lead and relevant maintainers will review and either accept, reject, or request changes. Accepted RFCs become tracking issues for implementation.

## 4. Developer Certificate of Origin (DCO)

Every commit must be signed off with `Signed-off-by: Your Name <email>`. This is the [DCO](https://developercertificate.org/), a lightweight alternative to a CLA that certifies you have the right to contribute the code.

Add the sign-off automatically:

```bash
git commit -s -m "your message"
```

If you forgot, amend:

```bash
git commit --amend --signoff
```

PRs with unsigned commits will be flagged by CI; you can fix them by rebasing and force-pushing.

We use DCO, not a CLA, because it's friction-free for contributors and sufficient for our Apache-2.0 + open core model. See [`GOVERNANCE.md`](GOVERNANCE.md).

## 5. Maintainer ladder

| Level | Permissions | How to advance |
|---|---|---|
| Contributor | Submit issues, PRs, RFCs | Open a PR |
| Trusted contributor | Recognized; eligible for invites | Three+ accepted contributions across at least two areas |
| Maintainer | Merge rights in specific areas (per CODEOWNERS) | Invitation by project lead |
| Core maintainer | Release authority and governance vote | Invitation by existing core maintainers |

At launch there is one core maintainer (project lead). The ladder exists so the path is legible.

## Code style

- TypeScript with strict mode. No `any` without comment justifying why.
- Biome for formatting and linting. Defaults; no custom rules unless documented.
- Test files in `__tests__/` next to the code, not in a top-level `tests/`.
- Module organization: each package owns its tests, its types, its README.

## Documentation

- New features need a recipe in the [demos repo's `recipes/`](https://github.com/crewhaus/demos/tree/main/recipes).
- New modules need a brief in the [docs repo's `module-briefs/`](https://github.com/crewhaus/docs/tree/main/module-briefs).
- Public API changes need a changelog entry (auto-generated from conventional commits).
- Docs use Creative Commons Attribution 4.0 (separate from the code license).

## Community expectations

CrewHaus follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Be kind, assume good faith, and behave like you'd want a stranger to behave at a conference.

Communication channels:

- **GitHub Issues** — bugs and feature requests
- **GitHub Discussions** — questions, ideas, showcase
- **Pull requests** — code contributions
- **Email** (`security@crewhaus.ai`) — vulnerability reports only

We do not run a Discord or Slack at this time. We do not respond to DMs about CrewHaus on social media. The async-first model is intentional and documented in `SUPPORT.md`.

## License

By contributing, you agree your contributions are licensed under [Apache License 2.0](LICENSE), matching the rest of the codebase. The DCO sign-off is your assertion that you have the right to make this license grant.

---

Thanks for contributing. We mean it.
